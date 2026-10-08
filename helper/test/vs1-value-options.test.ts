// Value settlement: one option of an Ask's value question is one exact proposed field value. Code converts each
// candidate for the field first (the option a menu selects, the ticked box, the date in the input's format, the number a
// currency field takes) and states that output; candidates the existing shape, cut and privacy vetoes reject are not
// offered. Two members share an option only when everything that could make them differ is identical: the output, the
// source evidence unit, where it came from, the label it was read beside, its owner and every assumption code made.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { groupOptions, type OptionMember } from "../src/fill/value-options.ts";
import { runB31, valueQuestions } from "./vs1-kit.ts";

beforeEach(() => setGeneratorClock(() => 0));
afterEach(() => setGeneratorClock(null));

const member = (id: string, o: Partial<OptionMember> = {}): OptionMember => ({ id, output: "April", evidence: "note-1", origin: "window", label: "Birthday", owner: null, assumptions: [], verifier: false, ...o });

describe("grouping exact outputs (pure)", () => {
  it("collapses aliases with identical evidence and assumptions, keeping every member in order", () => {
    const g = groupOptions([member("c2"), member("d4"), member("c9", { output: "May" })]);
    expect(g.map((o) => [o.id, o.output, o.members.map((m) => m.id)])).toEqual([["c2", "April", ["c2", "d4"]], ["c9", "May", ["c9"]]]);
  });

  it("keeps apart different outputs, units, origins, labels, owners and assumptions", () => {
    const apart: [string, Partial<OptionMember>][] = [
      ["a different date", { output: "2027-01-05" }],
      ["the same text in another note (one with a disclaimer)", { evidence: "note-2" }],
      ["memory beside the screen", { origin: "memory", evidence: "about-1" }],
      ["another phone purpose", { label: "Office" }],
      ["another owner", { owner: "other" }],
      ["an assumed year", { assumptions: ["year 2026: the next October 17"] }],
    ];
    for (const [why, o] of apart) {
      const g = groupOptions([member("c1"), member("c2", o)]);
      expect(g.map((x) => x.id), why).toEqual(["c1", "c2"]);
    }
  });

  it("an option needs the verifier when any of its members does, and keeps each member's provenance", () => {
    const g = groupOptions([member("c1"), member("d1", { verifier: true })]);
    expect(g).toHaveLength(1);
    expect(g[0]?.verifier).toBe(true);
    expect(g[0]?.members.map((m) => m.verifier)).toEqual([false, true]);
  });

  it("does not merge similar text: case, spacing and punctuation are different outputs", () => {
    expect(groupOptions([member("c1", { output: "Apt 2" }), member("c2", { output: "apt 2" }), member("c3", { output: "Apt  2" })]).map((o) => o.id)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("each option states the exact output Caret would write (B31 desks)", () => {
  it("a whole birthday is never an option for Day or Year", async () => {
    const r = await runB31("b31-02");
    for (const label of ["Month", "Day", "Year"]) {
      const qs = valueQuestions(r, label);
      for (const q of qs) expect(q.options.map((o) => o.output), label).not.toContain("04/12/1990");
    }
  });

  it("a currency field is offered the number it takes, not the amount with its sign", async () => {
    const r = await runB31("b31-07");
    const [q] = valueQuestions(r, "Monthly rent ($)");
    expect(q?.options.map((o) => o.output)).toContain("1,450");
    expect(q?.options.map((o) => o.output)).not.toContain("$1,450");
  });

  it("a menu's option is the option itself, with the conversion said", async () => {
    const r = await runB31("b31-15");
    const [q] = valueQuestions(r, "Pizza Size");
    const large = q?.options.find((o) => o.output === "Large");
    expect(large).toBeDefined();
    expect(large?.criterion).toMatch(/Derivation: (?!literal copy)/u);
    expect(q?.options.map((o) => o.output)).not.toContain("Large, mushroom and onion");
  });

  it("a box is offered its ticked state, said as such, never as another conversion", async () => {
    const r = await runB31("b31-15");
    const [q] = valueQuestions(r, "Onion");
    expect(q?.options.find((o) => o.output === "checked")?.criterion).toMatch(/Derivation: the box ticked, as the supporting text says it should be\.$/u);
  });

  it("a date input is offered the date in its own format, never the sentence it was read from", async () => {
    const r = await runB31("b31-13");
    const [q] = valueQuestions(r, "Preferred date");
    expect(q?.options.map((o) => o.output)).toContain("2026-10-17");
    expect(q?.options.map((o) => o.output)).not.toContain("Saturday, October 17 at 8:45am");
  });

  it("states every part of the criterion, in the order the design gives it", async () => {
    const r = await runB31("b31-07");
    const [q] = valueQuestions(r, "Monthly rent ($)");
    for (const o of q?.options.filter((x) => x.id !== "none") ?? []) expect(o.criterion).toMatch(/^Proposed value: ".*"\. Source: .+\. Observed label: .+\. Supporting text: .+\. Derivation: .+\.$/su);
    expect(q?.options.find((o) => o.id === "none")?.criterion).toBe("No listed proposed value is supported for this field under the request; the needed value may be absent, ambiguous, or not represented in a usable form.");
  });
});
