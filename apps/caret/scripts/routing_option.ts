// The socket acceptances' routing switch (H6), shared by offers_socket_acceptance.ts and
// memory_socket_acceptance.ts.
//
//   --routing off    the helper runs without the router, as before D2-02 (the default; also what a
//                    helper started with --no-jev does).
//   --routing live   the helper runs D2-02's router. Router 1 and Router 2 questions go to live Jev;
//                    every other question goes to the script's own fake, as before. Spend stops at
//                    SPEND_CAP_USD: past it a router question fails, which the router reads as abstain.
//   --host-routing on|off   the host's "Caret decides when to help", set over the debug socket.
//
// The Jev key is read at call time from CARET_ENV_FILE (default: the main checkout's .env), never printed.
import type { AskJev } from "../../../helper/src/fill/jev.ts";
import { loadJevKey, makeJevClient } from "../../../helper/src/fill/jev.ts";
import type { Helper } from "../../../helper/src/helper.ts";

/** Live router spend per process, in dollars, after which router questions fail. H6 started six live processes under a $0.05 limit (two crashed before reporting), so each stops at $0.006. */
export const SPEND_CAP_USD = 0.006;

export const routingOptions = {
  routing: { type: "string", default: "off" },
  "host-routing": { type: "string", default: "on" },
} as const;

export interface RoutedJev {
  askJev: AskJev | null;
  /** For the result file: calls and dollars on live Jev. */
  usage: () => { routerCalls: number; spendUsd: number; refusedOverCap: number };
}

/** Router questions are the ones routing/judge.ts asks: `outcome` (Router 1) and `route` (Router 2). */
const isRouter = (questions: Record<string, unknown>): boolean => "outcome" in questions || "route" in questions;

export function routedJev(mode: string, fake: AskJev | null): RoutedJev {
  if (mode !== "live" && mode !== "off") throw new Error(`--routing is off or live, not ${mode}`);
  let routerCalls = 0;
  let spendUsd = 0;
  let refusedOverCap = 0;
  const usage = () => ({ routerCalls, spendUsd: Number(spendUsd.toFixed(6)), refusedOverCap });
  if (mode === "off") return { askJev: fake, usage };
  process.env.CARET_ENV_FILE ??= "/Users/samgu/Programming Projects/Caret/.env";
  const live = makeJevClient(() => loadJevKey());
  const askJev: AskJev = async (req) => {
    if (isRouter(req.questions as Record<string, unknown>)) {
      if (spendUsd >= SPEND_CAP_USD) {
        refusedOverCap++;
        throw new Error(`live router spend reached $${SPEND_CAP_USD}`);
      }
      routerCalls++;
      const r = await live(req);
      spendUsd += r.costUsd;
      return r;
    }
    if (fake === null) throw new Error("this run answers router questions only");
    return fake(req);
  };
  return { askJev, usage };
}

/**
 * The Helper option that turns the router on, with its timers kept here (Router 1's cooldown runs on real time) so a
 * session can wait for routing to settle and cancel what is pending before it closes the helper: Helper.shutdown does
 * not stop the router, and a cooldown timer that fires after the stores close throws in the router's next observe.
 */
export interface RoutingHarness {
  options: { routing?: { setTimer: (fn: () => void, ms: number) => () => void } };
  /** Resolves once no router call is in flight or waiting and the work its decisions started has ended. */
  settle: (h: Helper) => Promise<void>;
  /** Cancels every pending router timer; call before Helper.shutdown. */
  cancel: () => void;
}

export function routingHarness(mode: string): RoutingHarness {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const setTimer = (fn: () => void, ms: number): (() => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return () => {
      clearTimeout(t);
      timers.delete(t);
    };
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  return {
    options: mode === "live" ? { routing: { setTimer } } : {},
    settle: async (h) => {
      for (let i = 0; i < 400; i++) {
        await h.routing?.idle();
        await h.routedSettled;
        if (timers.size === 0) return;
        await sleep(50);
      }
    },
    cancel: () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
