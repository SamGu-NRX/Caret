// SC1 section 2b: the typed boundary between the screen and a model. A request may carry only text its Disclosure
// minted: Caret's own wording, or screen text read from a redacted view, priced against that window's budget and
// recorded, the same ledger privacy.ts has always kept (SnippetLedger). The record is the brand. A TypeScript brand
// disappears at runtime, so the check that holds is `verify`, run on the body where each request is sent (the Jev
// client, the writer port, the canned harness and the local decision engine): any string in the body that this
// request's Disclosure did not mint throws UnmintedText, naming the path, never the text.
import { assertNoSecrets, cut, flat, SnippetLedger, type Snippet } from "../privacy.ts";
import type { WindowState } from "../model.ts";
import { instructionForModel, isRedacted } from "../fill/redact.ts";
import { sensitiveKind } from "../memory/sensitive.ts";
import { excludedValue } from "./exclude.ts";

/** A window as redactWindow gave it (fill/redact.ts): the only window a Disclosure mints screen text from. */
export type RedactedWindow = WindowState;

/** The redacted view's text as one string, its lines whitespace-collapsed and NUL-separated, per view object. */
const VIEW_TEXT = new WeakMap<WindowState, string>();

function viewText(view: WindowState): string {
  let s = VIEW_TEXT.get(view);
  if (s !== undefined) return s;
  const lines: string[] = [];
  const add = (raw: string | undefined): void => {
    if (raw === undefined || raw === "") return;
    for (const l of raw.split(/\r?\n/u)) {
      const f = flat(l);
      if (f !== "") lines.push(f);
    }
  };
  add(view.window.title);
  for (const n of view.nodes.values()) {
    add(n.label);
    add(n.value);
    add(n.placeholder);
  }
  s = `\u0000${lines.join("\u0000")}\u0000`;
  VIEW_TEXT.set(view, s);
  return s;
}

/**
 * Whether the redacted view shows `text`: each of its lines, whitespace collapsed and a cut's ellipsis taken off, stands
 * inside one line of the view (its title, or a kept node's label, value or placeholder).
 */
export function viewHolds(view: WindowState, text: string): boolean {
  const pieces = text.split(/\r?\n/u).map((raw) => flat(raw).replace(/^…|…$/gu, "")).filter((x) => x !== "");
  if (pieces.length === 0) return false;
  const all = viewText(view);
  return pieces.every((p) => !p.includes("\u0000") && all.includes(p));
}

declare const brand: unique symbol;
/** Text a Disclosure minted for one request. Only privacy/ makes one. */
export type ModelText = string & { readonly [brand]: "ModelText" };
/** What a request's state or a writer's input may hold: minted text, numbers, booleans, null, and lists and records of them. */
export type ModelValue = ModelText | number | boolean | null | readonly ModelValue[] | { readonly [k: string]: ModelValue };

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
 * - drafted: a sentence Caret's local model drafted (goals/drafts.ts), checked by Jev before it is offered;
 * - legacy: SC1 migration step 1 only. A builder that has not yet minted its text declares the whole request legacy.
 */
export type MintReason = "ownWording" | "descriptor" | "candidate" | "instruction" | "memory" | "held" | "plan" | "drafted" | "legacy";

/** A request body carried a string its Disclosure never minted, or it had no Disclosure. Never names the text. */
export class UnmintedText extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnmintedText";
  }
}

/** Strings minted as legacy, by purpose, since the process started (SC1 step 1: T-P1 reports it; step 4 brings it to 0). */
export const legacyCounts = new Map<string, number>();

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

/**
 * The one ledger a request's screen text goes through (privacy.ts SnippetLedger, whose budgets it keeps unchanged) and
 * the record of every text it minted. Construct one per request, over every window whose lines the request could reveal.
 */
/**
 * Marks a Disclosure across module instances: a test that reloads the client's modules (vi.resetModules) still hands it
 * a request built with the Disclosure class it imported first, so the check is by this registered symbol, not instanceof.
 */
const IS_DISCLOSURE = Symbol.for("caret.privacy.disclosure");

function asDisclosure(x: unknown): Disclosure | null {
  return typeof x === "object" && x !== null && (x as { [IS_DISCLOSURE]?: unknown })[IS_DISCLOSURE] === true ? (x as Disclosure) : null;
}

export class Disclosure extends SnippetLedger {
  readonly [IS_DISCLOSURE] = true;
  /** Every text minted for this request, with the reasons it was minted under. */
  private readonly mints = new Map<string, Set<MintReason>>();

  /** Records `text` as minted under `reasons` and brands it. */
  private record(text: string, reasons: Iterable<MintReason>): ModelText {
    let r = this.mints.get(text);
    if (r === undefined) this.mints.set(text, (r = new Set()));
    for (const x of reasons) r.add(x);
    return text as ModelText;
  }

  /** The reasons `text` was minted under, or null when this Disclosure never minted it. */
  reasonsOf(text: string): ReadonlySet<MintReason> | null {
    return this.mints.get(text) ?? null;
  }

  /**
   * SC1 2a, at the ledger: a text holding a value in a format Caret never carries (privacy/exclude.ts) never fits, from a
   * window, a plan or memory. The model withheld such values when windows were read in; this holds for any other path.
   */
  override take(w: WindowState, kind: Snippet["kind"], texts: readonly (string | null | undefined)[]): boolean {
    return !texts.some((t) => excludedValue(t) !== null) && super.take(w, kind, texts);
  }

  override cost(w: WindowState, texts: readonly (string | null | undefined)[]): number | null {
    return texts.some((t) => excludedValue(t) !== null) ? null : super.cost(w, texts);
  }

  override plan(texts: readonly string[]): boolean {
    return !texts.some((t) => excludedValue(t) !== null) && super.plan(texts);
  }

  override memory(texts: readonly string[]): boolean {
    return !texts.some((t) => excludedValue(t) !== null) && super.memory(texts);
  }

  /** The reasons a text this Disclosure minted carries; throws UnmintedText when it never minted it. */
  private reasons(text: string, where: string): Set<MintReason> {
    const r = this.mints.get(text);
    if (r === undefined) throw new UnmintedText(`${where}: a part was not minted for this request`);
    return r;
  }

  /**
   * Screen text read from a redacted view, priced against that window's budget (SnippetLedger.take) and recorded under
   * `reason`. Null when the view does not show it (it is not screen text the view keeps, so it is never sent) or when it
   * does not fit the window's budget. A text this ledger already took from the window costs nothing again.
   */
  private fromView(view: RedactedWindow, text: string, reason: "descriptor" | "candidate" | "held"): ModelText | null {
    if (!isRedacted(view)) throw new UnmintedText(`a ${reason} was read from a window that is not a redacted view`);
    if (text === "" || !viewHolds(view, text)) return null;
    if (!this.take(view, reason === "descriptor" ? "descriptor" : "candidate", [text])) return null;
    return this.record(text, [reason]);
  }

  /** A kept node's label or placeholder, a window's title, or another name the redacted view shows for something. */
  descriptor(view: RedactedWindow, text: string | null | undefined): ModelText | null {
    return text === null || text === undefined ? null : this.fromView(view, text, "descriptor");
  }

  /** A kept node's value or a typed value, as the redacted view shows it. */
  candidate(view: RedactedWindow, text: string | null | undefined): ModelText | null {
    return text === null || text === undefined ? null : this.fromView(view, text, "candidate");
  }

  /** A string code computed locally (a program's output, a part of a value) that the redacted view shows as it is. */
  held(view: RedactedWindow, text: string | null | undefined): ModelText | null {
    return text === null || text === undefined ? null : this.fromView(view, text, "held");
  }

  /**
   * A plan's own text, a step's goal or target (MintReason plan), priced as plan text (SnippetLedger.plan): every line of
   * a window it shows is charged to that window. Null when one would go over its budget.
   */
  planText(text: string): ModelText | null {
    if (!this.plan([text])) return null;
    return this.record(text, ["plan"]);
  }

  /**
   * A sentence the local model drafted (MintReason drafted), priced as plan text: a draft quotes the windows it was
   * drafted from. Null when one would go over its budget.
   */
  draftedText(text: string): ModelText | null {
    if (!this.plan([text])) return null;
    return this.record(text, ["drafted"]);
  }

  /** The app a window belongs to, by the name the reader gives it: not screen text the window shows, but a descriptor of it. */
  app(view: RedactedWindow): ModelText {
    if (!isRedacted(view)) throw new UnmintedText("an app name was read from a window that is not a redacted view");
    return this.record(view.app.name, ["descriptor"]);
  }

  /** The user's instruction as a model may read it (fill/redact.ts instructionForModel): its secret clauses replaced. */
  instruction(raw: string): ModelText {
    return this.record(instructionForModel(raw), ["instruction"]);
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
  own<S extends string>(s: string extends S ? never : S): ModelText {
    return this.record(s, ["ownWording"]);
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
  derived<W extends string = never>(base: ModelText | readonly ModelText[], text: string, codeWords: readonly (string extends W ? never : W)[] = []): ModelText | null {
    const bases = typeof base === "string" ? [base] : base;
    const reasons = new Set<MintReason>(["held"]);
    const shown = new Set<string>(codeWords.map((w) => w.toLowerCase()));
    for (const b of bases) {
      for (const r of this.reasons(b, "derived")) reasons.add(r);
      for (const w of b.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w !== "") shown.add(w);
    }
    const ws = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x !== "");
    if (ws.length === 0 && text.trim() !== "") return null;
    for (const w of ws) if (!shown.has(w) && !/^\d+(?:st|nd|rd|th|am|pm|h)?$/u.test(w) && !DERIVED_WORDS.has(w)) return null;
    return this.record(text, reasons);
  }

  /**
   * An app's name as the reader gives it, minted when some window this Disclosure was built over belongs to that app:
   * reader metadata that describes a window, not text the window shows.
   */
  appNamed(name: string): ModelText | null {
    for (const w of this.known.values()) if (w.app.name === name) return this.record(name, ["descriptor"]);
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
    const reasons = new Set<MintReason>();
    let out = strings[0] ?? "";
    holes.forEach((h, i) => {
      if (typeof h !== "string") throw new UnmintedText("t: a hole is not text");
      for (const r of this.reasons(h, "t")) reasons.add(r);
      out += h + (strings[i + 1] ?? "");
    });
    if (strings.some((s) => s !== "")) reasons.add("ownWording");
    return this.record(out, reasons);
  }

  /** A minted text cut to `max` characters with an ellipsis (privacy.ts cut); it keeps its reasons. */
  cut(s: ModelText, max?: number): ModelText {
    return this.record(cut(s, max), this.reasons(s, "cut"));
  }

  /** A minted text's first `max` characters, with no ellipsis (String.slice); it keeps its reasons. */
  slice(s: ModelText, max: number): ModelText {
    return this.record(s.slice(0, max), this.reasons(s, "slice"));
  }

  /** A minted text with its whitespace collapsed (privacy.ts flat); it keeps its reasons. */
  flat(s: ModelText): ModelText {
    return this.record(flat(s), this.reasons(s, "flat"));
  }

  /** Minted texts joined by Caret's separator; the result carries every part's reasons. */
  join(parts: readonly ModelText[], sep: string): ModelText {
    const reasons = new Set<MintReason>();
    for (const p of parts) for (const r of this.reasons(p, "join")) reasons.add(r);
    if (sep !== "" && parts.length > 1) reasons.add("ownWording");
    return this.record(parts.join(sep), reasons);
  }

  /**
   * SC1 step 1: declares every string a not-yet-converted builder's request carries as legacy, then seals it. The count
   * of legacy strings per purpose is kept in legacyCounts; step 4 converts every builder and removes this.
   */
  legacy<R extends Sealable>(req: R): R & { disclosure: Disclosure } {
    let n = 0;
    const walk = (v: unknown): void => {
      if (typeof v === "string") {
        this.record(v, ["legacy"]);
        n++;
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
    };
    walk([req.state, req.questions, req.nouls, req.input]);
    const purpose = req.purpose ?? req.kind ?? "unknown";
    legacyCounts.set(purpose, (legacyCounts.get(purpose) ?? 0) + n);
    return this.seal(req);
  }

  /**
   * Attaches this Disclosure to a request and verifies its body as built, so a builder's miss fails in every test that
   * builds the request, as it does at the client. A Jev request's body is its state, questions and yes/no questions; a
   * writer request's is its input.
   */
  seal<R extends Sealable>(req: R): R & { disclosure: Disclosure } {
    const sealed = { ...req, disclosure: this };
    // The G2 disclosure rule, at build as it always was (SC1 step 5 narrows it to formats).
    assertNoSecrets(req as Parameters<typeof assertNoSecrets>[0]);
    if (req.input !== undefined && req.kind !== undefined) this.verify(req.kind, req.input, "input");
    else this.verify(req.purpose ?? "unknown", { state: req.state, questions: { ...(req.questions as object), ...(req.nouls as object | undefined) } });
    return sealed;
  }

  /**
   * Every string in a body is a text this Disclosure minted, every key is a short identifier, and the paths the client
   * writes itself hold only their allowed values. Throws UnmintedText naming the purpose and the path, never the text.
   * `root` names the body in paths: "" for a Jev wire body, "input" for a writer's input.
   */
  verify(purpose: string, body: unknown, root = ""): void {
    const at = (path: string, k: string | number): string => (typeof k === "number" ? `${path}[${k}]` : path === "" ? k : `${path}.${k}`);
    const walk = (v: unknown, path: string): void => {
      if (typeof v === "string") {
        const exempt = EXEMPT_EXACT.find((e) => e.path.test(path));
        if (exempt !== undefined) {
          if (exempt.values !== null && !exempt.values.has(v)) throw new UnmintedText(`${purpose}: ${path} holds a value the protocol does not allow there; it was not sent`);
          return;
        }
        if (!this.mints.has(v)) throw new UnmintedText(`${purpose}: ${path} carries text that was not minted for this request; it was not sent`);
        return;
      }
      if (v === null || typeof v === "number" || typeof v === "boolean" || v === undefined) return;
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, at(path, i)));
      if (typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (!KEY.test(k)) throw new UnmintedText(`${purpose}: a key under ${path === "" ? "the body" : path} is not an identifier; it was not sent`);
          walk(x, at(path, k));
        }
        return;
      }
      throw new UnmintedText(`${purpose}: ${path} holds a ${typeof v}, which no request carries; it was not sent`);
    };
    walk(body, root);
  }

  /**
   * A minted value written as JSON text, for an engine that takes a request's state as one string (engines/decide/
   * harness.ts layaState): every string inside it must be minted, and the text carries their reasons.
   */
  jsonText(v: unknown): ModelText {
    this.verify("jsonText", v);
    const reasons = new Set<MintReason>(["ownWording"]);
    const walk = (x: unknown): void => {
      if (typeof x === "string") for (const r of this.reasons(x, "jsonText")) reasons.add(r);
      else if (Array.isArray(x)) x.forEach(walk);
      else if (typeof x === "object" && x !== null) Object.values(x).forEach(walk);
    };
    walk(v);
    return this.record(JSON.stringify(v), reasons);
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
  d.verify(req.purpose ?? "unknown", body);
}

/** The writer port's check: the request has a Disclosure and its input is all minted text. */
export function verifyWriterInput(req: { kind: string; disclosure?: unknown; input: unknown }): void {
  const d = asDisclosure(req.disclosure);
  if (d === null) throw new UnmintedText(`writer ${req.kind} request has no Disclosure, so nothing in it was minted; it was not sent`);
  d.verify(req.kind, req.input, "input");
}

