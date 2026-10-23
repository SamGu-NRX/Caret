// Slice 2: navigate's act-through. A row the walk qualified (not in a form, a link that stays on the page) is opened
// by Caret itself, with the model read fresh right before the act and the page's own handler doing the opening; an
// engine refusal stops the step with its named reason instead of verifying a step the page never took.
import { afterEach, describe, expect, it } from "vitest";
import type { AskJev } from "../src/fill/jev.ts";
import type { GoalProgress, TaskProgress } from "../src/protocol.ts";
import { confirmationCode, goalScene, mailMessages, standInJev, WEBMAIL_ID, webmailWindow, type DeskMessage, type GoalScene } from "./goal-desk.ts";

const scenes: GoalScene[] = [];
afterEach(async () => {
  for (const s of scenes.splice(0)) await s.close();
});

/** Jev's stand-in: none of these scenes ask. */
const jev = (): AskJev => standInJev();

const scene = (o: Parameters<typeof goalScene>[0] & { askJev: AskJev }): GoalScene => {
  const s = goalScene(o);
  scenes.push(s);
  return s;
};

type Segment = Extract<GoalProgress, { event: "segment" }>;
const segments = (sc: GoalScene, goalId: string): Segment[] => sc.goals.filter((g): g is Segment => g.goalId === goalId && g.event === "segment");
const last = <E extends GoalProgress["event"]>(sc: GoalScene, event: E): Extract<GoalProgress, { event: E }> | undefined => [...sc.goals].reverse().find((g): g is Extract<GoalProgress, { event: E }> => g.event === event);
const waiting = (sc: GoalScene): TaskProgress[] => sc.published.filter((m): m is TaskProgress => m.type === "taskProgress" && m.phase === "acting" && (m.detail ?? "").startsWith("waiting for you"));

const INSTRUCTION = "Reply to Dana with the confirmation number from Kayak's message";

/** The plan is one navigation: open Kayak's thread and stop. */
const OPEN_ONLY: { source: string } = {
  source: `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const box = await caret.readWindow();
  const kayak = box.targets.find((t) => t.kind === "row" && t.label.startsWith("Kayak · Flight itinerary · "));
  if (kayak === undefined) throw new Error("no Kayak row in the inbox");
  const open = caret.navigate(kayak.ref, "e:open");
  return caret.plan({ basedOn: box.snapshot, steps: [open] });
}`,
};

/** The inbox, with every row qualified for Caret's own open: not in a form, its link stays on the page. */
function pageWindow(messages: DeskMessage[]) {
  const w = webmailWindow(messages);
  for (const n of w.nodes) if (n.role === "AXRow") { n.inForm = false; n.href = "none"; }
  return w;
}

const messages = (): DeskMessage[] => mailMessages(confirmationCode(), confirmationCode());

describe("navigate opens a qualified page row itself (slice 2)", { timeout: 60_000 }, () => {
  it("acts through the page's own handler under the task's grant, and the goal finishes", async () => {
    const ms = messages();
    const sc = await scene({ scripts: [OPEN_ONLY], windows: [pageWindow(ms)], askJev: jev() });
    // What the open does: the page shows the thread in place of the list, as the real page's pushState does.
    sc.desk.rowsOpen = (windowId) => {
      if (windowId === WEBMAIL_ID) sc.desk.windows.set(WEBMAIL_ID, webmailWindow(ms, "kayak"));
    };
    const first = await sc.request(INSTRUCTION);
    if (first.event !== "segment") throw new Error(JSON.stringify(first));
    // A qualified row is no handoff: the preview plans the act (a navigate's act preview shows as its press).
    expect(first.steps.map((s) => [s.kind, s.tier])).toEqual([["press", "navigate"]]);
    expect(waiting(sc)).toEqual([]);
    await sc.accept(first.goalId);
    expect(sc.desk.activated).toEqual([{ windowId: WEBMAIL_ID, key: expect.stringContaining("row:kayak"), taskId: `${first.goalId}:s0` }]);
    // The thread is shown, and nothing else was written or pressed.
    expect(sc.desk.writes).toEqual([]);
    expect(sc.desk.pressed).toEqual([]);
    expect(last(sc, "finished")).toBeDefined();
  });

  it("stops with the engine's refusal when the element stopped being a row, instead of verifying the open", async () => {
    const ms = messages();
    const sc = await scene({ scripts: [OPEN_ONLY], windows: [pageWindow(ms)], askJev: jev() });
    sc.desk.rowsOpen = (windowId) => {
      if (windowId === WEBMAIL_ID) sc.desk.windows.set(WEBMAIL_ID, webmailWindow(ms, "kayak"));
    };
    const first = await sc.request(INSTRUCTION);
    if (first.event !== "segment") throw new Error(JSON.stringify(first));
    // The engine refuses the open itself (its own gate, not the model): the row is whole, the answer is not ok.
    const inner = sc.desk.grants.refusal.bind(sc.desk.grants);
    sc.desk.grants.refusal = (verb) => (verb.kind === "press" && verb.key === "f0/row:kayak" ? "no act grant for the open (test)" : inner(verb));
    await sc.accept(first.goalId);
    expect(sc.desk.activated).toEqual([]);
    // The step ends on the refusal, naming it — never on a mismatch against a page state the act never produced.
    const ended = last(sc, "stopped") ?? last(sc, "finished");
    expect(ended).toBeDefined();
    expect(JSON.stringify(ended)).toMatch(/axError|refused/);
  });
});
