import { requireVercelDevelopment } from "../privacy/vercel.ts";
// One OpenAI-compatible chat completion, the shape both Vercel AI Gateway and Groq serve. No retry: a
// failed write is reported, and the plan says a provider change is explicit configuration.
import { sealedBody, type Sealed } from "../privacy/send.ts";
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
  /** Seconds the provider asked the caller to wait (Retry-After), when it said. */
  readonly retryAfterS: number | null;
  constructor(provider: string, status: number, errorType: string | null, detail: string, retryAfterS: number | null = null) {
    super(`${provider} HTTP ${status}${errorType === null ? "" : ` ${errorType}`}: ${detail}`);
    this.provider = provider;
    this.status = status;
    this.errorType = errorType;
    this.retryAfterS = retryAfterS;
  }
}

/**
 * Vercel AI Gateway's refusal of an account with no card: HTTP 403, type customer_verification_required, "requires a
 * valid credit card on file". It came for every completion on 2026-10-04 and again on 2026-10-05 for the free models
 * (L1), so it is said plainly rather than as the provider's text. Never retried, never sent to another route.
 */
export class GatewayNeedsCard extends ChatHttpError {
  constructor(errorType: string | null) {
    super("gateway", 403, errorType, "requires a valid credit card on file");
    this.message = "Vercel AI Gateway needs a card on file, even for free models";
  }
}

const needsCard = (provider: ChatRoute["provider"], status: number, type: string | null, message: string): boolean =>
  provider === "gateway" && status === 403 && (type === "customer_verification_required" || /credit card on file/i.test(message));

export const costOf = (p: Pricing, inputTokens: number, outputTokens: number): number => (inputTokens * p.inputUsdPerMTok + outputTokens * p.outputUsdPerMTok) / 1_000_000;

export async function chat(
  route: ChatRoute,
  key: string,
  /** The sealed request (privacy/send.ts seal), and its messages as rendered from the sealed copy only. */
  sealed: Sealed,
  messagesOf: (wire: unknown) => readonly ChatMessage[],
  maxOutputTokens: number,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
  /** An OpenAI-style response_format, such as a strict json_schema (B25 intents); absent for free text. */
  responseFormat?: Readonly<Record<string, unknown>>,
): Promise<ChatResult> {
  if (route.provider === "gateway" || new URL(route.baseUrl).hostname === "ai-gateway.vercel.sh") requireVercelDevelopment();
  const body = (wire: unknown) => ({ ...route.extraBody, model: route.model, messages: messagesOf(wire), [route.maxTokensParam]: maxOutputTokens, temperature: 0, ...(responseFormat === undefined ? {} : { response_format: responseFormat }) });
  const t0 = performance.now();
  const res = await fetchFn(`${route.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: sealedBody(sealed, body),
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
    if (needsCard(route.provider, res.status, type, message)) throw new GatewayNeedsCard(type);
    const retry = Number(res.headers.get("retry-after"));
    throw new ChatHttpError(route.provider, res.status, type, message, Number.isFinite(retry) && retry > 0 ? retry : null);
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
  if (route.provider === "gateway" || new URL(route.baseUrl).hostname === "ai-gateway.vercel.sh") requireVercelDevelopment();
  const res = await fetchFn(`${route.baseUrl}/models`, { headers: key === null ? {} : { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new ChatHttpError(route.provider, res.status, null, "model list failed");
  return ModelList.parse(await res.json()).data.map((m) => m.id);
}
