// A dollar cap on live Jev for the evaluation scripts that had none (executor-eval, pending-agent-eval,
// pending-fixture-eval, real-target-eval; H1 follow-up).
import type { AskJev } from "../src/fill/jev.ts";

/**
 * The default cap per run, in dollars. The lead set "under $0.25 per run" (brief I2). The cap is checked
 * before each request, so a run can pass it by one request's cost; 0.20 leaves that room. Not measured
 * against these scripts' usual spend: raise it with --max-usd when a run needs more.
 */
export const DEFAULT_MAX_USD = "0.20";

export interface CappedJev {
  ask: AskJev;
  calls: () => number;
  usd: () => number;
}

/**
 * `ask` behind a cap: once the spend reaches `maxUsd`, every further request is refused with an error
 * naming the cap, before anything is sent. A failed request costs nothing here, as the client reports
 * no cost for it.
 */
export function capJev(ask: AskJev, maxUsd: number): CappedJev {
  let calls = 0;
  let usd = 0;
  return {
    ask: async (req) => {
      if (usd >= maxUsd) throw new Error(`stopped: the live pass reached its $${maxUsd} budget ($${usd.toFixed(5)} spent)`);
      const r = await ask(req);
      calls++;
      usd += r.costUsd;
      return r;
    },
    calls: () => calls,
    usd: () => usd,
  };
}
