// C2 (lead decision 3): the lines in fixtures/golden/goal-parts.ndjson are what a host decodes for a page form over 20
// fields, filled in parts: the first part's preview (segment 0 of 2, which says the form goes in parts), the second
// part's preview after the first part ran (reason moreFields, its own digest and expiry), and the goal's end. Cut from a
// page-rig run with a fixed clock (test/page-rig.ts) on a form of 22 text fields and a Submit button.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GoalProgress, HelperMessage } from "../src/protocol.ts";

const lines = readFileSync(new URL("../fixtures/golden/goal-parts.ndjson", import.meta.url), "utf8").trim().split("\n");
type Segment = Extract<GoalProgress, { event: "segment" }>;
const at = (i: number): GoalProgress => GoalProgress.parse(JSON.parse(lines[i] as string));

describe("the parts of a long page form (C2)", () => {
  it("parses every golden line and writes it back byte for byte", () => {
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(JSON.stringify(HelperMessage.parse(JSON.parse(l)))).toBe(l);
  });

  it("previews each part as its own segment of one goal, the second with reason moreFields", () => {
    const first = at(0) as Segment;
    const second = at(1) as Segment;
    expect(first).toMatchObject({ event: "segment", segment: 0, segments: 2, reason: "start", requestId: "a1" });
    expect(first.steps).toHaveLength(20);
    expect(first.warnings).toEqual(["Caret fills this form in 2 parts of up to 20 fields, each with its own preview and Tab."]);
    expect(second).toMatchObject({ event: "segment", goalId: first.goalId, segment: 1, segments: 2, reason: "moreFields", requestId: null, warnings: [] });
    expect(second.digest).not.toBe(first.digest);
    expect(second.steps.map((s) => s.says)).toEqual(["Answer 21: value 21", "Answer 22: value 22", "You press Submit"]);
    expect(at(2)).toMatchObject({ event: "finished", outcome: "done", verified: 22 });
  });

  it("refuses a segment reason no host knows", () => {
    expect(GoalProgress.safeParse({ ...JSON.parse(lines[1] as string), reason: "nextPart" }).success).toBe(false);
  });
});
