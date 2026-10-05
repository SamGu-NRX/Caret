// G2 review (theo-astra-reviewer a083a3197a7fa3dd0): each path the review showed writing an unchecked value or ending
// done with an effect missing, as a scene on the desk. Every name and number is invented.
import { afterEach, describe, expect, it } from "vitest";
import type { GoalProgress, Node } from "../src/protocol.ts";
import { areaKey, button, caseWindow, detailsWindow, fieldKey, goalScene, MAIL, mailWindow, replyWindow, standInJev, SUPPORT, textArea, textField, textKey, type CannedStep, type DeskWindow, type GoalScene } from "./goal-desk.ts";

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
const preview = (g: GoalProgress): Segment => {
  if (g.event !== "segment") throw new Error(`no preview: ${JSON.stringify(g)}`);
  return g;
};
async function runAll(sc: GoalScene): Promise<GoalProgress | undefined> {
  for (let i = 0; i < 8; i++) {
    await sc.helper.goals.idle();
    const pending = [...sc.goals].reverse().find((g): g is Segment => g.event === "segment" && sc.helper.goals.get(g.goalId)?.state === "awaiting" && sc.helper.goals.get(g.goalId)?.cursor.segment === g.segment);
    if (pending === undefined) break;
    await sc.accept(pending.goalId);
  }
  await sc.helper.goals.idle();
  return sc.goals.filter((g) => g.event === "finished" || g.event === "stopped").at(-1);
}

const EMAIL = "priya.raman@northwind.example";
const ORDER = "ORD-2026-48213";

describe("finding 1: every write passes the gates, drafts, the code-filled To and calendar events included", () => {
  it("drops a draft planned for Order number", async () => {
    const steps: CannedStep[] = [
      { draft: { window: "New case", target: "Order number", text: EMAIL, from: ["Order ORD-2026-48213 arrived damaged"] } },
      { fill: { window: "Case details", target: "Description", value: "cracked base" } },
    ];
    const sc = scene({ scripts: [steps], windows: [mailWindow(), caseWindow(), detailsWindow()], userWindow: "7171-1" });
    const g = preview(await sc.request("file the case"));
    expect(g.steps.map((s) => s.says)).toEqual(["Description: The desk lamp arrived with a cracked base and does not switch on."]);
    expect(g.warnings).toEqual(["Caret left 'Order number' empty: Caret writes drafts only in a field for a message or a description."]);
  });

  it("checks the sender's kind before code puts it in a recipient field", async () => {
    const reply: DeskWindow = { ...replyWindow(), nodes: [textField(MAIL, "To phone number"), textArea(MAIL, "Message"), button(MAIL, "Send")] };
    const sc = scene({ scripts: [[{ draft: { window: "Re: Order", target: "Message", text: "I'm in.", from: [] } }]], windows: [mailWindow(), reply], userWindow: "6161-2" });
    const g = preview(await sc.request("draft a reply to Priya saying I'm in"));
    expect(g.steps.map((s) => s.says)).toEqual(["Message: I'm in."]);
    expect(g.warnings).toEqual([`You add the recipient in 'To phone number': '${EMAIL}' is an email address, and the field takes a phone number.`]);
  });

  it("asks Jev about a calendar event, and adds none Jev does not confirm or when Jev is not there", async () => {
    const steps: CannedStep[] = [
      { fill: { window: "Calendar", target: "Caret", value: "Meet Priya" } },
      { fill: { window: "Re: Order", target: "To", value: EMAIL } },
    ];
    const doubting = scene({ scripts: [steps], windows: [mailWindow(), replyWindow()], userWindow: "6161-2", askJev: standInJev({ belongs: (q) => !q.includes("'the Caret calendar'") }) });
    const g = preview(await doubting.request("add this meeting to my calendar and address a reply to Priya"));
    expect(g.steps.map((s) => s.kind)).toEqual(["write"]);
    expect(g.warnings).toEqual(["Caret left the event out of your 'Caret' calendar: Jev didn't confirm 'Meet Priya' belongs there."]);
    const alone = scene({ scripts: [[steps[0] as CannedStep]], windows: [mailWindow(), replyWindow()], userWindow: "6161-2", askJev: undefined });
    const r = await alone.request("add this meeting to my calendar");
    expect(r.event === "stopped" && r.says).toBe("Caret left the event out of your 'Caret' calendar: Caret couldn't ask Jev whether 'Meet Priya' belongs there");
  });
});

describe("finding 2: a fresh plan after a stop does not forget what the stopped plan meant", () => {
  it("ends partial when the fresh plan leaves out a write the stopped plan never made, and its preview says so", async () => {
    const claim: DeskWindow = { windowId: "7171-6", app: SUPPORT, title: "Support — Claim", nodes: [textField(SUPPORT, "Order number"), textArea(SUPPORT, "Description"), textField(SUPPORT, "Reference")] };
    const first: CannedStep[] = [
      { fill: { window: "Claim", target: "Order number", value: ORDER } },
      { fill: { window: "Claim", target: "Description", value: "cracked base" } },
      { fill: { window: "Claim", target: "Reference", value: ORDER } },
    ];
    const fresh: CannedStep[] = [{ fill: { window: "Claim", target: "Reference", value: ORDER } }];
    const sc = scene({ scripts: [first, fresh], windows: [mailWindow(), claim], userWindow: "7171-6" });
    sc.desk.afterAct = (v) => {
      if (v.kind !== "write") return;
      sc.desk.afterAct = null;
      sc.desk.show({ windowId: "7171-9", app: SUPPORT, title: "Saved", kind: "dialog", nodes: [button(SUPPORT, "OK")] });
    };
    await sc.request("fill the claim from the email");
    const end = await runAll(sc);
    const freshPreview = sc.goals.find((g): g is Segment => g.event === "segment" && g.replaces !== null);
    expect(freshPreview?.warnings).toEqual(["Caret's stopped plan meant to write 'Description', and has not."]);
    expect(sc.desk.node("7171-6", fieldKey(SUPPORT, "Reference"))?.value).toBe(ORDER);
    expect(end?.event === "finished" && [end.outcome, end.left]).toEqual(["partial", ["Caret's stopped plan meant to write 'Description', and has not"]]);
  });
});

describe("finding 5: required controls that are not text fields", () => {
  it("ends partial while a required popup still shows its prompt", async () => {
    const country: Node = { key: `${SUPPORT.bundleId}/standard/popupbutton:country~0`, parent: null, role: "AXPopUpButton", label: "Country *", value: "Select…" };
    const form: DeskWindow = { windowId: "7171-7", app: SUPPORT, title: "Support — Shipping", nodes: [textField(SUPPORT, "Order number"), country, button(SUPPORT, "Save")] };
    const sc = scene({ scripts: [[{ fill: { window: "Shipping", target: "Order number", value: ORDER } }]], windows: [mailWindow(), form], userWindow: "7171-7" });
    const g = preview(await sc.request("put the order number in"));
    expect(g.warnings).toEqual(["'Country' is required, and this plan leaves it empty."]);
    const end = await runAll(sc);
    expect(end?.event === "finished" && end.outcome).toBe("partial");
  });
});

describe("finding 6: a window that closes cannot erase what it owed", () => {
  it("ends partial when the window of a required field Caret wrote closes before the goal ends", async () => {
    const form: DeskWindow = { windowId: "7171-8", app: SUPPORT, title: "Support — New case", nodes: [textField(SUPPORT, "Order number *"), button(SUPPORT, "Save")] };
    const steps: CannedStep[] = [
      { fill: { window: "New case", target: "Order number", value: ORDER } },
      { fill: { window: "Case details", target: "Description", value: "cracked base" } },
    ];
    const sc = scene({ scripts: [steps], windows: [mailWindow(), form, detailsWindow()], userWindow: "7171-8" });
    const g = preview(await sc.request("file the case"));
    await sc.accept(g.goalId);
    sc.desk.close("7171-8");
    await sc.accept(g.goalId);
    const end = sc.goals.filter((x) => x.event === "finished").at(-1);
    expect(end?.event === "finished" && [end.outcome, end.left]).toEqual(["partial", ["'Order number' could not be checked: its window closed"]]);
  });
});

describe("finding 7: a field that reads as another after the preview", () => {
  it("stops before writing when the field's name changed under the same key", async () => {
    const sc = scene({ scripts: [[{ fill: { window: "New case", target: "Order number", value: ORDER } }]], windows: [mailWindow(), caseWindow(), detailsWindow()], userWindow: "7171-1" });
    const g = preview(await sc.request("put the order number in the case"));
    const w = sc.desk.windows.get("7171-1") as DeskWindow;
    const n = w.nodes.find((x) => x.key === fieldKey(SUPPORT, "Order number")) as Node;
    n.label = "Email";
    sc.desk.show(w);
    await sc.accept(g.goalId);
    const stop = sc.goals.filter((x) => x.event === "stopped").at(-1);
    expect(stop?.event === "stopped" && [stop.reason, stop.says]).toEqual(["targetChanged", "'Order number' in 'Support — New case' now reads as another field, so Caret stopped after 0 of 1 steps."]);
    expect(sc.desk.writes).toEqual([]);
  });
});

// G2 re-check (theo-astra-reviewer ac171c02b28bce62d) of 69df243.
describe("re-check: what the first fixes left open", () => {
  it("ends partial when Jev confirms one of two events: each event is its own effect", async () => {
    const mail: DeskWindow = {
      ...mailWindow(),
      nodes: [...mailWindow().nodes, { key: textKey(MAIL, 5), parent: null, role: "AXStaticText", label: "Can we also meet with Dana on Friday, October 9, 2026 from 1:00 PM to 1:30 PM PT?" }],
      values: [...(mailWindow().values ?? []), { kind: "date", text: "Friday, October 9, 2026", nodeKey: textKey(MAIL, 5) }, { kind: "time", text: "1:00 PM to 1:30 PM PT", nodeKey: textKey(MAIL, 5) }],
    };
    const steps: CannedStep[] = [
      { fill: { window: "Calendar", target: "Caret", value: "Meet Priya" } },
      { fill: { window: "Calendar", target: "Caret", value: "Meet Dana" } },
    ];
    const sc = scene({ scripts: [steps], windows: [mail, replyWindow()], userWindow: "6161-2", askJev: standInJev({ belongs: (q) => !q.includes("Meet Dana") }) });
    const g = preview(await sc.request("add both meetings to my calendar"));
    expect(g.steps.map((s) => s.says)).toEqual([expect.stringMatching(/^Add 'Meet Priya' to your Caret calendar/)]);
    const end = await runAll(sc);
    expect(end?.event === "finished" && [end.outcome, end.left]).toEqual(["partial", ["Caret left the event out of your 'Caret' calendar: Jev didn't confirm 'Meet Dana' belongs there"]]);
  });

  it("owes a required page control, which arrives editable", async () => {
    const country: Node = { key: `${SUPPORT.bundleId}/standard/popupbutton:country~0`, parent: null, role: "AXPopUpButton", label: "Country *", value: "Select…", editable: true };
    const form: DeskWindow = { windowId: "7171-7", app: SUPPORT, title: "Support — Shipping", nodes: [textField(SUPPORT, "Order number"), country, button(SUPPORT, "Save")] };
    const sc = scene({ scripts: [[{ fill: { window: "Shipping", target: "Order number", value: ORDER } }]], windows: [mailWindow(), form], userWindow: "7171-7" });
    const g = preview(await sc.request("put the order number in"));
    expect(g.warnings).toEqual(["'Country' is required, and this plan leaves it empty."]);
  });

  it("stops before writing a page control whose label is gone", async () => {
    const web: Node = { key: "page:e1:3/webarea~0", parent: null, role: "AXWebArea", label: "Shipping" };
    const pop: Node = { key: "page:e1:3/select:country~0", parent: web.key, role: "AXPopUpButton", label: "Country", editable: true };
    const items: Node[] = ["Canada", "Mexico"].map((l) => ({ key: `${pop.key}/item:${l}`, parent: pop.key, role: "AXMenuItem", label: l }));
    const app = { pid: 5151, bundleId: "com.google.Chrome", name: "Chrome" };
    const page: DeskWindow = { windowId: "5151-1", app, title: "Shipping", kind: "page", nodes: [web, pop, ...items] };
    const sc = scene({ scripts: [[{ fill: { window: "Shipping", target: "Country", value: "Canada" } }]], windows: [page], userWindow: "5151-1" });
    const g = preview(await sc.request('put "Canada" in Country'));
    const n = page.nodes.find((x) => x.key === pop.key) as Node;
    delete n.label;
    sc.desk.show(sc.desk.windows.get("5151-1") as DeskWindow);
    await sc.accept(g.goalId);
    const stop = sc.goals.filter((x) => x.event === "stopped").at(-1);
    expect(stop?.event === "stopped" && [stop.reason, stop.says]).toEqual(["targetChanged", "'Country' in 'Shipping' now reads as another field, so Caret stopped after 0 of 1 steps."]);
  });

  it("lets a draft into a description area whatever else its label says", async () => {
    const ticket: DeskWindow = { windowId: "7171-10", app: SUPPORT, title: "Support — Ticket", nodes: [textArea(SUPPORT, "Ticket Description"), button(SUPPORT, "Save")] };
    const sc = scene({ scripts: [[{ draft: { window: "Ticket", target: "Ticket Description", text: "The lamp is broken.", from: [] } }]], windows: [ticket], userWindow: "7171-10" });
    const g = preview(await sc.request("describe the problem: the lamp is broken"));
    expect(g.steps.map((s) => s.says)).toEqual(["Ticket Description: The lamp is broken."]);
  });
});
