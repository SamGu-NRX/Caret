// What a Jev request may carry from the screen. The host's onboarding promises: "To decide what to
// offer, Caret sends short snippets to a cloud model, such as a field's label and the values it might
// fill. Never whole windows." Every request builder declares each piece of screen text it puts in a
// request as a Snippet (a field descriptor or a candidate value, and the window it came from) and takes
// it through a SnippetLedger, which holds each window to its budget. test/privacy.test.ts records every
// request the producers make over the synthetic sessions and checks the request text against the
// declarations and these bounds.
import { nodeText, type WindowState } from "./model.ts";

/**
 * Distinct characters of one window's text that one request may carry. The bound comes from the
 * question shapes. The pending question shows Jev at most 4 marker lines and 6 changed lines of
 * SNIPPET_CHARS each, which is 1,200. The fill question's densest source window in the synthetic
 * calibration recordings (~/.caret-run/evidence/screen/fill-distractors-v2, 21 recordings) gives 589
 * distinct characters over 21 candidates, so 1,200 leaves twice that before a window's values are cut.
 * A window with more text than this never goes out whole.
 */
export const WINDOW_CHARS = 1200;
/** The longest screen line the pending and first-look questions quote, cut with an ellipsis past it. */
export const SNIPPET_CHARS = 120;
/**
 * A window whose every line is at most CARD_LINE_CHARS long (the fill generator's longest candidate) and
 * that has at most CARD_LINES lines is a card of values: a contact card, an order confirmation, a meeting
 * block. Its lines are themselves the values a fill might copy, so a request may carry all of it, up to
 * WINDOW_CHARS. Any other window keeps more than half of its text back. 24 is assumed: just above the
 * calibration fixture's largest source window, 21 lines.
 */
export const CARD_LINES = 24;
export const CARD_LINE_CHARS = 80;

export interface Snippet {
  windowId: string;
  /** A field descriptor (a label, placeholder, section or window title that says what something is) or a candidate value with its facts. */
  kind: "descriptor" | "candidate";
  text: string;
}

/** Collapses whitespace as every request builder does before it quotes a line. */
export const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A line cut to SNIPPET_CHARS, ellipsis included. */
export function cut(s: string, max = SNIPPET_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const budgets = new WeakMap<WindowState, number>();

/**
 * The characters a request may take from this window: WINDOW_CHARS for a card of values and for a window
 * with more than twice that much text, else just under half its text. Overlapping texts each count in
 * full, so outside a card the budget holds a request under half the window with room to spare. A window's text is its title and every line of its nodes'
 * labels, values and placeholders, each counted once. Reading stops once the text is twice WINDOW_CHARS,
 * where the bound is WINDOW_CHARS whatever the rest holds; cached per window state, which the model
 * replaces on every snapshot.
 */
export function windowBudget(w: WindowState): number {
  const cached = budgets.get(w);
  if (cached !== undefined) return cached;
  const seen = new Set<string>();
  let chars = 0;
  let card = true;
  const add = (raw: string | undefined): boolean => {
    if (raw === undefined) return true;
    for (const line of raw.split("\n")) {
      const t = flat(line);
      if (t === "" || seen.has(t)) continue;
      seen.add(t);
      chars += t.length;
      if (t.length > CARD_LINE_CHARS || seen.size > CARD_LINES) card = false;
      if (chars >= 2 * WINDOW_CHARS) return false;
    }
    return true;
  };
  let whole = add(w.window.title);
  for (const n of w.nodes.values()) {
    if (!whole) break;
    whole = add(n.label) && add(n.value) && add(n.placeholder) && add(nodeText(n));
  }
  // A card's budget is not its size: a request quotes a value both as a span and inside its labelled line
  // ("Priya Raman <priya@…>" and "priya@…"), so the texts taken can add up to more than the card holds
  // while covering no more of it.
  const budget = !whole || card ? WINDOW_CHARS : Math.min(WINDOW_CHARS, Math.floor((chars - 1) / 2));
  budgets.set(w, budget);
  return budget;
}

/**
 * The screen text one request takes, window by window. `take` adds a group of texts (one candidate with
 * its facts, one field's descriptor) only when every new text in it fits the window's budget, so a group
 * goes out whole or not at all; texts already taken from that window cost nothing again.
 */
export class SnippetLedger {
  private readonly windows = new Map<string, { texts: Set<string>; chars: number; budget: number }>();
  readonly snippets: Snippet[] = [];

  take(w: WindowState, kind: Snippet["kind"], texts: readonly (string | null | undefined)[]): boolean {
    const id = w.window.windowId;
    let e = this.windows.get(id);
    if (e === undefined) this.windows.set(id, (e = { texts: new Set(), chars: 0, budget: windowBudget(w) }));
    const fresh = [...new Set(texts.filter((t): t is string => t !== null && t !== undefined && t !== "" && !e.texts.has(t)))];
    const cost = fresh.reduce((n, t) => n + t.length, 0);
    if (e.chars + cost > e.budget) return false;
    for (const t of fresh) {
      e.texts.add(t);
      this.snippets.push({ windowId: id, kind, text: t });
    }
    e.chars += cost;
    return true;
  }

  /**
   * Declares text a request carries that a plan wrote rather than a window shows: an executor step's goal
   * and target. A plan's values were copied from windows when it was made, so these are candidate values;
   * the caller cuts each to SNIPPET_CHARS, since no window's budget is charged for them. Their window id is "plan".
   */
  plan(texts: readonly string[]): void {
    for (const t of new Set(texts)) if (t !== "") this.snippets.push({ windowId: "plan", kind: "candidate", text: t });
  }

  /** Characters taken from a window so far. */
  chars(windowId: string): number {
    return this.windows.get(windowId)?.chars ?? 0;
  }
}
