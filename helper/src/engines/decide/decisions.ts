// Eval-only OpenAI Decisions transport. The caller still owns every option, scope and write guard.
//
// Errors (lead ruling, 2026-10-09): a billing stop (credit_balance_exhausted, insufficient_quota, a spend or usage limit)
// on the org key switches this client to the personal key once; a billing stop on the personal key ends the run, and
// every later request fails without sending. rate_limit_exceeded, slow_down and 503 server_is_overloaded are retried
// after Retry-After, else exponential backoff with jitter, at most MAX_ATTEMPTS attempts and REQUEST_BUDGET_MS per
// request. Every attempt reserves its own hold, so retries and the fallback count against the run's cap.
import { readFileSync } from "node:fs";
import * as z from "zod";
import { ENV, processEnv, type HostEnv } from "../../host-env.ts";
import { assertNoExcludedValue } from "../../privacy.ts";
import { seal, sendable, type Sink } from "../../privacy/send.ts";
import { frozenRequest, wireBody, type AskJev, type JevRequest, type JevResult, type WireBody } from "../../fill/jev.ts";
import { checkFixture, refuseShipped, type FixtureSources } from "./cache.ts";
import { DecisionsSpend, DecisionsBudgetError, DECISIONS_MAX_ESTIMATED_TOKENS, DECISIONS_USD_PER_TOKEN, type DecisionsHold, type DecisionsKeySource } from "./decisions-spend.ts";

export type { DecisionsKeySource } from "./decisions-spend.ts";

/** Official Decisions reference endpoint; never selectable by a caller or env file. */
export const DECISIONS_URL = "https://api.openai.com/v1/decisions";
/** The lead selected Luna for this comparison; no fallback or automatic model substitution. */
export const DECISIONS_MODEL = "gpt-6-luna";
/**
 * How a Jev request becomes a Decisions body, for the result cache's key: a changed mapping must never replay answers
 * given to another body. 2: Jev's `none` option is sent as `leave_blank` (lead ruling 3, 2026-10-09).
 */
export const DECISIONS_POLICY_VERSION = "decisions-body:2";
/** The fallback a Jev question's `none` option becomes; Decisions sees no other added option. */
export const LEAVE_BLANK = "leave_blank";
/** Chosen timeout matches the existing Jev client; it is not a measured Luna latency bound. */
const TIMEOUT_MS = 10_000;
/** Chosen allowance for service framing per question, above the UTF-8 byte upper estimate; not tuned. */
const FRAMING_TOKENS_PER_QUESTION = 1024;
/** Lead ruling 1: at most 4 attempts and 60 s per request, the key fallback included. */
export const MAX_ATTEMPTS = 4;
export const REQUEST_BUDGET_MS = 60_000;
/** Chosen first backoff step (doubling, equal jitter); not tuned. */
const BACKOFF_BASE_MS = 1_000;
/** An attempt with less time than this left is not started; chosen, not measured. */
const MIN_ATTEMPT_MS = 1_000;

/** Error codes and types that need billing action (Errors guide); retrying never restores access. */
const STOP_CODES: ReadonlySet<string> = new Set(["credit_balance_exhausted", "insufficient_quota", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded", "project_usage_limit_exceeded"]);
/** Error codes and types that pace traffic (Rate limits guide); retried within the per-request bounds. */
const RETRY_CODES: ReadonlySet<string> = new Set(["rate_limit_exceeded", "slow_down", "server_is_overloaded"]);

export function refuseDecisionsApp(env: HostEnv): void {
  refuseShipped(env);
  if (env[ENV.caret_internal_build] !== undefined) throw new Error("Decisions is eval-only and refuses internal app builds");
  if (env[ENV.caret_release_host] !== undefined && env[ENV.caret_release_host] !== "") throw new Error("Decisions is eval-only and refuses release app builds");
}

const KEY_NAMES = { org: ENV.openai_api_key, personal: ENV.openai_api_key_personal } as const;

function configured(env: HostEnv, source: DecisionsKeySource): string | undefined {
  const name = KEY_NAMES[source];
  const direct = env[name];
  if (direct !== undefined && direct !== "") return direct;
  const file = env[ENV.caret_env_file];
  if (file !== undefined && file !== "") {
    let text: string;
    try { text = readFileSync(file, "utf8"); }
    catch { throw new Error(`Cannot read CARET_ENV_FILE for ${name}`); }
    const line = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`);
    for (const l of text.split(/\r?\n/)) {
      const value = line.exec(l)?.[1]?.replace(/^(['"])(.*)\1$/, "$2").trim();
      if (value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}
/** The org key (OPENAI_API_KEY), directly or from CARET_ENV_FILE. */
export function configuredDecisionsKey(env: HostEnv = processEnv()): string | undefined {
  return configured(env, "org");
}
export interface DecisionsKeys { readonly org?: string; readonly personal?: string }
export function configuredDecisionsKeys(env: HostEnv = processEnv()): DecisionsKeys {
  const org = configured(env, "org");
  const personal = configured(env, "personal");
  return { ...(org === undefined ? {} : { org }), ...(personal === undefined ? {} : { personal }) };
}
export function loadDecisionsKey(env: HostEnv = processEnv()): string {
  const key = configuredDecisionsKey(env);
  if (key === undefined) throw new Error("Decisions key missing: set OPENAI_API_KEY or reference its file with CARET_ENV_FILE");
  return key;
}
export function assertDecisionsCredentialAbsent(bytes: string, ...keys: (string | undefined)[]): void {
  for (const key of keys) if (key !== undefined && bytes.includes(key)) throw new DecisionsCredentialError();
}

interface Choice { type: "choice"; name: string; instructions: string; choices: { value: string; description?: string }[] }
interface Predicate { type: "predicate"; name: string; instructions: string }
export interface DecisionsBody { model: string; input: string; questions: (Choice | Predicate)[] }

/** Jev's option ids are short handles (c3, v12, asks, a window id); a value or label is never an id. */
const OPTION_ID = /^[A-Za-z0-9_.:~#+-]{1,32}$/u;

/**
 * The sink renders only the already verified Jev wire: the evidence is one shared `input`, each question keeps Jev's
 * instructions (true/false criteria appended to a predicate's) and option ids, and only Jev's `none` is renamed to
 * LEAVE_BLANK. Nothing Jev does not see is added.
 */
export function decisionsBody(wire: WireBody): DecisionsBody {
  const questions: DecisionsBody["questions"] = Object.entries(wire.questions).map(([name, q]) => {
    if (q.type === "choice") {
      const choices = Object.entries(q.criteria).map(([id, description]) => {
        if (!OPTION_ID.test(id) || id === LEAVE_BLANK) throw new Error(`Decisions option ids must be short handles; question ${name} has one that is not`);
        return { value: id === "none" ? LEAVE_BLANK : id, ...(description === null ? {} : { description: String(description) }) };
      });
      if (choices.length < 2 || choices.length > 255) throw new Error("Decisions choice questions require between 2 and 255 offered options");
      return { type: "choice", name, instructions: String(q.instructions), choices };
    }
    // A Jev noul's true/false criteria qualify its predicate; neither wording is discarded.
    const criteria = q.criteria === undefined ? "" : `\nTrue: ${q.criteria.true}\nFalse: ${q.criteria.false}`;
    return { type: "predicate", name, instructions: `${q.instructions}${criteria}` };
  });
  if (questions.length === 0) throw new Error("Decisions needs at least one question");
  return { model: DECISIONS_MODEL, input: typeof wire.state === "string" ? wire.state : JSON.stringify(wire.state), questions };
}
/** A Decisions option value as the Jev request named it. */
const jevOption = (value: string): string => (value === LEAVE_BLANK ? "none" : value);

const SINK: Sink = {
  name: "OpenAI Decisions",
  // SAFETY: seal verifies the wireBody request before passing its frozen copy to this sink.
  render: (wire) => decisionsBody(wire as WireBody),
  envelope: {
    model: { kind: "config", max: 100 },
    input: { kind: "rendered", max: 400_000 },
    "questions[*].type": { kind: "config", max: 20 },
    "questions[*].name": { kind: "rendered", max: 200 },
    "questions[*].instructions": { kind: "rendered", max: 100_000 },
    "questions[*].choices[*].value": { kind: "rendered", max: 200 },
    "questions[*].choices[*].description": { kind: "rendered", max: 100_000 },
  },
  wording: ["True: False:", LEAVE_BLANK],
};
const Probability = z.number().finite().min(0).max(1);
const Answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), name: z.string().nullable(), choice: z.string(), confidence: Probability, probabilities: z.array(z.object({ value: z.string(), probability: Probability })) }),
  z.object({ type: z.literal("predicate"), name: z.string().nullable(), probability: Probability }),
  z.object({ type: z.literal("refusal"), name: z.string().nullable() }),
]);
const Usage = z.object({ usage: z.object({ input_tokens: z.number().int().nonnegative() }) });
const ResponseBody = z.object({ model: z.literal(DECISIONS_MODEL), answers: z.array(Answer), usage: z.object({ input_tokens: z.number().int().nonnegative() }) });
const ErrorBody = z.object({ error: z.object({ type: z.unknown().optional(), code: z.unknown().optional() }) });
/** Only a provider enum is kept from an error body; free text could reflect the request or the key. */
const enumOf = (v: unknown): string | null => (typeof v === "string" && /^[a-z0-9_]{1,64}$/u.test(v) ? v : null);

const MappedResult = z.object({
  model: z.literal(DECISIONS_MODEL),
  answers: z.record(z.string(), z.object({ choice: z.string(), confidence: Probability })),
  nouls: z.record(z.string(), Probability).optional(),
  probabilities: z.record(z.string(), z.record(z.string(), Probability)),
});
/** The shared cache renames options globally. Decisions must also check each question's own offered set on replay. */
export function assertDecisionsResult(req: JevRequest, result: JevResult): void {
  const parsed = MappedResult.safeParse(result);
  if (!parsed.success) throw new Error("Decisions cached result does not match its answer schema");
  const r = parsed.data;
  if (Object.keys(r.answers).length !== Object.keys(req.questions).length || Object.keys(r.nouls ?? {}).length !== Object.keys(req.nouls ?? {}).length || Object.keys(r.probabilities).length !== Object.keys(req.questions).length) throw new Error("Decisions result question count does not match the request");
  for (const [id, q] of Object.entries(req.questions)) {
    const answer = r.answers[id]; const ps = r.probabilities[id];
    if (answer === undefined || !Object.hasOwn(q.criteria, answer.choice)) throw new Error("Decisions result contains an out-of-set choice");
    if (ps === undefined || Object.keys(ps).length !== Object.keys(q.criteria).length || Object.keys(ps).some((option) => !Object.hasOwn(q.criteria, option))) throw new Error("Decisions result probabilities do not match the offered set");
  }
  if (Object.keys(req.nouls ?? {}).some((id) => !Object.hasOwn(r.nouls ?? {}, id))) throw new Error("Decisions result omits a predicate");
}

export class DecisionsCredentialError extends Error {
  constructor() {
    super("Decisions request contains the configured credential; no request was sent");
    this.name = "DecisionsCredentialError";
  }
}

export type DecisionsHttpKind = "stop" | "rate" | "auth" | "service";
export class DecisionsHttpError extends Error {
  readonly kind: DecisionsHttpKind;
  readonly status: number;
  readonly retryAfterMs: number | null;
  /** The provider's error.type and error.code, kept only when each is a plain enum. */
  readonly type: string | null;
  readonly code: string | null;
  /** Whether the lead's retry rule covers this reply. */
  readonly retryable: boolean;
  constructor(status: number, retryAfterMs: number | null, type: string | null = null, code: string | null = null) {
    // Never include a service body, header or fetch error, any of which could reflect the bearer key.
    super(`Decisions HTTP ${status}${code === null && type === null ? "" : ` (${[type, code].filter((x) => x !== null).join("/")})`}; no answer was accepted`);
    this.name = "DecisionsHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.type = type;
    this.code = code;
    const named = [type, code].filter((x): x is string => x !== null);
    const stop = named.some((x) => STOP_CODES.has(x));
    this.retryable = !stop && (status === 429 || status === 503) && named.some((x) => RETRY_CODES.has(x));
    this.kind = stop ? "stop" : status === 429 || status === 503 ? "rate" : status === 401 || status === 403 ? "auth" : "service";
  }
}

/** One HTTP attempt within a request: which key, what came back, how long, and what it billed (null when unknown). */
export interface DecisionsAttemptRecord {
  key: DecisionsKeySource;
  status: number | null;
  code: string | null;
  latencyMs: number;
  costUsd: number | null;
  /** The wait before the next attempt, 0 for the last. */
  waitMs: number;
}
export interface DecisionsAttempt {
  latencyMs: number;
  costUsd: number | null;
  inputTokens: number | null;
  refused: boolean;
}
export class DecisionsAttemptError extends Error {
  readonly attempt: DecisionsAttempt;
  readonly attempts: readonly DecisionsAttemptRecord[];
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly code: string | null;
  /** "stop": a billing stop ended this run; "cap": a budget cap did. Either way no later request is sent. */
  readonly kind: "stop" | "rate" | "auth" | "service" | "cap";
  constructor(reason: Error, attempt: DecisionsAttempt, secrets: readonly (string | undefined)[], attempts: readonly DecisionsAttemptRecord[] = [], stopped = false) {
    let message = reason.message;
    for (const s of secrets) if (s !== undefined && s !== "") message = message.split(s).join("[withheld]");
    super(message);
    this.name = "DecisionsAttemptError";
    this.attempt = attempt;
    this.attempts = attempts;
    this.status = reason instanceof DecisionsHttpError ? reason.status : null;
    this.retryAfterMs = reason instanceof DecisionsHttpError ? reason.retryAfterMs : null;
    this.code = reason instanceof DecisionsHttpError ? (reason.code ?? reason.type) : null;
    this.kind = stopped ? "stop" : reason instanceof DecisionsHttpError ? reason.kind : reason instanceof DecisionsBudgetError ? "cap" : "service";
  }
}

/** What a live Decisions answer adds to JevResult: the key that served it and every attempt it took. */
export interface DecisionsResult extends JevResult {
  servedBy: DecisionsKeySource;
  attempts: DecisionsAttemptRecord[];
}

export interface DecisionsOptions {
  fixture: FixtureSources;
  env?: HostEnv;
  spend?: DecisionsSpend;
  probe?: boolean;
  fetchFn?: typeof fetch;
  /** Test seams for the retry wait and its jitter. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}
type Once =
  | { ok: true; result: JevResult; status: number; billedCost: number }
  | { ok: false; error: Error; status: number | null; billedCost: number | null; billedTokens: number | null; refused: boolean };

export function makeDecisionsClient(o: DecisionsOptions): AskJev {
  const env = o.env ?? processEnv();
  refuseDecisionsApp(processEnv());
  refuseDecisionsApp(env);
  const spend = o.spend ?? DecisionsSpend.fromEnv(env);
  const transport = o.fetchFn ?? ((input, init) => fetch(input, init));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  // Per client, so per run: the key in use, and why the run stopped.
  let active: DecisionsKeySource | null = null;
  let stopped: string | null = null;

  const once = async (body: DecisionsBody, sealed: ReturnType<typeof seal>, asked: JevRequest, key: string, hold: DecisionsHold, timeoutMs: number): Promise<Once> => {
    const started = performance.now();
    let billedCost: number | null = null;
    let billedTokens: number | null = null;
    let refused = false;
    let status: number | null = null;
    try {
      let response: Response;
      let text: string;
      try {
        response = await transport(DECISIONS_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: sendable(sealed), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
        status = response.status;
        text = await response.text();
      } catch { throw new Error("Decisions network request failed; answer withheld and worst-case reservation retained"); }
      let json: unknown;
      try { json = JSON.parse(text); }
      catch {
        if (!response.ok) throw new DecisionsHttpError(response.status, retryAfter(response.headers));
        throw new Error("Decisions returned malformed JSON; answer withheld and worst-case reservation retained");
      }
      const usage = Usage.safeParse(json);
      if (usage.success) { billedTokens = usage.data.usage.input_tokens; billedCost = hold.settle(billedTokens); }
      if (!response.ok) {
        const err = ErrorBody.safeParse(json);
        // A documented error reply without usage processed no input: its hold settles at $0.
        if (err.success && !usage.success) { hold.settleRejected(response.status); billedCost = 0; billedTokens = 0; }
        throw new DecisionsHttpError(response.status, retryAfter(response.headers), err.success ? enumOf(err.data.error.type) : null, err.success ? enumOf(err.data.error.code) : null);
      }
      const parsed = ResponseBody.safeParse(json);
      if (!parsed.success || billedCost === null) throw new Error("Decisions response does not match the documented schema; no answer was accepted");
      const raw = parsed.data;
      if (raw.answers.length !== body.questions.length) throw new Error("Decisions response has the wrong answer count");
      const answers: JevResult["answers"] = {};
      const nouls: Record<string, number> = {};
      const probabilities: Record<string, Record<string, number>> = {};
      raw.answers.forEach((answer, i) => {
        const question = body.questions[i];
        if (question === undefined || answer.name !== question.name) throw new Error("Decisions response question name or order does not match the request");
        if (answer.type === "refusal") { refused = true; throw new Error("Decisions refused a question; no answer was accepted"); }
        if (question.type === "choice" && answer.type === "choice") {
          const offered = new Set(question.choices.map((c) => c.value));
          if (!offered.has(answer.choice)) throw new Error("Decisions returned an out-of-set choice; no answer was accepted");
          const ps: Record<string, number> = {};
          for (const p of answer.probabilities) {
            if (!offered.has(p.value) || Object.hasOwn(ps, jevOption(p.value))) throw new Error("Decisions probabilities contain an out-of-set or duplicate option");
            Object.defineProperty(ps, jevOption(p.value), { value: p.probability, enumerable: true });
          }
          if (Object.keys(ps).length !== offered.size) throw new Error("Decisions probabilities omit an offered option");
          Object.defineProperty(answers, question.name, { value: { choice: jevOption(answer.choice), confidence: answer.confidence }, enumerable: true });
          Object.defineProperty(probabilities, question.name, { value: ps, enumerable: true });
        } else if (question.type === "predicate" && answer.type === "predicate") {
          Object.defineProperty(nouls, question.name, { value: answer.probability, enumerable: true });
        } else throw new Error("Decisions answer type does not match its question");
      });
      return { ok: true, status: response.status, billedCost, result: { model: raw.model, answers, ...(asked.nouls === undefined ? {} : { nouls }), probabilities, inputTokens: raw.usage.input_tokens, costUsd: billedCost, latencyMs: performance.now() - started } };
    } catch (e) {
      // All transport/body errors above use our own messages, never the provider's body or a fetch cause.
      return { ok: false, error: e instanceof Error ? e : new Error("Decisions request failed; no answer was accepted"), status, billedCost, billedTokens, refused };
    }
  };

  return async (req) => {
    refuseDecisionsApp(processEnv());
    refuseDecisionsApp(env);
    checkFixture(req, o.fixture);
    if (Object.keys(req.nouls ?? {}).some((id) => Object.hasOwn(req.questions, id))) throw new Error("Decisions request repeats a choice and predicate question ID");
    assertNoExcludedValue(req);
    const sealed = seal({ req, wire: wireBody(req, DECISIONS_MODEL) }, SINK);
    const asked = frozenRequest(req, sealed.wire, sealed.charged);
    const body = decisionsBody(sealed.wire as WireBody);
    // UTF-8 bytes bound the body's tokens from above; the framing allowance covers the service's per-question text.
    const estimate = Buffer.byteLength(sealed.bytes, "utf8") + body.questions.length * FRAMING_TOKENS_PER_QUESTION;
    if (estimate > DECISIONS_MAX_ESTIMATED_TOKENS) throw new Error("Decisions estimated input exceeds the chosen 200K-token ceiling; no request was sent");
    const keys = configuredDecisionsKeys(env);
    const secrets = [keys.org, keys.personal];
    const started = performance.now();
    const attempts: DecisionsAttemptRecord[] = [];
    const summary = (refused: boolean): DecisionsAttempt => {
      const known = attempts.filter((a) => a.costUsd !== null);
      // A billed prefix is not a complete total when a later attempt's reservation remains unsettled.
      const cost = known.length === 0 || known.length !== attempts.length ? null : known.reduce((s, a) => s + (a.costUsd as number), 0);
      return { latencyMs: performance.now() - started, costUsd: cost, inputTokens: cost === null ? null : Math.round(cost / DECISIONS_USD_PER_TOKEN), refused };
    };
    if (stopped !== null) throw new DecisionsAttemptError(new Error(`Decisions run stopped earlier (${stopped}); no request was sent`), summary(false), secrets, attempts, true);
    if (keys.org === undefined && keys.personal === undefined) throw new Error("Decisions key missing: set OPENAI_API_KEY or OPENAI_API_KEY_PERSONAL, or reference their file with CARET_ENV_FILE");
    active ??= keys.org !== undefined ? "org" : "personal";
    // The format assertions catch OpenAI keys; this also catches an exact configured key of any shape.
    assertDecisionsCredentialAbsent(sealed.bytes, ...secrets);
    sendable(sealed);
    const deadline = started + REQUEST_BUDGET_MS;
    for (let n = 1; ; n++) {
      const source: DecisionsKeySource = active;
      const key = keys[source] as string;
      let hold: DecisionsHold;
      try { hold = spend.reserve(o.probe ?? false, estimate, source); }
      catch (e) { throw new DecisionsAttemptError(e instanceof Error ? e : new Error("Decisions reservation failed"), summary(false), secrets, attempts); }
      const t0 = performance.now();
      const r = await once(body, sealed, asked, key, hold, Math.min(TIMEOUT_MS, deadline - t0));
      const record: DecisionsAttemptRecord = { key: source, status: r.status, code: !r.ok && r.error instanceof DecisionsHttpError ? (r.error.code ?? r.error.type) : null, latencyMs: performance.now() - t0, costUsd: r.billedCost, waitMs: 0 };
      attempts.push(record);
      // Earlier retry/fallback responses can carry billed usage even when they failed.
      if (r.ok) return { ...r.result, costUsd: summary(false).costUsd ?? r.result.costUsd, latencyMs: performance.now() - started, servedBy: source, attempts } satisfies DecisionsResult;
      const err = r.error;
      const left = (): number => deadline - performance.now();
      if (err instanceof DecisionsHttpError && err.kind === "stop") {
        // A stop seen on the org key moves the run to the personal key once; a request sent on org before another
        // request switched sees the same stop, and follows the switch.
        if (source === "org" && keys.personal !== undefined) {
          active = "personal";
          if (n < MAX_ATTEMPTS && left() > MIN_ATTEMPT_MS) continue;
          throw new DecisionsAttemptError(err, summary(false), secrets, attempts);
        }
        stopped = `${err.code ?? err.type ?? `HTTP ${err.status}`} on the ${source} key`;
        throw new DecisionsAttemptError(err, summary(false), secrets, attempts, true);
      }
      if (err instanceof DecisionsHttpError && err.retryable && n < MAX_ATTEMPTS) {
        const wait = err.retryAfterMs ?? backoff(n, random);
        if (wait + MIN_ATTEMPT_MS <= left()) {
          record.waitMs = wait;
          await sleep(wait);
          continue;
        }
      }
      throw new DecisionsAttemptError(err, summary(r.refused), secrets, attempts);
    }
  };
}
/** Exponential backoff with equal jitter: half the step fixed, half random. */
function backoff(attempt: number, random: () => number): number {
  const step = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return step / 2 + random() * (step / 2);
}
function retryAfter(headers: Headers): number | null {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\d+(?:\.\d+)?$/.test(ms)) return Number(ms);
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
