// Minimal client for TypeSafe's System One endpoint (https://docs.typesafe.ai/api.md).
// The key is read at call time from TYPESAFE_API_KEY or from the .env file named by
// CARET_ENV_FILE. It is never logged; errors name the variable, not the value.
import { readFileSync } from "node:fs";
import * as z from "zod";
import type { Snippet } from "../privacy.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
/** Sourced: $0.042 per million input tokens, output free (https://docs.typesafe.ai/models.md). */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export interface ChoiceQuestion {
  type: "choice";
  instructions: string | Record<string, unknown>;
  criteria: Record<string, string | null>;
}

/** A yes/no question; Jev answers with the probability of yes (docs.typesafe.ai/api, "Noul"), and no confidence. */
export interface NoulQuestion {
  type: "noul";
  instructions: string | Record<string, unknown>;
  criteria?: { true: string; false: string };
}

export interface JevRequest {
  state: string | Record<string, unknown>;
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
}

const ChoiceAnswer = z.object({ choice: z.string(), confidence: z.number() }).loose();
const NoulAnswer = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).loose();
const JevResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.union([NoulAnswer, ChoiceAnswer])),
  usage: z.object({ input_tokens: z.number() }).loose(),
});

export interface JevResult {
  model: string;
  answers: Record<string, { choice: string; confidence: number }>;
  /** The probability of yes for each of the request's `nouls`, by id; absent when it asked none. */
  nouls?: Record<string, number>;
  inputTokens: number;
  latencyMs: number;
  costUsd: number;
}

export type AskJev = (req: JevRequest) => Promise<JevResult>;

export function loadJevKey(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env.TYPESAFE_API_KEY;
  if (direct !== undefined && direct.length > 0) return direct;
  const file = env.CARET_ENV_FILE;
  if (file === undefined || file.length === 0) {
    throw new Error("Jev key missing: set TYPESAFE_API_KEY, or CARET_ENV_FILE to a .env file that defines it");
  }
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1] !== undefined) {
      const v = m[1].replace(/^(['"])(.*)\1$/, "$2").trim();
      if (v.length > 0) return v;
    }
  }
  throw new Error(`Jev key missing: ${file} has no TYPESAFE_API_KEY line`);
}

export function makeJevClient(key: () => string, timeoutMs = 10_000): AskJev {
  return async (req) => {
    const ids = Object.keys(req.nouls ?? {});
    if (ids.some((id) => id in req.questions)) throw new Error(`Jev request repeats a question id between its choices and its yes/no questions`);
    const body = JSON.stringify({ state: req.state, model: JEV_MODEL, questions: { ...req.questions, ...req.nouls } });
    for (let attempt = 0; ; attempt++) {
      const t0 = performance.now();
      const res = await fetch(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = performance.now() - t0;
      if (res.status === 429 && attempt === 0) {
        const wait = Number(res.headers.get("retry-after") ?? "1");
        await new Promise((r) => setTimeout(r, Math.min(5, Number.isFinite(wait) ? wait : 1) * 1000));
        continue;
      }
      if (!res.ok) {
        // The body is the service's own text; the key is cut out in case it is ever echoed back.
        const detail = (await res.text()).slice(0, 300).split(key()).join("[redacted]");
        throw new Error(`Jev HTTP ${res.status}: ${detail}`);
      }
      const parsed = JevResponse.parse(await res.json());
      const answers: JevResult["answers"] = {};
      const nouls: Record<string, number> = {};
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
      }
      return {
        model: parsed.model,
        answers,
        ...(ids.length === 0 ? {} : { nouls }),
        inputTokens: parsed.usage.input_tokens,
        latencyMs,
        costUsd: parsed.usage.input_tokens * JEV_USD_PER_INPUT_TOKEN,
      };
    }
  };
}
