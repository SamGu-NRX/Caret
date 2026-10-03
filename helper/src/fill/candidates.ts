// The grounded-fill candidate generator. It collects short spans from every window other than
// the form's own: typed values first, then single lines of visible text, splitting "Label: value"
// lines so the value is the span and the label is its context. Jev later picks among these by id,
// and code copies the chosen span verbatim.
import type { FillSource, Node, TypedValue, ValueKind } from "../protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { nearestText } from "./descriptor.ts";
import { heldAsConversation, type SnippetLedger } from "../privacy.ts";
import { isKindTerm, kindTerm, overlap, words } from "./kinds.ts";

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
  /**
   * The request's screen-text budget. A candidate goes in only when its text and facts fit its window's
   * budget; the first that does not closes that window to the rest of the generator. Absent for the
   * audit's measures, which send nothing.
   */
  ledger?: SnippetLedger;
  /** Windows that give no candidates: the first look leaves out windows the reader could not walk just now. */
  exclude?: ReadonlySet<string>;
  /**
   * The form's fields as terms (kinds.ts fieldTerms), nearest the trigger first. With a ledger, a
   * conversation's budget goes first to the spans whose line and section share the most terms with each
   * field in turn, and only then to the rest in screen order: the cap holds a chat to a few hundred
   * characters, and in screen order those went to whatever came first (B11's replay filled 18 of 78
   * answerable fields with the sources as Messages windows).
   */
  fields?: readonly ReadonlySet<string>[];
}

/** Wall milliseconds per part of one generator call: splitting node text into lines, and the three facts worked out per kept span. */
export interface GeneratorProfile {
  split: number;
  context: number;
  section: number;
  blockHead: number;
}

export interface Collected {
  candidates: Candidate[];
  stats: GenerateStats;
  /** Windows the ledger closed: a span of theirs did not fit their budget, so what followed it was not offered. */
  cut: string[];
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
export function collectCandidates(model: ScreenModel, targetWindowId: string, o: GenerateOptions = {}): Collected {
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
    .filter((w) => w.window.windowId !== targetWindowId && o.exclude?.has(w.window.windowId) !== true)
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
  /** Windows whose budget a candidate did not fit; nothing more is taken from them. */
  const closed = new Set<string>();
  /** Windows a span of which did not fit their budget, closed or not. */
  const missed = new Set<string>();
  /** The candidate for a span, with every fact about it worked out. */
  const build = (w: WindowState, node: Node, text: string, kind: ValueKind | null, context: () => string | null): Candidate => ({
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
  /**
   * Adds a span unless the cap is reached, its text is already in, or its window is closed. A span that
   * does not fit its window's budget closes the window.
   */
  const add = (w: WindowState, node: Node, text: string, kind: ValueKind | null, context: () => string | null): void => {
    if (full() || seen.has(text) || closed.has(w.window.windowId)) return;
    const c = build(w, node, text, kind, context);
    if (o.ledger !== undefined && !o.ledger.take(w, "candidate", candidateTexts(c))) {
      missed.add(w.window.windowId);
      closed.add(w.window.windowId);
      return;
    }
    seen.add(text);
    out.push(c);
  };
  const touched = new Set<string>();
  const finish = (): Collected => {
    stats.windows = touched.size;
    stats.ms = clock() - t0;
    return { candidates: out, stats, cut: [...missed] };
  };

  /** Conversations whose budget went by relevance; the line pass leaves them alone. */
  const ranked = new Set<string>();
  const relevance = o.fields !== undefined && o.fields.length > 0 && o.ledger !== undefined ? o.fields : null;

  /**
   * Every span of a conversation, typed values first and then lines as the two passes below would take
   * them, each with the terms of its line, its section and the kinds of typed values it holds; then adds
   * them in relevance order. False when the cap or the clock ran out.
   */
  const byRelevance = (w: WindowState, fields: readonly ReadonlySet<string>[]): boolean => {
    const spans: { node: Node; text: string; kind: ValueKind | null; context: () => string | null; terms: Set<string> }[] = [];
    const sections = new Map<string, string[]>();
    const sectionWords = (n: Node): string[] => {
      let ws = sections.get(n.key);
      if (ws === undefined) sections.set(n.key, (ws = words(sectionAround(w, n))));
      return ws;
    };
    const valuesOf = new Map<string, TypedValue[]>();
    for (const v of w.values) {
      const list = valuesOf.get(v.nodeKey);
      if (list === undefined) valuesOf.set(v.nodeKey, [v]);
      else list.push(v);
    }
    const termsOf = (n: Node, line: string, kinds: Iterable<ValueKind>): Set<string> => {
      const t = new Set([...words(line), ...sectionWords(n)]);
      for (const k of kinds) t.add(kindTerm(k));
      return t;
    };
    for (const v of w.values) {
      if (outOfTime()) return false;
      stats.values++;
      const node = w.nodes.get(v.nodeKey);
      if (node === undefined) continue;
      spans.push({ node, text: v.text, kind: v.kind, context: () => contextFor(w, node, v.text), terms: termsOf(node, lineHolding(nodeText(node), v.text), [v.kind]) });
    }
    for (const node of w.nodes.values()) {
      if (outOfTime()) return false;
      stats.nodes++;
      const isSourceField = node.editable === true && (node.value ?? "").length > 0 && !node.states?.includes("secure");
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      const lines = timed("split", () => nodeText(node).split(/\r?\n/));
      for (const raw of lines) {
        if (outOfTime()) return false;
        const s = spanOfLine(raw);
        if (s === null) continue;
        const kinds = (valuesOf.get(node.key) ?? []).filter((v) => s.line.includes(v.text)).map((v) => v.kind);
        const context = s.label !== null ? constant(s.label) : () => lineContext(w, node, lines.length, isSourceField);
        spans.push({ node, text: s.text, kind: null, context, terms: termsOf(node, s.line, kinds) });
      }
    }
    // Round robin over the fields: each field's best span, then each field's second best, and so on.
    const lists = fields.map((f) =>
      spans
        .map((sp, i) => [overlap(f, sp.terms), i] as const)
        .filter(([n]) => n > 0)
        .sort((a, b) => b[0] - a[0] || a[1] - b[1])
        .map(([, i]) => i),
    );
    const order: number[] = [];
    const used = new Set<number>();
    for (let r = 0; lists.some((l) => r < l.length); r++) {
      for (const l of lists) {
        const i = l[r];
        if (i !== undefined && !used.has(i)) (used.add(i), order.push(i));
      }
    }
    for (let i = 0; i < spans.length; i++) if (!used.has(i)) order.push(i);
    // A kind some field takes goes in whole or not at all: every typed value of it in the window, each
    // with all its facts, in one take, kind by kind in the order the fields first want them. A kind that
    // does not fit is left out whole, so cutKinds reports it and fill withholds its fields, and the budget
    // goes on to the next kind. So a field is asked only when every value of its kind in the window is
    // offered, and offered as fully as a window that is not a conversation would offer it: no value is
    // missing, and none lost the facts (label, section, block) that set it apart from another. The first
    // B12 replays spent a conversation's budget value by value: four values with facts used up a
    // 220-character Messages window, and values let in bare, to fit, let Jev take a padding thread's
    // meeting link for the form's (~/.caret-run/evidence/screen/b12/live-run5).
    const kinds = new Set(fields.flatMap((f) => [...f].filter(isKindTerm)));
    const takesKind = (i: number): boolean => {
      const k = spans[i]?.kind;
      return k !== null && k !== undefined && kinds.has(kindTerm(k));
    };
    const kindOrder = [...new Set(order.filter(takesKind).map((i) => spans[i]?.kind as ValueKind))];
    /** Kinds left out whole; a line holding a value of one stays out too. */
    const leftOut = new Set<string>();
    for (const k of kindOrder) {
      if (full() || outOfTime()) return false;
      const group: Candidate[] = [];
      const texts = new Set<string>();
      for (const i of order) {
        const sp = spans[i] as (typeof spans)[number];
        if (sp.kind !== k || seen.has(sp.text) || texts.has(sp.text)) continue;
        texts.add(sp.text);
        group.push(build(w, sp.node, sp.text, sp.kind, sp.context));
      }
      if (group.length === 0) continue;
      if (out.length + group.length > max || o.ledger?.take(w, "candidate", group.flatMap(candidateTexts)) !== true) {
        missed.add(w.window.windowId);
        leftOut.add(kindTerm(k));
        continue;
      }
      for (const c of group) {
        c.id = `c${out.length + 1}`;
        seen.add(c.text);
        out.push(c);
      }
    }
    // Then the rest, nearest the fields first, with their facts, until one does not fit.
    for (const i of order.filter((x) => !takesKind(x))) {
      if (full() || outOfTime()) return false;
      if (closed.has(w.window.windowId)) break;
      const sp = spans[i] as (typeof spans)[number];
      if ([...sp.terms].some((t) => leftOut.has(t))) continue;
      add(w, sp.node, sp.text, sp.kind, sp.context);
    }
    return true;
  };

  for (const w of windows) {
    if (full()) return finish();
    touched.add(w.window.windowId);
    if (relevance !== null && heldAsConversation(w)) {
      ranked.add(w.window.windowId);
      if (!byRelevance(w, relevance)) return finish();
      continue;
    }
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
    if (closed.has(w.window.windowId) || ranked.has(w.window.windowId)) continue;
    for (const node of w.nodes.values()) {
      if (full() || outOfTime()) return finish();
      stats.nodes++;
      const isSourceField = node.editable === true && (node.value ?? "").length > 0 && !node.states?.includes("secure");
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      const lines = timed("split", () => nodeText(node).split(/\r?\n/));
      for (const raw of lines) {
        // A node can hold thousands of lines (a log, a transcript), so the cap and the clock apply per line too.
        if (full() || outOfTime()) return finish();
        const s = spanOfLine(raw);
        if (s === null) continue;
        add(w, node, s.text, null, s.label !== null ? constant(s.label) : () => lineContext(w, node, lines.length, isSourceField));
      }
    }
  }
  return finish();
}

const constant =
  <T>(x: T): (() => T) =>
  () =>
    x;

/**
 * The span a screen line offers: a "Label: value" line offers its value, with the label as context; a
 * line too short or too long to be a value, with no letter or digit, or ending in a colon offers none.
 */
function spanOfLine(raw: string): { line: string; text: string; label: string | null } | null {
  const line = raw.replace(/\s+/g, " ").trim();
  if (line.length < MIN_LINE || line.length > MAX_LINE || !/[\p{L}\p{N}]/u.test(line)) return null;
  if (line.endsWith(":")) return null; // a label, not a value
  const m = LABELLED.exec(line);
  if (m !== null && m[1] !== undefined && m[2] !== undefined) return { line, text: m[2].trim(), label: m[1].trim() };
  return { line, text: line, label: null };
}

/** The context of an unlabelled line: for a one-line node, its field label or the nearest label text. */
function lineContext(w: WindowState, node: Node, lines: number, isSourceField: boolean): string | null {
  if (lines !== 1) return null;
  return isSourceField ? (node.label ?? nearestText(w, node, true)) : nearestText(w, node, true);
}

/** The line of a node's text that holds a span, found by search rather than by splitting the whole text. */
function lineHolding(text: string, span: string): string {
  const at = text.indexOf(span);
  if (at < 0) return span;
  const nl = text.indexOf("\n", at);
  return text.slice(text.lastIndexOf("\n", at) + 1, nl < 0 ? text.length : nl);
}

/** The candidates for a fill; see collectCandidates. With a ledger, each window gives only what fits its budget. */
export function generateCandidates(model: ScreenModel, targetWindowId: string, max = MAX_CANDIDATES, now = Date.now(), ledger?: SnippetLedger, exclude?: ReadonlySet<string>): Candidate[] {
  return collectCandidates(model, targetWindowId, { max, now, ...(ledger === undefined ? {} : { ledger }), ...(exclude === undefined ? {} : { exclude }) }).candidates;
}

/**
 * The kinds of value the privacy budget kept out of a request: each typed value (the reader's, with its
 * kind) of a window the ledger cut that no candidate text taken into the request contains. A value
 * offered from another window, or inside a longer line that was taken, is not kept out.
 */
export function cutKinds(model: ScreenModel, cut: readonly string[], ledger: SnippetLedger): Set<ValueKind> {
  const out = new Set<ValueKind>();
  if (cut.length === 0) return out;
  // One string, so each value is one search; NUL appears in no screen text, so a match never spans two texts.
  const taken = ledger.snippets.filter((s) => s.kind === "candidate").map((s) => s.text).join("\u0000");
  for (const id of cut) {
    const w = model.windows.get(id);
    if (w === undefined) continue;
    for (const v of w.values) if (!out.has(v.kind) && w.nodes.has(v.nodeKey) && !taken.includes(v.text)) out.add(v.kind);
  }
  return out;
}

/** The kinds of the reader's typed values a candidate's text holds, its own kind included. */
export function candidateKinds(model: ScreenModel, c: Candidate): Set<ValueKind> {
  const out = new Set<ValueKind>(c.kind === null ? [] : [c.kind]);
  for (const v of model.windows.get(c.source.windowId)?.values ?? []) {
    if (c.text.includes(v.text) || (v.nodeKey === c.source.nodeKey && v.text.includes(c.text))) out.add(v.kind);
  }
  return out;
}

/** The screen text describeCandidate puts in a request for this candidate: the span, its facts, and its window's title. */
export function candidateTexts(c: Candidate): (string | null)[] {
  return [c.text, c.context, c.blockHead, c.section, c.source.windowTitle];
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

/**
 * The label of the first "Label: value" line of the node whose value holds the span; else the field's
 * own label, or the nearest label text. Only lines holding the span can match, so it searches the text
 * for the span instead of splitting all of it: a typed value in a long log or transcript would
 * otherwise split the whole node again for every value (B8 measured 20 ms per focus on one 220 KB node).
 */
function contextFor(w: WindowState, node: Node, span: string): string | null {
  const text = nodeText(node);
  for (let at = text.indexOf(span); at >= 0; ) {
    const start = text.lastIndexOf("\n", at) + 1;
    const nl = text.indexOf("\n", at);
    const m = LABELLED.exec(text.slice(start, nl < 0 ? text.length : nl).trim());
    if (m !== null && m[1] !== undefined && m[2]?.includes(span)) return m[1].trim();
    if (nl < 0) break;
    at = text.indexOf(span, nl + 1);
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
  const text = nodeText(node);
  const own = firstLines(text);
  let head: string | undefined;
  if (own.more) head = own.first;
  else if (node.parent !== null) {
    const section = w.nodes.get(node.parent)?.label;
    for (const n of childrenOf(w, node.parent)) {
      if (!LINE_ROLES.has(n.role)) continue;
      const t = nodeText(n);
      const nl = t.indexOf("\n");
      const first = (nl < 0 ? t : t.slice(0, nl)).trim();
      if (first.length === 0 || first === section) continue;
      head = first;
      break;
    }
  }
  // With two lines of its own, the node's trimmed text holds a line break, so it cannot equal one line.
  if (head === undefined || head.includes(span) || (!own.more && head === text.trim())) return null;
  return short(head);
}

/**
 * The first non-empty trimmed line of a text, and whether another non-empty line follows, reading only
 * as far as that second line: the node may be a whole log, and this runs for every span kept from it.
 */
function firstLines(text: string): { first: string | undefined; more: boolean } {
  let first: string | undefined;
  for (let start = 0; start <= text.length; ) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(start, end).trim();
    if (line.length > 0) {
      if (first !== undefined) return { first, more: true };
      first = line;
    }
    if (nl < 0) break;
    start = nl + 1;
  }
  return { first, more: false };
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
