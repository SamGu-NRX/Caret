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
 * N_w, written out: every `line:offset` of the window, less (a) every line whose whole normalized text stands in a line
 * before it, and (b) every position that produced a scalar inside an occurrence of a K-scalar run that occurred before
 * it, where "before" is the canonical order: lines longest normalized first, then by their scalars, and within a line,
 * by start.
 */
export function refKept(lines: readonly string[]): Set<string> {
  return refN(lines).kept;
}

/**
 * N_w and, for each line that stands whole in a line before it, the `line:offset` keys of its leftmost copy in the first
 * such line: revealing the line reveals that copy, which is the one counted.
 */
function refN(lines: readonly string[]): { kept: Set<string>; copies: Map<number, string[]> } {
  const norm = lines.map((l) => ledgerNormalizeV1(l));
  const order = lines.map((_, i) => i).sort((a, b) => {
    const x = norm[a]!.cps;
    const y = norm[b]!.cps;
    if (x.length !== y.length) return y.length - x.length;
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k]! - y[k]!;
    return 0;
  });
  const has = (hay: readonly number[], needle: readonly number[], before = hay.length): boolean => {
    for (let c = 0; c + needle.length <= before; c++) {
      let eq = true;
      for (let k = 0; k < needle.length && eq; k++) eq = hay[c + k] === needle[k];
      if (eq) return true;
    }
    return false;
  };
  const kept = new Set<string>();
  const copies = new Map<number, string[]>();
  order.forEach((li, rank) => {
    const cps = norm[li]!.cps;
    const earlier = order.slice(0, rank).map((x) => norm[x]!.cps);
    const host = cps.length === 0 ? -1 : earlier.findIndex((e) => has(e, cps));
    if (host >= 0) {
      const h = order[host]!;
      const hay = norm[h]!.cps;
      let at = 0;
      while (!cps.every((c, k) => hay[at + k] === c)) at++;
      copies.set(li, [...new Set(norm[h]!.origins.slice(at, at + cps.length).flat())].map((p) => `${h}:${p}`));
      return;
    }
    const dropped = new Set<number>();
    for (let a = 0; a + K <= cps.length; a++) {
      const gram = cps.slice(a, a + K);
      // Before it: in an earlier line, or starting earlier in this one (an occurrence may overlap this one).
      if (earlier.some((e) => has(e, gram)) || has(cps, gram, a + K - 1)) for (let k = a; k < a + K; k++) dropped.add(k);
    }
    // A source position goes when any scalar it produced is in a dropped occurrence ("ß" is two scalars).
    const gone = new Set<number>();
    norm[li]!.origins.forEach((o, k) => {
      if (dropped.has(k)) for (const p of o) gone.add(p);
    });
    for (let p = 0; p < lines[li]!.length; p++) if (!gone.has(p)) kept.add(`${li}:${p}`);
  });
  return { kept, copies };
}

/** Section 5's limit of a conversation, from its lines: under half of N_w, at most 600. */
export function refConversationLimit(lines: readonly string[]): number {
  return Math.min(600, Math.max(0, Math.floor((refKept(lines).size - 1) / 2)));
}

/**
 * The positions of one window (its distinct lines, in order) that the units reveal, as sorted `line:offset` keys: every
 * source substring of K or more normalized scalars, or a whole line of any length (with the copy of it that is counted),
 * that equals a stretch of some unit, within N_w (refKept).
 */
export function refReveal(units: readonly string[], lines: readonly string[]): { positions: string[]; charged: number } {
  const us = units.map((u) => ledgerNormalizeV1(u).cps);
  const counted = refN(lines);
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
        if (whole) {
          for (let p = 0; p < raw.length; p++) marked.add(`${li}:${p}`);
          for (const k of counted.copies.get(li) ?? []) marked.add(k);
        }
        else for (let k = a; k < b; k++) for (const p of src.origins[k]!) marked.add(`${li}:${p}`);
      }
    }
  });
  const positions = [...marked].filter((p) => counted.kept.has(p)).sort();
  return { positions, charged: positions.length };
}
