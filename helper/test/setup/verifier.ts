// W2: every test file starts with a stand-in verifier that calls each value exact at 0.95 (fill/contract.ts
// setTestVerifier), since the stand-in Jevs written before W2 know only fill's and the planner's questions. A test of
// the verifier itself calls setTestVerifier(null) and passes its own Jev (test/contract.test.ts).
import { setTestVerifier } from "../../src/fill/contract.ts";
import type { AskJev } from "../../src/fill/jev.ts";

export const STAND_IN: AskJev = async (req) => ({ model: "verify-stand-in", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "exact", confidence: 0.95 }])), inputTokens: 0, latencyMs: 0, costUsd: 0 });
setTestVerifier(STAND_IN);
