// What the content script keeps about each text control so that its value never has to leave the page (counsel
// 2026-10-09, "Field values never leave the content script"). A walk sends a text control's `hasValue` and `rev`, never
// its value; a write sends back booleans the page computed; Undo restores a `before` the page kept itself. Everything
// here lives in this content script's memory, keyed by the element, and dies with the document. Pure over the element
// type, so the rules are tested on plain objects (test/revs.test.ts); content.ts, walker.ts and actions.ts wire them to
// the DOM.
import { equivalentValue } from "../../../helper/src/values/equivalent.ts";
import { sha256Hex } from "../shared/sha256.ts";

/**
 * Where a text control's current text came from, as far as this page saw:
 * - `clean`: empty when first seen, or since emptied, and changed since only by the user's own typing.
 * - `prefilled`: an `<input>` first seen holding text (a React replacement of a password field, an autofilled field, a
 *   copy added later), with no emptying since, whatever trusted events came before that first reading. Its text is not
 *   the user's typing as far as Caret can show.
 * - `programmatic`: an `<input>` whose text changed between two readings to text other than the user's last typing
 *   left: a password manager's fill, a page script's copy, a paste, browser autofill (whose input events are trusted
 *   but carry no inputType, as Chrome for Testing 154 shows: fixtures/web-form/tests/walk-values.test.ts).
 * - `caret`: exactly what Caret's own last write left, with no change since.
 */
export type Origin = "clean" | "prefilled" | "programmatic" | "caret";

interface Rec {
  /** The page-local change counter the walk sends. */
  rev: number;
  /** A salted digest of the text last read, never the text; null before any reading (a trusted event came first). */
  last: string | null;
  /** Trusted input, change, paste and compositionend events seen on the element. */
  trusted: number;
  /** `trusted` as of the last reading. */
  seenTrusted: number;
  /**
   * A salted digest of the text right after the user's latest typing input event since the last reading, taken at the
   * event: text a script puts in after the keystroke differs from it. Null after a reading, or after an input event
   * that is no typing (a paste, a drop, autofill).
   */
  typedAt: string | null;
  /** Since the last reading, some text came in that was not the user's typing: the next change is not theirs. */
  foreign: boolean;
  origin: Origin;
}

/**
 * Per-element change counters and origins. `rev` bumps on a reading that sees text other than the last one read, and
 * on a Caret write: at most once per reading, however many keystrokes came between, so it never counts the user's
 * typing (audit of PR #52, MED 4). A trusted event only marks the element as edited. It is per content-script
 * instance: a new document starts every element again, which the helper knows from the verb's documentId.
 */
export class Revs<E extends object> {
  private readonly recs = new WeakMap<E, Rec>();
  /** How text is kept for comparison: a salted digest (saltedDigest), so no text sits in the page's memory here. */
  readonly digestOf: (text: string) => string;

  constructor(digestOf: (text: string) => string = saltedDigest()) {
    this.digestOf = digestOf;
  }

  /** Forgets everything kept for the element: it turned out to be a secret field, which keeps nothing. */
  forget(el: E): void {
    this.recs.delete(el);
  }

  private rec(el: E): Rec {
    let r = this.recs.get(el);
    if (r === undefined) {
      r = { rev: 0, last: null, trusted: 0, seenTrusted: 0, typedAt: null, foreign: false, origin: "clean" };
      this.recs.set(el, r);
    }
    return r;
  }

  /**
   * Reads `text`, the element's current text. `input`: the element is an `<input>`, the only kind `prefilled` and
   * `programmatic` apply to (a password cannot become a textarea or editor on an honest page, and a reopened draft or a
   * prefilled "About me" would otherwise go dark).
   */
  read(el: E, text: string, input: boolean): { rev: number; origin: Origin } {
    const r = this.rec(el);
    const d = this.digestOf(text);
    if (r.last === null) {
      // The first reading of text in an input is never the user's: a trusted event before it (autofill's, a paste's)
      // shows no typing that Caret saw start from empty.
      r.origin = input && text !== "" ? "prefilled" : "clean";
    } else if (d !== r.last) {
      r.rev++;
      // The user's own only when the text is exactly what their latest keystroke left, and nothing else came in since.
      const typed = r.trusted > r.seenTrusted && !r.foreign && r.typedAt === d;
      if (r.origin === "caret") r.origin = typed || !input ? "clean" : "programmatic";
      else if (input && !typed) r.origin = "programmatic";
    }
    if (text === "") r.origin = "clean";
    r.last = d;
    r.seenTrusted = r.trusted;
    r.typedAt = null;
    r.foreign = false;
    return { rev: r.rev, origin: r.origin };
  }

  /**
   * A trusted beforeinput, input, change, paste or compositionend event on the element; it marks the element edited,
   * and bumps no rev. `e.before`: the text right before the event, for one that fires before the change (beforeinput,
   * paste). Text there that is neither the last reading nor what the user's typing left came from elsewhere since; at
   * the first sight of the element it is its first reading, so text a page put in before the user's first keystroke
   * still counts as `prefilled`. `e.typed`: the text right after an input event that is the user's typing (entry.ts
   * isTyping). `e.foreign`: an input event that is not (a paste, a drop, autofill's event with no inputType).
   */
  trusted(el: E, e: { before?: string; typed?: string; foreign?: true }, input: boolean): void {
    const r = this.rec(el);
    if (e.before !== undefined) {
      if (r.last === null) this.read(el, e.before, input);
      else {
        const d = this.digestOf(e.before);
        if (d !== r.last && d !== r.typedAt) r.foreign = true;
      }
    }
    r.trusted++;
    if (e.typed !== undefined) r.typedAt = this.digestOf(e.typed);
    if (e.foreign === true) {
      r.typedAt = null;
      r.foreign = true;
    }
    if (r.origin === "caret") r.origin = "clean";
  }

  /** Caret's own write left `text` in the element. `typed`: a trusted event came while it wrote, so the text may be the user's too. */
  caretWrote(el: E, text: string, typed: boolean): number {
    const r = this.rec(el);
    r.rev++;
    r.last = this.digestOf(text);
    r.seenTrusted = r.trusted;
    r.typedAt = null;
    r.foreign = false;
    r.origin = text === "" ? "clean" : typed ? "programmatic" : "caret";
    return r.rev;
  }

  /** How many trusted events the element saw: compared before and after a write for `typedBetween`. */
  trustedCount(el: E): number {
    return this.recs.get(el)?.trusted ?? 0;
  }
}

/**
 * A salted SHA-256 of a text, random per content script, as content/entry.ts keeps one: enough to tell that a field's
 * text changed, and no use against a list of common values, since the salt never leaves this script.
 */
export function saltedDigest(): (text: string) => string {
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return (text) => sha256Hex(`${salt}\u0000${text}`);
}

/** Why a text control's text is withheld: from the walk's hasValue and rev, the focused text, compares and copies. */
export type Withheld = "secret" | "unknownHistory" | "replacement" | "prefilled" | "programmatic";

/**
 * The withheld reason of a non-secret text control. A history or replacement doubt (password-watch.ts) and a
 * prefilled or programmatic origin all withhold; text exactly as Caret's own write left it is Caret's, never a revealed
 * password, so it is withheld for none of them.
 */
export function withheldFor(doubt: "unknownHistory" | "replacement" | null, origin: Origin): Withheld | null {
  if (origin === "caret") return null;
  if (doubt !== null) return doubt;
  return origin === "prefilled" || origin === "programmatic" ? origin : null;
}

/**
 * What a walk sends for a text control: whether it holds text, and its rev. An empty field holds nothing to withhold,
 * so it reads `false` with its rev whatever its doubt; a withheld one that holds text reads null for both. A secret
 * field reads null for both, empty or not.
 */
export function presence(empty: boolean, rev: number, withheld: Withheld | null): { hasValue: boolean | null; rev: number | null } {
  if (withheld === "secret") return { hasValue: null, rev: null };
  if (empty) return { hasValue: false, rev };
  return withheld === null ? { hasValue: true, rev } : { hasValue: null, rev: null };
}

/** The page's equivalence for one element: numeric only for a number input or a numeric inputmode, as the walk names it. */
export function equivalentFor(kind: { numeric: boolean }, held: string, wrote: string): boolean {
  return equivalentValue(kind.numeric, held, wrote);
}

/** One write Caret made, kept for its undo: the element, the text before it, what Caret meant, and the rev it left. */
export interface WriteRecord<E extends object> {
  el: WeakRef<E>;
  before: string;
  wrote: string;
  revAfter: number;
  trustedAfter: number;
}

/**
 * Most write records one document keeps; past it the oldest go, and their undo answers noRecord. Assumed, as the
 * helper's MAX_MARKS is: a run writes tens of fields.
 */
export const MAX_RECORDS = 512;

/**
 * The page-held `before` of Caret's writes, by task and the element written, newest last per element: an undo restores
 * the newest first, so a field Caret wrote twice goes back step by step. By the element, not its registry id: a write
 * that reached a re-rendered field through a strong-key rebind is undone on that very element under the id a later
 * walk gave it, and an id now naming another element finds no record. Never sent anywhere.
 */
export class WriteRecords<E extends object> {
  private readonly byKey = new Map<string, WriteRecord<E>[]>();
  private readonly serials = new WeakMap<E, number>();
  private next = 1;
  private count = 0;

  private key(taskId: string, el: E): string {
    let n = this.serials.get(el);
    if (n === undefined) {
      n = this.next++;
      this.serials.set(el, n);
    }
    return `${taskId}\u0000${n}`;
  }

  /** A write is about to change the element: kept before anything is touched, so a write whose answer is lost can still be undone. */
  begin(taskId: string, el: E, before: string, wrote: string, rev: number, trusted: number): WriteRecord<E> {
    const k = this.key(taskId, el);
    const list = this.byKey.get(k) ?? [];
    const rec: WriteRecord<E> = { el: new WeakRef(el), before, wrote, revAfter: rev, trustedAfter: trusted };
    list.push(rec);
    this.byKey.set(k, list);
    this.count++;
    while (this.count > MAX_RECORDS) this.dropOldest();
    return rec;
  }

  private dropOldest(): void {
    const first = this.byKey.keys().next();
    if (first.done === true) return;
    const list = this.byKey.get(first.value) ?? [];
    list.shift();
    this.count--;
    if (list.length === 0) this.byKey.delete(first.value);
  }

  newest(taskId: string, el: E): WriteRecord<E> | undefined {
    return this.byKey.get(this.key(taskId, el))?.at(-1);
  }

  /** The newest record was restored or refused for good: the one before it is next. */
  pop(taskId: string, el: E): void {
    const k = this.key(taskId, el);
    const list = this.byKey.get(k);
    if (list === undefined || list.length === 0) return;
    list.pop();
    this.count--;
    if (list.length === 0) this.byKey.delete(k);
  }
}

/** Why a restore is refused (protocol.ts PageRestored). */
export type RestoreRefusal = "changed" | "mayIncludeInput" | "gone" | "reloaded" | "noRecord";

/**
 * Whether the newest record may be restored now, and if not why: the field is the element Caret wrote, nobody's trusted
 * event reached it since, its rev is the one Caret's write left, and its text is equivalent to what Caret wrote.
 */
export function restoreCheck<E extends object>(rec: WriteRecord<E> | undefined, el: E, now: { rev: number; trusted: number; text: string; numeric: boolean }, exact = false): RestoreRefusal | null {
  if (rec === undefined) return "noRecord";
  if (rec.el.deref() !== el) return "gone";
  if (now.trusted !== rec.trustedAfter) return "mayIncludeInput";
  if (now.rev !== rec.revAfter) return "changed";
  // `exact`: S1's rule for a write whose answer was lost, recognized only as exactly what Caret was writing.
  if (exact) return now.text === rec.wrote ? null : "changed";
  return equivalentFor({ numeric: now.numeric }, now.text, rec.wrote) ? null : "changed";
}

/** pageCompare's bounds in one document (counsel, "pageCompare as an oracle"). The worker holds the per-origin one. */
export const COMPARE_PER_CONTROL = 8;
export const COMPARE_PER_TASK = 64;
/** Candidates shorter than this, in code points, answer unknown: a short value is guessed in a few tries. */
export const COMPARE_MIN_CODE_POINTS = 3;

export type CompareAnswer = "equal" | "equivalent" | "different" | "unknown";

/** Per-task, per-control budgets of pageCompare candidates in this document. Every candidate counts, answered or not. */
export class CompareBudget {
  private readonly perControl = new Map<string, number>();
  private readonly perTask = new Map<string, number>();

  /** Whether one more candidate may be answered for (taskId, id); counts it either way. */
  take(taskId: string, id: string): boolean {
    const ck = `${taskId}\u0000${id}`;
    const c = (this.perControl.get(ck) ?? 0) + 1;
    const t = (this.perTask.get(taskId) ?? 0) + 1;
    this.perControl.set(ck, c);
    this.perTask.set(taskId, t);
    return c <= COMPARE_PER_CONTROL && t <= COMPARE_PER_TASK;
  }
}

/**
 * The answers to one pageCompare: whole-value equality, or equivalence under the element's own kind; never a prefix,
 * contains or distance. `text` is null for a withheld control, which answers unknown for every candidate and still
 * spends the budget, so probing it shows in the count.
 */
export function compareAnswers(text: string | null, numeric: boolean, candidates: readonly string[], take: () => boolean): CompareAnswer[] {
  return candidates.map((c) => {
    const allowed = take();
    if (!allowed || text === null || [...c].length < COMPARE_MIN_CODE_POINTS) return "unknown";
    if (text === c) return "equal";
    return equivalentFor({ numeric }, text, c) ? "equivalent" : "different";
  });
}
