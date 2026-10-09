// Request builders declare each piece of screen text as a Snippet and charge it to a window's
// SnippetLedger. test/privacy.test.ts checks the declarations and bounds over synthetic sessions.
// PRIVACY_PROMISE discloses the whole-note owner exception; the build gate requires acceptance
// of the fixes backing its switched-off and conversation sentences before this text can ship.
import type { WindowState } from "./model.ts";
import type { Node } from "./protocol.ts";
import { isConversation } from "./conversation.ts";
import { excludedValue } from "./privacy/exclude.ts";

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

/**
 * HA2 recall lever 1: the longest whole note an owner question may show beyond its window's budget and prose share, in
 * characters; 0 turns the lever off. Why it exists: an owner judgement counts only when it saw every note that holds the
 * value whole (fill/note-unit.ts), and a note with a line over CARD_LINE_CHARS never fits a fill on focus's prose share,
 * so its user values were withheld. What it sends: the whole note, as the redacted view shows it, in the owner questions
 * only (the value questions keep the window's budget), charged to the window and declared like any other text; nothing
 * redaction cut, no conversation (it keeps more than half of itself back, as ever), and no window the model does not
 * hold (Sites rules act before the model), is ever sent.
 * Sam approved 2,000 on 2026-10-07, on condition of latency, from an offline measurement of canned right 352 against 353
 * before HA2 (243 with the lever off), wrong 0; with conversations kept out it measured canned right 306, page oracle 132
 * (130 off), reader oracle 122 (120 off), wrong 0 on both oracles and the refuse-mode adversary (evidence/screen/ha2, tag
 * lever1). Live B31 (evidence/screen/ha2/live-cap0, live-cap2000): the owner (fill.whose) requests' p95 went from
 * 385.07 ms to 398.80 ms, +3.6% against a 20% budget; ten requests per run, a small sample. It sends more than the old
 * onboarding promise allowed ("never a whole document"), so ownerNoteGate requires the whole-note disclosure in
 * PRIVACY_PROMISE. The build gate separately requires acceptance of the fixes behind its other privacy claims.
 *
 * TODO(INT1): temporary: re-express on the output-based ledger, then restore 2,000. HA2 built the allotment as a second
 * charge inside the pre-PV2 SnippetLedger's pricing, past the window's budget. PV2's span ledger has no such charge, and
 * INT1 may not add one to its internals while that ledger is being replaced by output-based accounting at seal(). So the
 * allotment is 0 here: an owner note is shown only when it fits its window's own budget and prose share (minted through
 * the Disclosure like any candidate), and a note that does not fit withholds its values (fill.ts NOTE_UNSHOWN).
 */
export const OWNER_NOTE_CHARS = 0;

/** Approved draft 2; the host onboarding owner reuses this text. Required fix acceptances remain separate. */
export const PRIVACY_PROMISE = `What Caret sends

To decide what to offer, Caret sends short pieces of what's on your screen to a cloud model: a field's label, the values that might go in it, and the lines around them. To decide whose details a value is, Caret may send the whole note it came from, if the note is 2,000 characters or shorter. No request carries more than half of a conversation. Before anything leaves your Mac, Caret removes password fields, card numbers, one-time codes and keys, and lines it recognizes as secrets, though it can miss a secret written in ordinary words. It sends nothing from an app or website you've switched off.

Who receives it

Caret's main model is Jev, run by TypeSafe. TypeSafe says Jev isn't trained on customer requests or responses, and its terms say it won't put them in a dataset used to train models without Caret's consent. Its terms set no limit on how long it keeps requests. They let TypeSafe keep using requests, even after you stop using Caret, to monitor for fraud and abuse, and to derive what it calls telemetry: logs, statistics, classifications and "learnings". TypeSafe may use that telemetry without restriction, including to improve its services and other products. We don't know whether TypeSafe staff read requests.

Inline suggestions come from a model hosted by Groq. Groq says it doesn't keep request data by default, except reliability and abuse logs, which it keeps for up to 30 days. It also says it doesn't use your text to train models unless Caret allows it. Groq has a setting that turns those logs off, and we haven't confirmed it's on for Caret's account. We don't know whether Groq staff read requests.`;
/** The approved sentence that discloses whole owner notes when OWNER_NOTE_CHARS is above zero. */
export const OWNER_NOTE_DISCLOSURE: string | null = "To decide whose details a value is, Caret may send the whole note it came from, if the note is 2,000 characters or shorter.";

/**
 * Why the app may not be packaged as configured, or null: OWNER_NOTE_CHARS above 0 needs a promise that discloses the
 * owner note, by OWNER_NOTE_DISCLOSURE's words. The shared build gate also requires acceptance of the fixes
 * behind the conversation and switched-off promises, and refuses shipping the development-only gateway.
 */
export function ownerNoteGate(chars: number = OWNER_NOTE_CHARS, promise: string = PRIVACY_PROMISE, disclosure: string | null = OWNER_NOTE_DISCLOSURE): string | null {
  if (chars <= 0) return null;
  if (disclosure === null || disclosure.trim() === "") return `OWNER_NOTE_CHARS is ${chars}, and OWNER_NOTE_DISCLOSURE names no words of the privacy promise that disclose the owner note`;
  if (!promise.includes(disclosure)) return `OWNER_NOTE_CHARS is ${chars}, and the privacy promise does not include OWNER_NOTE_DISCLOSURE`;
  return null;
}

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
 * Text as the ledger compares it (PV2, the one normalization; lines are already whitespace-collapsed, flat): case
 * folded character by character, so a text and a line compare the same however either is capitalized. Length is kept,
 * so an offset in the folded text is the same offset in the text.
 */
export function fold(s: string): string {
  let out = "";
  for (const c of s) {
    const l = c.toLowerCase();
    out += l.length === c.length ? l : c;
  }
  return out;
}

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
  /**
   * Every line joined by NUL, as written and case-folded (the same offsets), and the folded lines of CONTAINED_MIN or
   * more characters by their first CONTAINED_MIN, with the lines that fold to each; null until locating needs them again.
   */
  private folded: { j: string; f: string; starts: Map<string, Map<number, Map<string, string[]>>> } | null = null;

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
      if (o === n || (o !== undefined && o.label === n.label && o.value === n.value && o.placeholder === n.placeholder && sameTexts(sectionTexts(o), sectionTexts(n)))) continue;
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

  private foldedIndex(): { j: string; f: string; starts: Map<string, Map<number, Map<string, string[]>>> } {
    if (this.folded !== null) return this.folded;
    const lines = [...this.counts.keys()];
    const j = `\u0000${lines.join("\u0000")}\u0000`;
    const starts = new Map<string, Map<number, Map<string, string[]>>>();
    for (const l of lines) {
      if (l.length < CONTAINED_MIN) continue;
      const fl = fold(l);
      const p = fl.slice(0, CONTAINED_MIN);
      let byLen = starts.get(p);
      if (byLen === undefined) starts.set(p, (byLen = new Map()));
      let byText = byLen.get(fl.length);
      if (byText === undefined) byLen.set(fl.length, (byText = new Map()));
      const originals = byText.get(fl);
      if (originals === undefined) byText.set(fl, [l]);
      else originals.push(l);
    }
    this.folded = { j, f: fold(j), starts };
    return this.folded;
  }

  /**
   * PV2, locating: where `t` (flat) stands in the window's lines, compared case-folded: each occurrence's line, as
   * written, and offset, at most MAX_OCCURRENCES of them, in line order.
   */
  find(t: string): { line: string; at: number }[] {
    if (t === "" || t.includes("\u0000")) return [];
    const { j, f } = this.foldedIndex();
    const ft = fold(t);
    // Where it stands as written before where it stands only case aside, and as whole words ("5" as the number 5, not
    // inside "15") before inside a word: the first of these four that has any is where the text was cut from.
    const buckets: { line: string; at: number }[][] = [[], [], [], []];
    const word = /[\p{L}\p{N}]/u;
    let n = 0;
    for (let p = f.indexOf(ft); p >= 0 && n < MAX_OCCURRENCES; p = f.indexOf(ft, p + 1), n++) {
      const start = j.lastIndexOf("\u0000", p) + 1;
      const o = { line: j.slice(start, j.indexOf("\u0000", p)), at: p - start };
      const bounded = !(word.test(ft[0] ?? "") && word.test(f[p - 1] ?? "")) && !(word.test(ft[ft.length - 1] ?? "") && word.test(f[p + ft.length] ?? ""));
      const exact = j.startsWith(t, p);
      (buckets[(exact ? 0 : 2) + (bounded ? 0 : 1)] as { line: string; at: number }[]).push(o);
    }
    return buckets.find((b) => b.length > 0) ?? [];
  }

  /**
   * Every distinct line of CONTAINED_MIN or more characters that `t` holds whole, compared case-folded; each once. A line
   * inside a word counts too ("Back" in "Outback"): a known, conservative over-charge kept because it matches T-M2's
   * containment measure (test/privacy.test.ts); its only cost is recall (the lead's ruling, PV2).
   */
  linesInFolded(t: string): string[] {
    const { starts } = this.foldedIndex();
    const ft = fold(t);
    const out = new Set<string>();
    for (let i = 0; i + CONTAINED_MIN <= ft.length; i++) {
      const byLen = starts.get(ft.slice(i, i + CONTAINED_MIN));
      if (byLen === undefined) continue;
      for (const [len, byText] of byLen) {
        if (i + len > ft.length) continue;
        for (const l of byText.get(ft.slice(i, i + len)) ?? []) out.add(l);
      }
    }
    return [...out];
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
    for (const t of sectionTexts(n)) this.addField(t);
  }

  private removeNode(n: Node): void {
    this.removeField(n.label);
    this.removeField(n.value);
    this.removeField(n.placeholder);
    for (const t of sectionTexts(n)) this.removeField(t);
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
    this.folded = null;
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
    this.folded = null;
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
 * SCP1: a page web area's heading list and section texts (Node.headings, Node.outline), which a section question sends:
 * lines of the window like its labels, so they count toward its budget and prose share and the ledger charges them.
 */
export function sectionTexts(n: Node): string[] {
  if (n.headings === undefined && n.outline === undefined) return [];
  return [...(n.headings ?? []), ...(n.outline ?? []).flatMap((o) => (o.text === undefined ? [] : [o.text]))];
}
const sameTexts = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i]);

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

export interface WindowShare {
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

export function windowShare(w: WindowState): WindowShare {
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
  /** The stretch each unit was charged at. */
  chosen: Span[];
}

/** A stretch of a window's line: the line as the ledger keys it (flat), and where in it. */
export interface Span {
  windowId: string;
  line: string;
  at: number;
  len: number;
}

/** A stretch of some line of a window, its offset and length. */
export interface Place {
  line: string;
  at: number;
  len: number;
}

/** Where one located stretch stands in a window: one of `alts`, marked when it is charged (SnippetLedger.priceUnits). */
export interface Unit {
  windowId: string;
  alts: readonly Place[];
  /**
   * Which repeat of the same stretch this is within one located text (a run its text says twice): the same stretch
   * located again by another rule (a whole line, an occurrence) is the same repeat and charged once; another repeat
   * is charged at another occurrence, as many as there are.
   */
  repeat?: number;
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
  /** Where each text taken from a window stands (locate, locatePlan), by window and text, worked out once per ledger. */
  private readonly located = new Map<string, Unit[] | null>();
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
    this.located.clear();
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
  protected partialRuns(t: string): [string, string[]][] {
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

  protected revealed(t: string): { lines: [string, string[]][]; shownBy: string[] } {
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
   * PV2, the one place a text taken from window `from` is located ("pricing never searches text", the lead's restated
   * invariant): each piece of it (a line of it, or a stretch between a cut's ellipses), flat and compared case-folded,
   * as a stretch of one of the window's lines; or else as runs of its words, each a stretch of one line, with only spaces
   * and punctuation (which reveal nothing) between them. Then where each stretch also stands in every other window's
   * lines, and every line of any window it holds whole (accessibility trees repeat text: B26). Null when a word of the
   * text stands in no line of `from`: the cut fails and nothing is minted. Worked out once per ledger, window and text.
   */
  protected locate(from: WindowState, text: string): Unit[] | null {
    this.know(from);
    const key = `${from.window.windowId}\u0000${text}`;
    const hit = this.located.get(key);
    if (hit !== undefined) return hit;
    const table = windowText(from);
    const fromId = from.window.windowId;
    const units: Unit[] = [];
    const said = new Map<string, number>();
    const add = (run: string, here: readonly { line: string; at: number }[]): void => {
      const repeat = said.get(fold(run)) ?? 0;
      said.set(fold(run), repeat + 1);
      // Every line of any window the stretch holds whole first, so the stretch itself then stands where it is marked.
      for (const [wid, w] of this.known) for (const l of windowText(w).linesInFolded(run)) units.push({ windowId: wid, alts: [{ line: l, at: 0, len: l.length }], repeat });
      // A stretch that is a whole line of the window stands there, not inside a longer line that also shows it.
      const lines = here.filter((o) => o.at === 0 && o.line.length === run.length);
      units.push({ windowId: fromId, alts: (lines.length > 0 ? lines : here).map((o) => ({ line: o.line, at: o.at, len: run.length })), repeat });
      if (run.length < CONTAINED_MIN) return;
      for (const [wid, w] of this.known) {
        if (wid === fromId) continue;
        const there = windowText(w).find(run);
        if (there.length > 0) units.push({ windowId: wid, alts: there.map((o) => ({ line: o.line, at: o.at, len: run.length })), repeat });
      }
    };
    let ok = true;
    for (const raw of text.split("\n")) {
      for (const seg of raw.split("…")) {
        const piece = flat(seg);
        if (piece === "") continue;
        const whole = table.find(piece);
        if (whole.length > 0) {
          add(piece, whole);
          continue;
        }
        const words = [...piece.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ at: m.index, end: m.index + m[0].length }));
        for (let i = 0; i < words.length && ok; ) {
          let took = false;
          for (let k = words.length - 1; k >= i; k--) {
            const run = piece.slice((words[i] as { at: number }).at, (words[k] as { end: number }).end);
            const here = table.find(run);
            if (here.length === 0) continue;
            add(run, here);
            i = k + 1;
            took = true;
            break;
          }
          if (!took) ok = false;
        }
      }
    }
    const out = ok ? units : null;
    this.located.set(key, out);
    return out;
  }

  /**
   * Where plan or memory text stands (it is no window read, and keeps its own rule, SC1 as ruled for PV2): every line of
   * any window it holds whole, every window that shows a piece of it inside a line, and every run of PARTIAL_MIN or more
   * characters of it that a line shows. Worked out once per ledger and text.
   */
  private locatePlan(text: string): Unit[] {
    const key = `\u0000plan\u0000${text}`;
    const hit = this.located.get(key);
    if (hit !== undefined && hit !== null) return hit;
    const units: Unit[] = [];
    const inside = (wid: string, t: string): void => {
      const occ = this.placesOf(wid, t);
      if (occ.length > 0) units.push({ windowId: wid, alts: occ.map((o) => ({ line: o.line, at: o.at, len: t.length })) });
    };
    for (const piece of text.split("\n").map((raw) => flat(raw).replace(/^…|…$/gu, "")).filter((x) => x !== "")) {
      const r = this.revealed(piece);
      for (const [l, ids] of r.lines) for (const wid of ids) units.push({ windowId: wid, alts: [{ line: l, at: 0, len: l.length }] });
      for (const wid of r.shownBy) inside(wid, piece);
      for (const [run, ids] of this.partialRuns(piece)) for (const wid of ids) inside(wid, run);
    }
    this.located.set(key, units);
    return units;
  }

  /**
   * What taking these texts would add, window by window: their located stretches (locate, or locatePlan for plan and
   * memory text), charged by priceUnits. Null when one cannot be located or a window would go over its budget.
   */
  private price(from: WindowState | null, texts: readonly (string | null | undefined)[]): Priced | null {
    const own = from === null ? null : (this.know(from), this.entry(from));
    const fresh = [...new Set(texts.filter((t): t is string => t !== null && t !== undefined && t !== "" && own?.texts.has(t) !== true))];
    const units: Unit[] = [];
    for (const t of fresh) {
      const u = from === null ? this.locatePlan(t) : this.locate(from, t);
      if (u === null) return null;
      units.push(...u);
    }
    return this.priceUnits(units, fresh);
  }

  /**
   * The one charging rule: each unit's stretch is marked in its line (one of its alternatives: one already marked, else
   * one in a line of at most CARD_LINE_CHARS, else the one with most of it marked; a stretch located twice at another
   * occurrence each time), a window charged the characters newly marked, of which those of a line over CARD_LINE_CHARS
   * count against its prose share. Never searches text; never charges a character twice. Null when a window would go
   * over its budget.
   */
  private priceUnits(units: readonly Unit[], fresh: string[]): Priced | null {
    const adds = new Map<string, Add>();
    const chosen: Span[] = [];
    /**
     * The spans chosen so far for each stretch (its window and folded text), by repeat. Units are never skipped: a
     * character marked twice costs nothing the second time, so only span identity decides what is charged. A unit takes
     * the span another unit of the same repeat took (two rules locating one occurrence), and avoids the spans other
     * repeats took (a text that says a stretch twice reveals two occurrences, as many as there are).
     */
    const taken = new Map<string, Map<number, Set<string>>>();
    const id = (o: Place): string => `${o.line}\u0000${o.at}\u0000${o.len}`;
    for (const u of units) {
      const w = this.known.get(u.windowId);
      if (w === undefined || u.alts.length === 0) continue;
      const first = u.alts[0] as Place;
      const cls = `${u.windowId}\u0000${fold(first.line.slice(first.at, first.at + first.len))}`;
      const repeat = u.repeat ?? 0;
      let byRepeat = taken.get(cls);
      if (byRepeat === undefined) taken.set(cls, (byRepeat = new Map()));
      const mine = byRepeat.get(repeat) ?? new Set<string>();
      const others = new Set([...byRepeat].filter(([r]) => r !== repeat).flatMap(([, ids]) => [...ids]));
      const e = this.entry(w);
      let a = adds.get(u.windowId);
      if (a === undefined) adds.set(u.windowId, (a = { cost: 0, prose: 0, covered: new Set(), marks: new Map() }));
      const same = u.alts.filter((o) => mine.has(id(o)));
      const free = u.alts.filter((o) => !others.has(id(o)));
      const alts = same.length > 0 ? same : free.length > 0 ? free : u.alts;
      let best: Place | null = null;
      let bestMarked = -1;
      for (const o of alts) {
        const m = a.marks.get(o.line) ?? e.marks.get(o.line);
        let marked = 0;
        if (m !== undefined) for (let k = o.at; k < o.at + o.len; k++) marked += m[k] as number;
        if (marked === o.len) {
          best = o;
          break;
        }
        const short = o.line.length <= CARD_LINE_CHARS;
        const bestShort = best !== null && best.line.length <= CARD_LINE_CHARS;
        if (best === null || (short && !bestShort) || (short === bestShort && marked > bestMarked)) (best = o, (bestMarked = marked));
      }
      if (best === null) continue;
      mine.add(id(best));
      byRepeat.set(repeat, mine);
      chosen.push({ windowId: u.windowId, ...best });
      let m = a.marks.get(best.line);
      if (m === undefined) {
        const before = e.marks.get(best.line);
        a.marks.set(best.line, (m = before === undefined ? new Uint8Array(best.line.length) : before.slice()));
      }
      let n = 0;
      for (let k = best.at; k < best.at + best.len; k++) if (m[k] === 0) (m[k] = 1, n++);
      a.cost += n;
      if (e.share.prose !== null && best.line.length > CARD_LINE_CHARS) a.prose += n;
      // Declared the first time this stretch's text is revealed in the window, as the ledger always declared a text once.
      const said = best.line.slice(best.at, best.at + best.len);
      if (!e.covered.has(said)) a.covered.add(said);
    }
    // The budget check every path meets: the window's budget, and its prose share, per window, as SC1 defines it (just
    // under half the window's prose, windowShare; not a share per line), whatever revealed the characters.
    for (const [wid, a] of adds) {
      const e = this.entries.get(wid) as Entry;
      if (e.chars + a.cost > e.share.budget) return null;
      if (e.share.prose !== null && e.prose + a.prose > e.share.prose) return null;
    }
    return { fresh, adds, chosen };
  }

  /**
   * `remember`: the texts are cuts of the window, located where they stand, so taking them again costs nothing; false for a
   * derivation, whose text was not located (the same words cut later may stand elsewhere and are located then).
   */
  private commit(p: Priced, windowId: string, kind: Snippet["kind"], own: Entry | null, remember = true): void {
    for (const t of p.fresh) {
      if (remember) own?.texts.add(t);
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

  /**
   * Charges stretches already located (a derivation's, privacy/disclosure.ts Disclosure.derived, read off its bases'
   * located stretches, from the windows `ws`) by the one charging rule, all at once, and declares `text` under the first
   * of them. The stretches charged, or null, charging nothing, when a window would go over its budget or prose share.
   */
  protected takeSpans(ws: readonly WindowState[], spans: readonly Span[], text: string): Span[] | null {
    const w = ws[0];
    if (w === undefined) return [];
    for (const x of ws) this.know(x);
    // Each stretch is its own (two stretches with the same words at two places are both charged), and it reveals what
    // any located text reveals (locate): every line of any window it holds whole, and where it stands in every other
    // window, each window charged its own occurrences against its own budget and share.
    const units: Unit[] = [];
    spans.forEach((x, i) => {
      const t = x.line.slice(x.at, x.at + x.len);
      for (const [wid, win] of this.known) for (const l of windowText(win).linesInFolded(t)) units.push({ windowId: wid, alts: [{ line: l, at: 0, len: l.length }], repeat: i });
      units.push({ windowId: x.windowId, alts: [{ line: x.line, at: x.at, len: x.len }], repeat: i });
      if (t.length < CONTAINED_MIN) return;
      for (const [wid, win] of this.known) {
        if (wid === x.windowId) continue;
        const there = windowText(win).find(t);
        if (there.length > 0) units.push({ windowId: wid, alts: there.map((o) => ({ line: o.line, at: o.at, len: t.length })), repeat: i });
      }
    });
    const p = this.priceUnits(units, [text]);
    if (p === null) return null;
    this.commit(p, w.window.windowId, "candidate", this.entry(w), false);
    return p.chosen;
  }

  /**
   * Charges a text that is not cut from a window: an app's name, reader metadata every window of the app carries, which
   * a window may also show as a whole line of its own. Sending it shows that line, so each window whose line it is is
   * charged that line and declares it; a title that merely mentions the app ("… - Google Chrome") reveals nothing the
   * metadata does not. The lines charged, or null when a window would go over its budget.
   */
  protected takeShown(text: string): Span[] | null {
    const t = flat(text);
    const units: Unit[] = [];
    for (const [wid, w] of this.known) if (windowText(w).isLine(t)) units.push({ windowId: wid, alts: [{ line: t, at: 0, len: t.length }] });
    if (units.length === 0) return [];
    const p = this.priceUnits(units, []);
    if (p === null) return null;
    this.commit(p, "plan", "candidate", null);
    return p.chosen;
  }

  /**
   * Where a piece of text stands in window `w`, located as a cut is (locate's own placement: as written before case
   * aside, whole words before inside a word, a whole line before inside a longer one), charging nothing: a basis's pieces.
   */
  protected placesIn(w: WindowState, piece: string): Place[] {
    this.know(w);
    const here = windowText(w).find(piece);
    const lines = here.filter((o) => o.at === 0 && o.line.length === piece.length);
    return (lines.length > 0 ? lines : here).map((o) => ({ line: o.line, at: o.at, len: piece.length }));
  }

  /** Takes these texts from `w` (located, charged); the stretches they were charged at, or null when they cannot be taken. */
  protected takeLocated(w: WindowState, kind: Snippet["kind"], texts: readonly (string | null | undefined)[]): Span[] | null {
    const p = this.price(w, texts);
    if (p === null) return null;
    this.commit(p, w.window.windowId, kind, this.entry(w));
    return p.chosen;
  }

  take(w: WindowState, kind: Snippet["kind"], texts: readonly (string | null | undefined)[]): boolean {
    return this.takeLocated(w, kind, texts) !== null;
  }

  /** Characters of each line of window `windowId` charged so far, by line: what the request reveals of it. */
  markedLines(windowId: string): Map<string, number> {
    const e = this.entries.get(windowId);
    return new Map([...(e?.marks ?? new Map<string, Uint8Array>())].map(([l, m]) => [l, m.reduce((n, b) => n + b, 0)]));
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
  protected takePlan(texts: readonly string[], windowId: string): Span[] | null {
    const p = this.price(null, texts);
    if (p === null) return null;
    this.commit(p, windowId, "candidate", null);
    return p.chosen;
  }

  plan(texts: readonly string[]): boolean {
    return this.takePlan(texts, "plan") !== null;
  }

  /**
   * Declares a value the user told Caret (a typed About entry, fill/about.ts) under window id "memory".
   * No window shows it, so none is charged for it, except a window whose lines it holds or that shows it
   * inside a line, as for `plan`: sending the value reveals that much of that window. False, declaring
   * nothing, when such a window would go over its budget.
   */
  memory(texts: readonly string[]): boolean {
    return this.takePlan(texts, MEMORY_SNIPPETS) !== null;
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

/** A request held a value in a format Caret never carries (assertNoExcludedValue). */
export class SecretInRequest extends Error {}

/**
 * The client's last line (SC1 section 3, which narrowed G2's assertNoSecrets to formats): no string in a request's
 * state, questions, yes/no questions or writer input holds a value in a format Caret never carries (privacy/exclude.ts
 * excludedValue: a key, a card, account or ID number, a private key, a high-entropy token). It checks formats, not
 * words: what a request may say is settled by its Disclosure, which mints only text a redacted view keeps, and its
 * shape (privacy/disclosure.ts, privacy/shapes.ts). Every such value was withheld when its window was read in and the
 * ledger refuses one, so one here is a bug: it throws SecretInRequest naming the path and the format, never the text.
 */
export function assertNoExcludedValue<T extends { state?: unknown; questions?: Record<string, unknown>; nouls?: Record<string, unknown>; input?: unknown }>(req: T): T {
  const check = (where: string, v: unknown): void => {
    if (typeof v === "string") {
      const kind = excludedValue(v);
      if (kind !== null) throw new SecretInRequest(`a request's ${where} holds a value shaped like a ${kind}; it was not sent`);
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
