// I6: the lines in fixtures/golden/goal-handoff.ndjson are what a host decodes for a page plan's hand-off row: a preview
// whose last row, after an attach row, names the form's one forward button ("You press Next"); a preview of a form with
// two forward buttons, whose row says "The rest is yours"; a preview with the row alone after its writes; and that
// goal's end, whose sentence closes with the row. Cut from page-rig runs with a fixed clock (test/page-rig.ts), each
// in its own helper (so each goal is goal-2-a1). The row is a step view of kind "handoff" with no field of its own.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GoalProgress, HelperMessage } from "../src/protocol.ts";

const lines = readFileSync(new URL("../fixtures/golden/goal-handoff.ndjson", import.meta.url), "utf8").trim().split("\n");
type Segment = Extract<GoalProgress, { event: "segment" }>;
const segment = (i: number): Segment => GoalProgress.parse(JSON.parse(lines[i] as string)) as Segment;

describe("the hand-off row protocol lines (I6)", () => {
  it("parses every golden line and writes it back byte for byte", () => {
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(JSON.stringify(HelperMessage.parse(JSON.parse(l)))).toBe(l);
  });

  it("puts the row last, after the attach rows, as a step with no file", () => {
    expect(segment(0).steps.slice(-2)).toEqual([
      { index: 2, kind: "attach", says: "Resume: a file you choose", file: { source: "choose" } },
      { index: 3, kind: "handoff", says: "You press Next" },
    ]);
    expect(segment(1).steps.at(-1)).toEqual({ index: 2, kind: "handoff", says: "The rest is yours" });
    expect(segment(2).steps.at(-1)).toEqual({ index: 2, kind: "handoff", says: "You press Next" });
    const end = GoalProgress.parse(JSON.parse(lines[3] as string));
    expect(end).toMatchObject({ event: "finished", outcome: "done", says: "Done: 2 steps verified. You press Next." });
  });
});
