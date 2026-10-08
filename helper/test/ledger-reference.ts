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

/** A declared span as the reference takes it: a range of one of the window's lines, or a text (charging the lines that hold it). */
export type RefSpan = string | { at: { part: string; start: number; end: number } } | { text: string };

/**
 * The positions of one window (its distinct lines, in order) that the units reveal, as sorted `line:offset` keys: every
 * source substring of K or more normalized scalars, or a whole line of any length, that equals a stretch of some unit;
 * and each declared span's positions. A range (`at`, on part `line:<index>`) marks exactly its offsets. A text marks every
 * line that holds one of its lines (split at CR, LF or CRLF, whitespace collapsed and trimmed), as written or with an
 * ellipsis taken off either end, whole.
 */
export function refReveal(units: readonly string[], lines: readonly string[], spans: readonly RefSpan[] = []): { positions: string[]; charged: number } {
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
  for (const sp of spans) {
    if (typeof sp !== "string" && "at" in sp) {
      const li = Number(sp.at.part.replace(/^line:/u, ""));
      for (let p = sp.at.start; p < sp.at.end; p++) marked.add(`${li}:${p}`);
      continue;
    }
    const text = typeof sp === "string" ? sp : sp.text;
    const pieces: string[] = [];
    for (const raw of text.split(/\r\n|\r|\n/u)) {
      const l = raw.replace(/\s+/gu, " ").trim();
      if (l === "") continue;
      pieces.push(l);
      const bare = l.replace(/^\u2026/u, "").replace(/\u2026$/u, "").trim();
      if (bare !== "") pieces.push(bare);
    }
    lines.forEach((line, li) => {
      if (pieces.some((p) => line.includes(p))) for (let p = 0; p < line.length; p++) marked.add(`${li}:${p}`);
    });
  }
  const positions = [...marked].sort();
  return { positions, charged: positions.length };
}
