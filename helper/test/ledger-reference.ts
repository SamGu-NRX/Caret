// The output ledger's independent reference (OUTPUT-LEDGER-SPEC section 9), for tiny cases only. It shares
// ledgerNormalizeV1 with production on purpose and nothing else: no index, no scan, no production charge. It reads
// units out of the final bytes with JSON.parse plus its own walk (production has its own strict parser), and literally
// enumerates every substring pair.
import { ledgerNormalizeV1 } from "../src/privacy/ledger/normalize.ts";

/** The shortest run that counts, written here on its own (production: measure.ts RUN_MIN). */
const K = 12;

/** Units of a JSON text, in no particular order: keys, strings, and the spelling of numbers, booleans and null. */
export function refUnits(json: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        walk(x);
      }
    } else out.push(JSON.stringify(v));
  };
  walk(JSON.parse(json));
  return out;
}

/**
 * The positions of one window (its distinct lines, in order) that the units reveal, as sorted `line:offset` keys: every
 * source substring of K or more normalized scalars, or a whole line of any length, that equals a stretch of some unit;
 * and, for each piece of a declared span (`spans`: the source texts the window's minted units present in the output were
 * read from), at any length, every source position from the first to the last of the one place it is taken to stand: a
 * whole line first, then an occurrence with no letter or digit either side, then any; the widest source range; the line
 * that sorts first; the leftmost. A span's pieces are its lines, each with its whitespace collapsed and trimmed and an
 * ellipsis at either end dropped. A derivation's span (`within` its basis) marks, inside the place of each piece of the
 * basis, what the derived text reproduces: from each of its positions in turn, the longest stretch of it the piece
 * holds anywhere, at the leftmost such place, then on past that stretch.
 */
export function refReveal(units: readonly string[], lines: readonly string[], spans: readonly (string | { text: string; within?: string })[] = []): { positions: string[]; charged: number } {
  const us = units.map((u) => ledgerNormalizeV1(u).cps);
  const marked = new Set<string>();
  lines.forEach((raw, li) => {
    const src = ledgerNormalizeV1(raw);
    const n = src.cps.length;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b <= n; b++) {
        const len = b - a;
        const whole = a === 0 && b === n;
        if (len < K && !whole) continue;
        let found = false;
        for (const u of us) {
          for (let c = 0; c + len <= u.length && !found; c++) {
            let eq = true;
            for (let k = 0; k < len && eq; k++) eq = u[c + k] === src.cps[a + k];
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
  const piecesOf = (t: string): (readonly number[])[] =>
    t
      .split(/\r?\n/u)
      .map((x) => x.replace(/\s+/gu, " ").trim().replace(/^\u2026|\u2026$/gu, "").trim())
      .filter((x) => x !== "")
      .map((x) => ledgerNormalizeV1(x).cps)
      .filter((x) => x.length > 0);
  const norm = lines.map((l) => ledgerNormalizeV1(l));
  const at = (hay: readonly number[], needle: readonly number[], a: number): boolean => needle.every((c, k) => hay[a + k] === c);
  const word = (cp: number | undefined): boolean => cp !== undefined && /[\p{L}\p{N}]/u.test(String.fromCodePoint(cp));
  /** Every source position of line `li` from the first to the last that normalized scalars `a` to `a + len` came from. */
  const keysOf = (li: number, a: number, len: number): string[] => {
    const ps = norm[li]!.origins.slice(a, a + len).flat();
    const out: string[] = [];
    for (let p = Math.min(...ps); p <= Math.max(...ps); p++) out.push(`${li}:${p}`);
    return out;
  };
  /** Every occurrence of `piece`, ranked: whole line, then bounded by no letter or digit, then any; most positions; line text; offset. */
  const place = (piece: readonly number[]): { li: number; a: number } | null => {
    const all: { li: number; a: number; cls: number; size: number }[] = [];
    norm.forEach((n, li) => {
      for (let a = 0; a + piece.length <= n.cps.length; a++) {
        if (!at(n.cps, piece, a)) continue;
        const whole = a === 0 && piece.length === n.cps.length;
        const bounded = !word(n.cps[a - 1]) && !word(n.cps[a + piece.length]);
        all.push({ li, a, cls: whole ? 0 : bounded ? 1 : 2, size: keysOf(li, a, piece.length).length });
      }
    });
    all.sort((x, y) => x.cls - y.cls || y.size - x.size || (lines[x.li]! < lines[y.li]! ? -1 : lines[x.li]! > lines[y.li]! ? 1 : 0) || x.a - y.a);
    return all[0] ?? null;
  };
  for (const sp of spans) {
    const { text, within } = typeof sp === "string" ? { text: sp, within: undefined } : sp;
    const derived = within === undefined ? null : ledgerNormalizeV1(text).cps;
    for (const piece of piecesOf(within ?? text)) {
      const p = place(piece);
      if (p === null) continue;
      if (derived === null) {
        for (const k of keysOf(p.li, p.a, piece.length)) marked.add(k);
        continue;
      }
      /** The leftmost start in the piece's place where `needle` stands, or -1. */
      const first = (needle: readonly number[]): number => {
        for (let b = p.a; b + needle.length <= p.a + piece.length; b++) if (at(norm[p.li]!.cps, needle, b)) return b;
        return -1;
      };
      for (let i = 0; i < derived.length; ) {
        let len = derived.length - i;
        while (len > 0 && first(derived.slice(i, i + len)) < 0) len--;
        if (len === 0) {
          i++;
          continue;
        }
        for (const k of keysOf(p.li, first(derived.slice(i, i + len)), len)) marked.add(k);
        i += len;
      }
    }
  }
  const positions = [...marked].sort();
  return { positions, charged: positions.length };
}
