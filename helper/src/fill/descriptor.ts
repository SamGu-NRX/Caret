// Field descriptors. Most fields carry no accessible label (28 of 140 on Sam's Mac, deep plan
// section 2), so after the field's own label and placeholder, code looks for the nearest static
// text to the left on the same row, then directly above, using the frames in the screen model.
import type { Frame, Node } from "../protocol.ts";
import type { WindowState } from "../model.ts";
import { secretText } from "../memory/sensitive.ts";
import type { Disclosure, ModelText } from "../privacy/disclosure.ts";
import { collapsedRange, nodePart, type SourceAt } from "../privacy/ledger/source.ts";

export interface FieldDescriptor {
  text: string;
  label: string | null;
  placeholder: string | null;
  nearest: string | null;
  section: string | null;
}

const ROLE_NAMES = {
  AXTextField: "Text field",
  AXTextArea: "Text area",
  AXComboBox: "Combo box",
  AXSearchField: "Search field",
} as const;
const roleName = (role: string): (typeof ROLE_NAMES)[keyof typeof ROLE_NAMES] | "Field" => (Object.hasOwn(ROLE_NAMES, role) ? ROLE_NAMES[role as keyof typeof ROLE_NAMES] : "Field");

/** Limits for "nearest": wider than a label column, tighter than a neighbouring section. Assumed. */
const MAX_LEFT_GAP = 260;
const MAX_ABOVE_GAP = 48;
const MAX_LABEL_CHARS = 60;

/**
 * Where each part of a field descriptor was read (OUTPUT-LEDGER-SPEC section 4): a range of the view's text, through the
 * one collapse map (ledger/source.ts collapsedRange). Each part is a prefix of its node text collapsed: chrome is taken
 * off its end and a long one is cut, with an ellipsis Caret adds outside the range.
 */
export interface DescriptorSources {
  readonly view: WindowState;
  readonly label?: SourceAt;
  readonly placeholder?: SourceAt;
  readonly nearest?: SourceAt;
  readonly section?: SourceAt;
}
const SOURCES = new WeakMap<FieldDescriptor, DescriptorSources>();

/** Where `fd`'s parts were read, when describeField made it. */
export function descriptorSources(fd: FieldDescriptor): DescriptorSources | undefined {
  return SOURCES.get(fd);
}

/** The range of `text` at the start of node `n`'s part, or nothing. */
const headOf = (n: Node | undefined, part: "label" | "value" | "placeholder", text: string | null): SourceAt | undefined => {
  const raw = n === undefined ? undefined : n[part];
  return text === null || raw === undefined || n === undefined ? undefined : (collapsedRange(nodePart(n.key, part), raw, text) ?? undefined);
};

export function describeField(w: WindowState, field: Node): FieldDescriptor {
  // A label or placeholder is a short snippet in the question (privacy.ts): a long one is cut, ellipsis included.
  const label = cutLabel(fieldLabelText(field.label));
  const placeholder = cutLabel(clean(field.placeholder));
  const near = label === null ? nearestLabel(w, field) : null;
  const nearest = label === null ? nearestText(w, field) : null;
  const sectionAt = sectionNode(w, field);
  const section = sectionOf(w, field);
  const parts = [`${roleName(field.role)}.`];
  if (label !== null) parts.push(`Label: '${label}'.`);
  if (nearest !== null) parts.push(`Nearest label: '${nearest}'.`);
  if (placeholder !== null) parts.push(`Placeholder: '${placeholder}'.`);
  if (section !== null) parts.push(`Section: '${section}'.`);
  const fd: FieldDescriptor = { text: parts.join(" "), label, placeholder, nearest, section };
  const nearNode = near === null ? undefined : w.nodes.get(near.key);
  const at = {
    label: headOf(field, "label", label),
    placeholder: headOf(field, "placeholder", placeholder),
    nearest: headOf(nearNode, nearNode?.label !== undefined ? "label" : "value", nearest),
    section: section === null || sectionAt === null ? undefined : headOf(sectionAt, "label", section),
  };
  SOURCES.set(fd, { view: w, ...Object.fromEntries(Object.entries(at).filter(([, v]) => v !== undefined)) });
  return fd;
}

/**
 * SC1 2b: a field's descriptor as describeField words it, minted part by part by `d` from the redacted view `w`
 * describeField read: the role in Caret's words, each label, placeholder and section as the view shows it. Null when a
 * part does not fit its window's budget or the view does not show it.
 */
export function mintDescriptor(d: Disclosure, w: WindowState, field: Node, fd: FieldDescriptor = describeField(w, field)): ModelText | null {
  const parts: ModelText[] = [d.t`${d.own(roleName(field.role))}.`];
  const src = descriptorSources(fd);
  const read = src?.view === w ? src : undefined;
  const add = (text: string | null, say: (m: ModelText) => ModelText, at?: SourceAt): boolean => {
    if (text === null) return true;
    const m = d.descriptor(w, text, at);
    if (m === null) return false;
    parts.push(say(m));
    return true;
  };
  const ok =
    add(fd.label, (m) => d.t`Label: '${m}'.`, read?.label) &&
    add(fd.nearest, (m) => d.t`Nearest label: '${m}'.`, read?.nearest) &&
    add(fd.placeholder, (m) => d.t`Placeholder: '${m}'.`, read?.placeholder) &&
    add(fd.section, (m) => d.t`Section: '${m}'.`, read?.section);
  return ok ? d.join(parts, " ") : null;
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
}

/**
 * Each window's label texts, built once per window state. The model replaces a window's state on every
 * snapshot, so a state never changes under its entry; the candidate generator asks for the nearest
 * label of many spans in one window, and scanning every node for each was most of its time.
 *
 * Queries scan this list in document order. An index sorted by row was tried in B8 (ead8b1a): it was
 * faster on a synthetic scene with dozens of queries per window, but on real windows, which get a few
 * queries each, sorting on every snapshot made the cold call slower (event-loop CPU p95 5.3 -> 7.4 ms
 * over the same hour), so it was taken out.
 */
const labelIndex = new WeakMap<WindowState, LabelText[]>();
/** Whitespace that clean() would change: a run, a tab or line break, or space at either end. */
const UNCLEAN = /\s\s|[^\S ]|^\s|\s$/;

function labelTexts(w: WindowState): LabelText[] {
  let out = labelIndex.get(w);
  if (out !== undefined) return out;
  out = [];
  // A text that holds one of the reader's typed values is content, not a label. An email or a web address
  // passes isLabelLike's shape (one word, no digits), so the calibration fixture's signature labelled its
  // phone and website with the email line above them, which cost a conversation's budget 32 characters a
  // candidate and told Jev something false (B13).
  const holdsValue = new Set(w.values.map((v) => v.nodeKey));
  for (const n of w.nodes.values()) {
    if (n.role !== "AXStaticText" || n.frame === undefined) continue;
    const raw = n.label ?? n.value;
    // A document is content, never a competing nearest label.
    if (raw === undefined || raw.length === 0 || /\S\s*\n\s*\S/u.test(raw)) continue;
    // With nothing to collapse, cleaning leaves the text as it is, so a long one is over the cap without running the replace.
    const unclean = UNCLEAN.test(raw);
    if (!unclean && raw.length > MAX_LABEL_CHARS) continue;
    const t = unclean ? clean(raw) : raw;
    if (t === null || t.length > MAX_LABEL_CHARS) continue;
    out.push({ key: n.key, frame: n.frame, t, labelLike: !holdsValue.has(n.key) && isLabelLike(t) });
  }
  labelIndex.set(w, out);
  return out;
}

/** Nearest short static text to the left on the same row, else directly above. `labelOnly` keeps texts that pass isLabelLike. */
export function nearestText(w: WindowState, target: Node, labelOnly = false): string | null {
  return stripColon(nearestLabel(w, target, labelOnly)?.t ?? null);
}

/**
 * The static text nearestText reads for `target`: its node key and text, or null. G2: the redacted view (fill/redact.ts)
 * drops a node whose nearest label names a secret, and that label's own node with it.
 */
export function nearestLabel(w: WindowState, target: Node, labelOnly = false): { key: string; t: string } | null {
  const f = target.frame;
  if (f === undefined) return null;
  const [fx, fy, , fh] = f;
  const cy = fy + fh / 2;
  let left: { d: number; e: LabelText } | null = null;
  let above: { d: number; e: LabelText } | null = null;
  for (const e of labelTexts(w)) {
    if (e.key === target.key || (labelOnly && !e.labelLike)) continue;
    const [x, y, wd, h] = e.frame;
    const right = x + wd;
    const textCy = y + h / 2;
    if (Math.abs(textCy - cy) <= Math.max(fh, h) / 2 && right <= fx + 4) {
      const d = fx - right;
      if (d <= MAX_LEFT_GAP && (left === null || d < left.d)) left = { d, e };
      continue;
    }
    const bottom = y + h;
    if (bottom <= fy + 4 && overlapsHorizontally(e.frame, f)) {
      const d = fy - bottom;
      if (d <= MAX_ABOVE_GAP && (above === null || d < above.d)) above = { d, e };
    }
  }
  const hit = (left ?? above)?.e;
  return hit === undefined ? null : { key: hit.key, t: hit.t };
}

/**
 * G2: the keys of the nodes whose nearest text `marked` says names a secret, and of those texts' own nodes. Admission
 * reads every static text in full (G2 round 5: the presentation list, labelTexts, leaves out texts over MAX_LABEL_CHARS,
 * so a long label naming a password did not keep the field beside it out), and a node is dropped when its nearest text
 * by that full list, or by either reading nearestText presents (any text, or label-like texts only), is marked. Marked
 * texts are few, so this looks only at the nodes each one could be nearest to (to its right on its row, or below it):
 * about one pass over the window, not one lookup per field (G2 round 4: one per field cost about 30 ms on 2,000).
 */
export function nodesLabelledBy(w: WindowState, marked: (t: string) => boolean, markedKeys: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const all = allTexts(w);
  // A one-line text that names a secret is a label: it goes, and so does each node it is nearest to. A text of several
  // lines is a document, whose own lines the redacted view drops one by one, and which labels nothing (G2 round 6: a
  // document lost its name and phone, and then took "Robin Vale" beside it).
  const oneLine = all.filter((e) => !e.document);
  const labels = oneLine.filter((e) => markedKeys.has(e.key) || marked(e.t));
  if (labels.length === 0) return out;
  const isDocument = new Set(all.filter((e) => e.document).map((e) => e.key));
  for (const e of labels) out.add(e.key);
  const isMarkedLabel = (key: string, t: string): boolean => !isDocument.has(key) && (markedKeys.has(key) || marked(t));
  for (const n of w.nodes.values()) {
    const f = n.frame;
    // A document is checked too: a one-line label naming a secret beside it takes it whole.
    if (f === undefined || out.has(n.key)) continue;
    const [fx, fy, , fh] = f;
    const near = labels.some((e) => {
      const [x, y, wd, h] = e.frame;
      const sameRow = Math.abs(y + h / 2 - (fy + fh / 2)) <= Math.max(fh, h) / 2 && x + wd <= fx + 4 && fx - (x + wd) <= MAX_LEFT_GAP;
      const below = y + h <= fy + 4 && overlapsHorizontally(e.frame, f) && fy - (y + h) <= MAX_ABOVE_GAP;
      return sameRow || below;
    });
    if (!near) continue;
    const full = nearestIn(oneLine, n);
    const shown = [nearestLabel(w, n, false), nearestLabel(w, n, true)];
    if ((full !== null && isMarkedLabel(full.key, full.t)) || shown.some((l) => l !== null && isMarkedLabel(l.key, l.t))) out.add(n.key);
  }
  return out;
}

/** Every static text with a frame, in full and cleaned of runs of white space: what admission reads (nodesLabelledBy). */
function allTexts(w: WindowState): FullText[] {
  let out = fullIndex.get(w);
  if (out !== undefined) return out;
  out = [];
  for (const n of w.nodes.values()) {
    if (n.role !== "AXStaticText" || n.frame === undefined) continue;
    const raw = n.label ?? n.value;
    const t = clean(raw);
    if (t === null) continue;
    out.push({ key: n.key, frame: n.frame, t, labelLike: false, document: /\S\s*\n\s*\S/u.test(raw ?? "") });
  }
  fullIndex.set(w, out);
  return out;
}
const fullIndex = new WeakMap<WindowState, FullText[]>();
/** A static text as admission reads it: in full, and whether it is a document of several lines rather than a label. */
type FullText = LabelText & { document: boolean };

/** nearestLabel's rule over a given list of texts. */
function nearestIn(texts: readonly LabelText[], target: Node): LabelText | null {
  const f = target.frame;
  if (f === undefined) return null;
  const [fx, fy, , fh] = f;
  const cy = fy + fh / 2;
  let left: { d: number; e: LabelText } | null = null;
  let above: { d: number; e: LabelText } | null = null;
  for (const e of texts) {
    if (e.key === target.key) continue;
    const [x, y, wd, h] = e.frame;
    const right = x + wd;
    if (Math.abs(y + h / 2 - cy) <= Math.max(fh, h) / 2 && right <= fx + 4) {
      const d = fx - right;
      if (d <= MAX_LEFT_GAP && (left === null || d < left.d)) left = { d, e };
      continue;
    }
    const bottom = y + h;
    if (bottom <= fy + 4 && overlapsHorizontally(e.frame, f)) {
      const d = fy - bottom;
      if (d <= MAX_ABOVE_GAP && (above === null || d < above.d)) above = { d, e };
    }
  }
  return (left ?? above)?.e ?? null;
}

function overlapsHorizontally(a: Frame, b: Frame): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2];
}

function sectionOf(w: WindowState, field: Node): string | null {
  const n = sectionNode(w, field);
  // A section can name a secret even when its child field does not. Do not quote that name.
  return n === null || secretText(n.label) ? null : fieldLabelText(n.label);
}

/** The node whose label is `n`'s section: its nearest ancestor below the web area with a short label, or null. */
export function sectionNode(w: WindowState, n: Node): Node | null {
  let key = n.parent;
  while (key !== null) {
    const p = w.nodes.get(key);
    if (p === undefined) return null;
    // A page's own section ends at its web area: above it is the browser's group named for the window
    // ("httpbin.org/forms/post - Google Chrome"), which put the window title in every web field's name and
    // spent the form window's budget on it (B24 capture).
    if (p.role === "AXWebArea") return null;
    const t = fieldLabelText(p.label);
    if (t !== null && t.length <= MAX_LABEL_CHARS) return p;
    key = p.parent;
  }
  return null;
}

/**
 * A field's own label without form chrome: a required marker ("Email *", "First Name*", "Phone (required)")
 * and a trailing colon ("Customer name:"). Chrome names a web field by its whole <label>, marker included, so
 * plan cards read "Fill Email * in Google Chrome" with the asterisk wrapped onto its own line (Q1 bug 16).
 * "(optional)" stays: it says something about the field.
 */
export function fieldLabelText(s: string | undefined | null): string | null {
  const t = clean(s);
  if (t === null) return null;
  let out = t;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(REQUIRED_MARK, "").replace(/\s*:\s*$/, "").trim();
  }
  return out === "" ? t : out;
}
/** A required marker at the end of a label: asterisks, "(required)" or "[required]". */
const REQUIRED_MARK = /\s*(?:\*+|\(required\)|\[required\])\s*$/iu;

function clean(s: string | undefined | null): string | null {
  if (s === undefined || s === null) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length === 0 ? null : t;
}

function cutLabel(s: string | null): string | null {
  return s === null || s.length <= MAX_LABEL_CHARS ? s : `${s.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function stripColon(s: string | null): string | null {
  return s === null ? null : s.replace(/\s*:\s*$/, "");
}
