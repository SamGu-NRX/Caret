// WriterPort (action-engine-v2 section 5): one bounded write by the configured model. This batch serves
// `plan`; `polish` and `memoryProposal` are refused until their schemas exist. The output is untrusted
// text: a plan program still has to pass compileProgram and the sandbox.
import { chat, type ChatRoute } from "./chat.ts";
import { assertNoExcludedValue, type Snippet } from "../privacy.ts";
import { verifyWriterInput, type Disclosure, type ModelValue } from "../privacy/disclosure.ts";
import { writerPolicy, type ProviderPolicy } from "../privacy/providers.ts";
import { readKey } from "./env.ts";
import { extractProgram, PLAN_SYSTEM, PlanInputSchema, planUserMessage } from "./plan-prompt.ts";
import { GOAL_SYSTEM } from "./goal-prompt.ts";
import { INTENT_SYSTEM, IntentInputSchema, intentResponseFormat, intentUserMessage } from "./intent-prompt.ts";

export interface WriterRequest {
  /**
   * "intent" (B25): an Ask's intent as strict JSON over the snapshot's refs (intent-prompt.ts). "goal" (D2-06): a plan
   * program whose steps may span the listed windows and the calendar (goal-prompt.ts); same input as "plan".
   */
  kind: "plan" | "goal" | "intent" | "polish" | "memoryProposal";
  /** Names the disclosure the caller accounted for this request; required so no write goes out unaccounted. */
  disclosureId: string;
  /**
   * The ledger's declarations the request's input carries (planner/codeplan.ts disclosureFor), for the helper's
   * record of what was sent (B24). Never sent.
   */
  disclosed?: readonly Snippet[];
  /** SC1 2b: minted text only (privacy/disclosure.ts ModelValue); the port verifies it against `disclosure`. */
  input: ModelValue;
  /** SC1 2b: the Disclosure that minted every text in `input` (privacy/disclosure.ts). Never sent; write() verifies against it. */
  disclosure: Disclosure;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface WriterResult {
  /** The model id the provider says served the request. */
  model: string;
  provider: string;
  /** `program` for a plan; `json` for an intent, parsed but not yet checked against its schema. */
  output: { program: string | null; reply: string; json?: unknown };
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  costUsd: number;
}

export interface WriterPort {
  readonly route: ChatRoute;
  write(request: WriterRequest): Promise<WriterResult>;
}

/** Plan section 5: a 10-second writer timeout, no automatic retry. */
export const WRITER_TIMEOUT_MS = 10_000;

/** SC1 T4: the writer's route keeps what it is sent, and this is no evaluation over fixture text. */
export class WriterProviderRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriterProviderRefused";
  }
}

/**
 * `evaluation`: the caller is an evaluation harness whose requests carry fixture text only, the one case a route whose
 * provider keeps what it is sent may run (privacy/providers.ts). `policy` replaces writerPolicy, for tests.
 */
export function makeWriterPort(route: ChatRoute, opts: { key?: () => string; fetchFn?: typeof fetch; evaluation?: boolean; policy?: (route: ChatRoute) => ProviderPolicy } = {}): WriterPort {
  const key = opts.key ?? (() => readKey(route.keyName));
  const retains = (opts.policy ?? writerPolicy)(route).retains;
  return {
    route,
    async write(req) {
      // A kind with no schema yet is refused before its input is read (privacy/shapes.ts gives it no slot).
      if (req.kind !== "plan" && req.kind !== "goal" && req.kind !== "intent") throw new Error(`writer kind ${req.kind} is not implemented yet`);
      assertNoExcludedValue(req);
      // SC1 2b: every string in the input was minted for this request, before schema parsing, key access or transport.
      verifyWriterInput(req);
      if (retains && opts.evaluation !== true) throw new WriterProviderRefused(`${route.provider}:${route.model} keeps what it is sent, so it writes only for evaluation harnesses over fixture text`);
      if (req.disclosureId.length === 0) throw new Error("writer request has no disclosureId");
      if (req.kind === "intent") {
        const input = IntentInputSchema.parse(req.input);
        const messages = [
          { role: "system" as const, content: INTENT_SYSTEM },
          { role: "user" as const, content: intentUserMessage(input) },
        ];
        const signal = AbortSignal.any([req.signal, AbortSignal.timeout(WRITER_TIMEOUT_MS)]);
        const r = await chat(route, key(), messages, req.maxOutputTokens, signal, opts.fetchFn, intentResponseFormat(input));
        let json: unknown;
        try {
          json = JSON.parse(r.text);
        } catch {
          json = undefined;
        }
        return { model: r.servedModel, provider: route.provider, output: { program: null, reply: r.text, json }, inputTokens: r.inputTokens, outputTokens: r.outputTokens, reasoningTokens: r.reasoningTokens, latencyMs: r.latencyMs, costUsd: r.costUsd };
      }
      const input = PlanInputSchema.parse(req.input);
      const messages = [
        { role: "system" as const, content: req.kind === "goal" ? GOAL_SYSTEM : PLAN_SYSTEM },
        { role: "user" as const, content: planUserMessage(input) },
      ];
      const signal = AbortSignal.any([req.signal, AbortSignal.timeout(WRITER_TIMEOUT_MS)]);
      const r = await chat(route, key(), messages, req.maxOutputTokens, signal, opts.fetchFn);
      return {
        model: r.servedModel,
        provider: route.provider,
        output: { program: extractProgram(r.text), reply: r.text },
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        reasoningTokens: r.reasoningTokens,
        latencyMs: r.latencyMs,
        costUsd: r.costUsd,
      };
    },
  };
}
