// The user's settings as the helper's gate reads them: which producer families may make offers, how
// many offers an hour, and whether Caret is paused. The host sends them as a `settings` message
// (protocol.ts); until one arrives the helper uses the host's own defaults (DEFAULT_SETTINGS). Every
// producer asks `OfferGate.holds` before it starts work that ends in an offer, and calls `spoke` when an
// offer is shown; the helper withdraws shown offers when a change disallows them.
import type { Settings, SettingsLevel, SettingsRole } from "../protocol.ts";

/** The helper's producer families, named as the host's firstLook request and GatePolicy name them. */
export const FAMILIES = ["fill", "pending", "loop", "routine"] as const;
export type Family = (typeof FAMILIES)[number];

/** The families each role switches. `words` is the host's ghost text, which the helper does not make. */
export const ROLE_FAMILIES: Record<SettingsRole, readonly Family[]> = {
  fill: ["fill"],
  repeat: ["loop", "routine"],
  watch: ["pending"],
  words: [],
};

export interface LevelRules {
  /** Offers of every family together that may be shown in a rolling hour. Ghost text is the host's and not counted. */
  offersPerHour: number;
  /** Families the level lets speak at all. */
  families: Record<Family, boolean>;
  /** Silent predictions of a routine that must have matched before it is offered; null where routines are off. */
  routineSightings: number | null;
}

/**
 * One table for every level. All of it is assumed, not measured; the B10 brief set these numbers and the
 * host's GatePolicy (CaretSettings.swift on v2/host) uses the same ones, following the Fable plan's day-one
 * budget of at most four offers an hour besides ghost text. Quiet is a quarter of that and offers only
 * what is grounded on screen now (fill and pending); Eager doubles it and offers a routine one sighting
 * sooner. A loop needs its two rounds at every level where it is on, which is the loop recognizer's own
 * rule, so the table has no number for it.
 */
export const LEVELS: Record<SettingsLevel, LevelRules> = {
  quiet: { offersPerHour: 1, families: { fill: true, pending: true, loop: false, routine: false }, routineSightings: null },
  balanced: { offersPerHour: 4, families: { fill: true, pending: true, loop: true, routine: true }, routineSightings: 3 },
  eager: { offersPerHour: 8, families: { fill: true, pending: true, loop: true, routine: true }, routineSightings: 2 },
};

/** The host's defaults (CaretSettings() on v2/host): every role, Balanced, not paused. */
export const DEFAULT_SETTINGS: UserSettings = { roles: ["fill", "repeat", "watch", "words"], level: "balanced", paused: false };

export type UserSettings = Pick<Settings, "roles" | "level" | "paused">;

/** Why the settings hold an offer, in the order checked. */
export type SettingsHold = "caretPaused" | "roleOff" | "levelOff" | "hourlyBudget";

const HOUR_MS = 60 * 60 * 1000;

/** Where the gate keeps the times of shown offers across helper restarts: the Store's offer_budget table. */
export interface BudgetLog {
  /** Every time kept, oldest first. */
  load(): number[];
  record(at: number): void;
}

export class OfferGate {
  private current: UserSettings;
  /** When each offer counted against the budget was shown, oldest first; loaded from the log, so a restart keeps them. */
  private readonly spokenAt: number[] = [];
  private readonly log: BudgetLog | null;

  constructor(initial: UserSettings = DEFAULT_SETTINGS, log: BudgetLog | null = null) {
    this.current = { roles: [...initial.roles], level: initial.level, paused: initial.paused };
    this.log = log;
    if (log !== null) this.spokenAt.push(...log.load().toSorted((a, b) => a - b));
  }

  get settings(): UserSettings {
    return this.current;
  }

  get rules(): LevelRules {
    return LEVELS[this.current.level];
  }

  /**
   * Applies a settings message. Returns the families that were allowed before and are not now, so the
   * caller can withdraw what they show; all of them when Caret was just paused.
   */
  apply(next: UserSettings): Family[] {
    const before = FAMILIES.filter((f) => this.enabled(f));
    this.current = { roles: [...next.roles], level: next.level, paused: next.paused };
    return before.filter((f) => !this.enabled(f));
  }

  /** The family may make offers now, budget aside. */
  enabled(family: Family): boolean {
    return this.offHolds(family).length === 0;
  }

  /** Every settings rule that holds an offer of this family at `now`, in the order checked; empty when it may speak. */
  holds(family: Family, now: number): SettingsHold[] {
    const out = this.offHolds(family);
    if (this.spokenLastHour(now) >= this.rules.offersPerHour) out.push("hourlyBudget");
    return out;
  }

  /** An offer was shown at `at`; it counts against the budget for an hour. */
  spoke(at: number): void {
    this.spokenAt.push(at);
    this.log?.record(at);
  }

  spokenLastHour(now: number): number {
    while ((this.spokenAt[0] ?? Number.POSITIVE_INFINITY) <= now - HOUR_MS) this.spokenAt.shift();
    return this.spokenAt.filter((t) => t > now - HOUR_MS).length;
  }

  private offHolds(family: Family): SettingsHold[] {
    const out: SettingsHold[] = [];
    if (this.current.paused) out.push("caretPaused");
    if (!this.current.roles.some((r) => ROLE_FAMILIES[r].includes(family))) out.push("roleOff");
    if (!this.rules.families[family]) out.push("levelOff");
    return out;
  }
}
