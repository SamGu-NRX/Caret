// Field descriptors. Most fields carry no accessible label (28 of 140 on Sam's Mac, deep plan
// section 2), so after the field's own label and placeholder, code looks for the nearest static
// text to the left on the same row, then directly above, using the frames in the screen model.
import type { Frame, Node } from "../protocol.ts";
import type { WindowState } from "../model.ts";

export interface FieldDescriptor {
  text: string;
  label: string | null;
  placeholder: string | null;
  nearest: string | null;
  section: string | null;
}

const ROLE_NAMES: Record<string, string> = {
  AXTextField: "Text field",
  AXTextArea: "Text area",
  AXComboBox: "Combo box",
  AXSearchField: "Search field",
};

/** Limits for "nearest": wider than a label column, tighter than a neighbouring section. Assumed. */
const MAX_LEFT_GAP = 260;
const MAX_ABOVE_GAP = 48;
const MAX_LABEL_CHARS = 60;

export function describeField(w: WindowState, field: Node): FieldDescriptor {
  const label = clean(field.label);
  const placeholder = clean(field.placeholder);
  const nearest = label === null ? nearestText(w, field) : null;
  const section = sectionOf(w, field);
  const parts = [`${ROLE_NAMES[field.role] ?? "Field"}.`];
  if (label !== null) parts.push(`Label: '${label}'.`);
  if (nearest !== null) parts.push(`Nearest label: '${nearest}'.`);
  if (placeholder !== null) parts.push(`Placeholder: '${placeholder}'.`);
  if (section !== null) parts.push(`Section: '${section}'.`);
  return { text: parts.join(" "), label, placeholder, nearest, section };
}

/**
 * A text that reads as a label rather than content: ends with a colon, or is a few words with no digits.
 * Candidate contexts use this filter, since the text above a value is often just the previous paragraph.
 */
export function isLabelLike(t: string): boolean {
  return t.length <= 32 && (t.endsWith(":") || (!/\d/.test(t) && t.split(" ").length <= 4));
}

/** A static text that could name a field: its frame and cleaned text, at most MAX_LABEL_CHARS long. */
interface LabelText {
  key: string;
  frame: Frame;
  t: string;
  labelLike: boolean;
  /** Position in document order, so a search of a band of rows still breaks ties as a scan of every text would. */
  order: number;
}

/**
 * Each window's label texts, built once per window state. The model replaces a window's state on every
 * snapshot, so a state never changes under its entry; the candidate generator asks for the nearest
 * label of many spans in one window, and scanning every node for each was most of its time. The texts
 * are also sorted by their top edge, so a query reads only the rows near its field; texts taller than
 * TALL_TEXT are kept apart and always read, so one page-high text does not widen every band.
 */
interface LabelIndex {
  byTop: LabelText[];
  tall: LabelText[];
  /** The tallest text in byTop. */
  maxH: number;
}

/** Texts taller than this go in LabelIndex.tall. Chosen so ordinary lines and wrapped labels stay in the bands; not measured. */
const TALL_TEXT = 200;
/** Points a band reaches past its computed bounds; far above any rounding error, and it only reads a few more texts. */
const BAND_SLACK = 1;
const labelIndex = new WeakMap<WindowState, LabelIndex>();
/** Whitespace that clean() would change: a run, a tab or line break, or space at either end. */
const UNCLEAN = /\s\s|[^\S ]|^\s|\s$/;

function labelTexts(w: WindowState): LabelIndex {
  let idx = labelIndex.get(w);
  if (idx !== undefined) return idx;
  const byTop: LabelText[] = [];
  const tall: LabelText[] = [];
  let maxH = 0;
  let order = 0;
  for (const n of w.nodes.values()) {
    if (n.role !== "AXStaticText" || n.frame === undefined) continue;
    const raw = n.label ?? n.value;
    if (raw === undefined || raw.length === 0) continue;
    // With nothing to collapse, cleaning leaves the text as it is, so a long one is over the cap without running the replace.
    const unclean = UNCLEAN.test(raw);
    if (!unclean && raw.length > MAX_LABEL_CHARS) continue;
    const t = unclean ? clean(raw) : raw;
    if (t === null || t.length > MAX_LABEL_CHARS) continue;
    const e: LabelText = { key: n.key, frame: n.frame, t, labelLike: isLabelLike(t), order: order++ };
    // A negative height would break the band's bounds; such a frame is read on every query instead.
    if (n.frame[3] > TALL_TEXT || !(n.frame[3] >= 0)) tall.push(e);
    else {
      byTop.push(e);
      if (n.frame[3] > maxH) maxH = n.frame[3];
    }
  }
  byTop.sort((a, b) => a.frame[1] - b.frame[1] || a.order - b.order);
  idx = { byTop, tall, maxH };
  labelIndex.set(w, idx);
  return idx;
}

/** The first index in `xs`, sorted by top edge, whose top is at least `y`. */
function firstTopAtLeast(xs: readonly LabelText[], y: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] as LabelText).frame[1] < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Nearest short static text to the left on the same row, else directly above. `labelOnly` keeps texts
 * that pass isLabelLike. Only texts whose top is in the band a match can lie in are read, then in
 * document order, so the result is the one a scan of every text gives.
 */
export function nearestText(w: WindowState, target: Node, labelOnly = false): string | null {
  const f = target.frame;
  if (f === undefined) return null;
  const [fx, fy, , fh] = f;
  const cy = fy + fh / 2;
  const idx = labelTexts(w);
  // Same row: the text's centre within max(fh, h) / 2 of the field's. Above: its bottom within MAX_ABOVE_GAP over the field's top.
  // Widened by BAND_SLACK, since the exact tests below round differently from these bounds at the edge.
  const m = Math.max(fh, idx.maxH);
  const lo = Math.min(cy - m / 2 - idx.maxH / 2, fy - MAX_ABOVE_GAP - idx.maxH) - BAND_SLACK;
  const hi = Math.max(cy + m / 2, fy + 4) + BAND_SLACK;
  const band: LabelText[] = [...idx.tall];
  for (let i = firstTopAtLeast(idx.byTop, lo); i < idx.byTop.length; i++) {
    const e = idx.byTop[i] as LabelText;
    if (e.frame[1] > hi) break;
    band.push(e);
  }
  band.sort((a, b) => a.order - b.order);
  let left: { d: number; t: string } | null = null;
  let above: { d: number; t: string } | null = null;
  for (const e of band) {
    if (e.key === target.key || (labelOnly && !e.labelLike)) continue;
    const [x, y, wd, h] = e.frame;
    const right = x + wd;
    const textCy = y + h / 2;
    if (Math.abs(textCy - cy) <= Math.max(fh, h) / 2 && right <= fx + 4) {
      const d = fx - right;
      if (d <= MAX_LEFT_GAP && (left === null || d < left.d)) left = { d, t: e.t };
      continue;
    }
    const bottom = y + h;
    if (bottom <= fy + 4 && overlapsHorizontally(e.frame, f)) {
      const d = fy - bottom;
      if (d <= MAX_ABOVE_GAP && (above === null || d < above.d)) above = { d, t: e.t };
    }
  }
  return stripColon((left ?? above)?.t ?? null);
}

function overlapsHorizontally(a: Frame, b: Frame): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2];
}

function sectionOf(w: WindowState, field: Node): string | null {
  let key = field.parent;
  while (key !== null) {
    const n = w.nodes.get(key);
    if (n === undefined) return null;
    const t = clean(n.label);
    if (t !== null && n.role !== "AXWebArea" && t.length <= MAX_LABEL_CHARS) return t;
    key = n.parent;
  }
  return null;
}

function clean(s: string | undefined | null): string | null {
  if (s === undefined || s === null) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length === 0 ? null : t;
}

function stripColon(s: string | null): string | null {
  return s === null ? null : s.replace(/\s*:\s*$/, "");
}
