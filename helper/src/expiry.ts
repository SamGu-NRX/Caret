// Everything that lets go of a window's state when the screen model expires it (model.ts ScreenModel.expire): every
// offer family, and each other holder of state read from one window. Helper.onExpiry is the one list. Its type names
// every offer producer (offers/lifetimes.ts), so tsc refuses a list that leaves out a new family, and
// test/model-retention.test.ts checks the names it holds.
import { provenanceWindows, type Provenance } from "./fill/contract.ts";
import type { OfferProducer } from "./offers/lifetimes.ts";

/** Holders of state read from a window that are not offer families. */
export const WINDOW_STATE_HOLDERS = ["transfers", "lineTable", "ownerVerdicts", "preFocus", "caretWrites", "answerOffers", "askQuestions", "pendingWatches", "goalSegments", "runs", "router"] as const;

export type WindowStateHolder = OfferProducer | (typeof WINDOW_STATE_HOLDERS)[number];

/** How each holder lets go of an expired window; null for one that lets go of nothing, with the reason beside it in the list. */
export type ExpiryList = Record<WindowStateHolder, ((windowId: string) => void) | null>;

/** Notifies every holder of the expired window in the list's order, each handler once though several families share it. */
export function notifyExpiry(list: ExpiryList, windowId: string): void {
  for (const f of new Set(Object.values(list))) f?.(windowId);
}

type Read = { readonly provenance: Provenance };

/** The windows a planned task acts in or copies from: its target, and each window a value it writes or attaches was read from. */
export function planWindows(d: { checked: { window: { window: { windowId: string } }; mints: ReadonlyMap<string, Read>; writes: readonly { checked: Read }[]; attach: { checked: Read } | null } }): Set<string> {
  const out = new Set([d.checked.window.window.windowId]);
  const reads = [...d.checked.mints.values(), ...d.checked.writes.map((w) => w.checked), ...(d.checked.attach === null ? [] : [d.checked.attach.checked])];
  for (const r of reads) for (const id of provenanceWindows(r.provenance)) out.add(id);
  return out;
}

/** The windows an Ask question is about or quotes: its form, and each window a value its fill proposed was read from. */
export function askWindows(d: { window: { windowId: string }; resume: { windowId: string; values?: { proposal: { fields: readonly { source: { windowId: string } | null }[] } } } }): Set<string> {
  const out = new Set([d.window.windowId, d.resume.windowId]);
  for (const f of d.resume.values?.proposal.fields ?? []) if (f.source !== null) out.add(f.source.windowId);
  return out;
}
