// How long each producer's offer stays offered. When a lifetime ends, the producer sends
// offerWithdrawn `expired`, so the host never shows an offer the helper would refuse. The registry
// (registry.ts) keeps a record exactly until its withdrawal, so these are the only lifetimes.
//
// Every entry is assumed, not measured: no run has timed how long users take to act on each kind of
// offer (B8 brief). `ms` null means no timer; the event in `until` ends the offer instead.

export interface OfferLifetime {
  ms: number | null;
  until: string | null;
}

export const OFFER_LIFETIMES = {
  /**
   * A grounded fill pop-up. "The field changes": frontmost focus lands outside the form's proposed
   * fields; moving among them keeps it, since the host shows it again on the bound field. "The form
   * changes": a destination or the form's field set changes, or a source stops showing its value;
   * that is `stale`, since the offer is then wrong rather than old.
   */
  fill: { ms: null, until: "focus leaves the form's proposed fields, or the form or a source changes" },
  loopNext: { ms: 2 * 60 * 1000, until: null },
  loopFinish: { ms: 5 * 60 * 1000, until: null },
  routine: { ms: 10 * 60 * 1000, until: null },
  /** "Open <app>" for a watched window that finished or needs the user; visiting the window is `taken`. */
  open: { ms: null, until: "the user visits the watched window" },
  /**
   * The offer a first look found, shown on the host's last onboarding screen rather than at a field. It
   * is rechecked when taken, so the timer only keeps an offer nobody took from lingering in the registry.
   */
  firstLook: { ms: 5 * 60 * 1000, until: null },
  /**
   * A planned task (planner/). The user asked for it, so it is shown at once; the timer only keeps an
   * offer nobody took from lingering. It is checked again against the screen when taken.
   */
  plan: { ms: 5 * 60 * 1000, until: null },
} as const satisfies Record<string, OfferLifetime>;

export type OfferProducer = keyof typeof OFFER_LIFETIMES;

/** Whether an offer made at `createdAt` has outlived its timer at `now`. Never true for an offer with no timer. */
export function expired(producer: OfferProducer, createdAt: number, now: number): boolean {
  const ms: number | null = OFFER_LIFETIMES[producer].ms;
  return ms !== null && now - createdAt >= ms;
}
