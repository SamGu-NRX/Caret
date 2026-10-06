// The focus report of a document (W2) and which focus changes are Caret's own (C1). Writing a field, picking an option
// or ticking a box focuses the control, and the focusin listener reported that focus as it reports the user's, so the
// helper asked an ambient Fill all on a form Caret was filling and spent Jev calls on it (P2's fixture runs). Acts are
// counted where they run, so a focus change made while one runs is Caret's and asks for nothing; the user's own focus,
// before or right after an act, is reported as before. A focus the page itself moves after an act answered is not
// counted as Caret's: nothing ties it to the act.

/** Assumed: one report per burst of focus changes is enough for the helper to walk once. */
export const FOCUS_EVERY_MS = 150;

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
