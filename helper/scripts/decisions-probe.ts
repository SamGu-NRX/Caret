// One synthetic predicate, no retry. Print only status, latency and billed cost, never the key or response body.
import { Disclosure, registryOf } from "../src/privacy/disclosure.ts";
import { makeDecisionsClient, DecisionsAttemptError } from "../src/engines/decide/decisions.ts";
import { DecisionsSpend } from "../src/engines/decide/decisions-spend.ts";

const spend = DecisionsSpend.fromEnv();
const started = performance.now();
let status: string | number = "failed";
let costUsd: number | null = null;
try {
  const d = new Disclosure(registryOf([]));
  const ask = makeDecisionsClient({ fixture: { windows: () => false, memory: false, plan: false }, spend, probe: true });
  const result = await ask(d.seal({
    state: d.own("Synthetic test: the square is blue."),
    questions: {},
    nouls: { blue: { type: "noul" as const, instructions: d.own("Is the square blue?") } },
    snippets: [], charged: {}, disclosure: d,
  }));
  status = "ok";
  costUsd = result.costUsd;
} catch (e) {
  status = e instanceof DecisionsAttemptError ? e.status ?? "failed" : "failed";
  if (e instanceof DecisionsAttemptError) costUsd = e.attempt.costUsd;
  process.exitCode = 1;
} finally {
  spend.close();
}
console.log(JSON.stringify({ status, latencyMs: performance.now() - started, costUsd }));
