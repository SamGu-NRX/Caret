// The field an offer is bound to, built in one place so every producer gives the host the same
// window identity to check.
import type { OfferField } from "../protocol.ts";
import type { WindowState } from "../model.ts";

export function offerField(w: WindowState, key: string): OfferField {
  return {
    pid: w.app.pid,
    windowId: w.window.windowId,
    key,
    frame: w.nodes.get(key)?.frame ?? null,
    window: { number: w.window.number ?? null, title: w.window.title },
  };
}
