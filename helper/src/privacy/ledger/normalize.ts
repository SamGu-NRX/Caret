// The output ledger's one normalizer (OUTPUT-LEDGER-SPEC section 2). Production measurement and the independent
// reference both call this module and nothing else to decide what matches: neither adds its own lowercasing, boundary
// preference or whitespace handling.
//
// Each Unicode scalar is mapped on its own, by the Unicode 16.0.0 table in unicode16.ts (NFKD, full case folding C+F,
// NFKD, White_Space to space); the results are concatenated, runs of spaces collapse to one and the ends are trimmed.
// Nothing is composed or reordered across the original scalars, so this is not whole-string NFKC. Punctuation stays
// (U+2026 becomes three periods); accents, default-ignorable and zero-width characters stay.
//
// Every normalized scalar keeps the UTF-16 positions of the source text that produced it (its origin), so a charge is
// counted in source code units: a supplementary character's scalars map to both of its code units, and a collapsed
// space maps to every position that contributed to the run. Positions dropped by trimming produce no scalar.

import { SCALAR_MAP, UNICODE_VERSION } from "./unicode16.ts";

export const LEDGER_NORMALIZATION = `ledgerNormalizeV1/unicode-${UNICODE_VERSION}`;

/** The token between measured units in an index: outside the scalar range, so no text, a NUL included, can equal it. */
export const BOUNDARY = -1;

/** Text the ledger will not measure: an unpaired surrogate (or, at the byte layer, malformed UTF-8). */
export class LedgerEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerEncodingError";
  }
}

const TABLE: ReadonlyMap<number, readonly number[]> = (() => {
  const m = new Map<number, readonly number[]>();
  for (const e of SCALAR_MAP.split(";")) {
    if (e === "") continue;
    const [from, to] = e.split(":") as [string, string];
    m.set(Number.parseInt(from, 16), Object.freeze(to.split(" ").map((x) => Number.parseInt(x, 16))));
  }
  return m;
})();

// Hangul syllables decompose arithmetically (The Unicode Standard, 3.12); their jamo neither fold nor decompose further.
const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const T_COUNT = 28;
const N_COUNT = 588;
const S_COUNT = 11172;

/** What one scalar maps to, on its own. */
function scalarMap(cp: number): readonly number[] {
  const s = cp - S_BASE;
  if (s >= 0 && s < S_COUNT) {
    const l = L_BASE + Math.floor(s / N_COUNT);
    const v = V_BASE + Math.floor((s % N_COUNT) / T_COUNT);
    const t = T_BASE + (s % T_COUNT);
    return t === T_BASE ? [l, v] : [l, v, t];
  }
  return TABLE.get(cp) ?? [cp];
}

const SPACE = 0x20;

/** A normalized text: its scalars, and for each the source UTF-16 positions it came from. */
export interface Normalized {
  readonly cps: readonly number[];
  readonly origins: readonly (readonly number[])[];
}

/** ledgerNormalizeV1 of one source line or one measured unit. Throws LedgerEncodingError on an unpaired surrogate. */
export function ledgerNormalizeV1(text: string): Normalized {
  const cps: number[] = [];
  const origins: number[][] = [];
  for (let i = 0; i < text.length; i++) {
    const hi = text.charCodeAt(i);
    let cp = hi;
    let at = [i];
    if (hi >= 0xd800 && hi <= 0xdbff) {
      const lo = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (lo < 0xdc00 || lo > 0xdfff) throw new LedgerEncodingError(`an unpaired surrogate at UTF-16 position ${i}`);
      cp = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
      at = [i, i + 1];
      i++;
    } else if (hi >= 0xdc00 && hi <= 0xdfff) {
      throw new LedgerEncodingError(`an unpaired surrogate at UTF-16 position ${i}`);
    }
    for (const out of scalarMap(cp)) {
      if (out === SPACE) {
        // Leading spaces are trimmed; a run of spaces is one space, mapped to every position in the run.
        if (cps.length === 0) continue;
        if (cps[cps.length - 1] === SPACE) {
          const last = origins[origins.length - 1]!;
          for (const p of at) if (!last.includes(p)) last.push(p);
          continue;
        }
      }
      cps.push(out);
      origins.push([...at]);
    }
  }
  if (cps[cps.length - 1] === SPACE) {
    cps.pop();
    origins.pop();
  }
  return { cps, origins };
}
