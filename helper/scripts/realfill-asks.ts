// The Ask scoreboard (B24, then B25): natural instructions on the real-form corpus, each on its form's replayed
// desk (realfill-corpus.ts buildDesk), through Ask as the helper runs it (planner/ask.ts): an intent from the
// chosen maker, checked by code, then the scoped fill or the planner. Nothing runs: a proposed plan is scored,
// never executed.
//
//   node scripts/realfill-asks.ts --out DIR [--asks-file asks.json] [--asks a,b] [--maker heads|jev|writer]
//        [--spend-limit USD] [--gap S] [--writer-model provider:model] [--plan-writer provider:model]
//        [--engine jev|llama|gemini] [--log-requests FILE]
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
// B29: an Ask that asks a question with choices is "asked", apart from "refused". For each, option recall says whether
// the right answer is among the options: every expected field for a fields question; the form's corpus source window
// for a source question (none when the source is memory); for a person question, the person whose name an expected
// value holds, else the user. Then the user's pick is simulated (the right options), the Ask continues from it, up to
// three questions deep, and the continued Ask is scored as any other.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AskJev } from "../src/fill/jev.ts";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { engineName } from "../src/engines/decide/port.ts";
import { AskAsks, AskRefused, planAsk, type AskDraft, type AskQuestionDraft } from "../src/planner/ask.ts";
import { jevIntentMaker, writerIntentMaker, type IntentMaker, type MakerUse } from "../src/planner/intent-makers.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import type { AskIntent } from "../src/planner/intent.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { SAYS, SaidError } from "../src/planner/says.ts";
import { makeWriterPort, type WriterPort } from "../src/writer/port.ts";
import { ASK_MAKER } from "../src/writer/config.ts";
import { devWriterRoute } from "../src/writer/routes.ts";
import { ChatHttpError } from "../src/writer/chat.ts";
import { Snapshot } from "../src/protocol.ts";
import { rng } from "../test/large-scene.ts";
import { buildDesk, loadAsks, loadCorpus, nodesFor, T0, type CorpusAsk, type REFUSE_REASONS } from "./realfill-corpus.ts";

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
  },
});
if (a.out === undefined) throw new Error("--out is required");
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
const decide = harnessEngine({ name: engineName(a.engine), canned: null, fixture: { windows: (id) => fixtureIds.has(id), memory: true, plan: true }, ...(a["log-requests"] === undefined ? {} : { logRequests: a["log-requests"] }) });
/** Each decision request's latency, for the bake-off's p50 and p95. */
const requestMs: number[] = [];
let current = "";
const askJev: AskJev = async (req) => {
  if (jevSpent + writerSpent >= SPEND_LIMIT) throw new Error(`spend limit $${SPEND_LIMIT} reached`);
  const r = await decide.ask(req);
  jevSpent += r.costUsd;
  jevModels.add(r.model);
  requestMs.push(r.latencyMs);
  if (a["log-jev"] !== undefined) {
    const qs = { ...req.questions, ...req.nouls };
    appendFileSync(a["log-jev"], JSON.stringify({ ask: current, questions: Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, String(q.instructions).slice(0, 300)])), answers: r.answers, nouls: r.nouls ?? {} }) + "\n");
  }
  return r;
};
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

type Verdict = "right" | "partial" | "wrong" | "refused" | "asked";
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
}

const rows: Row[] = [];
for (const [i, ask] of asks.entries()) {
  const form = corpus.forms.find((f) => f.id === ask.form);
  if (form === undefined) throw new Error(`no form ${ask.form}`);
  const desk = buildDesk(corpus, snaps, form);
  for (const id of desk.model.windows.keys()) fixtureIds.add(id);
  const memory = { values: () => desk.memory };
  const r = rng(Number(a.seed) * 1000 + i);
  const offerKey = `realfill-ask-${ask.id}`;
  current = ask.id;
  const maker: IntentMaker = a.maker === "heads" ? headsIntentMaker(askJev) : a.maker === "jev" || writer === null ? jevIntentMaker(askJev, { rand: (n) => Math.floor(r() * n) }) : writerIntentMaker(writer, () => offerKey);
  let draft: AskDraft | null = null;
  let error: string | null = null;
  let says: string | null = null;
  let detail: string | null = null;
  let intent: AskIntent | null = null;
  let use: MakerUse | null = null;
  let question: AskQuestionDraft | null = null;
  const run = (resume?: AskQuestionDraft["resume"]) =>
    planAsk(ask.instruction, desk.model, memory, desk.about, { askJev, maker, writer: planWriter, offerKey, windowId: desk.form.window.windowId, now: T0, rand: (n) => Math.floor(r() * n), ...(resume === undefined ? {} : { resume }) });
  try {
    draft = await run();
    intent = draft.intent;
    use = draft.maker;
  } catch (e) {
    if (!(e instanceof PlannerError)) throw e;
    error = `${e.code}: ${e.message}`;
    says = e.message;
    detail = e instanceof SaidError ? e.detail : e.message;
    if (e instanceof AskRefused) ((intent = e.intent), (use = e.maker));
    if (e instanceof AskAsks) question = e.question;
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
  const scoreDraft = (d: AskDraft | null, asked: boolean): { verdict: Verdict; proposed: Proposed[]; missing: string[] } => {
    const proposed: Proposed[] = [
      ...(d?.checked.writes ?? []).map((wr) => {
        const field = labelOf.get(wr.node.key) ?? `(${wr.node.label ?? wr.node.key})`;
        return { field, value: wr.value, expected: exp(field), control: false };
      }),
      ...(d?.controls ?? []).map((c) => {
        const field = labelOf.get(c.key) ?? `(${c.name})`;
        return { field, value: c.value, expected: exp(field), control: true };
      }),
    ];
    const missing = wanted.filter((l) => !proposed.some((p) => p.field === l));
    const verdict: Verdict = proposed.length === 0 ? (asked ? "asked" : "refused") : ask.expected === "refuse" || proposed.some((p) => !ok(p)) ? "wrong" : missing.length === 0 ? "right" : "partial";
    return { verdict, proposed, missing };
  };
  const { verdict, proposed, missing } = scoreDraft(draft, question !== null);
  // B29: option recall, then the simulated pick of the right options, continued up to three questions deep.
  const expectedValues = Object.values(expected).filter((v) => v !== "none" && v !== "handoff" && v !== "unchecked" && v !== "checked");
  const rightOf = (q: AskQuestionDraft): { ids: string[]; right: string[] } => {
    if (q.part === "fields") {
      const ids = q.options.filter((c) => wanted.includes(labelOf.get(c.fixes.fields?.[0] ?? "") ?? "")).map((c) => c.option.id);
      return { ids: ids.length === wanted.length && wanted.length > 0 ? ids : [], right: wanted };
    }
    if (q.part === "source") {
      const id = desk.source?.window.windowId ?? null;
      const hit = q.options.find((c) => (id === null ? c.fixes.source?.kind === "memory" : c.fixes.source?.kind === "window" && c.fixes.source.windowId === id));
      return { ids: hit === undefined ? [] : [hit.option.id], right: [desk.source === null ? "memory" : desk.source.window.title] };
    }
    const named = q.options.find((c) => c.option.kind === "person" && expectedValues.some((v) => v.toLowerCase().includes(c.option.kind === "person" ? (c.option.name.toLowerCase().split(/\s+/u)[0] ?? "\u0000") : "\u0000")));
    const pick = named ?? q.options.find((c) => c.option.kind === "you");
    return { ids: pick === undefined ? [] : [pick.option.id], right: [pick === undefined ? "(none)" : pick.option.kind === "you" ? "you" : (pick.option as { name: string }).name] };
  };
  const optionText = (c: AskQuestionDraft["options"][number]): string => {
    const o = c.option;
    return o.kind === "field" ? (labelOf.get(c.fixes.fields?.[0] ?? "") ?? o.label) : o.kind === "window" ? o.title : o.kind === "memory" ? "memory" : o.kind === "you" ? "you" : o.name;
  };
  const askedRows: Row["asked"] = [];
  let continued: Row["continued"] = null;
  let q = question;
  for (let depth = 0; q !== null && depth < 3; depth++) {
    const { ids, right } = rightOf(q);
    askedRows.push({ part: q.part, options: q.options.map(optionText), recall: ids.length > 0, right, picked: ids.map((id) => optionText(q?.options.find((c) => c.option.id === id) as AskQuestionDraft["options"][number])) });
    if (ids.length === 0) break;
    const fixed = { ...q.resume.fixed };
    for (const c of q.options.filter((x) => ids.includes(x.option.id))) {
      if (c.fixes.fields !== undefined) fixed.fields = [...(fixed.fields ?? []), ...c.fixes.fields];
      if (c.fixes.source !== undefined) fixed.source = c.fixes.source;
      if (c.fixes.person !== undefined) fixed.person = c.fixes.person;
    }
    const resume = { ...q.resume, fixed };
    q = null;
    try {
      const d = await run(resume);
      continued = { ...scoreDraft(d, false), says: null };
    } catch (e) {
      if (!(e instanceof PlannerError)) throw e;
      if (e instanceof AskAsks) q = e.question;
      continued = { ...scoreDraft(null, q !== null), says: e.message };
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
      const fixed = { ...q0.resume.fixed };
      for (const c of set) {
        if (c.fixes.fields !== undefined) fixed.fields = [...(fixed.fields ?? []), ...c.fixes.fields];
        if (c.fixes.source !== undefined) fixed.source = c.fixes.source;
        if (c.fixes.person !== undefined) fixed.person = c.fixes.person;
      }
      try {
        const d = await run({ ...q0.resume, fixed });
        for (const p of scoreDraft(d, false).proposed) refusePicks.proposed.push(`${p.field} = ${p.value}`);
      } catch (e) {
        if (!(e instanceof PlannerError)) throw e;
      }
    }
  }
  const fill = (draft?.fill?.fields ?? []).map((f) => ({ field: labelOf.get(f.key) ?? f.descriptor, value: f.value ?? f.handoff?.value ?? null, withheld: f.withheld }));
  const sentenceOk = ask.reason === undefined ? null : says !== null && sentenceFor(ask.reason, says);
  rows.push({ ask, route: draft?.route ?? intent?.route ?? "none", verdict, proposed, missing, error, says, detail, sentenceOk, intent, maker: use, fill, asked: askedRows, continued, refusePicks });
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
const named = refuseAsks.filter((r) => r.ask.reason !== undefined);
const tokens = rows.flatMap((r) => (r.maker === null ? [] : [r.maker.inputTokens + r.maker.outputTokens]));
const makerCalls = rows.flatMap((r) => (r.maker === null ? [] : [r.maker.calls]));
const makerMs = rows.flatMap((r) => (r.maker === null ? [] : [r.maker.latencyMs])).sort((x, y) => x - y);
const pct = (xs: readonly number[], p: number): number => (xs.length === 0 ? 0 : Math.round(xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] as number));
const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : Math.round(xs.reduce((s, x) => s + x, 0) / xs.length));
const md = [
  `# Ask scoreboard (B26): ${a["asks-file"]}, maker ${a.maker}`,
  "",
  `Maker ${a.maker}${route !== null && a.maker === "writer" ? ` (${route.model} on ${route.provider})` : a.maker !== "writer" ? ` (Jev ${jevModels.size === 0 ? "unanswered" : [...jevModels].join(", ")})` : ""}; plan route's writer ${planRoute === null ? "off" : `${planRoute.provider} ${planRoute.model}`}. Writer $${writerSpent.toFixed(4)}, ${retries} 429 retries; Jev $${jevSpent.toFixed(4)}.`,
  `Maker tokens per intent (input + output, ${a.maker === "writer" ? "the writer's" : "Jev input only"}): mean ${mean(tokens)}, max ${Math.max(0, ...tokens)}.`,
  `Decisions: ${decide.says}; ${requestMs.length} requests, latency per request p50 ${pct([...requestMs].sort((x, y) => x - y), 0.5)} ms, p95 ${pct([...requestMs].sort((x, y) => x - y), 0.95)} ms.`,
  `Maker requests per intent: ${[...new Set(makerCalls)].sort((x, y) => x - y).join(", ") || "none"} (${makerCalls.length} intents made); maker latency p50 ${pct(makerMs, 0.5)} ms, p95 ${pct(makerMs, 0.95)} ms.`,
  "",
  `All ${rows.length}: right ${n("right")}, partial ${n("partial")}, asked with choices ${n("asked")}, refused ${n("refused")}, **wrong ${n("wrong")}**.`,
  `Asked ${asked.length}: the right answer among the first question's options in ${recalled.length} (fields ${asked.filter((r) => r.asked[0]?.part === "fields").length}, source ${asked.filter((r) => r.asked[0]?.part === "source").length}, person ${asked.filter((r) => r.asked[0]?.part === "person").length}).`,
  `Must-refuse asks that were asked: ${rows.filter((r) => r.refusePicks !== null).length}; every pick tried (${rows.reduce((s2, r) => s2 + (r.refusePicks?.tried ?? 0), 0)} picks) proposed **${rows.reduce((s2, r) => s2 + (r.refusePicks?.proposed.length ?? 0), 0)} values (all wrong)**${rows.flatMap((r) => (r.refusePicks?.proposed ?? []).map((x) => `${r.ask.id}: ${x}`)).map((x) => `; ${x}`).join("")}.`,
  `After the simulated right pick: right ${cont("right")}, partial ${cont("partial")}, asked again with no right option ${cont("asked")}, refused ${cont("refused")}, **wrong ${cont("wrong")}**; not continued (right answer not offered) ${asked.length - recalled.length}.`,
  `Of the ${refuseAsks.length} that should be refused: refused ${n("refused", refuseAsks)}, wrong ${n("wrong", refuseAsks)}; with the right sentence ${named.filter((r) => r.sentenceOk === true).length} of the ${named.length} that name their reason.`,
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
writeFileSync(join(OUT, "realfill-asks.md"), md.join("\n") + "\n");
writeFileSync(join(OUT, "realfill-asks.json"), JSON.stringify({ engine: decide.says, requestMs, maker: a.maker, model: a.maker === "writer" && route !== null ? route.model : `jev (${[...jevModels].join(", ")})`, jevSpent, writerSpent, retries, rows }, null, 1) + "\n");
process.stderr.write(`right ${n("right")}, partial ${n("partial")}, asked ${n("asked")}, refused ${n("refused")}, wrong ${n("wrong")}; recall ${recalled.length}/${asked.length}; refuse-picks proposed ${rows.reduce((s2, r) => s2 + (r.refusePicks?.proposed.length ?? 0), 0)}; after pick right ${cont("right")} partial ${cont("partial")} wrong ${cont("wrong")}; $${(jevSpent + writerSpent).toFixed(4)}\n`);
