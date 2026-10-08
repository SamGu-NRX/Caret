// SC1 section 2b: the typed boundary between the screen and a model. A request may carry only text its Disclosure
// minted: Caret's own wording, or screen text read from a redacted view, priced against that window's budget and
// recorded, the same ledger privacy.ts has always kept (SnippetLedger). The record is the brand. A TypeScript brand
// disappears at runtime, so the check that holds is `verify`, run on the body where each request is sent (the Jev
// client, the writer port, the canned harness and the local decision engine): any string in the body that this
// request's Disclosure did not mint throws UnmintedText, naming the path, never the text.
import { assertNoExcludedValue, cut, flat, fold, OWNER_NOTE_CHARS, sectionTexts, SnippetLedger, spansOf, type Snippet, type ViewSpan } from "../privacy.ts";
import { breachWithNotes, measure, normalizedUnits, OperationLedger, splitNotes, viewInventory, type Breach, type Measurement, type OwnerNotes } from "./ledger/account.ts";
import { nodePart, sourceLines, wholePart, type SourceAt } from "./ledger/source.ts";
import { spanKey } from "./ledger/measure.ts";
export { registryOf, type ScreenRegistry } from "./ledger/account.ts";
import { decodeUnits, type DecodedUnit } from "./ledger/units.ts";
import { LedgerEncodingError } from "./ledger/normalize.ts";
import type { WindowState } from "../model.ts";
import { instructionForModel, isRedacted, redactWindow } from "../fill/redact.ts";
import { sensitiveKind } from "../memory/sensitive.ts";
import { excludedValue, withholdValues } from "./exclude.ts";
import { ANY_PATH, childGlob, knownPath, scalarsAt, shapeItems, shapeOf, UNNAMED, type ScalarType, type Slot } from "./shapes.ts";
import { switchedOffCount } from "./read-policy.ts";
import { describeField, type FieldDescriptor } from "../fill/descriptor.ts";
import type { Node } from "../protocol.ts";

/** A window as redactWindow gave it (fill/redact.ts): the only window a Disclosure mints screen text from. */
export type RedactedWindow = WindowState;

/**
 * The redacted view's text as one string: its inventory's lines (ledger/source.ts reads them, as the ledger counts
 * them), and each typed value the view keeps (a date or time the reader read off a line, in its own words),
 * NUL-separated, per view object.
 */
const VIEW_TEXT = new WeakMap<WindowState, string>();

function viewText(view: WindowState): string {
  let s = VIEW_TEXT.get(view);
  if (s !== undefined) return s;
  s = `\u0000${[...viewInventory(view).lines, ...view.values.flatMap((v) => sourceLines(v.text))].join("\u0000")}\u0000`;
  VIEW_TEXT.set(view, s);
  return s;
}

/**
 * Whether the redacted view shows `text`: each of its lines (split, collapsed and trimmed as the inventory's are), with
 * a cut's ellipsis taken off either end, stands inside one line of the view's inventory.
 */
export function viewHolds(view: WindowState, text: string): boolean {
  const pieces = sourceLines(text).map((l) => l.replace(/^\u2026|\u2026$/gu, "")).filter((x) => x !== "");
  if (pieces.length === 0) return false;
  const all = viewText(view);
  return pieces.every((p) => !p.includes("\u0000") && all.includes(p));
}

/** Every part of node `key`'s text in `view`, whole, as declared spans. */
function nodeSpans(view: WindowState, key: string): ViewSpan[] {
  const parts = viewInventory(view).parts;
  return (["label", "value", "placeholder"] as const).flatMap((p) => {
    const map = parts.get(nodePart(key, p));
    return map === undefined ? [] : [{ view, at: wholePart(nodePart(key, p), map.raw) }];
  });
}

/**
 * Whether `at`, a range of a part of `view`'s text, holds `text`: their lines (as the inventory reads them) are the
 * same, but for an ellipsis Caret added at either end of the text, outside the range.
 */
function rangeHolds(view: WindowState, at: SourceAt, text: string): boolean {
  const map = viewInventory(view).parts.get(at.part);
  if (map === undefined || !(0 <= at.start && at.start < at.end && at.end <= map.raw.length)) return false;
  const want = sourceLines(map.raw.slice(at.start, at.end));
  const got = sourceLines(text);
  if (got.length !== want.length || got.length === 0) return false;
  return got.every((l, i) => {
    if (l === want[i]) return true;
    let x = l;
    if (i === 0 && x.startsWith("\u2026") && !want[i]!.startsWith("\u2026")) x = x.slice(1).trimStart();
    if (i === got.length - 1 && x.endsWith("\u2026") && !want[i]!.endsWith("\u2026")) x = x.slice(0, -1).trimEnd();
    return x === want[i];
  });
}

/** Each raw window's value-shaped words that only lines its redacted view removed show (removedValueWords). */
const REMOVED_WORDS = new WeakMap<WindowState, ReadonlySet<string>>();
/** A word as a value is written: letters and digits, with the joining marks keys, codes and handles use inside. */
const VALUE_WORD = /[\p{L}\p{N}][\p{L}\p{N}._@#$%&*!+/-]*[\p{L}\p{N}]/gu;

/**
 * A text's words as they are written, each whole word (VALUE_WORD) and each part of one between its joining marks, so
 * "hunter2" is a word of "https://hunter2@example.test" as of "hunter2" (PV2 re-review). Case is kept: the inner-capital
 * mark of a value ("violetOrchard") is read on the word as written.
 */
function valueWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(VALUE_WORD)) {
    out.add(m[0]);
    for (const part of m[0].split(/[._@#$%&*!+/-]+/u)) if (part !== "") out.add(part);
  }
  return out;
}

/**
 * The words of a raw window's removed lines (lines its redacted view does not show) that look like values, not prose: at
 * least four characters holding a digit, a joining mark, or a capital after a small letter ("hunter2", "Zq7x-Kw",
 * "violetOrchard"), and shown nowhere in the redacted view. A plan text quoting one quotes a secret line's value, however
 * short (PV2 review should-fix; keptByViews' runs of PARTIAL_MIN characters catch only long ones). A plain word
 * ("swordfish") is not caught: the marker grammar is best effort, and this widens it by nothing.
 */
function removedValueWords(raw: WindowState): ReadonlySet<string> {
  let out = REMOVED_WORDS.get(raw);
  if (out !== undefined) return out;
  const view = redactWindow(raw);
  const shown = viewText(view).toLowerCase();
  const words = new Set<string>();
  // Every text the view is built from, SCP1's section texts (Node.headings, Node.outline) included: redaction removes a
  // secret section line as it removes a label's (INT1 review P1: an outline "API key: Zq7x" let "Open Zq7x" through).
  const lines = [raw.window.title, ...[...raw.nodes.values()].flatMap((n) => [n.label, n.value, n.placeholder, ...sectionTexts(n)])].flatMap((t) => (t === undefined || t === "" ? [] : t.split(/\r?\n/u)));
  for (const line of lines) {
    if (flat(line) === "" || viewHolds(view, line)) continue;
    for (const w of valueWords(line)) if (w.length >= 4 && /\p{N}|[._@#$%&*!+/-]|\p{Ll}\p{Lu}/u.test(w) && !shown.includes(w.toLowerCase())) words.add(w.toLowerCase());
  }
  REMOVED_WORDS.set(raw, (out = words));
  return out;
}

declare const brand: unique symbol;
/** Text a Disclosure minted for one request. Only privacy/ makes one. */
export type ModelText = string & { readonly [brand]: "ModelText" };
/** What a request's state or a writer's input may hold: minted text, numbers, booleans, null, and lists and records of them. */
export type ModelValue = ModelText | number | boolean | null | readonly ModelValue[] | { readonly [k: string]: ModelValue };

/** A value whose every string is minted text: the type of a writer's input once its builder minted it. */
export type Minted<T> = T extends string ? (string extends T ? ModelText : T & ModelText) : T extends (infer U)[] ? Minted<U>[] : T extends readonly (infer U)[] ? readonly Minted<U>[] : T extends object ? { [K in keyof T]: Minted<T[K]> } : T;

/**
 * Why a text may be sent (SC1 2b):
 * - ownWording: Caret's own wording, code literals, never screen text;
 * - descriptor: a kept node's label or placeholder, or a window's title or app name, from the redacted view;
 * - candidate: a kept node's value, or a typed value, from the redacted view;
 * - instruction: the user's instruction as instructionForModel gives it;
 * - memory: an About or saved-answer entry the user told Caret, that sensitiveKind passes;
 * - held: a string computed locally that the redacted view holds (a program's output, a derivation);
 * - plan: a step's goal or target as a plan Caret wrote says it (executor/target.ts), priced as plan text: the plan was
 *   built from minted text when it was proposed, and its values may quote any window, so every line it shows is charged;
 * - drafted: a sentence Caret's local model drafted (goals/drafts.ts), checked by Jev before it is offered.
 */
export type MintReason = "ownWording" | "descriptor" | "candidate" | "instruction" | "memory" | "held" | "plan" | "drafted";

/** A request body carried a string its Disclosure never minted, or it had no Disclosure. Never names the text. */
export class UnmintedText extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnmintedText";
  }
}

/**
 * SC1 2c: a minted text at a path its request's shape (privacy/shapes.ts) has no row for, minted for a reason its slot
 * does not allow, or longer than its slot; or a request whose purpose has no shape. Never names the text.
 */
export class OutOfShape extends UnmintedText {
  constructor(message: string) {
    super(message);
    this.name = "OutOfShape";
  }
}

/**
 * The output ledger refused a request at seal (OUTPUT-LEDGER-SPEC section 6): what its final bytes reveal of a window
 * breaks that window's limit, a text in it cannot be measured, or its Disclosure has no registry to
 * measure against. Names the purpose, the window and the bound, never text.
 */
export class LedgerRefused extends UnmintedText {
  constructor(message: string) {
    super(message);
    this.name = "LedgerRefused";
  }
}

/** A request a shape's chosen limit refused: a text over its slot's length, or a list over its item count. */
export type ShapeLengthRefusal = { purpose: string; slot: string; max: number } & ({ length: number } | { items: number });

let shapeLengthLog: (r: ShapeLengthRefusal) => void = (r) => {
  process.stderr.write(`[caret-privacy ${new Date().toISOString()}] shape refused on a limit: ${JSON.stringify(r)}\n`);
};

/**
 * Where a refusal on a length or an item count is logged (privacy/shapes.ts: the limits are chosen, not measured): the
 * helper's stderr unless set.
 * Returns the one it replaced.
 */
export function setShapeLengthLog(log: (r: ShapeLengthRefusal) => void): (r: ShapeLengthRefusal) => void {
  const was = shapeLengthLog;
  shapeLengthLog = log;
  return was;
}

/** How many ways of minting one text a Disclosure keeps, and how many a composition may produce, before it keeps their union. */
const MAX_WAYS = 8;

/** The parts of a decision or writer request that leave the Mac, as builders write them before they are sealed. */
interface Sealable {
  purpose?: string;
  kind?: string;
  state?: unknown;
  questions?: unknown;
  nouls?: unknown;
  input?: unknown;
}

/**
 * Object keys a body may use. Keys are never minted, so none may carry screen text: an id, a state field's name or an
 * option name is Caret's own short identifier. A key holding a space or longer than this is refused as unminted.
 */
const KEY = /^[A-Za-z0-9_.:~#+-]{1,64}$/u;
/**
 * Words code writes when it derives a text from screen text (Disclosure.derived): the calendar's words, as times and
 * dates are said (offers/event-time.ts, fill/derive.ts), and the joining words between their parts.
 */
const DERIVED_WORDS: ReadonlySet<string> = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  "am", "pm", "a", "p", "m", "utc", "noon", "midnight", "today", "tomorrow", "yesterday", "at", "to", "from", "on", "until", "and", "or", "of", "the", "in",
]);
/** The separators Caret's own code joins minted texts with (Disclosure.join). */
const SEPARATORS: ReadonlySet<string> = new Set([" ", ", ", "; ", " and ", " or ", "; or ", ", and ", ", or ", "\n", "\n\n", " / "]);
/** What Disclosure.id takes: a code-made identifier. */
const ID = /^[A-Za-z0-9_.:~#+/-]{1,96}$/u;

/** Paths in a Jev wire body that the client itself writes and are never screen text, each with the only values allowed. */
const EXEMPT_EXACT: readonly { path: RegExp; values: ReadonlySet<string> | null }[] = [
  // The model id the client sends (fill/jev.ts wireBody); the route chose it, not a builder.
  { path: /^model$/u, values: null },
  // The gateway's provider pin (fill/jev.ts makeJevClient).
  { path: /^providerOptions\.gateway\.only\[\d+\]$/u, values: null },
  // The question kind is the protocol's, one of two words.
  { path: /^questions\.[^.]+\.type$/u, values: new Set(["choice", "noul"]) },
];

/** Only Disclosure.basis makes a Basis: its constructor takes this module's own token. */
const BASIS_TOKEN = Symbol("basis");

/** A text of a redacted view a derivation may read words from (Disclosure.basis); never sent itself. */
export class Basis {
  readonly of: object;
  readonly text: string;
  /** The redacted view the text was read from, which a derivation from it declares its span under. */
  readonly view: WindowState | null;
  /** Where in `view` the text was read, if the producer recorded it; a derivation declares all of it. */
  readonly at: SourceAt | null;
  constructor(token: symbol, of: object, text: string, view: WindowState | null = null, at: SourceAt | null = null) {
    if (token !== BASIS_TOKEN) throw new UnmintedText("a Basis comes only from Disclosure.basis");
    this.of = of;
    this.text = text;
    this.view = view;
    this.at = at;
  }
}

/**
 * Marks a Disclosure across module instances: a test that reloads the client's modules (vi.resetModules) still hands it
 * a request built with the Disclosure class it imported first, so the check is by this registered symbol, not instanceof.
 */
const IS_DISCLOSURE = Symbol.for("caret.privacy.disclosure");

function asDisclosure(x: unknown): Disclosure | null {
  return typeof x === "object" && x !== null && (x as { [IS_DISCLOSURE]?: unknown })[IS_DISCLOSURE] === true ? (x as Disclosure) : null;
}

/**
 * The one ledger a request's screen text goes through (privacy.ts SnippetLedger, whose budgets it keeps unchanged) and
 * the record of every text it minted. Construct one per request, over every window whose lines the request could reveal.
 */
export class Disclosure extends SnippetLedger {
  readonly [IS_DISCLOSURE] = true;
  /** Every text minted for this request, with the reasons it was minted under. */
  private readonly mints = new Map<string, Set<MintReason>>();
  /** Section 7: the requests sent through this Disclosure are one operation, held together to each conversation's limit. */
  private readonly operation = new OperationLedger();
  /** Section 8: each whole owner note this Disclosure minted, with the redacted view it was read from. */
  private readonly ownerNotes = new Map<string, WindowState>();
  /** privacy/read-policy.ts switchedOffCount when this Disclosure was made: verify refuses once it moves. */
  private readonly policy = switchedOffCount();
  /**
   * Each way a text was minted, as the set of reasons that one minting carried. The same string may be minted twice for
   * different reasons (a count "2" Caret wrote and a "2" a field shows): a shape's slot accepts a text when one way of
   * minting it fits, so a coincidence never refuses a request, while a text composed from a candidate carries that
   * candidate in every way of minting it.
   */
  private readonly ways = new Map<string, MintReason[][]>();
  /** Texts jsonText wrote: verify parses each and checks the strings it holds against the shape. */
  private readonly asJson = new Set<string>();
  /**
   * Section 4: each minted text's declared spans, with the redacted view each was read from: the source range a producer
   * recorded where it read the text, or, from a producer that cannot know its range, the text itself (which charges
   * every line of the view holding it). A composition carries its parts' spans. The seal charges them as they are
   * (ledger/measure.ts spanPositions).
   */
  private readonly spans = new Map<string, ViewSpan[]>();

  /** Adds declared spans to a minted text. */
  private declareSpans(text: string, spans: Iterable<ViewSpan>): void {
    let l = this.spans.get(text);
    for (const sp of spans) {
      if (l === undefined) this.spans.set(text, (l = []));
      if (!l.some((x) => x.view === sp.view && spanKey(x) === spanKey(sp))) l.push(sp);
    }
  }

  /** A composed text, recorded with its ways, carrying the declared spans of `parts`. */
  private composed(text: string, ways: readonly (readonly MintReason[])[], parts: readonly string[]): ModelText {
    this.declareSpans(text, parts.flatMap((p) => this.spans.get(p) ?? []));
    return this.recordWays(text, ways);
  }

  /** Records `text` as minted under `reasons`, as one way of minting it, and brands it. */
  private record(text: string, reasons: Iterable<MintReason>): ModelText {
    return this.recordWays(text, [[...reasons]]);
  }

  /** Records `text` as minted in each of `ways` (each a set of reasons) and brands it. */
  private recordWays(text: string, ways: readonly (readonly MintReason[])[]): ModelText {
    let r = this.mints.get(text);
    if (r === undefined) this.mints.set(text, (r = new Set()));
    let kept = this.ways.get(text);
    if (kept === undefined) this.ways.set(text, (kept = []));
    for (const way of ways) {
      for (const x of way) r.add(x);
      const sorted = [...new Set(way)].sort();
      if (!kept.some((k) => k.length === sorted.length && k.every((x, i) => x === sorted[i]))) kept.push(sorted);
    }
    // Past MAX_WAYS, one way holding every reason stands for them all: a slot then accepts it only if it allows all.
    if (kept.length > MAX_WAYS) this.ways.set(text, [[...r].sort()]);
    return text as ModelText;
  }

  /**
   * The ways of minting a text composed of `parts`, each of which must be minted, with `own` added when Caret's own
   * wording joins them: one way for each choice of one way per part. Past MAX_WAYS, one way holding every reason.
   */
  private composedWays(parts: readonly string[], where: string, own: boolean): MintReason[][] {
    let out: MintReason[][] = [own ? ["ownWording"] : []];
    for (const p of parts) {
      this.reasons(p, where);
      const ways = this.ways.get(p) ?? [];
      if (out.length * ways.length > MAX_WAYS) {
        const all = new Set<MintReason>(own ? ["ownWording"] : []);
        for (const q of parts) for (const x of this.reasons(q, where)) all.add(x);
        return [[...all]];
      }
      out = out.flatMap((o) => ways.map((w) => [...o, ...w]));
    }
    return out;
  }

  /** The reasons `text` was minted under, or null when this Disclosure never minted it. */
  reasonsOf(text: string): ReadonlySet<MintReason> | null {
    return this.mints.get(text) ?? null;
  }

  /** The reasons a text this Disclosure minted carries; throws UnmintedText when it never minted it. */
  private reasons(text: string, where: string): Set<MintReason> {
    const r = this.mints.get(text);
    if (r === undefined) throw new UnmintedText(`${where}: a part was not minted for this request`);
    return r;
  }

  /**
   * Screen text read from a redacted view, admitted by the ledger's early check (SnippetLedger) and recorded under
   * `reason`, with its declared span: `at`, the source range the producer read it from, or else the text. Null when the
   * view does not show it (it is not screen text the view keeps, so it is never sent) or when it would break a window's
   * bound. The seal measures it again in the request's final bytes. Throws when `at` does not hold the text: a producer
   * that records the wrong range would under-charge.
   */
  private fromView(view: RedactedWindow, text: string, reason: "descriptor" | "candidate" | "held", at?: SourceAt): ModelText | null {
    if (!isRedacted(view)) throw new UnmintedText(`a ${reason} was read from a window that is not a redacted view`);
    if (text === "" || !viewHolds(view, text)) return null;
    if (at !== undefined && !rangeHolds(view, at, text)) throw new Error(`a ${reason}'s recorded source range [${at.start}, ${at.end}) of ${JSON.stringify(at.part)} does not hold its text`);
    this.know(view);
    const spans: ViewSpan[] = [at === undefined ? { view, text } : { view, at }];
    // A typed value in the reader's own words may stand in no line: it charges the node it was read from, whole.
    if (at === undefined) for (const v of view.values) if (sourceLines(text).some((l) => v.text.includes(l.replace(/^\u2026|\u2026$/gu, "")))) spans.push(...nodeSpans(view, v.nodeKey));
    if (!this.admitTexts([text], { under: view.window.windowId, kind: reason === "descriptor" ? "descriptor" : "candidate", spans })) return null;
    this.declareSpans(text, spans);
    return this.record(text, [reason]);
  }

  /**
   * A field's descriptor as fill/descriptor.ts describeField words it for a node of the redacted view, read from that
   * view here: its role in Caret's words, and its label, nearest label, placeholder and section as the view shows them.
   * Priced as one text, as the builders that send whole descriptors have always taken them, unless already taken.
   */
  fieldDescriptor(view: RedactedWindow, node: Node, fd: FieldDescriptor = describeField(view, node)): ModelText | null {
    if (!isRedacted(view)) throw new UnmintedText("a descriptor was read from a window that is not a redacted view");
    if (view.nodes.get(node.key) === undefined) return null;
    const own = describeField(view, node);
    if (own.text !== fd.text) return null;
    const parts = [fd.label, fd.nearest, fd.placeholder, fd.section].filter((t): t is string => t !== null);
    for (const t of parts) if (!viewHolds(view, t)) return null;
    // Its window texts are declared one by one; the whole descriptor, Caret's words included, is what the early check
    // measures, as the seal will.
    this.know(view);
    const spans = parts.map((t) => ({ view, text: t }));
    if (!this.admitTexts(parts, { under: view.window.windowId, kind: "descriptor", spans }) || !this.admitTexts([fd.text], { under: null, kind: "descriptor", spans })) return null;
    this.declareSpans(fd.text, spans);
    return this.record(fd.text, ["descriptor"]);
  }

  /**
   * A kept node's label or placeholder, a window's title, or another name the redacted view shows for something. `at`:
   * where it was read (fromView).
   */
  descriptor(view: RedactedWindow, text: string | null | undefined, at?: SourceAt): ModelText | null {
    return text === null || text === undefined ? null : this.fromView(view, text, "descriptor", at);
  }

  /** A kept node's value or a typed value, as the redacted view shows it. `at`: where it was read (fromView). */
  candidate(view: RedactedWindow, text: string | null | undefined, at?: SourceAt): ModelText | null {
    return text === null || text === undefined ? null : this.fromView(view, text, "candidate", at);
  }

  /**
   * Section 8: a whole note an owner question shows, read from its redacted view. A note of at most OWNER_NOTE_CHARS
   * from a window that is no conversation counts against that window's owner-note allotment instead of its limit, and
   * only where it stands whole in a request's state.source_notes; any other note is a candidate like any text.
   */
  ownerNote(view: RedactedWindow, text: string): ModelText | null {
    if (!this.ownerNoteFits(view, text)) return this.candidate(view, text);
    if (!isRedacted(view)) throw new UnmintedText("an owner note was read from a window that is not a redacted view");
    if (text === "" || !viewHolds(view, text)) return null;
    this.know(view);
    if (!this.admitTexts([text], { under: view.window.windowId, kind: "candidate", noteOf: view })) return null;
    this.ownerNotes.set(text, view);
    return this.record(text, ["candidate"]);
  }

  /**
   * ownerNote for every text, each from the first window this Disclosure was built over whose redacted view shows it
   * whole: all of them or, when one cannot go, none (MERGE-CASES b2).
   */
  ownerNotesOnScreen(texts: readonly string[]): ModelText[] | null {
    const views = [...this.known.values()].map(redactWindow);
    const takes = texts.map((text) => ({ w: views.find((v) => viewHolds(v, text)), text }));
    if (!takes.every((t): t is { w: WindowState; text: string } => t.w !== undefined) || !this.notesFit(takes)) return null;
    const out = takes.flatMap((t) => this.ownerNote(t.w, t.text) ?? []);
    return out.length === takes.length ? out : null;
  }

  /**
   * Section 8: which of a request's decoded units are its owner notes: a string standing whole at state.source_notes.<id>
   * that this Disclosure minted as an owner note, by the view it was read from.
   */
  ownerNoteUnits(units: readonly DecodedUnit[]): OwnerNotes {
    const out = new Map<WindowState, Set<number>>();
    units.forEach((u, i) => {
      const view = u.kind === "string" && u.path.length === 3 && u.path[0] === "state" && u.path[1] === "source_notes" ? this.ownerNotes.get(u.text) : undefined;
      if (view === undefined) return;
      let s = out.get(view);
      if (s === undefined) out.set(view, (s = new Set()));
      s.add(i);
    });
    return out;
  }

  /**
   * A text some window this Disclosure was built over shows in its redacted view, read from the first that does: a
   * person's name the user picked from those on screen. Null when no view shows it or it will not fit.
   */
  onScreen(text: string): ModelText | null {
    for (const w of this.known.values()) {
      const v = redactWindow(w);
      if (viewHolds(v, text)) return this.fromView(v, text, "candidate");
    }
    return null;
  }

  /** A string code computed locally (a program's output, a part of a value) that the redacted view shows as it is. */
  held(view: RedactedWindow, text: string | null | undefined, at?: SourceAt): ModelText | null {
    return text === null || text === undefined ? null : this.fromView(view, text, "held", at);
  }

  /**
   * A plan's own text, a step's goal or target (MintReason plan), priced as plan text (SnippetLedger.plan): every line of
   * a window it shows is charged to that window. Null when one would go over its budget.
   */
  planText(text: string): ModelText | null {
    if (!this.keptByViews(text) || !this.plan([text])) return null;
    return this.record(text, ["plan"]);
  }

  /**
   * A text code wrote from what it read on screen (a reading's assumptions, the choice it made), held (MintReason held):
   * minted when every line of a window it reveals is kept by that window's redacted view, priced as plan text.
   */
  heldText(text: string): ModelText | null {
    if (!this.keptByViews(text) || !this.plan([text])) return null;
    return this.record(text, ["held"]);
  }

  /**
   * Whether every line of a window that `text` reveals (SnippetLedger's reading: each line it holds, and each window
   * that shows a piece of it) is kept by that window's redacted view. Plan and draft text are code's, built from minted
   * text, but a value can be anything code chose; one that shows a line redaction removed never mints.
   */
  private keptByViews(text: string): boolean {
    const pieces = text.split("\n").map((raw) => flat(raw).replace(/^…|…$/gu, "")).filter((x) => x !== "");
    for (const piece of pieces) {
      const r = this.revealed(piece);
      for (const [line, ids] of r.lines) for (const id of ids) {
        const w = this.known.get(id);
        if (w !== undefined && !viewHolds(redactWindow(w), line)) return false;
      }
      for (const id of r.shownBy) {
        const w = this.known.get(id);
        if (w !== undefined && !viewHolds(redactWindow(w), piece)) return false;
      }
      // And every run of it a line shows (PARTIAL_MIN or more characters): a value quoted out of a removed line.
      for (const [run, ids] of this.partialRuns(piece)) for (const id of ids) {
        const w = this.known.get(id);
        if (w !== undefined && !viewHolds(redactWindow(w), run)) return false;
      }
      // And a shorter value-shaped word only a removed line shows ("The note says hunter2").
      const said = new Set([...valueWords(piece)].map((w) => w.toLowerCase()));
      if (said.size > 0) for (const w of this.known.values()) for (const word of removedValueWords(w)) if (said.has(word)) return false;
    }
    return true;
  }

  /**
   * A sentence the local model drafted (MintReason drafted), priced as plan text: a draft quotes the windows it was
   * drafted from. Null when one would go over its budget.
   */
  draftedText(text: string): ModelText | null {
    if (!this.keptByViews(text) || !this.plan([text])) return null;
    return this.record(text, ["drafted"]);
  }

  /**
   * Whether `text` may be quoted as a window's own: this Disclosure was built over the window `windowId` and its redacted
   * view shows the text (viewHolds). A provenance names its window but was not read from a view here.
   */
  shownIn(windowId: string, text: string): boolean {
    const w = this.known.get(windowId);
    return w !== undefined && viewHolds(redactWindow(w), text);
  }

  /** The app a window belongs to, by the name the reader gives it: not screen text the window shows, but a descriptor of it. */
  app(view: RedactedWindow): ModelText {
    if (!isRedacted(view)) throw new UnmintedText("an app name was read from a window that is not a redacted view");
    return this.appText(view.app.name);
  }

  /**
   * An app's name, minted once per request: reader metadata, but a window may show it too (a title, a line), and then
   * sending it reveals that (takeShown charges every window that shows it). When that will not fit, the app is named in
   * Caret's words instead, "an app".
   */
  private appText(name: string): ModelText {
    if (this.mints.has(name) && (this.ways.get(name) ?? []).some((w) => w.includes("descriptor"))) return name as ModelText;
    // An app name is runtime text like any other (OUTPUT-LEDGER-SPEC section 3): measured against every window, each
    // line it shows declared under its window.
    if (!this.admitTexts([name], { under: null, kind: "descriptor", lines: true })) return this.own("an app");
    return this.record(name, ["descriptor"]);
  }

  /** The user's instruction as a model may read it (fill/redact.ts instructionForModel): its secret clauses replaced. */
  instruction(raw: string): ModelText {
    return this.record(instructionForModel(raw), ["instruction"]);
  }

  /**
   * A span of the user's instruction as a model may read it: minted only when it stands in the instruction's model
   * text (instructionForModel), so a span of a withheld clause never goes out.
   */
  instructionSpan(raw: string, span: string): ModelText | null {
    const shown = instructionForModel(raw);
    if (span === "" || !shown.includes(span)) return null;
    return this.record(span, ["instruction"]);
  }

  /**
   * A value the user told Caret (an About entry or a saved answer) and its label, priced against every window whose lines
   * it reveals (SnippetLedger.memory). Null when it names a kind Caret never sends (memory/sensitive.ts sensitiveKind) or
   * a window would go over its budget.
   */
  memoryText(label: string | null, text: string): ModelText | null {
    if (text === "" || sensitiveKind(label, text) !== null || excludedValue(text) !== null) return null;
    if (!this.memory([text])) return null;
    return this.record(text, ["memory"]);
  }

  /**
   * Caret's own wording: a string literal in code. Its type takes literal types only, so a `string` variable does not
   * compile here; build sentences around screen text with `t`.
   */
  own<S extends string>(s: string extends S ? never : S): S & ModelText {
    return this.record(s, ["ownWording"]) as S & ModelText;
  }

  /**
   * An identifier code made (a question or option id, a ref like "v3", a window id, a digest): no spaces, at most 96
   * characters. It is Caret's own wording; screen text goes through descriptor, candidate or held.
   */
  id(s: string): ModelText {
    if (!ID.test(s)) throw new UnmintedText("id() takes a code-made identifier: no spaces, at most 96 characters");
    return this.record(s, ["ownWording"]);
  }

  /** A text this Disclosure minted before, for another request that shares the ledger; null when it never minted it. */
  again(text: string): ModelText | null {
    return this.mints.has(text) ? (text as ModelText) : null;
  }

  /**
   * A text code derived from minted ones (a time read from a sentence, a part of a name, a date in a field's format, a
   * name composed of labels), minted when each of its words is a word of some `base`, a number, one of DERIVED_WORDS
   * (calendar words code writes), or one of `codeWords`, the caller's own literal vocabulary. Null otherwise: a
   * derivation never brings in a word the screen did not show. It carries the bases' reasons and held.
   */
  derived<W extends string = never>(base: ModelText | Basis | readonly (ModelText | Basis)[], text: string, codeWords: readonly (string extends W ? never : W)[] = []): ModelText | null {
    const bases = typeof base === "string" || base instanceof Basis ? [base] : base;
    const shown = new Set<string>(codeWords.map((w) => w.toLowerCase()));
    const minted: ModelText[] = [];
    for (const b of bases) {
      if (b instanceof Basis) {
        if (b.of !== this) throw new UnmintedText("derived: a basis read for another request");
      } else minted.push(b);
      const t = b instanceof Basis ? b.text : b;
      for (const w of t.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w !== "") shown.add(w);
    }
    const ws = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x !== "");
    if (ws.length === 0 && text.trim() !== "") return null;
    for (const w of ws) if (!shown.has(w) && !/^\d+(?:st|nd|rd|th|am|pm|h)?$/u.test(w) && !DERIVED_WORDS.has(w)) return null;
    // What the derivation says is what it reveals: the text itself is measured against every window, as the seal will
    // measure it, and declared under the first basis's window (OUTPUT-LEDGER-SPEC: charge the final text, not its bases).
    const view = bases.find((b): b is Basis => b instanceof Basis && b.view !== null)?.view ?? null;
    if (view !== null) this.know(view);
    // Its declared spans: each basis read from a view, whole (what it read, not what it reproduced), and a minted base's
    // own spans.
    const spans: ViewSpan[] = bases.flatMap((b) => (b instanceof Basis ? (b.view === null ? [] : [b.at === null ? { view: b.view, text: b.text } : { view: b.view, at: b.at }]) : (this.spans.get(b) ?? [])));
    if (!this.admitTexts([text], { under: view === null ? null : view.window.windowId, kind: "candidate", spans })) return null;
    this.declareSpans(text, spans);
    return this.recordWays(text, this.composedWays(minted, "derived", false).map((w) => [...w, "held" as const]));
  }

  /**
   * A text of the redacted view that a derivation reads its words from (derived), neither priced nor minted itself: a
   * sentence an event's title is read from. A derivation from it declares the whole basis as its span: `at`, where the
   * producer read it, or else its text (fromView). Null when the view does not show it. Throws when `at` does not hold
   * the text.
   */
  basis(view: RedactedWindow, text: string, at?: SourceAt): Basis | null {
    if (!isRedacted(view)) throw new UnmintedText("a basis was read from a window that is not a redacted view");
    if (!viewHolds(view, text)) return null;
    if (at !== undefined && !rangeHolds(view, at, text)) throw new Error(`a basis's recorded source range [${at.start}, ${at.end}) of ${JSON.stringify(at.part)} does not hold its text`);
    this.know(view);
    return new Basis(BASIS_TOKEN, this, text, view, at ?? null);
  }

  /**
   * An app's name as the reader gives it, minted when some window this Disclosure was built over belongs to that app:
   * reader metadata that describes a window, not text the window shows.
   */
  appNamed(name: string): ModelText | null {
    for (const w of this.known.values()) if (w.app.name === name) return this.appText(name);
    return null;
  }

  /** Caret's own wording for each option of a question: a record whose values are string literals (`as const`). */
  ownRecord<R extends Readonly<Record<string, string>>>(r: string extends R[keyof R] ? never : R): { readonly [K in keyof R]: ModelText } {
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, this.record(v, ["ownWording"])])) as { readonly [K in keyof R]: ModelText };
  }

  /** A number code computed (a count, a position, a size) written as Caret writes it. */
  count(n: number): ModelText {
    if (!Number.isFinite(n)) throw new UnmintedText("count() takes a finite number");
    return this.record(String(n), ["ownWording"]);
  }

  /**
   * A sentence of Caret's wording around texts this Disclosure minted: t`A form in the ${where} has this field: ${d}`.
   * Every hole must be minted text; the result carries the holes' reasons, and ownWording for the literal parts.
   */
  t(strings: TemplateStringsArray, ...holes: readonly ModelText[]): ModelText {
    if (!Array.isArray((strings as { raw?: unknown }).raw) || !Object.isFrozen(strings)) throw new UnmintedText("t takes a template literal");
    let out = strings[0] ?? "";
    holes.forEach((h, i) => {
      if (typeof h !== "string") throw new UnmintedText("t: a hole is not text");
      out += h + (strings[i + 1] ?? "");
    });
    return this.composed(out, this.composedWays(holes, "t", strings.some((s) => s !== "")), holes);
  }


  /** A minted text cut to `max` characters with an ellipsis (privacy.ts cut); it keeps its reasons. */
  cut(s: ModelText, max?: number): ModelText {
    return this.composed(cut(s, max), this.composedWays([s], "cut", false), [s]);
  }

  /** A minted text's first `max` characters, with no ellipsis (String.slice); it keeps its reasons. */
  slice(s: ModelText, max: number): ModelText {
    return this.composed(s.slice(0, max), this.composedWays([s], "slice", false), [s]);
  }

  /** A minted text with its whitespace collapsed (privacy.ts flat); it keeps its reasons. */
  flat(s: ModelText): ModelText {
    return this.composed(flat(s), this.composedWays([s], "flat", false), [s]);
  }

  /**
   * Minted texts joined by a separator: one of Caret's own (SEPARATORS, a string literal at every call), or a text this
   * Disclosure minted, whose reasons the result then carries. Any other separator throws UnmintedText, since a string's
   * type cannot show at runtime whether it was a literal.
   */
  join<S extends string>(parts: readonly ModelText[], sep: string extends S ? never : S): ModelText;
  join(parts: readonly ModelText[], sep: ModelText): ModelText;
  join(parts: readonly ModelText[], sep: string): ModelText {
    const text = parts.join(sep);
    if (parts.length < 2 || sep === "") return this.composed(text, this.composedWays(parts, "join", false), parts);
    if (SEPARATORS.has(sep)) return this.composed(text, this.composedWays(parts, "join", true), parts);
    if (this.mints.has(sep)) return this.composed(text, this.composedWays([...parts, sep], "join", false), [...parts, sep]);
    throw new UnmintedText("join: the separator is neither Caret's own nor minted for this request");
  }

  /**
   * Attaches this Disclosure to a request and verifies its body as built, so a builder's miss fails in every test that
   * builds the request, as it does at the client. A Jev request's body is its state, questions and yes/no questions; a
   * writer request's is its input.
   */
  seal<R extends Sealable>(req: R): R & { disclosure: Disclosure } {
    const sealed = { ...req, disclosure: this };
    // The client's format check, at build too (privacy.ts assertNoExcludedValue).
    assertNoExcludedValue(req as Parameters<typeof assertNoExcludedValue>[0]);
    if (req.input !== undefined && req.kind !== undefined) this.verify(req.kind, req.input, "input");
    else {
      // The questions as given: a value that is not an object is checked as it is, not spread into one.
      const q = req.questions;
      const questions = req.nouls === undefined || typeof q !== "object" || q === null ? q : { ...q, ...(req.nouls as object) };
      this.verify(req.purpose ?? UNNAMED, { state: req.state, questions });
    }
    return sealed;
  }

  /**
   * Every string in a body is a text this Disclosure minted, every key is a short identifier, the paths the client
   * writes itself hold only their allowed values, and every text fits its purpose's shape (privacy/shapes.ts): its path
   * has a row, one way it was minted carries only reasons the row allows, and it is no longer than the row's max.
   * Throws UnmintedText (OutOfShape for a shape's rule) naming the purpose and the path, never the text. `root` names
   * the body in paths: "" for a Jev wire body, "input" for a writer's input.
   */
  verify(purpose: string, body: unknown, root = ""): void {
    // The user switched an app or a site off since this request's text was read (PV2 re-review): none of it is sent,
    // whichever window it came from, since what was read before the switch is not rechecked text by text.
    if (switchedOffCount() !== this.policy) throw new UnmintedText(`${purpose}: an app or a site was switched off after this request was built; it was not sent`);
    const shape = shapeOf(purpose);
    if (shape === null) throw new OutOfShape(`${purpose} has no request shape (privacy/shapes.ts), so nothing in it may be sent; it was not sent`);
    const check = (path: string, glob: string, v: string): void => {
      // A whole state sent as one JSON text (Disclosure.jsonText; engines/decide/harness.ts layaState) is checked as the
      // state that text writes, parsed from the text itself. Only there: anywhere else a JSON text is a text like any
      // other, held to its own slot's reasons and length (PV2 re-review).
      if (path === "state" && glob === "state" && this.asJson.has(v)) return this.walk(purpose, JSON.parse(v) as unknown, path, check, glob, { count, scalar, key });
      const slot: Slot | undefined = shape[glob] ?? shape[ANY_PATH];
      if (slot === undefined) throw new OutOfShape(`${purpose}: ${path} has no row in the request shapes (privacy/shapes.ts, ${glob}); it was not sent`);
      if (v.length > slot.max) {
        shapeLengthLog({ purpose, slot: glob, length: v.length, max: slot.max });
        throw new OutOfShape(`${purpose}: ${path} holds ${v.length} characters, more than its shape's ${slot.max}; it was not sent`);
      }
      const ways = this.ways.get(v) ?? [];
      if (!ways.some((w) => w.every((r) => slot.reasons.includes(r)))) throw new OutOfShape(`${purpose}: ${path} carries text minted as ${[...(this.mints.get(v) ?? [])].sort().join(", ")}, which its shape allows only as ${slot.reasons.join(", ")}; it was not sent`);
    };
    const scalar = (path: string, glob: string, type: ScalarType): void => {
      if (!scalarsAt(purpose, glob).includes(type)) throw new OutOfShape(`${purpose}: ${path} holds a ${type}, which its shape does not allow there; it was not sent`);
    };
    const key = (path: string, glob: string): void => {
      if (!knownPath(purpose, glob)) throw new OutOfShape(`${purpose}: ${path} has no row in the request shapes (privacy/shapes.ts, ${glob}); it was not sent`);
    };
    const items = shapeItems(purpose);
    const count = (path: string, glob: string, n: number): void => {
      const max = items[glob] ?? items[ANY_PATH];
      if (max === undefined) throw new OutOfShape(`${purpose}: ${path} is a list with no item count in the request shapes (privacy/shapes.ts ITEMS, ${glob}); it was not sent`);
      if (n <= max) return;
      shapeLengthLog({ purpose, slot: glob, items: n, max });
      throw new OutOfShape(`${purpose}: ${path} holds ${n} items, more than its shape's ${max}; it was not sent`);
    };
    this.walk(purpose, body, root, check, root, { count, scalar, key });
  }

  /**
   * Walks a body: every string a text this Disclosure minted (or a client-written path's allowed value), every key an
   * identifier; `each` is called on every minted string with its path and glob (privacy/shapes.ts childGlob), and the
   * shape's callbacks on every nonempty list (`count`, with its items' glob and their number), every number, boolean
   * and null (`scalar`), and every object key (`key`, with the key's glob).
   */
  private walk(
    purpose: string,
    body: unknown,
    root: string,
    each: ((path: string, glob: string, v: string) => void) | null,
    rootGlob = root,
    shape: { count: (path: string, glob: string, n: number) => void; scalar: (path: string, glob: string, type: ScalarType) => void; key: (path: string, glob: string) => void } | null = null,
  ): void {
    const at = (path: string, k: string | number): string => (typeof k === "number" ? `${path}[${k}]` : path === "" ? k : `${path}.${k}`);
    const go = (v: unknown, path: string, glob: string): void => {
      if (typeof v === "string") {
        const exempt = EXEMPT_EXACT.find((e) => e.path.test(path));
        if (exempt !== undefined) {
          if (exempt.values !== null && !exempt.values.has(v)) throw new UnmintedText(`${purpose}: ${path} holds a value the protocol does not allow there; it was not sent`);
          return;
        }
        if (!this.mints.has(v)) throw new UnmintedText(`${purpose}: ${path} carries text that was not minted for this request; it was not sent`);
        each?.(path, glob, v);
        return;
      }
      if (v === undefined) return;
      if (v === null || typeof v === "number" || typeof v === "boolean") return shape?.scalar(path, glob, v === null ? "null" : typeof v === "number" ? "number" : "boolean");
      if (Array.isArray(v)) {
        if (v.length > 0) shape?.count(path, childGlob(glob, 0), v.length);
        return v.forEach((x, i) => go(x, at(path, i), childGlob(glob, i)));
      }
      if (typeof v === "object") {
        const keys = Object.keys(v);
        const items = keys.length === 0 ? null : childGlob(glob, keys[0]!);
        if (items !== null && items.endsWith(".*")) shape?.count(path, items, keys.length);
        for (const [k, x] of Object.entries(v)) {
          if (!KEY.test(k)) throw new UnmintedText(`${purpose}: a key under ${path === "" ? "the body" : path} is not an identifier; it was not sent`);
          shape?.key(at(path, k), childGlob(glob, k));
          go(x, at(path, k), childGlob(glob, k));
        }
        return;
      }
      throw new UnmintedText(`${purpose}: ${path} holds a ${typeof v}, which no request carries; it was not sent`);
    };
    go(body, root, rootGlob);
  }

  /**
   * A minted value written as JSON text, for an engine that takes a request's state as one string (engines/decide/
   * harness.ts layaState): every string inside it must be minted, and the text carries their reasons.
   */
  jsonText(v: unknown): ModelText {
    // Written once, then checked as written: what the text says is what is checked.
    const text = JSON.stringify(v);
    const written = JSON.parse(text) as unknown;
    this.walk("jsonText", written, "", null);
    const reasons = new Set<MintReason>(["ownWording"]);
    const parts: string[] = [];
    const walk = (x: unknown): void => {
      if (typeof x === "string") {
        parts.push(x);
        for (const r of this.reasons(x, "jsonText")) reasons.add(r);
      }
      else if (Array.isArray(x)) x.forEach(walk);
      else if (typeof x === "object" && x !== null) Object.values(x).forEach(walk);
    };
    walk(written);
    this.asJson.add(text);
    this.declareSpans(text, parts.flatMap((p) => this.spans.get(p) ?? []));
    return this.record(text, reasons);
  }

  /**
   * The seal's measure (OUTPUT-LEDGER-SPEC sections 4-7): the request's final decoded units against every window the
   * registry knows now and every older snapshot this Disclosure holds, each held to its limit, and with every request
   * sent through this Disclosure before it, held to each conversation's limit together. Throws LedgerRefused, naming the
   * purpose, window key and limit, when there is no registry, a unit cannot be measured, or a limit breaks.
   */
  measureSent(purpose: string, sent: readonly string[], notes: OwnerNotes = new Map(), spanned: readonly string[] = sent, commit = true): Measurement {
    if (this.registry === null) throw new LedgerRefused(`${purpose}: its Disclosure has no screen registry, so what it reveals cannot be measured; it was not sent`);
    // A JSON text this Disclosure wrote (jsonText) is a declared layer: the strings it holds are measured too, decoded,
    // since their escaped spelling can cut runs a reader of the decoded text sees whole. Added after the units, so the
    // owner-note indexes (into `sent`) stand.
    const units = [...sent];
    for (let i = 0; i < units.length; i++) if (this.asJson.has(units[i]!)) units.push(...decodeUnits(units[i]!).units.map((u) => u.text));
    const norm = normalizedUnits(units);
    if (norm === null) throw new LedgerRefused(`${purpose}: a text in it holds an unpaired surrogate and cannot be measured; it was not sent`);
    const ws = this.measuredWindows();
    const bad = ws.find((w) => w.inv.malformed);
    if (bad !== undefined) throw new LedgerRefused(`${purpose}: window ${bad.key} shows text the ledger cannot measure (an unpaired surrogate); it was not sent`);
    // Every declared span of every minted unit the request holds (section 4): its units, or, for a sink that rendered
    // them into other text, the strings of the wire it rendered from (`spanned`).
    const spanUnits = [...spanned];
    for (let i = 0; i < spanUnits.length; i++) if (this.asJson.has(spanUnits[i]!)) spanUnits.push(...decodeUnits(spanUnits[i]!).units.map((u) => u.text));
    const spans = spansOf(spanUnits.flatMap((u) => this.spans.get(u) ?? []));
    const m = measure(norm, ws, spans);
    const split = splitNotes(norm, ws, notes, spans);
    const refuse = (b: Breach & { notes: boolean }, before: boolean): LedgerRefused =>
      new LedgerRefused(`${purpose}: ${before ? "with the requests sent before it, " : ""}it reveals ${b.charged} characters of ${b.notes ? `window ${b.key}'s owner notes, over the owner-note allotment` : `window ${b.key}, over its limit`} of ${b.limit}; it was not sent`);
    const b = breachWithNotes(m, ws, split, OWNER_NOTE_CHARS);
    if (b !== null) throw refuse(b, false);
    const ob = this.operation.admit(m, ws, split, OWNER_NOTE_CHARS, commit);
    if (ob !== null) throw refuse(ob, true);
    return m;
  }

  /** Never serialized with a request: JSON of a request names its Disclosure, nothing it holds. */
  toJSON(): string {
    return "[disclosure]";
  }
}

/**
 * The client's check on a request it is about to send (SC1 2b, the runtime line): the request has a Disclosure and its
 * wire body is all minted text. `body` is what goes on the wire, after wireBody.
 */
export function verifySent(req: { purpose?: string; disclosure?: unknown }, body: unknown): void {
  const d = asDisclosure(req.disclosure);
  if (d === null) throw new UnmintedText(`${req.purpose ?? "a request"} has no Disclosure, so nothing in it was minted; it was not sent`);
  d.verify(req.purpose ?? UNNAMED, body);
}

/**
 * The seal's measure of a request's final bytes (OUTPUT-LEDGER-SPEC section 3 and 6): decoded into units (every key,
 * string and scalar spelling), then measured by the request's Disclosure (Disclosure.measureSent). Bytes that do not
 * decode refuse. Throws LedgerRefused (an UnmintedText) naming no text.
 */
export function measureBytes(req: { purpose?: string; kind?: string; disclosure?: unknown }, bytes: string, spanned?: readonly string[], commit = true): Measurement {
  const purpose = req.purpose ?? req.kind ?? UNNAMED;
  const d = asDisclosure(req.disclosure);
  if (d === null) throw new UnmintedText(`${purpose} has no Disclosure, so nothing in it was minted; it was not sent`);
  let units: readonly DecodedUnit[];
  try {
    units = decodeUnits(bytes).units;
  } catch (e) {
    if (e instanceof LedgerEncodingError) throw new LedgerRefused(`${purpose}: its bytes do not decode as one well-formed JSON value (${e.message.replace(/^.*?: /u, "")}); it was not sent`);
    throw e;
  }
  const texts = units.map((u) => u.text);
  return d.measureSent(purpose, texts, d.ownerNoteUnits(units), spanned ?? texts, commit);
}

/** The writer port's check: the request has a Disclosure and its input is all minted text. */
export function verifyWriterInput(req: { kind: string; disclosure?: unknown; input: unknown }): void {
  const d = asDisclosure(req.disclosure);
  if (d === null) throw new UnmintedText(`writer ${req.kind} request has no Disclosure, so nothing in it was minted; it was not sent`);
  d.verify(req.kind, req.input, "input");
}

/**
 * PV2 Q2 (SC1 T5): what a local store keeps of a request (the replay cache, a request log, an evaluation's dump). The
 * request's wire body is verified first, as the client verifies what it sends: every string minted for this request,
 * in its shape. Then `kept`, the store's own record of it, is returned with every value in a format Caret never carries
 * withheld (privacy/exclude.ts withholdValues) in its strings and its keys. Throws UnmintedText as the client would, so
 * a store never keeps a body the client would not send.
 */
export function storable<T>(req: { purpose?: string; disclosure?: unknown }, wire: unknown, kept: T): T {
  verifySent(req, wire);
  return withheldDeep(kept) as T;
}

/** A value with withholdValues applied to every string and key in it. */
export function withheldDeep(v: unknown): unknown {
  if (typeof v === "string") return withholdValues(v);
  if (Array.isArray(v)) return v.map(withheldDeep);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [withholdValues(k), withheldDeep(x)]));
  return v;
}
