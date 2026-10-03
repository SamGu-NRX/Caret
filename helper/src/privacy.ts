// What a Jev request may carry from the screen. The host's onboarding promises: "To decide what to
// offer, Caret sends short snippets to a cloud model, such as a field's label and the values it might
// fill. Never a whole document or conversation." Every request builder declares each piece of screen text it puts in a
// request as a Snippet (a field descriptor or a candidate value, and the window it came from) and takes
// it through a SnippetLedger, which holds each window to its budget. test/privacy.test.ts records every
// request the producers make over the synthetic sessions and checks the request text against the
// declarations and these bounds.
import { nodeText, type WindowState } from "./model.ts";
import { isConversation } from "./conversation.ts";

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
/**
 * Distinct characters one request may take from a conversation (conversation.ts), which also always
 * keeps more than half of its text back, however short it is: a conversation is what people mean by
 * private, and a short chat of 24 lines would otherwise pass as a card and go out whole. 600 is half of
 * WINDOW_CHARS and is assumed, not measured; the live replay (scripts/live-replay.ts) measures what it
 * costs fill when the source windows are chats.
 */
export const CONVERSATION_CHARS = 600;

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

interface WindowShare {
  budget: number;
  /** The window's distinct lines when it was read whole, for charging the lines a taken text contains; null past 2 * WINDOW_CHARS. */
  lines: readonly string[] | null;
}

let budgets = new WeakMap<WindowState, WindowShare>();
let conversationCap = true;

/**
 * Turns the conversation rule off or back on, for the live replay's comparison of fill with and
 * without it (scripts/live-replay.ts). The helper never calls it; the rule is on from start.
 */
export function setConversationCap(on: boolean): void {
  conversationCap = on;
  budgets = new WeakMap();
}

/**
 * The characters a request may take from this window. A conversation gives just under half its text, and
 * at most CONVERSATION_CHARS. Any other window gives WINDOW_CHARS when it is a card of values or has more
 * than twice that much text, else just under half its text. Overlapping texts each count in
 * full, so outside a card the budget holds a request under half the window with room to spare. A window's text is its title and every line of its nodes'
 * labels, values and placeholders, each counted once. Reading stops once the text is twice WINDOW_CHARS,
 * where the bound is WINDOW_CHARS whatever the rest holds; cached per window state, which the model
 * replaces on every snapshot.
 */
export function windowBudget(w: WindowState): number {
  return windowShare(w).budget;
}

function windowShare(w: WindowState): WindowShare {
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
  const half = Math.max(0, Math.floor((chars - 1) / 2));
  // Past 2 * WINDOW_CHARS the count stopped, so `half` is a floor there, and above CONVERSATION_CHARS.
  const budget = conversationCap && isConversation(w) ? Math.min(CONVERSATION_CHARS, half) : !whole || card ? WINDOW_CHARS : Math.min(WINDOW_CHARS, half);
  const share = { budget, lines: whole ? [...seen] : null };
  budgets.set(w, share);
  return share;
}

/** Lines shorter than this are not charged when a taken text contains them: a letter or two is in most texts. */
const CONTAINED_MIN = 3;

/**
 * The screen text one request takes, window by window. `take` adds a group of texts (one candidate with
 * its facts, one field's descriptor) only when every new text in it fits the window's budget, so a group
 * goes out whole or not at all; texts already taken from that window cost nothing again. A text also
 * pays for every other line of the window it contains: accessibility trees repeat text, a group's label
 * holding its children's, so taking "Alice, meet Bob at 3:41 PM" reveals the lines "Bob" and "3:41 PM"
 * as well, and the window's text counts each of them.
 */
export class SnippetLedger {
  private readonly windows = new Map<string, { texts: Set<string>; covered: Set<string>; chars: number; share: WindowShare }>();
  readonly snippets: Snippet[] = [];

  take(w: WindowState, kind: Snippet["kind"], texts: readonly (string | null | undefined)[]): boolean {
    const id = w.window.windowId;
    let e = this.windows.get(id);
    if (e === undefined) this.windows.set(id, (e = { texts: new Set(), covered: new Set(), chars: 0, share: windowShare(w) }));
    const fresh = [...new Set(texts.filter((t): t is string => t !== null && t !== undefined && t !== "" && !e.texts.has(t)))];
    const covered = new Set<string>();
    let cost = 0;
    for (const t of fresh) {
      if (!e.covered.has(t)) cost += t.length;
      covered.add(t);
      for (const l of e.share.lines ?? []) {
        if (l.length < CONTAINED_MIN || l === t || e.covered.has(l) || covered.has(l) || !t.includes(l)) continue;
        covered.add(l);
        cost += l.length;
      }
    }
    if (e.chars + cost > e.share.budget) return false;
    for (const t of fresh) {
      e.texts.add(t);
      this.snippets.push({ windowId: id, kind, text: t });
    }
    for (const l of covered) e.covered.add(l);
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
