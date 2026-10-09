// An evaluation's Jev, with every request tied to the Ask that sent it when it is sent. The scorer moves to the next Ask
// while a slow answer is still on its way; read at answer time, four of SCP1's live log lines named the wrong Ask. An
// HTTP 503 marks the Ask that sent it unavailable, its continuations included ("<id>+pick"), so the scorer reports it
// as not run instead of scoring what the Ask said after the failure (b31-03's verifier 503 had read as "no value").
import type { AskJev, JevRequest, JevResult } from "../src/fill/jev.ts";
import { JevHttpError } from "../src/fill/jev.ts";
import { DecisionsAttemptError } from "../src/engines/decide/decisions.ts";

/** One event: dispatch, then exactly one of answer or error, each carrying the request, its number and its Ask. */
export type DispatchLine = { request: number; ask: string; req: JevRequest } & ({ event: "dispatch" } | { event: "answer"; result: JevResult } | { event: "error"; error: string });

/** The HTTP status behind a failed request, through the causes a wrapper keeps; null for no HTTP answer. */
export function httpStatus(e: unknown): number | null {
  for (let at = e, depth = 0; at instanceof Error && depth < 5; at = at.cause, depth++) if (at instanceof JevHttpError || at instanceof DecisionsAttemptError) return at.status;
  return null;
}

/** The Ask an id names: a continuation's "<id>+pick" is its Ask's. */
export const askOf = (id: string): string => id.replace(/\+pick$/u, "");

/**
 * `notRun(id)` answers whether any request the Ask sent got HTTP 503, only once every request it sent has answered: an
 * Ask can end on one failure (planAsk's Promise.all rejects at the first) while a sibling is still out, and that
 * sibling's 503 still makes the Ask not run.
 */
export function attributedJev(send: (req: JevRequest, ask: string) => Promise<JevResult>, current: () => string, log: (line: DispatchLine) => void): { ask: AskJev; notRun: (id: string) => Promise<boolean> } {
  const unavailable = new Set<string>();
  const sent = new Map<string, Promise<unknown>[]>();
  let dispatched = 0;
  const ask: AskJev = (req) => {
    const request = ++dispatched;
    const id = current();
    log({ request, ask: id, req, event: "dispatch" });
    const reply = (async () => {
      let result: JevResult;
      try {
        result = await send(req, id);
      } catch (e) {
        const status = httpStatus(e);
        if (status === 503) unavailable.add(askOf(id));
        log({ request, ask: id, req, event: "error", error: status === null ? (e instanceof Error ? e.name : "error") : `HTTP ${status}` });
        throw e;
      }
      log({ request, ask: id, req, event: "answer", result });
      return result;
    })();
    sent.set(askOf(id), [...(sent.get(askOf(id)) ?? []), reply]);
    return reply;
  };
  const notRun = async (id: string): Promise<boolean> => {
    await Promise.allSettled(sent.get(id) ?? []);
    return unavailable.has(id);
  };
  return { ask, notRun };
}
