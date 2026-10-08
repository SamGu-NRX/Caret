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
 * read from), at any length, the one place it is taken to stand: a whole line first, then an occurrence with no letter
 * or digit either side, then any; the most source positions; the line that sorts first; the leftmost. A span's pieces
 * are its text split at line breaks and at "…", each with its whitespace collapsed and trimmed. A derivation's span
 * (`within` its basis) marks each of its words (runs of letters and digits) where it first stands inside the place of
 * a piece of the basis.
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
  const piecesOf = (t: string): (readonly number[])[] => t.split("\n").flatMap((l) => l.split("\u2026")).map((x) => x.replace(/\s+/gu, " ").trim()).filter((x) => x !== "").map((x) => ledgerNormalizeV1(x).cps).filter((x) => x.length > 0);
  const norm = lines.map((l) => ledgerNormalizeV1(l));
  const at = (hay: readonly number[], needle: readonly number[], a: number): boolean => needle.every((c, k) => hay[a + k] === c);
  const word = (cp: number | undefined): boolean => cp !== undefined && /[\p{L}\p{N}]/u.test(String.fromCodePoint(cp));
  const keysOf = (li: number, a: number, len: number): string[] => [...new Set(norm[li]!.origins.slice(a, a + len).flat())].map((p) => `${li}:${p}`);
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
    const words = within === undefined ? null : String.fromCodePoint(...ledgerNormalizeV1(text).cps).split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "").map((w) => Array.from(w, (c) => c.codePointAt(0)!));
    for (const piece of piecesOf(within ?? text)) {
      const p = place(piece);
      if (p === null) continue;
      if (words === null) {
        for (const k of keysOf(p.li, p.a, piece.length)) marked.add(k);
        continue;
      }
      for (const w of words) {
        for (let b = p.a; b + w.length <= p.a + piece.length; b++) {
          if (!at(norm[p.li]!.cps, w, b)) continue;
          for (const k of keysOf(p.li, b, w.length)) marked.add(k);
          break;
        }
      }
    }
  }
  const positions = [...marked].sort();
  return { positions, charged: positions.length };
}
