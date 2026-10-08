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
  scanLine(line: readonly number[]): { readonly marks: Uint8Array; readonly whole: boolean } {
    const n = line.length;
    const diff = new Int32Array(n + 1);
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
      if (len >= RUN_MIN) {
        diff[i - len + 1]!++;
        diff[i + 1]!--;
      }
    }
    const marks = new Uint8Array(n);
    if (n > 0 && len === n) return { marks: marks.fill(1), whole: true };
    let run = 0;
    for (let i = 0; i < n; i++) {
      run += diff[i]!;
      marks[i] = run > 0 ? 1 : 0;
    }
    return { marks, whole: false };
  }
}

/** What the units of `index` reveal of a window. */
export function reveal(index: UnitIndex, inv: LineInventory): Revealed {
  const positions = new Uint8Array(inv.total);
  let charged = 0;
  let prose = 0;
  inv.normalized.forEach((norm, li) => {
    const line = inv.lines[li]!;
    const start = inv.starts[li]!;
    const { marks, whole } = index.scanLine(norm.cps);
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
  });
  return { positions, charged, prose };
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
