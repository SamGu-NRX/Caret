// Minimal client for TypeSafe's System One endpoint (https://docs.typesafe.ai/api.md).
// The key is read at call time from TYPESAFE_API_KEY or from the .env file named by
// CARET_ENV_FILE. It is never logged; errors name the variable, not the value.
import { readFileSync } from "node:fs";
import * as z from "zod";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
/** Sourced: $0.042 per million input tokens, output free (https://docs.typesafe.ai/models.md). */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export interface ChoiceQuestion {
  type: "choice";
  instructions: string | Record<string, unknown>;
  criteria: Record<string, string | null>;
}

export interface JevRequest {
  state: string | Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
}

const ChoiceAnswer = z.object({ choice: z.string(), confidence: z.number() }).loose();
const JevResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), ChoiceAnswer),
  usage: z.object({ input_tokens: z.number() }).loose(),
});

export interface JevResult {
  model: string;
  answers: Record<string, { choice: string; confidence: number }>;
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
    const body = JSON.stringify({ state: req.state, model: JEV_MODEL, questions: req.questions });
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
        const detail = (await res.text()).slice(0, 300);
        throw new Error(`Jev HTTP ${res.status}: ${detail}`);
      }
      const parsed = JevResponse.parse(await res.json());
      return {
        model: parsed.model,
        answers: Object.fromEntries(Object.entries(parsed.answers).map(([k, a]) => [k, { choice: a.choice, confidence: a.confidence }])),
        inputTokens: parsed.usage.input_tokens,
        latencyMs,
        costUsd: parsed.usage.input_tokens * JEV_USD_PER_INPUT_TOKEN,
      };
    }
  };
}
