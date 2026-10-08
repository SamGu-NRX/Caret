// The output ledger's measurement (OUTPUT-LEDGER-SPEC sections 4, 5 and 10): which source positions of each window a
// request's final measured text reveals, and whether that fits the window's limit.
//
// A position is revealed when it lies in a common run of at least RUN_MIN normalized scalars between a measured unit and
// a source line, or when its whole line, normalized, is contained in a measured unit (any length; no word-boundary
// test, so "Back" inside "Outback" counts). Every occurrence counts and the charge is the union of positions: there is
// no allocation, cap or cheapest placement.
//
// How: one suffix automaton over every measured unit, BOUNDARY between them. Each source line is scanned from the root;
// at each line position the scan holds the longest suffix ending there that occurs in some unit. Every shorter match
// ending at that position lies inside it, so marking that interval when it is at least RUN_MIN long marks every
// qualifying run, and the line is whole in a unit exactly when the match at its last position spans it. Source lines
// never contain BOUNDARY, so no run crosses a unit. O(B + S) for B measured scalars and S source scalars, up to the
// transition map's lookups.
import { BOUNDARY, ledgerNormalizeV1, type Normalized } from "./normalize.ts";

/**
 * The shortest run that counts, in normalized scalars: the lead's 2026-10-08 ruling, chosen on the scripted corpus
 * (evidence/screen/pv2/match-rule), not calibrated. At four, coincidental English ("the in", "ction") refused every Ask
 * there.
 */
export const RUN_MIN = 12;
/**
 * Characters one request may reveal of a window that is no conversation. The bound comes from the question shapes: the
 * pending question shows Jev at most 4 marker lines and 6 changed lines of 120 characters, which is 1,200. The fill
 * question's densest source window in the synthetic calibration recordings (~/.caret-run/evidence/screen/
 * fill-distractors-v2, 21 recordings) gives 589 distinct characters over 21 candidates, so 1,200 leaves twice that
 * before a window's values are cut.
 */
export const WINDOW_CHARS = 1200;
/**
 * Characters one request may reveal of a conversation, which also always keeps more than half of its text back, however
 * short it is: a conversation is what people mean by private. 600 is half of WINDOW_CHARS and is assumed, not measured.
 */
export const CONVERSATION_CHARS = 600;

/** One window's measured inventory: distinct, trimmed, collapsed, nonempty lines (section 1), normalized once. */
export interface LineInventory {
  readonly lines: readonly string[];
  readonly normalized: readonly Normalized[];
  /** Where each line's first code unit sits in the window's position space. */
  readonly starts: readonly number[];
  /** T_w: the code units of all lines. */
  readonly total: number;
}

/** A window's inventory from its lines as section 1 collects them (already split, collapsed, trimmed and distinct). */
export function inventoryOf(lines: readonly string[]): LineInventory {
  if (new Set(lines).size !== lines.length) throw new Error("inventoryOf: a line twice; section 1 deduplicates exact lines");
  const starts: number[] = [];
  let total = 0;
  for (const l of lines) {
    if (l === "") throw new Error("inventoryOf: an empty line; section 1 removes them");
    starts.push(total);
    total += l.length;
  }
  return Object.freeze({ lines: Object.freeze([...lines]), normalized: Object.freeze(lines.map(ledgerNormalizeV1)), starts: Object.freeze(starts), total });
}

/** What one request reveals of one window: the positions (bits over 0..total-1) and their count. */
export interface Revealed {
  readonly positions: Uint8Array;
  readonly charged: number;
}

/**
 * Section 5: what one request may reveal of a window. A conversation gives under half its text, at most 600 characters;
 * any other window gives 1200.
 */
export function limitOf(inv: LineInventory, conversation: boolean): number {
  return conversation ? Math.min(CONVERSATION_CHARS, Math.max(0, Math.floor((inv.total - 1) / 2))) : WINDOW_CHARS;
}

/** A suffix automaton over normalized measured units, BOUNDARY between them. */
export class UnitIndex {
  private readonly next: Map<number, number>[] = [new Map()];
  private readonly link: number[] = [-1];
  private readonly len: number[] = [0];
  private last = 0;

  constructor(units: readonly Normalized[]) {
    let first = true;
    for (const u of units) {
      if (!first) this.add(BOUNDARY);
      first = false;
      for (const cp of u.cps) this.add(cp);
    }
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

  /** For each normalized position of one line, whether a qualifying run covers it; all of them when the line is whole in a unit. */
  scanLine(line: readonly number[]): Uint8Array {
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
    if (n > 0 && len === n) return marks.fill(1);
    let run = 0;
    for (let i = 0; i < n; i++) {
      run += diff[i]!;
      marks[i] = run > 0 ? 1 : 0;
    }
    return marks;
  }
}

/** Marks the lines `which` of `inv` by what `index` finds. A whole line marks every code unit of it, trimmed ones too. */
function revealLines(index: UnitIndex, inv: LineInventory, which: Iterable<number>): Revealed {
  const positions = new Uint8Array(inv.total);
  let charged = 0;
  for (const li of which) {
    const norm = inv.normalized[li]!;
    const start = inv.starts[li]!;
    const marks = index.scanLine(norm.cps);
    const mark = (p: number): void => {
      if (positions[start + p] === 1) return;
      positions[start + p] = 1;
      charged++;
    };
    if (marks.length > 0 && marks.every((m) => m === 1)) for (let p = 0; p < inv.lines[li]!.length; p++) mark(p);
    else marks.forEach((m, i) => {
      if (m === 1) for (const p of norm.origins[i]!) mark(p);
    });
  }
  return { positions, charged };
}

/** What the units of `index` reveal of a window, every line scanned. */
export function reveal(index: UnitIndex, inv: LineInventory): Revealed {
  return revealLines(index, inv, inv.lines.keys());
}

// Finding the lines a measurement must scan. A line can be marked only by a common run of RUN_MIN or more scalars, which
// starts with one of the units' RUN_MIN-grams, or by being whole inside a unit, which a line of RUN_MIN or more scalars
// can be only if it shares a RUN_MIN-gram with it. So scanning the lines that share a RUN_MIN-gram with a unit, and every
// shorter line, gives exactly reveal()'s answer (test/ledger-core.test.ts holds them equal).

/** A RUN_MIN-gram as a number; two grams may share one, which only adds a line to scan. */
function gramKey(cps: readonly number[], i: number): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < RUN_MIN; k++) h = Math.imul(h ^ cps[i + k]!, 0x01000193);
  return h;
}

/** A window inventory's lines by their RUN_MIN-grams, and its lines shorter than that. */
const LINE_INDEX = new WeakMap<LineInventory, { grams: ReadonlyMap<number, readonly number[]>; short: readonly number[] }>();

function lineIndex(inv: LineInventory): { grams: ReadonlyMap<number, readonly number[]>; short: readonly number[] } {
  let ix = LINE_INDEX.get(inv);
  if (ix !== undefined) return ix;
  const grams = new Map<number, number[]>();
  const short: number[] = [];
  inv.normalized.forEach((n, li) => {
    const c = n.cps;
    if (c.length < RUN_MIN) return void short.push(li);
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
  private readonly index: UnitIndex;
  private readonly grams = new Set<number>();

  constructor(units: readonly Normalized[]) {
    this.index = new UnitIndex(units);
    for (const u of units) {
      const c = u.cps;
      for (let i = 0; i + RUN_MIN <= c.length; i++) this.grams.add(gramKey(c, i));
    }
  }

  /** What the units reveal of `inv`: reveal()'s answer, scanning only the lines they could mark. */
  reveal(inv: LineInventory): Revealed {
    const ix = lineIndex(inv);
    const which = new Set<number>(ix.short);
    for (const k of this.grams) for (const li of ix.grams.get(k) ?? []) which.add(li);
    return revealLines(this.index, inv, [...which].sort((a, b) => a - b));
  }
}
