// Consent the user already gave, as the helper itself recorded it (R2 lead decision 2). An offer the user consented to
// passes the routers with no Jev question: it is a legal act route whose reason code wrote, and it still needs Tab.
// Routing grants no autonomy here or anywhere else.
//
// This is a consent boundary. Producers' candidates carry nothing the router reads as consent: no claim, flag or
// wording of theirs counts, and nothing on screen does. One helper function (Helper.consentedCandidates) builds each
// consented candidate around a held offer and asks ConsentLedger for that offer's own record (its routine, its watch),
// so the candidate's `run` shows exactly the offer the record is about. The records, all written by the helper when
// the user acted, through a host session where a message carries the act:
//
//   skill  the user answered Keep to "Keep this as a skill?" (patterns/skills.ts answer -> MemoryStore.addSkill), the
//          skill is not paused or forgotten, and its routine is marked kept. The server takes skillAnswer, and a
//          skill's resume, only from the host.
//   watch  the helper's own pending watch (tasks/pending.ts) resolved by what the screen showed (task state done or
//          needsYou, cause screen; a watch the user stopped does not count), and the user's watch role came in a
//          settings message from a host session. Watches start on their own when the user leaves a window with work
//          under way, so the watch role is the user's whole consent to them; the helper's defaults and a non-host
//          consumer's settings are not.
//
// The user's explicit requests (Ask, fillRequest, Command-1 Fill all, Tab on a visible offer) never reach the
// coordinator: their handlers act on the request itself, so they pass by construction and need no record here.
// Learned loop offers have no record to name: they always go to Router 1.
import type { TaskRecord } from "../protocol.ts";
import type { MemoryStore } from "../patterns/memory.ts";

/** The record a consented offer rests on: its routine, or its watch. Built only by Helper.consentedCandidates. */
export type ConsentClaim = { kind: "skill"; routineId: string } | { kind: "watch"; watchId: string };

/** A claim the ledger found a record for, with the reason the decision log carries. */
export interface Consent {
  kind: ConsentClaim["kind"];
  reason: string;
}

export interface ConsentRecords {
  memory: Pick<MemoryStore, "skillFor" | "routine">;
  task: (id: string) => Pick<TaskRecord, "kind" | "state" | "cause"> | undefined;
}

export const CONSENT_REASONS = {
  skill: "you kept this as a skill",
  watch: "you have Caret watch unfinished work, and this watch resolved",
} as const satisfies Record<ConsentClaim["kind"], string>;

export class ConsentLedger {
  private readonly records: ConsentRecords;
  /** The watch role as a host session last sent it; null until a host sends settings. */
  private hostWatchRole: boolean | null = null;

  constructor(records: ConsentRecords) {
    this.records = records;
  }

  /**
   * A settings message arrived. Only one from a host session records the watch role. One from any other session
   * still rules the gate (it may lift the host's pause, so watches ask again), so no watch passes on consent until a
   * host sends settings again.
   */
  settings(roles: readonly string[], fromHost: boolean): void {
    this.hostWatchRole = fromHost ? roles.includes("watch") : null;
  }

  /** The record behind `claim`, or null when there is none. Never throws on a malformed claim: it is not consent. */
  verify(claim: ConsentClaim | undefined): Consent | null {
    if (claim === undefined || typeof claim !== "object" || claim === null) return null;
    switch (claim.kind) {
      case "skill": {
        if (typeof claim.routineId !== "string") return null;
        const skill = this.records.memory.skillFor(claim.routineId);
        if (skill === null || skill.paused) return null;
        if (this.records.memory.routine(claim.routineId)?.keep !== "kept") return null;
        return { kind: "skill", reason: CONSENT_REASONS.skill };
      }
      case "watch": {
        if (typeof claim.watchId !== "string" || this.hostWatchRole !== true) return null;
        const t = this.records.task(claim.watchId);
        if (t === undefined || t.kind !== "watch" || t.cause !== "screen" || (t.state !== "done" && t.state !== "needsYou")) return null;
        return { kind: "watch", reason: CONSENT_REASONS.watch };
      }
      default:
        return null;
    }
  }
}
