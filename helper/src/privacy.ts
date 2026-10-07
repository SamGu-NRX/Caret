// What a Jev request may carry from the screen. The host's onboarding promises: "To decide what to
// offer, Caret sends short snippets to a cloud model, such as a field's label and the values it might
// fill. Never a whole document or conversation." Every request builder declares each piece of screen text it puts in a
// request as a Snippet (a field descriptor or a candidate value, and the window it came from) and takes
// it through a SnippetLedger, which holds each window to its budget. test/privacy.test.ts records every
// request the producers make over the synthetic sessions and checks the request text against the
// declarations and these bounds.
import type { WindowState } from "./model.ts";
import type { Node } from "./protocol.ts";
import { isConversation } from "./conversation.ts";
import { secretText } from "./memory/sensitive.ts";

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
 * WINDOW_CHARS. 24 is assumed: just above the calibration fixture's largest source window, 21 lines. A line
 * longer than CARD_LINE_CHARS is prose: more than half of a window's prose always stays on the Mac
 * (windowBudget).
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

/** The window id under which a request declares values the user told Caret (SnippetLedger.memory). */
export const MEMORY_SNIPPETS = "memory";

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
  /** Windows the user's instruction named, which gave this request up to WINDOW_CHARS (SnippetLedger consented). */
  consented?: readonly string[];
}

/**
 * What a window the user's Ask names may give that one request (B26 lead decision 1): up to WINDOW_CHARS, whether it
 * is a conversation, a mixed note or a card, with no prose share. Naming a window is consent to read it for the request
 * that names it ("from my note", "Bea's email", "the Saturday Chris mentioned"), as asking is consent in the design's
 * lead decision 6. Before it, a mail an Ask named was held under half and to 600 characters as a conversation, and B25's
 * held-out asks that named one found nothing in it (held-12, held-14). Every other window, and every fill on focus,
 * keeps windowBudget; a window with more text than WINDOW_CHARS still never goes out whole.
 */
const CONSENTED: WindowShare = { budget: WINDOW_CHARS, prose: null };

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

/**
 * A window's text as the ledger reads it, whatever the conversation rule says: its distinct lines, and
 * an index of them for finding the lines a taken text holds and whether a line holds a text.
 *
 * A window's text is its title and every line of its nodes' labels, values and placeholders, each
 * distinct line counted once. Reading a window of 5,000 lines from scratch and searching it took a
 * ledger's first take 15 to 20 ms on eight such windows (B14 bench, ~/.caret-run/evidence/screen/b14).
 * So one table follows each window id from snapshot to snapshot: the model gives every snapshot a new
 * WindowState, and the table moves to the newest state it is asked about by changing only the lines of
 * nodes whose text differs. A table belongs to one state at a time; asking about an earlier state (a
 * task's kept source window) moves it back the same way, so every answer is about the state asked.
 */
class LineTable {
  owner: WindowState;
  /** Each distinct line, and how many of the title's and the nodes' lines read it. */
  private readonly counts = new Map<string, number>();
  /** Characters of the distinct lines. */
  chars = 0;
  /** Distinct lines longer than CARD_LINE_CHARS, and their characters: the window's prose. */
  private long = 0;
  longChars = 0;
  /** Distinct lines of CONTAINED_MIN or more characters by their first CONTAINED_MIN: their lengths, each with how many lines have it. */
  private readonly starts = new Map<string, Map<number, number>>();
  /** Texts asked about, and whether a line of the window holds them; kept right as lines come and go. */
  private readonly inside = new Map<string, boolean>();
  /** The lines of CONTAINED_MIN or more characters joined by NUL, which no screen text holds; null until a search needs it again. */
  private joined: string | null = null;

  constructor(w: WindowState) {
    this.owner = w;
    this.addField(w.window.title);
    for (const n of w.nodes.values()) this.addNode(n);
  }

  get card(): boolean {
    return this.counts.size <= CARD_LINES && this.long === 0;
  }

  /** Moves the table to another state of the same window, changing the lines of the nodes and title that differ. */
  moveTo(w: WindowState): void {
    const before = this.owner;
    this.owner = w;
    if (before.window.title !== w.window.title) {
      this.removeField(before.window.title);
      this.addField(w.window.title);
    }
    let kept = 0;
    for (const [k, n] of w.nodes) {
      const o = before.nodes.get(k);
      if (o !== undefined) kept++;
      if (o === n || (o !== undefined && o.label === n.label && o.value === n.value && o.placeholder === n.placeholder)) continue;
      if (o !== undefined) this.removeNode(o);
      this.addNode(n);
    }
    if (kept < before.nodes.size) for (const [k, o] of before.nodes) if (!w.nodes.has(k)) this.removeNode(o);
  }

  /** Whether some line of the window holds `t`, which is CONTAINED_MIN or more characters long. */
  holds(t: string): boolean {
    let r = this.inside.get(t);
    if (r !== undefined) return r;
    if (this.counts.has(t)) r = true;
    else {
      this.joined ??= `\u0000${[...this.counts.keys()].filter((l) => l.length >= CONTAINED_MIN).join("\u0000")}\u0000`;
      r = this.joined.includes(t);
    }
    // Bounded, since every candidate a request prices is asked about. No measurement behind the number.
    if (this.inside.size >= INSIDE_CACHE) this.inside.clear();
    this.inside.set(t, r);
    return r;
  }

  /** Whether `t` is a whole distinct line of the window. */
  isLine(t: string): boolean {
    return this.counts.has(t);
  }

  /**
   * Where `t` stands inside the window's lines of CONTAINED_MIN or more characters: each occurrence's line and
   * offset, at most MAX_OCCURRENCES of them, in line order. The ledger marks one of them as revealed (SnippetLedger).
   */
  occurrences(t: string): { line: string; at: number }[] {
    if (t.length < CONTAINED_MIN || !this.holds(t)) return [];
    this.joined ??= `\u0000${[...this.counts.keys()].filter((l) => l.length >= CONTAINED_MIN).join("\u0000")}\u0000`;
    const j = this.joined;
    const out: { line: string; at: number }[] = [];
    for (let p = j.indexOf(t); p >= 0 && out.length < MAX_OCCURRENCES; p = j.indexOf(t, p + 1)) {
      const start = j.lastIndexOf("\u0000", p) + 1;
      out.push({ line: j.slice(start, j.indexOf("\u0000", p)), at: p - start });
    }
    return out;
  }

  /**
   * The runs of `t`, each PARTIAL_MIN or more characters long, that a line of the window also shows: what a text
   * quoting part of a line reveals of it ("Copy this: " and a sentence's first hundred characters). Each run is the
   * longest stretch of `t` from its start that one line shows, so every run stands inside a line and is charged
   * there, prose share included. Runs from two lines may overlap in `t`. Before B26's review the matches of
   * different lines were merged into one run that no line held, which was charged no prose: a text joining the end of
   * one sentence to the start of another revealed 146 characters of a note's prose against a share of 96.
   */
  sharedRuns(t: string): string[] {
    if (t.length < PARTIAL_MIN) return [];
    this.joined ??= `\u0000${[...this.counts.keys()].filter((l) => l.length >= CONTAINED_MIN).join("\u0000")}\u0000`;
    const j = this.joined;
    const runs: string[] = [];
    let reach = 0;
    for (let p = 0; p + PARTIAL_MIN <= t.length; p++) {
      const gram = t.slice(p, p + PARTIAL_MIN);
      let best = 0;
      let n = 0;
      // `t` holds no NUL, so a match ends where its line does.
      for (let q = j.indexOf(gram); q >= 0 && n < MAX_OCCURRENCES; q = j.indexOf(gram, q + 1), n++) {
        let k = PARTIAL_MIN;
        while (p + k < t.length && j.charCodeAt(q + k) === t.charCodeAt(p + k)) k++;
        if (k > best) best = k;
      }
      // A run inside one already found reveals nothing more of this window.
      if (best > 0 && p + best > reach) {
        runs.push(t.slice(p, p + best));
        reach = p + best;
      }
    }
    return [...new Set(runs)];
  }

  /** Every distinct line of the window that `t` holds, by where it starts in `t`; each line once. */
  linesIn(t: string, out: Set<string>): void {
    for (let i = 0; i + CONTAINED_MIN <= t.length; i++) {
      const lens = this.starts.get(t.slice(i, i + CONTAINED_MIN));
      if (lens === undefined) continue;
      for (const len of lens.keys()) {
        if (i + len > t.length) continue;
        const l = len === t.length ? t : t.slice(i, i + len);
        if (this.counts.has(l)) out.add(l);
      }
    }
  }

  private addNode(n: Node): void {
    this.addField(n.label);
    this.addField(n.value);
    this.addField(n.placeholder);
  }

  private removeNode(n: Node): void {
    this.removeField(n.label);
    this.removeField(n.value);
    this.removeField(n.placeholder);
  }

  private addField(raw: string | undefined): void {
    if (raw === undefined || raw === "") return;
    if (!raw.includes("\n")) return this.addLine(flat(raw));
    for (const line of raw.split("\n")) this.addLine(flat(line));
  }

  private removeField(raw: string | undefined): void {
    if (raw === undefined || raw === "") return;
    if (!raw.includes("\n")) return this.removeLine(flat(raw));
    for (const line of raw.split("\n")) this.removeLine(flat(line));
  }

  private addLine(t: string): void {
    if (t === "") return;
    const c = this.counts.get(t);
    this.counts.set(t, (c ?? 0) + 1);
    if (c !== undefined) return;
    this.chars += t.length;
    if (t.length > CARD_LINE_CHARS) (this.long++, (this.longChars += t.length));
    if (t.length < CONTAINED_MIN) return;
    const p = t.slice(0, CONTAINED_MIN);
    let lens = this.starts.get(p);
    if (lens === undefined) this.starts.set(p, (lens = new Map()));
    lens.set(t.length, (lens.get(t.length) ?? 0) + 1);
    if (this.joined !== null) this.joined = null;
    for (const [s, held] of this.inside) if (!held && t.includes(s)) this.inside.set(s, true);
  }

  private removeLine(t: string): void {
    if (t === "") return;
    const c = this.counts.get(t);
    if (c === undefined) throw new Error(`the line table of window ${this.owner.window.windowId} lost count of a line`);
    if (c > 1) return void this.counts.set(t, c - 1);
    this.counts.delete(t);
    this.chars -= t.length;
    if (t.length > CARD_LINE_CHARS) (this.long--, (this.longChars -= t.length));
    if (t.length < CONTAINED_MIN) return;
    const lens = this.starts.get(t.slice(0, CONTAINED_MIN)) as Map<number, number>;
    const k = lens.get(t.length) as number;
    if (k > 1) lens.set(t.length, k - 1);
    else if (lens.size > 1) lens.delete(t.length);
    else this.starts.delete(t.slice(0, CONTAINED_MIN));
    if (this.joined !== null) this.joined = null;
    // Another line may hold the same texts, so they are asked again.
    for (const [s, held] of this.inside) if (held && t.includes(s)) this.inside.delete(s);
  }
}

/**
 * Shortest stretch of a plan's or memory's text that counts as quoting part of a window's line (sharedRuns).
 * Assumed: long enough that common words do not match by chance, short enough to catch a quoted phrase.
 */
const PARTIAL_MIN = 16;
/** Texts each window's table remembers asking about. Assumed. */
const INSIDE_CACHE = 4096;
/**
 * Occurrences of a text inside a window's lines that the ledger weighs when it marks one revealed (LineTable
 * occurrences). Assumed: a value repeated more often than this is marked in one of the first ones, which can only
 * charge more than the best choice would, never less.
 */
const MAX_OCCURRENCES = 64;
/** Windows whose tables are kept after their state was last asked about; the oldest goes first. Assumed: more windows than a screen usually has open. */
const TABLES_KEPT = 64;

/** The table of each window id, most recently used last. */
const tables = new Map<string, LineTable>();

function windowText(w: WindowState): LineTable {
  const id = w.window.windowId;
  let t = tables.get(id);
  if (t !== undefined) {
    tables.delete(id);
    if (t.owner !== w) t.moveTo(w);
  } else {
    t = new LineTable(w);
    if (tables.size >= TABLES_KEPT) tables.delete(tables.keys().next().value as string);
  }
  tables.set(id, t);
  return t;
}

/**
 * Brings the window's line table up to this state. The helper calls it as each snapshot arrives, so a
 * window is read from scratch once, when it first arrives, and after that only its changed nodes are,
 * instead of every window a request could reveal at the request's first take.
 */
export function readWindow(w: WindowState): void {
  windowText(w);
}

/** Lets go of a closed window's table. A state of it that a task kept is read from scratch if asked about. */
export function forgetWindow(windowId: string): void {
  tables.delete(windowId);
}

/** Lets go of every table, for a new reader session whose window ids start over. */
export function forgetWindows(): void {
  tables.clear();
}

interface WindowShare {
  budget: number;
  /** Characters of the window's prose (lines over CARD_LINE_CHARS) a request may cover, apart from `budget`; null when only `budget` holds it. */
  prose: number | null;
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
 * than twice that much text. Any other window, a mixed note or a short page, gives the characters of its
 * lines of at most CARD_LINE_CHARS, plus just under half the characters of its longer lines (its prose), at
 * most WINDOW_CHARS; and of its prose a request covers just under half at most (WindowShare.prose), however
 * the rest of the budget is spent. A request is charged the distinct characters it reveals (SnippetLedger). A window's text is its title and every
 * line of its nodes' labels, values and placeholders, each counted once (LineTable); the budget is cached per
 * window state, which the model replaces on every snapshot.
 *
 * Why the mixed-note rule (B25 lead decision 3): before it, such a window gave just under half its whole text,
 * so a short note with one sentence over 80 characters gave less than half its labelled value lines. On B24's
 * real-form corpus that was the largest cause of misses, 22 text fields withheld as sourceCut (evidence/screen/
 * b24/after). Measured on that corpus, which this rule was not tuned on but whose numbers prompted it
 * (evidence/screen/b25/budgets.md, fill-dev-2):
 * - The three mixed notes went from 282, 224 and 245 characters to 515, 400 and 431. The four mail sources are
 *   conversations, so their budgets did not change.
 * - Text sourceCut misses fell from 22 to 17 (rental application 12 to 7); fill went from 38 to 40 right of 131,
 *   with 0 wrong, a change within the run-to-run variation of about two fields.
 * - All three notes were still cut at their last line: a value and the line that holds it were each charged in
 *   full. B26 charges the distinct characters revealed instead (SnippetLedger), with this budget unchanged.
 *   Offline on the same corpus (scripts/realfill-budgets.ts, evidence/screen/b26/budgets-before.md and
 *   budgets-after.md), sources cut fell from 7 of 10 to 4: the rental and enrollment notes and the car-service
 *   mail now fit, and the RSVP mail gives 17 candidates, not 11. The checkout note is still cut, since its other
 *   person's address and phone sit in its one sentence and the prose share keeps them back.
 */
export function windowBudget(w: WindowState): number {
  return windowShare(w).budget;
}

function windowShare(w: WindowState): WindowShare {
  const cached = budgets.get(w);
  if (cached !== undefined) return cached;
  // Every line is read, however large the window. B10 stopped at 2 * WINDOW_CHARS, where the budget no
  // longer changes, but then had no lines to charge a containing text for, so a parent's label that
  // joins its children's went out uncharged for them (B13 review: 907 characters of a Messages window
  // covered on a 595 charge).
  const text = windowText(w);
  // A card's budget is WINDOW_CHARS rather than its size, so a card of values may go out whole.
  const half = Math.max(0, Math.floor((text.chars - 1) / 2));
  const large = text.chars >= 2 * WINDOW_CHARS;
  const prose = Math.max(0, Math.floor((text.longChars - 1) / 2));
  const share: WindowShare = heldAsConversation(w)
    ? { budget: Math.min(CONVERSATION_CHARS, half), prose: null }
    : large || text.card
      ? { budget: WINDOW_CHARS, prose: null }
      : { budget: Math.min(WINDOW_CHARS, text.chars - text.longChars + prose), prose };
  budgets.set(w, share);
  return share;
}

/**
 * Whether a request may take only part of this window's text though it is no conversation: a short note or
 * page that is not a card of values (a line over CARD_LINE_CHARS, or more than CARD_LINES lines) and not large,
 * held to under half its prose and to WINDOW_CHARS (windowBudget). Fill spends such a window's budget on the
 * lines nearest the form's fields first, as it does a conversation's (candidates.ts byRelevance, B24).
 */
export function heldToHalf(w: WindowState): boolean {
  if (heldAsConversation(w)) return false;
  const text = windowText(w);
  return !text.card && text.chars < 2 * WINDOW_CHARS;
}

/** Whether the conversation rule holds this window: it is a conversation, and the rule is on. */
export function heldAsConversation(w: WindowState): boolean {
  return conversationCap && isConversation(w);
}

/** What one window would add for a group of texts: characters newly revealed, of them prose, and the lines' new marks. */
interface Add {
  cost: number;
  prose: number;
  /** Texts revealed in this window for the first time, which plan text declares under it (commit). */
  covered: Set<string>;
  /** Copies of the line marks this pricing changed, by line; the entry's own marks change only on commit. */
  marks: Map<string, Uint8Array>;
}

interface Priced {
  fresh: string[];
  adds: Map<string, Add>;
}

interface Entry {
  texts: Set<string>;
  /** Every text revealed in this window so far: lines, texts inside lines, and texts no line shows. */
  covered: Set<string>;
  /** For each distinct line a request revealed some of, which of its characters it revealed. */
  marks: Map<string, Uint8Array>;
  chars: number;
  /** Of `chars`, the characters of prose (WindowShare.prose). */
  prose: number;
  share: WindowShare;
}

/**
 * The screen text one request takes, window by window. `take` adds a group of texts (one candidate with
 * its facts, one field's descriptor) only when every new text in it fits, so a group goes out whole or
 * not at all; texts already taken from that window cost nothing again. A text also reveals every line
 * it contains, in whichever window shows that line: accessibility trees repeat text, a group's label
 * holding its children's, so taking "Alice, meet Bob at 3:41 PM" reveals the lines "Bob" and "3:41 PM"
 * as well; and a value copied into a card, "Dana Whitfield", reveals the chat line that reads the same.
 * Every window so charged must stay within its own budget, or nothing is taken. The ledger is built over
 * every window a request could reveal (the screen model's), since a line of a window the request never
 * takes from is still revealed when a taken text contains it; privacy.test.ts measures the same.
 *
 * A window is charged the distinct characters of its lines a request reveals (B26 lead decision 2). Each
 * distinct line keeps a mark per character: a whole line marks all of it, a text inside a line marks where it
 * stands, and a charge is the characters newly marked. So a value inside a line already taken costs nothing
 * more, and a line holding a value already taken costs only its other characters. Before B26 the value and the
 * line holding it were each charged in full, and a note's budget was spent twice on the same characters (B25
 * found every corpus note cut at its last line for it, evidence/screen/b25/budgets.md). A text inside lines is
 * marked in one of them: one where it is already revealed (no charge), else a line of at most CARD_LINE_CHARS
 * before a prose line, since a value a note labels on its own line reveals none of a sentence that repeats it,
 * then the line with the most of it already marked. A text a window's lines do not show (a fact cut to length
 * with an ellipsis, a value spanning two lines) is charged its characters that the lines it holds do not cover.
 */
export class SnippetLedger {
  private readonly entries = new Map<string, Entry>();
  protected readonly known = new Map<string, WindowState>();
  /**
   * What each text reveals, worked out once per ledger: the lines it holds, with their windows, and the
   * windows that show it inside a line. The generator prices each kind of a conversation again after every
   * take, and takes the one it priced, so the same texts are looked up many times (B13 review: 25 to 29 ms
   * per pricing of 40 texts over eight windows of 5,000 lines).
   */
  private readonly reveals = new Map<string, { lines: [string, string[]][]; shownBy: string[] }>();
  /** Where a text stands inside a window's lines (LineTable.occurrences), by window id and text; looked up only when a charge needs it. */
  private readonly places = new Map<string, { line: string; at: number }[]>();
  /** For plan and memory text: the runs of it each window's lines show (LineTable.sharedRuns), worked out once per ledger. */
  private readonly partials = new Map<string, [string, string[]][]>();
  readonly snippets: Snippet[] = [];

  private readonly consented: ReadonlySet<string>;

  /**
   * `windows`: every window whose lines a request's text could reveal, normally all of the screen model's.
   * `consented`: windows the user's Ask names, which this request may read up to WINDOW_CHARS (CONSENTED).
   */
  constructor(windows: Iterable<WindowState>, o: { consented?: ReadonlySet<string> } = {}) {
    for (const w of windows) this.known.set(w.window.windowId, w);
    this.consented = o.consented ?? new Set();
  }

  private entry(w: WindowState): Entry {
    const id = w.window.windowId;
    let e = this.entries.get(id);
    if (e === undefined) this.entries.set(id, (e = { texts: new Set(), covered: new Set(), marks: new Map(), chars: 0, prose: 0, share: this.consented.has(id) ? CONSENTED : windowShare(w) }));
    return e;
  }

  /** The characters this request may take from a window: its budget, or WINDOW_CHARS when the Ask named it. */
  budget(w: WindowState): number {
    return this.consented.has(w.window.windowId) ? CONSENTED.budget : windowBudget(w);
  }

  /** A window a take names that the ledger was not built over (a closed source a task kept) is known from then on. */
  private know(w: WindowState): void {
    if (this.known.has(w.window.windowId)) return;
    this.known.set(w.window.windowId, w);
    this.reveals.clear();
    this.partials.clear();
  }

  private placesOf(wid: string, t: string): { line: string; at: number }[] {
    const k = `${wid}\u0000${t}`;
    let r = this.places.get(k);
    if (r === undefined) this.places.set(k, (r = windowText(this.known.get(wid) as WindowState).occurrences(t)));
    return r;
  }

  /**
   * The runs of a plan's or memory's text that windows' lines show, with the windows: a text that quotes part of a
   * line, not the whole line, reveals that part of it (B25 review: an instruction quoting most of a note's sentence
   * was charged nothing). A run inside a whole line the text holds is that line's, charged once already.
   */
  private partialRuns(t: string): [string, string[]][] {
    let r = this.partials.get(t);
    if (r !== undefined) return r;
    const whole = this.revealed(t).lines;
    const out = new Map<string, string[]>();
    for (const [wid, w] of this.known) {
      for (const run of windowText(w).sharedRuns(t)) {
        if (whole.some(([l, ids]) => ids.includes(wid) && l.includes(run))) continue;
        const ids = out.get(run);
        if (ids === undefined) out.set(run, [wid]);
        else ids.push(wid);
      }
    }
    r = [...out];
    this.partials.set(t, r);
    return r;
  }

  private revealed(t: string): { lines: [string, string[]][]; shownBy: string[] } {
    let r = this.reveals.get(t);
    if (r !== undefined) return r;
    const shownBy: string[] = [];
    const lines = new Map<string, string[]>();
    const found = new Set<string>();
    for (const [wid, w] of this.known) {
      const table = windowText(w);
      if (t.length >= CONTAINED_MIN && table.holds(t)) shownBy.push(wid);
      // Every line of this window the text holds, with the windows that show it.
      found.clear();
      table.linesIn(t, found);
      for (const l of found) {
        const ids = lines.get(l);
        if (ids === undefined) lines.set(l, [wid]);
        else ids.push(wid);
      }
    }
    r = { lines: [...lines], shownBy };
    this.reveals.set(t, r);
    return r;
  }

  /**
   * What taking these texts would add, window by window: the characters newly revealed, and the texts. A text
   * taken from a window (`from`) is charged to it, whether or not a line of it shows the text; plan text (`from`
   * null) only pays for what windows' lines show of it. Null when a window would go over its budget.
   */
  private price(from: WindowState | null, texts: readonly (string | null | undefined)[]): Priced | null {
    const own = from === null ? null : (this.know(from), this.entry(from));
    const fresh = [...new Set(texts.filter((t): t is string => t !== null && t !== undefined && t !== "" && own?.texts.has(t) !== true))];
    const adds = new Map<string, Add>();
    /** The window's add, unless it has revealed `t` already (in this pricing or before); null then. */
    const fresh1 = (wid: string, t: string): { e: Entry; a: Add } | null => {
      const w = this.known.get(wid);
      if (w === undefined) return null;
      const e = this.entry(w);
      let a = adds.get(wid);
      if (a === undefined) adds.set(wid, (a = { cost: 0, prose: 0, covered: new Set(), marks: new Map() }));
      if (e.covered.has(t) || a.covered.has(t)) return null;
      a.covered.add(t);
      return { e, a };
    };
    const view = (e: Entry, a: Add, line: string): Uint8Array | undefined => a.marks.get(line) ?? e.marks.get(line);
    /** Marks [at, at + len) of a line revealed and charges the characters newly marked. */
    const mark = (e: Entry, a: Add, line: string, at: number, len: number): void => {
      let m = a.marks.get(line);
      if (m === undefined) {
        const before = e.marks.get(line);
        a.marks.set(line, (m = before === undefined ? new Uint8Array(line.length) : before.slice()));
      }
      let n = 0;
      for (let i = at; i < at + len; i++) if (m[i] === 0) (m[i] = 1, n++);
      a.cost += n;
      // What of the window's prose the text reveals counts against its prose share as well.
      if (e.share.prose !== null && line.length > CARD_LINE_CHARS) a.prose += n;
    };
    /** A whole line of window `wid`. */
    const chargeLine = (wid: string, line: string): void => {
      const x = fresh1(wid, line);
      if (x !== null) mark(x.e, x.a, line, 0, line.length);
    };
    /** A text that lines of window `wid` hold: one of its occurrences is marked (the class's comment says which). */
    const chargeInside = (wid: string, t: string): void => {
      const x = fresh1(wid, t);
      if (x === null) return;
      const { e, a } = x;
      const occ = this.placesOf(wid, t);
      // Every caller found the text inside a line first; were none found after all, it is charged in full.
      if (occ.length === 0) return void (a.cost += t.length);
      let best: { line: string; at: number; marked: number } | null = null;
      for (const o of occ) {
        const m = view(e, a, o.line);
        let marked = 0;
        if (m !== undefined) for (let i = o.at; i < o.at + t.length; i++) marked += m[i] as number;
        if (marked === t.length) return;
        const short = o.line.length <= CARD_LINE_CHARS;
        const bestShort = best !== null && best.line.length <= CARD_LINE_CHARS;
        if (best === null || (short && !bestShort) || (short === bestShort && marked > best.marked)) best = { ...o, marked };
      }
      if (best !== null) mark(e, a, best.line, best.at, t.length);
    };
    for (const t of fresh) {
      // A text is matched piece by piece in every window: a line break or a cut's ellipsis ends a piece, so a value
      // cut to length still reveals the line it was cut from, in whichever window shows it (B26 review: a cut line
      // charged its own window and not a chat that showed the same line).
      const pieces = t.split("\n").map((raw) => flat(raw).replace(/^…|…$/gu, "")).filter((x) => x !== "");
      for (const piece of pieces) {
        const r = this.revealed(piece);
        if (from !== null) {
          const wid = from.window.windowId;
          const table = windowText(from);
          // Taken from this window: a whole line, a text inside lines, or neither, which is charged what of it the
          // lines it holds do not cover.
          if (table.isLine(piece)) chargeLine(wid, piece);
          else if (piece.length >= CONTAINED_MIN && table.holds(piece)) chargeInside(wid, piece);
          else {
            const x = fresh1(wid, piece);
            if (x !== null) {
              const held = new Set<string>();
              table.linesIn(piece, held);
              const cover = new Uint8Array(piece.length);
              for (const l of held) for (let p = piece.indexOf(l); p >= 0; p = piece.indexOf(l, p + 1)) cover.fill(1, p, p + l.length);
              x.a.cost += piece.length - cover.reduce((n, b) => n + b, 0);
            }
          }
        }
        // Every line the piece holds, in whichever window shows it.
        for (const [l, ids] of r.lines) for (const wid of ids) chargeLine(wid, l);
        // And every other window that shows the piece inside a line: a value taken from a card that a chat
        // message also quotes reveals that much of the chat.
        for (const wid of r.shownBy) if (wid !== from?.window.windowId) chargeInside(wid, piece);
        // Plan and memory text that quotes part of a line reveals that part.
        if (from === null) for (const [run, ids] of this.partialRuns(piece)) for (const wid of ids) chargeInside(wid, run);
      }
    }
    for (const [wid, a] of adds) {
      const e = this.entries.get(wid) as Entry;
      if (e.chars + a.cost > e.share.budget) return null;
      if (e.share.prose !== null && e.prose + a.prose > e.share.prose) return null;
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
      for (const [l, m] of a.marks) e.marks.set(l, m);
      e.chars += a.cost;
      e.prose += a.prose;
      // Text no window gave (a plan's or an instruction's, or what the user told Caret) declares each line it
      // reveals under the window that shows it, so the request names every window whose text it carries:
      // an instruction that quotes a line of private notes names the notes (B17 privacy test, planner desk).
      if (own === null) for (const l of a.covered) this.snippets.push({ windowId: wid, kind: "candidate", text: l });
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

  /**
   * Declares a value the user told Caret (a typed About entry, fill/about.ts) under window id "memory".
   * No window shows it, so none is charged for it, except a window whose lines it holds or that shows it
   * inside a line, as for `plan`: sending the value reveals that much of that window. False, declaring
   * nothing, when such a window would go over its budget.
   */
  memory(texts: readonly string[]): boolean {
    const p = this.price(null, texts);
    if (p === null) return false;
    this.commit(p, MEMORY_SNIPPETS, "candidate", null);
    return true;
  }

  /** Characters charged to each window so far, by window id. */
  charges(): Record<string, number> {
    return Object.fromEntries([...this.entries].filter(([, e]) => e.chars > 0).map(([id, e]) => [id, e.chars]));
  }

  /** What a request built from this ledger declares: its screen text, what each window was charged, and the windows the Ask named. */
  declared(): Declared {
    return { snippets: this.snippets, charged: this.charges(), ...(this.consented.size === 0 ? {} : { consented: [...this.consented] }) };
  }

  /** Characters taken from a window so far. */
  chars(windowId: string): number {
    return this.entries.get(windowId)?.chars ?? 0;
  }
}

/** G2 review: a request that would carry a secret marker (assertNoSecrets). */
export class SecretInRequest extends Error {}

/**
 * G2 review: the one disclosure rule every request meets before it is sent: no text in its state, questions or yes/no
 * questions holds a secret marker word or a value Caret never types (memory/sensitive.ts secretText, the redacted view's
 * rule, fill/redact.ts), neither a whole string nor any text quoted inside
 * one (a candidate's description quotes its label, line and block head as 'text'). The candidate generator, fill and the
 * planner drop such lines and labels where they read them; this is the guarantee behind those filters, so a text one of
 * them misses stops the request loudly instead of reaching Jev. Throws SecretInRequest naming the question, never the
 * text.
 */
export function assertNoSecrets<T extends { state?: unknown; questions?: Record<string, unknown>; nouls?: Record<string, unknown>; input?: unknown }>(req: T): T {
  const check = (where: string, v: unknown): void => {
    if (typeof v === "string") {
      // Caret's own fixed wording passes only where Caret puts it, as a question's criterion; nowhere else, and never in
      // the state, where screen text goes (G2 round 5).
      if (secretText(v) && !(OWN_WORDING.has(v) && /^questions\.[^.]+\.criteria\.[^.]+$/u.test(where))) throw new SecretInRequest(`a Jev request's ${where} holds a secret marker; it was not sent`);
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => check(`${where}[${i}]`, x));
    else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) check(`${where}.${k}`, x);
  };
  check("state", req.state);
  check("questions", req.questions);
  check("nouls", req.nouls ?? {});
  // The writer sends input rather than Jev's state and questions. Check before schema parsing or key access.
  check("input", req.input);
  return req;
}

/**
 * G2 round 4: Caret's own fixed wording a request carries, which may name a kind of secret to say what Caret refuses
 * ("…give a card number, a password, a one-time code…"): assertNoSecrets passes these strings, matched exactly, as a
 * question's criterion and nowhere else. A builder registers its constants once, at load (ownWording).
 */
const OWN_WORDING = new Set<string>();
export function ownWording(...texts: readonly string[]): void {
  for (const t of texts) OWN_WORDING.add(t);
}

/** G2 round 4: a screen text a request names something by (a field, a section, a window), or `instead` when it holds a marker. */
export function sendable(text: string, instead: string): string {
  return secretText(text) ? instead : text;
}
