// The output ledger's independent reference (OUTPUT-LEDGER-SPEC section 9), for tiny cases only. It shares
// ledgerNormalizeV1 with production on purpose and nothing else: no index, no scan, no production charge. It reads
// units out of the final bytes with JSON.parse plus its own walk (production has its own strict parser), applies the
// declared literal boundaries itself, and literally enumerates every substring pair.
import { BOUNDARY, ledgerNormalizeUnit, ledgerNormalizeV1 } from "../src/privacy/ledger/normalize.ts";

/** A measured unit as the reference sees it: its runtime pieces, a certified literal between each two. */
export type RefUnit = readonly string[];

/** Units of a JSON text, in no particular order: keys, strings, and the spelling of numbers, booleans and null. */
export function refUnits(json: string): RefUnit[] {
  const out: RefUnit[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push([v]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        out.push([k]);
        walk(x);
      }
    } else out.push([JSON.stringify(v)]);
  };
  walk(JSON.parse(json));
  return out;
}

/** The match rule under test (CARET_TEST_LEDGER_RULE), read here on its own: A by default. */
export type RefRule = "A" | "B" | "C" | "D" | "E";
const envRule = (): RefRule => (process.env.CARET_TEST_LEDGER_RULE as RefRule | undefined) ?? "A";

/**
 * The reference's own word segmentation of a normalized line, written apart from production's: a word is a maximal run
 * of L, M and N scalars, except that a scalar of Han, Hiragana, Katakana, Thai, Lao, Khmer or Myanmar is a word alone.
 * Returns, for each scalar, whether a word starts and whether one ends there.
 */
function refWords(cps: readonly number[]): { starts: Set<number>; ends: Set<number>; words: [number, number][] } {
  const inWord = (cp: number): boolean => /[\p{L}\p{M}\p{N}]/u.test(String.fromCodePoint(cp));
  const alone = (cp: number): boolean => /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u.test(String.fromCodePoint(cp));
  const words: [number, number][] = [];
  let i = 0;
  while (i < cps.length) {
    if (!inWord(cps[i]!)) {
      i++;
      continue;
    }
    if (alone(cps[i]!)) {
      words.push([i, i]);
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < cps.length && inWord(cps[j + 1]!) && !alone(cps[j + 1]!)) j++;
    words.push([i, j]);
    i = j + 1;
  }
  return { starts: new Set(words.map((w) => w[0])), ends: new Set(words.map((w) => w[1])), words };
}

/** The positions of one window (lines in order) that the units reveal, as a sorted list of `line:offset`. */
export function refReveal(units: readonly RefUnit[], lines: readonly string[], rule: RefRule = envRule(), wordsOn = process.env.CARET_TEST_LEDGER_WORDS === "1"): { positions: string[]; charged: number; prose: number; words?: { positions: string[]; charged: number; prose: number } } {
  // The coordinator's 2026-10-08 ruling: a line that normalizes like an earlier one is the same line, counted once.
  // Of copies that normalize alike, the one that sorts first by code units stands for all, in the first copy's place.
  const firstAt = new Map<string, number>();
  const best = new Map<string, string>();
  lines.forEach((l, i) => {
    const k = ledgerNormalizeV1(l).cps.join(",");
    if (!firstAt.has(k)) firstAt.set(k, i);
    const b = best.get(k);
    if (b === undefined || l < b) best.set(k, l);
  });
  lines = [...firstAt].sort((a, b) => a[1] - b[1]).map(([k]) => best.get(k) as string);
  const marked = new Set<string>();
  const wmarked = new Set<string>();
  const us = units.map((u) => ledgerNormalizeUnit(u).cps);
  lines.forEach((raw, li) => {
    const src = ledgerNormalizeV1(raw);
    const n = src.cps.length;
    const ws = refWords(src.cps);
    const occurs = (a: number, b: number): boolean => {
      const len = b - a;
      for (const u of us) for (let c = 0; c + len <= u.length; c++) {
        let eq = true;
        for (let k = 0; k < len && eq; k++) eq = u[c + k] !== BOUNDARY && u[c + k] === src.cps[a + k];
        if (eq) return true;
      }
      return false;
    };
    if (wordsOn && (rule === "B" || rule === "C" || rule === "D")) {
      for (const [a, e] of ws.words) if (occurs(a, e + 1)) for (let k = a; k <= e; k++) for (const p of src.origins[k]!) wmarked.add(`${li}:${p}`);
    }
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b <= n; b++) {
        const len = b - a;
        const whole = a === 0 && b === n;
        if (!whole) {
          if (rule === "A" && len < 4) continue;
          if (rule === "E" && len < 12) continue;
          if (rule === "B" || rule === "C" || rule === "D") {
            if (!ws.starts.has(a) || !ws.ends.has(b - 1)) continue;
            const count = ws.words.filter(([s0, e0]) => s0 >= a && e0 <= b - 1).length;
            if (rule === "B" && len < 4) continue;
            if (rule === "C" && count < 2) continue;
            if (rule === "D" && count < 3) continue;
          }
        }
        let found = false;
        for (const u of us) {
          for (let c = 0; c + len <= u.length && !found; c++) {
            let eq = true;
            for (let k = 0; k < len && eq; k++) eq = u[c + k] !== BOUNDARY && u[c + k] === src.cps[a + k];
            found = eq;
          }
          if (found) break;
        }
        if (!found) continue;
        if (whole) for (let p = 0; p < raw.length; p++) marked.add(`${li}:${p}`);
        else for (let k = a; k < b; k++) for (const p of src.origins[k]!) marked.add(`${li}:${p}`);
      }
    }
  });
  const positions = [...marked].sort();
  const proseOf = (ps: string[]): number => ps.filter((p) => (lines[Number(p.split(":")[0])] ?? "").length > 80).length;
  const prose = proseOf(positions);
  if (!(wordsOn && (rule === "B" || rule === "C" || rule === "D"))) return { positions, charged: positions.length, prose };
  const wp = [...wmarked].sort();
  return { positions, charged: positions.length, prose, words: { positions: wp, charged: wp.length, prose: proseOf(wp) } };
}
