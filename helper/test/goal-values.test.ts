// G2: every value a goal writes passes the gates Ask's fill passes, before the preview. The value's kind must fit the
// field, Jev must confirm it belongs there with fill's question and floor, and a kind Caret never types is never
// written. A write that fails is dropped from the plan, and the preview says why. Every name and number is invented.
import { afterEach, describe, expect, it } from "vitest";
import type { GoalProgress } from "../src/protocol.ts";
import { caseWindow, detailsWindow, goalScene, mailWindow, standInJev, SUPPORT, textField, type CannedStep, type DeskWindow, type GoalScene } from "./goal-desk.ts";

const scenes: GoalScene[] = [];
afterEach(async () => {
  for (const s of scenes.splice(0)) await s.close();
});
const scene = (o: Parameters<typeof goalScene>[0]): GoalScene => {
  const s = goalScene(o);
  scenes.push(s);
  return s;
};
type Segment = Extract<GoalProgress, { event: "segment" }>;
const preview = (g: GoalProgress): Segment => {
  if (g.event !== "segment") throw new Error(`no preview: ${JSON.stringify(g)}`);
  return g;
};
const says = (g: GoalProgress): string[] => (g.event === "segment" ? g.steps.map((s) => s.says) : []);

const ORDER = "ORD-2026-48213";
const EMAIL = "priya.raman@northwind.example";
const PROBLEM = "The desk lamp arrived with a cracked base and does not switch on.";
const supportDesk = (): DeskWindow[] => [mailWindow(), caseWindow(), detailsWindow()];
/** M2's live qwen3.8 plan on scene 1: the sender's email in Order number, then the problem in Description. */
const EMAIL_IN_ORDER: CannedStep[] = [
  { fill: { window: "New case", target: "Order number", value: EMAIL } },
  { fill: { window: "Case details", target: "Description", value: "cracked base" } },
];
const INSTRUCTION = "copy the order number from the email into the support case, then put the problem from the email in the case description";

describe("a goal value's kind must fit its field", () => {
  it("drops an email address proposed for Order number before the preview, and the preview says why", async () => {
    const sc = scene({ scripts: [EMAIL_IN_ORDER], windows: supportDesk(), userWindow: "7171-1", askJev: standInJev() });
    const g = preview(await sc.request(INSTRUCTION));
    // The one write left is Description's; Order number is not a step of any segment.
    expect([g.segments, says(g)]).toEqual([1, [`Description: ${PROBLEM}`]]);
    expect(g.warnings).toEqual([`Caret left 'Order number' empty: '${EMAIL}' is an email address, and the field takes a number or code.`]);
    expect(sc.desk.writes).toEqual([]);
  });

  it("refuses the goal, saying why, when every write it planned is dropped", async () => {
    const sc = scene({ scripts: [[EMAIL_IN_ORDER[0] as CannedStep]], windows: supportDesk(), userWindow: "7171-1", askJev: standInJev() });
    const g = await sc.request(INSTRUCTION);
    expect(g.event === "stopped" && [g.reason, g.says]).toEqual(["refused", `Caret left 'Order number' empty: '${EMAIL}' is an email address, and the field takes a number or code`]);
  });
});

describe("Jev confirms each value belongs in its field, with fill's question and floor", () => {
  it("asks Jev about every copied value, both wordings, and drops a write Jev does not confirm", async () => {
    const jev = standInJev({ belongs: (q) => !q.includes("'Description'") });
    const sc = scene({ scripts: [[{ fill: { window: "New case", target: "Order number", value: ORDER } }, { fill: { window: "Case details", target: "Description", value: "cracked base" } }]], windows: supportDesk(), userWindow: "7171-1", askJev: jev });
    const g = preview(await sc.request(INSTRUCTION));
    expect(says(g)).toEqual([`Order number: ${ORDER}`]);
    expect(g.warnings).toEqual([`Caret left 'Description' empty: Jev didn't confirm '${PROBLEM.slice(0, 59)}…' belongs there.`]);
    // Ask's question, in both of its wordings, for each of the two writes.
    expect(jev.asked.filter((q) => q.startsWith("A form has the field 'Order number'. Is this value the right one for it?"))).toHaveLength(1);
    expect(jev.asked.filter((q) => q.includes("Field: 'Order number'. The user asked:") && q.includes("Does this value belong in this field?"))).toHaveLength(1);
    expect(jev.asked.filter((q) => q.includes("'Description'"))).toHaveLength(2);
  });

  it("drops a write Jev confirms under fill's floor", async () => {
    const sc = scene({ scripts: [[{ fill: { window: "New case", target: "Order number", value: ORDER } }]], windows: supportDesk(), userWindow: "7171-1", askJev: standInJev({ p: 0.7 }) });
    const g = await sc.request(INSTRUCTION);
    expect(g.event === "stopped" && g.says).toBe(`Caret left 'Order number' empty: Jev didn't confirm '${ORDER}' belongs there`);
  });

  it("writes no copied value when Jev is not there", async () => {
    const sc = scene({ scripts: [[{ fill: { window: "New case", target: "Order number", value: ORDER } }]], windows: supportDesk(), userWindow: "7171-1" });
    const g = await sc.request(INSTRUCTION);
    expect(g.event === "stopped" && g.says).toBe(`Caret left 'Order number' empty: Caret couldn't ask Jev whether '${ORDER}' belongs there`);
  });
});

describe("a kind Caret never types is never written by a goal", () => {
  it("drops a card number the instruction quotes, whatever field it is planned for", async () => {
    const notes: DeskWindow = { windowId: "7171-4", app: SUPPORT, title: "Support — Notes", nodes: [textField(SUPPORT, "Notes"), textField(SUPPORT, "Reference")] };
    const steps: CannedStep[] = [
      { fill: { window: "Notes", target: "Notes", value: "4111 1111 1111 1111" } },
      { fill: { window: "Notes", target: "Reference", value: ORDER } },
    ];
    const sc = scene({ scripts: [steps], windows: [mailWindow(), notes], userWindow: "7171-4", askJev: standInJev() });
    const g = preview(await sc.request(`put "4111 1111 1111 1111" in the notes and the order number in Reference`));
    expect(says(g)).toEqual([`Reference: ${ORDER}`]);
    expect(g.warnings).toEqual(["Caret left 'Notes' empty: Caret never types card numbers; that is yours to enter."]);
  });
});
