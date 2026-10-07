// W2 (AC1 section 5): the verifier on its labelled dev set, live. Each case is a field, a text and where the text was
// read, labelled right or wrong by a person (fixtures/verify/dev.json). The verifier alone is asked about every case
// (fill/contract.ts verifyProposed, both wordings in parallel, the requests as the product sends them), in several
// passes, and each case's code checks are run apart (shapeRefusal, then W1's text-shape gate), so the table shows what
// the verifier catches alone and what only code refuses. Acceptance (AC1): 0 false "exact" on a wrong case, in every
// pass. The verdicts are evidence for reading, never training data (TypeSafe terms §2.3(b)).
//
//   CARET_JEV_DAILY_CAP=<ledger + margin> node scripts/verifier-eval.ts --out DIR [--dev FILE] [--passes 3]
//   node scripts/verifier-eval.ts --out DIR --from DIR/results.json   (no Jev: the verdicts of an earlier run, read again
//                                                                       against the code checks as they are now)
//
// The family table (AC1 section 6, migration step 4): for each of W1's text-shape families (fill/writable.ts), the
// wrong cases it refuses and how many of them the verifier minted in some pass, and the right cases it refuses that
// the verifier minted in every pass: what retiring it would recover.
//
// Spend counts against CARET_JEV_DAILY_CAP (fill/jev.ts makeJevClient). Writes results.json (every verdict) and
// summary.md to --out. Exit 1 when a wrong case was minted in any pass.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeFieldContract, shapeRefusal, shapeSource, textShapeRefusal, verifyProposed, VERIFY_CUTOFF, type Proposed, type Provenance, type VerifyAsk } from "../src/fill/contract.ts";
import { familyRefusal, RETIRED_FAMILIES, SHAPE_FAMILIES } from "../src/fill/writable.ts";
import { fieldKinds } from "../src/fill/kinds.ts";
import { loadJevKey, makeJevClient, type AskJev } from "../src/fill/jev.ts";
import type { Control } from "../src/fill/controls.ts";
import type { FillPart } from "../src/fill/derive.ts";
import type { Node } from "../src/protocol.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const a = parseArgs({ options: { out: { type: "string" }, dev: { type: "string", default: join(HERE, "..", "fixtures", "verify", "dev.json") }, passes: { type: "string", default: "3" }, from: { type: "string" } } });
if (a.values.out === undefined) throw new Error("--out is required");
const OUT = resolve(a.values.out);
const PASSES = Number(a.values.passes);
if (!Number.isInteger(PASSES) || PASSES < 1) throw new Error(`--passes must be a whole number of at least 1, not ${a.values.passes}`);

interface DevCase {
  id: string;
  family: string;
  field: { key: string; descriptor: string; name: string; labelWords: (string | null)[]; control: Control; part: FillPart | null; inputKind: Node["inputKind"] | null; maxLength: number | null };
  text: string;
  provenance: Provenance;
  owner: null;
  expected: "right" | "wrong";
  label: string;
  note?: string;
}
const dev = JSON.parse(readFileSync(resolve(a.values.dev), "utf8")) as { cases: DevCase[] };
const proposed: Proposed[] = dev.cases.map((c) => ({
  field: makeFieldContract({ windowId: "form", node: { key: c.field.key, parent: null, role: "AXTextField", label: c.field.name, ...(c.field.inputKind === null ? {} : { inputKind: c.field.inputKind }), ...(c.field.maxLength === null ? {} : { maxLength: c.field.maxLength }) }, descriptor: c.field.descriptor, name: c.field.name, labelWords: c.field.labelWords, control: c.field.control, kinds: fieldKinds(c.field.labelWords), part: c.field.part }),
  text: c.text,
  display: c.text,
  provenance: c.provenance,
  owner: c.owner,
}));
const code = proposed.map((p) => ({ shape: shapeRefusal(p), w1: textShapeRefusal(p) }));

const latencies: number[] = [];
let spent = 0;
const passes: (readonly [VerifyAsk, VerifyAsk] | null)[][] = [];
if (a.values.from !== undefined) {
  const earlier = JSON.parse(readFileSync(resolve(a.values.from), "utf8")) as { rows: { id: string; verdicts: (readonly [VerifyAsk, VerifyAsk] | null)[] }[]; latencyMs: { all?: number[] }; spentUsd: number };
  const byId = new Map(earlier.rows.map((r) => [r.id, r.verdicts]));
  const n = earlier.rows[0]?.verdicts.length ?? 0;
  for (let k = 0; k < n; k++) passes.push(dev.cases.map((c) => byId.get(c.id)?.[k] ?? null));
  latencies.push(...(earlier.latencyMs.all ?? []));
  spent = earlier.spentUsd;
} else {
  const live = makeJevClient(loadJevKey);
  const ask: AskJev = async (req) => {
    const r = await live(req);
    latencies.push(r.latencyMs);
    spent += r.costUsd;
    return r;
  };
  for (let i = 0; i < PASSES; i++) {
    const r = await verifyProposed(proposed, { authority: { kind: "plan", offerKey: "verifier-eval" }, askJev: ask, ledger: null, now: Date.now() });
    passes.push(r.asks);
    process.stderr.write(`pass ${i + 1}: ${r.jev.requests} requests, $${r.jev.costUsd.toFixed(5)}\n`);
  }
}

const mints = (x: readonly [VerifyAsk, VerifyAsk] | null): boolean => x !== null && x[0].choice === "exact" && x[1].choice === "exact" && Math.min(x[0].confidence, x[1].confidence) >= VERIFY_CUTOFF;
const q = (xs: number[], p: number): number => {
  const v = [...xs].sort((x, y) => x - y);
  return v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0;
};
const rows = dev.cases.map((c, i) => ({
  id: c.id,
  family: c.family,
  expected: c.expected,
  label: c.label,
  field: c.field.name,
  text: c.text,
  shape: code[i]?.shape ?? null,
  w1: code[i]?.w1 ?? null,
  verdicts: passes.map((p) => p[i] ?? null),
  minted: passes.map((p) => mints(p[i] ?? null)),
  families: SHAPE_FAMILIES.filter((f) => familyRefusal(f, c.text, { labelWords: c.field.labelWords, part: c.field.part }, shapeSource(proposed[i] as Proposed)) !== null),
}));
const wrong = rows.filter((r) => r.expected === "wrong");
const right = rows.filter((r) => r.expected === "right");
/**
 * A wrong case's label says what kind of wrong it is: "more", "part" and "note" are exactness, the verifier's promise;
 * "other" is a selection (another field's or another person's value), which the two value asks and the owner veto own
 * (AC1 sections 1 and 7, risk 5). Both are counted; the table shows them apart.
 */
const exactness = (r: { label: string }): boolean => r.label !== "other";
const perPass = (k: number) => ({
  falseExact: wrong.filter((r) => r.minted[k]).length,
  falseExactExactness: wrong.filter((r) => r.minted[k] && exactness(r)).length,
  falseExactOther: wrong.filter((r) => r.minted[k] && !exactness(r)).length,
  rightRefused: right.filter((r) => !r.minted[k]).length,
  disagree: rows.filter((r) => r.verdicts[k] !== null && r.verdicts[k]?.[0].choice !== r.verdicts[k]?.[1].choice).length,
  unasked: rows.filter((r) => r.verdicts[k] === null).length,
});
const table = passes.map((_, k) => perPass(k));
// What the verifier catches alone, and what only code refuses, by family: a family's wrong cases the verifier minted in
// some pass, and its right cases code refuses that the verifier minted in every pass.
const families = [...new Set(rows.map((r) => r.family))];
const byFamily = families.map((f) => {
  const fr = rows.filter((r) => r.family === f);
  return {
    family: f,
    cases: fr.length,
    wrongMintedAnyPass: fr.filter((r) => r.expected === "wrong" && r.minted.some(Boolean)).length,
    rightMintedEveryPass: fr.filter((r) => r.expected === "right" && r.minted.every(Boolean)).length,
    rightCodeRefuses: fr.filter((r) => r.expected === "right" && (r.shape !== null || r.w1 !== null)).length,
    rightOnlyCodeRefuses: fr.filter((r) => r.expected === "right" && r.minted.every(Boolean) && (r.shape !== null || r.w1 !== null)).map((r) => `${r.id} '${r.text}' in ${r.field}: ${r.shape ?? r.w1}`),
  };
});
const familyTable = SHAPE_FAMILIES.map((f) => {
  const fr = rows.filter((r) => r.families.includes(f));
  const wr = fr.filter((r) => r.expected === "wrong");
  const rr = fr.filter((r) => r.expected === "right");
  return {
    family: f,
    retired: RETIRED_FAMILIES.has(f),
    wrongRefused: wr.length,
    wrongVerifierMinted: wr.filter((r) => r.minted.some(Boolean)).map((r) => `${r.id} '${r.text}'`),
    rightRefused: rr.length,
    // Recovered by retiring the family: the verifier minted it every pass, and no other check refuses it.
    rightRecovered: rr.filter((r) => r.minted.every(Boolean) && r.shape === null && r.families.every((g) => g === f || RETIRED_FAMILIES.has(g))).map((r) => `${r.id} '${r.text}' in ${r.field}`),
  };
});
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "results.json"), `${JSON.stringify({ cutoff: VERIFY_CUTOFF, passes: PASSES, spentUsd: spent, latencyMs: { n: latencies.length, p50: q(latencies, 0.5), p95: q(latencies, 0.95), all: latencies }, table, byFamily, familyTable, rows }, null, 1)}\n`);
const md = [
  `# Verifier eval (W2), ${dev.cases.length} cases (${wrong.length} wrong, ${right.length} right), ${PASSES} passes, cutoff ${VERIFY_CUTOFF}`,
  "",
  "The verdicts are evidence for reading, never training data (TypeSafe terms §2.3(b)).",
  "",
  `| pass | false exact on wrong (${wrong.length}) | of those, exactness (more, part, note: ${wrong.filter(exactness).length}) | of those, selection (other: ${wrong.filter((r) => !exactness(r)).length}) | right refused | wordings disagree | not asked |`,
  "|---|---|---|---|---|---|---|",
  ...table.map((t, k) => `| ${k + 1} | ${t.falseExact} | ${t.falseExactExactness} | ${t.falseExactOther} | ${t.rightRefused} of ${right.length} | ${t.disagree} | ${t.unasked} |`),
  "",
  `Requests ${latencies.length}; latency per request p50 ${q(latencies, 0.5)} ms, p95 ${q(latencies, 0.95)} ms; spend $${spent.toFixed(5)}.`,
  "",
  "| family | cases | wrong minted (any pass) | right minted (every pass) | right code refuses | of those, the verifier mints |",
  "|---|---|---|---|---|---|",
  ...byFamily.map((f) => `| ${f.family} | ${f.cases} | ${f.wrongMintedAnyPass} | ${f.rightMintedEveryPass} | ${f.rightCodeRefuses} | ${f.rightOnlyCodeRefuses.length} |`),
  "",
  "## W1's text-shape families (fill/writable.ts), by what the verifier does with the cases each refuses",
  "",
  "| family | retired | wrong it refuses | of those, the verifier minted (any pass) | right it refuses | right recovered by retiring it |",
  "|---|---|---|---|---|---|",
  ...familyTable.map((f) => `| ${f.family} | ${f.retired ? "yes" : "no"} | ${f.wrongRefused} | ${f.wrongVerifierMinted.length}${f.wrongVerifierMinted.length === 0 ? "" : `: ${f.wrongVerifierMinted.join(", ")}`} | ${f.rightRefused} | ${f.rightRecovered.length}${f.rightRecovered.length === 0 ? "" : `: ${f.rightRecovered.join("; ")}`} |`),
  "",
  "## Wrong cases minted",
  "",
  ...(wrong.some((r) => r.minted.some(Boolean)) ? wrong.filter((r) => r.minted.some(Boolean)).map((r) => `- ${r.id} (${r.label}) '${r.text}' in ${r.field}: ${r.verdicts.map((v) => (v === null ? "-" : `${v[0].choice}/${v[1].choice} ${Math.min(v[0].confidence, v[1].confidence).toFixed(2)}`)).join("; ")}; code: ${r.shape ?? r.w1 ?? "passes"}`) : ["None."]),
  "",
  "## Right cases refused (any pass)",
  "",
  ...right.filter((r) => !r.minted.every(Boolean)).map((r) => `- ${r.id} '${r.text.slice(0, 80)}' in ${r.field}: ${r.verdicts.map((v) => (v === null ? "-" : `${v[0].choice}/${v[1].choice} ${Math.min(v[0].confidence, v[1].confidence).toFixed(2)}`)).join("; ")}`),
  "",
  "## Right cases only code refuses (the verifier minted them in every pass)",
  "",
  ...byFamily.flatMap((f) => f.rightOnlyCodeRefuses.map((x) => `- ${x}`)),
];
writeFileSync(join(OUT, "summary.md"), `${md.join("\n")}\n`);
process.stderr.write(`verifier eval: ${table.map((t, k) => `pass ${k + 1} false exact ${t.falseExact}, right refused ${t.rightRefused}/${right.length}, disagree ${t.disagree}`).join("; ")}; $${spent.toFixed(5)}; ${join(OUT, "summary.md")}\n`);
process.exitCode = table.some((t) => t.falseExact > 0) ? 1 : 0;
