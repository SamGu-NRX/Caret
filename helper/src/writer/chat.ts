// One OpenAI-compatible chat completion, the shape both Vercel AI Gateway and Groq serve. No retry: a
// failed write is reported, and the plan says a provider change is explicit configuration.
import * as z from "zod";

export interface Pricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Where the price came from and when. */
  source: string;
}

export interface ChatRoute {
  provider: "gateway" | "groq";
  baseUrl: string;
  /** Environment variable holding the key; read at call time. */
  keyName: string;
  model: string;
  /** Name of the output cap in this API's request body. */
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  /** Provider-specific request fields, such as a reasoning effort. */
  extraBody: Readonly<Record<string, unknown>>;
  pricing: Pricing;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatResult {
  text: string;
  servedModel: string;
  inputTokens: number;
  /** Billed output tokens, reasoning included. */
  outputTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  costUsd: number;
}

const Completion = z.object({
  model: z.string(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }).loose(), finish_reason: z.string().nullable().optional() }).loose()).min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      completion_tokens_details: z.object({ reasoning_tokens: z.number().optional() }).loose().nullable().optional(),
    })
    .loose(),
});

export class ChatHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly errorType: string | null;
  constructor(provider: string, status: number, errorType: string | null, detail: string) {
    super(`${provider} HTTP ${status}${errorType === null ? "" : ` ${errorType}`}: ${detail}`);
    this.provider = provider;
    this.status = status;
    this.errorType = errorType;
  }
}

export const costOf = (p: Pricing, inputTokens: number, outputTokens: number): number => (inputTokens * p.inputUsdPerMTok + outputTokens * p.outputUsdPerMTok) / 1_000_000;

export async function chat(
  route: ChatRoute,
  key: string,
  messages: readonly ChatMessage[],
  maxOutputTokens: number,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<ChatResult> {
  const body = { ...route.extraBody, model: route.model, messages, [route.maxTokensParam]: maxOutputTokens, temperature: 0 };
  const t0 = performance.now();
  const res = await fetchFn(`${route.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const raw = await res.text();
  const latencyMs = performance.now() - t0;
  if (!res.ok) {
    // The body is the provider's own text; the key is cut out in case it is ever echoed back.
    const safe = raw.split(key).join("[redacted]");
    let type: string | null = null;
    let message = safe.slice(0, 300);
    try {
      const e = (JSON.parse(safe) as { error?: { type?: unknown; code?: unknown; message?: unknown } }).error;
      if (e !== undefined) {
        type = typeof e.type === "string" ? e.type : typeof e.code === "string" ? e.code : null;
        if (typeof e.message === "string") message = e.message.slice(0, 300);
      }
    } catch {
      // not JSON; keep the text
    }
    throw new ChatHttpError(route.provider, res.status, type, message);
  }
  const parsed = Completion.parse(JSON.parse(raw));
  const inputTokens = parsed.usage.prompt_tokens;
  const outputTokens = parsed.usage.completion_tokens;
  return {
    text: parsed.choices[0]!.message.content ?? "",
    servedModel: parsed.model,
    inputTokens,
    outputTokens,
    reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens ?? 0,
    latencyMs,
    costUsd: costOf(route.pricing, inputTokens, outputTokens),
  };
}

const ModelList = z.object({ data: z.array(z.object({ id: z.string() }).loose()) });

/** The model ids a route's provider currently lists. */
export async function listModels(route: Pick<ChatRoute, "provider" | "baseUrl">, key: string | null, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchFn(`${route.baseUrl}/models`, { headers: key === null ? {} : { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new ChatHttpError(route.provider, res.status, null, "model list failed");
  return ModelList.parse(await res.json()).data.map((m) => m.id);
}
