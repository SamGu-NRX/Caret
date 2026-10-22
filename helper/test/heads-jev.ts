// Canned head answers for wire tests. Scope and value answers still come from each test's Jev.
import type { AskJev } from "../src/fill/jev.ts";

export function headsJev(inner: AskJev, route: "all" | "some" | "plan" = "some"): AskJev {
  return async (req) => {
    if (req.purpose !== "ask.heads") return inner(req);
    const choices: Record<string, string> = { route, source: "any", whose: "user", why: "nothingToFill" };
    return {
      model: "heads-fixture",
      answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: choices[id] ?? "none", confidence: 0.99 }])),
      inputTokens: 1, latencyMs: 0, costUsd: 0,
    };
  };
}
