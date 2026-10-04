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

/*
 * Measured 2026-10-04 with scripts/writer-eval.ts on the ten synthetic cases in
 * test/codemode/writer-corpus.ts, one request at a time from the development Mac. "Correct" means the sandbox
 * accepted the program and the plan's fills, presses and asks equal the expected ones. The gateway could
 * not be measured (HTTP 403, see GATEWAY_GPT_OSS_120B), so all three candidates are Groq-hosted.
 *
 * Run 3 (final prompt and sandbox, output cap 1,000 tokens, no rate-limit retries):
 * | model               | correct | valid | p50 ms | p95 ms | mean in/out tok (reasoning) | $/plan  |
 * | qwen/qwen3.8-27b    | 9/10    | 10/10 |    747 |   2006 | 1277 / 209 (0)              | 0.00186 |
 * | openai/gpt-oss-20b  | 8/10    | 10/10 |    617 |   1645 | 1244 / 313 (91)             | 0.00019 |
 * | openai/gpt-oss-120b | 7/10    |  8/10 |   1323 |   2669 | 1244 / 425 (178)            | 0.00044 |
 *
 * Run 2 (same corpus, before switch was allowed and before choose required every option):
 * qwen3.8-27b 6/10 correct, two of the misses Groq 429s; p50 670, p95 986 ms.
 * gpt-oss-20b 8/10; p50 756, p95 1222 ms. gpt-oss-120b 8/10, both misses a refused switch; p50 882,
 * p95 1928 ms. Spend over runs 1-3: $0.057.
 *
 * Pick: qwen3.8-27b. Best correctness in run 3, no reasoning tokens, and its misses fail safe: it left
 * out the Save press on "create the event" in both runs, and once passed a non-string to press, which the
 * sandbox refused. gpt-oss-20b pressed "Continue to payment" when only asked to fill the shipping
 * address in both runs. gpt-oss-120b once filled a date without calling choose, and once spent its
 * 1,000-token cap on reasoning and returned no program. Ten cases per run is small: a one- or two-case
 * difference is within run-to-run variation, so this pick is provisional.
 *
 * Limits that matter for the product: Groq's on-demand tier allows qwen3.8-27b 1,000 output tokens a
 * minute (about five plans) and the gpt-oss models 8,000 tokens a minute (about five plans).
 */
export const WRITER_ROUTE: ChatRoute = GROQ_QWEN_3_8_27B;

/** Longest qwen3.8 plan in runs 2 and 3 was 400 output tokens; 1,000 also stays under its per-minute limit. */
export const WRITER_MAX_OUTPUT_TOKENS = 1000;
