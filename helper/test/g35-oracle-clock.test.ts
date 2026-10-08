// The scripted oracle reads candidates with the fixed generator clock the tests use (fill/candidates.ts
// setGeneratorClock), so a machine under load can't cut a candidate list and flip a scored Ask (G35: b31-04 and ask-17
// flipped right -> refused about 1 run in 20). Live engines keep the wall clock, the product's real 15 ms budget.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectCandidates, setGeneratorClock } from "../src/fill/candidates.ts";
import { Snapshot } from "../src/protocol.ts";
import { buildDesk, generatorClock, loadCorpus, pageForm, T0 } from "../scripts/realfill-corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
afterEach(() => setGeneratorClock(null));

describe("the oracle's generator clock", () => {
  it("is fixed for the canned engine and the wall clock for a live one, unless a run names one", () => {
    expect(generatorClock("canned")?.()).toBe(0);
    expect(generatorClock("jev")).toBeNull();
    expect(generatorClock("llama")).toBeNull();
    expect(generatorClock("jev", "fixed")?.()).toBe(0);
    expect(generatorClock("canned", "wall")).toBeNull();
    expect(() => generatorClock("canned", "slow")).toThrow(/--generator-clock/u);
  });

  it("reads b31-04's whole candidate list however slow the machine, where a slow wall clock cuts it", () => {
    const form = corpus.forms.find((f) => f.id === "greenhouse-apply") ?? (() => { throw new Error("no form"); })();
    const desk = buildDesk(corpus, snaps, form, pageForm(form));
    const read = () => collectCandidates(desk.model, desk.form.window.windowId, { now: T0 });
    // A machine under load: 40 ms passes between every clock read.
    let t = 0;
    setGeneratorClock(() => (t += 40));
    const slow = read();
    expect(slow.stats.overBudget).toBe(true);
    setGeneratorClock(generatorClock("canned"));
    const fixed = read();
    expect(fixed.stats.overBudget).toBe(false);
    expect(fixed.candidates.length).toBeGreaterThan(slow.candidates.length);
    expect(fixed.candidates.map((c) => c.text)).toContain("The University of Texas at Austin");
  });
});
