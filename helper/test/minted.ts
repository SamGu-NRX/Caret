// Hand-built requests in tests and evaluation scripts carry fixture wording, not screen text a builder read. They mint
// every string as Caret's own wording and are sealed (privacy/disclosure.ts), so they reach the clients' minting check
// as a builder's request would. Production code mints through a builder's own Disclosure instead.
import { Disclosure } from "../src/privacy/disclosure.ts";
import type { MintedSay, RouteCandidate } from "../src/routing/routes.ts";

export function minted<R extends object>(req: R): R & { disclosure: Disclosure } {
  const d = new Disclosure([]);
  const walk = (v: unknown): void => {
    if (typeof v === "string") d.own(v as never);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  const r = req as { state?: unknown; questions?: unknown; nouls?: unknown; input?: unknown };
  walk([r.state, r.questions, r.nouls, r.input]);
  return d.seal(req);
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
