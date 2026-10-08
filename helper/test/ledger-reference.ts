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
 * source substring of K or more normalized scalars, or a whole line of any length, that equals a stretch of some unit.
 */
export function refReveal(units: readonly string[], lines: readonly string[]): { positions: string[]; charged: number } {
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
  const positions = [...marked].sort();
  return { positions, charged: positions.length };
}
