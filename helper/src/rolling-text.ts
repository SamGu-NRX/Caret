// The rolling text window: every text and typed value the reader has shown us in the last
// ten minutes, with the window it was in and when it was first and last seen. This is the only
// place plain screen text lives, and it is never written to disk.
import { containsBounded, normalizeValue, type MatchKind } from "./normalize.ts";
import { nodeText, ROLLING_WINDOW_MS, type WindowState } from "./model.ts";
import type { ValueKind } from "./protocol.ts";

export interface Observation {
  windowId: string;
  bundleId: string;
  windowKind: string;
  nodeKey: string;
  text: string;
  /** Null for a node's whole text; set for a typed value found inside it. */
  kind: ValueKind | null;
  editable: boolean;
  firstSeen: number;
  lastSeen: number;
}

export interface Found {
  obs: Observation;
  match: MatchKind;
}

export interface FindOptions {
  /** Observations from this window never count as a source. */
  excludeWindowId: string;
  /** The value must have been on screen at or before this time... */
  seenBy: number;
  /** ...and still within the rolling window measured back from `seenBy`. */
  windowMs?: number;
}

const MAX_TEXT = 2000;
/** Normalized keys shorter than this (an amount with no digits, a lone letter) would match unrelated text. */
const MIN_NORM = 3;

export class RollingText {
  private readonly obs = new Map<string, Observation>();
  private readonly byExact = new Map<string, Set<string>>();
  private readonly byNorm = new Map<string, Set<string>>();

  get size(): number {
    return this.obs.size;
  }

  observe(w: WindowState, at: number): void {
    for (const n of w.nodes.values()) {
      const text = nodeText(n);
      if (text.length === 0 || text.length > MAX_TEXT) continue;
      this.record(w, n.key, text, null, n.editable === true, at);
    }
    for (const v of w.values) {
      const editable = w.nodes.get(v.nodeKey)?.editable === true;
      this.record(w, v.nodeKey, v.text, v.kind, editable, at);
    }
  }

  private record(w: WindowState, nodeKey: string, text: string, kind: ValueKind | null, editable: boolean, at: number): void {
    const id = `${w.window.windowId}\u0000${nodeKey}\u0000${kind ?? ""}\u0000${text}`;
    const existing = this.obs.get(id);
    if (existing !== undefined) {
      existing.lastSeen = Math.max(existing.lastSeen, at);
      return;
    }
    this.obs.set(id, {
      windowId: w.window.windowId,
      bundleId: w.app.bundleId,
      windowKind: w.window.kind,
      nodeKey,
      text,
      kind,
      editable,
      firstSeen: at,
      lastSeen: at,
    });
    addTo(this.byExact, text, id);
    const norm = normalizeValue(text, kind);
    if (norm.length >= MIN_NORM) addTo(this.byNorm, norm, id);
  }

  /** Forgets everything, for a new reader session. */
  clear(): void {
    this.obs.clear();
    this.byExact.clear();
    this.byNorm.clear();
  }

  prune(now: number): void {
    const cutoff = now - ROLLING_WINDOW_MS;
    for (const [id, o] of this.obs) {
      if (o.lastSeen >= cutoff) continue;
      this.obs.delete(id);
      removeFrom(this.byExact, o.text, id);
      removeFrom(this.byNorm, normalizeValue(o.text, o.kind), id);
    }
  }

  /**
   * Every observation outside `excludeWindowId` whose whole text equals `value`, exactly or after
   * normalization. Unlike find(), never a text that merely contains it. Used when the same value is
   * on screen in several windows and the caller must choose the source that fits a pattern.
   */
  findAll(value: string, kind: ValueKind | null, opts: FindOptions): Observation[] {
    const span = opts.windowMs ?? ROLLING_WINDOW_MS;
    const out = new Map<string, Observation>();
    const add = (ids: Set<string> | undefined): void => {
      for (const id of ids ?? []) {
        const o = this.obs.get(id);
        if (o !== undefined && o.windowId !== opts.excludeWindowId && o.firstSeen <= opts.seenBy && o.lastSeen >= opts.seenBy - span) out.set(id, o);
      }
    };
    add(this.byExact.get(value));
    for (const k of kind === null ? [null] : [kind, null]) {
      const key = normalizeValue(value, k);
      if (key.length >= MIN_NORM) add(this.byNorm.get(key));
    }
    return [...out.values()];
  }

  /**
   * Finds a source for `value` in another window: an exact equal text or typed value first,
   * then the same after normalization, then an exact or normalized occurrence inside a longer text.
   * Editable sources count, since a value typed into one form can be the source for another.
   */
  find(value: string, kind: ValueKind | null, opts: FindOptions): Found | null {
    const span = opts.windowMs ?? ROLLING_WINDOW_MS;
    const ok = (o: Observation): boolean =>
      o.windowId !== opts.excludeWindowId && o.firstSeen <= opts.seenBy && o.lastSeen >= opts.seenBy - span;
    const pick = (ids: Set<string> | undefined): Observation | null => {
      if (ids === undefined) return null;
      let best: Observation | null = null;
      for (const id of ids) {
        const o = this.obs.get(id);
        if (o !== undefined && ok(o) && (best === null || o.lastSeen > best.lastSeen)) best = o;
      }
      return best;
    };

    const exact = pick(this.byExact.get(value));
    if (exact !== null) return { obs: exact, match: "exact" };
    for (const k of kind === null ? [null] : [kind, null]) {
      const key = normalizeValue(value, k);
      if (key.length < MIN_NORM) continue;
      const norm = pick(this.byNorm.get(key));
      if (norm !== null) return { obs: norm, match: "normalized" };
    }

    const normNeedle = normalizeValue(value, null);
    let normHit: Observation | null = null;
    if (normNeedle.length < MIN_NORM) return null;
    for (const o of this.obs.values()) {
      if (o.kind !== null || !ok(o)) continue;
      if (containsBounded(o.text, value)) return { obs: o, match: "exact" };
      if (normHit === null && normNeedle.length > 0 && containsBounded(normalizeValue(o.text, null), normNeedle)) normHit = o;
    }
    return normHit === null ? null : { obs: normHit, match: "normalized" };
  }
}

function addTo(m: Map<string, Set<string>>, k: string, id: string): void {
  const s = m.get(k);
  if (s === undefined) m.set(k, new Set([id]));
  else s.add(id);
}

function removeFrom(m: Map<string, Set<string>>, k: string, id: string): void {
  const s = m.get(k);
  if (s === undefined) return;
  s.delete(id);
  if (s.size === 0) m.delete(k);
}
