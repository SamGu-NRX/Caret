// Writer routes and the configured pick. Changing the pick is explicit configuration and needs a fresh run
// of scripts/writer-eval.ts (plan section 5); there is no automatic fallback to another route.
// L1 (2026-10-05): Sam turned Groq off ("As for Groq, I currently don't want to."). No route is configured; a developer
// names one with --dev-writer (writer/routes.ts devWriterRoute, writer/startup.ts).
import { ENV } from "../host-env.ts";
import type { ChatRoute } from "./chat.ts";

const GROQ = "https://api.groq.com/openai/v1";
const GATEWAY = "https://ai-gateway.vercel.sh/v1";
/** Groq's model table, console.groq.com/docs/models.md, read 2026-10-04. */
const GROQ_PRICES = "console.groq.com/docs/models.md, 2026-10-04";

export const GROQ_GPT_OSS_120B: ChatRoute = {
  provider: "groq",
  baseUrl: GROQ,
  keyName: ENV.groq_api_key,
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
  keyName: ENV.groq_api_key,
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
  keyName: ENV.ai_gateway_api_key,
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
/*
 * Slice 1 (2026-10-09, v2/act): the same ten cases (scripts/writer-eval.ts), one run each, for Sam's pick of the
 * plan-route writer (design CU-COUNSEL-20261009). Evidence: ~/.caret-run/evidence/act/writer/{groq,openai}.
 * | route                          | valid | correct | p50 ms | p95 ms | mean in/out tok (reasoning) | $/plan (list) |
 * | groq qwen/qwen3.8-27b          | 10/10 | 9/10    |    684 |   1121 | 1277 / 221 (0)              | 0.00191       |
 * | openai gpt-6-luna, effort low  |  5/10 | 4/10    |   5980 |   8794 | 1180 / 408 (194)            | 0.00032       |
 * | openai gpt-6-luna, effort none |  4/10 | 3/10    |   2272 |   3587 |  947 / 165 (0)              | 0.00018       |
 * Luna's misses: programs that read `window`, which the sandbox's API doesn't have (5 at effort low, 4 at none), two
 * requests at effort none that passed the 10 s writer timeout, and event-date-choice, a valid wrong plan on all three. Groq ran on its free tier, so its dollars are list price, not
 * billed. Ten cases a run: a one-case difference is noise. No route is configured until Sam picks one.
 */
export const WRITER_ROUTE: ChatRoute | null = null; // L1: was GROQ_QWEN_3_8_27B, the pick above

/** Longest qwen3.8 plan in runs 2 and 3 was 400 output tokens; 1,000 also stays under its per-minute limit. */
export const WRITER_MAX_OUTPUT_TOKENS = 1000;

/*
 * P1 (plans/fast-browser.md, "Intent as one request with heads"): "heads" is Jev in one request (planner/intent-heads.ts),
 * the default since it beat the retired staged Jev maker on all three sets. scripts/realfill-asks.ts --maker heads, Jev only,
 * plan-route writer off, code at 582e458 (evidence/screen/p1 asks-b24-heads-final, asks-heldout-heads-final,
 * asks-heldout2-heads-final):
 * | set                | right | partial | asked (option recall) | refused | wrong | after the pick: right, partial, wrong | Jev $  |
 * | B24 (tuned)        | 1     | 2       | 9 (5/9)               | 8       | 0     | 1, 2, 0                               | 0.0081 |
 * | B25 held-out       | 0     | 1       | 9 (6/9)               | 10      | 0     | 0, 1, 0                               | 0.0049 |
 * | B26 held-out-2     | 0     | 2       | 9 (5/9)               | 9       | 0     | 1, 2, 0                               | 0.0051 |
 * One Jev request per intent in all 60 (the staged maker sends two to four); its latency p50 148 to 207 ms, p95 under
 * 375 ms. Asks that end in a fill, at once or after the pick: 13 of 60 against the staged maker's 12, with 27 questions
 * against 38. B24's asked plus refused is 17 against the Groq writer's 14 (evidence/screen/b29/final3-b24-120b): the
 * scope head's margin stayed under its 0.75 floor on six asks, and on five more the best field answer was 0.69 to 0.93,
 * under 0.95 (two of those five must be refused anyway). Not tuned to close it.
 */
export const ASK_MAKER = "heads" as const;

/** Assumed, not measured: planner spending limit, design CU-COUNSEL-20261009. */
export const WRITER_DAILY_CAP_USD = 0.25;
