// The B24 Ask scoreboard: twenty natural instructions written blind for the real-form corpus
// (fixtures/realfill/asks.json), each on its form's replayed desk (realfill-corpus.ts buildDesk), through the
// helper's Ask path: the deterministic planner with live Jev, and for an instruction it cannot ground, the
// code-mode writer (planner/codeplan.ts) with the live writer. Nothing runs: a proposed plan is scored, never
// executed.
//
//   node scripts/realfill-asks.ts --out DIR [--asks a,b] [--spend-limit USD] [--gap S] [--no-writer]
//
// A plan is right when it writes every expected value of a text field and nothing else; partial when what it
// writes is right but some expected text value is missing; wrong when it writes any value that is not expected
// (or anything for "refuse"); refused when it proposes nothing. Expected values for selects, radios, boxes,
// dates and times are counted apart: a plan writes text fields only. Wrong must be 0. Keys come from
// CARET_ENV_FILE and are never printed; output holds synthetic corpus text only.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadJevKey, makeJevClient, type AskJev } from "../src/fill/jev.ts";
import { planTask, type PlanDraft } from "../src/planner/planner.ts";
import { planWithCode, type WriterUse } from "../src/planner/codeplan.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { makeWriterPort, type WriterPort } from "../src/writer/port.ts";
import { WRITER_ROUTE } from "../src/writer/config.ts";
import { ChatHttpError } from "../src/writer/chat.ts";
import { Snapshot } from "../src/protocol.ts";
import { rng } from "../test/large-scene.ts";
import { buildDesk, loadAsks, loadCorpus, nodesFor, T0, type CorpusAsk } from "./realfill-corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    corpus: { type: "string", default: join(here, "../../fixtures/realfill") },
    windows: { type: "string", default: join(here, "../fixtures/recorded/realfill-windows.ndjson") },
    asks: { type: "string" },
    "spend-limit": { type: "string", default: "0.40" },
    // Groq allows qwen3.8 1,000 output tokens a minute (writer/config.ts): about one plan every 12 s.
    gap: { type: "string", default: "15" },
    "no-writer": { type: "boolean", default: false },
    seed: { type: "string", default: "24" },
    /** Writes every Jev question and answer to this NDJSON file (synthetic corpus text only), for reading the checks. */
    "log-jev": { type: "string" },
  },
});
if (a.out === undefined) throw new Error("--out is required");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const corpus = loadCorpus(resolve(a.corpus));
const asks = loadAsks(resolve(a.corpus), corpus).filter((x) => a.asks === undefined || a.asks.split(",").includes(x.id));
const snaps = readFileSync(resolve(a.windows), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const SPEND_LIMIT = Number(a["spend-limit"]);
const GAP_MS = Number(a.gap) * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let jevSpent = 0;
let writerSpent = 0;
const live = makeJevClient(() => loadJevKey());
const askJev: AskJev = async (req) => {
  if (jevSpent + writerSpent >= SPEND_LIMIT) throw new Error(`spend limit $${SPEND_LIMIT} reached`);
  const r = await live(req);
  jevSpent += r.costUsd;
  if (a["log-jev"] !== undefined) appendFileSync(a["log-jev"], JSON.stringify({ ask: current, questions: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, String(q.instructions).slice(0, 300)])), answers: r.answers }) + "\n");
  return r;
};
let current = "";
const port = makeWriterPort(WRITER_ROUTE);
let lastWrite = 0;
let retries = 0;
/** The writer, spaced to the provider's per-minute limit, with one wait-and-retry on 429 (counted; WriterPort itself never retries). */
const writer: WriterPort = {
  route: port.route,
  async write(req) {
    if (jevSpent + writerSpent >= SPEND_LIMIT) throw new Error(`spend limit $${SPEND_LIMIT} reached`);
    const wait = lastWrite + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    for (let attempt = 0; ; attempt++) {
      try {
        lastWrite = Date.now();
        const r = await port.write({ ...req, signal: AbortSignal.timeout(20_000) });
        writerSpent += r.costUsd;
        return r;
      } catch (e) {
        if (attempt === 0 && e instanceof ChatHttpError && e.status === 429) {
          retries++;
          await sleep(Math.min(60, e.retryAfterS ?? 20) * 1000);
          continue;
        }
        throw e;
      }
    }
  },
};

type Verdict = "right" | "partial" | "wrong" | "refused";
interface Row {
  ask: CorpusAsk;
  path: "planner" | "writer" | "none";
  verdict: Verdict;
  writes: { field: string; value: string; expected: string | null }[];
  missingText: string[];
  controlsLeft: string[];
  error: string | null;
  writer: WriterUse | null;
}

const rows: Row[] = [];
for (const [i, ask] of asks.entries()) {
  const form = corpus.forms.find((f) => f.id === ask.form);
  if (form === undefined) throw new Error(`no form ${ask.form}`);
  const desk = buildDesk(corpus, snaps, form);
  const memory = { values: () => desk.memory };
  const r = rng(Number(a.seed) * 1000 + i);
  const offerKey = `realfill-ask-${ask.id}`;
  current = ask.id;
  let draft: PlanDraft | null = null;
  let path: Row["path"] = "none";
  let error: string | null = null;
  let use: WriterUse | null = null;
  try {
    draft = await planTask(ask.instruction, desk.model, memory, { askJev, offerKey, windowId: desk.form.window.windowId, now: T0, rand: (n) => Math.floor(r() * n) });
    path = "planner";
  } catch (e) {
    if (!(e instanceof PlannerError)) throw e;
    error = `${e.code}: ${e.message}`;
    if ((e.code === "unsure" || e.code === "nothingToDo") && a["no-writer"] !== true) {
      try {
        const d = await planWithCode(ask.instruction, desk.model, memory, { writer, askJev, offerKey, windowId: desk.form.window.windowId, now: T0 });
        draft = d;
        use = d.writer;
        path = "writer";
        error = null;
      } catch (e2) {
        if (!(e2 instanceof PlannerError)) throw e2;
        error = `${error}; writer: ${e2.code}: ${e2.message}`;
      }
    }
  }
  // Each written field, by the corpus label whose node it is.
  const labelOf = new Map<string, string>();
  for (const f of form.fields) for (const n of nodesFor(desk.form, f)) labelOf.set(n.key, f.label);
  const expected = ask.expected === "refuse" ? {} : ask.expected;
  const writes = (draft?.checked.writes ?? []).map((wr) => {
    const field = labelOf.get(wr.node.key) ?? `(${wr.node.label ?? wr.node.key})`;
    return { field, value: wr.value, expected: expected[field] ?? null };
  });
  const ok = (w: { field: string; value: string; expected: string | null }): boolean => {
    if (w.expected === null || w.expected === "none" || w.expected === "handoff") return false;
    const f = form.fields.find((x) => x.label === w.field);
    return w.value === w.expected || (f?.accept ?? []).includes(w.value);
  };
  const textField = (label: string): boolean => {
    const c = form.fields.find((x) => x.label === label)?.control;
    return c === "text" || c === "email" || c === "tel" || c === "url" || c === "textarea";
  };
  const wantedText = Object.entries(expected).filter(([l, v]) => v !== "none" && v !== "handoff" && textField(l)).map(([l]) => l);
  const controlsLeft = Object.entries(expected).filter(([l, v]) => v !== "none" && v !== "handoff" && !textField(l)).map(([l, v]) => `${l}: ${v}`);
  const missingText = wantedText.filter((l) => !writes.some((w) => w.field === l));
  const verdict: Verdict = draft === null ? "refused" : ask.expected === "refuse" || writes.some((w) => !ok(w)) ? "wrong" : missingText.length === 0 ? "right" : "partial";
  rows.push({ ask, path, verdict, writes, missingText, controlsLeft, error, writer: use });
  process.stderr.write(`${ask.id} (${ask.form}): ${verdict} via ${path}${error === null ? "" : `; ${error.slice(0, 160)}`}\n`);
}

const n = (v: Verdict, xs: readonly Row[] = rows) => xs.filter((r) => r.verdict === v).length;
const refuseAsks = rows.filter((r) => r.ask.expected === "refuse");
const md = [
  "# Ask scoreboard (B24)",
  "",
  `Writer ${WRITER_ROUTE.model} on ${WRITER_ROUTE.provider}; ${rows.filter((r) => r.writer !== null).length} writer plans, $${writerSpent.toFixed(4)}, ${retries} 429 retries. Jev $${jevSpent.toFixed(4)}.`,
  "",
  `All ${rows.length}: right ${n("right")}, partial ${n("partial")}, refused ${n("refused")}, **wrong ${n("wrong")}**.`,
  `Of the ${refuseAsks.length} that should be refused: refused ${n("refused", refuseAsks)}, wrong ${n("wrong", refuseAsks)}.`,
  "",
  "| ask | form | instruction | verdict | path | writes | missing text | left to the user (controls) | error |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) =>
    `| ${r.ask.id} | ${r.ask.form} | ${r.ask.instruction} | ${r.verdict} | ${r.path} | ${r.writes.map((w) => `${w.field} = ${w.value}${w.expected === w.value ? "" : ` (expected ${w.expected ?? "no write"})`}`).join("; ")} | ${r.missingText.join("; ")} | ${r.controlsLeft.join("; ")} | ${(r.error ?? "").replace(/\|/g, "/").slice(0, 200)} |`,
  ),
];
writeFileSync(join(OUT, "realfill-asks.md"), md.join("\n") + "\n");
writeFileSync(join(OUT, "realfill-asks.json"), JSON.stringify({ jevSpent, writerSpent, retries, rows }, null, 1) + "\n");
process.stderr.write(`right ${n("right")}, partial ${n("partial")}, refused ${n("refused")}, wrong ${n("wrong")}; $${(jevSpent + writerSpent).toFixed(4)}\n`);
