// The output ledger's core (OUTPUT-LEDGER-SPEC sections 2-5, 9 and 11): the pinned normalizer, the decoded units, the
// measurement against its independent brute-force reference (test/ledger-reference.ts), and the fixed desks at the
// level of units and source lines. The request-boundary versions of the desks live with the seal.
import { describe, expect, it } from "vitest";
import { LEDGER_NORMALIZATION, LedgerEncodingError, ledgerNormalizeV1 } from "../src/privacy/ledger/normalize.ts";
import { decodeUnits } from "../src/privacy/ledger/units.ts";
import { inventoryOf, limitOf, reveal, spanPositions, UnitIndex, UnitProbe, withPositions, type DeclaredSpan, type LineInventory } from "../src/privacy/ledger/measure.ts";
import { refReveal, refUnits, type RefSpan } from "./ledger-reference.ts";
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
type Span = RefSpan;

/** A recorded source range of line `li` of a test window (inventoryOf's part `line:<li>`). */
const at = (li: number, start: number, end: number): Span => ({ at: { part: `line:${li}`, start, end } });

function production(units: readonly string[], lines: readonly string[], spans: readonly Span[] = []): { positions: string[]; charged: number } {
  const inv = inventoryOf(lines);
  const normalized = units.map((u) => ledgerNormalizeV1(u));
  const declared = new Uint8Array(inv.total);
  for (const t of spans) spanPositions(inv, (typeof t === "string" ? { text: t } : t) as DeclaredSpan).forEach((b, p) => (declared[p] = declared[p]! | b));
  const r = withPositions(reveal(new UnitIndex(normalized), inv), declared);
  const out = { positions: positionsOf(inv, r.positions), charged: r.charged };
  const probed = withPositions(new UnitProbe(normalized).reveal(inv), declared);
  expect({ positions: positionsOf(inv, probed.positions), charged: probed.charged }).toEqual(out);
  return out;
}

/** The charge of one window, both ways; the test fails when they differ in any position. */
function charge(units: readonly string[], lines: readonly string[], spans: readonly Span[] = []): number {
  const ref = refReveal(units, lines, spans);
  const prod = production(units, lines, spans);
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

  it("has no occurrence cap: 65 and 103 repeats of a 15-scalar run, as charge against the window's size", () => {
    for (const k of [65, 103]) {
      const line = Array.from({ length: k }, () => "see you at five").join(" ");
      // Every copy is charged; only the spaces between copies are not.
      expect([production(["see you at five"], [line]).charged, inventoryOf([line]).total]).toEqual([15 * k, 16 * k - 1]);
    }
  });
});

// The Astra second opinion's counterexamples to 9d110306 (run-level dedupe), each charged as the measure now charges it.
describe("the Astra counterexamples", () => {
  it("six short values minted from a chat are charged their declared spans: 25 of 35 characters, over its limit of 17", () => {
    const lines = ["Kofi", "Alice, Bob", "Cedar, Elm", "Paris, Rome"];
    const values = ["Alice", "Bob", "Cedar", "Elm", "Paris", "Rome"];
    // Lexically nothing: each value is under 12 scalars and no whole line.
    expect(charge(values, lines)).toBe(0);
    // Declared with the ranges they were read from, each is charged there.
    expect(charge(values, lines, [at(1, 0, 5), at(1, 7, 10), at(2, 0, 5), at(2, 7, 10), at(3, 0, 5), at(3, 7, 11)])).toBe(25);
    expect(limitOf(inventoryOf(lines), true)).toBe(17);
    // From a producer that cannot record its range, each charges the whole lines that hold it.
    expect(charge(values, lines, values)).toBe(31);
  });

  it("a 22-character run that a later copy of the alphabet holds is charged 22", () => {
    const L = "mnopqrstuvwxabcdefghijklabcdefghijklmnopqrstuvwx";
    expect(charge(["bcdefghijklmnopqrstuvw"], [L])).toBe(22);
  });

  it("a short line that another line holds is charged whole when it is sent", () => {
    const L = "mnopqrstuvwxabcdefghijklabcdefghijklmnopqrstuvwx";
    expect(charge(["klmn"], [L, "klmn"])).toBe(4);
  });

  it("a line of a folding character repeated is charged whole", () => {
    expect(charge(["ßßßßßßß"], ["ßßßßßßß"])).toBe(7);
  });

  it("line order cannot change a charge or a refusal: 'ss' takes 3 of a 6-character chat's limit of 2 either way", () => {
    for (const lines of [["ß", "ss", "xy", "z"], ["ss", "ß", "xy", "z"]]) {
      expect(charge(["ss"], lines), lines.join(",")).toBe(3);
      expect(limitOf(inventoryOf(lines), true), lines.join(",")).toBe(2);
    }
  });
});

// Astra's rechecks of 0deb3e23 and b5226a1f: a recorded range charges every source character in it, as it is.
describe("a declared span", () => {
  it("charges a recorded range every character in it, ellipses and punctuation included", () => {
    expect(charge(["a\u2026\u2026b"], ["a\u2026\u2026b."], [at(0, 0, 4)])).toBe(4);
    expect(charge(["\u2026a\u2026"], ["\u2026a\u2026."], [at(0, 0, 3)])).toBe(3);
    // A derivation declares the whole basis it read: '(1), (2)' from '(1), (2).' is charged the basis, 9.
    expect(charge(["(1), (2)"], ["(1), (2)."], [at(0, 0, 9)])).toBe(9);
  });

  it("charges a text with no range every line that holds one of its lines, whole", () => {
    expect(charge(["Alice"], ["Alice, Bob", "Cedar", "Alice"], ["Alice"])).toBe(15);
    expect(charge(["bcd\rxyz"], ["abcde", "wxyz", "q"], ["bcd\rxyz"])).toBe(9);
    // A cut's ellipsis is read both ways: 'Alic…' charges the line that holds 'Alic'.
    expect(charge(["Alic\u2026"], ["Alice, Bob", "Cedar"], ["Alic\u2026"])).toBe(10);
  });

  it("throws on a range of a part the window does not have, or past its end", () => {
    expect(() => production([], ["abc"], [at(1, 0, 1)])).toThrow(/no part/u);
    expect(() => production([], ["abc"], [at(0, 2, 4)])).toThrow(/not a range/u);
  });
});

// Sol review of 9d110306: full coverage by separate runs is not whole-line containment.
describe("whole-line containment is one match, not full coverage", () => {
  it("charges two runs that cover a line's scalars only their positions: a leading NEL, which normalizes to nothing, is not", () => {
    const line = "\u0085abcdefghijklmnopqrstuvwx";
    expect(charge(["abcdefghijkl", "mnopqrstuvwx"], [line])).toBe(24);
    // Held whole in one unit, the line is charged whole, its NEL included.
    expect(charge(["abcdefghijklmnopqrstuvwx"], [line])).toBe(25);
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
  const caseOf = (seed: number): { units: string[]; lines: string[]; spans: Span[] } => {
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
    // Declared spans: recorded ranges of a line (what a builder minted, where it read it), a cut of a line from a
    // producer with no range, and now and then text no line shows.
    const spans = Array.from({ length: Math.floor(r() * 3) }, (): Span => {
      if (lines.length === 0 || r() < 0.2) return gen(r, 6);
      const li = Math.floor(r() * lines.length);
      const l = lines[li]!;
      const a = Math.floor(r() * l.length);
      const b = Math.min(l.length, a + 1 + Math.floor(r() * 6));
      return r() < 0.6 ? at(li, a, b) : l.slice(a, b);
    });
    return { units, lines, spans };
  };

  it("in every position over 10,000 reproducible tiny cases", () => {
    let partial = 0;
    for (let seed = 1; seed <= 10_000; seed++) {
      const { units, lines, spans } = caseOf(seed);
      if (lines.length === 0) continue;
      const ref = refReveal(units, lines, spans);
      const prod = production(units, lines, spans);
      if (JSON.stringify(prod) !== JSON.stringify(ref)) expect({ seed, units, lines, spans, prod }).toEqual({ seed, units, lines, spans, prod: ref });
      if (ref.charged > 0 && ref.charged < lines.reduce((n, l) => n + l.length, 0)) partial++;
    }
    // Not vacuous: many cases charge part of a window.
    expect(partial).toBeGreaterThan(1000);
  });

  it("superstring monotonicity: prefix + O + suffix, concatenations, repetition and added units never charge less", () => {
    for (let seed = 1; seed <= 2_000; seed++) {
      const { units, lines, spans } = caseOf(seed);
      if (lines.length === 0 || units.length === 0) continue;
      const r = rng(seed + 99_999);
      const base = refReveal(units, lines, spans);
      const k = Math.floor(r() * units.length);
      const o = units[k]!;
      const grown: string[][] = [
        units.map((u, i) => (i === k ? `${gen(r, 3)}${o}${gen(r, 3)}` : u)),
        units.map((u, i) => (i === k ? `${o}${units[(k + 1) % units.length]!}` : u)),
        units.map((u, i) => (i === k ? `${o}${o}` : u)),
        [...units, gen(r, 24)],
      ];
      for (const g of grown) {
        const ref = refReveal(g, lines, spans);
        for (const p of base.positions) expect(ref.positions).toContain(p);
        expect(production(g, lines, spans)).toEqual(ref);
      }
      // A unit added with its declared span never charges less either.
      const more = refReveal([...units, gen(r, 6)], lines, [...spans, gen(r, 4)]);
      expect(production([...units, gen(rng(seed), 6)], lines, spans).charged).toBeGreaterThanOrEqual(production(units, lines, spans).charged);
      for (const p of base.positions) expect(more.positions).toContain(p);
    }
  });

  it("unit order and line order change nothing", () => {
    for (let seed = 1; seed <= 1_000; seed++) {
      const { units, lines, spans } = caseOf(seed);
      if (lines.length === 0) continue;
      const byText = (ls: readonly string[], ps: readonly string[]): string[] => ps.map((p) => `${ls[Number(p.split(":")[0])]}@${p.split(":")[1]}`).sort();
      const a = production(units, lines, spans);
      // Reversed lines are renumbered, so a range names its line's new index.
      const moved = spans.map((sp): Span => (typeof sp !== "string" && "at" in sp ? at(lines.length - 1 - Number(sp.at.part.slice(5)), sp.at.start, sp.at.end) : sp));
      const b = production([...units].reverse(), [...lines].reverse(), moved.reverse());
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
