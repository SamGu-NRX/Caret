// What the content script keeps about each text control so that its value never has to leave the page (counsel
// 2026-10-09, "Field values never leave the content script"). A walk sends a text control's `hasValue` and `rev`, never
// its value; a write sends back booleans the page computed; Undo restores a `before` the page kept itself. Everything
// here lives in this content script's memory, keyed by the element, and dies with the document. Pure over the element
// type, so the rules are tested on plain objects (test/revs.test.ts); content.ts, walker.ts and actions.ts wire them to
// the DOM.
import { equivalentValue } from "../../../helper/src/values/equivalent.ts";

/**
 * Where a text control's current text came from, as far as this page saw:
 * - `clean`: empty when first seen, or since emptied, and changed since only with the user's own trusted events.
 * - `prefilled`: an `<input>` first seen holding text (a React replacement of a password field, an autofilled field, a
 *   copy added later), with no emptying since. Its text is not the user's typing as far as Caret can show.
 * - `programmatic`: an `<input>` whose text changed between two readings with no trusted event between them (a
 *   password manager's fill, a page script's copy).
 * - `caret`: exactly what Caret's own last write left, with no change since.
 */
export type Origin = "clean" | "prefilled" | "programmatic" | "caret";

interface Rec {
  /** The page-local change counter the walk sends. */
  rev: number;
  /** The text last read, or null before any reading (a trusted event came first). */
  last: string | null;
  /** Trusted input, change, paste and compositionend events seen on the element. */
  trusted: number;
  /** `trusted` as of the last reading. */
  seenTrusted: number;
  origin: Origin;
}

/**
 * Per-element change counters and origins. `rev` bumps on a trusted input, change, paste or compositionend event on
 * the element; on a reading that sees text other than the last one read; and on a Caret write. It is per content-script
 * instance: a new document starts every element again, which the helper knows from the verb's documentId.
 */
export class Revs<E extends object> {
  private readonly recs = new WeakMap<E, Rec>();

  private rec(el: E): Rec {
    let r = this.recs.get(el);
    if (r === undefined) {
      r = { rev: 0, last: null, trusted: 0, seenTrusted: 0, origin: "clean" };
      this.recs.set(el, r);
    }
    return r;
  }

  /** Whether the element was ever read or saw a trusted event. */
  known(el: E): boolean {
    return this.recs.has(el);
  }

  /**
   * Reads `text`, the element's current text. `input`: the element is an `<input>`, the only kind `prefilled` and
   * `programmatic` apply to (a password cannot become a textarea or editor on an honest page, and a reopened draft or a
   * prefilled "About me" would otherwise go dark).
   */
  read(el: E, text: string, input: boolean): { rev: number; origin: Origin } {
    const r = this.rec(el);
    if (r.last === null) {
      r.origin = input && text !== "" && r.trusted === 0 ? "prefilled" : "clean";
    } else if (text !== r.last) {
      r.rev++;
      const typed = r.trusted > r.seenTrusted;
      if (r.origin === "caret") r.origin = typed || !input ? "clean" : "programmatic";
      else if (input && !typed) r.origin = "programmatic";
    }
    if (text === "") r.origin = "clean";
    r.last = text;
    r.seenTrusted = r.trusted;
    return { rev: r.rev, origin: r.origin };
  }

  /**
   * A trusted input, change, paste or compositionend event on the element. `before`: its text right before the event,
   * when the event fires before the change (beforeinput); read first, so text a page put in before the user's first
   * keystroke still counts as `prefilled`.
   */
  trusted(el: E, before: string | null, input: boolean): void {
    const seen = this.recs.get(el);
    if (before !== null && (seen === undefined || seen.last === null)) this.read(el, before, input);
    const r = this.rec(el);
    r.trusted++;
    r.rev++;
    if (r.origin === "caret") r.origin = "clean";
  }

  /** Caret's own write left `text` in the element. `typed`: a trusted event came while it wrote, so the text may be the user's too. */
  caretWrote(el: E, text: string, typed: boolean): number {
    const r = this.rec(el);
    r.rev++;
    r.last = text;
    r.seenTrusted = r.trusted;
    r.origin = text === "" ? "clean" : typed ? "programmatic" : "caret";
    return r.rev;
  }

  /** How many trusted events the element saw: compared before and after a write for `typedBetween`. */
  trustedCount(el: E): number {
    return this.recs.get(el)?.trusted ?? 0;
  }
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
 * The page-held `before` of Caret's writes, by task and control id, newest last per control: an undo restores the
 * newest first, so a field Caret wrote twice goes back step by step. Never sent anywhere.
 */
export class WriteRecords<E extends object> {
  private readonly byKey = new Map<string, WriteRecord<E>[]>();
  private count = 0;

  private static key(taskId: string, id: string): string {
    return `${taskId}\u0000${id}`;
  }

  /** A write is about to change the element: kept before anything is touched, so a write whose answer is lost can still be undone. */
  begin(taskId: string, id: string, el: E, before: string, wrote: string, rev: number, trusted: number): WriteRecord<E> {
    const k = WriteRecords.key(taskId, id);
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

  newest(taskId: string, id: string): WriteRecord<E> | undefined {
    return this.byKey.get(WriteRecords.key(taskId, id))?.at(-1);
  }

  /** The newest record was restored or refused for good: the one before it is next. */
  pop(taskId: string, id: string): void {
    const k = WriteRecords.key(taskId, id);
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
