// Transfer detection. A transfer is a value seen in one window that then appears in an
// editable element of another. Each edited field is judged once its value has settled,
// so a value typed one character at a time is matched whole, not at every prefix.
import { EditSpan, type MatchKind } from "./normalize.ts";
import type { Change, ScreenModel } from "./model.ts";
import type { TypedValue, ValueKind } from "./protocol.ts";
import type { Observation, RollingText } from "./rolling-text.ts";

export interface Transfer {
  at: number;
  /** Plain text. Held in memory only; the store receives its hash. */
  value: string;
  kind: ValueKind | null;
  match: MatchKind;
  src: Observation;
  dst: { windowId: string; bundleId: string; windowKind: string; key: string };
  ageMs: number;
  /** `caret` when the host reported inserting this value for Caret (fillResult). */
  attribution: "user" | "unknown" | "caret";
  /** The store's row for this transfer, once recorded. */
  rowId?: number;
}

interface PendingEdit {
  windowId: string;
  key: string;
  span: EditSpan;
  firstChange: number;
  lastChange: number;
  focused: boolean;
  /** The field's typed values as of its last non-empty value, so an edit judged after a clear still has them. */
  values: TypedValue[];
}

/** A value shorter than this is too likely to occur by chance in another window. */
export const MIN_WHOLE_VALUE = 6;
const MIN_TYPED_VALUE = 4;
const MAX_VALUE = 300;
/** How long a field must stay unchanged before it is judged. An assumption, not a measurement. */
export const SETTLE_MS = 1500;

export class TransferDetector {
  private readonly pending = new Map<string, PendingEdit>();
  private readonly model: ScreenModel;
  private readonly text: RollingText;
  private readonly settleMs: number;

  constructor(model: ScreenModel, text: RollingText, settleMs = SETTLE_MS) {
    this.model = model;
    this.text = text;
    this.settleMs = settleMs;
  }

  /**
   * Applies field edits. Returns the edits judged at once: a field that empties after holding entered
   * text, as a chat composer does on send. Judged after the settle time, such an edit would hold
   * nothing, and a message sent within SETTLE_MS of its last keystroke would never be a transfer, so
   * it is judged on the value just before the clear. Clearing a field by hand is judged the same way.
   */
  onChanges(changes: readonly Change[]): Transfer[] {
    const out: Transfer[] = [];
    for (const c of changes) {
      if (c.kind !== "value" || !c.editable || c.key === null) continue;
      const id = `${c.windowId}\u0000${c.key}`;
      const p = this.pending.get(id);
      const w = this.model.windows.get(c.windowId);
      const focused = w?.focused === true;
      const after = c.after ?? "";
      if (after.trim() === "") {
        // An empty field holds nothing entered; a clear with no open edit needs no judgment.
        if (p !== undefined && p.span.last.trim() !== "") {
          this.pending.delete(id);
          p.focused ||= focused;
          out.push(...this.judge(p));
        } else if (p !== undefined) p.span.observe(after);
        continue;
      }
      const values = w?.values.filter((v) => v.nodeKey === c.key) ?? [];
      if (p === undefined) {
        const span = new EditSpan(c.before ?? "");
        span.observe(after);
        this.pending.set(id, { windowId: c.windowId, key: c.key, span, firstChange: c.at, lastChange: c.at, focused, values });
      } else {
        p.span.observe(after);
        p.lastChange = c.at;
        p.focused ||= focused;
        p.values = values;
      }
    }
    return out;
  }

  /** Judges every edit that has been still for the settle time. */
  tick(now: number): Transfer[] {
    const out: Transfer[] = [];
    for (const [id, p] of this.pending) {
      if (now - p.lastChange < this.settleMs) continue;
      this.pending.delete(id);
      out.push(...this.judge(p));
    }
    return out;
  }

  /** Judges pending edits now, for a window being left or closed, or for all windows at shutdown. */
  flush(windowId?: string): Transfer[] {
    const out: Transfer[] = [];
    for (const [id, p] of this.pending) {
      if (windowId !== undefined && p.windowId !== windowId) continue;
      this.pending.delete(id);
      out.push(...this.judge(p));
    }
    return out;
  }

  private judge(p: PendingEdit): Transfer[] {
    const w = this.model.windows.get(p.windowId);
    if (w === undefined) return [];
    const inserted = p.span.entered().trim();
    if (inserted.length === 0) return [];

    const candidates: { value: string; kind: ValueKind | null }[] = [];
    if (inserted.length >= MIN_WHOLE_VALUE && inserted.length <= MAX_VALUE) candidates.push({ value: inserted, kind: null });
    for (const v of p.values) {
      if (v.text.length < MIN_TYPED_VALUE || p.span.initial.includes(v.text)) continue;
      if (!inserted.includes(v.text) && !v.text.includes(inserted)) continue;
      if (v.text === inserted) {
        const whole = candidates[0];
        // A typed value shorter than a whole entry may be (a time, a short amount) still counts.
        if (whole !== undefined && whole.value === inserted) whole.kind = v.kind;
        else candidates.unshift({ value: v.text, kind: v.kind });
        continue;
      }
      candidates.push({ value: v.text, kind: v.kind });
    }

    const out: Transfer[] = [];
    for (const c of candidates) {
      const found = this.text.find(c.value, c.kind, { excludeWindowId: p.windowId, seenBy: p.lastChange });
      if (found === null) continue;
      out.push({
        at: p.lastChange,
        value: c.value,
        kind: c.kind ?? found.obs.kind,
        match: found.match,
        src: found.obs,
        dst: { windowId: p.windowId, bundleId: w.app.bundleId, windowKind: w.window.kind, key: p.key },
        ageMs: Math.max(0, p.lastChange - found.obs.firstSeen),
        attribution: p.focused ? "user" : "unknown",
      });
      // The whole entry matched; its typed parts would only repeat the same transfer.
      if (c.value === inserted) break;
    }
    return out;
  }
}
