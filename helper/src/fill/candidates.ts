// The grounded-fill candidate generator. It collects short spans from every window other than
// the form's own: typed values first, then single lines of visible text, splitting "Label: value"
// lines so the value is the span and the label is its context. Jev later picks among these by id,
// and code copies the chosen span verbatim.
import type { FillSource, Node, ValueKind } from "../protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { nearestText } from "./descriptor.ts";

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
/**
 * Time the generator may spend on one focus before it stops and returns what it has. It runs on the
 * helper's event loop, which B6 holds to 20 ms per piece of work; 15 ms leaves the rest of the focus
 * path (form fields, descriptors) room. Spans it did not reach are the least recent, since windows
 * are taken most recent first.
 */
export const GENERATOR_BUDGET_MS = 15;
/** Nodes or values between clock reads. */
const CLOCK_EVERY = 64;
const MIN_LINE = 2;
const MAX_LINE = 80;
const LINE_ROLES = new Set(["AXStaticText", "AXCell", "AXHeading", "AXLink"]);
const LABELLED = /^([^:]{1,32}):\s+(.+)$/;

export interface GenerateOptions {
  max?: number;
  now?: number;
  budgetMs?: number;
  /** Milliseconds, for the budget. Tests pass a fake clock. */
  clock?: () => number;
  /** When given, wall time by part of the work is added to it, for the audit's probe. */
  profile?: GeneratorProfile;
}

/** Wall milliseconds per part of one generator call: splitting node text into lines, and the three facts worked out per kept span. */
export interface GeneratorProfile {
  split: number;
  context: number;
  section: number;
  blockHead: number;
}

export interface GenerateStats {
  /** Windows, typed values and nodes the generator looked at before it had enough or ran out of time. */
  windows: number;
  values: number;
  nodes: number;
  /** True when the budget ran out before the cap was reached or every window was read. */
  overBudget: boolean;
  ms: number;
}

/**
 * The candidates for a fill, in rank order, at most `max`: typed values first, then single lines,
 * each from the most recently focused window down. The rank is decided before any span is built, and
 * the expensive facts about a span (its label, section and block) are worked out only for spans that
 * make the cut, so the cost follows the cap rather than the screen. The output is the same as building
 * every span and keeping the first `max`, as the generator did before B6 (test/legacy-candidates.ts).
 */
export function collectCandidates(model: ScreenModel, targetWindowId: string, o: GenerateOptions = {}): { candidates: Candidate[]; stats: GenerateStats } {
  const max = o.max ?? MAX_CANDIDATES;
  const now = o.now ?? Date.now();
  const clock = o.clock ?? (() => performance.now());
  const budget = o.budgetMs ?? GENERATOR_BUDGET_MS;
  const t0 = clock();
  const stats: GenerateStats = { windows: 0, values: 0, nodes: 0, overBudget: false, ms: 0 };
  let tick = 0;
  const outOfTime = (): boolean => {
    if (++tick % CLOCK_EVERY !== 0) return false;
    if (clock() - t0 <= budget) return false;
    stats.overBudget = true;
    return true;
  };

  const windows = [...model.windows.values()]
    .filter((w) => w.window.windowId !== targetWindowId)
    .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt || b.updatedAt - a.updatedAt);
  const justLeft = model.windowBefore(targetWindowId);
  const recency = (w: WindowState): Recency =>
    w.window.windowId === justLeft ? "justLeft" : w.lastFocusedAt === 0 ? "unseen" : now - w.lastFocusedAt <= RECENT_MS ? "recent" : "earlier";

  const out: Candidate[] = [];
  const seen = new Set<string>();
  const full = (): boolean => out.length >= max;
  /** Adds a span unless the cap is reached or its text is already in; its context is worked out only then. */
  const prof = o.profile;
  const timed = <T>(part: keyof GeneratorProfile, f: () => T): T => {
    if (prof === undefined) return f();
    const t = performance.now();
    try {
      return f();
    } finally {
      prof[part] += performance.now() - t;
    }
  };
  const add = (w: WindowState, node: Node, text: string, kind: ValueKind | null, context: () => string | null): void => {
    if (full() || seen.has(text)) return;
    seen.add(text);
    out.push({
      id: `c${out.length + 1}`,
      text,
      kind,
      context: timed("context", context),
      section: timed("section", () => sectionAround(w, node)),
      blockHead: timed("blockHead", () => blockHead(w, node, text)),
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
  const touched = new Set<string>();
  const finish = (): { candidates: Candidate[]; stats: GenerateStats } => {
    stats.windows = touched.size;
    stats.ms = clock() - t0;
    return { candidates: out, stats };
  };

  for (const w of windows) {
    if (full()) return finish();
    touched.add(w.window.windowId);
    for (const v of w.values) {
      if (full() || outOfTime()) return finish();
      stats.values++;
      const node = w.nodes.get(v.nodeKey);
      if (node === undefined) continue;
      add(w, node, v.text, v.kind, () => contextFor(w, node, v.text));
    }
  }
  for (const w of windows) {
    if (full()) break;
    touched.add(w.window.windowId);
    for (const node of w.nodes.values()) {
      if (full() || outOfTime()) return finish();
      stats.nodes++;
      const isSourceField = node.editable === true && (node.value ?? "").length > 0 && !node.states?.includes("secure");
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      const lines = timed("split", () => nodeText(node).split(/\r?\n/));
      for (const raw of lines) {
        // A node can hold thousands of lines (a log, a transcript), so the cap and the clock apply per line too.
        if (full() || outOfTime()) return finish();
        const line = raw.replace(/\s+/g, " ").trim();
        if (line.length < MIN_LINE || line.length > MAX_LINE || !/[\p{L}\p{N}]/u.test(line)) continue;
        if (line.endsWith(":")) continue; // a label, not a value
        const m = LABELLED.exec(line);
        if (m !== null && m[1] !== undefined && m[2] !== undefined) {
          const label = m[1].trim();
          add(w, node, m[2].trim(), null, () => label);
          continue;
        }
        add(w, node, line, null, () =>
          lines.length === 1 ? (isSourceField ? (node.label ?? nearestText(w, node, true)) : nearestText(w, node, true)) : null,
        );
      }
    }
  }
  return finish();
}

/** The candidates for a fill; see collectCandidates. */
export function generateCandidates(model: ScreenModel, targetWindowId: string, max = MAX_CANDIDATES, now = Date.now()): Candidate[] {
  return collectCandidates(model, targetWindowId, { max, now }).candidates;
}

/**
 * How many distinct spans the generator could offer with no cap: a cheap full pass for the audit,
 * which works out no labels, sections or blocks.
 */
export function countSpans(model: ScreenModel, targetWindowId: string): { spans: number; typed: number } {
  const seen = new Set<string>();
  let typed = 0;
  for (const w of model.windows.values()) {
    if (w.window.windowId === targetWindowId) continue;
    for (const v of w.values) {
      if (!w.nodes.has(v.nodeKey) || seen.has(v.text)) continue;
      seen.add(v.text);
      typed++;
    }
  }
  for (const w of model.windows.values()) {
    if (w.window.windowId === targetWindowId) continue;
    for (const node of w.nodes.values()) {
      const isSourceField = node.editable === true && (node.value ?? "").length > 0 && !node.states?.includes("secure");
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      for (const raw of nodeText(node).split(/\r?\n/)) {
        const line = raw.replace(/\s+/g, " ").trim();
        if (line.length < MIN_LINE || line.length > MAX_LINE || !/[\p{L}\p{N}]/u.test(line) || line.endsWith(":")) continue;
        const m = LABELLED.exec(line);
        seen.add(m !== null && m[2] !== undefined ? m[2].trim() : line);
      }
    }
  }
  return { spans: seen.size, typed };
}

function contextFor(w: WindowState, node: Node, span: string): string | null {
  for (const line of nodeText(node).split(/\r?\n/)) {
    const m = LABELLED.exec(line.trim());
    if (m !== null && m[1] !== undefined && m[2]?.includes(span)) return m[1].trim();
  }
  if (node.editable === true && node.label !== undefined) return node.label;
  return nearestText(w, node, true);
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

/** Each window state's nodes by parent key, in document order, built once per state for blockHead. */
const childIndex = new WeakMap<WindowState, Map<string, Node[]>>();

function childrenOf(w: WindowState, parent: string): Node[] {
  let idx = childIndex.get(w);
  if (idx === undefined) {
    idx = new Map();
    for (const n of w.nodes.values()) {
      if (n.parent === null) continue;
      const list = idx.get(n.parent);
      if (list === undefined) idx.set(n.parent, [n]);
      else list.push(n);
    }
    childIndex.set(w, idx);
  }
  return idx.get(parent) ?? [];
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
    for (const n of childrenOf(w, node.parent)) {
      if (!LINE_ROLES.has(n.role)) continue;
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
