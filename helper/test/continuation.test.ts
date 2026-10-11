// D2-06: accepted goal plans run one segment per acceptance, keep receipts in a cursor, never replay a mutation, and
// stop with a fresh preview when the screen moves under them. A real Helper and Executor on a synthetic desk that
// enforces the reader's act grants and press table; a canned writer.
import { afterEach, describe, expect, it } from "vitest";
import type { GoalProgress, ReaderVerb } from "../src/protocol.ts";
import { YOURS_EFFECT } from "../src/goals/capabilities.ts";
import { buildInventory } from "../src/goals/inventory.ts";
import { lowerGoal } from "../src/goals/lower.ts";
import { runCodePlan } from "../src/codemode/sandbox.ts";
import { macClock } from "../src/offers/event-time.ts";
import { areaKey, button, buttonKey, cannedProgram, standInJev, caseWindow, detailsWindow, fieldKey, goalScene, line, MAIL, mailWindow, replyWindow, SUPPORT, textKey, wizardWindow, type CannedStep, type DeskWindow, type GoalScene } from "./goal-desk.ts";

const scenes: GoalScene[] = [];
afterEach(async () => {
  for (const s of scenes.splice(0)) await s.close();
});
/** A desk scene; Jev's stand-in confirms every value unless the test brings its own (G2: no Jev writes nothing). */
const scene = (o: Parameters<typeof goalScene>[0]): GoalScene => {
  const s = goalScene({ askJev: standInJev(), ...o });
  scenes.push(s);
  return s;
};

type Segment = Extract<GoalProgress, { event: "segment" }>;
const segmentsOf = (sc: GoalScene, goalId: string): Segment[] => sc.goals.filter((g): g is Segment => g.goalId === goalId && g.event === "segment");
const last = <E extends GoalProgress["event"]>(sc: GoalScene, event: E): Extract<GoalProgress, { event: E }> | undefined => [...sc.goals].reverse().find((g): g is Extract<GoalProgress, { event: E }> => g.event === event);
const acts = (sc: GoalScene): ReaderVerb[] => sc.desk.verbs.filter((v) => v.kind === "write" || v.kind === "press");
const errors = (sc: GoalScene): string[] => sc.published.flatMap((m) => (m.type === "error" ? [m.message] : []));

const ORDER = "ORD-2026-48213";
const PROBLEM = "The desk lamp arrived with a cracked base and does not switch on.";
const TO_SUPPORT: CannedStep[] = [
  { fill: { window: "New case", target: "Order number", value: ORDER } },
  { fill: { window: "Case details", target: "Description", value: "cracked base" } },
];
const supportDesk = (): DeskWindow[] => [mailWindow(), caseWindow(), detailsWindow()];

describe("mail to support form: two windows, two acceptances", () => {
  it("runs each segment only after its own acceptance, under one grant for its one window, and finishes done", async () => {
    const sc = scene({ scripts: [TO_SUPPORT], windows: supportDesk(), userWindow: "7171-1" });
    const first = await sc.request("file a support case for the damaged order from the email");
    expect(first.event === "segment" && [first.segment, first.segments, first.reason, first.requestId, first.steps.map((s) => s.says)]).toEqual([0, 2, "start", "r1", [`Order number: ${ORDER}`]]);
    expect(acts(sc)).toEqual([]);

    const r1 = await sc.accept(first.goalId);
    expect(r1?.outcome).toBe("done");
    const second = segmentsOf(sc, first.goalId)[1];
    expect(second && [second.segment, second.reason, second.where, second.steps.map((s) => s.says)]).toEqual([1, "crossWindow", { kind: "window", app: "Support Fixture", title: "Support — Case details" }, [`Description: ${PROBLEM}`]]);
    // Nothing in the second window until its acceptance.
    expect(sc.desk.writes).toEqual([{ windowId: "7171-1", key: fieldKey(SUPPORT, "Order number"), value: ORDER }]);

    const r2 = await sc.accept(first.goalId);
    expect(r2?.outcome).toBe("done");
    expect(sc.desk.writes.map((w) => [w.windowId, w.value])).toEqual([["7171-1", ORDER], ["7171-2", PROBLEM]]);
    const fin = last(sc, "finished");
    expect(fin && [fin.outcome, fin.verified, fin.skipped, fin.says]).toEqual(["done", 2, 0, "Done: 2 steps verified."]);
    // One act grant per segment task, each for its one window, each revoked at its end.
    const grants = sc.desk.grants.log.filter((g) => g.type === "actGrant");
    expect(grants.map((g) => g.type === "actGrant" && [g.taskId, g.windowId])).toEqual([[`${first.goalId}:s0`, "7171-1"], [`${first.goalId}:s1`, "7171-2"]]);
    expect(sc.desk.grants.log.filter((g) => g.type === "actRevoke").map((g) => g.taskId)).toEqual([`${first.goalId}:s0`, `${first.goalId}:s1`]);
    // Step progress names each step once.
    expect(sc.goals.filter((g) => g.event === "step").map((g) => g.event === "step" && [g.segment, g.step, g.phase])).toEqual([[0, 0, "verified"], [1, 1, "verified"]]);
    const cursor = sc.helper.goals.get(first.goalId)?.cursor;
    expect(cursor && [cursor.segment, cursor.nextStep, cursor.receipts.map((r) => [r.step, r.status, r.before !== r.after])]).toEqual([1, 2, [[0, "verified", true], [1, "verified", true]]]);
    // P1: each verified step's receipt says how long it took from acting to verified.
    expect(cursor?.receipts.map((r) => typeof r.ms === "number" && r.ms >= 0)).toEqual([true, true]);
    expect(sc.desk.pressed).toEqual([]);
  });

  it("refuses a repeated acceptance of a segment that ran: nothing is dispatched again, and the goal goes on as it was", async () => {
    const sc = scene({ scripts: [TO_SUPPORT], windows: supportDesk(), userWindow: "7171-1" });
    const first = await sc.request("file a support case");
    await sc.accept(first.goalId);
    const before = acts(sc).length;
    // The same acceptance again, word for word.
    const again = await sc.accept(first.goalId, { segment: 0, digest: first.event === "segment" ? first.digest : "" });
    expect(again).toBeNull();
    expect(errors(sc).at(-1)).toMatch(/segment 1 of goal .* was already accepted; nothing runs twice/);
    expect(acts(sc).length).toBe(before);
    // Even after the user puts the field back, the receipt stands: the step is not run again.
    sc.desk.set("7171-1", fieldKey(SUPPORT, "Order number"), "");
    expect(await sc.accept(first.goalId, { segment: 0, digest: first.event === "segment" ? first.digest : "" })).toBeNull();
    expect(acts(sc).length).toBe(before);
    // Segment 2 still waits for its own acceptance.
    expect(sc.helper.goals.get(first.goalId)?.state).toBe("awaiting");
  });

  it("refuses an acceptance with another digest, for another segment, from another connection, or after the preview expired", async () => {
    const sc = scene({ scripts: [TO_SUPPORT], windows: supportDesk(), userWindow: "7171-1" });
    const first = await sc.request("file a support case");
    expect(await sc.accept(first.goalId, { digest: "0".repeat(64) })).toBeNull();
    expect(errors(sc).at(-1)).toMatch(/names another plan than the one shown/);
    expect(await sc.accept(first.goalId, { segment: 1 })).toBeNull();
    expect(errors(sc).at(-1)).toMatch(/waits for segment 1, not 2/);
    expect(await sc.accept(first.goalId, {}, "another-host")).toBeNull();
    expect(errors(sc).at(-1)).toMatch(/offered to another connection/);
    expect(await sc.accept("goal-404", { segment: 0, digest: "0".repeat(64) })).toBeNull();
    expect(acts(sc)).toEqual([]);
    sc.desk.at += 121_000;
    expect(await sc.accept(first.goalId)).toBeNull();
    expect(errors(sc).at(-1)).toMatch(/expired before it was accepted/);
    expect(last(sc, "stopped")?.reason).toBe("expired");
    expect(acts(sc)).toEqual([]);
  });
});

describe("equal values skip", () => {
  it("skips a write whose field already holds the planned value, with an alreadyTrue receipt and no dispatch", async () => {
    const sc = scene({ scripts: [TO_SUPPORT], windows: supportDesk(), userWindow: "7171-1" });
    const first = await sc.request("file a support case");
    // The user types exactly the planned value before accepting.
    sc.desk.set("7171-1", fieldKey(SUPPORT, "Order number"), ORDER);
    await sc.accept(first.goalId);
    expect(sc.desk.writes).toEqual([]);
    expect(sc.helper.goals.get(first.goalId)?.cursor.receipts.map((r) => [r.step, r.status, r.ms])).toEqual([[0, "alreadyTrue", null]]);
    expect(sc.goals.find((g) => g.event === "step")).toMatchObject({ phase: "skipped" });
  });

  it("refuses to run a segment whose field now holds other text, and offers a fresh plan that leaves it alone", async () => {
    const sc = scene({ scripts: [TO_SUPPORT, [{ fill: { window: "Case details", target: "Description", value: "cracked base" } }]], windows: supportDesk(), userWindow: "7171-1" });
    const first = await sc.request("file a support case");
    sc.desk.set("7171-1", fieldKey(SUPPORT, "Order number"), "ORD-OTHER");
    expect(await sc.accept(first.goalId)).toBeNull();
    const stop = last(sc, "stopped");
    expect(stop && [stop.reason, stop.freshPlan !== null]).toEqual(["targetChanged", true]);
    // A stop at acceptance's precheck, before any task ran, names no task to undo (Codex review on #22).
    expect(stop && "taskId" in stop).toBe(false);
    expect(stop?.says).toMatch(/^'Order number' changed since Caret planned this, so Caret stopped after 0 of 2 steps\. A fresh plan/);
    expect(acts(sc)).toEqual([]);
    const fresh = segmentsOf(sc, stop?.freshPlan ?? "")[0];
    expect(fresh && [fresh.reason, fresh.replaces, fresh.steps.map((s) => s.says)]).toEqual(["freshPlan", first.goalId, [`Description: ${PROBLEM}`]]);
  });
});

describe("stop and re-preview", () => {
  it("a dialog opening in the app mid-segment revokes the task before its next write and offers a fresh plan, which needs its own acceptance", async () => {
    const two: CannedStep[] = [
      { fill: { window: "Re: Order", target: "To", value: "priya.raman@northwind.example" } },
      { fill: { window: "Re: Order", target: "Message", value: "cracked base" } },
    ];
    const sc = scene({ scripts: [two, two.slice(1)], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const first = await sc.request("reply to Priya with the problem");
    // The first write lands; the app then opens a dialog of its own.
    sc.desk.afterAct = (v) => {
      if (v.kind !== "write") return;
      sc.desk.afterAct = null;
      sc.desk.show({ windowId: "6161-9", app: MAIL, title: "Spelling and Grammar", kind: "dialog", nodes: [button(MAIL, "Change")] });
    };
    const r = await sc.accept(first.goalId);
    expect(r?.outcome).toBe("stopped");
    expect(sc.desk.writes.map((w) => w.key)).toEqual([`${MAIL.bundleId}/standard/textfield:to~0`]);
    // The revoke reached the reader before any second write.
    expect(sc.desk.grants.log.at(-1)).toMatchObject({ type: "actRevoke", taskId: `${first.goalId}:s0` });
    const stop = last(sc, "stopped");
    // Stopped before step 2 (index 1), with step 1 verified.
    expect(stop && [stop.reason, stop.step, stop.says.startsWith("A new window 'Spelling and Grammar' opened in Mail Fixture, so Caret stopped after 1 of 2 steps.")]).toEqual(["dialog", 1, true]);
    // The executor's stop names the task that ran, whose undo ledger holds what it wrote (Codex review on #22).
    expect(stop?.taskId).toMatch(/:s0$/u);
    const fresh = segmentsOf(sc, stop?.freshPlan ?? "")[0];
    expect(fresh?.reason).toBe("freshPlan");
    // The stopped goal's segment cannot be accepted again; the fresh one runs once accepted, writing only what remains.
    expect(await sc.accept(first.goalId, { segment: 0, digest: first.event === "segment" ? first.digest : "" })).toBeNull();
    expect((await sc.accept(stop?.freshPlan ?? ""))?.outcome).toBe("done");
    expect(sc.desk.writes.map((w) => w.key)).toEqual([`${MAIL.bundleId}/standard/textfield:to~0`, areaKey(MAIL, "Message")]);
  });

  it("a page that reloads mid-segment stops as a reload with a fresh preview; nothing goes into the new page", async () => {
    let generation = 1;
    const form: DeskWindow = { windowId: "page:e1:4", app: { pid: 8181, bundleId: "com.google.Chrome", name: "Google Chrome" }, title: "Support request", kind: "page", nodes: [{ key: "f0/text:order number~0", parent: null, role: "AXTextField", label: "Order number", editable: true }, { key: "f0/textarea:description~0", parent: null, role: "AXTextArea", label: "Description", editable: true }] };
    const steps: CannedStep[] = [
      { fill: { window: "Support request", target: "Order number", value: ORDER } },
      { fill: { window: "Support request", target: "Description", value: "cracked base" } },
    ];
    const sc = scene({ scripts: [steps, steps], windows: [mailWindow(), form], userWindow: "page:e1:4", pageDocument: (id) => (id === "page:e1:4" ? `doc-${generation}` : null) });
    const first = await sc.request("file the support request from the email");
    sc.desk.afterAct = () => {
      sc.desk.afterAct = null;
      // The page reloads: a new document, every field empty again.
      generation++;
      for (const n of form.nodes) delete n.value;
      sc.desk.show(form);
    };
    const r = await sc.accept(first.goalId);
    expect(r?.outcome).toBe("stopped");
    // The write landed in the old page, which the reload then cleared: it was never verified, and nothing reached the new page.
    expect(sc.desk.writes.length).toBe(1);
    expect(form.nodes.map((n) => n.value ?? "")).toEqual(["", ""]);
    const stop = last(sc, "stopped");
    expect(stop && [stop.reason, stop.freshPlan !== null]).toEqual(["reload", true]);
    expect(stop?.says).toMatch(/^'Support request' reloaded or went to another page, so Caret stopped after 0 of 2 steps\. A fresh plan/);
    // A preview taken before a reload is refused at acceptance too.
    const fresh = stop?.freshPlan ?? "";
    generation++;
    expect(await sc.accept(fresh)).toBeNull();
    expect(last(sc, "stopped")?.reason).toBe("reload");
    expect(sc.desk.writes.length).toBe(1);
  });

  it("a source that changes between segments stops the goal before the next segment writes", async () => {
    const sc = scene({ scripts: [TO_SUPPORT], windows: supportDesk(), userWindow: "7171-1" });
    const first = await sc.request("file a support case");
    await sc.accept(first.goalId);
    const mail = sc.desk.windows.get("6161-1") as DeskWindow;
    mail.nodes = mail.nodes.map((n) => (n.key === textKey(MAIL, 3) ? line(MAIL, 3, "Problem: never mind, it works now.") : n));
    sc.desk.show(mail);
    expect(await sc.accept(first.goalId)).toBeNull();
    expect(last(sc, "stopped")?.reason).toBe("sourceChanged");
    expect(sc.desk.writes.map((w) => w.windowId)).toEqual(["7171-1"]);
  });

  it("the user stopping a segment stops the goal with no fresh plan", async () => {
    const sc = scene({ scripts: [TO_SUPPORT, TO_SUPPORT], windows: supportDesk(), userWindow: "7171-1" });
    const first = await sc.request("file a support case");
    sc.desk.afterAct = () => sc.helper.executor.stop(`${first.goalId}:s0`);
    const stopped = last(sc, "stopped");
    expect(stopped).toBeUndefined();
    await sc.accept(first.goalId);
    const stop = last(sc, "stopped");
    expect(stop && [stop.reason, stop.freshPlan]).toEqual(["you", null]);
  });
});

describe("a form behind a Next step", () => {
  const wizard: CannedStep[] = [
    { fill: { window: "Report a problem", target: "Order number", value: ORDER } },
    { press: { window: "Report a problem", target: "Next", effect: "e:reveal" } },
  ];
  const rest: CannedStep[] = [{ fill: { window: "Report a problem", target: "Description", value: "cracked base" } }];

  it("presses Next as a registered, verified press, then offers the revealed fields as a fresh plan needing a new acceptance", async () => {
    const sc = scene({ scripts: [wizard, rest], windows: [mailWindow(), wizardWindow()], userWindow: "7171-3" });
    const first = await sc.request("report the damaged lamp from the email");
    expect(first.event === "segment" && first.steps.map((s) => [s.kind, s.says])).toEqual([["write", `Order number: ${ORDER}`], ["press", "Press 'Next' to show the next fields"]]);
    expect((await sc.accept(first.goalId))?.outcome).toBe("done");
    expect(sc.desk.pressed).toEqual([{ windowId: "7171-3", label: "Next" }]);
    // Not done: the press showed fields this plan does not cover. The goal stops and names the fresh plan for them.
    expect(sc.goals.some((g) => g.goalId === first.goalId && g.event === "finished")).toBe(false);
    const stop = last(sc, "stopped");
    expect(stop && [stop.goalId, stop.reason, stop.freshPlan !== null, stop.says.startsWith("The last press showed more fields than this plan covers, so Caret stopped after 2 of 2 steps.")]).toEqual([first.goalId, "revealed", true, true]);
    expect(sc.goals.filter((g) => g.event === "step" && g.phase === "verified").length).toBe(2);
    const fresh = [...sc.goals].reverse().find((g): g is Segment => g.event === "segment" && g.replaces === first.goalId);
    expect(fresh?.goalId).toBe(stop?.freshPlan);
    expect(fresh && [fresh.reason, fresh.steps.map((s) => s.says)]).toEqual(["afterReveal", [`Description: ${PROBLEM}`]]);
    // The writer saw the revealed field only in the second request.
    expect(sc.writer.requests.map((snaps) => snaps[0]?.targets.map((t) => t.label))).toEqual([["Order number", "Next", "Continue"], ["Description", "Contact email", "Next", "Continue"]]);
    expect(sc.desk.writes.length).toBe(1);
    expect((await sc.accept(fresh?.goalId ?? ""))?.outcome).toBe("done");
    expect(sc.desk.writes.map((w) => w.value)).toEqual([ORDER, PROBLEM]);
  });

  it("stops as a timeout when Next shows nothing, and presses nothing else", async () => {
    const sc = scene({ scripts: [wizard], windows: [mailWindow(), wizardWindow(false)], userWindow: "7171-3" });
    const first = await sc.request("report the damaged lamp");
    expect((await sc.accept(first.goalId))?.outcome).toBe("stopped");
    expect(last(sc, "stopped")?.reason).toBe("timeout");
    expect(sc.desk.pressed.length).toBe(1);
  });

  it("hands Continue to the user: the reader is never asked to press it", async () => {
    const sc = scene({ scripts: [[wizard[0] as CannedStep, { press: { window: "Report a problem", target: "Continue", effect: YOURS_EFFECT } }]], windows: [mailWindow(), wizardWindow()], userWindow: "7171-3" });
    const first = await sc.request("report the damaged lamp");
    expect((await sc.accept(first.goalId))?.outcome).toBe("handoff");
    expect(sc.desk.pressed).toEqual([]);
    expect(sc.desk.verbs.some((v) => v.kind === "press")).toBe(false);
    expect(last(sc, "finished")).toMatchObject({ outcome: "handoff", verified: 1, says: "Ready: 1 done. You press 'Continue'." });
  });
});

describe("mail to calendar plus a draft reply", () => {
  it("adds the event through the calendar adapter, drafts the reply in a second acceptance, and leaves Send to the user", async () => {
    const steps: CannedStep[] = [
      { fill: { window: "Calendar", target: "Caret", value: "Meet Priya" } },
      { fill: { window: "Re: Order", target: "To", value: "priya.raman@northwind.example" } },
      { fill: { window: "Re: Order", target: "Message", value: "cracked base" } },
      { press: { window: "Re: Order", target: "Send", effect: YOURS_EFFECT } },
    ];
    const sc = scene({ scripts: [steps], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const first = await sc.request("add this meeting and draft a reply with the problem");
    expect(first.event === "segment" && [first.where, first.steps.map((s) => s.says)]).toEqual([{ kind: "calendar", calendar: "Caret" }, [expect.stringMatching(/^Add 'Meet Priya' to your Caret calendar, Thu /)]]);
    expect((await sc.accept(first.goalId))?.outcome).toBe("done");
    expect([...sc.calendar.events.values()].map((e) => [e.calendar, e.title, Date.parse(e.start)])).toEqual([["Caret", "Meet Priya", Date.parse("2026-10-08T15:00:00-07:00")]]);
    const second = segmentsOf(sc, first.goalId)[1];
    expect(second?.steps.map((s) => s.kind)).toEqual(["write", "write", "handoff"]);
    expect((await sc.accept(first.goalId))?.outcome).toBe("handoff");
    expect(sc.desk.writes.map((w) => w.value)).toEqual(["priya.raman@northwind.example", PROBLEM]);
    expect(sc.desk.pressed).toEqual([]);
    const fin = last(sc, "finished");
    expect(fin && [fin.outcome, fin.verified, fin.says]).toEqual(["handoff", 3, "Ready: 3 done. 'Send' reads as outbound; you press it."]);
    // The Send button is the user's: the reader was asked to press nothing.
    expect(sc.desk.verbs.filter((v) => v.kind === "press")).toEqual([]);
    expect(sc.desk.node("6161-2", buttonKey(MAIL, "Send"))).toBeDefined();
  });
});

describe("no goal survives its helper", () => {
  it("a restarted helper knows no goal: an acceptance of the old preview runs nothing", async () => {
    const a = scene({ scripts: [TO_SUPPORT], windows: supportDesk(), userWindow: "7171-1" });
    const first = await a.request("file a support case");
    const b = scene({ scripts: [], windows: supportDesk(), userWindow: "7171-1" });
    expect(await b.helper.handleGoalAccept({ type: "goalAccept", v: 1, goalId: first.goalId, segment: 0, digest: first.event === "segment" ? first.digest : "", at: b.desk.at }, b.session)).toBeNull();
    expect(errors(b).at(-1)).toMatch(/no goal goal-/);
    expect(acts(b)).toEqual([]);
  });

  it("a reader restart ends a waiting preview", async () => {
    const sc = scene({ scripts: [TO_SUPPORT], windows: supportDesk(), userWindow: "7171-1" });
    const first = await sc.request("file a support case");
    void sc.helper.handleReader({ type: "hello", v: 1, role: "reader", mode: "live", pid: 1, version: "goal-desk", session: "goal-desk-reader-2" });
    expect(last(sc, "stopped")?.reason).toBe("readerRestarted");
    expect(await sc.accept(first.goalId)).toBeNull();
    expect(acts(sc)).toEqual([]);
  });
});

// MARK: - the authority review's cases (theo-astra-reviewer adb294b23bd436f89 on 12c786f..c5554c8)

describe("review: what may press, and when a segment may act", () => {
  const wizard: CannedStep[] = [
    { fill: { window: "Report a problem", target: "Order number", value: ORDER } },
    { press: { window: "Report a problem", target: "Next", effect: "e:reveal" } },
  ];

  it("never presses a look-alike: a Next link that replaced the accepted Next button stops the goal, unpressed", async () => {
    const sc = scene({ scripts: [wizard], windows: [mailWindow(), wizardWindow()], userWindow: "7171-3" });
    const first = await sc.request("report the damaged lamp");
    sc.desk.afterAct = () => {
      sc.desk.afterAct = null;
      const w = sc.desk.windows.get("7171-3") as DeskWindow;
      // Same key, same label, another kind of control: a link the reader would press.
      w.nodes = w.nodes.map((n) => (n.key === buttonKey(SUPPORT, "Next") ? { key: n.key, parent: null, role: "AXLink", label: "Next" } : n));
      sc.desk.show(w);
    };
    expect((await sc.accept(first.goalId))?.outcome).toBe("stopped");
    expect(sc.desk.pressed).toEqual([]);
    expect(sc.desk.verbs.filter((v) => v.kind === "press")).toEqual([]);
  });

  it("a goal's paused segment stops, and a generic resume of its task is refused: nothing more is written", async () => {
    const sc = scene({ scripts: [TO_SUPPORT_ONE_WINDOW], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const first = await sc.request("reply to Priya with the problem");
    const taskId = `${first.goalId}:s0`;
    sc.desk.afterAct = () => {
      sc.desk.afterAct = null;
      sc.helper.executor.pause(taskId, false, "input");
    };
    await sc.accept(first.goalId);
    const stop = last(sc, "stopped");
    expect(stop && [stop.reason, stop.freshPlan]).toEqual(["you", null]);
    const writes = sc.desk.writes.length;
    expect(writes).toBe(1);
    await sc.helper.handleTask({ type: "taskControl", v: 1, taskId, action: "resume" }, "any-consumer");
    expect(errors(sc).at(-1)).toMatch(/is a goal's step; a goal goes on only from a fresh acceptance/);
    expect(sc.desk.writes.length).toBe(writes);
  });

  it("a dialog from another process of the same app stops the segment before its next write", async () => {
    const sc = scene({ scripts: [TO_SUPPORT_ONE_WINDOW], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const first = await sc.request("reply to Priya with the problem");
    sc.desk.afterAct = () => {
      sc.desk.afterAct = null;
      sc.desk.show({ windowId: "6299-1", app: { ...MAIL, pid: 6299 }, title: "Mail Fixture Helper", kind: "dialog", nodes: [button({ ...MAIL, pid: 6299 }, "OK")] });
    };
    expect((await sc.accept(first.goalId))?.outcome).toBe("stopped");
    expect(last(sc, "stopped")?.reason).toBe("dialog");
    expect(sc.desk.writes.length).toBe(1);
  });

  it("a Next that opens a sheet with a field is a dialog, never a verified reveal", async () => {
    const win = wizardWindow();
    win.buttons?.set(buttonKey(SUPPORT, "Next"), (w) => {
      w.nodes.push({ key: `${SUPPORT.bundleId}/standard/sheet:~0`, parent: null, role: "AXSheet" }, { key: `${SUPPORT.bundleId}/standard/sheet:/textfield:reason~0`, parent: `${SUPPORT.bundleId}/standard/sheet:~0`, role: "AXTextField", label: "Reason", editable: true });
    });
    const sc = scene({ scripts: [wizard], windows: [mailWindow(), win], userWindow: "7171-3" });
    const first = await sc.request("report the damaged lamp");
    expect((await sc.accept(first.goalId))?.outcome).toBe("stopped");
    expect(last(sc, "stopped")?.reason).toBe("dialog");
    expect(sc.goals.filter((g) => g.event === "step" && g.phase === "verified").length).toBe(1);
    expect(last(sc, "finished")).toBeUndefined();
  });

  it("closing the source window after the first write stops the goal before the second", async () => {
    const sc = scene({ scripts: [[{ fill: { window: "Re: Order", target: "To", value: "priya.raman@northwind.example" } }, { fill: { window: "Re: Order", target: "Message", value: "cracked base" } }]], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    const first = await sc.request("reply to Priya with the problem");
    sc.desk.afterAct = () => {
      sc.desk.afterAct = null;
      sc.desk.close("6161-1");
    };
    expect((await sc.accept(first.goalId))?.outcome).toBe("stopped");
    expect(last(sc, "stopped")?.reason).toBe("sourceChanged");
    expect(sc.desk.writes.length).toBe(1);
  });

  it("a reveal whose fresh plan cannot be made never reads as done", async () => {
    const pressOnly: CannedStep[] = [{ press: { window: "Report a problem", target: "Next", effect: "e:reveal" } }];
    // The live gpt-oss-120b run: the plan only pressed Next, and its fresh plan asked to press Next again.
    const sc = scene({ scripts: [pressOnly, pressOnly], windows: [mailWindow(), wizardWindow()], userWindow: "7171-3" });
    const first = await sc.request("report the damaged lamp");
    await sc.accept(first.goalId);
    expect(sc.goals.some((g) => g.event === "finished")).toBe(false);
    const stop = last(sc, "stopped");
    expect(stop && [stop.reason, stop.freshPlan]).toEqual(["revealed", null]);
  });

  it("a fresh plan may not press what the goal already pressed: Next is not pressed twice", async () => {
    const again: CannedStep[] = [{ press: { window: "Report a problem", target: "Next", effect: "e:reveal" } }];
    // Next stays on screen and reveals nothing the second time; the replan asks to press it again.
    const sc = scene({ scripts: [wizard, again], windows: [mailWindow(), wizardWindow()], userWindow: "7171-3" });
    const first = await sc.request("report the damaged lamp");
    await sc.accept(first.goalId);
    await sc.helper.goals.idle();
    expect(sc.desk.pressed.length).toBe(1);
    expect(sc.goals.filter((g) => g.event === "segment" && g.replaces !== null)).toEqual([]);
    expect(sc.warnings.some((l) => /would press 'Next' again, which Caret already did for this goal/.test(l))).toBe(true);
  });

  it("a write Caret could not make stops the goal as handed off; it never says the draft is ready", async () => {
    const steps: CannedStep[] = [
      { fill: { window: "Re: Order", target: "To", value: "priya.raman@northwind.example" } },
      { fill: { window: "Re: Order", target: "Message", value: "cracked base" } },
      { press: { window: "Re: Order", target: "Send", effect: YOURS_EFFECT } },
    ];
    const sc = scene({ scripts: [steps], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    sc.desk.focusMovesOn.add(fieldKey(MAIL, "To"));
    const first = await sc.request("reply to Priya with the problem");
    expect((await sc.accept(first.goalId))?.outcome).toBe("handoff");
    expect(last(sc, "finished")).toBeUndefined();
    const stop = last(sc, "stopped");
    expect(stop && [stop.reason, /^Focus moved away from the To field/.test(stop.says)]).toEqual(["handedOff", true]);
    expect(sc.desk.writes).toEqual([]);
  });

  it("what runs is the frozen copy that was shown: changing the offered plan object afterwards changes nothing", async () => {
    const sc = scene({ scripts: [], windows: supportDesk(), userWindow: "7171-1" });
    const inv = buildInventory(sc.helper.model, { instruction: "file a support case", windows: ["7171-1"], memory: [], calendar: null, clock: macClock(new Date(sc.desk.at)), now: sc.desk.at, readerSession: 1 });
    const ran = await runCodePlan(cannedProgram(inv.snapshots, [TO_SUPPORT[0] as CannedStep]), inv.snapshots, async () => null, { multiWindow: true });
    if (!ran.ok) throw new Error(ran.detail);
    const plan = await lowerGoal("goal-frozen", "file a support case", ran.plan, inv.inventory, { askJev: standInJev(), ledger: inv.ledger });
    const offered = sc.helper.goals.propose(plan, sc.session, "r-frozen");
    const seg = plan.segments[0] as (typeof plan.segments)[number];
    seg.slots.v0 = "ORD-SOMETHING-ELSE";
    seg.plan.steps[0] = { ...(seg.plan.steps[0] as (typeof seg.plan.steps)[number]), says: "changed" };
    expect(offered.event === "segment" && (await sc.helper.handleGoalAccept({ type: "goalAccept", v: 1, goalId: "goal-frozen", segment: 0, digest: offered.digest, at: sc.desk.at }, sc.session))?.outcome).toBe("done");
    expect(sc.desk.writes.map((w) => w.value)).toEqual([ORDER]);
  });
});

describe("re-check: presses that may have landed", () => {
  it("a Next whose effect never showed is still a press the goal made: the fresh plan may not press it again", async () => {
    const wizard: CannedStep[] = [
      { fill: { window: "Report a problem", target: "Order number", value: ORDER } },
      { press: { window: "Report a problem", target: "Next", effect: "e:reveal" } },
    ];
    const sc = scene({ scripts: [wizard, [{ press: { window: "Report a problem", target: "Next", effect: "e:reveal" } }]], windows: [mailWindow(), wizardWindow(false)], userWindow: "7171-3" });
    const first = await sc.request("report the damaged lamp");
    expect((await sc.accept(first.goalId))?.outcome).toBe("stopped");
    const stop = last(sc, "stopped");
    expect(stop && [stop.reason, stop.freshPlan]).toEqual(["timeout", null]);
    expect(sc.desk.pressed.length).toBe(1);
    expect(sc.warnings.some((l) => /would press 'Next' again, which Caret already did for this goal/.test(l))).toBe(true);
  });
});

const TO_SUPPORT_ONE_WINDOW: CannedStep[] = [
  { fill: { window: "Re: Order", target: "To", value: "priya.raman@northwind.example" } },
  { fill: { window: "Re: Order", target: "Message", value: "cracked base" } },
];
