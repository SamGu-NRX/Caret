// Eval-only OpenAI Decisions transport. The caller still owns every option, scope and write guard.
import { readFileSync } from "node:fs";
import * as z from "zod";
import { ENV, processEnv, type HostEnv } from "../../host-env.ts";
import { assertNoExcludedValue } from "../../privacy.ts";
import { seal, sendable, type Sink } from "../../privacy/send.ts";
import { frozenRequest, wireBody, type AskJev, type JevRequest, type JevResult, type WireBody } from "../../fill/jev.ts";
import { checkFixture, refuseShipped, type FixtureSources } from "./cache.ts";
import { DecisionsSpend, DecisionsBudgetError, DECISIONS_MAX_ESTIMATED_TOKENS, DECISIONS_USD_PER_TOKEN } from "./decisions-spend.ts";

/** Official Decisions reference endpoint; never selectable by a caller or env file. */
export const DECISIONS_URL = "https://api.openai.com/v1/decisions";
/** The lead selected Luna for this comparison; no fallback or automatic model substitution. */
export const DECISIONS_MODEL = "gpt-6-luna";
/** Chosen timeout matches the existing Jev client; it is not a measured Luna latency bound. */
const TIMEOUT_MS = 10_000;
/** Chosen allowance for service framing per question, above the UTF-8 byte upper estimate; not tuned. */
const FRAMING_TOKENS_PER_QUESTION = 1024;

export function refuseDecisionsApp(env: HostEnv): void {
  refuseShipped(env);
  if (env[ENV.caret_internal_build] !== undefined) throw new Error("Decisions is eval-only and refuses internal app builds");
  if (env[ENV.caret_release_host] !== undefined && env[ENV.caret_release_host] !== "") throw new Error("Decisions is eval-only and refuses release app builds");
}

export function configuredDecisionsKey(env: HostEnv = processEnv()): string | undefined {
  const direct = env[ENV.openai_api_key];
  if (direct !== undefined && direct !== "") return direct;
  const file = env[ENV.caret_env_file];
  if (file !== undefined && file !== "") {
    let text: string;
    try { text = readFileSync(file, "utf8"); }
    catch { throw new Error("Cannot read CARET_ENV_FILE for OPENAI_API_KEY"); }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
      const value = m?.[1]?.replace(/^(['"])(.*)\1$/, "$2").trim();
      if (value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}
export function loadDecisionsKey(env: HostEnv = processEnv()): string {
  const key = configuredDecisionsKey(env);
  if (key === undefined) throw new Error("Decisions key missing: set OPENAI_API_KEY or reference its file with CARET_ENV_FILE");
  return key;
}
export function assertDecisionsCredentialAbsent(bytes: string, key: string | undefined): void {
  if (key !== undefined && bytes.includes(key)) throw new DecisionsCredentialError();
}

interface Choice { type: "choice"; name: string; instructions: string; choices: { value: string; description?: string }[] }
interface Predicate { type: "predicate"; name: string; instructions: string }
export interface DecisionsBody { model: string; input: string; questions: (Choice | Predicate)[] }

/** The sink renders only the already verified Jev wire: string IDs and descriptions are preserved verbatim. */
export function decisionsBody(wire: WireBody): DecisionsBody {
  const questions: DecisionsBody["questions"] = Object.entries(wire.questions).map(([name, q]) => {
    if (q.type === "choice") {
      const choices = Object.entries(q.criteria).map(([value, description]) => ({ value, ...(description === null ? {} : { description: String(description) }) }));
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
  wording: ["True: False:"],
};
const Probability = z.number().finite().min(0).max(1);
const Answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), name: z.string().nullable(), choice: z.string(), confidence: Probability, probabilities: z.array(z.object({ value: z.string(), probability: Probability })) }),
  z.object({ type: z.literal("predicate"), name: z.string().nullable(), probability: Probability }),
  z.object({ type: z.literal("refusal"), name: z.string().nullable() }),
]);
const Usage = z.object({ usage: z.object({ input_tokens: z.number().int().nonnegative() }) });
const ResponseBody = z.object({ model: z.literal(DECISIONS_MODEL), answers: z.array(Answer), usage: z.object({ input_tokens: z.number().int().nonnegative() }) });

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

export class DecisionsHttpError extends Error {
  readonly kind: "rate" | "auth" | "service";
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, retryAfterMs: number | null) {
    // Never include a service body, header or fetch error, any of which could reflect the bearer key.
    super(`Decisions HTTP ${status}; no answer was accepted`);
    this.name = "DecisionsHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.kind = status === 429 ? "rate" : status === 401 || status === 403 ? "auth" : "service";
  }
}

export interface DecisionsAttempt {
  latencyMs: number;
  costUsd: number | null;
  inputTokens: number | null;
  refused: boolean;
}
export class DecisionsAttemptError extends Error {
  readonly attempt: DecisionsAttempt;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly kind: "rate" | "auth" | "service" | "cap";
  constructor(reason: Error, attempt: DecisionsAttempt, secret: string) {
    super(reason.message.split(secret).join("[withheld]"));
    this.name = "DecisionsAttemptError";
    this.attempt = attempt;
    this.status = reason instanceof DecisionsHttpError ? reason.status : null;
    this.retryAfterMs = reason instanceof DecisionsHttpError ? reason.retryAfterMs : null;
    this.kind = reason instanceof DecisionsHttpError ? reason.kind : reason instanceof DecisionsBudgetError ? "cap" : "service";
  }
}

export interface DecisionsOptions {
  fixture: FixtureSources;
  env?: HostEnv;
  spend?: DecisionsSpend;
  probe?: boolean;
  fetchFn?: typeof fetch;
}
export function makeDecisionsClient(o: DecisionsOptions): AskJev {
  const env = o.env ?? processEnv();
  refuseDecisionsApp(processEnv());
  refuseDecisionsApp(env);
  const spend = o.spend ?? DecisionsSpend.fromEnv(env);
  const transport = o.fetchFn ?? ((input, init) => fetch(input, init));
  return async (req) => {
    refuseDecisionsApp(processEnv());
    refuseDecisionsApp(env);
    checkFixture(req, o.fixture);
    if (Object.keys(req.nouls ?? {}).some((id) => Object.hasOwn(req.questions, id))) throw new Error("Decisions request repeats a choice and predicate question ID");
    assertNoExcludedValue(req);
    const sealed = seal({ req, wire: wireBody(req, DECISIONS_MODEL) }, SINK);
    const asked = frozenRequest(req, sealed.wire, sealed.charged);
    const body = decisionsBody(sealed.wire as WireBody);
    const estimate = Buffer.byteLength(sealed.bytes, "utf8") + body.questions.length * FRAMING_TOKENS_PER_QUESTION;
    if (estimate > DECISIONS_MAX_ESTIMATED_TOKENS) throw new Error("Decisions estimated input exceeds the chosen 200K-token ceiling; no request was sent");
    const key = loadDecisionsKey(env);
    // The format assertions catch OpenAI keys; this also catches an exact configured key of any shape.
    assertDecisionsCredentialAbsent(sealed.bytes, key);
    sendable(sealed);
    const hold = spend.reserve(o.probe ?? false);
    const started = performance.now();
    let billedCost: number | null = null;
    let billedTokens: number | null = null;
    let refused = false;
    try {
      let response: Response;
      let text: string;
      try {
        response = await transport(DECISIONS_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: sendable(sealed), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
        text = await response.text();
      } catch { throw new Error("Decisions network request failed; answer withheld and worst-case reservation retained"); }
      let json: unknown;
      try { json = JSON.parse(text); }
      catch {
        if (!response.ok) throw new DecisionsHttpError(response.status, retryAfter(response.headers.get("retry-after")));
        throw new Error("Decisions returned malformed JSON; answer withheld and worst-case reservation retained");
      }
      const usage = Usage.safeParse(json);
      if (usage.success) { billedTokens = usage.data.usage.input_tokens; billedCost = billedTokens * DECISIONS_USD_PER_TOKEN; }
      const costUsd = usage.success ? hold.settle(usage.data.usage.input_tokens) : null;
      if (!response.ok) throw new DecisionsHttpError(response.status, retryAfter(response.headers.get("retry-after")));
      const parsed = ResponseBody.safeParse(json);
      if (!parsed.success || costUsd === null) throw new Error("Decisions response does not match the documented schema; no answer was accepted");
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
            if (!offered.has(p.value) || Object.hasOwn(ps, p.value)) throw new Error("Decisions probabilities contain an out-of-set or duplicate option");
            Object.defineProperty(ps, p.value, { value: p.probability, enumerable: true });
          }
          if (Object.keys(ps).length !== offered.size) throw new Error("Decisions probabilities omit an offered option");
          Object.defineProperty(answers, question.name, { value: { choice: answer.choice, confidence: answer.confidence }, enumerable: true });
          Object.defineProperty(probabilities, question.name, { value: ps, enumerable: true });
        } else if (question.type === "predicate" && answer.type === "predicate") {
          Object.defineProperty(nouls, question.name, { value: answer.probability, enumerable: true });
        } else throw new Error("Decisions answer type does not match its question");
      });
      return { model: raw.model, answers, ...(asked.nouls === undefined ? {} : { nouls }), probabilities, inputTokens: raw.usage.input_tokens, costUsd, latencyMs: performance.now() - started };
    } catch (e) {
      // All transport/body errors above use our own messages, never the provider's body or a fetch cause.
      const reason = e instanceof Error ? e : new Error("Decisions request failed; no answer was accepted");
      throw new DecisionsAttemptError(reason, { latencyMs: performance.now() - started, costUsd: billedCost, inputTokens: billedTokens, refused }, key);
    }
  };
}
function retryAfter(raw: string | null): number | null {
  if (raw === null) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
