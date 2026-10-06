// WriterPort (action-engine-v2 section 5): one bounded write by the configured model. This batch serves
// `plan`; `polish` and `memoryProposal` are refused until their schemas exist. The output is untrusted
// text: a plan program still has to pass compileProgram and the sandbox.
import { chat, type ChatRoute } from "./chat.ts";
import type { Snippet } from "../privacy.ts";
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
  input: unknown;
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

export function makeWriterPort(route: ChatRoute, opts: { key?: () => string; fetchFn?: typeof fetch } = {}): WriterPort {
  const key = opts.key ?? (() => readKey(route.keyName));
  return {
    route,
    async write(req) {
      if (req.kind !== "plan" && req.kind !== "goal" && req.kind !== "intent") throw new Error(`writer kind ${req.kind} is not implemented yet`);
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
