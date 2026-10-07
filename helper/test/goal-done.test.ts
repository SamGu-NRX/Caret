// G2: a goal ends done only when every step it planned was written and read back and nothing its windows' own kind
// requires is missing. A write code dropped, a field the form marks required and a message's recipient are listed as
// what is left; a goal with any of them ends partial, or handed off when only the recipient (and the user's own press)
// is left. Every name and number is invented.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GoalProgress } from "../src/protocol.ts";
import { areaKey, button, caseWindow, detailsWindow, fieldKey, goalScene, MAIL, mailWindow, replyWindow, standInJev, SUPPORT, textArea, textField, type CannedStep, type DeskWindow, type GoalScene } from "./goal-desk.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import { STAND_IN } from "./setup/verifier.ts";

// W2: the write contract's verifier asks this file's stand-in Jev (goal-desk.ts standInJev: `belongs` decides), not the suite's.
beforeAll(() => setTestVerifier(null));
afterAll(() => setTestVerifier(STAND_IN));

const scenes: GoalScene[] = [];
afterEach(async () => {
  for (const s of scenes.splice(0)) await s.close();
});
const scene = (o: Parameters<typeof goalScene>[0]): GoalScene => {
  const s = goalScene({ askJev: standInJev(), ...o });
  scenes.push(s);
  return s;
};
type Segment = Extract<GoalProgress, { event: "segment" }>;
type Finished = Extract<GoalProgress, { event: "finished" }>;
const preview = (g: GoalProgress): Segment => {
  if (g.event !== "segment") throw new Error(`no preview: ${JSON.stringify(g)}`);
  return g;
};
/** Accepts every preview of the goal as the user would, then returns how it ended. */
async function runAll(sc: GoalScene, goalId: string): Promise<GoalProgress | undefined> {
  for (let i = 0; i < 6; i++) {
    await sc.helper.goals.idle();
    if (sc.helper.goals.get(goalId)?.state !== "awaiting") break;
    await sc.accept(goalId);
  }
  await sc.helper.goals.idle();
  return sc.goals.filter((g) => g.goalId === goalId && (g.event === "finished" || g.event === "stopped")).at(-1);
}

const EMAIL = "priya.raman@northwind.example";
const PROBLEM = "The desk lamp arrived with a cracked base and does not switch on.";

describe("a goal that leaves a planned write undone is never done", () => {
  it("ends partial, listing the field whose value code dropped (M2 scene 1)", async () => {
    const steps: CannedStep[] = [
      { fill: { window: "New case", target: "Order number", value: EMAIL } },
      { fill: { window: "Case details", target: "Description", value: "cracked base" } },
    ];
    const sc = scene({ scripts: [steps], windows: [mailWindow(), caseWindow(), detailsWindow()], userWindow: "7171-1" });
    const g = preview(await sc.request("copy the order number from the email into the support case, then the problem into the description"));
    const end = await runAll(sc, g.goalId);
    expect(sc.desk.node("7171-2", areaKey(SUPPORT, "Description"))?.value).toBe(PROBLEM);
    expect(end?.event === "finished" && [end.outcome, end.left, end.says]).toEqual([
      "partial",
      [`Caret left 'Order number' empty: '${EMAIL}' is an email address, and the field takes a number or code`],
      "Partly done: 1 step verified. Left for you: 'Order number'.",
    ]);
    expect(GoalProgress.safeParse(end).success).toBe(true);
  });
});

describe("a reply's recipient", () => {
  const message: CannedStep = { draft: { window: "Re: Order", target: "Message", text: "I'm in.", from: [] } };

  it("is filled by code with the answered message's sender when the program leaves To out", async () => {
    const sc = scene({ scripts: [[message]], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const g = preview(await sc.request("draft a reply to Priya saying I'm in"));
    expect(g.steps.map((s) => s.says)).toEqual([`To: ${EMAIL}`, "Message: I'm in."]);
    expect(g.warnings).toEqual([]);
    const end = await runAll(sc, g.goalId);
    expect(sc.desk.node("6161-2", fieldKey(MAIL, "To"))?.value).toBe(EMAIL);
    expect(end?.event === "finished" && [end.outcome, end.left]).toEqual(["done", []]);
  });

  // G3: code's own To skips Jev (goal-derived.test.ts); a To the program wrote is the writer's pick.
  it("is put to the write contract's verifier with where it was read when the program wrote To itself (W2)", async () => {
    const jev = standInJev();
    const sc = scene({ scripts: [[{ fill: { window: "Re: Order", target: "To", value: EMAIL } }, message]], windows: [mailWindow(), replyWindow()], userWindow: "6161-2", askJev: jev });
    preview(await sc.request("draft a reply to Priya saying I'm in"));
    expect(jev.asked.filter((q) => q.includes(`"${EMAIL}"`) && q.includes("Order ORD-2026-48213 arrived damaged"))).toHaveLength(2);
  });

  it("is the user's to add when no sender can be found, and the goal ends handed off, never done", async () => {
    const sc = scene({ scripts: [[message]], windows: [replyWindow()], userWindow: "6161-2" });
    const g = preview(await sc.request("draft a reply saying I'm in"));
    expect(g.steps.map((s) => s.says)).toEqual(["Message: I'm in."]);
    expect(g.warnings).toEqual(["You add the recipient in 'To': Caret found no sender of a message this one answers."]);
    const end = await runAll(sc, g.goalId);
    expect(sc.desk.node("6161-2", areaKey(MAIL, "Message"))?.value).toBe("I'm in.");
    expect(end?.event === "finished" && [end.outcome, end.left, end.says]).toEqual([
      "handoff",
      ["You add the recipient in 'To': Caret found no sender of a message this one answers"],
      "Ready: 1 done. You add the recipient in 'To'.",
    ]);
  });

  it("is the user's to add when Jev does not confirm the sender the program wrote, with Send still the user's", async () => {
    const steps: CannedStep[] = [{ fill: { window: "Re: Order", target: "To", value: EMAIL } }, message, { press: { window: "Re: Order", target: "Send", effect: "e:yours" } }];
    const sc = scene({ scripts: [steps], windows: [mailWindow(), replyWindow()], userWindow: "6161-2", askJev: standInJev({ belongs: (q) => !q.includes("'To'") }) });
    const g = preview(await sc.request("draft a reply to Priya saying I'm in"));
    expect(g.steps.map((s) => s.says)).toEqual(["Message: I'm in.", "'Send' reads as outbound; you press it"]);
    const end = await runAll(sc, g.goalId);
    expect(sc.desk.node("6161-2", fieldKey(MAIL, "To"))?.value).toBeUndefined();
    expect(end?.event === "finished" && [end.outcome, end.says]).toEqual(["handoff", "Ready: 1 done. You add the recipient in 'To'. 'Send' reads as outbound; you press it."]);
  });
});

describe("an event the instruction asks for", () => {
  const message: CannedStep = { draft: { window: "Re: Order", target: "Message", text: "I'm in.", from: [] } };

  it("is left when the plan adds none, so the goal is partial (B30 b30-04 live on gpt-oss-20b said Done)", async () => {
    const sc = scene({ scripts: [[message]], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const g = preview(await sc.request("add this meeting to my calendar and draft a reply to Priya saying I'm in"));
    expect(g.warnings).toEqual(["You asked for a calendar event, and this plan adds none to your 'Caret' calendar."]);
    const end = await runAll(sc, g.goalId);
    expect(end?.event === "finished" && [end.outcome, end.left]).toEqual(["partial", ["You asked for a calendar event, and this plan adds none to your 'Caret' calendar"]]);
  });

  it("is not asked for when the instruction says not to add one", async () => {
    const sc = scene({ scripts: [[message]], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const g = preview(await sc.request("draft a reply to Priya saying I'm in. Do not put it on my calendar."));
    expect(g.warnings).toEqual([]);
    const end = await runAll(sc, g.goalId);
    expect(end?.event === "finished" && end.outcome).toBe("done");
  });

  it("is done when the plan adds it", async () => {
    const steps: CannedStep[] = [{ fill: { window: "Calendar", target: "Caret", value: "Meet Priya" } }, message];
    const sc = scene({ scripts: [steps], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const g = preview(await sc.request("add this meeting to my calendar and draft a reply to Priya saying I'm in"));
    expect(g.warnings).toEqual([]);
    const end = await runAll(sc, g.goalId);
    expect(end?.event === "finished" && [end.outcome, end.left]).toEqual(["done", []]);
  });
});

describe("a required field the plan leaves empty", () => {
  const form = (): DeskWindow => ({ windowId: "7171-5", app: SUPPORT, title: "Support — Warranty claim", nodes: [textField(SUPPORT, "Order number"), textField(SUPPORT, "Serial number *"), textArea(SUPPORT, "Notes"), button(SUPPORT, "Save")] });
  const steps: CannedStep[] = [{ fill: { window: "Warranty claim", target: "Order number", value: "ORD-2026-48213" } }];

  it("is named in the preview and makes the goal partial", async () => {
    const sc = scene({ scripts: [steps], windows: [mailWindow(), form()], userWindow: "7171-5" });
    const g = preview(await sc.request("put the order number from the email in the warranty claim"));
    expect(g.warnings).toEqual(["'Serial number' is required, and this plan leaves it empty."]);
    const end = await runAll(sc, g.goalId);
    expect(end?.event === "finished" && [end.outcome, end.left]).toEqual(["partial", ["'Serial number' is required, and this plan leaves it empty"]]);
  });

  it("is not left when it holds text by the time the goal ends", async () => {
    const sc = scene({ scripts: [steps], windows: [mailWindow(), form()], userWindow: "7171-5" });
    const g = preview(await sc.request("put the order number from the email in the warranty claim"));
    sc.desk.set("7171-5", fieldKey(SUPPORT, "Serial number *"), "SN-55102");
    const end = await runAll(sc, g.goalId);
    expect(end?.event === "finished" && [end.outcome, end.left]).toEqual(["done", []]);
  });
});

describe("the finished message", () => {
  const done = (over: Record<string, unknown>) => ({ type: "goalProgress", v: 1, at: 1, goalId: "g", requestId: null, event: "finished", outcome: "done", verified: 1, skipped: 0, left: [], says: "Done: 1 step verified.", ...over });
  it("lists what is left, and only done may leave nothing", () => {
    expect(GoalProgress.safeParse(done({})).success).toBe(true);
    expect(GoalProgress.safeParse(done({ outcome: "partial", left: ["x"] })).success).toBe(true);
    expect(GoalProgress.safeParse(done({ left: ["x"] })).success).toBe(false);
    expect(GoalProgress.safeParse(done({ outcome: "partial" })).success).toBe(false);
    expect(GoalProgress.safeParse(done({ left: undefined })).success).toBe(false);
  });
});
