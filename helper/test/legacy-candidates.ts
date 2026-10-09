// The candidate generator as it was before B6 (commit 129b4b3), frozen as the reference that the
// early-capped generator must reproduce exactly. Not used by the helper. Deliberate changes since
// are carried over so the two stay comparable: a text holding a typed value is not a label (B13,
// src/fill/descriptor.ts labelTexts); and C1's reading of a line, taken from the generator itself so the
// two compare only rank and cap: the typed values code finds (windowValues), every span a line offers
// (lineSpans), a label naming only the typed value it starts with or the only one of its kind, and the
// clause a span's description quotes (lineFact); and each window read whole, typed values then lines, newest first,
// where the old generator read every window's typed values before any window's lines.
import type { Frame, Node, ValueKind } from "../src/protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../src/model.ts";
import { isLabelLike } from "../src/fill/descriptor.ts";
import { labelledSpan, lineFact, lineSpans, MAX_CANDIDATES, RECENT_MS, windowValues, type Candidate, type Recency } from "../src/fill/candidates.ts";
import { bareLine, lineValues } from "../src/fill/line-values.ts";

const MAX_CONTEXT_CHARS = 60;
const LINE_ROLES = new Set(["AXStaticText", "AXCell", "AXHeading", "AXLink"]);
const LABELLED = /^([^:]{1,32}):\s+(.+)$/;
const MAX_LEFT_GAP = 260;
const MAX_ABOVE_GAP = 48;
const MAX_LABEL_CHARS = 60;

export function legacyGenerateCandidates(model: ScreenModel, targetWindowId: string, max = MAX_CANDIDATES, now = Date.now()): Candidate[] {
  const windows = [...model.windows.values()]
    .filter((w) => w.window.windowId !== targetWindowId)
    .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt || b.updatedAt - a.updatedAt);
  const justLeft = model.windowBefore(targetWindowId);
  const recency = (w: WindowState): Recency =>
    w.window.windowId === justLeft ? "justLeft" : w.lastFocusedAt === 0 ? "unseen" : now - w.lastFocusedAt <= RECENT_MS ? "recent" : "earlier";

  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (w: WindowState, node: Node, text: string, kind: ValueKind | null, context: string | null, quote?: string): void => {
    if (out.length >= max || seen.has(text)) return;
    seen.add(text);
    const labelled = labelledSpan(node, text, context);
    out.push({
      id: `c${out.length + 1}`,
      text,
      kind,
      context,
      // B24's fact about the span, worked out as the generator does; the ranking under test is unchanged.
      labelled,
      line: quote ?? lineFact(w, node, text, labelled)?.clause ?? null,
      section: sectionAround(w, node),
      blockHead: blockHead(w, node, text),
      recency: recency(w),
      source: {
        pid: w.app.pid,
        windowId: w.window.windowId,
        bundleId: w.app.bundleId,
        appName: w.app.name,
        windowTitle: w.window.title,
        nodeKey: node.key,
        kind,
      },
    });
  };

  for (const w of windows) {
    for (const v of windowValues(w)) {
      const node = w.nodes.get(v.nodeKey);
      if (node === undefined) continue;
      add(w, node, v.text, v.kind, contextFor(w, node, v.text));
    }
    for (const node of w.nodes.values()) {
      const isSourceField = node.editable === true && (node.value ?? "").length > 0 && !node.states?.includes("secure");
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      const lines = nodeText(node).split(/\r?\n/);
      for (const raw of lines) {
        for (const s of lineSpans(raw)) {
          if (s.label !== null) {
            add(w, node, s.text, null, s.label, s.with);
            continue;
          }
          const context = lines.length === 1 ? (isSourceField ? (node.label ?? nearestText(w, node, isLabelLike)) : nearestText(w, node, isLabelLike)) : null;
          add(w, node, s.text, null, context);
        }
      }
    }
  }
  return out;
}

function contextFor(w: WindowState, node: Node, span: string): string | null {
  for (const line of nodeText(node).split(/\r?\n/)) {
    const m = LABELLED.exec(bareLine(line));
    if (m !== null && m[1] !== undefined && m[2] !== undefined && m[2].includes(span) && labelNames(m[2].trim(), span)) return m[1].trim();
  }
  if (node.editable === true && node.label !== undefined) return node.label;
  return nearestText(w, node, isLabelLike);
}

/** The label of the nearest named ancestor, skipping web areas, whose label is the page title. */
function sectionAround(w: WindowState, node: Node): string | null {
  let key = node.parent;
  while (key !== null) {
    const n = w.nodes.get(key);
    if (n === undefined) return null;
    // B24: a section ends at the page's web area, as the generator's does.
    if (n.role === "AXWebArea") return null;
    if (n.label !== undefined) {
      const t = short(n.label);
      if (t !== null) return t;
    }
    key = n.parent;
  }
  return null;
}

/**
 * The first line of the span's block: the first line of a multi-line node, or else the first text
 * line among the node's siblings. Lines equal to the section's own title are skipped, since a group
 * box repeats its title as a static text.
 */
function blockHead(w: WindowState, node: Node, span: string): string | null {
  const own = nodeText(node).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  let head: string | undefined;
  if (own.length > 1) head = own[0];
  else if (node.parent !== null) {
    const section = w.nodes.get(node.parent)?.label;
    for (const n of w.nodes.values()) {
      if (n.parent !== node.parent || !LINE_ROLES.has(n.role)) continue;
      const first = nodeText(n).split(/\r?\n/)[0]?.trim();
      if (first === undefined || first.length === 0 || first === section) continue;
      head = first;
      break;
    }
  }
  if (head === undefined || head.includes(span) || head === nodeText(node).trim()) return null;
  return short(head);
}

function short(s: string): string | null {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length === 0) return null;
  return t.length <= MAX_CONTEXT_CHARS ? t : `${t.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
}

/** Nearest short static text to the left on the same row, else directly above. With `accept`, a text holding a typed value is skipped too. */
function nearestText(w: WindowState, target: Node, accept?: (t: string) => boolean): string | null {
  const f = target.frame;
  if (f === undefined) return null;
  const holdsValue = accept === undefined ? new Set<string>() : new Set(w.values.map((v) => v.nodeKey));
  const [fx, fy, , fh] = f;
  const cy = fy + fh / 2;
  let left: { d: number; t: string } | null = null;
  let above: { d: number; t: string } | null = null;
  for (const n of w.nodes.values()) {
    if (n.role !== "AXStaticText" || n.frame === undefined || n.key === target.key) continue;
    const t = clean(n.label ?? n.value);
    if (t === null || t.length > MAX_LABEL_CHARS || holdsValue.has(n.key) || (accept !== undefined && !accept(t))) continue;
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

function clean(s: string | undefined | null): string | null {
  if (s === undefined || s === null) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length === 0 ? null : t;
}

function stripColon(s: string | null): string | null {
  return s === null ? null : s.replace(/\s*:\s*$/, "");
}

/** C1: a label names a typed value its value starts with, or the only one of its kind there (candidates.ts labelNames). */
function labelNames(value: string, span: string): boolean {
  if (value.startsWith(span)) return true;
  const vs = lineValues(value);
  const kind = vs.find((v) => v.text === span)?.kind;
  return kind === undefined || vs.filter((v) => v.kind === kind).length === 1;
}
