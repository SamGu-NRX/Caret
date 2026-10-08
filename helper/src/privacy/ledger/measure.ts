// The output ledger's measurement (OUTPUT-LEDGER-SPEC sections 4, 5 and 10): which source positions of each window a
// request's final measured text reveals, and whether that fits the window's limits.
//
// A position is revealed when it lies in a common run of at least RUN_MIN normalized scalars between a measured unit and
// a source line, or when its whole line, normalized, is contained in a measured unit (any length; no word-boundary
// test, so "Back" inside "Outback" counts). Every occurrence counts and the charge is the union of positions: there is
// no allocation, cap or cheapest placement.
//
// How: one suffix automaton over every measured unit, BOUNDARY between them (and inside a unit at a certified literal).
// Each source line is scanned from the root; at each line position the scan holds the longest suffix ending there that
// occurs in some unit. Every shorter match ending at that position lies inside it, so marking that interval when it is
// at least RUN_MIN long marks every qualifying run, and the line is whole in a unit exactly when the match at its last
// position spans it. Source lines never contain BOUNDARY, so no run crosses a unit or a literal. O(B + S) for B
// measured scalars and S source scalars, up to the transition map's lookups.
import { BOUNDARY, ledgerNormalizeV1, type Normalized } from "./normalize.ts";

/** The coordinator's 2026-10-07 minimum run, a ruling, not a calibrated threshold (OUTPUT-LEDGER-SPEC section 4). */
export const RUN_MIN = 4;

/**
 * MEASUREMENT ONLY (the match-rule comparison, ~/.caret-run/evidence/screen/pv2/match-rule): which rule marks a partial
 * run. A is the spec's (RUN_MIN scalars, no word condition); B, C and D mark source spans aligned to source words (each
 * starts at a word's first scalar and ends at a word's last) of at least 4 scalars, 2 words or 3 words; E is unaligned at
 * 12 scalars. Whole-line containment is the same under every rule. Set by CARET_TEST_LEDGER_RULE; the helper refuses to
 * start with it set (main.ts).
 */
export type MatchRule = "A" | "B" | "C" | "D" | "E";
/**
 * MEASUREMENT ONLY: with CARET_TEST_LEDGER_WORDS=1 under an aligned rule, every single source word whose text occurs in a
 * unit also goes into a second position set per window, held to the same window limits as the main charge; a request
 * needs both to fit (the coordinator's many-single-words option).
 */
export const LEDGER_WORDS_ENV = "CARET_TEST_LEDGER_WORDS";
export const wordSetOn = (): boolean => process.env[LEDGER_WORDS_ENV] === "1";
export const LEDGER_RULE_ENV = "CARET_TEST_LEDGER_RULE";
export function matchRule(): MatchRule {
  const r = process.env[LEDGER_RULE_ENV];
  if (r === undefined || r === "") return "A";
  if (r === "A" || r === "B" || r === "C" || r === "D" || r === "E") return r;
  throw new Error(`${LEDGER_RULE_ENV} must be one of A, B, C, D, E`);
}

/**
 * Words of a normalized source line for the aligned rules: maximal runs of scalars in Unicode categories L, M or N, except
 * that each scalar of a script written without spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar) is a word of
 * its own. Uses the runtime's Unicode properties (17.0 on the development Mac), not the pinned 16.0.0 tables: a
 * measurement-only approximation, flagged in the results.
 */
const WORDISH = /^[\p{L}\p{M}\p{N}]$/u;
const UNSPACED = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]$/u;
const WORDS = new WeakMap<readonly number[], { start: Int32Array; end: Int32Array; wordAt: Int32Array }>();
export function wordsOfLine(line: readonly number[]): { start: Int32Array; end: Int32Array; wordAt: Int32Array } {
  let w = WORDS.get(line);
  if (w !== undefined) return w;
  const starts: number[] = [];
  const ends: number[] = [];
  const wordAt = new Int32Array(line.length).fill(-1);
  let open = false;
  for (let i = 0; i < line.length; i++) {
    const ch = String.fromCodePoint(line[i]!);
    const wordish = WORDISH.test(ch);
    const alone = wordish && UNSPACED.test(ch);
    if (!wordish || alone) {
      if (open) (ends.push(i - 1), (open = false));
      if (alone) (starts.push(i), ends.push(i), (wordAt[i] = starts.length - 1));
      continue;
    }
    if (!open) (starts.push(i), (open = true));
    wordAt[i] = starts.length - 1;
  }
  if (open) ends.push(line.length - 1);
  w = { start: Int32Array.from(starts), end: Int32Array.from(ends), wordAt };
  WORDS.set(line, w);
  return w;
}

/** SC1 constants, as privacy.ts has them: a line over CARD_LINE_CHARS is prose; a card has at most CARD_LINES lines. */
export const CARD_LINE_CHARS = 80;
export const CARD_LINES = 24;
export const WINDOW_CHARS = 1200;
export const CONVERSATION_CHARS = 600;
/** A non-conversation window this large gives WINDOW_CHARS, as privacy.ts windowShare does (2 * WINDOW_CHARS). */
export const LARGE_WINDOW_CHARS = 2 * WINDOW_CHARS;

/** One window's measured inventory: distinct, trimmed, collapsed, nonempty lines (section 1), normalized once. */
export interface LineInventory {
  readonly lines: readonly string[];
  readonly normalized: readonly Normalized[];
  /** Where each line's first code unit sits in the window's position space. */
  readonly starts: readonly number[];
  /** T_w: the code units of all lines. */
  readonly total: number;
  /** L_w: the code units of lines longer than CARD_LINE_CHARS (prose). */
  readonly prose: number;
}

/** A window's inventory from its lines as section 1 collects them (already split, collapsed, trimmed and distinct). */
export function inventoryOf(lines: readonly string[]): LineInventory {
  const starts: number[] = [];
  let total = 0;
  let prose = 0;
  for (const l of lines) {
    if (l === "") throw new Error("inventoryOf: an empty line; section 1 removes them");
    starts.push(total);
    total += l.length;
    if (l.length > CARD_LINE_CHARS) prose += l.length;
  }
  if (new Set(lines).size !== lines.length) throw new Error("inventoryOf: a line twice; section 1 deduplicates exact lines");
  return Object.freeze({ lines: Object.freeze([...lines]), normalized: Object.freeze(lines.map(ledgerNormalizeV1)), starts: Object.freeze(starts), total, prose });
}

/** What one request reveals of one window: the positions (bits over 0..total-1), their count and their prose subset. */
export interface Revealed {
  readonly positions: Uint8Array;
  readonly charged: number;
  readonly prose: number;
  /** MEASUREMENT ONLY (LEDGER_WORDS_ENV): the single matched words' own position set. */
  readonly words?: { readonly positions: Uint8Array; readonly charged: number; readonly prose: number };
}

/** Marks the lines `which` of `inv` by what `index` finds: the shared body of reveal() and UnitProbe.reveal(). */
function revealLines(index: UnitIndex, inv: LineInventory, which: Iterable<number>): Revealed {
  const positions = new Uint8Array(inv.total);
  const wordsOn = wordSetOn();
  const wpos = wordsOn ? new Uint8Array(inv.total) : null;
  let charged = 0;
  let prose = 0;
  let wcharged = 0;
  let wprose = 0;
  for (const li of which) {
    const norm = inv.normalized[li]!;
    const line = inv.lines[li]!;
    const start = inv.starts[li]!;
    const { marks, whole, words } = index.scanLine(norm.cps);
    const mark = (p: number): void => {
      if (positions[start + p] === 1) return;
      positions[start + p] = 1;
      charged++;
      if (line.length > CARD_LINE_CHARS) prose++;
    };
    // A whole-line match marks the whole line, positions trimming dropped included.
    if (whole) for (let p = 0; p < line.length; p++) mark(p);
    else marks.forEach((m, i) => {
      if (m === 1) for (const p of norm.origins[i]!) mark(p);
    });
    if (wpos !== null && words !== null) words.forEach((m, i) => {
      if (m !== 1) return;
      for (const p of norm.origins[i]!) {
        if (wpos[start + p] === 1) continue;
        wpos[start + p] = 1;
        wcharged++;
        if (line.length > CARD_LINE_CHARS) wprose++;
      }
    });
  }
  return wpos === null ? { positions, charged, prose } : { positions, charged, prose, words: { positions: wpos, charged: wcharged, prose: wprose } };
}

/** A suffix automaton over normalized measured units, BOUNDARY between them. */
export class UnitIndex {
  private readonly next: Map<number, number>[] = [new Map()];
  private readonly link: number[] = [-1];
  private readonly len: number[] = [0];
  private last = 0;
  readonly size: number;

  constructor(units: readonly Normalized[]) {
    let first = true;
    let size = 0;
    for (const u of units) {
      if (!first) this.add(BOUNDARY);
      first = false;
      for (const cp of u.cps) this.add(cp);
      size += u.cps.length;
    }
    this.size = size;
  }

  private add(c: number): void {
    const cur = this.len.length;
    this.len.push(this.len[this.last]! + 1);
    this.link.push(-1);
    this.next.push(new Map());
    let p = this.last;
    while (p !== -1 && !this.next[p]!.has(c)) {
      this.next[p]!.set(c, cur);
      p = this.link[p]!;
    }
    if (p === -1) this.link[cur] = 0;
    else {
      const q = this.next[p]!.get(c)!;
      if (this.len[p]! + 1 === this.len[q]) this.link[cur] = q;
      else {
        const clone = this.len.length;
        this.len.push(this.len[p]! + 1);
        this.link.push(this.link[q]!);
        this.next.push(new Map(this.next[q]!));
        while (p !== -1 && this.next[p]!.get(c) === q) {
          this.next[p]!.set(c, clone);
          p = this.link[p]!;
        }
        this.link[q] = clone;
        this.link[cur] = clone;
      }
    }
    this.last = cur;
  }

  /**
   * The revealed normalized positions of one line: for each position, whether a qualifying run covers it; all of them
   * when the whole line is contained in a unit.
   */
  scanLine(line: readonly number[], rule: MatchRule = matchRule()): { readonly marks: Uint8Array; readonly whole: boolean; readonly words: Uint8Array | null } {
    const n = line.length;
    const diff = new Int32Array(n + 1);
    const wdiff = wordSetOn() && (rule === "B" || rule === "C" || rule === "D") ? new Int32Array(n + 1) : null;
    const aligned = rule === "B" || rule === "C" || rule === "D";
    const words = aligned ? wordsOfLine(line) : null;
    const runMin = rule === "E" ? 12 : RUN_MIN;
    let state = 0;
    let len = 0;
    for (let i = 0; i < n; i++) {
      const c = line[i]!;
      while (state !== 0 && !this.next[state]!.has(c)) {
        state = this.link[state]!;
        len = this.len[state]!;
      }
      const to = this.next[state]!.get(c);
      if (to === undefined) {
        state = 0;
        len = 0;
      } else {
        state = to;
        len++;
      }
      if (words !== null) {
        // An aligned span ending here: at the end of a word, from the earliest word start inside the match. Every shorter
        // aligned span ending here lies inside it, and the length conditions grow with the span, so marking this one
        // marks every qualifying span that ends here.
        const w = words.wordAt[i]!;
        if (w < 0 || words.end[w] !== i || len === 0) continue;
        if (wdiff !== null && len >= i - words.start[w]! + 1) {
          wdiff[words.start[w]!]!++;
          wdiff[i + 1]!--;
        }
        const from = i - len + 1;
        let lo = 0;
        let hi = w;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (words.start[mid]! >= from) hi = mid;
          else lo = mid + 1;
        }
        if (words.start[lo]! < from) continue;
        const a = words.start[lo]!;
        const count = w - lo + 1;
        const ok = rule === "B" ? i - a + 1 >= 4 : rule === "C" ? count >= 2 : count >= 3;
        if (ok) {
          diff[a]!++;
          diff[i + 1]!--;
        }
      } else if (len >= runMin) {
        diff[i - len + 1]!++;
        diff[i + 1]!--;
      }
    }
    let wmarks: Uint8Array | null = null;
    if (wdiff !== null) {
      wmarks = new Uint8Array(n);
      let r = 0;
      for (let i = 0; i < n; i++) {
        r += wdiff[i]!;
        wmarks[i] = r > 0 ? 1 : 0;
      }
    }
    const marks = new Uint8Array(n);
    if (n > 0 && len === n) return { marks: marks.fill(1), whole: true, words: wmarks };
    let run = 0;
    for (let i = 0; i < n; i++) {
      run += diff[i]!;
      marks[i] = run > 0 ? 1 : 0;
    }
    return { marks, whole: false, words: wmarks };
  }
}

/** What the units of `index` reveal of a window. */
export function reveal(index: UnitIndex, inv: LineInventory): Revealed {
  return revealLines(index, inv, inv.lines.keys());
}

/** The kind of window, for its limits (section 5). */
export interface WindowClass {
  readonly conversation: boolean;
  readonly consented: boolean;
}

/** A window's limits: characters, and prose where one applies (section 5's table). */
export interface Limits {
  readonly chars: number;
  readonly prose: number | null;
}

/** Whether a window is a card of values: at most CARD_LINES lines, none over CARD_LINE_CHARS. */
export function isCard(inv: LineInventory): boolean {
  return inv.lines.length <= CARD_LINES && inv.prose === 0;
}

/**
 * Section 5. A conversation's limit takes precedence over consent: an explicitly consented conversation still gives at
 * most min(600, floor((T - 1) / 2)). Otherwise a consented window, a card or a window of 2,400 or more gives 1,200; any
 * other window gives min(1200, T - L + H) with prose limit H = floor((L - 1) / 2).
 */
export function limitsOf(inv: LineInventory, c: WindowClass): Limits {
  const t = inv.total;
  const l = inv.prose;
  if (c.conversation) return { chars: Math.min(CONVERSATION_CHARS, Math.max(0, Math.floor((t - 1) / 2))), prose: null };
  if (c.consented || isCard(inv) || t >= LARGE_WINDOW_CHARS) return { chars: WINDOW_CHARS, prose: null };
  const h = Math.max(0, Math.floor((l - 1) / 2));
  return { chars: Math.min(WINDOW_CHARS, t - l + h), prose: h };
}

/** Which bound a reveal breaks, or null when it fits. */
export function overLimits(r: Pick<Revealed, "charged" | "prose">, limits: Limits): "chars" | "prose" | null {
  if (r.charged > limits.chars) return "chars";
  if (limits.prose !== null && r.prose > limits.prose) return "prose";
  return null;
}

// Finding the lines a measurement must scan. A line can be marked only by a common run of RUN_MIN or more scalars, which
// starts with one of the units' RUN_MIN-grams, or by being whole inside a unit; a line of RUN_MIN or more normalized
// scalars that is whole inside a unit shares a RUN_MIN-gram with it too. So the lines worth scanning are those sharing a
// RUN_MIN-gram with a unit, and the shorter lines equal to some stretch of a unit. Scanning only those gives exactly
// reveal()'s answer (test/ledger-core.test.ts holds them equal) without reading every line of every window.

/** A RUN_MIN-gram as a number; two grams may share one, which only adds a line to scan. */
function gramKey(cps: readonly number[], i: number): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < RUN_MIN; k++) h = Math.imul(h ^ cps[i + k]!, 0x01000193);
  return h;
}

const shortKey = (cps: readonly number[], i: number, n: number): string => cps.slice(i, i + n).join(",");

/** A window inventory's lines by their RUN_MIN-grams, and its short lines (under RUN_MIN scalars) by their text. */
interface LineIndex {
  readonly grams: ReadonlyMap<number, readonly number[]>;
  readonly short: ReadonlyMap<string, readonly number[]>;
}

const LINE_INDEX = new WeakMap<LineInventory, LineIndex>();

function lineIndex(inv: LineInventory): LineIndex {
  let ix = LINE_INDEX.get(inv);
  if (ix !== undefined) return ix;
  const grams = new Map<number, number[]>();
  const short = new Map<string, number[]>();
  inv.normalized.forEach((n, li) => {
    const c = n.cps;
    if (c.length === 0) return;
    if (c.length < RUN_MIN) {
      const k = shortKey(c, 0, c.length);
      const at = short.get(k);
      if (at === undefined) short.set(k, [li]);
      else at.push(li);
      return;
    }
    const seen = new Set<number>();
    for (let i = 0; i + RUN_MIN <= c.length; i++) {
      const k = gramKey(c, i);
      if (seen.has(k)) continue;
      seen.add(k);
      const at = grams.get(k);
      if (at === undefined) grams.set(k, [li]);
      else at.push(li);
    }
  });
  ix = { grams, short };
  LINE_INDEX.set(inv, ix);
  return ix;
}

/** Measured units, indexed once for every window a request is measured against. */
export class UnitProbe {
  readonly index: UnitIndex;
  private readonly grams = new Set<number>();
  private readonly shorts = new Set<string>();

  constructor(units: readonly Normalized[]) {
    this.index = new UnitIndex(units);
    for (const u of units) {
      const c = u.cps;
      for (let i = 0; i < c.length; i++) {
        for (let n = 1; n < RUN_MIN && i + n <= c.length; n++) {
          if (c[i + n - 1] === BOUNDARY) break;
          this.shorts.add(shortKey(c, i, n));
        }
        if (i + RUN_MIN > c.length) continue;
        let clean = true;
        for (let k = 0; k < RUN_MIN && clean; k++) clean = c[i + k] !== BOUNDARY;
        if (clean) this.grams.add(gramKey(c, i));
      }
    }
  }

  /** The lines of `inv` the units could mark, in line order. */
  candidates(inv: LineInventory): number[] {
    const rule = matchRule();
    // Rules C and D mark aligned spans of two or three words, which can be shorter than a RUN_MIN-gram: scan every line.
    if (rule === "C" || rule === "D" || wordSetOn()) return inv.lines.map((_, i) => i);
    const ix = lineIndex(inv);
    const out = new Set<number>();
    const [small, large] = this.grams.size <= ix.grams.size ? [this.grams, ix.grams] : [new Set(ix.grams.keys()), null];
    if (large !== null) for (const k of small) for (const li of large.get(k) ?? []) out.add(li);
    else for (const k of small) if (this.grams.has(k)) for (const li of ix.grams.get(k) ?? []) out.add(li);
    for (const [k, lis] of ix.short) if (this.shorts.has(k)) for (const li of lis) out.add(li);
    return [...out].sort((a, b) => a - b);
  }

  /** What the units reveal of `inv`: reveal()'s answer, scanning only the candidate lines. */
  reveal(inv: LineInventory): Revealed {
    return revealLines(this.index, inv, this.candidates(inv));
  }

}
