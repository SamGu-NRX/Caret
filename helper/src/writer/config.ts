// Writer routes and the configured pick. Changing the pick is explicit configuration and needs a fresh run
// of scripts/writer-eval.ts (plan section 5); there is no automatic fallback to another route.
import type { ChatRoute } from "./chat.ts";

const GROQ = "https://api.groq.com/openai/v1";
const GATEWAY = "https://ai-gateway.vercel.sh/v1";
/** Groq's model table, console.groq.com/docs/models.md, read 2026-10-04. */
const GROQ_PRICES = "console.groq.com/docs/models.md, 2026-10-04";

export const GROQ_GPT_OSS_120B: ChatRoute = {
  provider: "groq",
  baseUrl: GROQ,
  keyName: "GROQ_API_KEY",
  model: "openai/gpt-oss-120b",
  maxTokensParam: "max_completion_tokens",
  // gpt-oss reasons by default (medium on Groq); low keeps a short plan program from paying for long thought.
  extraBody: { reasoning_effort: "low", include_reasoning: false },
  pricing: { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6, source: GROQ_PRICES },
};

export const GROQ_GPT_OSS_20B: ChatRoute = {
  ...GROQ_GPT_OSS_120B,
  model: "openai/gpt-oss-20b",
  pricing: { inputUsdPerMTok: 0.075, outputUsdPerMTok: 0.3, source: GROQ_PRICES },
};

export const GROQ_QWEN_3_8_27B: ChatRoute = {
  provider: "groq",
  baseUrl: GROQ,
  keyName: "GROQ_API_KEY",
  model: "qwen/qwen3.8-27b",
  maxTokensParam: "max_completion_tokens",
  extraBody: { reasoning_effort: "none" },
  pricing: { inputUsdPerMTok: 0.8, outputUsdPerMTok: 4.0, source: GROQ_PRICES },
};

/**
 * The same gpt-oss-120b through Vercel AI Gateway, pinned to Cerebras, the lowest p50 latency the gateway
 * listed for it on 2026-10-04 (157 ms, /v1/models/openai/gpt-oss-120b/endpoints). Not measured: on
 * 2026-10-04 the gateway answered every completion with HTTP 403 customer_verification_required ("requires
 * a valid credit card on file"). The routing fields follow the gateway's providerOptions and are unverified.
 */
export const GATEWAY_GPT_OSS_120B: ChatRoute = {
  provider: "gateway",
  baseUrl: GATEWAY,
  keyName: "AI_GATEWAY_API_KEY",
  model: "openai/gpt-oss-120b",
  maxTokensParam: "max_tokens",
  extraBody: { reasoning: { effort: "low" }, providerOptions: { gateway: { order: ["cerebras"], only: ["cerebras"] } } },
  pricing: { inputUsdPerMTok: 0.35, outputUsdPerMTok: 0.75, source: "ai-gateway.vercel.sh/v1/models/openai/gpt-oss-120b/endpoints (cerebras), 2026-10-04" },
};

export const CANDIDATES: readonly ChatRoute[] = [GROQ_GPT_OSS_120B, GROQ_GPT_OSS_20B, GROQ_QWEN_3_8_27B];

/** Filled in from the measured run; see the table above WRITER_ROUTE. */
export const WRITER_ROUTE: ChatRoute = GROQ_GPT_OSS_120B;
