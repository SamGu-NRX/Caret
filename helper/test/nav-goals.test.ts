// Slice 2, milestone A (CU-COUNSEL-R2 "The two tasks"): a goal that opens a list item, observes it and goes on by replay,
// with the user making every navigation (actor "you"). A real Helper and Executor on the synthetic desk; one canned
// writer program per goal; Jev's stand-in. The native task opens Kayak's message, then Dana's, and drafts the reply in
// Dana's; the page task opens Kayak's thread in a Gmail-shaped page and drafts the reply there. Each run's confirmation
// code is new, so a value Caret did not read cannot pass.
import { afterEach, describe, expect, it } from "vitest";
import type { AskJev } from "../src/fill/jev.ts";
import { PROTOCOL_VERSION, type GoalProgress, type ReaderVerb, type TaskProgress } from "../src/protocol.ts";
import { confirmationCode, goalScene, mailboxWindow, mailMessages, MAILBOX, MAILBOX_REPLY, mailboxRowKey, standInJev, userOpens, WEBMAIL_ID, WEBMAIL_REPLY, webmailWindow, type DeskMessage, type GoalScene } from "./goal-desk.ts";

const scenes: GoalScene[] = [];
afterEach(async () => {
  for (const s of scenes.splice(0)) await s.close();
});

/** Jev's stand-in, counting the choose() requests a program's runs sent (purpose codemode.choice). */
function jev(): AskJev & { chooses: number } {
  const inner = standInJev();
  const f = Object.assign(
    async (req: Parameters<AskJev>[0]) => {
      if (req.purpose === "codemode.choice") f.chooses++;
      return inner(req);
    },
    { chooses: 0 },
  );
  return f;
}

const scene = (o: Parameters<typeof goalScene>[0] & { askJev: AskJev }): GoalScene => {
  const s = goalScene(o);
  scenes.push(s);
  return s;
};

type Segment = Extract<GoalProgress, { event: "segment" }>;
const segments = (sc: GoalScene, goalId: string): Segment[] => sc.goals.filter((g): g is Segment => g.goalId === goalId && g.event === "segment");
const last = <E extends GoalProgress["event"]>(sc: GoalScene, event: E): Extract<GoalProgress, { event: E }> | undefined => [...sc.goals].reverse().find((g): g is Extract<GoalProgress, { event: E }> => g.event === event);
const acts = (sc: GoalScene): ReaderVerb[] => sc.desk.verbs.filter((v) => v.kind === "write" || v.kind === "press" || v.kind === "raise");
const waiting = (sc: GoalScene): TaskProgress[] => sc.published.filter((m): m is TaskProgress => m.type === "taskProgress" && m.phase === "acting" && (m.detail ?? "").startsWith("waiting for you"));

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 4000; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Tab on the latest preview of `goalId`; once the executor waits for the user, `user` makes the navigation. */
async function acceptAndDo(sc: GoalScene, goalId: string, user: () => void): Promise<void> {
  const before = waiting(sc).length;
  const done = sc.accept(goalId);
  await until(() => waiting(sc).length > before, "the executor to wait for the user");
  user();
  await done;
}

const INSTRUCTION = "Reply to Dana with the confirmation number from Kayak's message";

/** What the writer returns for the native task: open Kayak's message, read its code, open Dana's, draft the reply, leave Send. */
const NATIVE: { source: string } = {
  source: `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const box = await caret.readWindow();
  const row = (w, sender, subject) => w.targets.find((t) => t.kind === "row" && t.label.startsWith(sender + " · " + subject + " · "));
  const openKayak = caret.navigate(row(box, "Kayak", "Flight itinerary").ref, "e:open");
  const kayak = await caret.observe(openKayak);
  const code = kayak.values.find((v) => v.display.includes("labelled 'Confirmation number'"));
  const codeText = code.display.split('"')[1];
  const openDana = caret.navigate(row(kayak, "Dana Whitfield", "Flight itinerary").ref, "e:open");
  const dana = await caret.observe(openDana);
  const reply = caret.fill(dana.targets.find((t) => t.kind === "text" && t.label.endsWith("Reply")).ref, caret.draft("Hi Dana, the confirmation number is " + codeText + ".", [kayak.window]));
  const send = caret.press(dana.targets.find((t) => t.label === "Send").ref, "e:yours");
  return caret.plan({ basedOn: box.snapshot, steps: [openKayak, openDana, reply, send] });
}`,
};

/** The page task: open Kayak's thread, read its code, draft the reply in the thread, leave Send. */
const PAGE: { source: string } = {
  source: `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const box = await caret.readWindow();
  const kayak = box.targets.find((t) => t.kind === "row" && t.label.startsWith("Kayak · Flight itinerary · "));
  const open = caret.navigate(kayak.ref, "e:open");
  const thread = await caret.observe(open);
  const code = thread.values.find((v) => v.display.includes("labelled 'Confirmation number'")).display.split('"')[1];
  const reply = caret.fill(thread.targets.find((t) => t.kind === "text" && t.label.endsWith("Reply")).ref, caret.draft("Thanks, the confirmation number is " + code + ".", [thread.window]));
  const send = caret.press(thread.targets.find((t) => t.label === "Send").ref, "e:yours");
  return caret.plan({ basedOn: box.snapshot, steps: [open, reply, send] });
}`,
};

function codes(): { code: string; decoy: string } {
  const code = confirmationCode();
  let decoy = confirmationCode();
  while (decoy === code) decoy = confirmationCode();
  return { code, decoy };
}

/** One native run, start to finish, with the user opening Kayak's and then Dana's message. */
async function nativeRun(): Promise<{ sc: GoalScene; goalId: string; code: string; askJev: ReturnType<typeof jev>; messages: DeskMessage[] }> {
  const { code, decoy } = codes();
  const messages = mailMessages(code, decoy);
  const askJev = jev();
  const sc = scene({ scripts: [NATIVE], windows: [mailboxWindow(messages)], userWindow: "6262-1", askJev });
  const first = await sc.request(INSTRUCTION);
  if (first.event !== "segment") throw new Error(`no preview: ${JSON.stringify(first)}`);
  await acceptAndDo(sc, first.goalId, () => userOpens(sc.desk, "6262-1", messages, "kayak"));
  await acceptAndDo(sc, first.goalId, () => userOpens(sc.desk, "6262-1", messages, "dana"));
  await sc.accept(first.goalId);
  return { sc, goalId: first.goalId, code, askJev, messages };
}

// Each run plans, replays and checks values on a loaded machine; a whole native run takes a few seconds there.
describe("native task: open Kayak's message, then Dana's, and draft the reply (milestone A)", { timeout: 60_000 }, () => {
  it("previews each navigation as the user's, observes twice on one writer call, and writes only the drafted reply", async () => {
    const { code, decoy } = codes();
    const messages = mailMessages(code, decoy);
    const askJev = jev();
    const sc = scene({ scripts: [NATIVE], windows: [mailboxWindow(messages)], userWindow: "6262-1", askJev });
    const first = await sc.request(INSTRUCTION);
    if (first.event !== "segment") throw new Error(JSON.stringify(first));
    expect(first.steps).toEqual([{ index: 0, kind: "handoff", tier: "navigate", says: "Open 'Flight itinerary' (Kayak) yourself. Caret continues once it's open" }]);
    expect(acts(sc)).toEqual([]);

    await acceptAndDo(sc, first.goalId, () => userOpens(sc.desk, "6262-1", messages, "kayak"));
    const second = segments(sc, first.goalId)[1];
    expect(second && [second.segment, second.steps.map((s) => [s.kind, s.tier, s.says])]).toEqual([1, [["handoff", "navigate", "Open 'Flight itinerary' (Dana Whitfield) yourself. Caret continues once it's open"]]]);
    // Nothing was dispatched before the second Tab.
    expect(acts(sc)).toEqual([]);

    await acceptAndDo(sc, first.goalId, () => userOpens(sc.desk, "6262-1", messages, "dana"));
    const third = segments(sc, first.goalId)[2];
    const drafted = `Hi Dana, the confirmation number is ${code}.`;
    expect(third?.steps.map((s) => [s.kind, s.tier, s.says])).toEqual([["write", "write", `Message Reply: ${drafted}`], ["handoff", "yours", "'Send' reads as outbound; you press it"]]);
    expect(acts(sc)).toEqual([]);

    await sc.accept(first.goalId);
    expect(sc.desk.node("6262-1", MAILBOX_REPLY)?.value).toBe(drafted);
    expect(sc.desk.writes).toEqual([{ windowId: "6262-1", key: MAILBOX_REPLY, value: drafted }]);
    expect(sc.desk.node("6262-1", MAILBOX_REPLY)?.value).not.toContain(decoy);
    // Consequential: no press of any kind reached the reader; Send stays the user's.
    expect(sc.desk.verbs.filter((v) => v.kind === "press")).toEqual([]);
    expect(sc.desk.pressed).toEqual([]);
    expect(last(sc, "finished")).toMatchObject({ outcome: "handoff", says: "Ready: 3 done. 'Send' reads as outbound; you press it." });
    // Calls: one writer call, two observations, no chooser call (the program found the rows by label).
    expect(sc.writer.requests).toHaveLength(1);
    expect(sc.helper.goals.replayCounts(first.goalId)).toMatchObject({ observations: 2, newChoices: 0, pending: false });
    expect(askJev.chooses).toBe(0);
    // One Tab per segment: three previews, three acceptances, one grant per segment task.
    expect(segments(sc, first.goalId)).toHaveLength(3);
    expect(sc.desk.grants.log.filter((g) => g.type === "actGrant").map((g) => g.type === "actGrant" && g.taskId)).toEqual([`${first.goalId}:s0`, `${first.goalId}:s1`, `${first.goalId}:s2`]);
  });

  it("20 runs with a new code each: every reply holds exactly its run's code, and nothing else is written", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await nativeRun();
      expect(r.sc.desk.writes).toEqual([{ windowId: "6262-1", key: MAILBOX_REPLY, value: `Hi Dana, the confirmation number is ${r.code}.` }]);
      expect(r.sc.desk.verbs.filter((v) => v.kind === "press")).toEqual([]);
      await r.sc.close();
      scenes.splice(scenes.indexOf(r.sc), 1);
    }
  }, 240_000);

  it("already open: the first step finds Kayak's message on screen, waits for nothing, and the rest proceeds", async () => {
    const { code, decoy } = codes();
    const messages = mailMessages(code, decoy);
    const sc = scene({ scripts: [NATIVE], windows: [mailboxWindow(messages, "kayak")], userWindow: "6262-1", askJev: jev() });
    const first = await sc.request(INSTRUCTION);
    await sc.accept(first.goalId);
    expect(waiting(sc)).toEqual([]);
    expect(sc.helper.goals.get(first.goalId)?.cursor.receipts.map((r) => [r.step, r.status])).toEqual([[0, "alreadyTrue"]]);
    expect(segments(sc, first.goalId)[1]?.steps.map((s) => s.says)).toEqual(["Open 'Flight itinerary' (Dana Whitfield) yourself. Caret continues once it's open"]);
    expect(acts(sc)).toEqual([]);
  });

  it("the user's own clicks in the window while Caret waits do not stop the goal", async () => {
    const { code, decoy } = codes();
    const messages = mailMessages(code, decoy);
    const sc = scene({ scripts: [NATIVE], windows: [mailboxWindow(messages)], userWindow: "6262-1", askJev: jev() });
    const first = await sc.request(INSTRUCTION);
    await acceptAndDo(sc, first.goalId, () => {
      void sc.helper.handleReader({ type: "userInput", v: PROTOCOL_VERSION, at: (sc.desk.at += 10), pid: MAILBOX.pid, kind: "mouse", point: null });
      void sc.helper.handleReader({ type: "userInput", v: PROTOCOL_VERSION, at: (sc.desk.at += 10), pid: MAILBOX.pid, kind: "key", point: null });
      userOpens(sc.desk, "6262-1", messages, "kayak");
    });
    expect(last(sc, "stopped")).toBeUndefined();
    expect(segments(sc, first.goalId)).toHaveLength(2);
  });

  it("opening the decoy instead never verifies Kayak's: the wait runs out, the rest is left, and nothing is filled", async () => {
    const { code, decoy } = codes();
    const messages = mailMessages(code, decoy);
    const sc = scene({ scripts: [NATIVE], windows: [mailboxWindow(messages)], userWindow: "6262-1", askJev: jev(), waitForYouMs: 200 });
    const first = await sc.request(INSTRUCTION);
    await acceptAndDo(sc, first.goalId, () => userOpens(sc.desk, "6262-1", messages, "dana-old"));
    const stop = last(sc, "stopped");
    expect(stop && [stop.reason, stop.says.endsWith("The rest is yours.")]).toEqual(["handedOff", true]);
    expect(stop?.says).toMatch(/^Caret waited less than a second for this and left it as is: Open 'Flight itinerary' \(Kayak\) yourself/);
    expect(segments(sc, first.goalId)).toHaveLength(1);
    expect(acts(sc)).toEqual([]);
    expect(sc.helper.goals.replayCounts(first.goalId)).toMatchObject({ observations: 0 });
  });

  it("stale card: a row whose cells changed between the preview and Tab stops the goal, and nothing runs", async () => {
    const { code, decoy } = codes();
    const messages = mailMessages(code, decoy);
    const sc = scene({ scripts: [NATIVE], windows: [mailboxWindow(messages)], userWindow: "6262-1", askJev: jev() });
    const first = await sc.request(INSTRUCTION);
    sc.desk.show(mailboxWindow(messages.map((m) => (m.id === "kayak" ? { ...m, subject: "Flight itinerary (changed)" } : m))));
    expect(await sc.accept(first.goalId)).toBeNull();
    expect(last(sc, "stopped")).toMatchObject({ reason: "targetChanged", freshPlan: null });
    expect(waiting(sc)).toEqual([]);
    expect(acts(sc)).toEqual([]);
    expect(sc.writer.requests).toHaveLength(1);
  });

  it("stop while Caret waits for the user: the goal ends there, with no further preview", async () => {
    const { code, decoy } = codes();
    const messages = mailMessages(code, decoy);
    const sc = scene({ scripts: [NATIVE], windows: [mailboxWindow(messages)], userWindow: "6262-1", askJev: jev() });
    const first = await sc.request(INSTRUCTION);
    await acceptAndDo(sc, first.goalId, () => void sc.helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: `${first.goalId}:s0`, action: "stop" }, sc.session));
    expect(last(sc, "stopped")).toMatchObject({ reason: "you", freshPlan: null });
    expect(segments(sc, first.goalId)).toHaveLength(1);
    expect(acts(sc)).toEqual([]);
  });

  it("stop between segments: the next preview cannot be accepted, and nothing more runs", async () => {
    const { code, decoy } = codes();
    const messages = mailMessages(code, decoy);
    const sc = scene({ scripts: [NATIVE], windows: [mailboxWindow(messages)], userWindow: "6262-1", askJev: jev() });
    const first = await sc.request(INSTRUCTION);
    await acceptAndDo(sc, first.goalId, () => userOpens(sc.desk, "6262-1", messages, "kayak"));
    expect(segments(sc, first.goalId)).toHaveLength(2);
    await sc.helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: `${first.goalId}:s0`, action: "stop" }, sc.session);
    expect(last(sc, "stopped")).toMatchObject({ reason: "you" });
    expect(await sc.accept(first.goalId)).toBeNull();
    expect(waiting(sc)).toHaveLength(1);
    expect(acts(sc)).toEqual([]);
  });

  it("a fourth observe stops at the goal's limit of three: what ran is kept, the rest is the user's, and nothing more runs", async () => {
    const { code, decoy } = codes();
    const messages = mailMessages(code, decoy);
    const FOUR = {
      source: `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  let w = await caret.readWindow();
  const steps = [];
  for (const sender of ["Kayak", "Dana Whitfield", "Kayak", "Dana Whitfield"]) {
    const s = caret.navigate(w.targets.find((t) => t.kind === "row" && t.label.startsWith(sender + " · ")).ref, "e:open");
    steps.push(s);
    w = await caret.observe(s);
  }
  return caret.plan({ basedOn: "s1", steps });
}`,
    };
    const sc = scene({ scripts: [FOUR], windows: [mailboxWindow(messages)], userWindow: "6262-1", askJev: jev() });
    const first = await sc.request(INSTRUCTION);
    for (const id of ["kayak", "dana", "kayak"]) await acceptAndDo(sc, first.goalId, () => userOpens(sc.desk, "6262-1", messages, id));
    const stop = last(sc, "stopped");
    expect(stop?.says).toBe("Caret reads at most 3 views for one goal. The rest is yours.");
    expect(segments(sc, first.goalId)).toHaveLength(3);
    expect(sc.helper.goals.get(first.goalId)?.cursor.receipts.map((r) => r.status)).toEqual(["verified", "verified", "verified"]);
    expect(sc.helper.goals.replayCounts(first.goalId)).toMatchObject({ observations: 3 });
    expect(acts(sc)).toEqual([]);
    expect(sc.writer.requests).toHaveLength(1);
  });

  it("a replay whose recorded choice no longer matches its request ends as diverged, and nothing more runs", async () => {
    const { code, decoy } = codes();
    const messages = mailMessages(code, decoy);
    const CHOOSING = {
      source: `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const box = await caret.readWindow();
  const q = box.questions[0];
  const pick = await caret.choose(q.options.map((o) => o.ref));
  const label = q.options.find((o) => o.ref === pick).label;
  const open = caret.navigate(box.targets.find((t) => t.label === label).ref, "e:open");
  const seen = await caret.observe(open);
  const reply = caret.fill(seen.targets.find((t) => t.kind === "text" && t.label.endsWith("Reply")).ref, caret.draft("Hi, I read it.", [seen.window]));
  return caret.plan({ basedOn: box.snapshot, steps: [open, reply] });
}`,
    };
    const askJev = jev();
    const sc = scene({ scripts: [CHOOSING], windows: [mailboxWindow(messages)], userWindow: "6262-1", askJev });
    const first = await sc.request(INSTRUCTION);
    expect(askJev.chooses).toBe(1);
    // The goal's record, as the next replay would read it: its one choice's request digest no longer matches.
    const state = (sc.helper.goals as unknown as { runs: Map<string, { replay: { record: { choices: { requestDigest: string }[] } } }> }).runs.get(first.goalId)?.replay;
    const first0 = state?.record.choices[0];
    if (first0 === undefined) throw new Error("no recorded choice");
    first0.requestDigest = "0".repeat(64);
    // The stand-in chooses the first row, Kayak's.
    await acceptAndDo(sc, first.goalId, () => userOpens(sc.desk, "6262-1", messages, "kayak"));
    expect(last(sc, "stopped")?.says).toBe("The plan ran differently the second time. The rest is yours.");
    expect(askJev.chooses).toBe(1);
    expect(acts(sc)).toEqual([]);
  });
});

describe("page task: open Kayak's thread in a Gmail-shaped page and draft the reply (milestone A)", { timeout: 60_000 }, () => {
  const PAGE_INSTRUCTION = "Reply to Kayak's flight itinerary with its confirmation number";
  const doc = () => "doc-1";

  async function pageRun(): Promise<{ sc: GoalScene; goalId: string; code: string; decoy: string; askJev: ReturnType<typeof jev> }> {
    const { code, decoy } = codes();
    const messages = mailMessages(code, decoy);
    const askJev = jev();
    const sc = scene({ scripts: [PAGE], windows: [webmailWindow(messages)], userWindow: WEBMAIL_ID, askJev, pageDocument: (id) => (id === WEBMAIL_ID ? doc() : null) });
    const first = await sc.request(PAGE_INSTRUCTION);
    if (first.event !== "segment") throw new Error(`no preview: ${JSON.stringify(first)}`);
    await acceptAndDo(sc, first.goalId, () => userOpens(sc.desk, WEBMAIL_ID, messages, "kayak"));
    await sc.accept(first.goalId);
    return { sc, goalId: first.goalId, code, decoy, askJev };
  }

  it("one observe, two segments: the thread replaces the list, and only the drafted reply is written", async () => {
    const { sc, goalId, code, decoy, askJev } = await pageRun();
    const segs = segments(sc, goalId);
    expect(segs.map((s) => s.steps.map((x) => [x.kind, x.tier]))).toEqual([[["handoff", "navigate"]], [["write", "write"], ["handoff", "yours"]]]);
    // The page retitled itself on open, and the second preview names it so.
    expect(segs[1]?.where).toEqual({ kind: "window", app: "Google Chrome", title: "Flight itinerary - Mail" });
    const drafted = `Thanks, the confirmation number is ${code}.`;
    expect(sc.desk.writes).toEqual([{ windowId: WEBMAIL_ID, key: WEBMAIL_REPLY, value: drafted }]);
    expect(sc.desk.node(WEBMAIL_ID, WEBMAIL_REPLY)?.value).not.toContain(decoy);
    expect(sc.desk.verbs.filter((v) => v.kind === "press")).toEqual([]);
    expect(last(sc, "finished")).toMatchObject({ outcome: "handoff" });
    expect(sc.writer.requests).toHaveLength(1);
    expect(sc.helper.goals.replayCounts(goalId)).toMatchObject({ observations: 1, newChoices: 0 });
    expect(askJev.chooses).toBe(0);
  });

  it("20 runs with a new code each write exactly that run's code", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await pageRun();
      expect(r.sc.desk.writes).toEqual([{ windowId: WEBMAIL_ID, key: WEBMAIL_REPLY, value: `Thanks, the confirmation number is ${r.code}.` }]);
      await r.sc.close();
      scenes.splice(scenes.indexOf(r.sc), 1);
    }
  }, 240_000);

  it("the row-shaped submit button in a form is never listed as a row, and the list's rows are", async () => {
    const { code, decoy } = codes();
    const sc = scene({ scripts: [], windows: [webmailWindow(mailMessages(code, decoy))], userWindow: WEBMAIL_ID, askJev: jev(), pageDocument: (id) => (id === WEBMAIL_ID ? doc() : null) });
    await sc.request(PAGE_INSTRUCTION);
    const targets = sc.writer.requests[0]?.[0]?.targets ?? [];
    expect(targets.find((t) => t.label === "Search flights")).toMatchObject({ kind: "button", allowedPressEffects: ["e:yours"] });
    expect(targets.find((t) => t.label === "Search flights")?.allowedNavigateEffects).toBeUndefined();
    const rows = targets.filter((t) => t.kind === "row");
    expect(rows.map((t) => t.label)).toContain("Kayak · Flight itinerary · 3m ago");
    // A page row is the user's to open until the page engine qualifies it (slice 2 step 3), but every effect is offered.
    expect(rows[0]?.allowedNavigateEffects).toEqual(["e:select", "e:open", "e:yours"]);
    // The list's choice group offers exactly the rows the request could carry: a conversation discloses under half.
    expect(sc.writer.requests[0]?.[0]?.questions.map((q) => q.options.map((x) => x.label))).toEqual([rows.map((t) => t.label)]);
  });

  it("a control outside the list that repeats the row's cells makes the open look done: Caret skips it, and nothing is written", async () => {
    // CU-COUNSEL-R2 D2: the weak form's false positive fails safe. The observation lacks the code, the program cannot
    // find it, and the goal ends with the rest left to the user.
    const { code, decoy } = codes();
    const messages = mailMessages(code, decoy);
    const sc = scene({ scripts: [PAGE], windows: [webmailWindow(messages, null, { negative: "Kayak Flight itinerary" })], userWindow: WEBMAIL_ID, askJev: jev(), pageDocument: (id) => (id === WEBMAIL_ID ? doc() : null) });
    const first = await sc.request(PAGE_INSTRUCTION);
    await sc.accept(first.goalId);
    expect(sc.helper.goals.get(first.goalId)?.cursor.receipts.map((r) => r.status)).toEqual(["alreadyTrue"]);
    expect(last(sc, "stopped")?.says).toMatch(/The rest is yours\.$/);
    expect(acts(sc)).toEqual([]);
  });
});

it("the native window's rows are listed with their cells, and none of them is selected yet", () => {
  const w = mailboxWindow(mailMessages("AAAAAA", "BBBBBB"));
  expect(w.nodes.filter((n) => n.role === "AXRow").map((n) => n.key)).toContain(mailboxRowKey("kayak"));
  expect(w.nodes.some((n) => n.states?.includes("selected"))).toBe(false);
});
