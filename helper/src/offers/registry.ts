// The host-offer registry: every alternatives, action and popup message the helper published, kept so
// an offerAccept can be checked against what the host was shown and routed to the code that made the
// offer. A record goes when its offer is withdrawn or after OFFER_KEEP_MS.
import type { OfferAccept, OfferAction, OfferAlternatives, OfferField, OfferPopup } from "../protocol.ts";
import type { TaskResult } from "../executor/executor.ts";
import { specActions, specChoices, type PopupBlock, type PopupSpecT } from "../popup.ts";

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

/** Every choices block the user can reach in a spec, top-level or behind a reveal, by its override key. */
export function reachableChoices(spec: PopupSpecT): Map<string, Extract<PopupBlock, { type: "choices" }>> {
  const out = new Map<string, Extract<PopupBlock, { type: "choices" }>>();
  const add = (b: PopupBlock): void => {
    if (b.type === "choices" && !out.has(b.id ?? "choices")) out.set(b.id ?? "choices", b);
  };
  for (const b of spec.blocks) {
    add(b);
    if (b.type === "actions") for (const a of b.items) if (a.reveal !== undefined) add(a.reveal.with);
  }
  return out;
}

/**
 * Why an offerAccept cannot finish this offer, or null when it can. Checks what the host could have
 * sent from what it was shown: the action exists and finishes the offer, and each override names a
 * picker the offer has and a row inside it. Does not check expiry, mode or a previous accept.
 */
export function acceptRefusal(r: OfferRecord, m: OfferAccept): string | null {
  const msg = r.message;
  if (msg.type === "alternatives") return "the host inserts alternatives itself; there is nothing to accept";
  const actions = msg.type === "action" ? msg.actions : specActions(msg.spec);
  const action = actions.find((a) => a.id === m.actionId);
  if (action === undefined) return `the offer has no action ${m.actionId}`;
  if (action.reveal !== undefined) return `action ${m.actionId} changes the pop-up; it does not finish it`;
  const choices = msg.type === "popup" ? reachableChoices(msg.spec) : new Map<string, Extract<PopupBlock, { type: "choices" }>>();
  for (const [key, row] of Object.entries(m.overrides)) {
    if (key === "variants") {
      if (msg.type !== "action" || msg.variants === undefined) return "the offer has no variants to pick from";
      const rows = specChoices(msg.variants)?.rows.length ?? 0;
      if (row >= rows) return `variants row ${row} does not exist; there are ${rows}`;
      continue;
    }
    const block = choices.get(key);
    if (block === undefined) return `the offer has no choices block ${key}`;
    if (row >= block.rows.length) return `${key} row ${row} does not exist; there are ${block.rows.length}`;
  }
  return null;
}
