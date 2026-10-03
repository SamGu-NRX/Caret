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

/** A request's screen text as its ledger took it, and the characters charged to each window (JevRequest). */
export interface Declared {
  snippets: readonly Snippet[];
  charged: Readonly<Record<string, number>>;
}

/** Collapses whitespace as every request builder does before it quotes a line. */
/** Whitespace flat() would change: a run, a tab or line break, or space at either end. Testing first spares the copy for most lines. */
const UNCLEAN = /\s\s|[^\S ]|^\s|\s$/;
export const flat = (s: string): string => (UNCLEAN.test(s) ? s.replace(/\s+/g, " ").trim() : s);

/** A line cut to SNIPPET_CHARS, ellipsis included. */
export function cut(s: string, max = SNIPPET_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Lines shorter than this are not charged when a taken text contains them: a letter or two is in most texts. */
const CONTAINED_MIN = 3;

/** A window's text as the ledger reads it, whatever the conversation rule says. */
interface WindowText {
  chars: number;
  card: boolean;
  /** The window's distinct lines of CONTAINED_MIN or more characters, for charging the lines a taken text contains. */
  lines: readonly string[];
  /** The same lines joined by NUL, which no screen text holds, so a search for a text finds it only inside one line. */
  joined: string;
}

interface WindowShare {
  budget: number;
  text: WindowText;
}

const texts = new WeakMap<WindowState, WindowText>();
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
 * full, so outside a card the budget holds a request under half the window with room to spare. A window's
 * text is its title and every line of its nodes' labels, values and placeholders, each counted once;
 * cached per window state, which the model replaces on every snapshot.
 */
export function windowBudget(w: WindowState): number {
  return windowShare(w).budget;
}

function windowText(w: WindowState): WindowText {
  const cached = texts.get(w);
  if (cached !== undefined) return cached;
  const seen = new Set<string>();
  let chars = 0;
  let card = true;
  // Every line is read, however large the window. B10 stopped at 2 * WINDOW_CHARS, where the budget no
  // longer changes, but then had no lines to charge a containing text for, so a parent's label that
  // joins its children's went out uncharged for them (B13 review: 907 characters of a Messages window
  // covered on a 595 charge).
  const add = (raw: string | undefined): void => {
    if (raw === undefined) return;
    for (const line of raw.split("\n")) {
      const t = flat(line);
      if (t === "" || seen.has(t)) continue;
      seen.add(t);
      chars += t.length;
      if (t.length > CARD_LINE_CHARS || seen.size > CARD_LINES) card = false;
    }
  };
  add(w.window.title);
  // nodeText is a node's label, value or both, so these three cover it.
  for (const n of w.nodes.values()) {
    add(n.label);
    add(n.value);
    add(n.placeholder);
  }
  const lines = [...seen].filter((l) => l.length >= CONTAINED_MIN);
  const out = { chars, card, lines, joined: `\u0000${lines.join("\u0000")}\u0000` };
  texts.set(w, out);
  return out;
}

function windowShare(w: WindowState): WindowShare {
  const cached = budgets.get(w);
  if (cached !== undefined) return cached;
  const text = windowText(w);
  // A card's budget is not its size: a request quotes a value both as a span and inside its labelled line
  // ("Priya Raman <priya@…>" and "priya@…"), so the texts taken can add up to more than the card holds
  // while covering no more of it.
  const half = Math.max(0, Math.floor((text.chars - 1) / 2));
  const large = text.chars >= 2 * WINDOW_CHARS;
  const budget = heldAsConversation(w) ? Math.min(CONVERSATION_CHARS, half) : large || text.card ? WINDOW_CHARS : Math.min(WINDOW_CHARS, half);
  const share = { budget, text };
  budgets.set(w, share);
  return share;
}

/** Whether the conversation rule holds this window: it is a conversation, and the rule is on. */
export function heldAsConversation(w: WindowState): boolean {
  return conversationCap && isConversation(w);
}

/** Lines by their first CONTAINED_MIN characters: each line, and the ids of the windows that show it. */
type LineIndex = Map<string, Map<string, string[]>>;
/** The last index built, with the window states it was built over. */
let lastIndex: { states: readonly WindowState[]; index: LineIndex } | null = null;

interface Priced {
  fresh: string[];
  adds: Map<string, { cost: number; covered: Set<string> }>;
}

interface Entry {
  texts: Set<string>;
  covered: Set<string>;
  chars: number;
  share: WindowShare;
}

/**
 * The screen text one request takes, window by window. `take` adds a group of texts (one candidate with
 * its facts, one field's descriptor) only when every new text in it fits, so a group goes out whole or
 * not at all; texts already taken from that window cost nothing again. A text also pays for every line
 * it contains, in whichever window shows that line: accessibility trees repeat text, a group's label
 * holding its children's, so taking "Alice, meet Bob at 3:41 PM" reveals the lines "Bob" and "3:41 PM"
 * as well; and a value copied into a card, "Dana Whitfield", reveals the chat line that reads the same.
 * Every window so charged must stay within its own budget, or nothing is taken. The ledger is built over
 * every window a request could reveal (the screen model's), since a line of a window the request never
 * takes from is still revealed when a taken text contains it; privacy.test.ts measures the same.
 */
export class SnippetLedger {
  private readonly entries = new Map<string, Entry>();
  private readonly known = new Map<string, WindowState>();
  /** Every known window's lines by their first CONTAINED_MIN characters: each line, and the windows that show it. */
  private index: LineIndex | null = null;
  readonly snippets: Snippet[] = [];

  /** `windows`: every window whose lines a request's text could reveal, normally all of the screen model's. */
  constructor(windows: Iterable<WindowState>) {
    for (const w of windows) this.known.set(w.window.windowId, w);
  }

  private entry(w: WindowState): Entry {
    const id = w.window.windowId;
    let e = this.entries.get(id);
    if (e === undefined) this.entries.set(id, (e = { texts: new Set(), covered: new Set(), chars: 0, share: windowShare(w) }));
    return e;
  }

  /** A window a take names that the ledger was not built over (a closed source a task kept) is known from then on. */
  private know(w: WindowState): void {
    if (this.known.has(w.window.windowId)) return;
    this.known.set(w.window.windowId, w);
    this.index = null;
  }

  private lineIndex(): LineIndex {
    if (this.index !== null) return this.index;
    const states = [...this.known.values()];
    // Consecutive requests over an unchanged screen (a fill's two asks, a first look's questions) share one index.
    if (lastIndex !== null && lastIndex.states.length === states.length && lastIndex.states.every((w, i) => w === states[i])) return (this.index = lastIndex.index);
    const idx: LineIndex = new Map();
    for (const w of states) {
      const id = w.window.windowId;
      for (const l of windowText(w).lines) {
        const p = l.slice(0, CONTAINED_MIN);
        let bucket = idx.get(p);
        if (bucket === undefined) idx.set(p, (bucket = new Map()));
        const ids = bucket.get(l);
        if (ids === undefined) bucket.set(l, [id]);
        else ids.push(id);
      }
    }
    lastIndex = { states, index: idx };
    return (this.index = idx);
  }

  /** Every known window's line the text holds, each with the windows that show it. */
  private contained(t: string): [string, string[]][] {
    const idx = this.lineIndex();
    const out = new Map<string, string[]>();
    for (let i = 0; i + CONTAINED_MIN <= t.length; i++) {
      const bucket = idx.get(t.slice(i, i + CONTAINED_MIN));
      if (bucket === undefined) continue;
      for (const [l, ids] of bucket) if (!out.has(l) && t.startsWith(l, i)) out.set(l, ids);
    }
    return [...out];
  }

  /**
   * What taking these texts would add, window by window: the characters, and the lines they cover. A text
   * taken from a window (`from`) is charged to it in full, a line of it or not; plan text (`from` null)
   * only pays for the lines it holds. Null when a window would go over its budget.
   */
  private price(from: WindowState | null, texts: readonly (string | null | undefined)[]): Priced | null {
    const own = from === null ? null : (this.know(from), this.entry(from));
    const fresh = [...new Set(texts.filter((t): t is string => t !== null && t !== undefined && t !== "" && own?.texts.has(t) !== true))];
    const adds = new Map<string, { cost: number; covered: Set<string> }>();
    const charge = (wid: string, line: string): void => {
      const w = this.known.get(wid);
      if (w === undefined) return;
      const e = this.entry(w);
      let a = adds.get(wid);
      if (a === undefined) adds.set(wid, (a = { cost: 0, covered: new Set() }));
      if (e.covered.has(line) || a.covered.has(line)) return;
      a.covered.add(line);
      a.cost += line.length;
    };
    for (const t of fresh) {
      if (from !== null) charge(from.window.windowId, t);
      // Every line the text holds, in whichever window shows it.
      for (const [l, ids] of this.contained(t)) for (const wid of ids) charge(wid, l);
      // And every other window that shows the text inside a line: a value taken from a card that a chat
      // message also quotes reveals that much of the chat.
      if (t.length < CONTAINED_MIN) continue;
      for (const [wid, w] of this.known) if (wid !== from?.window.windowId && windowText(w).joined.includes(t)) charge(wid, t);
    }
    for (const [wid, a] of adds) {
      const e = this.entries.get(wid) as Entry;
      if (e.chars + a.cost > e.share.budget) return null;
    }
    return { fresh, adds };
  }

  private commit(p: Priced, windowId: string, kind: Snippet["kind"], own: Entry | null): void {
    for (const t of p.fresh) {
      own?.texts.add(t);
      this.snippets.push({ windowId, kind, text: t });
    }
    for (const [wid, a] of p.adds) {
      const e = this.entries.get(wid) as Entry;
      for (const l of a.covered) e.covered.add(l);
      e.chars += a.cost;
    }
  }

  take(w: WindowState, kind: Snippet["kind"], texts: readonly (string | null | undefined)[]): boolean {
    const p = this.price(w, texts);
    if (p === null) return false;
    this.commit(p, w.window.windowId, kind, this.entry(w));
    return true;
  }

  /** What taking these texts from `w` would charge `w`, or null when some window would go over its budget. Takes nothing. */
  cost(w: WindowState, texts: readonly (string | null | undefined)[]): number | null {
    const p = this.price(w, texts);
    return p === null ? null : (p.adds.get(w.window.windowId)?.cost ?? 0);
  }

  /**
   * Declares text a request carries that a plan wrote rather than a window shows: an executor step's goal
   * and target, under window id "plan". The caller cuts each to SNIPPET_CHARS. A plan's values were copied
   * from windows, so each line of a known window the text holds is charged to that window, as `take` does;
   * false, declaring nothing, when one would go over its budget.
   */
  plan(texts: readonly string[]): boolean {
    const p = this.price(null, texts);
    if (p === null) return false;
    this.commit(p, "plan", "candidate", null);
    return true;
  }

  /** Characters charged to each window so far, by window id. */
  charges(): Record<string, number> {
    return Object.fromEntries([...this.entries].filter(([, e]) => e.chars > 0).map(([id, e]) => [id, e.chars]));
  }

  /** What a request built from this ledger declares: its screen text, and what each window was charged. */
  declared(): Declared {
    return { snippets: this.snippets, charged: this.charges() };
  }

  /** Characters taken from a window so far. */
  chars(windowId: string): number {
    return this.entries.get(windowId)?.chars ?? 0;
  }
}
