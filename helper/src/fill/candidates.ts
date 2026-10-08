// The grounded-fill candidate generator. It collects short spans from every window other than
// the form's own: typed values first, then single lines of visible text, splitting "Label: value"
// lines so the value is the span and the label is its context. Jev later picks among these by id,
// and code copies the chosen span verbatim.
import { Disclosure, viewHolds, type ModelText } from "../privacy/disclosure.ts";
import { ValueKind, type FillSource, type Node, type TypedValue } from "../protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { nearestLabel, nearestText } from "./descriptor.ts";
import { heldAsConversation, type ViewSpan } from "../privacy.ts";
import { isKindTerm, isNameLike, kindTerm, NAME_TERM, namesIn, namesInAt, overlap, textKind, valueKinds, words } from "./kinds.ts";
import { labelKind, sensitiveKind, valueKind } from "../memory/sensitive.ts";
import { bareLine, clauseSpan, LABELLED, lineTexts, lineValues, partSpan, sentenceSpan, rawURLToken, WARNS } from "./line-values.ts";
import { redactWindow } from "./redact.ts";
import { WITHHELD } from "../privacy/exclude.ts";
import { splitDate } from "./derive.ts";
import { collapsedMap, collapsedRange, eachLine, lineEndAt, lineStartAt, linesWithStarts, nextLineStart, nodePart, nodeTexts, sourceLine, splitLines, TITLE, wholePart, type SourceAt } from "../privacy/ledger/source.ts";

/** At most `max` lines of `text`, split one at a time (source.ts eachLine). */
function* linesUpTo(text: string, max: number): Generator<string> {
  let k = 0;
  for (const l of eachLine(text)) {
    if (++k > max) return;
    yield l;
  }
}

/**
 * A field whose typed value is a candidate, as a line of text is: editable, holding text, not secure, not a kind memory
 * never keeps. A page checkbox is editable too since D2-04 (engines/page-link.ts), but what it holds, "checked", is its
 * state, not text anyone typed.
 */
function sourceField(node: Node): boolean {
  return node.editable === true && (node.value ?? "").length > 0 && !node.states?.includes("secure") && labelKind(node.label) === null && node.role !== "AXCheckBox";
}

/**
 * Whether every text of `c`'s line stands in its source view as a mint requires (Disclosure viewHolds): the one source-
 * membership contract collection and rendering share. A recorded range is held to its text by the mint itself.
 */
export function mintable(view: WindowState, c: Candidate): boolean {
  return candidateTexts(c).every((t) => t === null || t === "" || viewHolds(view, t));
}

/** An association's key: a window, the section or block a span sits in, and the label it is read beside. */
export function associationKey(windowId: string, place: string | null, label: string): string {
  return `${windowId}\u0000${place ?? ""}\u0000${label}`;
}

/** A candidate's association (associationKey): its window, its section or else its block head, and its label. */
export function associationOf(c: Candidate): string {
  return associationKey(c.source.windowId, c.section ?? c.blockHead, c.context ?? "");
}

/**
 * Where a candidate's texts were read (OUTPUT-LEDGER-SPEC section 4), as ranges of its source window's text parts:
 * its span, and the clause it quotes with that clause's text. The seal charges these ranges as they are. A text with
 * no range here (a copy fill made, a part code derived) is charged every line of its window that holds it.
 */
export interface CandidateSource {
  /** The redacted view the ranges are of: a mint from another view object uses none of them. */
  readonly view?: WindowState;
  readonly text?: SourceAt;
  readonly line?: Fact;
  readonly context?: Fact;
  readonly section?: Fact;
  readonly blockHead?: Fact;
}

/** A text the generator read, with its source range. */
export interface Fact {
  readonly text: string;
  readonly at: SourceAt;
}

/** A text and its source range, or the text alone when its source has none (another node's text cut down, a copy). */
type Read = { readonly text: string; readonly at: SourceAt | null };
const factOf = (r: Read | null): Fact | undefined => (r === null || r.at === null ? undefined : { text: r.text, at: r.at });
const SOURCES = new WeakMap<Candidate, CandidateSource>();

/** Where `c`'s texts were read, as far as the generator recorded it. */
export function sourceOf(c: Candidate): CandidateSource {
  return SOURCES.get(c) ?? {};
}

/**
 * Where each text of `c`'s line was read, as declared spans: its recorded range, or the text itself (every line holding
 * it). candidateTexts' texts, in the same admission, so a candidate goes in with all its facts or not at all, and its
 * line mints later at no further charge (mintCandidate).
 */
export function candidateSpans(c: Candidate): ViewSpan[] {
  const src = SOURCES.get(c);
  const view = src?.view;
  if (src === undefined || view === undefined) return [];
  const out: ViewSpan[] = [];
  const add = (t: string | null | undefined, read: Fact | SourceAt | undefined): void => {
    if (t === null || t === undefined || t === "") return;
    const at = read === undefined ? undefined : "part" in read ? read : read.text === t ? read.at : undefined;
    out.push(at === undefined ? { view, text: t } : { view, at });
  };
  add(c.text, src.text);
  if (c.context !== c.text) add(c.context, src.context);
  add(c.line, src.line);
  add(c.blockHead, src.blockHead);
  if (c.section !== c.context) add(c.section, src.section);
  if (c.source.windowTitle !== "") add(c.source.windowTitle, c.source.windowTitle === view.window.title ? wholePart(TITLE, view.window.title) : undefined);
  return out;
}

/** A clause of `c` (Candidate.line, set once spans are in) with where it was read, for its own admission. */
export function clauseSpans(c: Candidate, clause: string): ViewSpan[] {
  const src = SOURCES.get(c);
  if (src?.view === undefined) return [];
  return [src.line?.text === clause ? { view: src.view, at: src.line.at } : { view: src.view, text: clause }];
}

/** `copy`, a copy of `c` with the same texts (another id), with `c`'s source ranges. */
export function withSources<C extends Candidate>(copy: C, c: Candidate): C {
  const src = SOURCES.get(c);
  if (src !== undefined) SOURCES.set(copy, src);
  return copy;
}

/**
 * The part and raw offset that offset `i` of nodeText(node) came from, or null for the line break nodeText puts
 * between a label and a value. One map, through the label/value join; bareMap continues it through bareLine.
 */
function partOffset(node: Node, i: number): { part: string; offset: number } | null {
  if (node.editable === true) return { part: nodePart(node.key, "value"), offset: i };
  if (node.label !== undefined && node.value !== undefined) {
    if (i < node.label.length) return { part: nodePart(node.key, "label"), offset: i };
    if (i === node.label.length) return null;
    return { part: nodePart(node.key, "value"), offset: i - node.label.length - 1 };
  }
  return { part: nodePart(node.key, node.value !== undefined ? "value" : "label"), offset: i };
}

/** The source range of nodeText(node) from `from` to `to`, or null when it is empty or crosses the label/value join. */
export function nodeRange(node: Node, from: number, to: number): SourceAt | null {
  if (to <= from) return null;
  const a = partOffset(node, from);
  const b = partOffset(node, to - 1);
  if (a === null || b === null || a.part !== b.part) return null;
  return { part: a.part, start: a.offset, end: b.offset + 1 };
}

/** bareLine(raw), with the offset in `raw` each of its characters came from: collapsedMap, less a list bullet. */
export function bareMap(raw: string): { line: string; from: number[] } {
  const { text, from } = collapsedMap(raw);
  const bullet = BULLET_PREFIX.exec(text);
  const cut = bullet === null ? 0 : bullet[0].length;
  return { line: text.slice(cut), from: cut === 0 ? from : from.slice(cut) };
}
const BULLET_PREFIX = /^(?:[-*•·–—]|•) /u;

/**
 * The source range of `text` read from the line of nodeText(node) that starts at `lineStart` and reads `raw`: at `pos`
 * in bareLine(raw) when the reader knows it, else where it first stands in that line. Null when the line does not hold
 * it or it crosses the label/value join.
 */
function lineRange(node: Node, lineStart: number, raw: string, text: string, pos: number | undefined): SourceAt | null {
  // No search: a text whose reader gave no position has the whole line as its source (the fallback).
  if (text === "" || pos === undefined) return null;
  const { line, from } = bareMap(raw);
  const p = pos;
  if (p < 0 || line.slice(p, p + text.length) !== text) return null;
  return nodeRange(node, lineStart + from[p]!, lineStart + from[p + text.length - 1]! + 1);
}

/**
 * The source range of `text` read from the line of nodeText(node) at `lineStart` reading `raw`, where `text`, less an
 * ellipsis Caret added at its end, stands at the start of that line collapsed (collapsedMap). Null otherwise.
 */
function lineHeadRange(node: Node, lineStart: number, raw: string, text: string): SourceAt | null {
  const r = collapsedRange("", raw, text);
  return r === null ? null : nodeRange(node, lineStart + r.start, lineStart + r.end);
}

/** The source range of `text` at the start of one of a node's own parts collapsed (its label, or its value). */
function partHeadRange(node: Node, part: "label" | "value", text: string): SourceAt | null {
  const raw = part === "label" ? node.label : node.value;
  return raw === undefined ? null : collapsedRange(nodePart(node.key, part), raw, text);
}

/** Where a span was read: a line of nodeText (its start there and its raw text), or an offset in nodeText. */
type Found = { readonly lineStart: number; readonly raw: string; readonly at?: number; readonly withAt?: number } | { readonly offset: number };

/**
 * The source range of the white-space-bounded token of nodeText(node) that holds offset `at` (rawURLToken's token), when
 * that token is `token`; null otherwise.
 */
function tokenRange(node: Node, at: number, token: string): SourceAt | null {
  const t = nodeText(node);
  let a = at;
  let b = at;
  while (a > 0 && !/\s/u.test(t[a - 1]!)) a--;
  while (b < t.length && !/\s/u.test(t[b]!)) b++;
  return t.slice(a, b) === token ? nodeRange(node, a, b) : null;
}

/** Where `found` puts a span as a line of nodeText and a position in it as bareLine reads it, or undefined when it says no position. */
function foundAt(node: Node, found: Found | undefined): { lineStart: number; raw: string; at: number } | undefined {
  if (found === undefined) return undefined;
  if (!("offset" in found)) return found.at === undefined ? undefined : { lineStart: found.lineStart, raw: found.raw, at: found.at };
  // An offset in nodeText: its line, and the place in that line's bareLine reading that maps back to it (bareMap).
  const t = nodeText(node);
  const lineStart = lineStartAt(t, found.offset);
  const raw = t.slice(lineStart, lineEndAt(t, found.offset));
  const at = bareMap(raw).from.indexOf(found.offset - lineStart);
  return at < 0 ? undefined : { lineStart, raw, at };
}

/** The source range of `text`, read where `found` says. */
function foundRange(node: Node, text: string, found: Found | undefined): SourceAt | null {
  if (found === undefined) return null;
  if ("offset" in found) return nodeText(node).slice(found.offset, found.offset + text.length) === text ? nodeRange(node, found.offset, found.offset + text.length) : null;
  return lineRange(node, found.lineStart, found.raw, text, found.at);
}

/** Each raw line of nodeText(node) with its start there, split as the inventory splits it (source.ts linesWithStarts). */
function nodeLines(node: Node): { raw: string; start: number }[] {
  return linesWithStarts(nodeText(node));
}

/** Whether `text` occurs in `raw` exactly once, overlapping occurrences counted. */
function standsOnce(raw: string, text: string): boolean {
  const at = raw.indexOf(text);
  return text !== "" && at >= 0 && raw.indexOf(text, at + 1) < 0;
}

/** Where a typed value was read: a code-found one's line or offset (windowValues), else where it first stands in its node's text. */
function valueFound(node: Node, v: TypedValue): Found | undefined {
  const off = sourceOffsets.get(v);
  if (off !== undefined) return { offset: off };
  const line = valueLines.get(v);
  if (line !== undefined) return line;
  // A reader's typed value says its node and its text exactly as the node's text has it (protocol.ts TypedValue), not
  // its offset. Standing there once, it was read there; standing there twice or more, which one is not known, and its
  // source is the whole lines that hold it (the fallback), never the first of them.
  const t = nodeText(node);
  return standsOnce(t, v.text) ? { offset: t.indexOf(v.text) } : undefined;
}

export interface Candidate {
  id: string;
  text: string;
  kind: ValueKind | null;
  /** The label the span sits next to in its source window, if code found one. */
  context: string | null;
  /**
   * True when `context` is the label of a "Label: value" line holding the span ("Name: Jordan Reyes"), rather
   * than text found near it. Fill trusts such a line as naming what the value is (fill.ts anchors).
   */
  labelled?: boolean;
  /**
   * C1: the clause of the line a typed or bounded span sits in, when the line says more than a label does: a line over
   * MAX_LINE characters, which is not offered whole, or one that shows two values of the span's kind ("Cell: 555-0147.
   * Don't give out 555-0112, …"). Jev reads it to tell the value the line gives from one it warns about.
   */
  line?: string | null;
  /**
   * W1: the labelled value this span was cut from, when it is a part of one (line-values.ts LineText.partOf): only a
   * field that takes one value may take it (fill.ts).
   */
  partOf?: string;
  /**
   * G2: the memory entry this text is exactly, when it is the user's own email, phone or full name (whose.ts
   * identityOf): code decides such a value is the user's without asking. Its label goes through the ledger as memory.
   */
  identity?: CandidateIdentity;
  /** G2: where the span sits, as code reads its window (whose.ts placementsOf); shown to Jev in whose-value questions. */
  placements?: readonly Placement[];
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

/** G2: a candidate that is exactly one of the user's own identities from memory (whose.ts identityOf). */
export interface CandidateIdentity {
  memoryId: string;
  kind: "email" | "phone" | "name";
  /** The memory entry's label ("primary email"), which the value question quotes. */
  label: string;
  /** The identity as fill compared it (whose.ts identityKey), which a recheck compares the entry with again. */
  key: string;
}

/**
 * G2: where a candidate sits, read by code from its window (whose.ts placementsOf), for Jev to weigh in a whose-value
 * question, never as a rule. `soleRecipient`: on the To: line of a mail, as its only recipient. `toUsersAddress`: on a
 * To: line whose one address is the user's own email from memory. `namesOther`: in a sentence that names someone other
 * than the user ("my husband Marcus Cole, …"). HA2 removed `ownNoteAlone` ("in a sentence that names no other person"):
 * one sentence can't say whose a value is (whose.ts header).
 */
export type Placement = "soleRecipient" | "toUsersAddress" | "namesOther";
export const PLACEMENT_SAYS = {
  soleRecipient: "it is the only recipient on the To: line of this mail",
  toUsersAddress: "it is on a To: line whose address is the email the user told Caret is theirs",
  namesOther: "it is in a sentence that names someone other than the user",
} as const satisfies Record<Placement, string>;

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
 * floor(15 ms / 0.025 ms per visit) = 600 visits. The denominator is the p95 of thread-CPU ms / guard
 * visits over all 1,590 idle-fixed generator calls in ~/.caret-run/evidence/screen/budget/idle-fixed/
 * measurements.json and v4.json, measured on an M4 Pro. The 15 ms allocation leaves room for fields and
 * descriptors in the helper's 20 ms focus-work goal; it is not a wall-time ceiling. A fixed work cap
 * keeps the same screen's candidates independent of scheduler load.
 */
export const MAX_GENERATOR_VISITS = 600;
const MIN_LINE = 2;
export const MAX_LINE = 80;
const LINE_ROLES = new Set(["AXStaticText", "AXCell", "AXHeading", "AXLink"]);
/**
 * C1: how much of a node's text code scans for typed values, as the reader scans (TypedValues.swift maxScan): a longer
 * text is a document, read on its first screenful.
 */
const MAX_SCAN = 4000;
/**
 * Spans of a cut window that are not a conversation read for what they left out (leftOut) before the rest
 * counts as unread. Assumed: far above a note or a mail, below a log the generator should not read whole.
 */
const LEFT_OUT_MAX = 2000;
/**
 * Nodes, lines and typed values of a window the cap stopped in, or never reached, read for what it may hold
 * (unreadRest), each one counted, a repeated line too; past it the rest is unknown and everything is withheld. A chosen
 * cap, LEFT_OUT_MAX's size, not a tuned one: no fixture desk needs the pass, so nothing measured its effect on recall.
 * The scan prototype in ~/.caret-run/evidence/screen/pv2/simplify/cap-binding.md read at most 1,280 in one window of
 * a synthetic realistic desk, so the cap is above that one desk and nothing more.
 */
const UNREAD_MAX = 2000;
/**
 * Visits a conversation's listing may spend (rankWindow), newest message first; its older messages past the share are
 * read for what they hold instead (unreadRest). Half of MAX_GENERATOR_VISITS, chosen so a long conversation leaves the
 * other windows half the budget. It binds on no fixture desk the cap-binding measurement covered (at most 192 visits for
 * a whole desk, ~/.caret-run/evidence/screen/pv2/simplify/cap-binding.md); what it does on long chats is measured on the
 * long-conversation set (fixtures/longchat), not tuned there.
 */
const CONVERSATION_LIST_SHARE = 300;
/** Nodes and lines a window's own reading for typed values reads (windowValues), counted as read: UNREAD_MAX's size, chosen. */
const EXTRACT_MAX = UNREAD_MAX;
const INCOMPLETE = new WeakSet<WindowState>();
/** Whether windowValues stopped at EXTRACT_MAX in `w`, so its values are not all known. */
export function valuesIncomplete(w: WindowState): boolean {
  return INCOMPLETE.has(w);
}
/**
 * The kinds of typed value that make a line a contact line ("Dana Whitfield <dana@example.com>", "Priya,
 * (415) 555-0162"), whose names count as kept out when the line is cut (B14). A date or a time does not: "a
 * call with Priya Thursday 3pm PT" is a sentence, and counting "Priya Thursday" withheld every name on Q1's
 * forms (B24).
 */
const CONTACT_KINDS: ReadonlySet<ValueKind> = new Set(["email", "phone", "address"]);

export interface GenerateOptions {
  max?: number;
  now?: number;
  /** When given, wall time by part of the work is added to it, for the audit's probe. */
  profile?: GeneratorProfile;
  /**
   * The request's screen-text budget. A candidate goes in only when its text and facts fit its window's
   * budget; the first that does not closes that window to the rest of the generator. Absent for the
   * audit's measures, which send nothing.
   */
  ledger?: Disclosure;
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
  /**
   * False takes a conversation's kinds in the order the fields first want them, as B12 did, rather than
   * by cost per field served; for the live replay's comparison. The helper never sets it.
   */
  kindsByCost?: boolean;
  /**
   * False leaves a conversation's name-like lines ungrouped, as B13 did, for the live replay's
   * comparison. The helper never sets it.
   */
  nameGroup?: boolean;
  /**
   * C1: leave each span's clause (Candidate.line) to the caller, in Collected.clauses, instead of charging it once every
   * span is in: fill charges clauses after the user's own values from memory (fill.ts), so a clause never costs one.
   */
  deferClauses?: boolean;
  /**
   * Windows an Ask names (B26 lead decision 1) and the people it names: in those windows, the spans whose line or
   * section names one of the people go before the rest, in the order the fields would take them otherwise.
   */
  first?: { windows: ReadonlySet<string>; names: readonly string[] };
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
  /**
   * For fields whose label names no kind (fill.ts): the words of every line a cut conversation left out,
   * so such a field is withheld when a line about it may have been cut; and whether some other window was
   * cut, whose left-out lines were not read, so any such field may have lost its value.
   */
  cutTerms: ReadonlySet<string>;
  cutAll: boolean;
  /**
   * A field takes a name and a name may have been kept out: a conversation's names, or a line holding
   * one, did not fit; a window was cut whose left-out lines were not read; or either cap
   * stopped the generator partway through a window. Fill then asks no field that takes a name and
   * proposes no name-like value (fill.ts).
   */
  namesCut: boolean;
  /** C1: with GenerateOptions.deferClauses, each offered span's clause, for the caller to charge and set; empty otherwise. */
  clauses: ReadonlyMap<Candidate, string>;
  /**
   * The associations (window, section or block, label: associationOf) of spans not offered as their own: cut, left out,
   * or whose text another association already offered. An offered value of one of them is not the only value that
   * label gives there, so fill withholds a pick of it (fill.ts pickCut). Text is deduplicated in what is offered only.
   */
  omitted: ReadonlySet<string>;
}

export interface GenerateStats {
  /** Windows, typed values and nodes the generator looked at before it had enough or exhausted its visit cap. */
  windows: number;
  values: number;
  nodes: number;
  /** True when the visit cap was exhausted before the candidate cap or every window was read. */
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
  const t0 = performance.now();
  const stats: GenerateStats = { windows: 0, values: 0, nodes: 0, overBudget: false, ms: 0 };
  let visits = 0;
  const outOfWork = (): boolean => {
    if (++visits <= MAX_GENERATOR_VISITS) return false;
    stats.overBudget = true;
    return true;
  };

  const windows = [...model.windows.values()]
    .filter((w) => w.window.windowId !== targetWindowId && o.exclude?.has(w.window.windowId) !== true)
    // G2 round 4: every source window is read through its redacted view (redact.ts), the one place secrets are decided.
    .map(redactWindow)
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
  const build = (w: WindowState, node: Node, text: string, kind: ValueKind | null, context: () => Read | null, quote?: string, partOf?: string, sourceOffset?: number, found?: Found): Candidate | null => {
    const url = kind === "url" || textKind(text) === "url";
    const raw = url ? rawURLToken(nodeText(node), text, MAX_SCAN, sourceOffset) : null;
    if (url && raw === null) return null;
    const read = timed("context", context);
    const ctx = read?.text ?? null;
    const labelled = labelledSpan(node, text, ctx);
    // A span that must go with its line's words (line-values.ts LineText.with, or a clause its line warns in) carries them
    // from the start, charged with it; any other clause waits until every span is in.
    const where = foundAt(node, found ?? (sourceOffset === undefined ? undefined : { offset: sourceOffset }));
    const fact = quote !== undefined ? null : timed("context", () => lineFact(w, node, text, labelled, where));
    let required = quote ?? (fact?.required === true ? fact.clause : undefined);
    let requiredAt = quote !== undefined ? (found !== undefined && !("offset" in found) ? lineRange(node, found.lineStart, found.raw, quote, found.withAt) : null) : fact?.required === true ? fact.at : null;
    // The verifier must read the maximal raw token, not just the URL substring the extractor picked.
    // It is required context, so a budget cut withholds the URL instead of silently omitting its evidence.
    if (raw !== null && required?.includes(raw) !== true) {
      const source = nodeText(node);
      const line = lineHolding(source, text);
      // Keep any required clause and all raw tokens in one verbatim excerpt, not just the first occurrence's line.
      const start = Math.min(source.indexOf(line), source.indexOf(raw));
      const end = Math.max(source.indexOf(line) + line.length, source.indexOf(raw) + raw.length);
      required = required === undefined ? raw : source.slice(start, end);
      // Its range only where the token was read at a known offset: the token is what runs to white space either side of it.
      // Where the value was read in nodeText: its recorded offset, or its line's start and its place in that line.
      const valueAt = sourceOffset ?? (where === undefined ? undefined : where.lineStart + (bareMap(where.raw).from[where.at] ?? -where.lineStart - 1));
      // Only when the excerpt is that one token: an excerpt of every occurrence (rawURLToken with no offset) has none.
      requiredAt = required === raw && valueAt !== undefined && valueAt >= 0 ? tokenRange(node, valueAt, raw) : null;
    }
    const clause = required !== undefined || fact === null || fact.required ? null : fact.clause;
    const sec = timed("section", () => sectionRead(w, node));
    const head = timed("blockHead", () => blockHeadRead(w, node, text));
    const c: Candidate = {
    id: `c${out.length + 1}`,
    text,
    kind,
    context: ctx,
    labelled,
    line: required ?? null,
    ...(partOf === undefined ? {} : { partOf }),
    section: sec?.text ?? null,
    blockHead: head?.text ?? null,
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
    };
    if (clause !== null) clauses.set(c, clause);
    if (required !== undefined) quoted.add(c);
    const textAt = foundRange(node, text, found ?? (sourceOffset === undefined ? undefined : { offset: sourceOffset }));
    const lineText = required ?? clause;
    const lineAt = required !== undefined ? requiredAt : clause !== null ? (fact?.at ?? null) : null;
    SOURCES.set(c, {
      view: w,
      ...(textAt === null ? {} : { text: textAt }),
      ...(lineText === null || lineAt === null || lineAt === undefined ? {} : { line: { text: lineText, at: lineAt } }),
      context: factOf(read),
      section: factOf(sec),
      blockHead: factOf(head),
    });
    return c;
  };
  /** Spans that go only with their clause (Candidate.line set at build). */
  const quoted = new WeakSet<Candidate>();
  /**
   * Texts left out because their warning did not fit: the same text found later with no warning beside it is left out
   * too, so it cannot stand in for the warned one, and the cut rules still count it as kept out (C1 review).
   */
  const unwarned = new Set<string>();
  /** Whether a span holds a text left out for its warning, whole ("555-0101 ext 42" holds "555-0101"). */
  const holdsUnwarned = (text: string): boolean => unwarned.size > 0 && [...unwarned].some((u) => holdsWhole(text, u));
  /**
   * C1: the clause each span would quote (Candidate.line), set only once every span is in (finish): a clause is worth a
   * window's budget only after every value that fits, so it never pushes another span out. Spent first, clauses took
   * the room of the lines a field's terms matched, and the cut rule then withheld those fields (corpus clinic-intake).
   */
  const clauses = new Map<Candidate, string>();
  /**
   * Adds a span unless the cap is reached, its text is already in, or its window is closed. A span that
   * does not fit its window's budget closes the window.
   */
  const add = (w: WindowState, node: Node, text: string, kind: ValueKind | null, context: () => Read | null, quote?: string, partOf?: string, sourceOffset?: number, found?: Found): void => {
    // SC1 2a: a span holding a value the model withheld is never a candidate; its line may still be another's context.
    if (full() || text.includes(WITHHELD)) return;
    // Text is deduplicated in what is offered; the association of a span not offered is kept (Collected.omitted).
    if (seen.has(text) || holdsUnwarned(text) || closed.has(w.window.windowId)) return void omit(w, node, text, context()?.text ?? null);
    const c = build(w, node, text, kind, context, quote, partOf, sourceOffset, found);
    if (c === null) return;
    // The mint's own membership (Disclosure viewHolds), checked here when the candidates will be minted (a ledger): one
    // whose line could not be minted is an omission now, never a failure when its request is built.
    if (o.ledger !== undefined && !mintable(w, c)) return void omit(w, node, text, c.context);
    if (o.ledger !== undefined && !o.ledger.take(w, "candidate", candidateTexts(c), candidateSpans(c))) {
      // W2: a part of a labelled value (line-values.ts valueParts) is an extra beside the whole value: one that does not
      // fit is dropped, and the window is neither cut nor closed for it. Counting it as a cut withheld Greenhouse's names
      // (W1's regression: 12/12 to 6/6 canned, evidence/screen/w1 CHECKLIST).
      if (partOf !== undefined) return;
      missed.add(w.window.windowId);
      if (c.context !== null) omitted.add(associationOf(c));
      // A span that goes only with its line (a warning, a remark) and does not fit with it is left out alone: the window
      // counts as cut, so the cut rules withhold its kind and words, but the spans after it are still read. Closing the
      // window instead cut every later line of a mail whose prose warns often (corpus clinic-intake, 7 -> 5).
      if (quoted.has(c)) {
        unwarned.add(text);
        if (!ranked.has(w.window.windowId)) leftOutOf.add(w.window.windowId);
        return;
      }
      closed.add(w.window.windowId);
      // What else of a window that is not a conversation was left out is read at the end (leftOut).
      if (!ranked.has(w.window.windowId)) leftOutOf.add(w.window.windowId);
      return;
    }
    offer(c);
  };
  const touched = new Set<string>();
  /** Collected.omitted, and the association each offered text was offered under. */
  const omitted = new Set<string>();
  const offeredAs = new Map<string, string>();
  /** A span of `w` not offered as its own: its association is omitted, unless that text was offered under it. */
  const omit = (w: WindowState, node: Node, text: string, label: string | null): void => {
    if (label === null) return;
    const key = associationKey(w.window.windowId, sectionAround(w, node) ?? blockHead(w, node, text), label);
    if (offeredAs.get(text) !== key) omitted.add(key);
  };
  const offer = (c: Candidate): void => {
    seen.add(c.text);
    offeredAs.set(c.text, associationOf(c));
    out.push(c);
  };
  /** The window the generator is reading, if it stops there. */
  let reading: string | null = null;
  const finish = (): Collected => {
    const pending = new Map<Candidate, string>();
    for (const c of out) {
      const clause = clauses.get(c);
      const sw = viewOf(model, c.source.windowId);
      if (clause === undefined || sw === undefined) continue;
      if (o.deferClauses === true) pending.set(c, clause);
      else if (viewHolds(sw, clause) && (o.ledger === undefined || o.ledger.take(sw, "candidate", [clause], clauseSpans(c, clause)))) c.line = clause;
    }
    for (const id of unreadOf) {
      const lw = viewOf(model, id);
      if (lw !== undefined) unreadRest(lw);
    }
    for (const [id, nodes] of unlistedOf) {
      const lw = viewOf(model, id);
      if (lw !== undefined && !unreadOf.has(id)) unreadRest(lw, nodes);
    }
    unlistedOf.clear();
    for (const id of leftOutOf) {
      const lw = viewOf(model, id);
      if (lw !== undefined && !unreadOf.has(id)) leftOut(lw);
    }
    leftOutOf.clear();
    unreadOf.clear();
    // A window read whose own reading for typed values stopped at its bound may hold anything: what it holds is unknown.
    for (const id of touched) {
      const tw = viewOf(model, id);
      if (tw !== undefined && valuesIncomplete(tw)) cutAll = true;
    }
    stats.windows = touched.size;
    stats.ms = performance.now() - t0;
    return { candidates: out, stats, cut: [...missed], cutTerms, cutAll, namesCut: wantsNames && (cutAll || partway || namesKeptOut(cutNames, out)), clauses: pending, omitted };
  };
  /**
   * Stops early, on either cap, partway through `reading`: what of it was offered is a partial
   * set like a privacy cut's, so it is reported cut and fill withholds the kinds it lost (B13 review: a
   * chat's 79 times filled the cap before its meeting date, and an older window's date was asked alone).
   * Each window in `unread`, which the cap stopped the generator from reaching, counts as cut the same way. Both are
   * read for what they may hold (unreadRest), so the cut rules withhold those kinds, words and names.
   */
  const stop = (unread: readonly WindowState[]): Collected => {
    if (reading !== null) {
      missed.add(reading);
      // The rest of the window was not read, so whether it held a name is not known.
      partway = true;
      unreadOf.add(reading);
    }
    for (const w of unread) {
      missed.add(w.window.windowId);
      unreadOf.add(w.window.windowId);
    }
    return finish();
  };

  const cutTerms = new Set<string>();
  let cutAll = false;
  /** Windows, not conversations, that a span did not fit; their left-out lines are read when the generator finishes. */
  const leftOutOf = new Set<string>();
  /** Windows a cap stopped the generator in, or kept it from reaching; their unread text is read when it finishes. */
  const unreadOf = new Set<string>();
  /** By conversation, the older nodes its listing left unlisted (rankWindow); read when the generator finishes. */
  const unlistedOf = new Map<string, ReadonlySet<string>>();
  /**
   * What a window a cap stopped in, or never reached, may hold: every line of every node not offered whole, a line with
   * no candidate in it as much as one with (a note's closing "Do not use L01 ..."), since candidate extraction does not
   * say a window was read whole. Its words, its section's and its typed values' kinds go in cutTerms, its names in
   * cutNames, its labels' associations in omitted. Every line and value read counts, a repeated one too, against
   * UNREAD_MAX; past it what the rest may hold is not known, and cutAll is set.
   */
  const unreadRest = (w: WindowState, only?: ReadonlySet<string>): void => {
    // The work is counted as it is done, a node, a line and a typed value at a time, and nothing is read ahead of the
    // count: a window of a million lines costs this pass UNREAD_MAX of them, not the extraction of all of them.
    let n = 0;
    const over = (): boolean => {
      if (++n <= UNREAD_MAX) return false;
      cutAll = true;
      return true;
    };
    const readerValues = new Map<string, TypedValue[]>();
    for (const v of w.values) {
      if (only !== undefined && !only.has(v.nodeKey)) continue;
      if (over()) return;
      readerValues.set(v.nodeKey, [...(readerValues.get(v.nodeKey) ?? []), v]);
      if (secretValue(w, v) || seen.has(v.text)) continue;
      for (const k of valueKinds(v)) cutTerms.add(kindTerm(k));
    }
    for (const node of w.nodes.values()) {
      if (only !== undefined && !only.has(node.key)) continue;
      const texts = nodeTexts(node);
      // A node with no text costs one; one with text, its lines.
      if (texts.length === 0 && over()) return;
      const isSourceField = sourceField(node);
      for (const raw of texts.flatMap((t) => [...linesUpTo(t, UNREAD_MAX - n + 1)])) {
        if (over()) return;
        const line = bareLine(raw);
        if (line === "") continue;
        const spans = lineSpans(raw);
        for (const sp of spans) omit(w, node, sp.text, sp.label ?? (isSourceField ? (node.label ?? null) : null));
        if (spans.length > 0 && spans.every((sp) => seen.has(sp.text))) continue;
        for (const t of words(line)) cutTerms.add(t);
        for (const t of words(sectionAround(w, node))) cutTerms.add(t);
        // The line's typed values: the reader's on this node, and those this code's own reading finds in the line.
        const values = [...(readerValues.get(node.key) ?? []).filter((v) => line.includes(v.text)), ...lineValues(line).map((v): TypedValue => ({ kind: v.kind, text: v.text, nodeKey: node.key }))].filter((v) => !secretValue(w, v));
        for (const v of values) for (const k of valueKinds(v)) cutTerms.add(kindTerm(k));
        if (!wantsNames) continue;
        for (const sp of spans) if (!seen.has(sp.text) && isNameLike(sp.text, sp.label)) cutNames.push(sp.text);
        if (values.some((v) => valueKinds(v).some((k) => CONTACT_KINDS.has(k)))) cutNames.push(...namesOutside(line, values));
      }
    }
  };
  /**
   * What a window that is not a conversation left out once a span of it did not fit its budget: the words of
   * every line not offered, as cutTerms, and the names those lines hold, as cutNames, the way a conversation's
   * left-out spans are counted (byRelevance). B13 set cutAll instead, which withheld every name and every field
   * whose label names no kind whenever any such window did not fit, an unrelated draft included: on Q1's real
   * forms and the B24 corpus that withheld every name the user's own note held (Q1 bug 1). Past LEFT_OUT_MAX
   * spans, or out of time, the rest is not read and cutAll is set as before.
   */
  const leftOut = (w: WindowState): void => {
    const valuesOf = new Map<string, TypedValue[]>();
    for (const v of windowValues(w)) valuesOf.set(v.nodeKey, [...(valuesOf.get(v.nodeKey) ?? []), v]);
    let n = 0;
    const note = (node: Node, text: string, line: string, kinds: readonly ValueKind[], label: string | null): boolean => {
      // Every span read counts, a repeated one too, before it is weighed.
      if (++n > LEFT_OUT_MAX || outOfWork()) {
        cutAll = true;
        return false;
      }
      omit(w, node, text, label);
      if (seen.has(text)) return true;
      for (const t of words(line)) cutTerms.add(t);
      for (const t of words(sectionAround(w, node))) cutTerms.add(t);
      for (const k of kinds) cutTerms.add(kindTerm(k));
      if (!wantsNames) return true;
      if (isNameLike(text, label)) cutNames.push(text);
      if (kinds.some((k) => CONTACT_KINDS.has(k))) cutNames.push(...namesOutside(line, valuesOf.get(node.key)));
      return true;
    };
    for (const v of windowValues(w)) {
      const node = w.nodes.get(v.nodeKey);
      if (secretValue(w, v)) continue;
      if (node !== undefined && !note(node, v.text, lineHolding(nodeText(node), v.text), valueKinds(v), null)) return;
    }
    for (const node of w.nodes.values()) {
      const isSourceField = sourceField(node);
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      for (const raw of splitLines(nodeText(node))) {
        for (const sp of lineSpans(raw)) {
          const kinds = (valuesOf.get(node.key) ?? []).filter((v) => sp.line.includes(v.text)).flatMap(valueKinds);
          if (!note(node, sp.text, sp.line, kinds, sp.label ?? (isSourceField ? (node.label ?? null) : null))) return;
        }
      }
    }
  };
  /** Either cap stopped the generator inside a window. */
  let partway = false;
  /** The names held by spans a conversation's budget left out. */
  const cutNames: string[] = [];
  /** Conversations whose budget went by relevance; the line pass leaves them alone. */
  const ranked = new Set<string>();
  const relevance = o.fields !== undefined && o.fields.length > 0 && o.ledger !== undefined ? o.fields : null;
  /** Some field takes a name, so a conversation's name-like lines are a group like a kind's values. */
  const wantsNames = relevance !== null && o.nameGroup !== false && relevance.some((f) => f.has(NAME_TERM));

  /**
   * Every span of a conversation, typed values first and then lines as the two passes below would take
   * them, each with the terms of its line, its section and the kinds of typed values it holds; then adds
   * them in relevance order. False when either cap was reached. A span's group is the term of the
   * whole-or-nothing set it goes in with: its kind's for a typed value, NAME_TERM for a name-like line.
   */
  type Span = { node: Node; text: string; kind: ValueKind | null; group: string | null; context: () => Read | null; terms: Set<string>; names: string[]; quote?: string; partOf?: string; sourceOffset?: number; found?: Found };
  const byRelevance = (w: WindowState, fields: readonly ReadonlySet<string>[]): boolean => {
    const spans: Span[] = [];
    const built = { done: false };
    const finished = rankWindow(w, fields, spans, built);
    if (finished && !missed.has(w.window.windowId)) return true;
    // Cut, or stopped partway: what it left out. Spans the visit cap stopped it from even listing are unknown.
    // A left-out span's names are weighed at the end against everything offered, as cutKinds weighs
    // typed values, so NAME_TERM stays out of cutTerms.
    if (!built.done) cutAll = true;
    for (const sp of spans) {
      omit(w, sp.node, sp.text, sp.context()?.text ?? null);
      if (seen.has(sp.text)) continue;
      for (const t of sp.terms) if (t !== NAME_TERM) cutTerms.add(t);
      cutNames.push(...sp.names);
    }
    return finished;
  };
  /** byRelevance's work: lists the window's spans into `spans`, then offers them; false when either cap was reached. */
  const rankWindow = (w: WindowState, fields: readonly ReadonlySet<string>[], spans: Span[], built: { done: boolean }): boolean => {
    const sections = new Map<string, string[]>();
    const sectionWords = (n: Node): string[] => {
      let ws = sections.get(n.key);
      if (ws === undefined) sections.set(n.key, (ws = words(sectionAround(w, n))));
      return ws;
    };
    const valuesOf = new Map<string, TypedValue[]>();
    for (const v of windowValues(w)) {
      const list = valuesOf.get(v.nodeKey);
      if (list === undefined) valuesOf.set(v.nodeKey, [v]);
      else list.push(v);
    }
    const termsOf = (n: Node, line: string, kinds: Iterable<ValueKind>): Set<string> => {
      const t = new Set([...words(line), ...sectionWords(n)]);
      for (const k of kinds) t.add(kindTerm(k));
      return t;
    };
    // Which nodes are listed: newest first (the end of the window's order), within the conversation's share of the
    // generator's visits (CONVERSATION_LIST_SHARE) and what is left of them, each listed node's own visits counted (the
    // node, each of its lines, each typed value on it). An older node left unlisted is read for what it may hold
    // (unreadRest, unlistedOf), as any unread text is, so the window counts as cut, not as unknown. The listed nodes are
    // then ranked in the window's own order, as a conversation listed whole always was.
    const listed = new Set<string>();
    const linesOf = new Map<string, { raw: string; start: number }[]>();
    {
      let spent = 0;
      const nodes = [...w.nodes.values()];
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i] as Node;
        const lines = LINE_ROLES.has(node.role) || sourceField(node) ? timed("split", () => nodeLines(node)) : [];
        const cost = 1 + lines.length + (valuesOf.get(node.key)?.length ?? 0);
        if (spent + cost > CONVERSATION_LIST_SHARE || visits + spent + cost > MAX_GENERATOR_VISITS) {
          unlistedOf.set(w.window.windowId, new Set(nodes.slice(0, i + 1).map((n) => n.key)));
          missed.add(w.window.windowId);
          break;
        }
        spent += cost;
        listed.add(node.key);
        linesOf.set(node.key, lines);
      }
    }
    for (const v of windowValues(w)) {
      if (!listed.has(v.nodeKey)) continue;
      if (outOfWork()) return false;
      stats.values++;
      const node = w.nodes.get(v.nodeKey);
      if (node === undefined || secretValue(w, v)) continue;
      const line = lineHolding(nodeText(node), v.text);
      const terms = termsOf(node, line, [v.kind]);
      const names = wantsNames ? namesOutside(line, valuesOf.get(node.key)) : [];
      if (names.length > 0) terms.add(NAME_TERM);
      spans.push({ node, text: v.text, kind: v.kind, group: kindTerm(v.kind), context: () => contextRead(w, node, v.text, foundAt(node, valueFound(node, v))), terms, names, sourceOffset: sourceOffsets.get(v), found: valueFound(node, v) });
    }
    for (const node of w.nodes.values()) {
      if (!listed.has(node.key)) continue;
      if (outOfWork()) return false;
      stats.nodes++;
      const isSourceField = sourceField(node);
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      const lines = linesOf.get(node.key) ?? [];
      for (const { raw, start } of lines) {
        if (outOfWork()) return false;
        const line: Found = { lineStart: start, raw };
        for (const s of lineSpans(raw)) {
          const found: Found = { ...line, ...(s.at === undefined ? {} : { at: s.at }), ...(s.withAt === undefined ? {} : { withAt: s.withAt }) };
          const kinds = (valuesOf.get(node.key) ?? []).filter((v) => s.line.includes(v.text)).map((v) => v.kind);
          const context = s.label !== null ? constant<Read>({ text: s.label, at: labelRange(node, start, raw, s.label) }) : () => lineContextRead(w, node, lines.length, isSourceField);
          const terms = termsOf(node, s.line, kinds);
          // A source field's own label says what its value is, as contextFor reads it ("Name" for "dana w.").
          const name = wantsNames && isNameLike(s.text, s.label ?? (isSourceField ? (node.label ?? null) : null));
          // A contact line holds a name beside a typed value ("Dana Whitfield <dana@example.com>"): it is not
          // offered as a name, but its cut can keep the name out. A name a sentence mentions without a typed
          // value ("Design review with Priya Raman") is not counted: counting those withheld Full name and
          // Company on every calibration set with the sources as Messages (B14 oracle replay).
          const placed = wantsNames && kinds.some((k) => CONTACT_KINDS.has(k)) ? namesOutsideAt(s.line, valuesOf.get(node.key)) : [];
          const names = placed.map((n) => n.name);
          if (name) names.push(s.text);
          if (names.length > 0) terms.add(NAME_TERM);
          // W2: a part of a labelled value joins no kind's group: the group goes in whole or not at all, so a part and its
          // quote of the whole value spent the names' budget and cut the note (W1's Greenhouse regression). Parts come after.
          spans.push({ node, text: s.text, kind: null, group: name && s.partOf === undefined ? NAME_TERM : null, context, terms, names, found, ...(s.with === undefined ? {} : { quote: s.with }), ...(s.partOf === undefined ? {} : { partOf: s.partOf }) });
          // Each name a contact line holds goes in with the names too, as its own span, copied verbatim from
          // the line: else "From: Priya Raman <priya.raman@…>" left a name out whenever the line was cut, and
          // the names spent the budget for nothing (B14 oracle replay, Claim form with the sources as Messages).
          for (const n of placed) if (n.name !== s.text) spans.push({ node, text: n.name, kind: null, group: NAME_TERM, context, terms: new Set([...terms]), names: [n.name], found: { ...line, ...(n.at === undefined ? {} : { at: n.at }) } });
        }
      }
    }
    built.done = true;
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
    // In a window the Ask named, lines about the people it named go first (CollectOptions.first).
    if (o.first !== undefined && o.first.windows.has(w.window.windowId)) {
      const names = new Set(o.first.names.flatMap((n) => words(n)));
      const about = (i: number): boolean => [...(spans[i]?.terms ?? [])].some((t) => names.has(t));
      const theirs = order.filter(about);
      if (theirs.length > 0) order.splice(0, order.length, ...theirs, ...order.filter((i) => !about(i)));
    }
    // A kind some field takes goes in whole or not at all: every typed value of it in the window, each
    // with all its facts, in one take. A kind that
    // does not fit is left out whole, so cutKinds reports it and fill withholds its fields, and the budget
    // goes on to the next kind. So a field is asked only when every value of its kind in the window is
    // offered, and offered as fully as a window that is not a conversation would offer it: no value is
    // missing, and none lost the facts (label, section, block) that set it apart from another. The first
    // B12 replays spent a conversation's budget value by value: four values with facts used up a
    // 220-character Messages window, and values let in bare, to fit, let Jev take a padding thread's
    // meeting link for the form's (~/.caret-run/evidence/screen/b12/live-run5). Name-like lines are one
    // more such group when a field takes a name (kinds.ts NAME_TERM).
    const kinds = new Set(fields.flatMap((f) => [...f].filter(isKindTerm)));
    const takesKind = (i: number): boolean => {
      const g = spans[i]?.group;
      return g !== null && g !== undefined && kinds.has(g);
    };
    const kindOrder = [...new Set(order.filter(takesKind).map((i) => spans[i]?.group as string))];
    const skipped: Span[] = [];
    const groups = new Map<string, Candidate[]>();
    for (const k of kindOrder) {
      if (outOfWork()) return false;
      const group: Candidate[] = [];
      const texts = new Set<string>();
      for (const i of order) {
        const sp = spans[i] as (typeof spans)[number];
        if (sp.group !== k) continue;
        // Not offered again: its association is weighed once the kinds are in (skipped), against the association its text
        // was offered under, as add() weighs one, so a repeat of an offered value under its own label is no omission.
        if (seen.has(sp.text) || holdsUnwarned(sp.text) || texts.has(sp.text)) {
          skipped.push(sp);
          continue;
        }
        texts.add(sp.text);
        const c = build(w, sp.node, sp.text, sp.kind, sp.context, sp.quote, sp.partOf, sp.sourceOffset, sp.found);
        if (c !== null && (o.ledger === undefined || mintable(w, c))) group.push(c);
        else if (c !== null) omit(w, sp.node, sp.text, c.context);
      }
      if (group.length > 0) groups.set(k, group);
    }
    // Kinds go in by what they cost per field they serve, cheapest first, priced again after each take,
    // since a kind's facts can share texts (the window's title, a section) with one already in. B12 took
    // them in the order the fields first wanted them, so one dear kind could spend the budget that two
    // cheap ones needed. No run measured this before B13's replay.
    const served = (k: string): number => fields.filter((f) => f.has(k)).length;
    for (;;) {
      if (full() || outOfWork()) return false;
      let best: { k: string; rate: number } | null = null;
      for (const [k, group] of groups) {
        const cost = out.length + group.length > max ? null : o.ledger?.cost(w, group.flatMap(candidateTexts), group.flatMap(candidateSpans));
        if (cost === null || cost === undefined) continue;
        const rate = o.kindsByCost === false ? kindOrder.indexOf(k) : cost / served(k);
        if (best === null || rate < best.rate) best = { k, rate };
      }
      if (best === null) break;
      const group = groups.get(best.k) as Candidate[];
      groups.delete(best.k);
      if (o.ledger?.take(w, "candidate", group.flatMap(candidateTexts), group.flatMap(candidateSpans)) !== true) throw new Error(`a kind priced to fit did not fit window ${w.window.windowId}`);
      for (const c of group) {
        c.id = `c${out.length + 1}`;
        offer(c);
      }
    }
    for (const sp of skipped) omit(w, sp.node, sp.text, sp.context()?.text ?? null);
    /** Kinds left out whole, since none of them fits what is left; a line holding a value of one stays out too. */
    const leftOut = new Set(groups.keys());
    for (const g of groups.values()) for (const c of g) if (quoted.has(c)) unwarned.add(c.text);
    if (leftOut.size > 0) missed.add(w.window.windowId);
    // Then the rest, nearest the fields first, with their facts, until one does not fit.
    for (const i of order.filter((x) => !takesKind(x))) {
      if (full() || outOfWork()) return false;
      if (closed.has(w.window.windowId)) break;
      const sp = spans[i] as (typeof spans)[number];
      if ([...sp.terms].some((t) => leftOut.has(t))) continue;
      add(w, sp.node, sp.text, sp.kind, sp.context, sp.quote, sp.partOf, sp.sourceOffset, sp.found);
    }
    return true;
  };

  /**
   * A window that is not a conversation, whole: its typed values, then its lines. False when either cap was reached
   * partway through it.
   */
  const readWindow = (w: WindowState): boolean => {
    for (const v of windowValues(w)) {
      if (full() || outOfWork()) return false;
      stats.values++;
      const node = w.nodes.get(v.nodeKey);
      if (node === undefined || secretValue(w, v)) continue;
      add(w, node, v.text, v.kind, () => contextRead(w, node, v.text, foundAt(node, valueFound(node, v))), undefined, undefined, sourceOffsets.get(v), valueFound(node, v));
    }
    for (const node of w.nodes.values()) {
      if (closed.has(w.window.windowId)) return true;
      if (full() || outOfWork()) return false;
      stats.nodes++;
      const isSourceField = sourceField(node);
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      const lines = timed("split", () => nodeLines(node));
      for (const { raw, start } of lines) {
        // A node can hold thousands of lines (a log, a transcript), so both caps apply per line too.
        if (full() || outOfWork()) return false;
        for (const s of lineSpans(raw)) {
          const context = s.label !== null ? constant<Read>({ text: s.label, at: labelRange(node, start, raw, s.label) }) : () => lineContextRead(w, node, lines.length, isSourceField);
          add(w, node, s.text, null, context, s.with, s.partOf, undefined, { lineStart: start, raw, ...(s.at === undefined ? {} : { at: s.at }), ...(s.withAt === undefined ? {} : { withAt: s.withAt }) });
        }
      }
    }
    return true;
  };

  // One pass, each window whole in recency order, typed values and lines together, so a cap stops in the least recent
  // windows and every window it does not finish is counted cut (stop).
  for (const [i, w] of windows.entries()) {
    if (full()) return stop(windows.slice(i));
    touched.add(w.window.windowId);
    reading = w.window.windowId;
    // A conversation spends its budget on the spans nearest the form's fields first; in screen order its budget went to
    // its first lines, and the lines a form wanted came after the cut (evidence/screen/b24/dev-5).
    const whole = relevance !== null && heldAsConversation(w) ? (ranked.add(w.window.windowId), byRelevance(w, relevance)) : readWindow(w);
    if (!whole) return stop(windows.slice(i + 1));
    reading = null;
  }
  return finish();
}

/** G2 round 4: a window as fill may read it (redact.ts), by id, or undefined. */
export function viewOf(model: ScreenModel, windowId: string): WindowState | undefined {
  const w = model.windows.get(windowId);
  return w === undefined ? undefined : redactWindow(w);
}

const constant =
  <T>(x: T): (() => T) =>
  () =>
    x;

/**
 * Whether a typed value is one Caret never types: by its shape, or because the field that holds it is labelled as
 * one ("Password" holding "hunter2"; B25 review).
 */
function secretValue(w: WindowState, v: TypedValue): boolean {
  return valueKind(v.text) !== null || labelKind(w.nodes.get(v.nodeKey)?.label) !== null;
}

/**
 * The span a screen line offers: a "Label: value" line offers its value, with the label as context; a
 * line too short or too long to be a value, with no letter or digit, or ending in a colon offers none.
 */
function spanOfLine(raw: string): { line: string; text: string; label: string | null; at: number } | null {
  const line = bareLine(raw);
  if (line.length < MIN_LINE || line.length > MAX_LINE || !/[\p{L}\p{N}]/u.test(line)) return null;
  if (line.endsWith(":")) return null; // a label, not a value
  const m = LABELLED.exec(line);
  // A value Caret never types (a password, a card or account number, a government ID, a one-time code or an API
  // key, by its label or its shape: memory/sensitive.ts) is no span: it is never offered, so no fill or plan can
  // choose it, and it never goes out in a question (B25 lead decision 2).
  // LABELLED's value runs to the line's end, after the colon's spaces: it starts there.
  if (m !== null && m[1] !== undefined && m[2] !== undefined) return sensitiveKind(m[1], m[2]) === null ? { line, text: m[2].trim(), label: m[1].trim(), at: line.length - m[2].length } : null;
  return valueKind(line) === null ? { line, text: line, label: null, at: 0 } : null;
}

/**
 * Every span a screen line offers (C1): spanOfLine's, then the free text the line bounds (line-values.ts lineTexts), each
 * under its line's label or none. A line of any length offers the bounded text; only spanOfLine's needs it short. Its
 * typed values are offered as the window's typed values (windowValues), not here.
 */
export function lineSpans(raw: string): LineSpan[] {
  const line = bareLine(raw);
  if (line.length < MIN_LINE) return [];
  const whole = spanOfLine(raw);
  const out: LineSpan[] = whole === null ? [] : [whole];
  for (const t of lineTexts(line)) {
    if (out.some((o) => o.text === t.text)) continue;
    out.push({ line, text: t.text, label: t.label, ...(t.with === undefined ? {} : { with: t.with }), ...(t.withAt === undefined ? {} : { withAt: t.withAt }), ...(t.partOf === undefined ? {} : { partOf: t.partOf }), ...(t.at === undefined ? {} : { at: t.at }) });
  }
  return out;
}

/**
 * A span a line offers, with where its reader found it in the line as bareLine reads it (`at`; `withAt` for the text it
 * must quote), when the reader knows. A span with no `at` has the whole line as its source.
 */
export interface LineSpan {
  line: string;
  text: string;
  label: string | null;
  with?: string;
  withAt?: number;
  partOf?: string;
  at?: number;
}

/**
 * C1: a window's typed values: the reader's, and those code finds in each line it reads (line-values.ts lineValues) that
 * no reader value of the node overlaps. Code finds them in text the reader did not type (a page the engine read, a
 * replay) and inside lines too long to offer whole. Kept per window state, so the generator, the cut rules and the
 * recheck read the same list.
 */
const valuesCache = new WeakMap<WindowState, readonly TypedValue[]>();
/** Code extraction offsets stay local; reader TypedValues have no source offsets. */
const sourceOffsets = new WeakMap<TypedValue, number>();
/** The line of nodeText a code-found value was read from (its start there and raw text), for its source range. */
const valueLines = new WeakMap<TypedValue, { lineStart: number; raw: string; at: number }>();
export function windowValues(w: WindowState): readonly TypedValue[] {
  const cached = valuesCache.get(w);
  if (cached !== undefined) return cached;
  // Lines this code's own reading of the window has read, counted as it reads them; past EXTRACT_MAX it stops, and the
  // window's values are incomplete (valuesIncomplete), which every reader of them treats as a window whose values are
  // not known.
  let lines = 0;
  const out: TypedValue[] = w.values.filter((v) => {
    if (v.kind !== "url") return true;
    const node = w.nodes.get(v.nodeKey);
    return node !== undefined && rawURLToken(nodeText(node), v.text, MAX_SCAN) !== null;
  });
  const byNode = new Map<string, TypedValue[]>();
  for (const v of w.values) byNode.set(v.nodeKey, [...(byNode.get(v.nodeKey) ?? []), v]);
  read: for (const node of w.nodes.values()) {
    if (++lines > EXTRACT_MAX) {
      INCOMPLETE.add(w);
      break;
    }
    if (!LINE_ROLES.has(node.role) && !sourceField(node)) continue;
    const reader = byNode.get(node.key) ?? [];
    const seen = new Set(reader.map((v) => v.text));
    // A reader's value says no offset. Where this code's own reading of the node finds the same text exactly once, that
    // reading's line and offset are where it was read; found twice or not at all, it keeps the whole-line fallback.
    const readAt = new Map<TypedValue, { lineStart: number; raw: string; at: number } | null>();
    for (const { raw, start } of linesWithStarts(nodeText(node).slice(0, MAX_SCAN))) {
      if (++lines > EXTRACT_MAX) {
        INCOMPLETE.add(w);
        break read;
      }
      const match = { index: start };
      const line = bareLine(raw);
      if (line.length < 3) continue;
      for (const v of lineValues(line)) {
        for (const r of reader) if (r.text === v.text) readAt.set(r, readAt.has(r) ? null : { lineStart: match.index, raw, at: v.at });
        if (seen.has(v.text) || reader.some((r) => r.text.includes(v.text) || v.text.includes(r.text))) continue;
        const value: TypedValue = { kind: v.kind, text: v.text, nodeKey: node.key };
        valueLines.set(value, { lineStart: match.index, raw, at: v.at });
        if (v.kind === "url") {
          // Normalizing a line changes offsets. Locate the URL in the original line, retaining normalized extraction for other kinds.
          const extracted = lineValues(raw).find((r) => r.kind === "url" && r.text === v.text);
          if (extracted === undefined) continue;
          const offset = match.index + extracted.at;
          if (rawURLToken(nodeText(node), v.text, MAX_SCAN, offset) === null) continue;
          sourceOffsets.set(value, offset);
        }
        seen.add(v.text);
        out.push(value);
      }
    }
    // Only for a value whose exact text stands in the node's raw text once: the reader may have read another occurrence
    // than the one this code's extractor sees.
    for (const [r, at] of readAt) if (at !== null && standsOnce(nodeText(node), r.text)) valueLines.set(r, at);
  }
  valuesCache.set(w, out);
  return out;
}

/**
 * C1: whether a line, as it reads now, still gives `span` the way fill read it with no label: on a line with no label,
 * one of its spans (lineSpans), typed values (lineValues) or a date's month or year (derive.ts splitDate); on a labelled
 * line, a typed value its label does not name (labelNames), or such a date's part ("School: …, September 2016 to May
 * 2020." gives "May"). A line that gained a label naming the span gives nothing: "Do not use: 555-0147" is not the line
 * the value was read from (P2 review). The recheck of a control's value holds the source to this (offers/fill-popup.ts
 * derivesSpan), so a value is checked by the same code that found it.
 */
export function lineGives(raw: string, span: string): boolean {
  const line = bareLine(raw);
  const m = LABELLED.exec(line);
  const value = m?.[2]?.trim() ?? null;
  if (value === null && lineSpans(raw).some((s) => s.text === span)) return true;
  for (const v of lineValues(value ?? line)) {
    if (value !== null && labelNames(value, v.text)) continue;
    if (v.text === span) return true;
    const d = v.kind === "date" ? splitDate(v.text) : null;
    if (d !== null && (d.month === span || d.year === span)) return true;
  }
  return false;
}

/**
 * C1: the clause a span's description quotes (Candidate.line): for a span on a line over MAX_LINE characters, or on a
 * line that shows another typed value of its kind, the clause around it; null otherwise, or when the span carries its
 * line's label (the label says what it is).
 */
/** How many wrapped lines a sentence is read on for a warning (lineFact). Assumed: a sentence rarely wraps more. */
const WRAPPED_LINES = 3;

/**
 * `where`: the line of nodeText the span was read from and its position there (Found), when its reader knows. The clause
 * is then read around that very place, and its source range is recorded; without it the clause is read around the
 * span's first place in the node and has the whole line as its source (the fallback).
 */
export function lineFact(w: WindowState, node: Node, text: string, labelled: boolean, where?: { lineStart: number; raw: string; at: number }): { clause: string; required: boolean; at: SourceAt | null } | null {
  const t = nodeText(node);
  const read = where ?? (() => {
    const at = t.indexOf(text);
    return at < 0 ? null : { lineStart: lineStartAt(t, at), raw: lineHolding(t, text), at: undefined };
  })();
  if (read === null) return null;
  const fact = readLineFact(t, read.lineStart, read.raw, read.at ?? bareLine(read.raw).indexOf(text), text, labelled);
  if (fact === null) return null;
  // A clause cut from lines joined across a wrap has no one range (start undefined).
  return { clause: fact.clause, required: fact.required, at: read.at === undefined ? null : lineRange(node, read.lineStart, read.raw, fact.clause, fact.start) };
}

function readLineFact(t: string, lineStart: number, raw: string, pos: number, text: string, labelled: boolean): { clause: string; required: boolean; start?: number } | null {
  const line = bareLine(raw);
  if (pos < 0 || line.slice(pos, pos + text.length) !== text) return null;
  const at = lineStart;
  // A sentence a line break cut, its next line going on in lowercase ("Phone: 555-0101" then "and must not be used ..."),
  // is read on to its end for a warning (C1 review).
  // At most WRAPPED_LINES more lines, read one at a time: a node can be a whole log.
  let joined = line;
  let end = lineEndAt(t, at);
  for (let k = 0; end < t.length && k < WRAPPED_LINES && !/[.!?;:]$/u.test(joined); k++) {
    const from = nextLineStart(t, end);
    const nl = lineEndAt(t, from);
    const next = t.slice(from, nl);
    if (!/^\s*\p{Ll}/u.test(next)) break;
    joined = `${joined} ${bareLine(next)}`;
    end = nl;
  }
  if (joined !== line) {
    const [j0, j1] = sentenceSpan(joined, pos, text);
    const sentence = joined.slice(j0, j1);
    // A sentence that ends on the span's own line has a range there; one that runs on past it has none.
    if (WARNS.test(sentence.replace(text, " "))) return { clause: sentence, required: true, ...(j1 <= line.length ? { start: j0 } : {}) };
  }
  // A sentence that warns ("Don't give out 555-0112, ...", "Phone: 555-0101; do not use this old number.") goes whole with
  // the span on it, or not the span: the warning may be about it, and a clause cut at a semicolon or to a length lost it
  // (C1 review). Only the span's own sentence: a whole line sent for "old" in the next sentence ("Their old chart had
  // 1978") cost corpus clinic-intake two values. A label otherwise says what the span is.
  const [s0, s1] = sentenceSpan(line, pos, text);
  const sentence = line.slice(s0, s1);
  if (WARNS.test(sentence.replace(text, " "))) return sentence === text ? null : { clause: sentence, required: true, start: s0 };
  const values = lineValues(line);
  const kind = values.find((v) => v.text === text)?.kind;
  // G2: a date, email or phone number goes with the part of its clause that says what it is (line-values.ts
  // partAround) whenever that says more than "Label: value", on a short line and under a label too. A label alone does
  // not say which of two dates is which: "School: …, September 2016 to May 2020." offered both as labelled 'School', and
  // live Jev put May 2020 in the education Start date (evidence/screen/g1 fix 3: start dates on wizard-2 and Greenhouse,
  // the reference's phone and email on forty). It is optional context: charged only after every span and memory value
  // (fill.ts, dates' and contacts' first among clauses), so it never keeps a value out and dropping it marks nothing
  // cut (G2 review: charged earlier, it pushed values out). On F1's task notes the budget is spent by then, and the
  // School line's dates go out without it (evidence/screen/g2/whose/probe-head.json). It can carry a second value of the
  // line that Jev then reads beside the first; both are spans of the line, and agreement and the cutoff still decide.
  if (kind === "date" || kind === "email" || kind === "phone") {
    const span = partSpan(line, pos, text);
    const clause = span === null ? null : line.slice(span[0], span[1]);
    const said = clause === null ? null : (LABELLED.exec(clause)?.[2] ?? clause).trim().replace(/[.!?;,]+$/u, "");
    return span === null || clause === null || said === text ? null : { clause, required: false, start: span[0] };
  }
  if (labelled) return null;
  const twins = kind !== undefined && values.filter((v) => v.kind === kind).length > 1;
  if (line.length <= MAX_LINE && !twins) return null;
  const span = clauseSpan(line, pos, text);
  return span === null ? null : { clause: line.slice(span[0], span[1]), required: false, start: span[0] };
}

/**
 * Every "Label: value" line a window shows, in the nodes the generator reads (static text, cells, headings,
 * links, and fields holding text), with the label and value trimmed. Fill's anchor reads them (fill.ts).
 */
export function labelledLines(w: WindowState): { label: string; value: string; node: Node }[] {
  const out: { label: string; value: string; node: Node }[] = [];
  for (const node of w.nodes.values()) {
    const isSourceField = sourceField(node);
    if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
    for (const raw of splitLines(nodeText(node))) {
      // C1: a labelled line of any length, so a value read from a long one ("School: …, September 2016 to May 2020.")
      // is checked by its label as one from a short one is (fill/contract.ts provenanceStale, spanContexts).
      const line = bareLine(raw);
      const m = LABELLED.exec(line);
      if (m?.[1] === undefined || m[2] === undefined || !/[\p{L}\p{N}]/u.test(m[2]) || sensitiveKind(m[1], m[2]) !== null) continue;
      out.push({ label: m[1].trim(), value: m[2].trim(), node });
    }
  }
  return out;
}

/**
 * The candidate a labelled line of `w` offers, with the facts the generator gives a span (fill.ts moves a
 * text another window also shows to the window the user just left, where its label names it).
 */
export function labelledCandidate(w: WindowState, node: Node, text: string, label: string, id: string, kind: ValueKind | null, recency: Recency): Candidate | null {
  const url = kind === "url" || textKind(text) === "url";
  const raw = url ? rawURLToken(nodeText(node), text, MAX_SCAN) : null;
  if (url && raw === null) return null;
  const sec = sectionRead(w, node);
  const head = blockHeadRead(w, node, text);
  const c: Candidate = {
    id,
    text,
    kind,
    ...(raw === null ? {} : { line: raw }),
    context: label,
    labelled: true,
    section: sec?.text ?? null,
    blockHead: head?.text ?? null,
    recency,
    source: { pid: w.app.pid, windowId: w.window.windowId, bundleId: w.app.bundleId, appName: w.app.name, windowTitle: w.window.title, nodeKey: node.key, kind },
  };
  // Its source ranges: the "Label: value" line labelledLines read, its label and the value in it.
  const line = nodeLines(node).find((l) => {
    const m = LABELLED.exec(bareLine(l.raw));
    return m?.[1]?.trim() === label && m[2]?.includes(text) === true;
  });
  // The value is the line's labelled value, which starts where LABELLED's second group does.
  const m = line === undefined ? null : LABELLED.exec(bareLine(line.raw));
  const textAt = line === undefined || m?.[2] === undefined || m[2].trim() !== text ? null : lineRange(node, line.start, line.raw, text, bareLine(line.raw).length - m[2].length);
  const labelAt = line === undefined ? null : labelRange(node, line.start, line.raw, label);
  // A URL's whole token has no read offset here (labelledLines gives none): its source is the whole line.
  const rawAt = null;
  SOURCES.set(c, {
    view: w,
    ...(textAt === null ? {} : { text: textAt }),
    ...(raw === null || rawAt === null ? {} : { line: { text: raw, at: rawAt } }),
    context: labelAt === null ? undefined : { text: label, at: labelAt },
    section: factOf(sec),
    blockHead: factOf(head),
  });
  return c;
}

/** Whether the span sits on a "Label: value" line of the node whose label is `context`. */
export function labelledSpan(node: Node, text: string, context: string | null): boolean {
  if (context === null || text === "") return false;
  const t = nodeText(node);
  for (let at = t.indexOf(text); at >= 0; at = t.indexOf(text, at + 1)) {
    const m = LABELLED.exec(bareLine(t.slice(lineStartAt(t, at), lineEndAt(t, at))));
    if (m?.[1]?.trim() === context && m[2]?.includes(text) === true) return true;
  }
  return false;
}

/** The context of an unlabelled line: for a one-line node, its field label or the nearest label text. */
function lineContext(w: WindowState, node: Node, lines: number, isSourceField: boolean): string | null {
  return lineContextRead(w, node, lines, isSourceField)?.text ?? null;
}

/** lineContext's label, with its source range. */
function lineContextRead(w: WindowState, node: Node, lines: number, isSourceField: boolean): Read | null {
  if (lines !== 1) return null;
  if (isSourceField && node.label !== undefined) return { text: node.label, at: node.label.trim() === "" ? null : partHeadRange(node, "label", sourceLine(node.label)) };
  return nearestRead(w, node);
}

/**
 * W2: every label the generator would read a span beside in this node now: its "Label: value" line's label, an editable
 * source field's own label, the nearest text of a one-line node. The write contract's recheck (contract.ts
 * provenanceStale) requires a value's recorded context among them.
 */
export function spanContexts(w: WindowState, node: Node, span: string): string[] {
  const lines = splitLines(nodeText(node)).length;
  // I1: G2's lines read white space as one space ("Name: Robin  Vale" gives "Robin Vale"), so the span is found and
  // compared that way too; and every line that holds it is read, not the first: a short span ("M", "4") is in many
  // ("Emergency contact name: …" before "T-shirt size: M"), and reading only the first refused unchanged sources
  // (evidence/screen/i1/canned-offline-merge.json, 4 drops).
  const flat = (t: string): string => t.replace(/\s+/gu, " ").trim();
  const labels = linesHolding(nodeText(node), span).flatMap((l) => lineSpans(l).filter((s) => flat(s.text) === flat(span)).map((s) => s.label));
  return [contextFor(w, node, span), lineContext(w, node, lines, sourceField(node)), ...labels].filter((x): x is string => x !== null);
}

/** The line of a node's text that holds a span, found by search rather than by splitting the whole text. */
function lineHolding(text: string, span: string): string {
  const at = text.indexOf(span);
  if (at < 0) return span;
  return text.slice(lineStartAt(text, at), lineEndAt(text, at));
}

/** The lines of a node's text that hold a span, white space in the span matching any run of spaces or tabs; the span itself when none does. */
function linesHolding(text: string, span: string): string[] {
  const words = span.trim().split(/\s+/u).map((x) => x.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const re = new RegExp(words.join("[ \\t]+"), "u");
  const held = splitLines(text).filter((l) => l.includes(span) || re.test(l));
  return held.length === 0 ? [span] : held;
}

/** The candidates for a fill; see collectCandidates. With a ledger, each window gives only what fits its budget. */
export function generateCandidates(model: ScreenModel, targetWindowId: string, max = MAX_CANDIDATES, now = Date.now(), ledger?: Disclosure, exclude?: ReadonlySet<string>): Candidate[] {
  return collectCandidates(model, targetWindowId, { max, now, ...(ledger === undefined ? {} : { ledger }), ...(exclude === undefined ? {} : { exclude }) }).candidates;
}

/**
 * The kinds of value the request kept out: each typed value (the reader's, with its kinds, valueKinds) of
 * a window the generator cut that no offered candidate's span contains. A value offered from another
 * window, or inside a longer line that was offered, is not kept out. Only spans count: a value that went
 * out as another candidate's fact (a window title, a label, a section) cannot be chosen, so it does not
 * make its kind whole (B13 review: a chat titled with the meeting date cleared the date's cut).
 */
export function cutKinds(model: ScreenModel, cut: readonly string[], offered: readonly { text: string }[]): Set<ValueKind> {
  const out = new Set<ValueKind>();
  if (cut.length === 0) return out;
  // A cut window whose own reading stopped at its bound may hold a value of any kind.
  if (cut.some((id) => {
    const w = viewOf(model, id);
    if (w === undefined) return false;
    windowValues(w);
    return valuesIncomplete(w);
  })) return new Set(ValueKind.options);
  // One string, so each value is one search; NUL appears in no screen text, so a match never spans two spans.
  const taken = offered.map((c) => c.text).join("\u0000");
  for (const id of cut) {
    const w = viewOf(model, id);
    if (w === undefined) continue;
    for (const v of windowValues(w)) if (w.nodes.has(v.nodeKey) && !holdsWhole(taken, v.text)) for (const k of valueKinds(v)) out.add(k);
  }
  return out;
}

/** The names a line holds (kinds.ts namesIn), less those inside a typed value: "Barton Springs Rd" is part of an address. */
/** namesOutside's names, each with where it starts in the line when namesInAt knows. */
function namesOutsideAt(line: string, values: readonly TypedValue[] | undefined): { name: string; at?: number }[] {
  const names = namesInAt(line);
  if (names.length === 0 || values === undefined) return names;
  return names.filter((n) => !values.some((v) => v.text.includes(n.name)));
}

function namesOutside(line: string, values: readonly TypedValue[] | undefined): string[] {
  const names = namesIn(line);
  if (names.length === 0 || values === undefined) return names;
  return names.filter((n) => !values.some((v) => v.text.includes(n)));
}

/**
 * Whether a name a cut span held is offered nowhere: not as a span, and not whole inside a longer one.
 * A team chat whose every line starts with its sender's name cuts lines whose names are already offered,
 * and those keep nothing out (the fill desk, test/review-b13.test.ts).
 */
function namesKeptOut(names: readonly string[], offered: readonly { text: string }[]): boolean {
  if (names.length === 0) return false;
  const taken = offered.map((c) => c.text).join("\u0000");
  return names.some((n) => !holdsWhole(taken, n));
}

/** A character that can continue a value: a letter, a digit, or one of an email's or a web address's joining marks. */
const VALUE_CHAR = /[\p{L}\p{N}@._%+\-/:]/u;

/**
 * Whether the text holds the value as a whole token, with no value character either side of it. A plain
 * substring search found "a@example.com" inside "dana@example.com", so a cut email counted as offered
 * when only another address was (B13 review).
 */
function holdsWhole(text: string, value: string): boolean {
  for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
    const before = text[at - 1];
    const after = text[at + value.length];
    if ((before === undefined || !VALUE_CHAR.test(before)) && (after === undefined || !VALUE_CHAR.test(after))) return true;
  }
  return false;
}

/** The kinds of the reader's typed values a candidate's text holds, its own kind included. */
export function candidateKinds(model: ScreenModel, c: Candidate): Set<ValueKind> {
  const out = new Set<ValueKind>(c.kind === null ? [] : valueKinds({ kind: c.kind, text: c.text }));
  const sw = viewOf(model, c.source.windowId);
  for (const v of sw === undefined ? [] : windowValues(sw)) {
    if (c.text.includes(v.text) || (v.nodeKey === c.source.nodeKey && v.text.includes(c.text))) for (const k of valueKinds(v)) out.add(k);
  }
  return out;
}

/** The screen text describeCandidate puts in a request for this candidate: the span, its facts, and its window's title. */
export function candidateTexts(c: Candidate): (string | null)[] {
  return [c.text, c.context, c.line ?? null, c.blockHead, c.section, c.source.windowTitle];
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
    for (const v of windowValues(w)) {
      if (!w.nodes.has(v.nodeKey) || seen.has(v.text)) continue;
      seen.add(v.text);
      typed++;
    }
  }
  for (const w of model.windows.values()) {
    if (w.window.windowId === targetWindowId) continue;
    for (const node of w.nodes.values()) {
      const isSourceField = sourceField(node);
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      for (const raw of splitLines(nodeText(node))) for (const s of lineSpans(raw)) seen.add(s.text);
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
  return contextRead(w, node, span)?.text ?? null;
}

/**
 * contextFor's label, with its source range. `where`: the line the span was read from, when its reader knows; its
 * label is read there. Without it the label is looked for on each line that holds the span, and has the whole line as
 * its source (the fallback), since no reader said which line the span came from.
 */
function contextRead(w: WindowState, node: Node, span: string, where?: { lineStart: number; raw: string }): Read | null {
  const text = nodeText(node);
  const labelOf = (raw: string): string | null => {
    const m = LABELLED.exec(bareLine(raw));
    return m !== null && m[1] !== undefined && m[2] !== undefined && m[2].includes(span) && labelNames(m[2].trim(), span) ? m[1].trim() : null;
  };
  if (where !== undefined) {
    const label = labelOf(where.raw);
    if (label !== null) return { text: label, at: labelRange(node, where.lineStart, where.raw, label) };
  } else {
    for (let at = text.indexOf(span); at >= 0; ) {
      const nl = lineEndAt(text, at);
      const label = labelOf(text.slice(lineStartAt(text, at), nl));
      if (label !== null) return { text: label, at: null };
      if (nl >= text.length) break;
      at = text.indexOf(span, nl + 1);
    }
  }
  if (node.editable === true && node.label !== undefined) return { text: node.label, at: node.label.trim() === "" ? null : partHeadRange(node, "label", sourceLine(node.label)) };
  // A document's text area has no label, and the text above it is its window's title ("Job notes.txt"), which
  // described every value in a note as "labelled 'Job notes.txt'" (B24 capture). A value inside a document has
  // no label but its line's.
  if (node.editable === true && splitLines(text).length > 1) return null;
  return nearestRead(w, node);
}

/** nearestText(w, node, true), with its source range in the node it was read from. */
function nearestRead(w: WindowState, node: Node): Read | null {
  const near = nearestLabel(w, node, true);
  const t = nearestText(w, node, true);
  if (near === null || t === null) return t === null ? null : { text: t, at: null };
  const n = w.nodes.get(near.key);
  return { text: t, at: n === undefined ? null : partHeadRange(n, n.label !== undefined ? "label" : "value", t) };
}

/** The source range of a "Label: value" line's label: at the start of the line as bareLine reads it (after a bullet). */
function labelRange(node: Node, lineStart: number, raw: string, label: string): SourceAt | null {
  const bullet = BULLET_PREFIX.exec(collapsedMap(raw).text);
  const r = collapsedRange("", raw, label, bullet === null ? 0 : bullet[0].length);
  return r === null ? null : nodeRange(node, lineStart + r.start, lineStart + r.end);
}

/**
 * C1: whether a "Label: value" line's label names a typed value inside its value: the value starts with it, or it is
 * the only value of its kind there. "Cell: 555-0147. Don't give out 555-0112, …" labels 555-0147 alone; "From: Elena
 * Varga <elena.varga@example.org>" still labels the one address. A span that is no typed value of the value is named by
 * its label as before.
 */
function labelNames(value: string, span: string): boolean {
  if (value.startsWith(span)) return true;
  const vs = lineValues(value);
  const kind = vs.find((v) => v.text === span)?.kind;
  return kind === undefined || vs.filter((v) => v.kind === kind).length === 1;
}

/** The label of the nearest named ancestor, skipping web areas, whose label is the page title. */
function sectionAround(w: WindowState, node: Node): string | null {
  return sectionRead(w, node)?.text ?? null;
}

/** sectionAround's label, with its source range in the ancestor it was read from. */
function sectionRead(w: WindowState, node: Node): Read | null {
  let key = node.parent;
  while (key !== null) {
    const n = w.nodes.get(key);
    if (n === undefined) return null;
    // Nothing above a page's web area is the page's: it is the browser's group named for the window (B24).
    if (n.role === "AXWebArea") return null;
    if (n.label !== undefined) {
      const t = short(n.label);
      if (t !== null) return { text: t, at: partHeadRange(n, "label", t) };
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
  return blockHeadRead(w, node, span)?.text ?? null;
}

/** blockHead's line, with its source range in the node it was read from. */
function blockHeadRead(w: WindowState, node: Node, span: string): Read | null {
  const text = nodeText(node);
  const own = firstLines(text);
  let head: string | undefined;
  /** Where the head's line was read: its node, and its start and raw text in that node's nodeText. */
  let from: { node: Node; start: number; raw: string } | null = null;
  if (own.more) {
    head = own.first;
    from = own.at === undefined ? null : { node, start: own.at, raw: text.slice(own.at, lineEndAt(text, own.at)) };
  } else if (node.parent !== null) {
    const section = w.nodes.get(node.parent)?.label;
    for (const n of childrenOf(w, node.parent)) {
      if (!LINE_ROLES.has(n.role)) continue;
      const t = nodeText(n);
      const nl = lineEndAt(t, 0);
      const first = t.slice(0, nl).trim();
      if (first.length === 0 || first === section) continue;
      head = first;
      from = { node: n, start: 0, raw: t.slice(0, nl) };
      break;
    }
  }
  // With two lines of its own, the node's trimmed text holds a line break, so it cannot equal one line.
  if (head === undefined || head.includes(span) || (!own.more && head === text.trim())) return null;
  const t = short(head);
  if (t === null) return null;
  return { text: t, at: from === null ? null : lineHeadRange(from.node, from.start, from.raw, t) };
}

/**
 * The first non-empty trimmed line of a text, and whether another non-empty line follows, reading only
 * as far as that second line: the node may be a whole log, and this runs for every span kept from it.
 */
function firstLines(text: string): { first: string | undefined; more: boolean; at?: number } {
  let first: string | undefined;
  let at: number | undefined;
  for (let start = 0; start <= text.length; ) {
    const end = lineEndAt(text, start);
    const line = text.slice(start, end).trim();
    if (line.length > 0) {
      if (first !== undefined) return { first, more: true, ...(at === undefined ? {} : { at }) };
      first = line;
      at = start;
    }
    const next = nextLineStart(text, end);
    if (next < 0) break;
    start = next;
  }
  return { first, more: false };
}

function short(s: string): string | null {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length === 0) return null;
  return t.length <= MAX_CONTEXT_CHARS ? t : `${t.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
}

const RECENCY_TEXT = {
  justLeft: "the window the user just left",
  recent: "a window the user visited in the last two minutes, but not the one they just left",
  earlier: "a window the user visited more than two minutes ago",
  unseen: "a window the user has not visited",
} as const satisfies Record<Recency, string>;

/** The fixed words of a candidate's line (mintCandidate), reserved with a fill request's wording (fill.ts fillWording). */
export const CANDIDATE_WORDING: readonly string[] = ["the user's own \n, which the user told Caret", "labelled '\n'", "in the line '\n'", "in a block that starts '\n'", "under '\n'", "\"\n\" (\n)", "in \n window '\n', \n", ...Object.values(RECENCY_TEXT)];

/**
 * SC1 2b: describeCandidate's line, minted by `d`: the span, its label, line, block head and section as its source
 * window's redacted view shows them, its kind and recency in Caret's words, the app and title of the window, and the
 * memory label of an identity. Null when the source window is gone or a part is not one its view shows or will not fit.
 * `blockHead` false leaves the block head out (SC1 2c, the minimized candidate).
 */
export function mintCandidate(d: Disclosure, model: ScreenModel, c: Candidate, o: { blockHead?: boolean; line?: string | null } = {}): ModelText | null {
  // The view the candidate was read from, which its ranges are of: a refresh since leaves it as it was, and the
  // ledger still measures it (a kept state); whether the source changed is the write recheck's to say.
  const src = sourceOf(c);
  const v = src.view ?? viewOf(model, c.source.windowId);
  if (v === undefined) return null;
  const facts: ModelText[] = [];
  const text = d.candidate(v, c.text, src.text);
  if (text === null) return null;
  const view = (t: string, as: "descriptor" | "candidate"): ModelText | null => (as === "descriptor" ? d.descriptor(v, t) : d.candidate(v, t));
  if (c.kind !== null) facts.push(d.id(c.kind));
  if (c.identity !== undefined) {
    const label = d.memoryText(null, c.identity.label);
    if (label === null) return null;
    facts.push(d.t`the user's own ${label}, which the user told Caret`);
  }
  const line = o.line !== undefined ? o.line : c.line;
  const lineAt = line !== null && line !== undefined && src.line?.text === line ? src.line.at : undefined;
  /** A fact's recorded range, when the fact is still the text the generator read. */
  const rangeOf = (t: string | null | undefined, f: Fact | undefined): SourceAt | undefined => (t !== null && t !== undefined && f?.text === t ? f.at : undefined);
  const parts: [string | null | undefined, "descriptor" | "candidate", (m: ModelText) => ModelText, SourceAt?][] = [
    [c.context !== null && c.context !== c.text ? c.context : null, "descriptor", (m) => d.t`labelled '${m}'`, rangeOf(c.context, src.context)],
    [line, "candidate", (m) => d.t`in the line '${m}'`, lineAt],
    [o.blockHead === false ? null : c.blockHead, "candidate", (m) => d.t`in a block that starts '${m}'`, rangeOf(c.blockHead, src.blockHead)],
    [c.section !== null && c.section !== c.context ? c.section : null, "descriptor", (m) => d.t`under '${m}'`, rangeOf(c.section, src.section)],
  ];
  for (const [t, as, say, at] of parts) {
    if (t === null || t === undefined) continue;
    const m = at === undefined ? view(t, as) : as === "descriptor" ? d.descriptor(v, t, at) : d.candidate(v, t, at);
    if (m === null) return null;
    facts.push(say(m));
  }
  const title = c.source.windowTitle === "" ? d.own("") : d.descriptor(v, c.source.windowTitle, c.source.windowTitle === v.window.title ? wholePart(TITLE, v.window.title) : undefined);
  if (title === null) return null;
  facts.push(d.t`in ${d.app(v)} window '${title}', ${d.own(RECENCY_TEXT[c.recency])}`);
  return d.t`"${text}" (${d.join(facts, "; ")})`;
}

/** One line per candidate: the span, then the facts code knows about where it was found. */
export function describeCandidate(c: Candidate): string {
  const facts: string[] = [];
  if (c.kind !== null) facts.push(c.kind);
  if (c.identity !== undefined) facts.push(`the user's own ${c.identity.label}, which the user told Caret`);
  if (c.context !== null && c.context !== c.text) facts.push(`labelled '${c.context}'`);
  if (c.line !== undefined && c.line !== null) facts.push(`in the line '${c.line}'`);
  if (c.blockHead !== null) facts.push(`in a block that starts '${c.blockHead}'`);
  if (c.section !== null && c.section !== c.context) facts.push(`under '${c.section}'`);
  facts.push(`in ${c.source.appName} window '${c.source.windowTitle}', ${RECENCY_TEXT[c.recency]}`);
  return `"${c.text}" (${facts.join("; ")})`;
}
