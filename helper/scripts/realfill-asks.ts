// The Ask scoreboard (B24, then B25): natural instructions on the real-form corpus, each on its form's replayed
// desk (realfill-corpus.ts buildDesk), through Ask as the helper runs it (planner/ask.ts): an intent from the
// chosen maker, checked by code, then the scoped fill or the planner. Nothing runs: a proposed plan is scored,
// never executed.
//
//   node scripts/realfill-asks.ts --out DIR [--asks-file asks.json] [--asks a,b] [--maker writer|jev]
//        [--spend-limit USD] [--gap S] [--writer-model ID] [--no-writer]
//
// Each ask's expected values are the fields it asks to change. A plan is right when it writes every expected
// text value and hands off every expected control value (a select's option, a radio, a box, a date or a time),
// and nothing else; partial when all it proposes is right but something expected is missing; wrong when it
// proposes any value that is not expected (or anything at all for "refuse"); refused when it proposes nothing.
// A plan that only names a press for the user proposes nothing. This is stricter than B24's scorer, which
// counted controls apart and called an ask with only control values right whenever a plan wrote nothing wrong.
// Wrong must be 0. Keys come from CARET_ENV_FILE and are never printed; output holds synthetic corpus text only.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadJevKey, makeJevClient, type AskJev } from "../src/fill/jev.ts";
import { AskRefused, planAsk, type AskDraft } from "../src/planner/ask.ts";
import { jevIntentMaker, writerIntentMaker, type IntentMaker, type MakerUse } from "../src/planner/intent-makers.ts";
import type { AskIntent } from "../src/planner/intent.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { makeWriterPort, type WriterPort } from "../src/writer/port.ts";
import { CANDIDATES, WRITER_ROUTE } from "../src/writer/config.ts";
import { ChatHttpError } from "../src/writer/chat.ts";
import { Snapshot } from "../src/protocol.ts";
import { rng } from "../test/large-scene.ts";
import { buildDesk, loadAsks, loadCorpus, nodesFor, T0, type CorpusAsk } from "./realfill-corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    corpus: { type: "string", default: join(here, "../../fixtures/realfill") },
    "asks-file": { type: "string", default: "asks.json" },
    windows: { type: "string", default: join(here, "../fixtures/recorded/realfill-windows.ndjson") },
    asks: { type: "string" },
    maker: { type: "string", default: "writer" },
    "spend-limit": { type: "string", default: "0.10" },
    // Groq allows each candidate 30 requests and 8,000 tokens a minute (console.groq.com/docs/rate-limits, 2026-10-04).
    gap: { type: "string", default: "13" },
    "no-writer": { type: "boolean", default: false },
    /** Another of writer/config.ts's candidates by model id; the report names the model used. */
    "writer-model": { type: "string" },
    seed: { type: "string", default: "24" },
    /** Writes every Jev question and answer to this NDJSON file (synthetic corpus text only). */
    "log-jev": { type: "string" },
  },
});
if (a.out === undefined) throw new Error("--out is required");
if (a.maker !== "writer" && a.maker !== "jev") throw new Error("--maker is writer or jev");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const corpus = loadCorpus(resolve(a.corpus));
const asks = loadAsks(resolve(a.corpus), corpus, a["asks-file"]).filter((x) => a.asks === undefined || a.asks.split(",").includes(x.id));
const snaps = readFileSync(resolve(a.windows), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const SPEND_LIMIT = Number(a["spend-limit"]);
const GAP_MS = Number(a.gap) * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let jevSpent = 0;
let writerSpent = 0;
const live = makeJevClient(() => loadJevKey());
let current = "";
const askJev: AskJev = async (req) => {
  if (jevSpent + writerSpent >= SPEND_LIMIT) throw new Error(`spend limit $${SPEND_LIMIT} reached`);
  const r = await live(req);
  jevSpent += r.costUsd;
  if (a["log-jev"] !== undefined) {
    const qs = { ...req.questions, ...req.nouls };
    appendFileSync(a["log-jev"], JSON.stringify({ ask: current, questions: Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, String(q.instructions).slice(0, 300)])), answers: r.answers, nouls: r.nouls ?? {} }) + "\n");
  }
  return r;
};
const route = a["writer-model"] === undefined ? WRITER_ROUTE : CANDIDATES.find((r) => r.model === a["writer-model"]);
if (route === undefined) throw new Error(`--writer-model ${a["writer-model"]} is not one of ${CANDIDATES.map((r) => r.model).join(", ")}`);
const port = makeWriterPort(route);
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
interface Proposed {
  field: string;
  value: string;
  expected: string | null;
  control: boolean;
}
interface Row {
  ask: CorpusAsk;
  route: string;
  verdict: Verdict;
  proposed: Proposed[];
  missing: string[];
  error: string | null;
  intent: AskIntent | null;
  maker: MakerUse | null;
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
  const maker: IntentMaker = a.maker === "jev" ? jevIntentMaker(askJev, { rand: (n) => Math.floor(r() * n) }) : writerIntentMaker(writer, () => offerKey);
  let draft: AskDraft | null = null;
  let error: string | null = null;
  let intent: AskIntent | null = null;
  let use: MakerUse | null = null;
  try {
    draft = await planAsk(ask.instruction, desk.model, memory, desk.about, { askJev, maker, writer: a["no-writer"] === true ? null : writer, offerKey, windowId: desk.form.window.windowId, now: T0, rand: (n) => Math.floor(r() * n) });
    intent = draft.intent;
    use = draft.maker;
  } catch (e) {
    if (!(e instanceof PlannerError)) throw e;
    error = `${e.code}: ${e.message}`;
    if (e instanceof AskRefused) ((intent = e.intent), (use = e.maker));
  }
  const labelOf = new Map<string, string>();
  for (const f of form.fields) for (const n of nodesFor(desk.form, f)) labelOf.set(n.key, f.label);
  const expected = ask.expected === "refuse" ? {} : ask.expected;
  const exp = (field: string): string | null => expected[field] ?? null;
  const proposed: Proposed[] = [
    ...(draft?.checked.writes ?? []).map((wr) => {
      const field = labelOf.get(wr.node.key) ?? `(${wr.node.label ?? wr.node.key})`;
      return { field, value: wr.value, expected: exp(field), control: false };
    }),
    ...(draft?.controls ?? []).map((c) => {
      const field = labelOf.get(c.key) ?? `(${c.name})`;
      return { field, value: c.value, expected: exp(field), control: true };
    }),
  ];
  const ok = (p: Proposed): boolean => {
    if (p.expected === null || p.expected === "none" || p.expected === "handoff") return false;
    const f = form.fields.find((x) => x.label === p.field);
    return p.value === p.expected || (f?.accept ?? []).includes(p.value);
  };
  const wanted = Object.entries(expected).filter(([, v]) => v !== "none" && v !== "handoff" && v !== "unchecked").map(([l]) => l);
  const missing = wanted.filter((l) => !proposed.some((p) => p.field === l));
  const verdict: Verdict = proposed.length === 0 ? "refused" : ask.expected === "refuse" || proposed.some((p) => !ok(p)) ? "wrong" : missing.length === 0 ? "right" : "partial";
  rows.push({ ask, route: draft?.route ?? intent?.route ?? "none", verdict, proposed, missing, error, intent, maker: use });
  process.stderr.write(`${ask.id} (${ask.form}): ${verdict} via ${draft?.route ?? "none"}${error === null ? "" : `; ${error.slice(0, 160)}`}\n`);
}

const n = (v: Verdict, xs: readonly Row[] = rows) => xs.filter((r) => r.verdict === v).length;
const refuseAsks = rows.filter((r) => r.ask.expected === "refuse");
const asked = rows.filter((r) => r.verdict === "refused" && r.error !== null && /morning or the evening|which date do you mean|which option|say it in full|which fields|where should|whose details/.test(r.error));
const tokens = rows.flatMap((r) => (r.maker === null ? [] : [r.maker.inputTokens + r.maker.outputTokens]));
const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : Math.round(xs.reduce((s, x) => s + x, 0) / xs.length));
const md = [
  `# Ask scoreboard (B25): ${a["asks-file"]}, maker ${a.maker}`,
  "",
  `Maker ${a.maker}${a.maker === "writer" ? ` (${route.model} on ${route.provider}${route === WRITER_ROUTE ? "" : `, not the configured ${WRITER_ROUTE.model}`})` : ""}. Writer $${writerSpent.toFixed(4)}, ${retries} 429 retries; Jev $${jevSpent.toFixed(4)}.`,
  `Maker tokens per intent (input + output, ${a.maker === "jev" ? "Jev input only" : "the writer's"}): mean ${mean(tokens)}, max ${Math.max(0, ...tokens)}.`,
  "",
  `All ${rows.length}: right ${n("right")}, partial ${n("partial")}, refused ${n("refused")} (of them asked a question ${asked.length}), **wrong ${n("wrong")}**.`,
  `Of the ${refuseAsks.length} that should be refused: refused ${n("refused", refuseAsks)}, wrong ${n("wrong", refuseAsks)}.`,
  "",
  "| ask | form | instruction | verdict | route | proposed | missing | intent | error |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => {
    const it = r.intent === null ? "" : `${r.intent.route}${r.intent.why === "none" ? "" : `/${r.intent.why}`} ${r.intent.scope}${r.intent.scope === "list" ? `[${r.intent.fields.join(",")}]` : ""} src=${r.intent.sources.join(",")} whose=${r.intent.whose}${r.intent.literals.length === 0 ? "" : ` lit=${r.intent.literals.map((l) => `${l.field}:${l.text}`).join(",")}`}`;
    const props = r.proposed.map((p) => `${p.control ? "set " : ""}${p.field} = ${p.value}${ok2(p) ? "" : ` (expected ${p.expected ?? "no change"})`}`).join("; ");
    return `| ${r.ask.id} | ${r.ask.form} | ${r.ask.instruction} | ${r.verdict} | ${r.route} | ${props} | ${r.missing.join("; ")} | ${it} | ${(r.error ?? "").replace(/\|/g, "/").slice(0, 220)} |`;
  }),
];
function ok2(p: Proposed): boolean {
  return p.expected === p.value;
}
writeFileSync(join(OUT, "realfill-asks.md"), md.join("\n") + "\n");
writeFileSync(join(OUT, "realfill-asks.json"), JSON.stringify({ maker: a.maker, model: a.maker === "writer" ? route.model : "jev", jevSpent, writerSpent, retries, rows }, null, 1) + "\n");
process.stderr.write(`right ${n("right")}, partial ${n("partial")}, refused ${n("refused")}, wrong ${n("wrong")}; $${(jevSpent + writerSpent).toFixed(4)}\n`);
