// WriterPort (action-engine-v2 section 5): one bounded write by the configured model. This batch serves
// `plan`; `polish` and `memoryProposal` are refused until their schemas exist. The output is untrusted
// text: a plan program still has to pass compileProgram and the sandbox.
import { chat, chatSink, type ChatRoute } from "./chat.ts";
import { assertNoExcludedValue, type Snippet } from "../privacy.ts";
import { verifyWriterInput, type Disclosure, type ModelValue } from "../privacy/disclosure.ts";
import { seal, sendable } from "../privacy/send.ts";
import { writerPolicy, type ProviderPolicy } from "../privacy/providers.ts";
import { readKey } from "./env.ts";
import { extractProgram, PLAN_SYSTEM, PLAN_WORDING, PlanInputSchema, planUserMessage } from "./plan-prompt.ts";
import { GOAL_SYSTEM } from "./goal-prompt.ts";
import { DailySpend, JevCapError } from "../engines/decide/daily-cap.ts";
import { ENV, processEnv } from "../host-env.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { WRITER_DAILY_CAP_USD } from "./config.ts";

export const WRITER_SPEND_DIR = join(homedir(), "Library", "Application Support", "CaretV2", "writer-spend");
const dailySpend = new DailySpend({ dir: processEnv()[ENV.caret_writer_spend_dir] || WRITER_SPEND_DIR, capUsd: WRITER_DAILY_CAP_USD });

/** The configured writer cannot send today. No alternate route is tried. */
export class WriterUnavailable extends Error {
  readonly reason: "budget";
  constructor(reason: "budget") {
    super(`writer unavailable: ${reason}`);
    this.name = "WriterUnavailable";
    this.reason = reason;
  }
}

/** UTF-8 bytes overestimate input tokens; reserve the full output cap, including reasoning. Assumed, not measured. */
export function writerEstimateUsd(route: ChatRoute, body: string, maxOutputTokens: number): number {
  return (Buffer.byteLength(body, "utf8") * route.pricing.inputUsdPerMTok + maxOutputTokens * route.pricing.outputUsdPerMTok) / 1_000_000;
}

export interface WriterRequest {
  /** "goal" programs may span the listed windows and calendar; same input as "plan". */
  kind: "plan" | "goal" | "polish" | "memoryProposal";
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
  /** The untrusted program and raw reply. Test doubles may also attach parsed JSON. */
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
export function makeWriterPort(route: ChatRoute, opts: { key?: () => string; fetchFn?: typeof fetch; evaluation?: boolean; policy?: (route: ChatRoute) => ProviderPolicy; spend?: DailySpend } = {}): WriterPort {
  const key = opts.key ?? (() => readKey(route.keyName));
  const spend = opts.spend ?? dailySpend;
  const retains = (opts.policy ?? writerPolicy)(route).retains;
  return {
    route,
    async write(req) {
      // A kind with no schema yet is refused before its input is read (privacy/shapes.ts gives it no slot).
      if (req.kind !== "plan" && req.kind !== "goal") throw new Error(`writer kind ${req.kind} is not implemented yet`);
      assertNoExcludedValue(req);
      if (retains && opts.evaluation !== true) throw new WriterProviderRefused(`${route.provider}:${route.model} keeps what it is sent, so it writes only for evaluation harnesses over fixture text`);
      if (req.disclosureId.length === 0) throw new Error("writer request has no disclosureId");
      // SC1 2b: every string in the input was minted for this request, before schema parsing, key access or transport.
      // Then sealed once for the chat sink (privacy/send.ts): rendered from the frozen input, validated, measured, and
      // sent as those bytes only.
      verifyWriterInput(req);
      PlanInputSchema.parse(req.input);
      const system = req.kind === "goal" ? GOAL_SYSTEM : PLAN_SYSTEM;
      const messages = (wire: unknown) => [
        { role: "system" as const, content: system },
        { role: "user" as const, content: planUserMessage(PlanInputSchema.parse(wire)) },
      ];
      const sealed = seal({ writer: req }, chatSink(route, messages, [system, ...PLAN_WORDING], req.maxOutputTokens));
      const signal = AbortSignal.any([req.signal, AbortSignal.timeout(WRITER_TIMEOUT_MS)]);
      let hold;
      try {
        // DailySpend permits a zero-price request at equality, so check the landed total explicitly too.
        if (spend.spent() >= spend.capUsd) throw new WriterUnavailable("budget");
        hold = spend.reserve(writerEstimateUsd(route, sendable(sealed), req.maxOutputTokens));
      } catch (e) {
        if (e instanceof JevCapError) throw new WriterUnavailable("budget");
        throw e;
      }
      let r;
      try {
        r = await chat(route, key(), sealed, signal, opts.fetchFn);
      } catch (e) {
        hold.release();
        throw e;
      }
      hold.settle(r.costUsd, r.inputTokens);
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
