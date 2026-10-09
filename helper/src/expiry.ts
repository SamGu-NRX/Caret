// Everything that lets go of a window's state when the screen model expires it (model.ts ScreenModel.expire): every
// offer family, and each other holder of state read from one window. Helper.onExpiry is the one list. Its type names
// every offer producer (offers/lifetimes.ts), so tsc refuses a list that leaves out a new family, and
// test/model-retention.test.ts checks the names it holds.
import type { OfferProducer } from "./offers/lifetimes.ts";

/** Holders of state read from a window that are not offer families. */
export const WINDOW_STATE_HOLDERS = ["transfers", "lineTable", "ownerVerdicts", "preFocus", "answerOffers", "askQuestions", "goalSegments", "runs", "router"] as const;

export type WindowStateHolder = OfferProducer | (typeof WINDOW_STATE_HOLDERS)[number];

/** How each holder lets go of an expired window; null for one that keeps nothing read from a window. */
export type ExpiryList = Record<WindowStateHolder, ((windowId: string) => void) | null>;

/** Notifies every holder of the expired window in the list's order, each handler once though several families share it. */
export function notifyExpiry(list: ExpiryList, windowId: string): void {
  for (const f of new Set(Object.values(list))) f?.(windowId);
}
