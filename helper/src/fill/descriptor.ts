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

/** Nearest short static text to the left on the same row, else directly above. */
export function nearestText(w: WindowState, target: Node, accept: (t: string) => boolean = () => true): string | null {
  const f = target.frame;
  if (f === undefined) return null;
  const [fx, fy, , fh] = f;
  const cy = fy + fh / 2;
  let left: { d: number; t: string } | null = null;
  let above: { d: number; t: string } | null = null;
  for (const n of w.nodes.values()) {
    if (n.role !== "AXStaticText" || n.frame === undefined || n.key === target.key) continue;
    const t = clean(n.label ?? n.value);
    if (t === null || t.length > MAX_LABEL_CHARS || !accept(t)) continue;
    const [x, y, wd, h] = n.frame;
    const right = x + wd;
    const textCy = y + h / 2;
    if (Math.abs(textCy - cy) <= Math.max(fh, h) / 2 && right <= fx + 4) {
      const d = fx - right;
      if (d <= MAX_LEFT_GAP && (left === null || d < left.d)) left = { d, t };
      continue;
    }
    const bottom = y + h;
    if (bottom <= fy + 4 && overlapsHorizontally(n.frame, f)) {
      const d = fy - bottom;
      if (d <= MAX_ABOVE_GAP && (above === null || d < above.d)) above = { d, t };
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
