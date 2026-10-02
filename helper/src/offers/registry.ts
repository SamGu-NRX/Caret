// The host-offer registry: every alternatives, action and popup message the helper published, kept so
// an offerAccept can be checked against what the host was shown and routed to the code that made the
// offer. A record goes when its offer is withdrawn or after OFFER_KEEP_MS.
import type { OfferAccept, OfferAction, OfferAlternatives, OfferField, OfferPopup } from "../protocol.ts";
import type { TaskResult } from "../executor/executor.ts";
import { applyingReveal, specActions, specChoices, type PopupAction, type PopupBlock, type PopupSpecT } from "../popup.ts";

export type HostOffer = OfferAlternatives | OfferAction | OfferPopup;

/** What taking an offer did: the run's result, or why the producer would not run it. */
export type AcceptResult = TaskResult | { refused: string };
/** Runs an accepted offer as a task whose id is the offerKey. Called at most once per record. */
export type AcceptHandler = (m: OfferAccept) => Promise<AcceptResult>;

export interface OfferRecord {
  offerKey: string;
  kind: HostOffer["type"];
  field: OfferField;
  message: HostOffer;
  createdAt: number;
  /** Null for alternatives, which the host inserts itself. */
  accept: AcceptHandler | null;
  accepted: boolean;
}

/** How long an offer can be accepted after it was published. Assumed, not measured. */
export const OFFER_KEEP_MS = 10 * 60 * 1000;

export class HostOfferRegistry {
  private readonly records = new Map<string, OfferRecord>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Records a published offer. A new offer under a key already in use replaces the old record. */
  record(message: HostOffer, accept: AcceptHandler | null): OfferRecord {
    const r: OfferRecord = { offerKey: message.offerKey, kind: message.type, field: message.field, message, createdAt: this.now(), accept, accepted: false };
    this.records.set(r.offerKey, r);
    return r;
  }

  /** The live record for a key; an expired one is dropped and reads as unknown. */
  get(offerKey: string): OfferRecord | undefined {
    const r = this.records.get(offerKey);
    if (r !== undefined && this.now() - r.createdAt > OFFER_KEEP_MS) {
      this.records.delete(offerKey);
      return undefined;
    }
    return r;
  }

  /** Every key recorded, expired or not. */
  keys(): string[] {
    return [...this.records.keys()];
  }

  remove(offerKey: string): void {
    this.records.delete(offerKey);
  }

  get size(): number {
    return this.records.size;
  }

  prune(): void {
    const now = this.now();
    for (const [k, r] of this.records) if (now - r.createdAt > OFFER_KEEP_MS) this.records.delete(k);
  }
}

/** Specs a chain of reveals can lead to. Each reveal removes an action, so chains end; the cap only guards a malformed cycle. */
const MAX_REACHABLE = 32;

/** The spec and every spec a chain of reveals leads to, each once: what the host can show the user. */
export function reachableSpecs(spec: PopupSpecT): PopupSpecT[] {
  const out = [spec];
  const seen = new Set([JSON.stringify(spec)]);
  for (let i = 0; i < out.length && out.length < MAX_REACHABLE; i++) {
    const s = out[i] as PopupSpecT;
    for (const a of specActions(s)) {
      if (a.reveal === undefined) continue;
      const r = applyingReveal(s, a.id);
      const k = JSON.stringify(r);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(r);
      }
    }
  }
  return out;
}

/**
 * Why `m` cannot finish the offer as the host showed it in this state, or null. The action must be in
 * the state's bar and not a reveal; the override, if any, must name the state's choices block (by id,
 * `choices` when it has none, `variants` for an action line's picker) and a row it has.
 */
interface Refusal {
  /** How close the accept came in this state: 0 a row out of range, 1 no such picker, 2 a reveal, 3 no such action. */
  rank: number;
  why: string;
}

function stateRefusal(actions: readonly PopupAction[], choices: Extract<PopupBlock, { type: "choices" }> | undefined, choicesKey: string | null, m: OfferAccept): Refusal | null {
  const action = actions.find((a) => a.id === m.actionId);
  if (action === undefined) return { rank: 3, why: `the offer has no action ${m.actionId}` };
  if (action.reveal !== undefined) return { rank: 2, why: `action ${m.actionId} changes the pop-up; it does not finish it` };
  for (const [key, row] of Object.entries(m.overrides)) {
    if (choices === undefined || key !== choicesKey) return { rank: 1, why: key === "variants" ? "the offer has no variants to pick from" : `the offer has no choices block ${key}` };
    if (row >= choices.rows.length) return { rank: 0, why: `${key} row ${row} does not exist; there are ${choices.rows.length}` };
  }
  return null;
}

/**
 * Why an offerAccept cannot finish this offer, or null when it can. The host sends the action and the
 * highlighted row of the pop-up as it was drawn: after any reveal, and for an action line, its own bar
 * or the variants picker it opened. The accept must fit one of those states. Does not check expiry,
 * mode or a previous accept.
 */
export function acceptRefusal(r: OfferRecord, m: OfferAccept): string | null {
  const msg = r.message;
  if (msg.type === "alternatives") return "the host inserts alternatives itself; there is nothing to accept";
  const states: { actions: readonly PopupAction[]; choices: Extract<PopupBlock, { type: "choices" }> | undefined; key: string | null }[] = [];
  if (msg.type === "popup") {
    for (const s of reachableSpecs(msg.spec)) {
      const c = specChoices(s);
      states.push({ actions: specActions(s), choices: c, key: c === undefined ? null : (c.id ?? "choices") });
    }
  } else {
    // The closed line: its own bar, with a row only of the variants picker when it has one.
    const variants = msg.variants === undefined ? [] : reachableSpecs(msg.variants);
    states.push({ actions: msg.actions, choices: variants.map(specChoices).find((c) => c !== undefined), key: "variants" });
    // The line opened into its variants: the picker's own bar and rows.
    for (const s of variants) states.push({ actions: specActions(s), choices: specChoices(s), key: "variants" });
  }
  // Refused in every state: the reason from the state that came closest, and of equals the last, the
  // furthest the user can have gone into the pop-up.
  let best: Refusal | null = null;
  for (const s of states) {
    const r = stateRefusal(s.actions, s.choices, s.key, m);
    if (r === null) return null;
    if (best === null || r.rank <= best.rank) best = r;
  }
  return best?.why ?? "the offer has nothing to accept";
}
