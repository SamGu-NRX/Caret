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
export const WRITER_ROUTE: ChatRoute | null = null; // L1: was GROQ_QWEN_3_8_27B, the pick above

/** Longest qwen3.8 plan in runs 2 and 3 was 400 output tokens; 1,000 also stays under its per-minute limit. */
export const WRITER_MAX_OUTPUT_TOKENS = 1000;

/*
 * How an Ask's instruction becomes an intent (B25, planner/ask.ts): "writer" (INTENT_ROUTE's strict JSON) or "jev"
 * (staged Choice and Noul, planner/intent-makers.ts). Measured with scripts/realfill-asks.ts on B24's twenty asks,
 * which these makers, their prompt and the scoped fill's rules were tuned on (evidence/screen/b25/asks-dev-*):
 * right / partial / refused / wrong of 20, the values proposed right, and the maker's tokens per intent (mean, max).
 * Prompt 1 is the first prompt; prompt 2 asks less and keeps names out of literals; prompt 3 adds each mail's sender.
 *
 * | run (prompt)          | maker              | right | partial | refused | wrong | values right | tokens/intent |
 * | dev-1 (1)             | gpt-oss-120b       | 1     | 2       | 16      | 1*    | -            | 1705, 2180    |
 * | dev-1 (1)             | Jev Choice + Noul  | 1     | 3       | 15      | 1*    | -            | 3058 in, 4499 |
 * | dev-2 (2)             | gpt-oss-120b       | 3     | 5       | 12      | 0     | 25           | 1861, 2347    |
 * | dev-2 (2)             | gpt-oss-20b        | 1     | 7       | 12      | 0     | 25           | 1847, 2332    |
 * | dev-2 (2)             | Jev Choice + Noul  | 2     | 2       | 16      | 0     | 11           | 3058 in, 4499 |
 * | dev-3 (3)             | gpt-oss-120b       | 1     | 8       | 11      | 0     | 25           | 1945, 2399    |
 * | dev-3 (3)             | gpt-oss-20b        | 1     | 7       | 11      | 1*    | 24           | 1923, 2410    |
 * | dev-3 (3)             | Jev Choice + Noul  | 2     | 2       | 16      | 0     | 11           | 3101 in, 4541 |
 * (* a wrong fill the scoped fill made from a right intent, closed by a fill rule afterwards: fill.ts untied,
 * the source-any owner rule, whichOfTheirs.)
 *
 * Pick: the writer on gpt-oss-120b. Right asks tie with Jev at a mean of 2 (3 and 1 against 2 and 2), and the
 * writer proposes more than twice the right values: Jev's two stages rarely both clear their floors, so 14 to 16
 * of its 20 ended as "which fields?". The Noul floor stays at plan section 4's 0.95: on dev-1 it confirmed 7 of 14
 * wanted fields and 0 of 107 others; 0.5 confirmed 12 of 14, and 2 others.
 *
 * qwen3.8-27b, the plan writer (WRITER_ROUTE), was not measured on intents: on 2026-10-04 it had used 198,935 of
 * Groq's 200,000 tokens a day before the third ask. Its two intents cost 1,286 and 1,815 tokens, so 50 asks a day
 * would fit its quota if Ask had it alone; the plan route and code mode share it. gpt-oss-120b has its own
 * 200,000 a day and 8,000 a minute (console.groq.com/docs/rate-limits, 2026-10-04): at about 1,950 tokens an
 * intent, 50 asks take about 98,000 a day, and four a minute is its ceiling. Strict mode failed twice on
 * gpt-oss-120b in 40 intents with HTTP 400 "does not match the expected schema" (both a refusal before scope
 * allowed "none"); such an Ask fails as unavailable and is not retried on another model.
 */
/*
 * B26 (2026-10-04): qwen3.8-27b against gpt-oss-120b on B24's twenty was not measured. Both models' Groq tokens per
 * day ran out on the first run of each, though a one-token probe still answered: gpt-oss-120b after 4 of 13 asks
 * (code at e71a525), qwen3.8-27b after 6 of 7 (code at 82a1ab3). On the asks both answered (ask-01 to ask-04), 120b:
 * refused, asked a question, right, refused; qwen3.8: partial, asked, right, refused; 0 wrong each
 * (evidence/screen/b26/asks-b24-120b, asks-b24-qwen run logs). Four asks are no measurement, so the pick stays
 * gpt-oss-120b. B26's scoreboards ran on gpt-oss-20b instead, which still had tokens, and say so. A second try two
 * hours later (code at 312cee5) ran out again within a few asks: 120b answered 2 of 20, qwen3.8 4 of 20.
 */
/*
 * L1 (2026-10-05, lead decision 2): Jev makes Ask's intents, so no Ask calls Groq. Today's numbers, scripts/realfill-asks.ts
 * --maker jev on Jev jev-1.13.0, plan-route writer off (evidence/screen/l1 asks-*-jev-1, code at 3e890b3), of 20 each:
 * | set                | right | partial | asked (option recall) | refused | wrong | after the pick: right, partial, wrong | Jev $  |
 * | B24 (tuned)        | 0     | 0       | 16 (10/16)            | 4       | 0     | 1, 4, 0                               | 0.0073 |
 * | B25 held-out       | 0     | 0       | 10 (7/10)             | 10      | 0     | 0, 2, 0                               | 0.0037 |
 * | B26 held-out-2     | 0     | 0       | 12 (8/12)             | 8       | 0     | 2, 3, 0                               | 0.0047 |
 */
/*
 * P1 (plans/fast-browser.md, "Intent as one request with heads"): "heads" is Jev in one request (planner/intent-heads.ts),
 * the default since it beat the staged Jev maker above on all three sets. scripts/realfill-asks.ts --maker heads, Jev only,
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
export const ASK_MAKER: "writer" | "jev" | "heads" = "heads";
/** The writer route for intents; a change is explicit configuration and a fresh scoreboard run, never a fallback. */
export const INTENT_ROUTE: ChatRoute | null = null; // L1: was GROQ_GPT_OSS_120B

