// The grounded-fill candidate generator. It collects short spans from every window other than
// the form's own: typed values first, then single lines of visible text, splitting "Label: value"
// lines so the value is the span and the label is its context. Jev later picks among these by id,
// and code copies the chosen span verbatim.
import type { FillSource, Node, ValueKind } from "../protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { isLabelLike, nearestText } from "./descriptor.ts";

export interface Candidate {
  id: string;
  text: string;
  kind: ValueKind | null;
  /** The label the span sits next to in its source window, if code found one. */
  context: string | null;
  /** The nearest named container around the span, such as a group box or a section heading. */
  section: string | null;
  /**
   * The first line of the block the span sits in, when that is another line. In a signature or an
   * email header it names whose details these are, which the span alone does not.
   */
  blockHead: string | null;
  /** How recently the user was in the source window, bucketed by code because Jev cannot compare numbers. */
  recency: Recency;
  source: FillSource;
}

/**
 * "justLeft": the window the user was in just before they came to the form (ScreenModel.windowBefore).
 * "recent": focused within RECENT_MS. "earlier": focused before that. "unseen": never focused while the reader ran.
 */
export type Recency = "justLeft" | "recent" | "earlier" | "unseen";
/** Two minutes: about the span of looking something up and coming back. Assumed, not measured. */
export const RECENT_MS = 2 * 60 * 1000;
const MAX_CONTEXT_CHARS = 60;

/**
 * Jev's accuracy falls with unrelated state (its docs; deep plan section 5), and a Choice allows
 * at most 255 options. The probe measured 36 of 36 correct at 134 candidates; 80 stays well inside that.
 */
export const MAX_CANDIDATES = 80;
const MIN_LINE = 2;
const MAX_LINE = 80;
const LINE_ROLES = new Set(["AXStaticText", "AXCell", "AXHeading", "AXLink"]);
const LABELLED = /^([^:]{1,32}):\s+(.+)$/;

export function generateCandidates(model: ScreenModel, targetWindowId: string, max = MAX_CANDIDATES, now = Date.now()): Candidate[] {
  const windows = [...model.windows.values()]
    .filter((w) => w.window.windowId !== targetWindowId)
    .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt || b.updatedAt - a.updatedAt);
  const justLeft = model.windowBefore(targetWindowId);
  const recency = (w: WindowState): Recency =>
    w.window.windowId === justLeft ? "justLeft" : w.lastFocusedAt === 0 ? "unseen" : now - w.lastFocusedAt <= RECENT_MS ? "recent" : "earlier";

  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (w: WindowState, node: Node, text: string, kind: ValueKind | null, context: string | null): void => {
    if (out.length >= max || seen.has(text)) return;
    seen.add(text);
    out.push({
      id: `c${out.length + 1}`,
      text,
      kind,
      context,
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
    for (const v of w.values) {
      const node = w.nodes.get(v.nodeKey);
      if (node === undefined) continue;
      add(w, node, v.text, v.kind, contextFor(w, node, v.text));
    }
  }
  for (const w of windows) {
    for (const node of w.nodes.values()) {
      const isSourceField = node.editable === true && (node.value ?? "").length > 0 && !node.states?.includes("secure");
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      const lines = nodeText(node).split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.replace(/\s+/g, " ").trim();
        if (line.length < MIN_LINE || line.length > MAX_LINE || !/[\p{L}\p{N}]/u.test(line)) continue;
        if (line.endsWith(":")) continue; // a label, not a value
        const m = LABELLED.exec(line);
        if (m !== null && m[1] !== undefined && m[2] !== undefined) {
          add(w, node, m[2].trim(), null, m[1].trim());
          continue;
        }
        const context = lines.length === 1 ? (isSourceField ? (node.label ?? nearestText(w, node, isLabelLike)) : nearestText(w, node, isLabelLike)) : null;
        add(w, node, line, null, context);
      }
    }
  }
  return out;
}

function contextFor(w: WindowState, node: Node, span: string): string | null {
  for (const line of nodeText(node).split(/\r?\n/)) {
    const m = LABELLED.exec(line.trim());
    if (m !== null && m[1] !== undefined && m[2]?.includes(span)) return m[1].trim();
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
    if (n.role !== "AXWebArea" && n.label !== undefined) {
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

const RECENCY_TEXT: Record<Recency, string> = {
  justLeft: "the window the user just left",
  recent: "a window the user visited in the last two minutes, but not the one they just left",
  earlier: "a window the user visited more than two minutes ago",
  unseen: "a window the user has not visited",
};

/** One line per candidate: the span, then the facts code knows about where it was found. */
export function describeCandidate(c: Candidate): string {
  const facts: string[] = [];
  if (c.kind !== null) facts.push(c.kind);
  if (c.context !== null && c.context !== c.text) facts.push(`labelled '${c.context}'`);
  if (c.blockHead !== null) facts.push(`in a block that starts '${c.blockHead}'`);
  if (c.section !== null && c.section !== c.context) facts.push(`under '${c.section}'`);
  facts.push(`in ${c.source.appName} window '${c.source.windowTitle}', ${RECENCY_TEXT[c.recency]}`);
  return `"${c.text}" (${facts.join("; ")})`;
}
