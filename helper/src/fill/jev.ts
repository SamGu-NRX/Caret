// System One through TypeSafe or Vercel (brief GW1). Keys are read at call time from the environment or
// CARET_ENV_FILE. Gateway uses only CARET_JEV_GATEWAY_KEY, never the writer's AI_GATEWAY_API_KEY.
import { readFileSync } from "node:fs";
import * as z from "zod";
import { assertNoExcludedValue, type Snippet } from "../privacy.ts";
import { storable, UnmintedText, verifySent, type Disclosure, type ModelText, type ModelValue } from "../privacy/disclosure.ts";
import { frozenRequest, seal, sealedBody, type Sealed } from "../privacy/send.ts";
import { jevPolicy } from "../privacy/providers.ts";
import { DailySpend, JevCapError } from "../engines/decide/daily-cap.ts";
import { checkFixture, refuseShipped, type FixtureSources } from "../engines/decide/cache.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_GATEWAY_URL = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";
export const JEV_GATEWAY_MODEL = "typesafe-ai/jev";
export type JevProvider = "typesafe" | "gateway";
export interface JevSettings {
  provider: JevProvider;
  url: string;
  model: string;
}

function setting(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const direct = env[name];
  if (direct !== undefined && direct !== "") return direct;
  const file = env.CARET_ENV_FILE;
  if (file === undefined || file === "") return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] === name && m[2] !== undefined) {
      const value = m[2].replace(/^(['"])(.*)\1$/, "$2").trim();
      if (value !== "") return value;
    }
  }
  return undefined;
}

/** Gateway is opt-in; Laya is used only when CARET_JEV_MODEL or the bake-off names it (brief GW1). */
export function jevSettings(env: NodeJS.ProcessEnv = process.env): JevSettings {
  const provider = setting("CARET_JEV_PROVIDER", env) ?? "typesafe";
  if (provider !== "typesafe" && provider !== "gateway") throw new Error("CARET_JEV_PROVIDER must be typesafe or gateway");
  return {
    provider,
    url: provider === "gateway" ? JEV_GATEWAY_URL : JEV_URL,
    model: setting("CARET_JEV_MODEL", env) ?? (provider === "gateway" ? JEV_GATEWAY_MODEL : JEV_MODEL),
  };
}
/** Sourced: $0.042 per million input tokens, output free (https://docs.typesafe.ai/models.md). */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/**
 * How a Jev request failed, which decides what the user can do about it (lead addendum, 2026-10-06):
 * - `billing`: HTTP 402, the account has no credits; trying again does not help until someone adds them.
 * - `auth`: HTTP 401 or a 403 without a recognised gateway account code, the key is wrong or revoked.
 * - `card`: gateway 403 customer_verification_required; Vercel needs a card on file.
 * - `paidCredits`: gateway 403 no_providers_available; Jev needs paid Vercel credits.
 * - `rate`: HTTP 429 after the client's one retry (or the first 429, for a caller that allows no retry).
 * - `network`: no HTTP answer at all: DNS, a dropped connection, or no answer within the client's timeout.
 * - `service`: any other HTTP error, such as a 500 from the service.
 * - `cap`: nothing was sent, because the day's spend reached CARET_JEV_DAILY_CAP (engines/decide/daily-cap.ts, J1).
 */
export type JevFailureKind = "billing" | "auth" | "rate" | "network" | "service" | "cap" | "card" | "paidCredits";

function httpKind(status: number, detail: string, provider: JevProvider): JevFailureKind {
  if (status === 403 && provider === "gateway") {
    // Only the structured code means a missing card; an arbitrary 403 still means auth.
    try {
      const error = JSON.parse(detail) as { error?: { code?: unknown; type?: unknown }; error_type?: unknown };
      const code = error?.error?.code ?? error?.error?.type ?? error?.error_type;
      if (code === "customer_verification_required") return "card";
      if (code === "no_providers_available") return "paidCredits";
    } catch { /* A non-JSON error retains its HTTP kind. */ }
  }
  if (status === 402) return "billing";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate";
  return "service";
}

/**
 * Jev answered with an HTTP error. The message keeps its old form ("Jev HTTP <status>: <the service's text>") for logs;
 * `status` and `kind` are for callers that tell the user what to do (planner/says.ts jevFailureSays).
 */
export class JevHttpError extends Error {
  readonly status: number;
  readonly kind: JevFailureKind;
  constructor(status: number, detail: string, provider: JevProvider = "typesafe") {
    super(`Jev HTTP ${status}: ${detail.slice(0, 300)}`);
    this.name = "JevHttpError";
    this.status = status;
    this.kind = httpKind(status, detail, provider);
  }
}

/** The request got no HTTP answer: the connection failed or the client's timeout passed. */
export class JevNetworkError extends Error {
  readonly kind = "network" as const;
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "JevNetworkError";
  }
}

/**
 * The kind of Jev failure behind `e`, following `cause` links a few deep (a wrapper may keep the client's error as its
 * cause), or null when `e` is not a Jev client failure.
 */
export function jevFailureKind(e: unknown): JevFailureKind | null {
  let at: unknown = e;
  for (let depth = 0; depth < 4 && at instanceof Error; depth++) {
    if (at instanceof JevHttpError || at instanceof JevNetworkError || at instanceof JevCapError || at instanceof JevGatewayPolicyError) return at.kind;
    at = at.cause;
  }
  return null;
}

/** SC1 2b: every text a question carries is ModelText, minted by its request's Disclosure (privacy/disclosure.ts). */
export interface ChoiceQuestion {
  type: "choice";
  instructions: ModelText;
  criteria: Record<string, ModelText | null>;
}

/** A yes/no question; Jev answers with the probability of yes (docs.typesafe.ai/api, "Noul"), and no confidence. */
export interface NoulQuestion {
  type: "noul";
  instructions: ModelText;
  criteria?: { true: ModelText; false: ModelText };
}

/**
 * What a request asks, by its builder (W1). Never sent. Question ids repeat across builders ("f1" is a fill value, an
 * Ask's field confirmation and a plan check's field) and so do option sets (yes/no), so an evaluation's canned engine
 * answers by this and the question's id (engines/decide/canned.ts), and refuses a request whose purpose it has no rule
 * for rather than answering it with silence.
 */
export type JevPurpose =
  | "fill.whose" | "fill.values" | "fill.verify" | "ask.heads" | "ask.scope" | "ask.confirm" | "intent.route" | "intent.fields" | "plan.verify" | "codeplan.asksAbout"
  | "planner.window" | "planner.fields" | "savedFile.match" | "codemode.choice" | "draft.check" | "event.card" | "pattern.naming"
  | "executor.target" | "route.judge" | "route.task" | "route.pick" | "pending.change" | "pending.look" | "probe.latency";

export interface JevRequest {
  /** What the request asks (JevPurpose); absent only in tests' hand-built requests, which no canned engine answers. */
  purpose?: JevPurpose;
  /** SC1 2b: minted text, numbers, booleans, null, and lists and records of them (privacy/disclosure.ts ModelValue). */
  state: ModelValue;
  questions: Record<string, ChoiceQuestion>;
  /**
   * Yes/no questions sent beside `questions` in the same request, by id (B25). Kept apart so every caller that
   * reads a choice's criteria and confidence stays as it was; ids must not repeat a choice question's.
   */
  nouls?: Record<string, NoulQuestion>;
  /**
   * Every piece of screen text in `state` and `questions`, with its window, as the builder took it through
   * a SnippetLedger (privacy.ts). Never sent: the client posts `state` and `questions` only.
   */
  snippets: readonly Snippet[];
  /**
   * Characters the ledger charged each window for this request, by window id (SnippetLedger.charges):
   * what it held to the window's budget. Never sent; privacy.test.ts checks its own measure against it.
   */
  charged: Readonly<Record<string, number>>;
  /**
   * Whether the client may wait out one 429 and send again. The routers promise one choice per context and set it
   * false (action engine v2, section 3: no transparent retry); absent means the one retry every other caller has had.
   */
  retry429?: boolean;
  /**
   * Windows the user's Ask named, which may give this request up to WINDOW_CHARS whatever their kind (privacy.ts
   * CONSENTED). Never sent; privacy.test.ts holds every other window to its usual rules.
   */
  consented?: readonly string[];
  /**
   * G2: for each whose-value question (fill.ts ownerId), the text of the value it asks about, so an evaluation harness
   * answers from the value itself and never parses it back out of the question (page-loop-eval.ts canned Jev). Never
   * sent: the text is already in the question, through the ledger.
   */
  subjects?: Readonly<Record<string, string>>;
  /**
   * SC1 2b: the Disclosure that minted every text in this request (privacy/disclosure.ts). Never sent: the client
   * verifies the wire body against it, and refuses a request without one.
   */
  disclosure: Disclosure;
}

const ChoiceAnswer = z.object({ choice: z.string(), confidence: z.number(), probabilities: z.record(z.string(), z.number()).optional() }).loose();
const NoulAnswer = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).loose();
const JevResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.union([NoulAnswer, ChoiceAnswer])),
  usage: z.object({ input_tokens: z.number() }).loose(),
  provider_metadata: z.unknown().optional(),
});

const GatewayCost = z.union([
  z.number(),
  z.string().regex(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/).transform(Number),
]).pipe(z.number().finite().nonnegative());
const GatewayMetadata = z.object({ gateway: z.object({ cost: GatewayCost.optional() }).loose().optional() }).loose();

/** Vercel reports dollars as a string; zero is a real cost, not a missing estimate (Vercel TypeSafe API docs). */
export function jevCostUsd(inputTokens: number, provider: JevProvider, metadata?: unknown): number {
  const cost = provider === "gateway" && metadata !== undefined ? GatewayMetadata.parse(metadata).gateway?.cost : undefined;
  return cost ?? inputTokens * JEV_USD_PER_INPUT_TOKEN;
}

export interface JevResult {
  model: string;
  answers: Record<string, { choice: string; confidence: number }>;
  /** The probability of yes for each of the request's `nouls`, by id; absent when it asked none. */
  nouls?: Record<string, number>;
  /**
   * Each choice question's probability for every option, by question id, when the engine reports them (Jev does, as
   * `probabilities`; docs.typesafe.ai/primitives/choice). Engines other than Jev compute `confidence` from these as Jev
   * documents it (engines/decide/confidence.ts), so a caller's floor means the same for every engine.
   */
  probabilities?: Record<string, Record<string, number>>;
  inputTokens: number;
  latencyMs: number;
  costUsd: number;
}

export type AskJev = (req: JevRequest) => Promise<JevResult>;

export function loadJevKey(provider?: JevProvider): string;
export function loadJevKey(env: NodeJS.ProcessEnv, provider?: JevProvider): string;
export function loadJevKey(envOrProvider: NodeJS.ProcessEnv | JevProvider = process.env, selectedProvider?: JevProvider): string {
  const env = typeof envOrProvider === "string" ? process.env : envOrProvider;
  const provider = typeof envOrProvider === "string" ? envOrProvider : selectedProvider ?? jevSettings(env).provider;
  const name = provider === "gateway" ? "CARET_JEV_GATEWAY_KEY" : "TYPESAFE_API_KEY";
  const value = setting(name, env);
  if (value !== undefined) return value;
  throw new Error(`Jev key missing: set ${name}, or CARET_ENV_FILE to a .env file that defines it`);
}

/** The state key under which a body describes, once, the options several of its questions share (wireBody). */
export const OPTION_DESCRIPTIONS = "option_descriptions";

/** What the client posts: the request's state, the model, and its choice and yes/no questions in one map. */
export interface WireBody {
  state: JevRequest["state"];
  model: string;
  questions: Record<string, ChoiceQuestion | NoulQuestion>;
  providerOptions?: { gateway: { only: string[] } };
}

/**
 * The body posted for `req` (J1 part A2). An option that two or more choice questions list under the same id with the
 * same description is described once, in the state under OPTION_DESCRIPTIONS, and each of those questions lists it with
 * no description, as TypeSafe's line-search recipe lists line ids whose text is in the state
 * (docs.typesafe.ai/cookbooks/semantic_find). A fill asks every field about every candidate, so this carries each
 * candidate once instead of once per field: on the corpus's fill requests the body is 36% of its old size
 * (evidence/screen/j1, probe/fill-base.ndjson). Nothing is dropped; expandWireBody gives back the request's questions.
 * Only a state that is a JSON object takes the key; a string state is sent as it was.
 *
 * Off until there is evidence on how Jev answers in this shape: Jev's credits ran out before it could be asked (HTTP 402
 * since 2026-10-06), and a body that says the same need not get the same answers (J1 review). Turning it on needs one
 * live run of the corpus and W4 pages compared with evidence/screen/p2/goal-live-3 and p1/loop-live, wrong 0 first.
 */
export const HOIST_SHARED_OPTIONS = false;

export function wireBody(req: JevRequest, model: string = JEV_MODEL, hoist: boolean = HOIST_SHARED_OPTIONS): WireBody {
  const all: Record<string, ChoiceQuestion | NoulQuestion> = { ...req.questions, ...req.nouls };
  const state = req.state;
  if (!hoist || typeof state !== "object" || state === null || Array.isArray(state)) return { state, model, questions: all };
  if (OPTION_DESCRIPTIONS in state) throw new Error(`a Jev request's state already has a ${OPTION_DESCRIPTIONS} key, which the body uses for shared options`);
  // Each id's one description across the choice questions, or null when some question gives it none or another one.
  const described = new Map<string, ModelText | null>();
  const uses = new Map<string, number>();
  for (const q of Object.values(req.questions)) {
    for (const [id, d] of Object.entries(q.criteria)) {
      const seen = described.get(id);
      described.set(id, seen === undefined || seen === d ? d : null);
      uses.set(id, (uses.get(id) ?? 0) + 1);
    }
  }
  const shared: Record<string, ModelText> = {};
  for (const [id, d] of described) if (d !== null && (uses.get(id) ?? 0) >= 2) shared[id] = d;
  if (Object.keys(shared).length === 0) return { state, model, questions: all };
  const questions: Record<string, ChoiceQuestion | NoulQuestion> = {};
  for (const [k, q] of Object.entries(all)) {
    questions[k] = q.type === "choice" ? { ...q, criteria: Object.fromEntries(Object.entries(q.criteria).map(([id, d]) => [id, id in shared ? null : d])) } : q;
  }
  return { state: { ...state, [OPTION_DESCRIPTIONS]: shared }, model, questions };
}

/**
 * PV2 Q2: what an evaluation's request log or dump keeps of a request: `kept`, its own record of it, once the request's
 * wire body verifies as the client's would, with every value in a format Caret never carries withheld (privacy/
 * disclosure.ts storable). A replayed request that never reaches the client is checked here the same way.
 */
export { frozenRequest };

export interface SealedRequest {
  readonly sealed: Sealed;
  /** The request as the sealed copy says it (frozenRequest): what is sent, and what a store records. */
  readonly asked: JevRequest;
}

/**
 * PV2: seals a request before it is sent (privacy/send.ts seal): what an evaluation sends is `asked`, the frozen copy, and
 * what it stores of the request comes from that same copy (storedRecord), never from the live request.
 */
export function sealRequest(req: JevRequest): SealedRequest {
  const sealed = seal({ req, wire: wireBody(req) });
  return { sealed, asked: frozenRequest(req, sealed.wire) };
}

/**
 * What an evaluation's request log or dump keeps of a request it sent: `build`'s record of the frozen copy that was sent,
 * checked again as it is written, with every value in a format Caret never carries withheld. There is no path that seals
 * the live request again at storage time.
 */
export function storedRecord<T>(s: SealedRequest, build: (frozen: JevRequest) => T): T {
  return storable(s.asked, s.sealed.wire, build(s.asked));
}


/** Whether a minted value is a record of them (an array is not: Array.isArray does not narrow a readonly array). */
function isRecord(v: ModelValue | undefined): v is { readonly [k: string]: ModelValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The questions and state a body says, with shared options described in each question again: the inverse of wireBody. */
export function expandWireBody(body: WireBody): WireBody {
  const state = body.state;
  if (typeof state !== "object" || state === null || Array.isArray(state) || !(OPTION_DESCRIPTIONS in state)) return body;
  const { [OPTION_DESCRIPTIONS]: shared, ...rest } = state;
  // The shared descriptions are the body's own (wireBody put them there), each a question's minted criterion.
  const d: Readonly<Record<string, ModelValue>> = isRecord(shared) ? shared : {};
  const described = (id: string): ModelText | null => {
    const x = d[id];
    return typeof x === "string" ? x : null;
  };
  const questions: Record<string, ChoiceQuestion | NoulQuestion> = {};
  for (const [k, q] of Object.entries(body.questions)) {
    questions[k] = q.type === "choice" ? { ...q, criteria: Object.fromEntries(Object.entries(q.criteria).map(([id, x]) => [id, x === null ? described(id) : x])) } : q;
  }
  return { state: rest, model: body.model, questions };
}

/**
 * The Jev client. Every request first takes a hold on the day's budget (engines/decide/daily-cap.ts): past
 * CARET_JEV_DAILY_CAP it is refused with JevCapError before anything is sent.
 */
export function makeJevClient(key: (provider: JevProvider) => string, timeoutMs = 10_000, spend: DailySpend = DailySpend.fromEnv(), settings: JevSettings = jevSettings(), fetchFn: typeof fetch = (input, init) => fetch(input, init), onUsage?: (usage: JevUsage) => void, evaluation?: { fixture: FixtureSources; env: NodeJS.ProcessEnv }): AskJev {
  const route = { ...settings };
  return async (req) => {
    if (jevPolicy(route).retains) {
      // SC1 T4: a provider that keeps or trains on what it is sent (Laya: privacy/providers.ts) never gets real-screen
      // text, even with explicit model configuration or no replay cache: only an evaluation's declared fixture text.
      if (evaluation === undefined) throw new JevGatewayPolicyError(`${route.model} keeps what it is sent, so it runs only with declared fixture sources in evaluation harnesses`, route.model);
      refuseShipped(process.env);
      refuseShipped(evaluation.env);
      checkFixture(req, evaluation.fixture);
    }
    const ids = Object.keys(req.nouls ?? {});
    if (ids.some((id) => id in req.questions)) throw new Error("Jev request repeats a question id between its choices and its yes/no questions");
    // SC1 section 3: no request leaves with a value in a format Caret never carries, whichever builder made it
    // (privacy.ts assertNoExcludedValue, G2's assertNoSecrets narrowed to formats).
    assertNoExcludedValue(req);
    const wire = wireBody(req, route.model);
    // SC1 2b: every string on the wire was minted for this request, checked after wireBody so a string the client makes
    // up shows too; checked again as it leaves, on every attempt (privacy/send.ts sealedBody).
    verifySent(req, wire);
    if (route.provider === "gateway") {
      wire.providerOptions = { gateway: { only: [checkGatewayModel(route.model)] } };
    }
    // Sealed once: every attempt posts this frozen copy, checked again as it leaves (privacy/send.ts).
    const sealed = seal({ req, wire });
    const hold = spend.reserve(DailySpend.estimateUsd(JSON.stringify(sealed.wire).length, JEV_USD_PER_INPUT_TOKEN));
    let settled = false;
    const settle = (costUsd: number, inputTokens: number): void => {
      settled = true;
      hold.settle(costUsd, inputTokens);
      onUsage?.({ costUsd, inputTokens });
    };
    try {
      const result = await post(key, timeoutMs, req, sealed, ids, route, fetchFn, settle);
      if (!settled) settle(result.costUsd, result.inputTokens);
      return result;
    } catch (e) {
      if (!settled) hold.release();
      throw e;
    }
  };
}

export interface JevUsage { inputTokens: number; costUsd: number }

export const LAYA_FREE_MODEL = "convaiinnovations/laya-free";
const GATEWAY_PROVIDERS: Readonly<Record<string, string>> = {
  [JEV_GATEWAY_MODEL]: "typesafe-ai",
  // The gateway endpoint lists boundless as Laya's sole provider, not its model publisher (Oct 6, 2026).
  [LAYA_FREE_MODEL]: "boundless",
};
const blockedGatewayModels = new Set<string>();

/** A refused gateway answer can already have cost money; callers must not use its choices (GW1 lead decision). */
export class JevGatewayPolicyError extends Error {
  readonly kind = "service" as const;
  readonly model: string;
  readonly usage: JevUsage;
  constructor(message: string, model: string, usage = { inputTokens: 0, costUsd: 0 }) {
    super(message);
    this.name = "JevGatewayPolicyError";
    this.model = model;
    this.usage = usage;
  }
}

function checkGatewayModel(model: string): string {
  if (blockedGatewayModels.has(model)) throw new JevGatewayPolicyError("this gateway model is blocked for the rest of this process", model);
  const provider = Object.hasOwn(GATEWAY_PROVIDERS, model) ? GATEWAY_PROVIDERS[model] : undefined;
  if (provider === undefined) throw new JevGatewayPolicyError("this model is not allowed on Caret's Jev gateway key", model);
  return provider;
}

// Laya's free tier returned 429 on the fifth rapid request (GW1 lead evidence, Oct 6). All clients share the pace.
let layaQueue: Promise<void> = Promise.resolve();
let layaNext = 0;
async function paceLaya(): Promise<void> {
  const turn = layaQueue.then(async () => {
    // An in-flight 429 can extend the deadline while this turn sleeps. Check it again after each wake.
    while (layaNext > Date.now()) await new Promise((resolve) => setTimeout(resolve, layaNext - Date.now()));
    layaNext = Date.now() + 3000;
  });
  layaQueue = turn.catch(() => {});
  await turn;
}

const GatewayEnvelope = z.object({ model: z.unknown().optional(), usage: z.unknown().optional(), provider_metadata: z.unknown().optional() }).loose();
const GatewayTokens = z.object({ input_tokens: z.number().finite().nonnegative() });
function gatewayUsage(json: unknown): { inputTokens: number; hasInputTokens: boolean; costUsd: number | undefined; costInvalid: boolean; model: string | undefined } {
  const raw = GatewayEnvelope.parse(json);
  const metadata = raw.provider_metadata === undefined ? undefined : GatewayMetadata.safeParse(raw.provider_metadata);
  const tokens = GatewayTokens.safeParse(raw.usage);
  return {
    inputTokens: tokens.success ? tokens.data.input_tokens : 0,
    hasInputTokens: tokens.success,
    costUsd: metadata?.success ? metadata.data.gateway?.cost : undefined,
    costInvalid: metadata !== undefined && !metadata.success,
    model: typeof raw.model === "string" ? raw.model : undefined,
  };
}

async function post(key: (provider: JevProvider) => string, timeoutMs: number, req: JevRequest, sealed: Sealed, ids: string[], settings: JevSettings, fetchFn: typeof fetch, settle: (costUsd: number, inputTokens: number) => void): Promise<JevResult> {
  for (let attempt = 0; ; attempt++) {
    if (settings.provider === "gateway") {
      if (settings.model === LAYA_FREE_MODEL) await paceLaya();
      checkGatewayModel(settings.model);
    }
    let credential = "";
    const t0 = performance.now();
    let res: Response;
    try {
      // Bind credential selection to the captured route, even if the environment changes between calls.
      credential = key(settings.provider);
      res = await fetchFn(settings.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: sealedBody(sealed),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // A request the boundary refused (privacy/send.ts sealedBody) is that refusal, not a network failure.
      if (e instanceof UnmintedText) throw e;
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      const rawDetail = e instanceof Error ? e.message : String(e);
      const detail = credential === "" ? rawDetail : rawDetail.split(credential).join("[redacted]");
      throw new JevNetworkError(timedOut ? `Jev did not answer within ${timeoutMs} ms` : `Jev could not be reached: ${detail}`, e);
    }
    const latencyMs = performance.now() - t0;
    let json: unknown;
    let errorText = "";
    let reportedGatewayCost = false;
    if (settings.provider === "gateway") {
      // Account before checking answers or policy: a charged refusal or malformed answer still used the daily budget.
      // H13's success-only host ledger is separate; this is the helper ledger J1's daily cap reads.
      const text = await res.text().catch((e: unknown) => {
        if (!res.ok) return "(the body could not be read)";
        throw new JevNetworkError("Jev's answer did not arrive whole", e);
      });
      errorText = text.split(credential).join("[redacted]");
      try { json = JSON.parse(text); } catch {
        if (res.ok) throw new JevHttpError(res.status, "the answer was not JSON", settings.provider);
      }
      if (typeof json === "object" && json !== null && !Array.isArray(json)) {
        const usage = gatewayUsage(json);
        const model = usage.model ?? settings.model;
        const wrongModel = !Object.hasOwn(GATEWAY_PROVIDERS, model);
        const laya = model === LAYA_FREE_MODEL || settings.model === LAYA_FREE_MODEL;
        const costUsd = usage.costUsd ?? (!laya && usage.hasInputTokens && !usage.costInvalid ? usage.inputTokens * JEV_USD_PER_INPUT_TOKEN : undefined);
        if (costUsd !== undefined) {
          reportedGatewayCost = true;
          settle(costUsd, usage.inputTokens);
        }
        if (wrongModel || laya && (usage.costInvalid || usage.costUsd !== 0 && (res.ok || usage.costUsd !== undefined))) {
          blockedGatewayModels.add(model);
          blockedGatewayModels.add(settings.model);
          const safeModel = model.split(credential).join("[redacted]");
          throw new JevGatewayPolicyError(wrongModel ? "the gateway answered with a model that is not allowed" : "Laya requires an explicit zero gateway cost; this model is blocked", safeModel, { inputTokens: usage.inputTokens, costUsd: costUsd ?? 0 });
        }
        if (usage.costInvalid) throw new JevHttpError(res.status, "the gateway returned invalid cost metadata", settings.provider);
      }
    }
    if (res.status === 429) {
      const raw = res.headers.get("retry-after");
      const seconds = Number(raw ?? "1");
      const waitMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(raw ?? "") - Date.now()) || 1000;
      if (settings.provider === "gateway" && settings.model === LAYA_FREE_MODEL) layaNext = Math.max(layaNext, Date.now() + waitMs);
      // A no-retry caller still leaves Laya's backoff for the next call. A reported cost is already settled.
      if (attempt === 0 && req.retry429 !== false && !reportedGatewayCost) {
        await new Promise((r) => setTimeout(r, settings.provider === "gateway" ? Math.max(3000, waitMs) : Math.min(5000, waitMs)));
        continue;
      }
    }
    if (!res.ok) {
      const text = settings.provider === "gateway" ? errorText : (await res.text().catch(() => "(the body could not be read)")).split(credential).join("[redacted]");
      throw new JevHttpError(res.status, text, settings.provider);
    }
    if (settings.provider !== "gateway") {
      try { json = await res.json(); } catch (e) {
        if (e instanceof SyntaxError) throw new JevHttpError(res.status, "the answer was not JSON");
        throw new JevNetworkError(`Jev's answer did not arrive whole: ${e instanceof Error ? e.message : String(e)}`, e);
      }
    }
    const parsed = JevResponse.parse(json);
    const answers: JevResult["answers"] = {};
    const nouls: Record<string, number> = {};
    const probabilities: Record<string, Record<string, number>> = {};
    for (const [k, a] of Object.entries(parsed.answers)) {
      const asked = req.nouls?.[k] !== undefined;
      const yes = NoulAnswer.safeParse(a);
      if (yes.success) {
        if (!asked) throw new Error(`Jev answered ${k} with a yes/no, which was asked as a choice`);
        nouls[k] = yes.data.noul;
        continue;
      }
      const c = ChoiceAnswer.parse(a);
      if (asked) throw new Error(`Jev answered ${k} with a choice, which was asked as a yes/no`);
      answers[k] = { choice: c.choice, confidence: c.confidence };
      if (c.probabilities !== undefined) probabilities[k] = c.probabilities;
    }
    return {
      model: parsed.model,
      answers,
      ...(ids.length === 0 ? {} : { nouls }),
      ...(Object.keys(probabilities).length === 0 ? {} : { probabilities }),
      inputTokens: parsed.usage.input_tokens,
      latencyMs,
      costUsd: jevCostUsd(parsed.usage.input_tokens, settings.provider, parsed.provider_metadata),
    };
  }
}
