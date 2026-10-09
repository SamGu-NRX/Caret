// The Ask scoreboard (B24, then B25): natural instructions on the real-form corpus, each on its form's replayed
// desk (realfill-corpus.ts buildDesk), through Ask as the helper runs it (planner/ask.ts): an intent from the
// chosen maker, checked by code, then the scoped fill or the planner. Nothing runs: a proposed plan is scored,
// never executed.
//
//   node scripts/realfill-asks.ts --out DIR [--asks-file asks.json] [--asks a,b] [--maker heads|jev|writer]
//        [--spend-limit USD] [--gap S] [--writer-model provider:model] [--plan-writer provider:model]
//        [--engine jev|canned|llama|gemini|decisions] [--log-requests FILE] [--replay JEV_LOG] [--form-window page|reader]
// J1: --engine names the decision engine in Jev's place (engines/decide/harness.ts; llama's server and calibration come
// from CARET_LLAMA_* and CARET_ENGINE_CALIBRATION), behind the record-and-replay cache (CARET_JEV_CACHE, replay-or-record
// by default), so a rerun of unchanged asks costs nothing. Every window and memory entry here comes from fixture files.
// L1: the maker is writer/config.ts ASK_MAKER (Jev) and the plan route has no writer unless a flag names a route
// (writer/routes.ts devWriterRoute); --maker writer needs --writer-model.
// P1: --maker heads is Jev in one request (planner/intent-heads.ts); the report counts each intent's Jev requests.
//
// Each ask's expected values are the fields it asks to change. A plan is right when it writes every expected
// text value and hands off every expected control value (a select's option, a radio, a box, a date or a time),
// and nothing else; partial when all it proposes is right but something expected is missing; wrong when it
// proposes any value that is not expected (or anything at all for "refuse"); refused when it proposes nothing.
// A plan that only names a press for the user proposes nothing. This is stricter than B24's scorer, which
// counted controls apart and called an ask with only control values right whenever a plan wrote nothing wrong.
// Wrong must be 0. Keys come from CARET_ENV_FILE and are never printed; output holds synthetic corpus text only.
//
// Any HTTP 503 in an Ask, its continuations included, makes it "not run" whatever it then proposed or said: b31-03's
// verifier 503 had scored as "no value". Each request is numbered and tied to its Ask when it is sent, so a log line
// stays attributable when its answer arrives after the scorer moved on (four of SCP1's live lines named the next Ask).
//
// B29: an Ask that asks a question with choices is "asked", apart from "refused". For each, option recall says whether
// the right answer is among the options: every expected field for a fields question; the form's corpus source window
// for a source question (none when the source is memory); for a person question, the person whose name an expected
// value holds, else the user. Then the user's pick is simulated (the right options), the Ask continues from it, up to
// three questions deep, and the continued Ask is scored as any other.
import { appendStore, appendStoreJson, writeStore, writeStoreJson } from "../src/privacy/send.ts";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sealRequest, storedRecord, type AskJev } from "../src/fill/jev.ts";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { realfillOracle } from "./realfill-oracle.ts";
import { mintOf, type FillTrace } from "../src/fill/fill.ts";
import { engineName } from "../src/engines/decide/port.ts";
import { answerQuestion, AskAsks, AskRefused, planAsk, type AskDraft, type AskQuestionDraft } from "../src/planner/ask.ts";
import { jevIntentMaker, writerIntentMaker, type IntentMaker, type MakerUse } from "../src/planner/intent-makers.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import type { AskIntent } from "../src/planner/intent.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { SAYS, SaidError } from "../src/planner/says.ts";
import { makeWriterPort, type WriterPort } from "../src/writer/port.ts";
import { ASK_MAKER } from "../src/writer/config.ts";
import { devWriterRoute } from "../src/writer/routes.ts";
import { ChatHttpError } from "../src/writer/chat.ts";
import { attributedJev } from "./attributed-jev.ts";
import { MAX_ASK_OPTIONS, Snapshot } from "../src/protocol.ts";
import { MAX_GENERATOR_VISITS } from "../src/fill/candidates.ts";
import { rng } from "../test/large-scene.ts";
import { buildDesk, loadAsks, loadCorpus, nodesFor, normLabel, pageForm, T0, type CorpusAsk, type REFUSE_REASONS } from "./realfill-corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    corpus: { type: "string", default: join(here, "../../fixtures/realfill") },
    "asks-file": { type: "string", default: "asks.json" },
    windows: { type: "string", default: join(here, "../fixtures/recorded/realfill-windows.ndjson") },
    asks: { type: "string" },
    maker: { type: "string", default: ASK_MAKER },
    "spend-limit": { type: "string", default: "0.10" },
    // Groq allows each candidate 30 requests and 8,000 tokens a minute (console.groq.com/docs/rate-limits, 2026-10-04).
    gap: { type: "string", default: "13" },
    /** Kept so older run scripts still parse: the plan route has no writer unless --plan-writer names one. */
    "no-writer": { type: "boolean", default: false },
    /** The intent writer's route for --maker writer, "groq:<model>" or "gateway:<model>"; the report names it. */
    "writer-model": { type: "string" },
    /** A writer for the plan route's programs, as the helper's --dev-writer; none by default. */
    "plan-writer": { type: "string" },
    seed: { type: "string", default: "24" },
    /** Writes every Jev question and answer to this NDJSON file (synthetic corpus text only). */
    "log-jev": { type: "string" },
    /** J1: the decision engine in Jev's place. */
    engine: { type: "string", default: "jev" },
    /** J1: every request's full body, for the token breakdown (synthetic corpus text only). */
    "log-requests": { type: "string" },
    /** A2: an earlier run's --log-jev file, whose answers are replayed for the same questions (see `recorded`). */
    replay: { type: "string" },
    /**
     * V4: which window the form is. "reader": the reader's recorded Accessibility window, as when no page engine covers
     * Chrome, where no menu shows its options. "page": the page engine's walk of it (realfill-corpus.ts pageForm), the
     * window an Ask plans on when a page engine covers the browser, with every native menu's options.
     * I4 (lead ruling, 2026-10-07): page is the default because the product plans browser Asks on the page walk
     * (helper.ts plans on the page window whenever a page engine covers it), so the reader's desk measured a window no
     * browser Ask uses. Pass "reader" to compare with runs before V4, which all used the reader's window.
     */
    "form-window": { type: "string", default: "page" },
  },
});
if (a.out === undefined) throw new Error("--out is required");
if (a.engine === "decisions" && a.replay !== undefined) throw new Error("--engine decisions cannot use --replay, which substitutes legacy Jev answers; use the engine-specific cache for Decisions replay");
if (a["form-window"] !== "reader" && a["form-window"] !== "page") throw new Error("--form-window is reader or page");
if (a.maker !== "writer" && a.maker !== "jev" && a.maker !== "heads") throw new Error("--maker is heads, jev or writer");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const corpus = loadCorpus(resolve(a.corpus));
const asks = loadAsks(resolve(a.corpus), corpus, a["asks-file"]).filter((x) => a.asks === undefined || a.asks.split(",").includes(x.id));
const snaps = readFileSync(resolve(a.windows), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const SPEND_LIMIT = Number(a["spend-limit"]);
const GAP_MS = Number(a.gap) * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let jevSpent = 0;
/** The model ids Jev's replies named, for the report (L1: every number names its model). */
const jevModels = new Set<string>();
let writerSpent = 0;
/** Windows put on a desk, all from fixture files (buildDesk); the cache and the request log take only their text. */
const fixtureIds = new Set<string>();
/**
 * A1: `--engine canned` is an oracle (realfill-oracle.ts), for when no model can run the Ask path (Laya's free tier takes at
 * most 512 input tokens, and Jev had no credits): it measures what code does with a perfect scope answer, not how a real
 * model scores.
 */
const oracle = realfillOracle({ asks, corpus, current: () => current, traces: () => traces, corpusLabel: () => corpusLabel });
const decide = harnessEngine({ name: engineName(a.engine), canned: oracle, fixture: { windows: (id) => fixtureIds.has(id), memory: true, plan: true },
  logRequests: a["log-requests"] ?? (a.engine === "decisions" ? join(OUT, "requests.ndjson") : undefined),
});
/**
 * A2: answers an earlier live run recorded (its --log-jev file), for developing on its asks without paying for them again.
 * LV1's live runs had the decision cache off, so their log is the only record of what Jev answered. The log keeps each
 * question's id and the first 300 characters of its text, not its options, so a request is replayed only when it asks,
 * in the same ask, exactly the questions a recorded one asked; each recorded answer is used once, in order. A request
 * the code now asks differently goes to --engine. A fill's options are shuffled by the run's seed, so a replayed choice
 * names the same candidate only while the fill offers the same candidates: a replayed run is a guide, and only a live
 * run is a measurement.
 */
const replayKey = (ask: string, qs: Record<string, string>): string => `${ask}\u0000${Object.entries(qs).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, t]) => `${k}=${t}`).join("\u0001")}`;
const recorded = new Map<string, { answers: Awaited<ReturnType<AskJev>>["answers"]; nouls: Record<string, number> }[]>();
if (a.replay !== undefined) {
  for (const line of readFileSync(resolve(a.replay), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const e = JSON.parse(line) as { ask: string; questions?: Record<string, string>; answers?: Awaited<ReturnType<AskJev>>["answers"]; nouls?: Record<string, number> };
    // A dispatch line, or a request that failed: nothing to replay.
    if (e.questions === undefined || e.answers === undefined) continue;
    const k = replayKey(e.ask, e.questions);
    recorded.set(k, [...(recorded.get(k) ?? []), { answers: e.answers, nouls: e.nouls ?? {} }]);
  }
}
const replay = { hits: 0, misses: 0 };
/** Each decision request's latency, for the bake-off's p50 and p95. */
const requestMs: number[] = [];
let current = "";
/** Fill's record of each proposal the current ask made (FillTrace), for the oracle; reset per ask. */
let traces: FillTrace[] = [];
/** The current ask's form, its field keys to the corpus labels, for the oracle. */
let corpusLabel = new Map<string, string>();
/** A1: decision requests by the ask (or "<id>+pick" for the simulated picks after a question) that made them. */
const requestsBy = new Map<string, number>();
const logJev = a["log-jev"];
const jev = attributedJev(async (req, ask) => {
  if (jevSpent + writerSpent >= SPEND_LIMIT) throw new Error(`spend limit $${SPEND_LIMIT} reached`);
  requestsBy.set(ask, (requestsBy.get(ask) ?? 0) + 1);
  const qs = Object.fromEntries(Object.entries({ ...req.questions, ...req.nouls }).map(([k, q]) => [k, String(q.instructions).slice(0, 300)]));
  const hit = a.replay === undefined ? undefined : recorded.get(replayKey(ask, qs))?.shift();
  // Sealed before it is sent: the engine is asked, and the log written, from this frozen copy (PV2).
  const sent = sealRequest(req);
  if (a.replay !== undefined) replay[hit === undefined ? "misses" : "hits"]++;
  const r = hit === undefined ? await decide.ask(sent.asked) : { model: "replay", answers: hit.answers, nouls: hit.nouls, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  jevSpent += r.costUsd;
  jevModels.add(r.model);
  requestMs.push(r.latencyMs);
  return r;
}, () => current, (line) => {
  if (logJev === undefined) return;
  // Each request's dispatch, then its answer or its error, by request number and the Ask that sent it.
  const { request, ask } = line;
  if (line.event === "dispatch") return appendStoreJson(logJev, { request, ask, purpose: line.req.purpose ?? null, dispatchedAt: Date.now() });
  const questions = storedRecord(sealRequest(line.req), (f) => Object.fromEntries(Object.entries({ ...f.questions, ...f.nouls }).map(([k, q]) => [k, String(q.instructions).slice(0, 300)])));
  appendStoreJson(logJev, line.event === "error" ? { request, ask, questions, error: line.error } : { request, ask, questions, answers: line.result.answers, nouls: line.result.nouls ?? {} });
});
const askJev = jev.ask;
// Intents go to the --writer-model named (only with --maker writer); the plan route's programs to --plan-writer's.
if (a.maker === "writer" && a["writer-model"] === undefined) throw new Error("--maker writer needs --writer-model provider:model (no route is a default since L1)");
const route = a["writer-model"] === undefined ? null : devWriterRoute(a["writer-model"]);
const planRoute = a["plan-writer"] === undefined || a["no-writer"] === true ? null : devWriterRoute(a["plan-writer"]);
let retries = 0;
/** A writer, spaced to the provider's per-minute limit, with one wait-and-retry on 429 (counted; WriterPort itself never retries). */
const spaced = (port: WriterPort): WriterPort => {
  let lastWrite = 0;
  return {
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
};
const writer = route === null ? null : spaced(makeWriterPort(route));
const planWriter = planRoute === null ? null : spaced(makeWriterPort(planRoute));

type Verdict = "right" | "partial" | "wrong" | "refused" | "asked" | "notRun";
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
  /** The sentence the user reads, and what the failing check found (planner/says.ts SaidError). */
  says: string | null;
  detail: string | null;
  /** For a must-refuse ask that names its reason: whether the sentence is that reason's. */
  sentenceOk: boolean | null;
  intent: AskIntent | null;
  maker: MakerUse | null;
  /** The scoped fill's answer for each field it asked about, by corpus label, for reading the misses. */
  fill: { field: string; value: string | null; withheld: string | null }[];
  /** B29: the questions asked, each with its options, whether the right answer was among them, and what was picked. */
  asked: { part: string; options: string[]; recall: boolean; right: string[]; picked: string[] }[];
  /** B29: the continued Ask after the simulated picks; null when nothing was asked or the right answer was not offered. */
  continued: { verdict: Verdict; proposed: Proposed[]; missing: string[]; says: string | null } | null;
  /** B29: for a must-refuse ask that was asked, the picks tried and anything they proposed (all of it wrong). */
  refusePicks: { tried: number; proposed: string[] } | null;
  /** A1: decision requests the Ask made before any simulated pick. */
  requests: number;
}

const rows: Row[] = [];
for (const [i, ask] of asks.entries()) {
  const form = corpus.forms.find((f) => f.id === ask.form);
  if (form === undefined) throw new Error(`no form ${ask.form}`);
  const desk = buildDesk(corpus, snaps, form, a["form-window"] === "page" ? pageForm(form) : undefined);
  for (const id of desk.model.windows.keys()) fixtureIds.add(id);
  const memory = { values: () => desk.memory };
  const r = rng(Number(a.seed) * 1000 + i);
  const offerKey = `realfill-ask-${ask.id}`;
  current = ask.id;
  traces = [];
  corpusLabel = new Map(form.fields.flatMap((f) => nodesFor(desk.form, f).map((n) => [n.key, f.label] as const)));
  const maker: IntentMaker = a.maker === "heads" ? headsIntentMaker(askJev) : a.maker === "jev" || writer === null ? jevIntentMaker(askJev, { rand: (n) => Math.floor(r() * n) }) : writerIntentMaker(writer, () => offerKey);
  let draft: AskDraft | null = null;
  let error: string | null = null;
  let says: string | null = null;
  let detail: string | null = null;
  let intent: AskIntent | null = null;
  let use: MakerUse | null = null;
  let question: AskQuestionDraft | null = null;
  let asked0: AskAsks | null = null;
  const run = (resume?: AskQuestionDraft["resume"]) =>
    planAsk(ask.instruction, desk.model, memory, desk.about, { askJev, maker, writer: planWriter, offerKey, windowId: desk.form.window.windowId, now: T0, rand: (n) => Math.floor(r() * n), fillTrace: (t) => traces.push(t), values: true, ...(resume === undefined ? {} : { resume }) });
  try {
    draft = await run();
    intent = draft.intent;
    use = draft.maker;
    // I3: the fields the Ask left to the user because Jev wasn't sure the request asks for them.
    if (draft.unsure !== undefined) detail = `left to you (unsure): ${draft.unsure.map((u) => u.name).join(", ")}`;
  } catch (e) {
    if (!(e instanceof PlannerError)) throw e;
    error = `${e.code}: ${e.message}`;
    says = e.message;
    detail = e instanceof SaidError ? e.detail : e.message;
    if (e instanceof AskRefused) ((intent = e.intent), (use = e.maker));
    if (e instanceof AskAsks) {
      question = e.question;
      asked0 = e;
    }
  }
  const labelOf = new Map<string, string>();
  for (const f of form.fields) for (const n of nodesFor(desk.form, f)) labelOf.set(n.key, f.label);
  const expected = ask.expected === "refuse" ? {} : ask.expected;
  const exp = (field: string): string | null => expected[field] ?? null;
  const ok = (p: Proposed): boolean => {
    if (p.expected === null || p.expected === "none" || p.expected === "handoff") return false;
    const f = form.fields.find((x) => x.label === p.field);
    return p.value === p.expected || (f?.accept ?? []).includes(p.value);
  };
  const wanted = Object.entries(expected).filter(([, v]) => v !== "none" && v !== "handoff" && v !== "unchecked").map(([l]) => l);
  /**
   * What an Ask proposes: a draft's checked writes and controls; while a value question is open, the fill it is about, by
   * its checked writes (a field with a mint) and its controls, which is what settled before the user answers.
   */
  const scoreDraft = (d: AskDraft | AskAsks | null, asked: boolean): { verdict: Verdict; proposed: Proposed[]; missing: string[] } => {
    const fill = d instanceof AskAsks ? (d.question.resume.values?.proposal.fields ?? []) : [];
    const writes = d instanceof AskAsks ? fill.flatMap((f) => (f.control === "text" && f.value !== null && mintOf(f) !== undefined ? [{ key: f.key, value: f.value }] : [])) : (d?.checked.writes ?? []).map((wr) => ({ key: wr.node.key, value: wr.value }));
    const controls = d instanceof AskAsks ? fill.flatMap((f) => (f.handoff === null ? [] : [{ key: f.key, value: f.handoff.value }])) : (d?.controls ?? []);
    const proposed: Proposed[] = [
      ...writes.map((wr) => {
        const field = labelOf.get(wr.key) ?? `(${wr.key})`;
        return { field, value: wr.value, expected: exp(field), control: false };
      }),
      ...controls.map((c) => {
        const field = labelOf.get(c.key) ?? `(${c.key})`;
        return { field, value: c.value, expected: exp(field), control: true };
      }),
    ];
    const missing = wanted.filter((l) => !proposed.some((p) => p.field === l));
    const verdict: Verdict = proposed.length === 0 ? (asked ? "asked" : "refused") : ask.expected === "refuse" || proposed.some((p) => !ok(p)) ? "wrong" : missing.length === 0 ? "right" : "partial";
    return { verdict, proposed, missing };
  };
  // A value question's Ask is scored by the fill it is about: what settled before the user answers.
  const scored = scoreDraft(draft ?? (question?.part === "value" ? asked0 : null), question !== null);
  const { proposed, missing } = scored;
  // B29: option recall, then the simulated pick of the right options, continued up to three questions deep.
  const expectedValues = Object.values(expected).filter((v) => v !== "none" && v !== "handoff" && v !== "unchecked" && v !== "checked");
  /** The right picks, or null when the right answer is not on offer. A question beside fields Caret settled may be answered with no pick. */
  const rightOf = (q: AskQuestionDraft): { ids: string[] | null; right: string[] } => {
    if (q.part === "fields") {
      const settledKeys = (q.resume.intent.sure ?? []).flatMap((r) => q.resume.refs.fields[r] ?? []);
      const rest = wanted.filter((l) => !settledKeys.some((k) => labelOf.get(k) === l));
      const ids = q.options.filter((c) => rest.includes(labelOf.get(c.fixes.fields?.[0] ?? "") ?? "")).map((c) => c.option.id);
      const answerable = ids.length === rest.length && (rest.length > 0 || q.filling.length > 0);
      return { ids: answerable ? ids : null, right: rest };
    }
    if (q.part === "source") {
      const id = desk.source?.window.windowId ?? null;
      const hit = q.options.find((c) => (id === null ? c.fixes.source?.kind === "memory" : c.fixes.source?.kind === "window" && c.fixes.source.windowId === id));
      return { ids: hit === undefined ? null : [hit.option.id], right: [desk.source === null ? "memory" : desk.source.window.title] };
    }
    if (q.part === "value") {
      // The right value as the field takes it (corpus `expected` or `accept`), by the exact output the option stands for; else Leave blank.
      const u = q.resume.values?.queue[0];
      const label = labelOf.get(u?.key ?? "") ?? "";
      const accepts = [exp(label), ...(form.fields.find((f) => f.label === label)?.accept ?? [])];
      const exact = (c: AskQuestionDraft["options"][number]): string | undefined => u?.options.find((o) => o.id === c.fixes.values?.[0]?.option)?.value;
      const hit = q.options.find((c) => c.option.kind === "value" && accepts.includes(exact(c) ?? null));
      const blank = q.options.find((c) => c.option.kind === "blank");
      return { ids: [(hit ?? blank)?.option.id ?? ""], right: [hit === undefined ? "(leave blank)" : (exact(hit) ?? "")] };
    }
    const named = q.options.find((c) => c.option.kind === "person" && expectedValues.some((v) => v.toLowerCase().includes(c.option.kind === "person" ? (c.option.name.toLowerCase().split(/\s+/u)[0] ?? "\u0000") : "\u0000")));
    const pick = named ?? q.options.find((c) => c.option.kind === "you");
    return { ids: pick === undefined ? null : [pick.option.id], right: [pick === undefined ? "(none)" : pick.option.kind === "you" ? "you" : (pick.option as { name: string }).name] };
  };
  const optionText = (c: AskQuestionDraft["options"][number]): string => {
    const o = c.option;
    return o.kind === "field" ? (labelOf.get(c.fixes.fields?.[0] ?? "") ?? o.label) : o.kind === "window" ? o.title : o.kind === "memory" ? "memory" : o.kind === "you" ? "you" : o.kind === "value" ? o.value : o.kind === "blank" ? "(leave blank)" : o.name;
  };
  const askedRows: Row["asked"] = [];
  let continued: Row["continued"] = null;
  current = `${ask.id}+pick`;
  let q = question;
  // Up to three questions about the Ask's parts, then each value question (at most MAX_ASK_OPTIONS of them).
  for (let depth = 0; q !== null && depth < 3 + MAX_ASK_OPTIONS; depth++) {
    const { ids, right } = rightOf(q);
    askedRows.push({ part: q.part, options: q.options.map(optionText), recall: ids !== null, right, picked: (ids ?? []).map((id) => optionText(q?.options.find((c) => c.option.id === id) as AskQuestionDraft["options"][number])) });
    if (ids === null) break;
    // No pick answers a question beside settled fields: those alone are filled (helper.ts handleAskAnswer).
    const resume = answerQuestion(q, ids);
    if (typeof resume === "string") throw new Error(`the simulated pick does not fit ${ask.id}'s question: ${resume}`);
    q = null;
    try {
      const d = await run(resume);
      continued = { ...scoreDraft(d, false), says: null };
    } catch (e) {
      if (!(e instanceof PlannerError)) throw e;
      if (e instanceof AskAsks) q = e.question;
      continued = { ...scoreDraft(e instanceof AskAsks && e.question.part === "value" ? e : null, q !== null), says: e.message };
    }
  }
  // A must-refuse ask that was asked: pick every option of a fields question, or each option of any other in turn, and
  // continue one step. Anything proposed is wrong (B29 safety check; the asks have no right option to pick).
  let refusePicks: Row["refusePicks"] = null;
  if (ask.expected === "refuse" && question !== null) {
    const q0 = question;
    const picks = q0.part === "fields" ? [q0.options] : q0.options.map((c) => [c]);
    refusePicks = { tried: picks.length, proposed: [] };
    for (const set of picks) {
      const resume = answerQuestion(q0, set.map((c) => c.option.id));
      if (typeof resume === "string") throw new Error(`the hostile pick does not fit ${ask.id}'s question: ${resume}`);
      try {
        const d = await run(resume);
        for (const p of scoreDraft(d, false).proposed) refusePicks.proposed.push(`${p.field} = ${p.value}`);
      } catch (e) {
        if (!(e instanceof PlannerError)) throw e;
      }
    }
  }
  // HTTP 503 anywhere in this Ask, its picks included: not run, and rerun under the same id. Read once every request the
  // Ask sent has answered, so a 503 arriving after the Ask ended still counts.
  const verdict: Verdict = (await jev.notRun(ask.id)) ? "notRun" : scored.verdict;
  const fill = (draft?.fill?.fields ?? []).map((f) => ({ field: labelOf.get(f.key) ?? f.descriptor, value: f.value ?? f.handoff?.value ?? null, withheld: f.withheld }));
  const sentenceOk = ask.reason === undefined ? null : says !== null && sentenceFor(ask.reason, says);
  rows.push({ ask, route: draft?.route ?? intent?.route ?? "none", verdict, proposed, missing, error, says, detail, sentenceOk, intent, maker: use, fill, asked: askedRows, continued, refusePicks, requests: requestsBy.get(ask.id) ?? 0 });
  process.stderr.write(`${ask.id} (${ask.form}): ${verdict} via ${draft?.route ?? "none"}${error === null ? "" : `; ${error.slice(0, 160)}`}${detail === null || detail === says ? "" : ` [${detail.slice(0, 200)}]`}\n`);
}

/** Whether a refusal's sentence is the one its reason calls for. */
function sentenceFor(reason: (typeof REFUSE_REASONS)[number], says: string): boolean {
  switch (reason) {
    case "neverTyped":
      return /^Caret doesn't type .+\. Type it yourself\.$/u.test(says);
    case "payment":
      return says === SAYS.payment;
    case "submit":
      return says === SAYS.submit;
    case "send":
      return says === SAYS.send;
    case "whichPerson":
      return says === SAYS.whichPerson;
    case "noSuchField":
      return says === SAYS.noSuchField;
    case "notOnScreen":
      return says === SAYS.notOnScreen;
  }
}

const n = (v: Verdict, xs: readonly Row[] = rows) => xs.filter((r) => r.verdict === v).length;
const refuseAsks = rows.filter((r) => r.ask.expected === "refuse");
const asked = rows.filter((r) => r.verdict === "asked");
const recalled = asked.filter((r) => r.asked[0]?.recall === true);
const cont = (v: Verdict) => asked.filter((r) => r.continued?.verdict === v).length;
const valued = rows.filter((r) => r.asked.some((q) => q.part === "value"));
const named = refuseAsks.filter((r) => r.ask.reason !== undefined);
const tokens = rows.flatMap((r) => (r.maker === null ? [] : [r.maker.inputTokens + r.maker.outputTokens]));
const makerCalls = rows.flatMap((r) => (r.maker === null ? [] : [r.maker.calls]));
const makerMs = rows.flatMap((r) => (r.maker === null ? [] : [r.maker.latencyMs])).sort((x, y) => x - y);
const pct = (xs: readonly number[], p: number): number => (xs.length === 0 ? 0 : Math.round(xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] as number));
const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : Math.round(xs.reduce((s, x) => s + x, 0) / xs.length));
/**
 * A1: an ask back is an Ask that ends asking the user instead of acting: a question with choices, or a refusal that
 * says Caret was unsure ("Which fields do you mean?", "Is 8:15 in the morning or the evening?"). Must-refuse asks and
 * asks whose right outcome is a question (CorpusAsk.ask) are not counted. A question is useful when its first
 * options hold the right answer (recall).
 */
const askedBack = (r: Row): boolean => r.ask.expected !== "refuse" && r.ask.ask === undefined && (r.verdict === "asked" || (r.verdict === "refused" && r.error?.startsWith("unsure:") === true));
const back = rows.filter(askedBack);
const rightAsks = rows.filter((r) => r.ask.ask !== undefined && r.verdict === "asked" && r.asked[0]?.part === r.ask.ask && r.asked[0]?.recall === true);
const firstRequests = rows.map((r) => r.requests);
const kinds = [...new Set(rows.flatMap((r) => (r.ask.kind === undefined ? [] : [r.ask.kind])))];
const md = [
  `# Ask scoreboard (B26): ${a["asks-file"]}, maker ${a.maker}, form window ${a["form-window"]}`,
  "",
  `Maker ${a.maker}${route !== null && a.maker === "writer" ? ` (${route.model} on ${route.provider})` : a.maker !== "writer" ? ` (Jev ${jevModels.size === 0 ? "unanswered" : [...jevModels].join(", ")})` : ""}; plan route's writer ${planRoute === null ? "off" : `${planRoute.provider} ${planRoute.model}`}. Writer $${writerSpent.toFixed(4)}, ${retries} 429 retries; Jev $${jevSpent.toFixed(4)}.`,
  `Maker tokens per intent (input + output, ${a.maker === "writer" ? "the writer's" : "Jev input only"}): mean ${mean(tokens)}, max ${Math.max(0, ...tokens)}.`,
  ...(a.replay === undefined ? [] : [`Replayed from ${a.replay}: ${replay.hits} requests; ${replay.misses} asked of ${decide.says} instead.`]),
  `Decisions: ${decide.says}; generator cap ${MAX_GENERATOR_VISITS} visits; ${requestMs.length} requests, latency per request p50 ${pct([...requestMs].sort((x, y) => x - y), 0.5)} ms, p95 ${pct([...requestMs].sort((x, y) => x - y), 0.95)} ms.`,
  `Maker requests per intent: ${[...new Set(makerCalls)].sort((x, y) => x - y).join(", ") || "none"} (${makerCalls.length} intents made); maker latency p50 ${pct(makerMs, 0.5)} ms, p95 ${pct(makerMs, 0.95)} ms.`,
  "",
  `All ${rows.length}: right ${n("right")}, partial ${n("partial")}, asked with choices ${n("asked")}, refused ${n("refused")}, **wrong ${n("wrong")}**; not run (HTTP 503) ${n("notRun")}${n("notRun") === 0 ? "" : `, rerun ${rows.filter((r) => r.verdict === "notRun").map((r) => r.ask.id).join(",")}`}.`,
  `Asked ${asked.length}: the right answer among the first question's options in ${recalled.length} (fields ${asked.filter((r) => r.asked[0]?.part === "fields").length}, source ${asked.filter((r) => r.asked[0]?.part === "source").length}, person ${asked.filter((r) => r.asked[0]?.part === "person").length}).`,
  `Must-refuse asks that were asked: ${rows.filter((r) => r.refusePicks !== null).length}; every pick tried (${rows.reduce((s2, r) => s2 + (r.refusePicks?.tried ?? 0), 0)} picks) proposed **${rows.reduce((s2, r) => s2 + (r.refusePicks?.proposed.length ?? 0), 0)} values (all wrong)**${rows.flatMap((r) => (r.refusePicks?.proposed ?? []).map((x) => `${r.ask.id}: ${x}`)).map((x) => `; ${x}`).join("")}.`,
  `After the simulated right pick: right ${cont("right")}, partial ${cont("partial")}, asked again with no right option ${cont("asked")}, refused ${cont("refused")}, **wrong ${cont("wrong")}**; not continued (right answer not offered) ${asked.length - recalled.length}.`,
  `Value questions (scripted right pick, else Leave blank): ${valued.length} Asks asked ${valued.reduce((x, r) => x + r.asked.filter((q) => q.part === "value").length, 0)}, picking a value in ${valued.reduce((x, r) => x + r.asked.filter((q) => q.part === "value" && q.picked[0] !== "(leave blank)").length, 0)}; after them right ${valued.filter((r) => r.continued?.verdict === "right").length}, partial ${valued.filter((r) => r.continued?.verdict === "partial").length}, **wrong ${valued.filter((r) => r.continued?.verdict === "wrong").length}**. The verdicts above are automatic: before any value question.`,
  `Of the ${refuseAsks.length} that should be refused: refused ${n("refused", refuseAsks)}, wrong ${n("wrong", refuseAsks)}; with the right sentence ${named.filter((r) => r.sentenceOk === true).length} of the ${named.length} that name their reason.`,
  `A1 asks back: ${back.length} (asked with choices ${back.filter((r) => r.verdict === "asked").length}, the right option offered in ${back.filter((r) => r.asked[0]?.recall === true).length}; refused as unsure ${back.filter((r) => r.verdict === "refused").length}). Asks whose right outcome is a question: ${rows.filter((r) => r.ask.ask !== undefined).length}, asked rightly ${rightAsks.length}.`,
  `A1 decision requests per ask before any pick: mean ${(firstRequests.reduce((x, y) => x + y, 0) / Math.max(1, firstRequests.length)).toFixed(2)}, max ${Math.max(0, ...firstRequests)}; ${requestMs.length} requests in all, with the simulated picks.`,
  ...(kinds.length === 0 ? [] : ["", "| kind | asks | right | partial | asked | refused | wrong | asked back |", "|---|---|---|---|---|---|---|---|", ...kinds.map((k) => { const xs = rows.filter((r) => r.ask.kind === k); return `| ${k} | ${xs.length} | ${n("right", xs)} | ${n("partial", xs)} | ${n("asked", xs)} | ${n("refused", xs)} | ${n("wrong", xs)} | ${xs.filter(askedBack).length} |`; })]),
  "",
  "| ask | form | instruction | verdict | route | proposed | missing | intent | says | detail | asked (options; right; recall) | after pick |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => {
    const it = r.intent === null ? "" : `${r.intent.route}${r.intent.why === "none" ? "" : `/${r.intent.why}`} ${r.intent.scope}${r.intent.scope === "list" ? `[${r.intent.fields.join(",")}]` : ""} src=${r.intent.sources.join(",")} whose=${r.intent.whose}${r.intent.literals.length === 0 ? "" : ` lit=${r.intent.literals.map((l) => `${l.field}:${l.text}`).join(",")}`}`;
    const props = r.proposed.map((p) => `${p.control ? "set " : ""}${p.field} = ${p.value}${ok2(p) ? "" : ` (expected ${p.expected ?? "no change"})`}`).join("; ");
    const sentence = r.says === null ? "" : `${r.sentenceOk === false ? "WRONG SENTENCE: " : ""}${r.error?.split(":")[0] ?? ""}: ${r.says}`;
    const qs = r.asked.map((x) => `${x.part}: [${x.options.join("; ")}]; right ${x.right.join("; ")}; ${x.recall ? `picked ${x.picked.join("; ")}` : "NOT OFFERED"}`).join(" -> ");
    const after = r.continued === null ? "" : `${r.continued.verdict}: ${r.continued.proposed.map((p) => `${p.field} = ${p.value}${ok2(p) ? "" : ` (expected ${p.expected ?? "no change"})`}`).join("; ")}${r.continued.missing.length === 0 ? "" : ` missing ${r.continued.missing.join("; ")}`}${r.continued.says === null ? "" : ` says ${r.continued.says}`}`;
    return `| ${r.ask.id} | ${r.ask.form} | ${r.ask.instruction} | ${r.verdict} | ${r.route} | ${props} | ${r.missing.join("; ")} | ${it} | ${sentence.replace(/\|/g, "/")} | ${(r.detail ?? "").replace(/\|/g, "/").slice(0, 200)} | ${qs.replace(/\|/g, "/")} | ${after.replace(/\|/g, "/")} |`;
  }),
];
function ok2(p: Proposed): boolean {
  return p.expected === p.value;
}
writeStore(join(OUT, "realfill-asks.md"), md.join("\n") + "\n");
writeStoreJson(join(OUT, "realfill-asks.json"), { engine: decide.says, formWindow: a["form-window"], requestMs, maker: a.maker, model: a.maker === "writer" && route !== null ? route.model : `jev (${[...jevModels].join(", ")})`, jevSpent, writerSpent, retries, rows }, 1);
process.stderr.write(`right ${n("right")}, partial ${n("partial")}, asked ${n("asked")}, refused ${n("refused")}, wrong ${n("wrong")}, not run ${n("notRun")}${n("notRun") === 0 ? "" : ` (rerun ${rows.filter((r) => r.verdict === "notRun").map((r) => r.ask.id).join(",")})`}; asked back ${back.length}; recall ${recalled.length}/${asked.length}; refuse-picks proposed ${rows.reduce((s2, r) => s2 + (r.refusePicks?.proposed.length ?? 0), 0)}; after pick right ${cont("right")} partial ${cont("partial")} wrong ${cont("wrong")}; $${(jevSpent + writerSpent).toFixed(4)}${a.replay === undefined ? "" : `; replayed ${replay.hits}, missed ${replay.misses}`}\n`);
