// The decision engine port (J1 part B). Every decision Caret asks a model for is a request of Choice questions (one
// option of a listed set, with a confidence) and yes/no questions (the probability of yes), the shapes Jev's System One
// answers (fill/jev.ts JevRequest and JevResult). Callers take an AskJev and never know which engine answers; an engine
// is an AskJev with a name, a model, and where the request text goes. No caller asks a Score question, so the port has
// none; add it when a caller does.
import type { AskJev } from "../../fill/jev.ts";

export const ENGINE_NAMES = ["jev", "canned", "llama", "gemini"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

/**
 * Where an engine's request text goes, which decides what text may be sent to it:
 * - `mac`: nowhere; the model runs on this Mac (llama-server on localhost, an answer key).
 * - `typesafe`: TypeSafe's service, which does not train on customer requests (docs.typesafe.ai/models, "Data handling").
 * - `google-free-tier`: Google AI Studio's free tier, whose terms let Google use requests to improve its products, so
 *   fixture text only, never the user's screens (brief J1).
 */
export type EngineReach = "mac" | "typesafe" | "google-free-tier";

export interface DecideEngine {
  readonly name: EngineName;
  /** The model that answers, as the engine names it: part of every cache key and every report line. */
  readonly model: string;
  readonly reach: EngineReach;
  readonly ask: AskJev;
}

export function engineName(raw: string): EngineName {
  if (!(ENGINE_NAMES as readonly string[]).includes(raw)) throw new Error(`--engine is ${ENGINE_NAMES.join(", ")}, not '${raw}'`);
  return raw as EngineName;
}
