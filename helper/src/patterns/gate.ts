// The speak-now gate for pattern offers (plan section 4, "How Caret knows, in the moment, that an
// offer is right"). Rules first: every rule is checked, an offer speaks only when none holds it, and
// every decision goes to the decision log with its show probability. A routine held as "unproven"
// is a silent prediction: recorded, scored when its bundle closes, never shown.
//
// The show probability is the Laplace-smoothed share of the pattern's past predictions that matched
// what the user did: (hits + 1) / (hits + misses + 2). It is logged so a later batch can calibrate
// it against takes; nothing has calibrated it yet, and no rule reads it.
import type { OfferKind, PermissionRule } from "../protocol.ts";
import { routineProven } from "./memory.ts";

/** Spoken offers per rolling hour. Assumed, not measured. */
export const HOURLY_BUDGET = 20;
/** An offer kind dismissed or ignored this many times in one app today is held until tomorrow (plan section 3, assumed). */
export const IGNORED_LIMIT = 2;

export type HoldReason =
  | "shadowMode"
  | "paused"
  | "permissionHandoff"
  | "dontOfferHere"
  | "ignoredToday"
  | "hourlyBudget"
  | "unproven"
  | "ungrounded"
  /** Another routine already spoke for this window. Added by the engine, not by decide(). */
  | "outranked";

export interface GateInput {
  offerKind: OfferKind;
  /**
   * Past predictions of this pattern that matched what the user did, and those that did not. For a
   * loop, round two matching round one is one hit, and a confirmed round is another.
   */
  hits: number;
  misses: number;
  /** The pattern or its memory entry is paused. */
  paused: boolean;
  /** Every value the offer would write was read from a live source just now. */
  grounded: boolean;
}

export interface GateContext {
  /** The helper logs decisions in shadow mode but shows nothing. */
  shadow: boolean;
  permission: PermissionRule;
  dontOfferHere: boolean;
  ignoredToday: number;
  spokenLastHour: number;
}

export interface Decision {
  speak: boolean;
  /** Every rule that held the offer, in the order checked. Empty when it speaks. */
  reasons: HoldReason[];
  showProbability: number;
}

export function decide(i: GateInput, c: GateContext): Decision {
  const reasons: HoldReason[] = [];
  if (c.shadow) reasons.push("shadowMode");
  if (i.paused) reasons.push("paused");
  if (c.permission === "handoff") reasons.push("permissionHandoff");
  if (c.dontOfferHere) reasons.push("dontOfferHere");
  if (c.ignoredToday >= IGNORED_LIMIT) reasons.push("ignoredToday");
  if (c.spokenLastHour >= HOURLY_BUDGET) reasons.push("hourlyBudget");
  if (!proven(i)) reasons.push("unproven");
  if (!i.grounded) reasons.push("ungrounded");
  return { speak: reasons.length === 0, reasons, showProbability: (i.hits + 1) / (i.hits + i.misses + 2) };
}

/**
 * A loop prediction is visible before it is applied, so the matching second round is proof enough
 * (Flash Fill's one-or-two-examples finding). "Finish the rest" needs the predicted round confirmed.
 * A routine acts on windows the user has not looked at yet, so it needs ROUTINE_MIN_HITS silent hits.
 */
function proven(i: GateInput): boolean {
  switch (i.offerKind) {
    case "loopNext":
      return i.hits >= 1;
    case "loopFinish":
      return i.hits >= 2;
    case "routine":
      return routineProven(i.hits, i.misses);
  }
}
