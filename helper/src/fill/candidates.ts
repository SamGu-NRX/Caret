// The grounded-fill candidate generator. It collects short spans from every window other than
// the form's own: typed values first, then single lines of visible text, splitting "Label: value"
// lines so the value is the span and the label is its context. Jev later picks among these by id,
// and code copies the chosen span verbatim.
import { Disclosure } from "../privacy/disclosure.ts";
import type { FillSource, Node, TypedValue, ValueKind } from "../protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { nearestText } from "./descriptor.ts";
import { heldAsConversation, heldToHalf } from "../privacy.ts";
import { isKindTerm, isNameLike, kindTerm, NAME_TERM, namesIn, overlap, valueKinds, words } from "./kinds.ts";
import { labelKind, sensitiveKind, valueKind } from "../memory/sensitive.ts";
import { bareLine, clauseAround, LABELLED, lineTexts, lineValues, partAround, sentenceAround, WARNS } from "./line-values.ts";
import { redactWindow } from "./redact.ts";
import { WITHHELD } from "../privacy/exclude.ts";
import { splitDate } from "./derive.ts";

/**
 * A field whose typed value is a candidate, as a line of text is: editable, holding text, not secure, not a kind memory
 * never keeps. A page checkbox is editable too since D2-04 (engines/page-link.ts), but what it holds, "checked", is its
 * state, not text anyone typed.
 */
function sourceField(node: Node): boolean {
  return node.editable === true && (node.value ?? "").length > 0 && !node.states?.includes("secure") && labelKind(node.label) === null && node.role !== "AXCheckBox";
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
 * To: line whose one address is the user's own email from memory. `ownNoteAlone`: in a sentence of the note the user
 * just left that names no other person. `namesOther`: in a sentence that names someone other than the user ("my
 * husband Marcus Cole, …").
 */
export type Placement = "soleRecipient" | "toUsersAddress" | "ownNoteAlone" | "namesOther";
export const PLACEMENT_SAYS: Record<Placement, string> = {
  soleRecipient: "it is the only recipient on the To: line of this mail",
  toUsersAddress: "it is on a To: line whose address is the email the user told Caret is theirs",
  ownNoteAlone: "it is in a sentence of the note the user just left that names no other person",
  namesOther: "it is in a sentence that names someone other than the user",
};

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
const wallClock = (): number => performance.now();
let defaultClock: () => number = wallClock;

/**
 * Sets the clock the budget reads when a call passes none; null puts back the wall clock. Tests whose
 * answers must not depend on the machine's load fix it: under CPU stress the wall clock stopped a long
 * chat partway, which withheld Name on the fill desk in 2 of 20 suite runs (B14). The budget's own tests
 * pass a clock per call instead. The helper never sets it.
 */
export function setGeneratorClock(clock: (() => number) | null): void {
  defaultClock = clock ?? wallClock;
}

/** Nodes or values between clock reads. */
const CLOCK_EVERY = 64;
const MIN_LINE = 2;
const MAX_LINE = 80;
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
 * The kinds of typed value that make a line a contact line ("Dana Whitfield <dana@example.com>", "Priya,
 * (415) 555-0162"), whose names count as kept out when the line is cut (B14). A date or a time does not: "a
 * call with Priya Thursday 3pm PT" is a sentence, and counting "Priya Thursday" withheld every name on Q1's
 * forms (B24).
 */
const CONTACT_KINDS: ReadonlySet<ValueKind> = new Set(["email", "phone", "address"]);

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
   * one, did not fit; a window was cut whose left-out lines were not read; or the cap or the clock
   * stopped the generator partway through a window. Fill then asks no field that takes a name and
   * proposes no name-like value (fill.ts).
   */
  namesCut: boolean;
  /** C1: with GenerateOptions.deferClauses, each offered span's clause, for the caller to charge and set; empty otherwise. */
  clauses: ReadonlyMap<Candidate, string>;
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
  const clock = o.clock ?? defaultClock;
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
  const build = (w: WindowState, node: Node, text: string, kind: ValueKind | null, context: () => string | null, quote?: string, partOf?: string): Candidate => {
    const ctx = timed("context", context);
    const labelled = labelledSpan(node, text, ctx);
    // A span that must go with its line's words (line-values.ts LineText.with, or a clause its line warns in) carries them
    // from the start, charged with it; any other clause waits until every span is in.
    const fact = quote !== undefined ? null : timed("context", () => lineFact(w, node, text, labelled));
    const required = quote ?? (fact?.required === true ? fact.clause : undefined);
    const clause = fact === null || fact.required ? null : fact.clause;
    const c: Candidate = {
    id: `c${out.length + 1}`,
    text,
    kind,
    context: ctx,
    labelled,
    line: required ?? null,
    ...(partOf === undefined ? {} : { partOf }),
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
    };
    if (clause !== null) clauses.set(c, clause);
    if (required !== undefined) quoted.add(c);
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
  const add = (w: WindowState, node: Node, text: string, kind: ValueKind | null, context: () => string | null, quote?: string, partOf?: string): void => {
    // SC1 2a: a span holding a value the model withheld is never a candidate; its line may still be another's context.
    if (full() || seen.has(text) || holdsUnwarned(text) || closed.has(w.window.windowId) || text.includes(WITHHELD)) return;
    const c = build(w, node, text, kind, context, quote, partOf);
    if (o.ledger !== undefined && !o.ledger.take(w, "candidate", candidateTexts(c))) {
      // W2: a part of a labelled value (line-values.ts valueParts) is an extra beside the whole value: one that does not
      // fit is dropped, and the window is neither cut nor closed for it. Counting it as a cut withheld Greenhouse's names
      // (W1's regression: 12/12 to 6/6 canned, evidence/screen/w1 CHECKLIST).
      if (partOf !== undefined) return;
      missed.add(w.window.windowId);
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
    seen.add(text);
    out.push(c);
  };
  const touched = new Set<string>();
  /** The window the generator is reading, if it stops there. */
  let reading: string | null = null;
  const finish = (): Collected => {
    const pending = new Map<Candidate, string>();
    for (const c of out) {
      const clause = clauses.get(c);
      const sw = viewOf(model, c.source.windowId);
      if (clause === undefined || sw === undefined) continue;
      if (o.deferClauses === true) pending.set(c, clause);
      else if (o.ledger === undefined || o.ledger.take(sw, "candidate", [clause])) c.line = clause;
    }
    for (const id of leftOutOf) {
      const lw = viewOf(model, id);
      if (lw !== undefined) leftOut(lw);
    }
    leftOutOf.clear();
    stats.windows = touched.size;
    stats.ms = clock() - t0;
    return { candidates: out, stats, cut: [...missed], cutTerms, cutAll, namesCut: wantsNames && (cutAll || partway || namesKeptOut(cutNames, out)), clauses: pending };
  };
  /**
   * Stops early, on the cap or the clock, partway through `reading`: what of it was offered is a partial
   * set like a privacy cut's, so it is reported cut and fill withholds the kinds it lost (B13 review: a
   * chat's 79 times filled the cap before its meeting date, and an older window's date was asked alone).
   * Windows not reached at all are left out whole; their values are the least recent on screen.
   */
  const stop = (): Collected => {
    if (reading !== null) {
      missed.add(reading);
      // The rest of the window was not read, so whether it held a name is not known (B14 review: the
      // cap stopped a notes window between another window's name and the right one).
      partway = true;
    }
    return finish();
  };

  const cutTerms = new Set<string>();
  let cutAll = false;
  /** Windows, not conversations, that a span did not fit; their left-out lines are read when the generator finishes. */
  const leftOutOf = new Set<string>();
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
      if (seen.has(text)) return true;
      if (++n > LEFT_OUT_MAX || outOfTime()) {
        cutAll = true;
        return false;
      }
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
      for (const raw of nodeText(node).split(/\r?\n/)) {
        for (const sp of lineSpans(raw)) {
          const kinds = (valuesOf.get(node.key) ?? []).filter((v) => sp.line.includes(v.text)).flatMap(valueKinds);
          if (!note(node, sp.text, sp.line, kinds, sp.label ?? (isSourceField ? (node.label ?? null) : null))) return;
        }
      }
    }
  };
  /** The cap or the clock stopped the generator inside a window. */
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
   * them in relevance order. False when the cap or the clock ran out. A span's group is the term of the
   * whole-or-nothing set it goes in with: its kind's for a typed value, NAME_TERM for a name-like line.
   */
  type Span = { node: Node; text: string; kind: ValueKind | null; group: string | null; context: () => string | null; terms: Set<string>; names: string[]; quote?: string; partOf?: string };
  const byRelevance = (w: WindowState, fields: readonly ReadonlySet<string>[]): boolean => {
    const spans: Span[] = [];
    const built = { done: false };
    const finished = rankWindow(w, fields, spans, built);
    if (finished && !missed.has(w.window.windowId)) return true;
    // Cut, or stopped partway: what it left out. Spans the clock stopped it from even listing are unknown.
    // A left-out span's names are weighed at the end against everything offered, as cutKinds weighs
    // typed values, so NAME_TERM stays out of cutTerms.
    if (!built.done) cutAll = true;
    for (const sp of spans) {
      if (seen.has(sp.text)) continue;
      for (const t of sp.terms) if (t !== NAME_TERM) cutTerms.add(t);
      cutNames.push(...sp.names);
    }
    return finished;
  };
  /** byRelevance's work: lists the window's spans into `spans`, then offers them; false when the cap or the clock ran out. */
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
    for (const v of windowValues(w)) {
      if (outOfTime()) return false;
      stats.values++;
      const node = w.nodes.get(v.nodeKey);
      if (node === undefined || secretValue(w, v)) continue;
      const line = lineHolding(nodeText(node), v.text);
      const terms = termsOf(node, line, [v.kind]);
      const names = wantsNames ? namesOutside(line, valuesOf.get(node.key)) : [];
      if (names.length > 0) terms.add(NAME_TERM);
      spans.push({ node, text: v.text, kind: v.kind, group: kindTerm(v.kind), context: () => contextFor(w, node, v.text), terms, names });
    }
    for (const node of w.nodes.values()) {
      if (outOfTime()) return false;
      stats.nodes++;
      const isSourceField = sourceField(node);
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      const lines = timed("split", () => nodeText(node).split(/\r?\n/));
      for (const raw of lines) {
        if (outOfTime()) return false;
        for (const s of lineSpans(raw)) {
          const kinds = (valuesOf.get(node.key) ?? []).filter((v) => s.line.includes(v.text)).map((v) => v.kind);
          const context = s.label !== null ? constant(s.label) : () => lineContext(w, node, lines.length, isSourceField);
          const terms = termsOf(node, s.line, kinds);
          // A source field's own label says what its value is, as contextFor reads it ("Name" for "dana w.").
          const name = wantsNames && isNameLike(s.text, s.label ?? (isSourceField ? (node.label ?? null) : null));
          // A contact line holds a name beside a typed value ("Dana Whitfield <dana@example.com>"): it is not
          // offered as a name, but its cut can keep the name out. A name a sentence mentions without a typed
          // value ("Design review with Priya Raman") is not counted: counting those withheld Full name and
          // Company on every calibration set with the sources as Messages (B14 oracle replay).
          const names = wantsNames && kinds.some((k) => CONTACT_KINDS.has(k)) ? namesOutside(s.line, valuesOf.get(node.key)) : [];
          if (name) names.push(s.text);
          if (names.length > 0) terms.add(NAME_TERM);
          // W2: a part of a labelled value joins no kind's group: the group goes in whole or not at all, so a part and its
          // quote of the whole value spent the names' budget and cut the note (W1's Greenhouse regression). Parts come after.
          spans.push({ node, text: s.text, kind: null, group: name && s.partOf === undefined ? NAME_TERM : null, context, terms, names, ...(s.with === undefined ? {} : { quote: s.with }), ...(s.partOf === undefined ? {} : { partOf: s.partOf }) });
          // Each name a contact line holds goes in with the names too, as its own span, copied verbatim from
          // the line: else "From: Priya Raman <priya.raman@…>" left a name out whenever the line was cut, and
          // the names spent the budget for nothing (B14 oracle replay, Claim form with the sources as Messages).
          for (const n of names) if (n !== s.text) spans.push({ node, text: n, kind: null, group: NAME_TERM, context, terms: new Set([...terms]), names: [n] });
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
    const groups = new Map<string, Candidate[]>();
    for (const k of kindOrder) {
      if (outOfTime()) return false;
      const group: Candidate[] = [];
      const texts = new Set<string>();
      for (const i of order) {
        const sp = spans[i] as (typeof spans)[number];
        if (sp.group !== k || seen.has(sp.text) || holdsUnwarned(sp.text) || texts.has(sp.text)) continue;
        texts.add(sp.text);
        group.push(build(w, sp.node, sp.text, sp.kind, sp.context, sp.quote, sp.partOf));
      }
      if (group.length > 0) groups.set(k, group);
    }
    // Kinds go in by what they cost per field they serve, cheapest first, priced again after each take,
    // since a kind's facts can share texts (the window's title, a section) with one already in. B12 took
    // them in the order the fields first wanted them, so one dear kind could spend the budget that two
    // cheap ones needed. No run measured this before B13's replay.
    const served = (k: string): number => fields.filter((f) => f.has(k)).length;
    for (;;) {
      if (full() || outOfTime()) return false;
      let best: { k: string; rate: number } | null = null;
      for (const [k, group] of groups) {
        const cost = out.length + group.length > max ? null : o.ledger?.cost(w, group.flatMap(candidateTexts));
        if (cost === null || cost === undefined) continue;
        const rate = o.kindsByCost === false ? kindOrder.indexOf(k) : cost / served(k);
        if (best === null || rate < best.rate) best = { k, rate };
      }
      if (best === null) break;
      const group = groups.get(best.k) as Candidate[];
      groups.delete(best.k);
      if (o.ledger?.take(w, "candidate", group.flatMap(candidateTexts)) !== true) throw new Error(`a kind priced to fit did not fit window ${w.window.windowId}`);
      for (const c of group) {
        c.id = `c${out.length + 1}`;
        seen.add(c.text);
        out.push(c);
      }
    }
    /** Kinds left out whole, since none of them fits what is left; a line holding a value of one stays out too. */
    const leftOut = new Set(groups.keys());
    for (const g of groups.values()) for (const c of g) if (quoted.has(c)) unwarned.add(c.text);
    if (leftOut.size > 0) missed.add(w.window.windowId);
    // Then the rest, nearest the fields first, with their facts, until one does not fit.
    for (const i of order.filter((x) => !takesKind(x))) {
      if (full() || outOfTime()) return false;
      if (closed.has(w.window.windowId)) break;
      const sp = spans[i] as (typeof spans)[number];
      if ([...sp.terms].some((t) => leftOut.has(t))) continue;
      add(w, sp.node, sp.text, sp.kind, sp.context, sp.quote, sp.partOf);
    }
    return true;
  };

  for (const w of windows) {
    if (full()) return finish();
    touched.add(w.window.windowId);
    reading = w.window.windowId;
    // A conversation, and (B24) a short window held to under half its text, spend their budget on the spans
    // nearest the form's fields first. In screen order a note's budget went to its first lines: the B24 corpus's
    // notes each have a line over 80 characters, so they are held to half, and their name, address and dates
    // lines came after the cut (evidence/screen/b24/dev-5).
    if (relevance !== null && (heldAsConversation(w) || heldToHalf(w))) {
      ranked.add(w.window.windowId);
      if (!byRelevance(w, relevance)) return stop();
      continue;
    }
    for (const v of windowValues(w)) {
      if (full() || outOfTime()) return stop();
      stats.values++;
      const node = w.nodes.get(v.nodeKey);
      if (node === undefined || secretValue(w, v)) continue;
      add(w, node, v.text, v.kind, () => contextFor(w, node, v.text));
    }
  }
  for (const w of windows) {
    if (full()) break;
    touched.add(w.window.windowId);
    if (closed.has(w.window.windowId) || ranked.has(w.window.windowId)) continue;
    reading = w.window.windowId;
    for (const node of w.nodes.values()) {
      if (full() || outOfTime()) return stop();
      stats.nodes++;
      const isSourceField = sourceField(node);
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      const lines = timed("split", () => nodeText(node).split(/\r?\n/));
      for (const raw of lines) {
        // A node can hold thousands of lines (a log, a transcript), so the cap and the clock apply per line too.
        if (full() || outOfTime()) return stop();
        for (const s of lineSpans(raw)) add(w, node, s.text, null, s.label !== null ? constant(s.label) : () => lineContext(w, node, lines.length, isSourceField), s.with, s.partOf);
      }
    }
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
function spanOfLine(raw: string): { line: string; text: string; label: string | null } | null {
  const line = bareLine(raw);
  if (line.length < MIN_LINE || line.length > MAX_LINE || !/[\p{L}\p{N}]/u.test(line)) return null;
  if (line.endsWith(":")) return null; // a label, not a value
  const m = LABELLED.exec(line);
  // A value Caret never types (a password, a card or account number, a government ID, a one-time code or an API
  // key, by its label or its shape: memory/sensitive.ts) is no span: it is never offered, so no fill or plan can
  // choose it, and it never goes out in a question (B25 lead decision 2).
  if (m !== null && m[1] !== undefined && m[2] !== undefined) return sensitiveKind(m[1], m[2]) === null ? { line, text: m[2].trim(), label: m[1].trim() } : null;
  return valueKind(line) === null ? { line, text: line, label: null } : null;
}

/**
 * Every span a screen line offers (C1): spanOfLine's, then the free text the line bounds (line-values.ts lineTexts), each
 * under its line's label or none. A line of any length offers the bounded text; only spanOfLine's needs it short. Its
 * typed values are offered as the window's typed values (windowValues), not here.
 */
export function lineSpans(raw: string): { line: string; text: string; label: string | null; with?: string; partOf?: string }[] {
  const line = bareLine(raw);
  if (line.length < MIN_LINE) return [];
  const whole = spanOfLine(raw);
  const out: { line: string; text: string; label: string | null; with?: string; partOf?: string }[] = whole === null ? [] : [whole];
  for (const t of lineTexts(line)) if (!out.some((o) => o.text === t.text)) out.push({ line, text: t.text, label: t.label, ...(t.with === undefined ? {} : { with: t.with }), ...(t.partOf === undefined ? {} : { partOf: t.partOf }) });
  return out;
}

/**
 * C1: a window's typed values: the reader's, and those code finds in each line it reads (line-values.ts lineValues) that
 * no reader value of the node overlaps. Code finds them in text the reader did not type (a page the engine read, a
 * replay) and inside lines too long to offer whole. Kept per window state, so the generator, the cut rules and the
 * recheck read the same list.
 */
const valuesCache = new WeakMap<WindowState, readonly TypedValue[]>();
export function windowValues(w: WindowState): readonly TypedValue[] {
  const cached = valuesCache.get(w);
  if (cached !== undefined) return cached;
  const out: TypedValue[] = [...w.values];
  const byNode = new Map<string, TypedValue[]>();
  for (const v of w.values) byNode.set(v.nodeKey, [...(byNode.get(v.nodeKey) ?? []), v]);
  for (const node of w.nodes.values()) {
    if (!LINE_ROLES.has(node.role) && !sourceField(node)) continue;
    const reader = byNode.get(node.key) ?? [];
    const seen = new Set(reader.map((v) => v.text));
    for (const raw of nodeText(node).slice(0, MAX_SCAN).split(/\r?\n/)) {
      const line = bareLine(raw);
      if (line.length < 3) continue;
      for (const v of lineValues(line)) {
        if (seen.has(v.text) || reader.some((r) => r.text.includes(v.text) || v.text.includes(r.text))) continue;
        seen.add(v.text);
        out.push({ kind: v.kind, text: v.text, nodeKey: node.key });
      }
    }
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

export function lineFact(w: WindowState, node: Node, text: string, labelled: boolean): { clause: string; required: boolean } | null {
  const t = nodeText(node);
  const at = t.indexOf(text);
  if (at < 0) return null;
  const raw = lineHolding(t, text);
  const line = bareLine(raw);
  const pos = line.indexOf(text);
  if (pos < 0) return null;
  // A sentence a line break cut, its next line going on in lowercase ("Phone: 555-0101" then "and must not be used ..."),
  // is read on to its end for a warning (C1 review).
  // At most WRAPPED_LINES more lines, read one at a time: a node can be a whole log.
  let joined = line;
  let end = t.indexOf("\n", at);
  for (let k = 0; end >= 0 && k < WRAPPED_LINES && !/[.!?;:]$/u.test(joined); k++) {
    const nl = t.indexOf("\n", end + 1);
    const next = t.slice(end + 1, nl < 0 ? t.length : nl);
    if (!/^\s*\p{Ll}/u.test(next)) break;
    joined = `${joined} ${bareLine(next)}`;
    end = nl;
  }
  if (joined !== line) {
    const sentence = sentenceAround(joined, pos, text);
    if (WARNS.test(sentence.replace(text, " "))) return { clause: sentence, required: true };
  }
  // A sentence that warns ("Don't give out 555-0112, ...", "Phone: 555-0101; do not use this old number.") goes whole with
  // the span on it, or not the span: the warning may be about it, and a clause cut at a semicolon or to a length lost it
  // (C1 review). Only the span's own sentence: a whole line sent for "old" in the next sentence ("Their old chart had
  // 1978") cost corpus clinic-intake two values. A label otherwise says what the span is.
  const sentence = sentenceAround(line, pos, text);
  if (WARNS.test(sentence.replace(text, " "))) return sentence === text ? null : { clause: sentence, required: true };
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
    const clause = partAround(line, pos, text);
    const said = clause === null ? null : (LABELLED.exec(clause)?.[2] ?? clause).trim().replace(/[.!?;,]+$/u, "");
    return clause === null || said === text ? null : { clause, required: false };
  }
  if (labelled) return null;
  const twins = kind !== undefined && values.filter((v) => v.kind === kind).length > 1;
  if (line.length <= MAX_LINE && !twins) return null;
  const clause = clauseAround(line, pos, text);
  return clause === null ? null : { clause, required: false };
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
    for (const raw of nodeText(node).split(/\r?\n/)) {
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
export function labelledCandidate(w: WindowState, node: Node, text: string, label: string, id: string, kind: ValueKind | null, recency: Recency): Candidate {
  return {
    id,
    text,
    kind,
    context: label,
    labelled: true,
    section: sectionAround(w, node),
    blockHead: blockHead(w, node, text),
    recency,
    source: { pid: w.app.pid, windowId: w.window.windowId, bundleId: w.app.bundleId, appName: w.app.name, windowTitle: w.window.title, nodeKey: node.key, kind },
  };
}

/** Whether the span sits on a "Label: value" line of the node whose label is `context`. */
export function labelledSpan(node: Node, text: string, context: string | null): boolean {
  if (context === null || text === "") return false;
  const t = nodeText(node);
  for (let at = t.indexOf(text); at >= 0; at = t.indexOf(text, at + 1)) {
    const start = t.lastIndexOf("\n", at) + 1;
    const nl = t.indexOf("\n", at);
    const m = LABELLED.exec(bareLine(t.slice(start, nl < 0 ? t.length : nl)));
    if (m?.[1]?.trim() === context && m[2]?.includes(text) === true) return true;
  }
  return false;
}

/** The context of an unlabelled line: for a one-line node, its field label or the nearest label text. */
function lineContext(w: WindowState, node: Node, lines: number, isSourceField: boolean): string | null {
  if (lines !== 1) return null;
  return isSourceField ? (node.label ?? nearestText(w, node, true)) : nearestText(w, node, true);
}

/**
 * W2: every label the generator would read a span beside in this node now: its "Label: value" line's label, an editable
 * source field's own label, the nearest text of a one-line node. The write contract's recheck (contract.ts
 * provenanceStale) requires a value's recorded context among them.
 */
export function spanContexts(w: WindowState, node: Node, span: string): string[] {
  const lines = nodeText(node).split(/\r?\n/).length;
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
  const nl = text.indexOf("\n", at);
  return text.slice(text.lastIndexOf("\n", at) + 1, nl < 0 ? text.length : nl);
}

/** The lines of a node's text that hold a span, white space in the span matching any run of spaces or tabs; the span itself when none does. */
function linesHolding(text: string, span: string): string[] {
  const words = span.trim().split(/\s+/u).map((x) => x.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const re = new RegExp(words.join("[ \\t]+"), "u");
  const held = text.split(/\r?\n/u).filter((l) => l.includes(span) || re.test(l));
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
      for (const raw of nodeText(node).split(/\r?\n/)) for (const s of lineSpans(raw)) seen.add(s.text);
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
    const m = LABELLED.exec(bareLine(text.slice(start, nl < 0 ? text.length : nl)));
    if (m !== null && m[1] !== undefined && m[2] !== undefined && m[2].includes(span) && labelNames(m[2].trim(), span)) return m[1].trim();
    if (nl < 0) break;
    at = text.indexOf(span, nl + 1);
  }
  if (node.editable === true && node.label !== undefined) return node.label;
  // A document's text area has no label, and the text above it is its window's title ("Job notes.txt"), which
  // described every value in a note as "labelled 'Job notes.txt'" (B24 capture). A value inside a document has
  // no label but its line's.
  if (node.editable === true && text.includes("\n")) return null;
  return nearestText(w, node, true);
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
  let key = node.parent;
  while (key !== null) {
    const n = w.nodes.get(key);
    if (n === undefined) return null;
    // Nothing above a page's web area is the page's: it is the browser's group named for the window (B24).
    if (n.role === "AXWebArea") return null;
    if (n.label !== undefined) {
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
  if (c.identity !== undefined) facts.push(`the user's own ${c.identity.label}, which the user told Caret`);
  if (c.context !== null && c.context !== c.text) facts.push(`labelled '${c.context}'`);
  if (c.line !== undefined && c.line !== null) facts.push(`in the line '${c.line}'`);
  if (c.blockHead !== null) facts.push(`in a block that starts '${c.blockHead}'`);
  if (c.section !== null && c.section !== c.context) facts.push(`under '${c.section}'`);
  facts.push(`in ${c.source.appName} window '${c.source.windowTitle}', ${RECENCY_TEXT[c.recency]}`);
  return `"${c.text}" (${facts.join("; ")})`;
}
