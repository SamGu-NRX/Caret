// The shadow logger (deep plan section 10). At each field focus it opens an episode; when the
// entry settles or focus moves on, it asks whether the text the user entered (6 or more
// characters) existed, exactly or after normalization, in another readable window during the
// ten minutes before the focus. It persists counts and hashes only and never shows anything.
import { insertedText } from "./normalize.ts";
import type { Change, ScreenModel } from "./model.ts";
import type { AppSwitch, Focus, ValueKind } from "./protocol.ts";
import type { Found, RollingText } from "./rolling-text.ts";
import type { ShadowRow, Store } from "./store.ts";
import { MIN_WHOLE_VALUE } from "./transfers.ts";

interface Episode {
  at: number;
  trigger: ShadowRow["trigger"];
  windowId: string;
  key: string;
  bundleId: string;
  initial: string;
  last: string;
  lastChange: number | null;
}

/** A focus this soon after an app switch is attributed to the switch. Assumed, not measured. */
const SWITCH_ATTRIBUTION_MS = 2000;
/** An entry idle this long is judged even if focus has not moved. Assumed, not measured. */
const IDLE_MS = 10_000;

export class ShadowLogger {
  private episode: Episode | null = null;
  private lastSwitchAt = -Infinity;
  private readonly model: ScreenModel;
  private readonly text: RollingText;
  private readonly store: Store;

  constructor(model: ScreenModel, text: RollingText, store: Store) {
    this.model = model;
    this.text = text;
    this.store = store;
  }

  onAppSwitch(m: AppSwitch): void {
    this.close();
    this.lastSwitchAt = m.at;
    this.store.count("shadow.app_switch", 1, m.at);
  }

  onFocus(m: Focus): void {
    this.close();
    this.store.count("shadow.focus", 1, m.at);
    if (!m.editable || m.key === null) return;
    this.store.count("shadow.field_focus", 1, m.at);
    const node = this.model.windows.get(m.windowId)?.nodes.get(m.key);
    const initial = node?.value ?? "";
    this.episode = {
      at: m.at,
      trigger: m.at - this.lastSwitchAt <= SWITCH_ATTRIBUTION_MS ? "appSwitch" : "focus",
      windowId: m.windowId,
      key: m.key,
      bundleId: m.app.bundleId,
      initial,
      last: initial,
      lastChange: null,
    };
  }

  onChanges(changes: readonly Change[]): void {
    const ep = this.episode;
    if (ep === null) return;
    for (const c of changes) {
      if (c.kind === "windowClosed" && c.windowId === ep.windowId) {
        this.close();
        return;
      }
      if (c.kind === "value" && c.windowId === ep.windowId && c.key === ep.key) {
        ep.last = c.after ?? "";
        ep.lastChange = c.at;
      }
    }
  }

  tick(now: number): void {
    const ep = this.episode;
    if (ep !== null && ep.lastChange !== null && now - ep.lastChange >= IDLE_MS) {
      this.close();
      // Keep watching the same field: further typing starts a new episode from where this one ended.
      this.episode = { ...ep, at: now, initial: ep.last, lastChange: null };
    }
  }

  /** Judges and closes the open episode. */
  close(): void {
    const ep = this.episode;
    this.episode = null;
    if (ep === null || ep.lastChange === null) return;
    const entered = insertedText(ep.initial, ep.last).trim();
    if (entered.length === 0) return;
    if (entered.length < MIN_WHOLE_VALUE) {
      this.store.count("shadow.entry_short", 1, ep.lastChange);
      return;
    }
    this.store.count("shadow.entry", 1, ep.lastChange);

    const { found, kind } = this.lookup(ep, entered);
    this.store.count(found === null ? "shadow.entry_not_found" : `shadow.opportunity_${found.match}`, 1, ep.lastChange);
    this.store.addShadow({
      at: ep.at,
      trigger: ep.trigger,
      dstBundle: ep.bundleId,
      dstKeyHash: this.store.hash(ep.key),
      enteredLength: entered.length,
      enteredHash: this.store.hash(entered),
      existed: found === null ? "no" : found.match,
      srcBundle: found?.obs.bundleId ?? null,
      srcKeyHash: found === null ? null : this.store.hash(found.obs.nodeKey),
      srcAgeMs: found === null ? null : Math.max(0, ep.at - found.obs.firstSeen),
      kind,
    });
  }

  /** The whole entry first, then any typed value of 6+ characters inside it. Sources must predate the focus. */
  private lookup(ep: Episode, entered: string): { found: Found | null; kind: ValueKind | null } {
    const values = this.model.windows.get(ep.windowId)?.values.filter((v) => v.nodeKey === ep.key) ?? [];
    const wholeKind = values.find((v) => v.text === entered)?.kind ?? null;
    const opts = { excludeWindowId: ep.windowId, seenBy: ep.at };
    const whole = this.text.find(entered, wholeKind, opts);
    if (whole !== null) return { found: whole, kind: wholeKind };
    for (const v of values) {
      if (v.text.length < MIN_WHOLE_VALUE || !entered.includes(v.text)) continue;
      const part = this.text.find(v.text, v.kind, opts);
      if (part !== null) return { found: part, kind: v.kind };
    }
    return { found: null, kind: wholeKind };
  }
}
