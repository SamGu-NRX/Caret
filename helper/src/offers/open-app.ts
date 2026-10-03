// "Open <app>": when a pending-state watch sees its window finish, or start waiting on the user, the
// host is offered an action line in the field the user is in now, and Tab brings the watched window to
// the front through the executor. The line quotes the window's status line from the node that shows
// it; with no status line, or none on screen, nothing is offered. It has no timer (OFFER_LIFETIMES.open):
// it lasts until the user visits the window, the window closes, or the watch resolves again.
import { PROTOCOL_VERSION, type Focus, type HelperMessage, type OfferAction, type OfferField, type OfferWithdrawn } from "../protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import type { TaskResult } from "../executor/executor.ts";
import type { Plan } from "../executor/schema.ts";
import type { AcceptHandler, AcceptResult } from "./registry.ts";
import { offerField } from "./field.ts";

interface Entry {
  offerKey: string;
  watchId: string;
  windowId: string;
  status: string;
  /** The field the offer is shown in; null while it waits for one. */
  boundTo: OfferField | null;
}

export interface OpenAppDeps {
  model: ScreenModel;
  /** The helper's publish gate; false when it refused the message. */
  publish: (m: HelperMessage, accept?: AcceptHandler) => boolean;
  run: (taskId: string, plan: Plan, slots: Record<string, string>) => Promise<TaskResult>;
  now?: () => number;
}

/** The first node, in document order, whose visible text contains the status line; editable and secure fields are not the window's status. */
export function statusNode(w: WindowState, status: string): string | null {
  for (const n of w.nodes.values()) {
    if (n.editable === true || n.states?.includes("secure")) continue;
    if (nodeText(n).includes(status)) return n.key;
  }
  return null;
}

export class OpenAppOffers {
  private readonly entries = new Map<string, Entry>();
  /** The latest editable field the user focused in the app they are in, to bind an offer held again after its field's window closed. */
  private lastField: OfferField | null = null;
  /** Numbers each offer of a watch: a watch can resolve twice (needsYou, then done), and each offer runs as its own task. */
  private seq = 0;
  private readonly deps: OpenAppDeps;
  private readonly now: () => number;

  constructor(deps: OpenAppDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Offers for watches, held or shown, by offerKey. For tests. */
  pending(): { offerKey: string; published: boolean }[] {
    return [...this.entries.values()].map((e) => ({ offerKey: e.offerKey, published: e.boundTo !== null }));
  }

  /** A watch ended as done or became needsYou. A newer resolution of the same watch replaces an older offer. */
  resolved(e: { watchId: string; windowId: string; status: string | null }): void {
    for (const old of [...this.entries.values()]) if (old.watchId === e.watchId) this.drop(old.offerKey, "stale");
    const offerKey = `open-${e.watchId}.${++this.seq}`;
    if (e.status === null) return;
    const w = this.deps.model.windows.get(e.windowId);
    if (w === undefined || statusNode(w, e.status) === null) return;
    const entry: Entry = { offerKey, watchId: e.watchId, windowId: e.windowId, status: e.status, boundTo: null };
    this.entries.set(offerKey, entry);
    const field = this.fieldNow(e.windowId);
    if (field !== null) this.show(entry, field);
  }

  /**
   * A focus event. Focus in the watched window, in the frontmost app, means the user went there on
   * their own: the offer is dropped, or withdrawn as taken. Focus in an editable field of another
   * window, in the frontmost app, binds a held offer to that field.
   */
  onFocus(m: Focus): void {
    const focused = this.deps.model.windows.get(m.windowId);
    if (m.frontmost && m.editable && m.key !== null && focused !== undefined) this.lastField = offerField(focused, m.key);
    for (const e of [...this.entries.values()]) {
      if (m.windowId === e.windowId) {
        if (m.frontmost) this.drop(e.offerKey, "taken");
      }
      else if (e.boundTo === null && m.frontmost && m.editable && m.key !== null && focused !== undefined) this.show(e, offerField(focused, m.key));
    }
  }

  /** The model's focused window changed to this one, in the app the user is in. */
  onFocusedWindow(windowId: string): void {
    for (const e of [...this.entries.values()]) if (e.windowId === windowId) this.drop(e.offerKey, "taken");
  }

  /**
   * The watched window closing ends its offer. The window of the field an offer is shown in closing
   * withdraws that showing: the offer is held again, under a new key, for the next field the user lands in.
   */
  onWindowClosed(windowId: string): void {
    for (const e of [...this.entries.values()]) {
      if (e.windowId === windowId) this.drop(e.offerKey, "stale");
      else if (e.boundTo?.windowId === windowId) {
        this.drop(e.offerKey, "stale");
        const held: Entry = { ...e, offerKey: `open-${e.watchId}.${++this.seq}`, boundTo: null };
        this.entries.set(held.offerKey, held);
        // The user may already be in another field: its focus came while the offer was still bound here.
        const f = this.currentLastField(windowId, e.windowId);
        if (f !== null) this.show(held, f);
      }
    }
    if (this.lastField?.windowId === windowId) this.lastField = null;
  }

  /** Window ids start over with a new reader, so every offer names a window that no longer exists. */
  /**
   * The last focused field, if it is still there, editable and in the frontmost app, and in neither the
   * closing window nor the watched one, with its frame read now.
   */
  private currentLastField(closing: string, watched: string): OfferField | null {
    const f = this.lastField;
    if (f === null || f.windowId === closing || f.windowId === watched || this.deps.model.frontmostPid !== f.pid) return null;
    const w = this.deps.model.windows.get(f.windowId);
    return w?.nodes.get(f.key)?.editable === true ? offerField(w, f.key) : null;
  }

  readerRestarted(): void {
    this.lastField = null;
    for (const e of [...this.entries.values()]) this.drop(e.offerKey, "stale");
  }

  /** The focused editable field of the model's focused window, unless that window is the watched one. */
  private fieldNow(watched: string): OfferField | null {
    const id = this.deps.model.focusedWindowId;
    if (id === null || id === watched) return null;
    const w = this.deps.model.windows.get(id);
    const key = w?.focusedKey ?? null;
    if (w === undefined || key === null || w.nodes.get(key)?.editable !== true) return null;
    return offerField(w, key);
  }

  /** Publishes the offer bound to `field`, after checking that the status line is still on screen. */
  private show(e: Entry, field: OfferField): void {
    const w = this.deps.model.windows.get(e.windowId);
    const node = w === undefined ? null : statusNode(w, e.status);
    if (w === undefined || node === null) {
      this.entries.delete(e.offerKey);
      return;
    }
    const msg: OfferAction = {
      type: "action",
      v: PROTOCOL_VERSION,
      offerKey: e.offerKey,
      at: this.now(),
      field,
      app: w.app.name,
      endState: { text: e.status, ref: { node: `${e.windowId}/${node}`, quote: e.status } },
      actions: [{ id: "open", label: `Open ${w.app.name}`, key: "tab" }],
    };
    if (this.deps.publish(msg, () => this.accept(e.offerKey))) e.boundTo = field;
    else this.entries.delete(e.offerKey);
  }

  private drop(offerKey: string, reason: OfferWithdrawn["reason"]): void {
    const e = this.entries.get(offerKey);
    if (e === undefined) return;
    this.entries.delete(offerKey);
    if (e.boundTo !== null) this.deps.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.now(), id: offerKey, reason });
  }

  /** Raises the watched window as the task `offerKey`. The window's title and app name are slots, read now. */
  private async accept(offerKey: string): Promise<AcceptResult> {
    const e = this.entries.get(offerKey);
    if (e === undefined) return { refused: "the offer was withdrawn" };
    const w = this.deps.model.windows.get(e.windowId);
    if (w === undefined) {
      this.drop(offerKey, "stale");
      return { refused: "the window closed" };
    }
    this.drop(offerKey, "taken");
    const plan: Plan = {
      id: offerKey,
      title: `Open ${w.app.name}`,
      slots: { title: "the watched window's title", app: "the watched window's app" },
      steps: [{ says: "'{{title}}' in {{app}} is in front", end: { kind: "windowFocused", window: { bundleId: w.app.bundleId, title: "{{title}}" } } }],
    };
    try {
      return await this.deps.run(offerKey, plan, { title: w.window.title, app: w.app.name });
    } catch (err) {
      return { refused: err instanceof Error ? err.message : String(err) };
    }
  }
}
