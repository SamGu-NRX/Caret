// Routes a developer may name (L1): "groq:<model>" for one of the measured Groq routes, "gateway:<model>" for Vercel AI
// Gateway's OpenAI-compatible endpoint by model id. Nothing here is a default: writer/startup.ts uses a route only when
// --dev-writer names it, and the eval scripts only when their flags do.
import { ENV } from "../host-env.ts";
import type { ChatRoute } from "./chat.ts";
import { CANDIDATES } from "./config.ts";

/** Vercel AI Gateway's OpenAI-compatible endpoint. */
export const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

/**
 * The gateway models a developer may name, with their prices. The free ones are the three language models
 * scripts/gateway-probe.ts found priced 0 on 2026-10-05; a completion on this account then answered HTTP 403 "requires
 * a valid credit card on file" even for them (chat.ts GatewayNeedsCard; evidence/screen/l1/gateway-probe.txt), so none
 * of these routes has been measured. gpt-oss-120b's fields are writer/config.ts GATEWAY_GPT_OSS_120B's.
 */
const FREE = { inputUsdPerMTok: 0, outputUsdPerMTok: 0, source: "ai-gateway.vercel.sh/v1/models, priced 0, 2026-10-05" };
const GATEWAY_MODELS: Readonly<Record<string, Pick<ChatRoute, "extraBody" | "pricing">>> = {
  "inclusionai/ling-3.1-flash": { extraBody: {}, pricing: FREE },
  "inclusionai/ling-3.1-flash-free": { extraBody: {}, pricing: FREE },
  "poolside/laguna-s-2.1-free": { extraBody: {}, pricing: FREE },
  "openai/gpt-oss-120b": {
    extraBody: { reasoning: { effort: "low" }, providerOptions: { gateway: { order: ["cerebras"], only: ["cerebras"] } } },
    pricing: { inputUsdPerMTok: 0.35, outputUsdPerMTok: 0.75, source: "ai-gateway.vercel.sh/v1/models/openai/gpt-oss-120b/endpoints (cerebras), 2026-10-04" },
  },
};
export const GATEWAY_MODEL_IDS: readonly string[] = Object.keys(GATEWAY_MODELS);

/** The gateway route for one of GATEWAY_MODEL_IDS; any other id is an error that lists them. */
export function gatewayRoute(model: string): ChatRoute {
  const m = GATEWAY_MODELS[model];
  if (m === undefined) throw new Error(`Vercel AI Gateway model '${model}' has no route here; known: ${GATEWAY_MODEL_IDS.join(", ")} (writer/routes.ts)`);
  return { provider: "gateway", baseUrl: GATEWAY_BASE_URL, keyName: ENV.ai_gateway_api_key, model, maxTokensParam: "max_tokens", ...m };
}

/** "groq:<model>" or "gateway:<model>"; anything else is an error that lists what may be named. */
export function devWriterRoute(spec: string): ChatRoute {
  const cut = spec.indexOf(":");
  const provider = cut < 0 ? "" : spec.slice(0, cut);
  const model = cut < 0 ? "" : spec.slice(cut + 1);
  if (provider === "gateway") return gatewayRoute(model);
  const groq = provider === "groq" ? CANDIDATES.find((r) => r.model === model) : undefined;
  if (groq !== undefined) return groq;
  throw new Error(`writer '${spec}' is not a route: name one of ${[...CANDIDATES.map((r) => `groq:${r.model}`), ...GATEWAY_MODEL_IDS.map((m) => `gateway:${m}`)].join(", ")}`);
}
