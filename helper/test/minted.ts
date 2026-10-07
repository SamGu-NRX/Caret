// Hand-built requests in tests and evaluation scripts carry fixture wording, not screen text a builder read. They mint
// every string as Caret's own wording and are sealed (privacy/disclosure.ts), so they reach the clients' minting check
// as a builder's request would. Production code mints through a builder's own Disclosure instead.
import { Disclosure } from "../src/privacy/disclosure.ts";

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
