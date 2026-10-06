// A1: code's reading of each ask's scope (planner/scope-reading.ts) and whose details (planner/people.ts), scored
// against the ask's expected fields with no model at all. It answers the A1 review question for a whole set: on which
// asks would code's reading put a field in scope that the user did not mean ("extra"), which a model that always agreed
// would let the fill write. "missing" readings only cost a partial; "none" falls back to the maker's heads.
//
//   node scripts/ask-reading-eval.ts --asks-file asks.json [--out DIR]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Snapshot } from "../src/protocol.ts";
import { intentSnapshot } from "../src/planner/intent.ts";
import { readScope } from "../src/planner/scope-reading.ts";
import { readWhose } from "../src/planner/people.ts";
import { buildDesk, loadAsks, loadCorpus, normLabel } from "./realfill-corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({ options: { "asks-file": { type: "string", default: "asks.json" }, out: { type: "string" }, corpus: { type: "string", default: join(here, "../../fixtures/realfill") } } });
const corpus = loadCorpus(resolve(a.corpus));
const asks = loadAsks(resolve(a.corpus), corpus, a["asks-file"]);
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));

type Verdict = "exact" | "missing" | "extra" | "none" | "refuse-read" | "refuse-none";
const rows: { id: string; kind: string; instruction: string; verdict: Verdict; reading: string; whose: string; extra: string[]; missing: string[]; why: string }[] = [];
for (const ask of asks) {
  const form = corpus.forms.find((f) => f.id === ask.form);
  if (form === undefined) throw new Error(`no form ${ask.form}`);
  const desk = buildDesk(corpus, snaps, form);
  const snap = intentSnapshot(ask.instruction, desk.model, desk.form, desk.memory);
  const r = readScope(snap);
  const reading = r.reading;
  const whose = readWhose(snap, snap.others, snap.memoryValues, reading?.because.some((b) => b.endsWith("(someone else's)")) ?? false);
  const whoseSays = whose.kind === "person" ? `person ${whose.name ?? snap.persons.find((p) => p.ref === whose.ref)?.span ?? whose.ref}` : whose.kind === "ask" ? `ask [${whose.candidates.join("; ")}]` : whose.kind;
  const expected = ask.expected === "refuse" ? [] : Object.entries(ask.expected).filter(([, v]) => v !== "none" && v !== "unchecked").map(([l]) => normLabel(l));
  // A field's corpus label: the reading's fields are named by their snapshot labels, which carry "(optional)" and marks.
  const label = (name: string): string => normLabel(name);
  const read = reading === null ? [] : reading.fields.map((f) => label(f.name));
  // A whole-form reading puts every empty field in scope; the fields the corpus fills with "none" are not extra.
  const formNone = new Set(form.fields.filter((f) => f.expected === "none" || f.expected === "unchecked").map((f) => normLabel(f.label)));
  const extra = read.filter((x) => !expected.includes(x) && !(reading?.kind === "all" && formNone.has(x)));
  const missing = expected.filter((x) => !read.includes(x));
  const verdict: Verdict = ask.expected === "refuse" ? (reading === null ? "refuse-none" : "refuse-read") : reading === null ? "none" : extra.length > 0 ? "extra" : missing.length > 0 ? "missing" : "exact";
  rows.push({ id: ask.id, kind: ask.kind ?? "", instruction: ask.instruction, verdict, reading: reading === null ? "" : reading.kind === "all" ? "all" : read.join("; "), whose: whoseSays, extra, missing, why: reading === null ? r.why : reading.because.join(", ") });
}
const count = (v: Verdict): number => rows.filter((r) => r.verdict === v).length;
const md = [
  `# Code's reading, no model (A1): ${a["asks-file"]}`,
  "",
  `All ${rows.length}: exact ${count("exact")}, missing some ${count("missing")}, **extra ${count("extra")}**, no reading ${count("none")}; must-refuse with no reading ${count("refuse-none")}, with a reading ${count("refuse-read")}.`,
  "",
  "| ask | kind | instruction | verdict | reading | whose | extra | missing | why |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | ${r.kind} | ${r.instruction} | ${r.verdict} | ${r.reading} | ${r.whose} | ${r.extra.join("; ")} | ${r.missing.join("; ")} | ${r.why.replace(/\|/gu, "/")} |`),
];
if (a.out !== undefined) {
  mkdirSync(resolve(a.out), { recursive: true });
  writeFileSync(join(resolve(a.out), "reading.md"), `${md.join("\n")}\n`);
  writeFileSync(join(resolve(a.out), "reading.json"), `${JSON.stringify(rows, null, 1)}\n`);
}
process.stdout.write(`${md.join("\n")}\n`);
