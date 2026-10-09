// SC1 threat T4: Caret can't enforce what a provider does with what it is sent, only where it sends. A route whose
// provider keeps or trains on requests (`retains`) is refused by the Jev client and the writer port unless the request
// comes from an evaluation harness's declared fixture text. The flags below are the ones the code acted on before SC1:
// only Laya was refused. None is verified with its provider; Sam is checking retention with TypeSafe, Groq and Gemini,
// and until then these flags change only on his word.
import type { ChatRoute } from "../writer/chat.ts";

export interface ProviderPolicy {
  /** Whether the provider keeps or trains on what Caret sends. */
  retains: boolean;
  /** Whether `retains` was confirmed with the provider for Caret's account. False for every route today. */
  verified: false;
  /** Where the flag comes from. */
  source: string;
}

const UNVERIFIED = "unverified: allowed before SC1; Sam is checking retention with the provider (PV2 brief)";

/** Laya on the gateway: refused outside evaluations since GW1. */
const LAYA: ProviderPolicy = { retains: true, verified: false, source: "Laya's boundless endpoint reports has_no_training:false and has_zdr:false (GW1, 2026-10-06)" };
const NOT_KNOWN_TO_RETAIN: ProviderPolicy = { retains: false, verified: false, source: UNVERIFIED };

/** The Jev route's policy: Laya by its gateway model id, every other TypeSafe route unverified (fill/jev.ts JevSettings). */
export function jevPolicy(route: { provider: "typesafe" | "gateway"; model: string }): ProviderPolicy {
  return route.provider === "gateway" && route.model === "convaiinnovations/laya-free" ? LAYA : NOT_KNOWN_TO_RETAIN;
}

/** A writer route's policy (writer/chat.ts ChatRoute): Groq's and the gateway's listed models, all unverified. */
export function writerPolicy(_route: Pick<ChatRoute, "provider" | "model">): ProviderPolicy {
  return NOT_KNOWN_TO_RETAIN;
}
