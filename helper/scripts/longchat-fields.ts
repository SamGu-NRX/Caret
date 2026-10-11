// Field by field on the long-conversation sets (fixtures/longchat, fixtures/longchat-solo): each desk's scoped fill, as
// a fill of the ask's fields runs it (proposeFill with them, owner questions on, every window a source), answered by the
// scripted oracle. Counts, per desk, the expected fields filled
// right, filled wrong, and withheld, by why. Fixture data only: no Jev, no network. The scripted oracle's ask verdicts
// are scripts/realfill-asks.ts's; this is the per-field view of the same desks.
//
//   node scripts/longchat-fields.ts [--sets longchat,longchat-solo] [--modes page,reader] [--out FILE.json]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Snapshot } from "../src/protocol.ts";
import { proposeFill, type FillTrace } from "../src/fill/fill.ts";
import { realfillOracle } from "./realfill-oracle.ts";
import { writeStoreJson } from "../src/privacy/send.ts";
import { buildDesk, loadAsks, loadCorpus, nodesFor, pageForm, T0 } from "./realfill-corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({ options: { sets: { type: "string", default: "longchat,longchat-solo" }, modes: { type: "string", default: "page,reader" }, out: { type: "string" } } });
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));

type Row = { set: string; mode: string; desk: string; kind: string; expected: number; right: number; wrong: number; withheld: Record<string, number>; fields: { label: string; expected: string; got: string | null; withheld: string | null; clauses?: unknown }[] };
const rows: Row[] = [];
for (const set of a.sets.split(",")) {
  const dir = join(here, "../../fixtures", set);
  const corpus = loadCorpus(dir);
  for (const mode of a.modes.split(",")) {
    const asks = loadAsks(dir, corpus, "asks.json");
    for (const ask of asks) {
      if (ask.expected === "refuse") continue;
      const expected = ask.expected;
      const form = corpus.forms.find((f) => f.id === ask.form);
      if (form === undefined) throw new Error(`no form ${ask.form}`);
      const d = buildDesk(corpus, snaps, form, mode === "page" ? pageForm(form) : undefined);
      const labelOf = new Map(form.fields.flatMap((f) => nodesFor(d.form, f).map((n) => [n.key, f.label] as const)));
      const keys = form.fields.filter((f) => expected[f.label] !== undefined).flatMap((f) => nodesFor(d.form, f).slice(0, 1).map((n) => n.key));
      if (keys.length === 0) throw new Error(`${ask.id}: no expected field on its form`);
      // The scripted oracle (scripts/realfill-oracle.ts) answers as it does for realfill-asks: the key's own value where
      // the trace says it is offered, owner questions by the key, the verifier exact.
      const traces: FillTrace[] = [];
      const jev = realfillOracle({ asks, corpus, current: () => ask.id, traces: () => traces, corpusLabel: () => labelOf });
      const p = await proposeFill(d.model, jev, d.form.window.windowId, keys[0] as string, T0, { only: keys, rand: () => 0, trace: (t) => traces.push(t) });
      // A measurement loader may record which cut clauses held for each field (globalThis.__clauses, by field name).
      const clauses = (globalThis as { __clauses?: Map<string, unknown> }).__clauses;
      const fields = p.fields.map((f) => {
        const label = labelOf.get(f.key) ?? f.key;
        const why = clauses?.get(label);
        return { label, expected: expected[label] ?? "none", got: f.value ?? f.handoff?.value ?? null, withheld: f.value === null && f.handoff === null ? (f.withheld ?? "none") : null, ...(why === undefined ? {} : { clauses: why }) };
      });
      clauses?.clear();
      const accept = (l: string): string[] => form.fields.find((f) => f.label === l)?.accept ?? [];
      const withheld: Record<string, number> = {};
      for (const f of fields) if (f.got === null) withheld[f.withheld ?? "none"] = (withheld[f.withheld ?? "none"] ?? 0) + 1;
      rows.push({
        set, mode, desk: ask.id, kind: ask.kind ?? "", expected: fields.filter((f) => f.expected !== "none").length,
        right: fields.filter((f) => f.got !== null && (f.got === f.expected || accept(f.label).includes(f.got))).length,
        wrong: fields.filter((f) => f.got !== null && f.got !== f.expected && !accept(f.label).includes(f.got)).length,
        withheld, fields,
      });
    }
  }
}
const lines = ["| set | mode | desk | kind | expected | right | wrong | withheld (why: n) |", "|---|---|---|---|---|---|---|---|", ...rows.map((r) => `| ${r.set} | ${r.mode} | ${r.desk} | ${r.kind} | ${r.expected} | ${r.right} | ${r.wrong} | ${Object.entries(r.withheld).map(([k, n]) => `${k}: ${n}`).join(", ")} |`)];
const total = (set: string, mode: string) => rows.filter((r) => r.set === set && r.mode === mode).reduce((t, r) => ({ expected: t.expected + r.expected, right: t.right + r.right, wrong: t.wrong + r.wrong }), { expected: 0, right: 0, wrong: 0 });
for (const set of a.sets.split(",")) for (const mode of a.modes.split(",")) lines.push(`${set} ${mode}: ${JSON.stringify(total(set, mode))}`);
console.log(lines.join("\n"));
if (a.out !== undefined) writeStoreJson(a.out, rows, 1);
