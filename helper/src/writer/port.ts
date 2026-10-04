// WriterPort (action-engine-v2 section 5): one bounded write by the configured model. This batch serves
// `plan`; `polish` and `memoryProposal` are refused until their schemas exist. The output is untrusted
// text: a plan program still has to pass compileProgram and the sandbox.
import { chat, type ChatRoute } from "./chat.ts";
import type { Snippet } from "../privacy.ts";
import { readKey } from "./env.ts";
import { extractProgram, PLAN_SYSTEM, PlanInputSchema, planUserMessage } from "./plan-prompt.ts";

export interface WriterRequest {
  kind: "plan" | "polish" | "memoryProposal";
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
  output: { program: string | null; reply: string };
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
      if (req.kind !== "plan") throw new Error(`writer kind ${req.kind} is not implemented yet`);
      if (req.disclosureId.length === 0) throw new Error("writer request has no disclosureId");
      const input = PlanInputSchema.parse(req.input);
      const messages = [
        { role: "system" as const, content: PLAN_SYSTEM },
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
