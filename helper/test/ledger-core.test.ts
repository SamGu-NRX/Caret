// The output ledger's core (OUTPUT-LEDGER-SPEC sections 2-5, 9 and 11): the pinned normalizer, the decoded units, the
// measurement against its independent brute-force reference (test/ledger-reference.ts), and the fixed desks at the
// level of units and source lines. The request-boundary versions of the desks live with the seal.
import { describe, expect, it } from "vitest";
import { LEDGER_NORMALIZATION, LedgerEncodingError, ledgerNormalizeV1 } from "../src/privacy/ledger/normalize.ts";
import { decodeUnits } from "../src/privacy/ledger/units.ts";
import { inventoryOf, limitOf, reveal, UnitIndex, UnitProbe, type LineInventory } from "../src/privacy/ledger/measure.ts";
import { refReveal, refUnits } from "./ledger-reference.ts";
import { rng } from "./large-scene.ts";

const cps = (s: string): string[] => [...s].map((c) => c.codePointAt(0)!.toString(16));

describe("ledgerNormalizeV1, pinned to Unicode 16.0.0", () => {
  it("names its version", () => {
    expect(LEDGER_NORMALIZATION).toBe("ledgerNormalizeV1/unicode-16.0.0");
  });

  // Each row: input, normalized text, and each normalized scalar's source UTF-16 positions.
  const pins: [string, string, string, number[][]][] = [
    ["case expansion", "Straße", "strasse", [[0], [1], [2], [3], [4], [4], [5]]],
    ["capital sharp s", "ẞ", "ss", [[0], [0]]],
    ["dotted capital I (F mapping, not Turkic)", "İ", "i̇", [[0], [0]]],
    ["final sigma folds to sigma", "ς", "σ", [[0]]],
    ["Cherokee folds to its capital", "ᏸ", "Ᏸ", [[0]]],
    ["ligature", "ﬁle", "file", [[0], [0], [1], [2]]],
    ["full-width", "ＡＢ", "ab", [[0], [1]]],
    ["composed accent", "é", "é", [[0], [0]]],
    ["decomposed accent", "é", "é", [[0], [1]]],
    ["Greek with ypogegrammeni, folded after NFKD", "ᾀ", "ἀι", [[0], [0], [0]]],
    ["angstrom sign", "Å", "å", [[0], [0]]],
    ["mathematical bold (supplementary)", "𝐀", "a", [[0, 1]]],
    ["emoji (supplementary, unchanged)", "😀", "😀", [[0, 1]]],
    ["Hangul syllable", "한", "한", [[0], [0], [0]]],
    ["whitespace collapses to one space over its run", "a \t b", "a b", [[0], [1, 2, 3], [4]]],
    ["line and paragraph separators, ideographic space", "a 　b", "a b", [[0], [1, 2], [3]]],
    ["trim", "  x  ", "x", [[2]]],
    ["punctuation stays", "Hi, you!", "hi, you!", [[0], [1], [2], [3], [4], [5], [6], [7]]],
    ["ellipsis spells three periods", "a…", "a...", [[0], [1], [1], [1]]],
    ["zero-width space stays", "a​b", "a​b", [[0], [1], [2]]],
    ["circled digit", "①", "1", [[0]]],
    ["square unit", "㎒", "mhz", [[0], [0], [0]]],
  ];
  for (const [name, input, text, origins] of pins) {
    it(name, () => {
      const n = ledgerNormalizeV1(input);
      expect(n.cps.map((c) => c.toString(16))).toEqual(cps(text));
      expect(n.origins).toEqual(origins);
    });
  }

  it("refuses an unpaired surrogate, high or low", () => {
    expect(() => ledgerNormalizeV1("\uD800x")).toThrow(LedgerEncodingError);
    expect(() => ledgerNormalizeV1("x\uDC00")).toThrow(LedgerEncodingError);
    expect(() => ledgerNormalizeV1("x\uD800")).toThrow(LedgerEncodingError);
  });
});

describe("decoded units", () => {
  it("reads keys, strings and scalar spellings as separate units, escapes decoded once", () => {
    const d = decodeUnits('{"state":{"note":"Al\\nix \\u00e9","n":4412,"ok":true,"none":null,"f":-0.5e3},"list":["a","{\\"x\\":1}"]}');
    expect(d.units.map((u) => [u.kind, u.text])).toEqual([
      ["key", "state"],
      ["key", "note"],
      ["string", "Al\nix é"],
      ["key", "n"],
      ["scalar", "4412"],
      ["key", "ok"],
      ["scalar", "true"],
      ["key", "none"],
      ["scalar", "null"],
      ["key", "f"],
      ["scalar", "-0.5e3"],
      ["key", "list"],
      ["string", "a"],
      // A string that looks like JSON is not parsed again.
      ["string", '{"x":1}'],
    ]);
    expect(d.units[2]!.path).toEqual(["state", "note"]);
    expect(d.units[13]!.path).toEqual(["list", 1]);
  });

  it("reads bytes as UTF-8, and refuses malformed UTF-8, a byte-order mark, malformed JSON, a duplicate key and a lone surrogate", () => {
    expect(decodeUnits(new TextEncoder().encode('{"a":"é"}')).units[1]!.text).toBe("é");
    expect(() => decodeUnits(new Uint8Array([0x7b, 0x22, 0xc3, 0x22, 0x7d]))).toThrow(LedgerEncodingError);
    expect(() => decodeUnits(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toThrow(LedgerEncodingError);
    for (const bad of ['{"a":1,"a":2}', '{"a":"\\ud800"}', '{"a":1', '{"a":1}x', "{'a':1}", '{"a":"\u0001"}', '{"a":01}', "[1,]"]) {
      expect(() => decodeUnits(bad), bad).toThrow(LedgerEncodingError);
    }
  });

  it("says nothing of the text in its errors", () => {
    try {
      decodeUnits('{"secret hunter2":1,"secret hunter2":2}');
    } catch (e) {
      expect(String(e)).not.toContain("hunter2");
    }
  });

  it("agrees with the reference's own extraction on random JSON", () => {
    const r = rng(7);
    const alphabet = ["a", "B", " ", "\n", "é", '"', "\\", "😀", "/", " "];
    const str = (): string => Array.from({ length: Math.floor(r() * 5) }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");
    const val = (depth: number): unknown => {
      const k = Math.floor(r() * (depth > 2 ? 3 : 5));
      if (k === 0) return str();
      if (k === 1) return [1, -2.5, true, false, null][Math.floor(r() * 5)];
      if (k === 2) return str();
      if (k === 3) return Array.from({ length: Math.floor(r() * 3) }, () => val(depth + 1));
      const o: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(r() * 3); i++) o[`${str()}${i}`] = val(depth + 1);
      return o;
    };
    for (let n = 0; n < 500; n++) {
      const json = JSON.stringify(val(0));
      const prod = decodeUnits(json).units.map((u) => u.text).sort();
      const ref = refUnits(json).sort();
      expect(prod).toEqual(ref);
    }
  });
});

/** Section 1's inventory of a window's text, written out here: split at line breaks, collapse, trim, drop empty, dedupe. */
function linesOf(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((t) => t.split(/\r?\n/u)).map((l) => l.replace(/\s+/gu, " ").trim()).filter((l) => l !== ""))];
}

function positionsOf(inv: LineInventory, bits: Uint8Array): string[] {
  const out: string[] = [];
  inv.starts.forEach((s, li) => {
    for (let p = 0; p < inv.lines[li]!.length; p++) if (bits[s + p] === 1) out.push(`${li}:${p}`);
  });
  return out.sort();
}

/** Production's charge of one window, by the full scan and by the indexed scan, which must agree position by position. */
function production(units: readonly string[], lines: readonly string[]): { positions: string[]; charged: number } {
  const inv = inventoryOf(lines);
  const normalized = units.map((u) => ledgerNormalizeV1(u));
  const r = reveal(new UnitIndex(normalized), inv);
  const out = { positions: positionsOf(inv, r.positions), charged: r.charged };
  const probed = new UnitProbe(normalized).reveal(inv);
  expect({ positions: positionsOf(inv, probed.positions), charged: probed.charged }).toEqual(out);
  return out;
}

/** The charge of one window, both ways; the test fails when they differ in any position. */
function charge(units: readonly string[], lines: readonly string[]): number {
  const ref = refReveal(units, lines);
  const prod = production(units, lines);
  expect(prod).toEqual(ref);
  return prod.charged;
}

describe("the fixed desks (OUTPUT-LEDGER-SPEC section 11), as units against a window's lines", () => {
  const tide = Array.from({ length: 18 }, () => "tide").join(" ");
  // [desk, units, the window's lines, charge]; each name says how the charge arises. A run must be RUN_MIN (12)
  // normalized scalars, or a whole line; a desk marked (whole line) is charged only through whole-line containment.
  const desks: [string, string[], string[], number][] = [
    ["1. 'Alice, Bob' derived as 'Alice Bob' (whole line)", ["Alice Bob"], ["Alice Bob"], 9],
    ["1. the consented source of that derivation: under 12 scalars, not a whole line (residual)", ["Alice Bob"], ["Alice, Bob"], 0],
    ["1. 'Tomorrow' derived as '2026' (whole line)", ["2026"], ["2026"], 4],
    ["1. an event time (whole line)", ["Thu 3:00 to 3:45 PM"], ["Thu 3:00 to 3:45 PM"], 19],
    ["2. repeated 'Echo' joined as 'Echo Echo' (whole line)", ["Echo Echo"], ["Echo Echo"], 9],
    ["2. 'Al' and 'ix' composed as 'Alix' (whole line)", ["Alix"], ["Alix"], 4],
    ["2. a descriptor wholly runtime (whole line)", ["Label: 'Name'."], ["Label: 'Name'."], 14],
    ["2. a descriptor's runtime part 'Name' against the descriptor line (residual)", ["Name"], ["Label: 'Name'."], 0],
    ["2. a repeated-word 89-character bystander prose line (whole line)", [tide], [tide], 89],
    ["2. a runtime event title (whole line)", ["Lunch with Priya"], ["Lunch with Priya", "okay!"], 16],
    ["3. 'Al ix' held as 'Al\\nix' (whole line)", ["Al\nix"], ["Al ix"], 5],
    ["4. 'Bob Ann Ann' against 'Bob Ann then Ann' (residual)", ["Bob Ann Ann"], ["Bob Ann then Ann"], 0],
    ["5. 'Echo echo' against unit 'Echo\\nEcho' (whole line)", ["Echo\nEcho"], ["Echo echo"], 9],
    ["5. 'Echo xEcho' against unit 'Echo\\nEcho' (residual)", ["Echo\nEcho"], ["Echo xEcho"], 0],
    ["6. held 'ALICE BOB' (whole line)", ["ALICE BOB"], ["Alice Bob"], 9],
    ["6. held 'Echo\\nEcho' against 'Echo Echo' (whole line)", ["Echo\nEcho"], ["Echo Echo"], 9],
    ["7. app 'Notes' against 'NOTES' (whole line)", ["Notes"], ["NOTES"], 5],
    ["T-M2. 'Back' inside 'Outback' (whole line)", ["Outback"], ["Back"], 4],
    ["unit boundary: separate JSON values 'Al' and 'ix' against 'Alix'", ["Al", "ix"], ["Alix"], 0],
    ["a 12-scalar run counts", ["see you at f"], ["we will see you at five tomorrow"], 12],
    ["an 11-scalar run does not", ["ee you at f"], ["we will see you at five tomorrow"], 0],
    ["'Echo Alfa Beto Cora' cut to 'Echo…' (residual)", ["Echo…"], ["Echo Alfa Beto Cora"], 0],
  ];
  for (const [name, units, lines, want] of desks) it(name, () => expect(charge(units, lines)).toBe(want));

  it("long repeats, as charge against the window's size: 65 output copies against 103 source copies of 'Echo'", () => {
    const line = Array.from({ length: 103 }, () => "Echo").join(" ");
    const inv = inventoryOf([line]);
    expect([production([Array.from({ length: 65 }, () => "Echo").join("\n")], [line]).charged, inv.total]).toEqual([514, 514]);
    // Two copies are a run of 9: the residual for repeats of a short word.
    expect(production(["Echo Echo"], [line]).charged).toBe(0);
  });

  it("has no occurrence cap: 65 and 103 repeats of a 13-scalar run", () => {
    for (const k of [65, 103]) {
      const line = Array.from({ length: k }, () => "see you at five").join(" ");
      expect(production(["see you at five"], [line]).charged).toBe(15 * k);
    }
  });
});

describe("section 5's limits", () => {
  const lines = (n: number): string[] => Array.from({ length: Math.ceil(n / 10) }, (_, i) => `${String(i).padStart(4, "0")}${"x".repeat(6)}`.slice(0, 10)).map((l, i, a) => (i === a.length - 1 ? l.slice(0, n - 10 * (a.length - 1)) : l));
  it("a conversation gives under half its text: 632 gives 315, 993 gives 496, never more than 600", () => {
    expect(limitOf(inventoryOf(lines(632)), true)).toBe(315);
    expect(limitOf(inventoryOf(lines(993)), true)).toBe(496);
    expect(limitOf(inventoryOf(lines(1300)), true)).toBe(600);
    expect(limitOf(inventoryOf(["a"]), true)).toBe(0);
  });
  it("any other window gives 1200, whatever its size", () => {
    expect(limitOf(inventoryOf(["a", "b"]), false)).toBe(1200);
    expect(limitOf(inventoryOf(lines(5000)), false)).toBe(1200);
  });
});

describe("production equals the brute-force reference (section 9)", () => {
  const ALPHA = ["a", "b", "A", " ", "ß", "s", "ﬁ", "f", "i", "…", ".", " ", "é", "é", "𝐀", "\n", ","];
  const gen = (r: () => number, max: number): string => Array.from({ length: Math.floor(r() * (max + 1)) }, () => ALPHA[Math.floor(r() * ALPHA.length)]).join("");
  const caseOf = (seed: number): { units: string[]; lines: string[] } => {
    const r = rng(seed);
    const lines = linesOf(Array.from({ length: 1 + Math.floor(r() * 3) }, () => gen(r, 30)));
    const units = Array.from({ length: Math.floor(r() * 4) }, () => gen(r, 24));
    // Some units copy a cut of a source line, so matches are common.
    if (lines.length > 0 && r() < 0.8) {
      // Cut by scalars, never inside a surrogate pair.
      const l = [...lines[Math.floor(r() * lines.length)]!];
      const a = Math.floor(r() * l.length);
      units.push(`${gen(r, 2)}${l.slice(a, a + 1 + Math.floor(r() * l.length)).join("")}${gen(r, 2)}`);
    }
    return { units, lines };
  };

  it("in every position over 10,000 reproducible tiny cases", () => {
    let partial = 0;
    for (let seed = 1; seed <= 10_000; seed++) {
      const { units, lines } = caseOf(seed);
      if (lines.length === 0) continue;
      const ref = refReveal(units, lines);
      const prod = production(units, lines);
      if (JSON.stringify(prod) !== JSON.stringify(ref)) expect({ seed, units, lines, prod }).toEqual({ seed, units, lines, prod: ref });
      if (ref.charged > 0 && ref.charged < lines.reduce((n, l) => n + l.length, 0)) partial++;
    }
    // Not vacuous: many cases charge part of a window.
    expect(partial).toBeGreaterThan(1000);
  });

  it("superstring monotonicity: prefix + O + suffix, concatenations, repetition and added units never charge less", () => {
    for (let seed = 1; seed <= 2_000; seed++) {
      const { units, lines } = caseOf(seed);
      if (lines.length === 0 || units.length === 0) continue;
      const r = rng(seed + 99_999);
      const base = refReveal(units, lines);
      const k = Math.floor(r() * units.length);
      const o = units[k]!;
      const grown: string[][] = [
        units.map((u, i) => (i === k ? `${gen(r, 3)}${o}${gen(r, 3)}` : u)),
        units.map((u, i) => (i === k ? `${o}${units[(k + 1) % units.length]!}` : u)),
        units.map((u, i) => (i === k ? `${o}${o}` : u)),
        [...units, gen(r, 24)],
      ];
      for (const g of grown) {
        const ref = refReveal(g, lines);
        for (const p of base.positions) expect(ref.positions).toContain(p);
        expect(production(g, lines)).toEqual(ref);
      }
    }
  });

  it("unit order and line order change nothing", () => {
    for (let seed = 1; seed <= 1_000; seed++) {
      const { units, lines } = caseOf(seed);
      if (lines.length === 0) continue;
      const byText = (ls: readonly string[], ps: readonly string[]): string[] => ps.map((p) => `${ls[Number(p.split(":")[0])]}@${p.split(":")[1]}`).sort();
      const a = production(units, lines);
      const b = production([...units].reverse(), [...lines].reverse());
      expect(byText([...lines].reverse(), b.positions)).toEqual(byText(lines, a.positions));
    }
  });

  it("escaped and literal JSON spellings of the same text charge equally", () => {
    const lines = ["Al ix café and the rest of it"];
    const literal = '{"a":"Al\nix café and the rest of it"}'.replace("\n", "\\n");
    const escaped = '{"a":"Al\\u000aix caf\\u00e9 and the rest of it"}';
    const of = (json: string): number => production(decodeUnits(json).units.map((u) => u.text), lines).charged;
    expect(of(literal)).toBe(of(escaped));
    expect(of(escaped)).toBeGreaterThan(0);
  });
});
