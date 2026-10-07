// PV2 re-review, the I/O boundary: a request's bytes reach a transport or a store only through these, called in the
// transport call or the store write itself, on every attempt (each retry, each call a queued request makes when it is
// dequeued). Each checks the request as it leaves: every string minted for it, in its shape, and no app or site
// switched off since it was built (Disclosure.verify). So a request built before a switch-off never reaches a model or a
// disk, however long it waited. test/sc1-boundary.test.ts holds every POST body and every request store in src to them.
import { verifySent, verifyWriterInput, withheldDeep } from "./disclosure.ts";

/** A request on its way out: the request (its Disclosure travels with it) and the body it verifies as. */
export type Outbound =
  | { readonly req: { purpose?: string; disclosure?: unknown }; readonly wire: unknown }
  | { readonly writer: { kind: string; disclosure?: unknown; input: unknown } };

function check(o: Outbound): void {
  if ("writer" in o) verifyWriterInput(o.writer);
  else verifySent(o.req, o.wire);
}

/**
 * The body a transport posts, checked now: `payload` (the wire body itself unless the transport renders it, as a chat
 * route's messages or a local engine's prompt) as JSON. Throws UnmintedText when the request may not leave.
 */
export function sealedBody(o: Outbound, payload?: unknown): string {
  check(o);
  if (payload !== undefined) return JSON.stringify(payload);
  return JSON.stringify("writer" in o ? o.writer.input : o.wire);
}

/**
 * The line a store writes, checked now (privacy/disclosure.ts storable): `kept`, the store's record of the request, as
 * JSON with every value in a format Caret never carries withheld, and a newline.
 */
export function storedLine(o: Outbound, kept: unknown): string {
  check(o);
  return `${JSON.stringify(withheldDeep(kept))}\n`;
}
