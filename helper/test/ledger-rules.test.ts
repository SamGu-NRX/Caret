// MEASUREMENT ONLY (the match-rule comparison, ~/.caret-run/evidence/screen/pv2/match-rule): each candidate rule
// (privacy/ledger/measure.ts MatchRule) against the brute-force reference written with the same rule, position by
// position, full scan and indexed scan, with and without the single-word set.
import { afterEach, describe, expect, it } from "vitest";
import { ledgerNormalizeUnit } from "../src/privacy/ledger/normalize.ts";
import { inventoryOf, reveal, UnitIndex, UnitProbe, type LineInventory } from "../src/privacy/ledger/measure.ts";
import { refReveal, type RefRule, type RefUnit } from "./ledger-reference.ts";
import { rng } from "./large-scene.ts";

const ALPHA = ["a", "b", "A", " ", " ", "ß", "s", "ﬁ", "i", "…", ".", ",", "-", " ", "é", "𝐀", "\n", "1", "中", "文", "ก", "า", "'"];
const gen = (r: () => number, max: number): string => Array.from({ length: Math.floor(r() * (max + 1)) }, () => ALPHA[Math.floor(r() * ALPHA.length)]).join("");
const linesOf = (texts: readonly string[]): string[] => [...new Set(texts.flatMap((t) => t.split(/\r?\n/u)).map((l) => l.replace(/\s+/gu, " ").trim()).filter((l) => l !== ""))];
function caseOf(seed: number): { units: RefUnit[]; lines: string[] } {
  const r = rng(seed);
  const lines = linesOf(Array.from({ length: 1 + Math.floor(r() * 3) }, () => gen(r, 14)));
  const units: RefUnit[] = Array.from({ length: Math.floor(r() * 4) }, () => Array.from({ length: 1 + (r() < 0.25 ? Math.floor(r() * 3) : 0) }, () => gen(r, 12)));
  if (lines.length > 0 && r() < 0.8) {
    const l = [...lines[Math.floor(r() * lines.length)]!];
    const a = Math.floor(r() * l.length);
    units.push([`${gen(r, 2)}${l.slice(a, a + 1 + Math.floor(r() * l.length)).join("")}${gen(r, 2)}`]);
  }
  return { units, lines };
}
function positionsOf(inv: LineInventory, bits: Uint8Array): string[] {
  const out: string[] = [];
  inv.starts.forEach((s, li) => {
    for (let p = 0; p < inv.lines[li]!.length; p++) if (bits[s + p] === 1) out.push(`${li}:${p}`);
  });
  return out.sort();
}

const saved = { rule: process.env.CARET_TEST_LEDGER_RULE, words: process.env.CARET_TEST_LEDGER_WORDS };
afterEach(() => {
  for (const [k, v] of [["CARET_TEST_LEDGER_RULE", saved.rule], ["CARET_TEST_LEDGER_WORDS", saved.words]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("each candidate match rule equals the brute-force reference written with the same rule", () => {
  const variants: [RefRule, boolean][] = [["A", false], ["B", false], ["C", false], ["D", false], ["E", false], ["B", true], ["C", true], ["D", true]];
  for (const [rule, words] of variants) {
    it(`rule ${rule}${words ? " with the single-word set" : ""}: 1,000 cases, every position`, () => {
      process.env.CARET_TEST_LEDGER_RULE = rule;
      if (words) process.env.CARET_TEST_LEDGER_WORDS = "1";
      else delete process.env.CARET_TEST_LEDGER_WORDS;
      let nonzero = 0;
      for (let seed = 1; seed <= 1000; seed++) {
        const { units, lines } = caseOf(seed * 13 + rule.charCodeAt(0));
        if (lines.length === 0) continue;
        const ref = refReveal(units, lines, rule, words);
        const inv = inventoryOf(lines);
        const norm = units.map((u) => ledgerNormalizeUnit(u));
        for (const got of [reveal(new UnitIndex(norm), inv), new UnitProbe(norm).reveal(inv)]) {
          const prod = { positions: positionsOf(inv, got.positions), charged: got.charged, prose: got.prose, ...(got.words === undefined ? {} : { words: { positions: positionsOf(inv, got.words.positions), charged: got.words.charged, prose: got.words.prose } }) };
          if (JSON.stringify(prod) !== JSON.stringify(ref)) expect({ seed, units, lines, prod }).toEqual({ seed, units, lines, prod: ref });
        }
        if (ref.charged > 0) nonzero++;
      }
      expect(nonzero).toBeGreaterThan(200);
    });
  }
});
