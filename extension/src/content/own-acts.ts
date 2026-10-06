// The focus report of a document (W2) and which focus changes are Caret's own (C1). Writing a field, picking an option
// or ticking a box focuses the control, and the focusin listener reported that focus as it reports the user's, so the
// helper asked an ambient Fill all on a form Caret was filling and spent Jev calls on it (P2's fixture runs). Acts are
// counted where they run, so a focus change made while one runs is Caret's and asks for nothing; the user's own focus,
// before or right after an act, is reported as before. A focus the page itself moves after an act answered is not
// counted as Caret's: nothing ties it to the act.

/** Assumed: one report per burst of focus changes is enough for the helper to walk once. */
export const FOCUS_EVERY_MS = 150;
/**
 * H13: how long a burst of typing in the focused field is gathered before it is reported, so the host's inline text
 * follows the text as it is. Assumed, not measured: short against the gap between keystrokes of steady typing (about
 * 150 to 250 ms), long enough to join a key's input and selectionchange events into one report.
 */
export const TYPED_EVERY_MS = 30;

export interface FocusReporterDeps {
  /** Whether the document is visible and has focus now. */
  inFront: () => boolean;
  /** Runs `f` after `ms`. */
  later: (f: () => void, ms: number) => void;
  /** Tells the worker focus moved. */
  report: () => void;
}

export class FocusReporter {
  private readonly deps: FocusReporterDeps;
  private armed = false;
  private typedArmed = false;
  /** The user typed while Caret's act ran: one report follows the act, so the host hears the field as it ends up. */
  private typedDuringAct = false;
  private acts = 0;

  constructor(deps: FocusReporterDeps) {
    this.deps = deps;
  }

  /** An act of Caret's started in this document. */
  actStarted(): void {
    this.acts++;
  }

  /** An act of Caret's answered. */
  actEnded(): void {
    this.acts = Math.max(0, this.acts - 1);
    if (this.acts === 0 && this.typedDuringAct) {
      this.typedDuringAct = false;
      this.typed();
    }
  }

  /**
   * H13 review: the page's document lost focus (the user clicked the address bar, or another browser window): reported
   * at once, though the document is no longer in front, so the helper walks the tab and the host takes down inline text
   * the user's next Tab would otherwise claim. Not during Caret's own act.
   */
  left(): void {
    if (this.acts > 0) return;
    this.deps.report();
  }

  /**
   * H13: the text or the caret of the focused field changed (an input or selectionchange event). Arms one report,
   * sent TYPED_EVERY_MS later if still in front, so the helper walks the field and the host learns the text around its
   * caret. During Caret's own act (an insert at the caret writes the field too) it waits for the act to end.
   */
  typed(): void {
    if (this.acts > 0) {
      this.typedDuringAct = true;
      return;
    }
    if (this.typedArmed || !this.deps.inFront()) return;
    this.typedArmed = true;
    this.deps.later(() => {
      this.typedArmed = false;
      if (this.deps.inFront()) this.deps.report();
    }, TYPED_EVERY_MS);
  }

  /** A focusin: the first of a burst that is not Caret's own arms one report, sent FOCUS_EVERY_MS later if still in front. */
  focusIn(): void {
    if (this.acts > 0 || this.armed || !this.deps.inFront()) return;
    this.armed = true;
    this.deps.later(() => {
      this.armed = false;
      if (this.deps.inFront()) this.deps.report();
    }, FOCUS_EVERY_MS);
  }
}
