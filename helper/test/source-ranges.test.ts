// The one map from collapsed text back to raw offsets (privacy/ledger/source.ts collapsedMap), and the fill candidate
// generator's reading of it through bareLine (fill/candidates.ts bareMap): each must read a line exactly as the reader it
// stands beside does, or a recorded range would point at other characters.
import { describe, expect, it } from "vitest";
import { collapsedMap, sourceLine } from "../src/privacy/ledger/source.ts";
import { bareMap } from "../src/fill/candidates.ts";
import { bareLine } from "../src/fill/line-values.ts";
import { rng } from "./large-scene.ts";

describe("the collapse map", () => {
  const ALPHA = ["a", "B", " ", "  ", "\t", " ", " ", "-", "•", "*", ":", "é", "😀", ",", "　"];
  const gen = (r: () => number): string => Array.from({ length: Math.floor(r() * 16) }, () => ALPHA[Math.floor(r() * ALPHA.length)]).join("");

  it("reads every text as sourceLine and bareLine do, each character from the raw offset it maps to", () => {
    const r = rng(11);
    for (let n = 0; n < 5000; n++) {
      const raw = gen(r);
      const c = collapsedMap(raw);
      expect(c.text).toBe(sourceLine(raw));
      c.from.forEach((p, k) => expect(c.text[k] === " " ? /\s/u.test(raw[p]!) : raw[p] === c.text[k]).toBe(true));
      const b = bareMap(raw);
      expect(b.line).toBe(bareLine(raw));
      b.from.forEach((p, k) => expect(b.line[k] === " " ? /\s/u.test(raw[p]!) : raw[p] === b.line[k]).toBe(true));
    }
  });
});
