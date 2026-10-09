// When the user's own input last reached each control (issue #26). When Stop cuts off a write whose answer is lost,
// the helper reads the field once to see whether the write landed, and a field holding exactly Caret's value reads
// the same whether Caret wrote it or the user typed it after Stop. The walker reports this time as
// PageControl.inputAt, so the read that decides carries its own evidence: no message can arrive after it.
//
// What counts: a trusted beforeinput or input event (typing, a paste, a drop, an autofill, an input method), and a
// trusted key going down other than Esc, which types nothing and is Caret's Stop key. The executor's writes are
// untrusted events (content/dom.ts), and so are a page script's; Caret's inline insert goes in as trusted typing
// (content/insert.ts) and is noted like the user's, which can only make a later read more careful. Each is noted at the
// element the event names and at the element with focus, which reaches inside a closed shadow root the event's path
// does not. Only the time is kept, never the key or the text, and only while a grant covers the frame and for
// USER_INPUT_RECENT_MS after it ends (`armed`): a frame Caret is not filling keeps nothing.

/** How long a time is kept and reported. Assumed, not measured: twice the longest span from a write's send to the read
 * after Stop that judges it (the page link's 5 s act deadline, Stop's 5 s wait, the walk's 5 s deadline). */
export const USER_INPUT_RECENT_MS = 30_000;
/** At most this many elements are kept; the oldest go first. A form has one focused field at a time. */
const MAX_KEPT = 64;

/** Whether an event is the user's own input on a field: trusted, and not the Esc that stops Caret. */
export function isUserInput(e: { isTrusted: boolean; type: string; key?: string }): boolean {
  if (!e.isTrusted) return false;
  if (e.type === "keydown") return e.key !== "Escape";
  return e.type === "beforeinput" || e.type === "input";
}

export class UserInputs<E extends object> {
  /** Element to the time input last reached it, oldest first. */
  private readonly seen = new Map<E, number>();
  /** Input before this time is noted: USER_INPUT_RECENT_MS past the end of the frame's grants. */
  private until = 0;
  /** Whether `inner` is `outer` or sits inside it, shadow roots included. */
  private readonly within: (inner: E, outer: E) => boolean;

  constructor(within: (inner: E, outer: E) => boolean) {
    this.within = within;
  }

  /**
   * The frame's grants now run until `until`, or ended at `now` (0): input is noted until USER_INPUT_RECENT_MS past
   * that, so the read after a Stop, which ends the grants, still finds it.
   */
  armed(until: number, now: number): void {
    this.until = until > 0 ? Math.max(this.until, until + USER_INPUT_RECENT_MS) : Math.min(this.until, now + USER_INPUT_RECENT_MS);
  }

  /** The user's input reached `el` at `at`; kept only while the frame is armed (`armed`). */
  noted(el: E, at: number): void {
    if (at >= this.until) return;
    this.seen.delete(el);
    this.seen.set(el, at);
    this.prune(at);
  }

  /** When input last reached `control` or an element inside it, within USER_INPUT_RECENT_MS of `now`; undefined if not. */
  at(control: E, now: number): number | undefined {
    this.prune(now);
    let last: number | undefined;
    for (const [el, at] of this.seen) if ((last === undefined || at > last) && this.within(el, control)) last = at;
    return last;
  }

  private prune(now: number): void {
    for (const [el, at] of this.seen) {
      if (now - at < USER_INPUT_RECENT_MS && this.seen.size <= MAX_KEPT) break;
      this.seen.delete(el);
    }
  }
}
