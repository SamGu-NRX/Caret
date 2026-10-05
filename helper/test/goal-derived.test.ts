// G3 (lead decision 1): a value the helper itself derived with no choice in it skips Jev's yes/no value question, and
// keeps the never-typed and kind-fit checks: a reply's To that code fills with the answered message's sender, and a
// calendar event the event adapter built from a sentence's person and resolved time. A value the writer picked, even
// with the same text, still goes to Jev, and nothing a program sends can make a value or a step count as derived.
// Every name and number is invented.
import { afterEach, describe, expect, it } from "vitest";
import { runCodePlan } from "../src/codemode/sandbox.ts";
import { DoneMessage } from "../src/codemode/types.ts";
import { buildInventory } from "../src/goals/inventory.ts";
import { lowerGoal } from "../src/goals/lower.ts";
import type { GoalInventory, ValueBinding } from "../src/goals/plan.ts";
import { macClock } from "../src/offers/event-time.ts";
import type { GoalProgress } from "../src/protocol.ts";
import { cannedProgram, fieldKey, goalScene, MAIL, mailWindow, replyWindow, standInJev, textField, type CannedStep, type DeskWindow, type GoalScene } from "./goal-desk.ts";

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
const says = (g: Segment): string[] => g.steps.map((s) => s.says);

const EMAIL = "priya.raman@northwind.example";
const MESSAGE: CannedStep = { draft: { window: "Re: Order", target: "Message", text: "I'm in.", from: [] } };
const MEETING: CannedStep = { fill: { window: "Calendar", target: "Caret", value: "Meet Priya" } };
/** Jev's value questions (fill's choice question with yes/no criteria), not drafts.ts's claim checks. */
const valueQuestions = (jev: ReturnType<typeof standInJev>): number => jev.calls - jev.claimCalls;

describe("a value code derived with no choice skips Jev's value question", () => {
  it("fills a reply's To with the answered message's sender without asking Jev, even a Jev that would say no", async () => {
    const jev = standInJev({ belongs: () => false });
    const sc = scene({ scripts: [[MESSAGE]], windows: [mailWindow(), replyWindow()], userWindow: "6161-2", askJev: jev });
    const g = preview(await sc.request("draft a reply to Priya saying I'm in"));
    expect(says(g)).toEqual([`To: ${EMAIL}`, "Message: I'm in."]);
    expect(valueQuestions(jev)).toBe(0);
    expect(jev.asked.filter((q) => q.includes(EMAIL))).toEqual([]);
  });

  it("adds a calendar event the event adapter built without asking Jev, even a Jev that would say no", async () => {
    const jev = standInJev({ belongs: () => false });
    const sc = scene({ scripts: [[MEETING]], windows: [mailWindow(), replyWindow()], userWindow: "6161-2", askJev: jev });
    const g = preview(await sc.request("add this meeting to my calendar"));
    expect(says(g)).toEqual([expect.stringMatching(/^Add 'Meet Priya' to your Caret calendar/)]);
    expect(jev.calls).toBe(0);
  });

  it("adds the derived event and To with no Jev at all, and still writes no copied value then", async () => {
    const sc = scene({ scripts: [[MEETING, MESSAGE]], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const g = preview(await sc.request("add this meeting to my calendar and draft a reply to Priya saying I'm in"));
    expect(g.warnings).toEqual([]);
    expect(g.segments).toBe(2);
  });

  it("keeps the kind-fit check on a derived To", async () => {
    const reply: DeskWindow = { ...replyWindow(), nodes: [textField(MAIL, "To phone number"), ...replyWindow().nodes.slice(1)] };
    const jev = standInJev();
    const sc = scene({ scripts: [[MESSAGE]], windows: [mailWindow(), reply], userWindow: "6161-2", askJev: jev });
    const g = preview(await sc.request("draft a reply to Priya saying I'm in"));
    expect(says(g)).toEqual(["Message: I'm in."]);
    expect(g.warnings).toEqual([`You add the recipient in 'To phone number': '${EMAIL}' is an email address, and the field takes a phone number.`]);
  });
});

describe("a value the writer picked still goes to Jev", () => {
  it("asks Jev about the sender when the program itself put it in To, and leaves To to the user when Jev says no", async () => {
    const jev = standInJev({ belongs: (q) => !q.includes("'To'") });
    const sc = scene({ scripts: [[{ fill: { window: "Re: Order", target: "To", value: EMAIL } }, MESSAGE]], windows: [mailWindow(), replyWindow()], userWindow: "6161-2", askJev: jev });
    const g = preview(await sc.request("draft a reply to Priya saying I'm in"));
    expect(jev.asked.filter((q) => q.includes(`"${EMAIL}" (the sender of the message this reply answers`))).toHaveLength(2);
    expect(says(g)).toEqual(["Message: I'm in."]);
    expect(g.warnings).toEqual([`You add the recipient in 'To': Jev didn't confirm '${EMAIL}' belongs there.`]);
  });
});

describe("nothing a program sends counts as derived", () => {
  it("the worker's plan schema refuses a step or a draft that carries a mark of its own", () => {
    const plan = (steps: unknown[], drafts: unknown[] = []) => ({ type: "done", outcome: { ok: true, plan: { basedOn: "s1", window: "w1", steps, choices: [], drafts, programDigest: "0".repeat(64) }, stats: { wallMs: 0, guestCpuMs: 0, readWindowCalls: 0, chooseCalls: 0, steps: 0 } } });
    expect(DoneMessage.safeParse(plan([{ ref: "a", kind: "fill", target: "t1", value: "v1" }])).success).toBe(true);
    expect(DoneMessage.safeParse(plan([{ ref: "a", kind: "fill", target: "t1", value: "v1", gate: "derived" }])).success).toBe(false);
    expect(DoneMessage.safeParse(plan([{ ref: "a", kind: "fill", target: "t1", value: "v1", derived: true }])).success).toBe(false);
    expect(DoneMessage.safeParse(plan([], [{ ref: "d1", text: "Meet Priya", from: [], origin: { kind: "derived" } }])).success).toBe(false);
  });

  /** The desk's inventory for the meeting, its program run in the sandbox, and lowering with a counting Jev. */
  async function meeting(sc: GoalScene, swap: (inv: GoalInventory) => GoalInventory, steps: CannedStep[] = [MEETING]) {
    const inv = buildInventory(sc.helper.model, { instruction: "add this meeting to my calendar", windows: ["6161-2"], memory: [], calendar: "Caret", clock: macClock(new Date(sc.desk.at)), now: sc.desk.at, readerSession: 1 });
    const ran = await runCodePlan(cannedProgram(inv.snapshots, steps), inv.snapshots, async () => null, { multiWindow: true, drafts: true });
    if (!ran.ok) throw new Error(`sandbox ${ran.kind}: ${ran.detail}`);
    const jev = standInJev();
    const plan = await lowerGoal("goal-g3", "add this meeting to my calendar", ran.plan, swap(inv.inventory), { askJev: jev, ledger: inv.ledger });
    return { plan, jev };
  }

  it("an event value of the same shape that the helper did not build goes to Jev", async () => {
    const sc = scene({ scripts: [], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const real = await meeting(sc, (inv) => inv);
    expect(real.jev.calls).toBe(0);
    const copied = await meeting(sc, (inv) => ({ ...inv, values: new Map([...inv.values].map(([k, v]): [string, ValueBinding] => [k, structuredClone(v)])) }));
    expect(copied.jev.asked.filter((q) => q.includes("'the Caret calendar'"))).toHaveLength(2);
    expect(copied.plan.segments.flatMap((s) => s.steps.map((x) => x.gate))).toEqual(["jev"]);
  });

  it("GoalRuns refuses a plan whose step says derived when lowering did not mark it", async () => {
    const sc = scene({ scripts: [], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const { plan } = await meeting(sc, (inv) => inv);
    expect(plan.segments.flatMap((s) => s.steps.map((x) => x.gate))).toEqual(["derived"]);
    const forged = structuredClone({ ...plan, goalId: "goal-forged" });
    expect(() => sc.helper.goals.propose(forged, sc.session, null)).toThrow(/without passing the value gates/);
    // The plan lowering made is offered.
    expect(sc.helper.goals.propose(plan, sc.session, null).event).toBe("segment");
  });

  it("a reply's To step the program wrote, whatever its ref, is still Jev's to confirm", async () => {
    const sc = scene({ scripts: [], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const { plan, jev } = await meeting(sc, (inv) => inv, [{ fill: { window: "Re: Order", target: "To", value: EMAIL } }]);
    const to = plan.segments.flatMap((s) => s.steps).find((x) => x.target.key === fieldKey(MAIL, "To"));
    expect(to?.gate).toBe("jev");
    expect(jev.asked.filter((q) => q.includes(EMAIL))).toHaveLength(2);
  });
});
