// A3: Jev's scope ask (planner/intent-heads.ts) against hand labels, for choosing SCOPE_CUTOFF. Each labelled request
// (scripts/ask-scope-labels.json) is put on its form's replayed desk, both wordings of the scope ask are sent, and every
// cutoff in a grid is scored by what readHeads would do with the answers: an ask with any "unclear" asks the user; else
// the fields both wordings answer "asks" at the cutoff are proposed. Scored per cutoff:
//   - extra: fields proposed that the request does not ask for (the user sees them in the preview before Tab);
//   - missed: fields the request asks for that a fill leaves out;
//   - asked: asks that end in a question, and whether its options hold every asked field.
// Fields labelled "either" count as neither. Nothing is filled; only the scope ask is sent.
//
//   node scripts/ask-scope-eval.ts --out DIR [--set b24|dev|all] [--engine jev] [--answers FILE] [--cutoff C] [--spend-limit USD]
// --answers rescores an earlier run's answers.json with no request. Keys come from CARET_ENV_FILE and are never printed;
// requests hold synthetic corpus text only.
import { writeStore, writeStoreJson } from "../src/privacy/send.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as z from "zod";
import type { AskJev, JevResult } from "../src/fill/jev.ts";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { engineName } from "../src/engines/decide/port.ts";
import { Snapshot } from "../src/protocol.ts";
import { intentSnapshot } from "../src/planner/intent.ts";
import { SCOPE_CUTOFF, scopeId, scopeRequest } from "../src/planner/intent-heads.ts";
import { buildDesk, loadAsks, loadCorpus } from "./realfill-corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    labels: { type: "string", default: join(here, "ask-scope-labels.json") },
    set: { type: "string", default: "all" },
    engine: { type: "string", default: "jev" },
    answers: { type: "string" },
    cutoff: { type: "string" },
    "spend-limit": { type: "string", default: "0.03" },
    corpus: { type: "string", default: join(here, "../../fixtures/realfill") },
    windows: { type: "string", default: join(here, "../fixtures/recorded/realfill-windows.ndjson") },
  },
});
if (a.out === undefined) throw new Error("--out is required");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });

const Labelled = z.object({
  id: z.string(),
  set: z.enum(["b24", "dev"]),
  form: z.string(),
  instruction: z.string(),
  asked: z.union([z.literal("all"), z.array(z.string())]),
  either: z.array(z.string()).optional(),
  why: z.string(),
}).strict();
const labelled = z.object({ about: z.string(), asks: z.array(Labelled) }).strict().parse(JSON.parse(readFileSync(resolve(a.labels), "utf8"))).asks.filter((x) => a.set === "all" || x.set === a.set);

type Label = "asked" | "not" | "either";
interface Answer { choice: string; confidence: number }
interface Row { id: string; set: string; field: string; label: Label; w0: Answer; w1: Answer }

const corpus = loadCorpus(resolve(a.corpus));
const b24 = new Map(loadAsks(resolve(a.corpus), corpus, "asks.json").map((x) => [x.id, x.instruction]));
const snaps = readFileSync(resolve(a.windows), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));

let rows: Row[];
if (a.answers !== undefined) rows = JSON.parse(readFileSync(resolve(a.answers), "utf8")) as Row[];
else {
  const fixtureIds = new Set<string>();
  const decide = harnessEngine({ name: engineName(a.engine), canned: null, fixture: { windows: (id) => fixtureIds.has(id), memory: true, plan: true } });
  const limit = Number(a["spend-limit"]);
  let spent = 0;
  const ask: AskJev = async (req) => {
    if (spent >= limit) throw new Error(`spend limit $${limit} reached`);
    const r = await decide.ask(req);
    spent += r.costUsd;
    return r;
  };
  rows = [];
  for (const x of labelled) {
    if (x.set === "b24" && b24.get(x.id) !== x.instruction) throw new Error(`${x.id}'s instruction is not B24's word for word`);
    const form = corpus.forms.find((f) => f.id === x.form);
    if (form === undefined) throw new Error(`no form ${x.form}`);
    const desk = buildDesk(corpus, snaps, form);
    for (const id of desk.model.windows.keys()) fixtureIds.add(id);
    const snap = intentSnapshot(x.instruction, desk.model, desk.form, desk.memory);
    const names = snap.fields.map((f) => f.name);
    for (const n of [...(x.asked === "all" ? [] : x.asked), ...(x.either ?? [])]) if (!names.includes(n)) throw new Error(`${x.id} labels '${n}', which ${x.form}'s snapshot does not list (${names.join("; ")})`);
    const [r0, r1] = (await Promise.all([ask(scopeRequest(snap, 0)), ask(scopeRequest(snap, 1))])) as [JevResult, JevResult];
    for (const f of snap.fields) {
      const got = (r: JevResult): Answer => r.answers[scopeId(f.ref)] ?? (() => { throw new Error(`no answer for ${x.id} ${f.name}`); })();
      const label: Label = x.either?.includes(f.name) ? "either" : x.asked === "all" || x.asked.includes(f.name) ? "asked" : "not";
      rows.push({ id: x.id, set: x.set, field: f.name, label, w0: got(r0), w1: got(r1) });
    }
    process.stderr.write(`${x.id}: ${snap.fields.length} fields, spent $${spent.toFixed(5)}\n`);
  }
  writeStoreJson(join(OUT, "answers.json"), rows, 1);
  writeStore(join(OUT, "spend.txt"), `$${spent.toFixed(6)} for ${labelled.length * 2} requests\n`);
}

const asks = [...new Set(rows.map((r) => r.id))];
const inScope = (r: Row, c: number): boolean => r.w0.choice === "asks" && r.w1.choice === "asks" && Math.min(r.w0.confidence, r.w1.confidence) >= c;
const isUnclear = (r: Row): boolean => r.w0.choice === "unclear" || r.w1.choice === "unclear";

interface Score { cutoff: number; fills: number; exact: number; asked: number; recall: number; refused: number; extra: number; missed: number; extraAny: number; missedAny: number }
function score(c: number, set: string): Score {
  const s: Score = { cutoff: c, fills: 0, exact: 0, asked: 0, recall: 0, refused: 0, extra: 0, missed: 0, extraAny: 0, missedAny: 0 };
  for (const id of asks) {
    const fs = rows.filter((r) => r.id === id && (set === "all" || r.set === set));
    if (fs.length === 0) continue;
    const chosen = fs.filter((r) => inScope(r, c));
    const extra = chosen.filter((r) => r.label === "not").length;
    const missed = fs.filter((r) => r.label === "asked" && !inScope(r, c)).length;
    s.extraAny += extra;
    s.missedAny += missed;
    // No field chosen, none unclear and no "asks" from either wording: readHeads refuses (noSuchField) on a settled fill
    // route rather than ask, so it is counted apart.
    if (!fs.some(isUnclear) && chosen.length === 0 && !fs.some((r) => r.w0.choice === "asks" || r.w1.choice === "asks")) {
      s.refused++;
      continue;
    }
    if (fs.some(isUnclear) || chosen.length === 0) {
      s.asked++;
      const offered = fs.some(isUnclear) ? fs.filter((r) => inScope(r, c) || isUnclear(r)) : fs.filter((r) => r.w0.choice === "asks" || r.w1.choice === "asks");
      if (fs.filter((r) => r.label === "asked").every((r) => offered.includes(r))) s.recall++;
      continue;
    }
    s.fills++;
    s.extra += extra;
    s.missed += missed;
    if (extra === 0 && missed === 0) s.exact++;
  }
  return s;
}

const GRID = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99];
const table = (set: string): string[] => [
  `### ${set} (${asks.filter((id) => rows.some((r) => r.id === id && (set === "all" || r.set === set))).length} asks)`,
  "",
  "| cutoff | fills | exact fills | extra fields in fills | missed fields in fills | asked | asked with every asked field offered | no field asked (refused) | extra, every ask | missed, every ask |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...GRID.map((c) => score(c, set)).map((s) => `| ${s.cutoff} | ${s.fills} | ${s.exact} | ${s.extra} | ${s.missed} | ${s.asked} | ${s.recall} | ${s.refused} | ${s.extraAny} | ${s.missedAny} |`),
  "",
];
const c = a.cutoff === undefined ? SCOPE_CUTOFF : Number(a.cutoff);
const detail = asks.map((id) => {
  const fs = rows.filter((r) => r.id === id);
  const show = (r: Row): string => `${r.field} (${r.w0.choice} ${r.w0.confidence.toFixed(2)}/${r.w1.choice} ${r.w1.confidence.toFixed(2)})`;
  const unclear = fs.filter(isUnclear);
  const extra = fs.filter((r) => inScope(r, c) && r.label === "not");
  const missed = fs.filter((r) => r.label === "asked" && !inScope(r, c));
  const outcome = unclear.length > 0 ? "asks" : fs.some((r) => inScope(r, c)) ? "fills" : fs.some((r) => r.w0.choice === "asks" || r.w1.choice === "asks") ? "asks" : "refuses";
  return `| ${id} | ${outcome} | ${unclear.map(show).join("; ")} | ${extra.map(show).join("; ")} | ${missed.map(show).join("; ")} |`;
});
const md = [
  "# Scope ask against hand labels (A3)",
  "",
  `Labels: ${a.labels}. Answers: ${a.answers ?? join(OUT, "answers.json")}.`,
  "",
  ...table("all"),
  ...table("b24"),
  ...table("dev"),
  `## Each ask at cutoff ${c}`,
  "",
  "| ask | outcome | unclear | extra | missed |",
  "|---|---|---|---|---|",
  ...detail,
];
writeStore(join(OUT, "scope-eval.md"), `${md.join("\n")}\n`);
process.stdout.write(`${md.join("\n")}\n`);
