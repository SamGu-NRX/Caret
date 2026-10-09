// Hand-built requests in tests and evaluation scripts carry fixture wording, not screen text a builder read. They mint
// every string as Caret's own wording and are sealed (privacy/disclosure.ts), so they reach the clients' minting check
// as a builder's request would. Production code mints through a builder's own Disclosure instead.
import { Disclosure, type Minted, registryOf } from "../src/privacy/disclosure.ts";
import type { MintedSay, RouteCandidate } from "../src/routing/routes.ts";
import type { GoalInventory } from "../src/goals/plan.ts";

/** A request with its body's texts typed as minted: what a builder's sealed request is. */
type Body = "state" | "questions" | "nouls" | "input";
export type MintedRequest<R> = Omit<R, Body> & { [K in keyof R & Body]: Minted<R[K]> } & { disclosure: Disclosure };

export function minted<const R extends object>(req: R): MintedRequest<R> {
  const d = new Disclosure(registryOf([]));
  const walk = (v: unknown): void => {
    if (typeof v === "string") d.own(v as never);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  const r = req as { state?: unknown; questions?: unknown; nouls?: unknown; input?: unknown };
  walk([r.state, r.questions, r.nouls, r.input]);
  return d.seal(req) as unknown as MintedRequest<R>;
}

/**
 * A test route candidate's sentences, minted at the router's request from the candidate's own fixed wording, read when
 * the router asks (routing/routes.ts RouteCandidate.say). Its quotes are checked by the router as any producer's are.
 */
export function fixtureSay(c: Pick<RouteCandidate, "says" | "plain" | "question" | "evidence">): (d: Disclosure) => MintedSay {
  return (d) => ({
    says: d.own(c.says as never),
    plain: d.own(c.plain as never),
    ...(c.question === undefined ? {} : { question: d.own(c.question.says as never) }),
    ...(c.evidence === undefined ? {} : { offer: { task: d.own(c.evidence.task as never), sentence: d.own(c.evidence.sentence as never), found: d.own(c.evidence.found as never), offerWhen: d.own(c.evidence.offerWhen as never) } }),
  });
}

/**
 * The goal ledger for a hand-built inventory: every target label and value text, display and source title minted as
 * fixture wording, as buildInventory mints them from the views (goals/inventory.ts).
 */
export function inventoryLedger(inv: GoalInventory): Disclosure {
  const d = new Disclosure(registryOf([]));
  for (const t of inv.targets.values()) d.own(t.label as never);
  for (const v of inv.values.values()) {
    d.own(v.text as never);
    d.own(v.display as never);
  }
  for (const t of inv.texts.values()) d.own(t.title as never);
  return d;
}
