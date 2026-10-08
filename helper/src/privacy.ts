// Request builders declare each piece of screen text as a Snippet and take it through a window's SnippetLedger, which
// refuses early what the output ledger (privacy/ledger/) would refuse at seal. test/privacy.test.ts checks the
// declarations and bounds over synthetic sessions.
// PRIVACY_PROMISE discloses the whole-note owner exception; the build gate requires acceptance
// of the fixes backing its switched-off and conversation sentences before this text can ship.
import type { WindowState } from "./model.ts";
import type { Node } from "./protocol.ts";
import { excludedValue } from "./privacy/exclude.ts";
import { isRedacted, redactWindow } from "./fill/redact.ts";
import { heldAsConversation, measuredWindows, MintAccount, sectionTexts, viewInventory, type DeclaredSpans, type Measurement, type MeasuredWindow, type ScreenRegistry } from "./privacy/ledger/account.ts";
import { CONVERSATION_CHARS, limitOf, spanKey, WINDOW_CHARS, type DeclaredSpan } from "./privacy/ledger/measure.ts";

export { CONVERSATION_CHARS, WINDOW_CHARS };
/** The longest screen line the pending and first-look questions quote, cut with an ellipsis past it. */
export const SNIPPET_CHARS = 120;

/**
 * HA2 recall lever 1: the owner-note allotment, in characters of a window's own whole notes (OUTPUT-LEDGER-SPEC section
 * 8); 0 turns it off. Why it exists: an owner judgement counts only when it saw every note that holds the value whole
 * (fill/note-unit.ts), so the user values of a note longer than its window's limit would be withheld. What it lets a
 * request send: whole notes of at most this many characters, as the redacted view shows them, only where they stand
 * whole in an owner question's state.source_notes, held together per window and per fill to this allotment instead of
 * the window's limit; everything else in the request is held to the window's limit, and every other window measures
 * the notes like any text. No conversation's note is eligible (it keeps more than half of itself back, as ever).
 * Sam approved 2,000 on 2026-10-07, on condition of latency, from an offline measurement of canned right 352 against 353
 * before HA2 (243 with the lever off), wrong 0; with conversations kept out it measured canned right 306, page oracle 132
 * (130 off), reader oracle 122 (120 off), wrong 0 on both oracles and the refuse-mode adversary (evidence/screen/ha2, tag
 * lever1). Live B31 (evidence/screen/ha2/live-cap0, live-cap2000): the owner (fill.whose) requests' p95 went from
 * 385.07 ms to 398.80 ms, +3.6% against a 20% budget; ten requests per run, a small sample. Those were measured on the
 * pre-PV2 ledger. On the output ledger the scripted oracle and the adversary measure the same with it at 0 and at 2,000
 * (evidence/screen/pv2/simplify, e-part and s8-off): what it recovered there, the prose share held back, and the
 * oracle's losses are conversations, which it does not cover. Its latency is unmeasured here. It sends more than the old
 * onboarding promise allowed ("never a whole document"), so ownerNoteGate requires the whole-note disclosure in
 * PRIVACY_PROMISE. The build gate separately requires acceptance of the fixes behind its other privacy claims.
 */
export const OWNER_NOTE_CHARS = 2000;

/** Approved draft 2; the host onboarding owner reuses this text. Required fix acceptances remain separate. */
export const PRIVACY_PROMISE = `What Caret sends

To decide what to offer, Caret sends a cloud model what you type to it and short pieces of what's on your screen: a field's label, the values that might go in it, and the lines around them. To decide whose details a value is, Caret may send the whole note it came from, if the note is 2,000 characters or shorter. No request takes more than half of any one conversation. Before anything leaves your Mac, Caret removes password fields, card numbers, one-time codes and keys, and lines it recognizes as secrets, though it can miss a secret written in ordinary words. It sends nothing from an app or website you've switched off.

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
}

/** Collapses whitespace as every request builder does before it quotes a line. */
/** Whitespace flat() would change: a run, a tab or line break, or space at either end. Testing first spares the copy for most lines. */
const UNCLEAN = /\s\s|[^\S ]|^\s|\s$/;
export const flat = (s: string): string => (UNCLEAN.test(s) ? s.replace(/\s+/g, " ").trim() : s);

/** A line cut to SNIPPET_CHARS, ellipsis included. */
export function cut(s: string, max = SNIPPET_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Lines shorter than this are not looked for inside a text when locating it: a letter or two is in most texts. */
const CONTAINED_MIN = 3;

/**
 * Text compared case aside, character by character, for locating a cut in its window (SnippetLedger.locatable). Length
 * is kept, so an offset in the folded text is the same offset in the text. Charging does not use it: the output
 * ledger's one normalization is privacy/ledger/normalize.ts ledgerNormalizeV1.
 */
export function fold(s: string): string {
  let out = "";
  for (const c of s) {
    const l = c.toLowerCase();
    out += l.length === c.length ? l : c;
  }
  return out;
}

export { sectionTexts, setConversationCap, heldAsConversation } from "./privacy/ledger/account.ts";

/**
 * A window's text as the eligibility checks read it: its distinct lines, and an index of them for finding where a text
 * a builder cuts stands (SnippetLedger.locatable) and which lines a plan's text quotes (revealed, partialRuns, for
 * Disclosure.keptByViews). These decide whether a text may be minted at all; none of them charges anything. What a
 * request is charged is the output ledger's (privacy/ledger/account.ts), measured on what it says.
 *
 * A window's text is its title and every line of its nodes' labels, values, placeholders and section texts, each
 * distinct line counted once. Reading a window of 5,000 lines from scratch and searching it took a ledger's first take
 * 15 to 20 ms on eight such windows (B14 bench, ~/.caret-run/evidence/screen/b14). So one table follows each window id
 * from snapshot to snapshot, changing only the lines of nodes whose text differs; asking about an earlier state (a
 * task's kept source window) moves it back the same way, so every answer is about the state asked.
 */
class LineTable {
  owner: WindowState;
  /** Each distinct line, and how many of the title's and the nodes' lines read it. */
  private readonly counts = new Map<string, number>();
  /** Distinct lines of CONTAINED_MIN or more characters by their first CONTAINED_MIN: their lengths, each with how many lines have it. */
  private readonly starts = new Map<string, Map<number, number>>();
  /** Texts asked about, and whether a line of the window holds them; kept right as lines come and go. */
  private readonly inside = new Map<string, boolean>();
  /** The lines of CONTAINED_MIN or more characters joined by NUL, which no screen text holds; null until a search needs it again. */
  private joined: string | null = null;
  /** Every line joined by NUL, as written and case-folded (the same offsets); null until locating needs it again. */
  private folded: { j: string; f: string } | null = null;

  constructor(w: WindowState) {
    this.owner = w;
    this.addField(w.window.title);
    for (const n of w.nodes.values()) this.addNode(n);
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

  /** Whether `t` (flat) stands in some line of the window, compared case-folded. */
  find(t: string): boolean {
    if (t === "" || t.includes("\u0000")) return false;
    if (this.folded === null) {
      const j = `\u0000${[...this.counts.keys()].join("\u0000")}\u0000`;
      this.folded = { j, f: fold(j) };
    }
    return this.folded.f.includes(fold(t));
  }

  /**
   * The runs of `t`, each PARTIAL_MIN or more characters long, that a line of the window also shows: what a text
   * quoting part of a line shows of it ("Copy this: " and a sentence's first hundred characters). Each run is the
   * longest stretch of `t` from its start that one line shows. Runs from two lines may overlap in `t`.
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
      // A run inside one already found shows nothing more of this window.
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

const sameTexts = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * Shortest stretch of a plan's text that counts as quoting part of a window's line (sharedRuns), for the eligibility
 * check only. Assumed: long enough that common words do not match by chance, short enough to catch a quoted phrase.
 */
const PARTIAL_MIN = 16;
/** Texts each window's table remembers asking about. Assumed. */
const INSIDE_CACHE = 4096;
/** Occurrences of a PARTIAL_MIN-gram sharedRuns extends before it stops looking. Assumed; eligibility only. */
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
 * Brings the window's line table up to this state. The helper calls it as each snapshot arrives, so a window is read
 * from scratch once, when it first arrives, and after that only its changed nodes are.
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

const viewOf = (w: WindowState): WindowState => (isRedacted(w) ? w : redactWindow(w));

/**
 * The characters a request may reveal of this window (OUTPUT-LEDGER-SPEC section 5): a conversation under half its
 * text and at most CONVERSATION_CHARS, any other window WINDOW_CHARS.
 */
export function windowBudget(w: WindowState): number {
  return limitOf(viewInventory(viewOf(w)), heldAsConversation(w));
}

const EMPTY_REGISTRY: ScreenRegistry = { windows: new Map() };

/** Declared spans grouped by the view they were read from (privacy/ledger/account.ts DeclaredSpans), each once. */
export function spansOf(spans: Iterable<ViewSpan>): DeclaredSpans {
  const out = new Map<WindowState, DeclaredSpan[]>();
  for (const { view, ...span } of spans) {
    const l = out.get(view);
    if (l === undefined) out.set(view, [span]);
    else if (!l.some((x) => spanKey(x) === spanKey(span))) l.push(span);
  }
  return out;
}

/** A declared span with the redacted view it was read from. */
export type ViewSpan = DeclaredSpan & { readonly view: WindowState };

/**
 * The screen text one request takes, window by window, and what taking it would charge (OUTPUT-LEDGER-SPEC, the output
 * ledger). Two jobs, kept apart:
 * - eligibility: a text cut from a window must stand in it (locatable), and a plan's text may not quote a line a
 *   redacted view removed (revealed, partialRuns, used by Disclosure.keptByViews). These read the window's lines.
 * - accounting: what a text reveals is the output ledger's measure of that text against every window the registry
 *   knows and every older snapshot the ledger holds (privacy/ledger/account.ts MintAccount), the union of positions per
 *   window held to its limits. Here it is an early refusal while a request is built, so a builder drops one optional
 *   text instead of having the whole request refused. What is sent, and what each window is charged, is decided again
 *   at seal (privacy/send.ts) on the request's final bytes; nothing here authorizes a send.
 *
 * The registry is the screen model (Disclosure takes it). With none, the ledger can still mint Caret's own words, but
 * every seal refuses: nothing can be measured.
 */
export class SnippetLedger {
  protected readonly known = new Map<string, WindowState>();
  /** Window states this ledger was handed or minted from: measured too, as retained revisions, when the registry has moved on. */
  protected readonly heldStates = new Set<WindowState>();
  protected readonly registry: ScreenRegistry | null;
  /** What each text reveals of the windows' lines, for eligibility: the lines it holds, and the windows that show it inside a line. */
  private readonly reveals = new Map<string, { lines: [string, string[]][]; shownBy: string[] }>();
  /** For plan text: the runs of it each window's lines show (LineTable.sharedRuns), for eligibility. */
  private readonly partials = new Map<string, [string, string[]][]>();
  /** Texts each window already took, so a take declares a text once. */
  private readonly taken = new Map<string, Set<string>>();
  private readonly account: MintAccount;
  /** Declared spans the early check has charged, by view: charging one again adds nothing. */
  private readonly spanned = new WeakMap<WindowState, Set<string>>();
  readonly snippets: Snippet[] = [];

  /**
   * `registry`: the screen model, every window whose lines a request's text could reveal. `snapshots`: older states a
   * builder holds (a task's kept source window), measured as well.
   */
  constructor(registry: ScreenRegistry | null, o: { snapshots?: Iterable<WindowState> } = {}) {
    this.registry = registry;
    for (const w of registry?.windows.values() ?? []) this.known.set(w.window.windowId, w);
    for (const w of o.snapshots ?? []) this.know(w);
    this.account = new MintAccount(() => this.measuredWindows(), OWNER_NOTE_CHARS);
  }

  /** Every window state this request is measured against (privacy/ledger/account.ts measuredWindows). */
  measuredWindows(): MeasuredWindow[] {
    return measuredWindows(this.registry ?? EMPTY_REGISTRY, this.heldStates);
  }

  /** A window a take names: known from then on, and held, so the seal measures that state too. */
  protected know(w: WindowState): void {
    this.heldStates.add(w);
    if (this.known.has(w.window.windowId)) return;
    this.known.set(w.window.windowId, w);
    this.reveals.clear();
    this.partials.clear();
  }

  /**
   * The runs of a plan's text that windows' lines show, with the windows: a text that quotes part of a line, not the
   * whole line, shows that part of it. A run inside a whole line the text holds is that line's. Eligibility only.
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

  /** The lines of known windows that `t` holds, with their windows, and the windows that show `t` inside a line. Eligibility only. */
  protected revealed(t: string): { lines: [string, string[]][]; shownBy: string[] } {
    let r = this.reveals.get(t);
    if (r !== undefined) return r;
    const shownBy: string[] = [];
    const lines = new Map<string, string[]>();
    const found = new Set<string>();
    for (const [wid, w] of this.known) {
      const table = windowText(w);
      if (t.length >= CONTAINED_MIN && table.holds(t)) shownBy.push(wid);
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
   * Whether `text` stands in window `from`: each piece of it (a line of it, or a stretch between a cut's ellipses), flat
   * and compared case-folded, in one of the window's lines, or else as runs of its words each in one line, with only
   * spaces and punctuation between them. A text a builder says it cut from a window and that the window does not show
   * is not taken.
   */
  protected locatable(from: WindowState, text: string): boolean {
    const table = windowText(from);
    for (const raw of text.split("\n")) {
      for (const seg of raw.split("…")) {
        const piece = flat(seg);
        if (piece === "" || table.find(piece)) continue;
        const words = [...piece.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ at: m.index, end: m.index + m[0].length }));
        for (let i = 0; i < words.length; ) {
          let took = false;
          for (let k = words.length - 1; k >= i; k--) {
            if (!table.find(piece.slice((words[i] as { at: number }).at, (words[k] as { end: number }).end))) continue;
            i = k + 1;
            took = true;
            break;
          }
          if (!took) return false;
        }
      }
    }
    return true;
  }

  /**
   * Admits texts into the early check (MintAccount): false, keeping nothing, when a window would break a bound or a text
   * holds a value in a format Caret never carries. `as` declares them: each text under `as.under` (none when it is
   * null), and with `as.lines` each window line they newly show under its own window (text no window gave: a plan's, an
   * app's name, the user's, which names every window whose line it carries).
   */
  protected admitTexts(texts: readonly string[], as: { under: string | null; kind: Snippet["kind"]; lines?: boolean; noteOf?: WindowState; spans?: readonly ViewSpan[] }): boolean {
    const set = as.under === null ? undefined : this.taken.get(as.under);
    const fresh = [...new Set(texts.filter((t) => t !== "" && set?.has(t) !== true))];
    if (fresh.some((t) => excludedValue(t) !== null)) return false;
    // A text taken before (by take, with no span) may be minted now with its span: the span is charged all the same.
    // A span's window state is measured until the operation ends, refreshed or not (measuredWindows' retained states).
    for (const sp of as.spans ?? []) this.heldStates.add(sp.view);
    const spans = (as.spans ?? []).filter((sp) => !this.spanned.get(sp.view)?.has(spanKey(sp)));
    if (fresh.length === 0 && spans.length === 0) return true;
    const noteOf = as.noteOf;
    const adds = this.account.admit(fresh, true, noteOf === undefined ? undefined : new Map(fresh.map((t) => [t, noteOf])), spansOf(spans));
    if (adds === null) return false;
    for (const sp of spans) {
      let set = this.spanned.get(sp.view);
      if (set === undefined) this.spanned.set(sp.view, (set = new Set()));
      set.add(spanKey(sp));
    }
    if (as.under !== null) {
      let s = this.taken.get(as.under);
      if (s === undefined) this.taken.set(as.under, (s = new Set()));
      for (const t of fresh) {
        s.add(t);
        this.snippets.push({ windowId: as.under, kind: as.kind, text: t });
      }
    }
    // The lines it newly shows, as declared screen text: only those the texts carry. A fallback span charges a whole line
    // the text only quotes part of, and the request does not send the rest of it.
    if (as.lines === true) {
      const said = fresh.map((t) => t.toLowerCase());
      for (const [key, a] of adds) for (const l of a.lines) if (said.some((t) => t.includes(l.toLowerCase()))) this.snippets.push({ windowId: key, kind: "candidate", text: l });
    }
    return true;
  }

  /** Takes texts cut from `w`: each must stand in it (locatable); admitted by the early check, or false. */
  take(w: WindowState, kind: Snippet["kind"], texts: readonly (string | null | undefined)[]): boolean {
    this.know(w);
    const ts = texts.filter((t): t is string => typeof t === "string" && t !== "");
    if (!ts.every((t) => this.locatable(w, t))) return false;
    return this.admitTexts(ts, { under: w.window.windowId, kind });
  }

  /**
   * Section 8: whether `text`, read whole from the redacted view `w`, may go as an owner note, against the window's
   * owner-note allotment rather than its limit: the allotment is on, the note fits it, and the window is no conversation.
   */
  protected ownerNoteFits(w: WindowState, text: string): boolean {
    return OWNER_NOTE_CHARS > 0 && text.length <= OWNER_NOTE_CHARS && !heldAsConversation(this.known.get(w.window.windowId) ?? w);
  }

  /**
   * Whether every owner note could be taken from its window together (each locatable there, and all of them within
   * every window's limit and allotment at once). Takes nothing: a caller that needs all or none checks here first.
   */
  notesFit(takes: readonly { w: WindowState; text: string }[]): boolean {
    for (const t of takes) this.know(t.w);
    if (takes.some((t) => excludedValue(t.text) !== null || !this.locatable(t.w, t.text))) return false;
    const notes = new Map(takes.flatMap((t) => (this.ownerNoteFits(t.w, t.text) ? [[t.text, t.w] as const] : [])));
    return this.account.admit(takes.map((t) => t.text), false, notes) !== null;
  }

  /** What taking these texts from `w` would add to `w`'s charge, or null when they cannot be taken. Takes nothing. */
  cost(w: WindowState, texts: readonly (string | null | undefined)[]): number | null {
    this.know(w);
    const ts = texts.filter((t): t is string => typeof t === "string" && t !== "");
    if (ts.some((t) => excludedValue(t) !== null) || !ts.every((t) => this.locatable(w, t))) return null;
    const adds = this.account.admit(ts, false);
    if (adds === null) return null;
    return adds.get(w.window.windowId)?.added ?? 0;
  }

  /**
   * Declares text a request carries that a plan wrote rather than a window shows, under window id "plan", and each window
   * line it shows under that window; false, declaring nothing, when a window would break a bound.
   */
  plan(texts: readonly string[]): boolean {
    return this.admitTexts(texts, { under: "plan", kind: "candidate", lines: true });
  }

  /** Declares a value the user told Caret under window id "memory", charged as plan text is. */
  memory(texts: readonly string[]): boolean {
    return this.admitTexts(texts, { under: MEMORY_SNIPPETS, kind: "candidate", lines: true });
  }

  /**
   * The lexical charge of wording a builder will send around its values (its question templates), kept by the early
   * check before any value is admitted: a short line of a chat that the wording happens to hold ("You" in "can you not
   * tell") is charged at seal, and values admitted up to the limit without it lost the whole request there.
   */
  reserveWording(texts: readonly string[]): void {
    this.account.reserve(texts);
  }

  /**
   * Keeps a committed seal's positions in the early check (MintAccount.absorb), and every window state it charged among
   * the states measured until the operation ends, so a snapshot refresh cannot drop what was charged there.
   */
  protected absorbSeal(m: Measurement): void {
    this.account.absorb(m);
    for (const { view } of m.positions.values()) this.heldStates.add(view);
  }

  /** Characters charged to each window so far by the early check, by window key. The seal's charge replaces it. */
  charges(): Record<string, number> {
    return this.account.charges();
  }

  /** What a request built from this ledger declares: its screen text and what each window was charged. */
  declared(): Declared {
    return { snippets: this.snippets, charged: this.charges() };
  }

  /** Characters taken from a window so far. */
  chars(windowId: string): number {
    return this.charges()[windowId] ?? 0;
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
