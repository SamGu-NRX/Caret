// B19: Caret names a proven routine, offers once to keep it as a skill, counts the skill's clean runs,
// and after PROMOTE_AFTER of them offers to run it without a Tab. Everything here is synthetic.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { ScreenModel } from "../src/model.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { HelperMessage, PROTOCOL_VERSION, ConsumerMessage, type MemoryEntry, type MemoryReply, type PatternOffer, type SkillOffer, type TaskProgress } from "../src/protocol.ts";
import { checkName, fallbackName, nameCandidates, nameRoutine, safeFacts, type RoutineFacts } from "../src/patterns/naming.ts";
import { cleanRun, handedPress, mayRunUnasked, PROMOTE_AFTER } from "../src/patterns/skills.ts";
import type { TaskResult } from "../src/executor/executor.ts";
import { Desk, buttonKey, cellKey, type GridWindow, type ListWindow } from "./scene.ts";
import { FIXTURE_APP, MAIL_APP, snap } from "./builders.ts";

const DAY = 24 * 60 * 60 * 1000;

// MARK: - naming, as pure functions

describe("naming a routine from its structure", () => {
  const model = new ScreenModel();
  model.apply(
    snap(
      [
        { key: "m/subject", parent: null, role: "AXTextField", label: "Subject", editable: true },
        { key: "m/to", parent: null, role: "AXTextField", label: "To", editable: true },
        { key: "m/link", parent: null, role: "AXTextField", label: "Link", editable: true },
      ],
      { at: 1, windowId: "6160-1", app: MAIL_APP, title: "New message" },
    ),
  );
  const dst = model.windows.get("6160-1")!;
  const values = ["Design review 4", "priya.raman+4@northwind.example", "https://meet.example.com/day-4"];
  const facts = (over: Partial<RoutineFacts> = {}): RoutineFacts => ({
    routineId: "routine-1",
    dstApp: "Mail Fixture",
    dstWindow: dst,
    dstLabels: ["Subject", "To", "Link"],
    srcApps: ["Caret Fixture"],
    srcLabels: [],
    count: 3,
    values,
    ...over,
  });

  it("checks a name: six words at most, the destination app or a field, no value and no word of one", () => {
    const f = facts();
    expect(checkName("Subject, To and Link into Mail Fixture", f)).toMatch(/7 words/);
    expect(checkName("Subject and To into Mail", f)).toBeNull();
    expect(checkName("Caret Fixture to somewhere", f)).toMatch(/neither the destination app/);
    expect(checkName("Design review 4 to Mail Fixture", f)).toMatch(/holds a value/);
    expect(checkName("Review to Mail Fixture", f)).toMatch(/word of a value/);
    expect(checkName("Fill Mail Fixture\nnow", f)).toMatch(/one line/);
    // A word the structure itself uses is not a value's, even when a value also has it.
    expect(checkName("Link into Mail Fixture", facts({ values: ["Link to the deck"] }))).toBeNull();
  });

  it("drops a label that holds a value or that a value holds, and composes names that each pass", () => {
    const f = safeFacts(facts({ dstLabels: ["Subject", "Design review 4", "To"], srcLabels: [{ window: dst, text: "review" }] }));
    expect(f.dstLabels).toEqual(["Subject", "To"]);
    expect(f.srcLabels).toEqual([]);
    const names = nameCandidates(f);
    expect(names.length).toBeGreaterThan(2);
    for (const n of names) expect(checkName(n, f), n).toBeNull();
    expect(fallbackName(f)).toBe(names[0]);
  });

  const answering = (choice: (req: JevRequest) => string, confidence = 0.9, seen: JevRequest[] = []): AskJev => async (req) => {
    seen.push(req);
    return { model: "jev-test", answers: { name: { choice: choice(req), confidence } }, inputTokens: 300, latencyMs: 1, costUsd: 300 * 0.042e-6 };
  };
  const first = (req: JevRequest): string => Object.keys(req.questions.name!.criteria).find((k) => k !== "none")!;

  it("keeps Jev's pick of code's names after one ask, and declares only labels", async () => {
    const seen: JevRequest[] = [];
    const r = await nameRoutine(facts(), answering(first, 0.9, seen), () => model.windows.values(), () => 0);
    expect(r).toMatchObject({ by: "jev", asks: 1, failures: [] });
    expect(checkName(r.name!, safeFacts(facts()))).toBeNull();
    const req = seen[0]!;
    expect(req.snippets.filter((s) => s.windowId === "6160-1").map((s) => [s.kind, s.text])).toEqual([["descriptor", "Subject"], ["descriptor", "To"], ["descriptor", "Link"]]);
    const body = JSON.stringify([req.state, req.questions]);
    for (const v of values) expect(body.includes(v), v).toBe(false);
    expect(req.state).toMatchObject({ into: "Mail Fixture", from: ["Caret Fixture"], timesSeen: 3 });
  });

  it("asks once more after a failed ask, then falls back to code's name", async () => {
    for (const [why, ask] of [
      ["none", answering(() => "none")],
      ["not a candidate", answering(() => "n99")],
      ["under", answering(first, 0.2)],
      ["Jev failed", (async () => { throw new Error("HTTP 503"); }) as AskJev],
    ] as const) {
      const r = await nameRoutine(facts(), ask, () => model.windows.values(), () => 0);
      expect(r.asks, why).toBe(2);
      expect(r.failures).toHaveLength(2);
      expect(r.failures[0]).toContain(why);
      expect(r.by).toBe("code");
      expect(r.name).toBe(fallbackName(safeFacts(facts())));
    }
    let n = 0;
    const second = await nameRoutine(facts(), answering((req) => (n++ === 0 ? "none" : first(req))), () => model.windows.values(), () => 0);
    expect(second).toMatchObject({ by: "jev", asks: 2 });
  });

  it("names by code at once with Jev off", async () => {
    expect(await nameRoutine(facts(), null, () => model.windows.values())).toMatchObject({ by: "code", asks: 0, name: fallbackName(safeFacts(facts())) });
  });
});

describe("what a skill may do, as pure rules", () => {
  it("lets write-here run unasked from ask or act, and write-elsewhere only when pre-approved", () => {
    expect(mayRunUnasked("writeHere", "ask")).toBe(true);
    expect(mayRunUnasked("writeHere", "act")).toBe(true);
    expect(mayRunUnasked("writeElsewhere", "ask")).toBe(false);
    expect(mayRunUnasked("writeElsewhere", "actIfApproved")).toBe(true);
  });

  it("calls a run clean when it reached every end state, or stopped only at the hand-off it ends with", () => {
    const write = { says: "x", end: { kind: "valueEquals" as const, window: { title: "t" }, target: { key: "k", describe: "d" }, value: "v" } };
    const send = { says: "press", end: { kind: "handoff" as const, window: { title: "t" }, target: { key: "b", describe: "Send" }, why: "outbound" as const } };
    const plain = { id: "p", title: "t", slots: {}, steps: [write, write] };
    const withSend = { ...plain, steps: [write, send] };
    expect(cleanRun(plain, { outcome: "done", step: null })).toBe(true);
    expect(cleanRun(plain, { outcome: "stopped", step: 1 })).toBe(false);
    expect(cleanRun(withSend, { outcome: "handoff", step: 1 })).toBe(true);
    expect(cleanRun(withSend, { outcome: "handoff", step: 0 })).toBe(false);
    expect(handedPress(plain)).toBeNull();
    expect(handedPress(withSend)).toEqual({ step: 1, why: "outbound" });
    expect(handedPress({ ...plain, steps: [write, { says: "p", end: write.end, via: { kind: "press" as const, target: { label: "Pay now", describe: "Pay" } } }] })).toEqual({ step: 1, why: "money" });
  });
});

describe("the skill messages", () => {
  const offer: SkillOffer = {
    type: "skillOffer",
    v: PROTOCOL_VERSION,
    id: "skill-offer-1",
    at: 1,
    kind: "keep",
    taskId: "offer-4",
    routineId: "routine-1",
    skillId: null,
    name: "Subject and To into Mail",
    says: "Keep this as Subject and To into Mail?",
    detail: "Caret will offer it when you start it again.",
    actions: [{ id: "accept", label: "Keep" }, { id: "decline", label: "No thanks" }],
  };
  it("refuses a keep offer naming a skill and a promote offer naming none", () => {
    expect(HelperMessage.safeParse(offer).success).toBe(true);
    expect(HelperMessage.safeParse({ ...offer, skillId: "skill-1" }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...offer, kind: "promote" }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...offer, actions: [offer.actions[1], offer.actions[0]] }).success).toBe(false);
    expect(ConsumerMessage.safeParse(offer).success).toBe(false);
  });
  it("takes an answer from the host and an unprompted mark on progress, true or absent", () => {
    expect(ConsumerMessage.parse({ type: "skillAnswer", v: 1, id: "skill-offer-1", answer: "decline", at: 2 })).toMatchObject({ answer: "decline" });
    expect(ConsumerMessage.safeParse({ type: "skillAnswer", v: 1, id: "", answer: "accept", at: 2 }).success).toBe(false);
    const p = { type: "taskProgress", v: 1, at: 1, taskId: "t", planId: "t", step: null, steps: 3, says: null, detail: null, phase: "started" };
    expect(HelperMessage.safeParse({ ...p, unprompted: true }).success).toBe(true);
    expect(HelperMessage.safeParse({ ...p, unprompted: false }).success).toBe(false);
  });
});

// MARK: - in the helper

describe("skills in the helper", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let desk: Desk;
  let sent: HelperMessage[];
  let asked: JevRequest[];
  /** Set to take over the run at its first act. */
  let takeOverAtAct: string | null;
  /** While set, the namer's answer waits for it, as a slow network would. */
  let namingHeld: Promise<void> | null;

  const namer: AskJev = async (req) => {
    asked.push(req);
    if (namingHeld !== null) await namingHeld;
    const choice = Object.keys(req.questions.name?.criteria ?? {}).find((k) => k !== "none") ?? "none";
    return { model: "jev-test", answers: { name: { choice, confidence: 0.9 } }, inputTokens: 300, latencyMs: 1, costUsd: 0 };
  };
  const ask = (op: "list" | "edit" | "pause" | "resume" | "forget", rest: { id?: string; kind?: "routine" | "skill" | "permission"; fields?: Record<string, unknown> } = {}): MemoryReply =>
    helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "r", op, ...rest });
  const skills = (): Extract<MemoryEntry, { kind: "skill" }>[] => ask("list", { kind: "skill" }).entries.filter((e): e is Extract<MemoryEntry, { kind: "skill" }> => e.kind === "skill");
  const routines = (): Extract<MemoryEntry, { kind: "routine" }>[] => ask("list", { kind: "routine" }).entries.filter((e): e is Extract<MemoryEntry, { kind: "routine" }> => e.kind === "routine");
  const since = <T extends HelperMessage["type"]>(type: T, from: number): Extract<HelperMessage, { type: T }>[] =>
    sent.slice(from).filter((m): m is Extract<HelperMessage, { type: T }> => m.type === type);
  const answer = (o: SkillOffer, a: "accept" | "decline") => helper.handleSkillAnswer({ type: "skillAnswer", v: PROTOCOL_VERSION, id: o.id, answer: a, at: desk.at });
  const setRule = (action: "writeElsewhere" | "writeHere", rule: string) => expect(ask("edit", { id: `permission-${action}`, fields: { rule } }).error).toBeNull();

  const calendar = (day: number): ListWindow => ({
    windowId: "5150-20",
    app: FIXTURE_APP,
    title: "Calendar",
    group: "Event",
    lines: [`Design review ${day}`, `priya.raman+${day}@northwind.example`, `https://meet.example.com/day-${day}`],
  });
  const compose = (day: number, buttons?: string[]): GridWindow => ({ windowId: `6160-${100 + day}`, app: MAIL_APP, title: `New message ${day}`, columns: ["Subject", "To", "Link"], rows: 1, values: new Map(), ...(buttons === undefined ? {} : { buttons }) });

  let day = 0;
  let buttons: string[] | undefined;
  /** The user's frontmost app while a compose window opens: Mail makes the run's writes "write where you are". */
  let frontmost: "mail" | "other" = "other";

  /** One occurrence by hand: the calendar shows the day's event, a compose window opens, the user copies three values and closes it. */
  const byHand = (): PatternOffer[] => {
    const at = sent.length;
    const c = open();
    for (let i = 0; i < 3; i++) desk.fill(c, 0, i, calendar(day).lines[i]!);
    desk.close(c.windowId);
    return since("patternOffer", at);
  };
  const open = (): GridWindow => {
    day++;
    desk.at += DAY;
    desk.showList(calendar(day));
    desk.advance(1000);
    if (frontmost === "mail") void helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: desk.at, from: FIXTURE_APP, to: MAIL_APP });
    const c = compose(day, buttons);
    desk.showGrid(c);
    return c;
  };

  interface CaretRun {
    offer: PatternOffer | null;
    result: TaskResult | null;
    progress: TaskProgress[];
    skillOffers: SkillOffer[];
    window: GridWindow;
  }
  /** One occurrence Caret runs: taken with a Tab when offered, or started on its own. The window stays open until close(). */
  const caretRun = async (): Promise<CaretRun> => {
    const at = sent.length;
    const c = open();
    await helper.patterns.unpromptedSettled();
    const offer = since("patternOffer", at).find((o) => o.kind === "routine") ?? null;
    let result: TaskResult | null = null;
    if (offer !== null) result = (await helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: offer.id, action: "take" })) as TaskResult | null;
    return { offer, result, progress: since("taskProgress", at), skillOffers: since("skillOffer", at), window: c };
  };
  const finish = (r: CaretRun): void => {
    desk.advance(2000);
    desk.close(r.window.windowId);
  };
  const values = (g: GridWindow): string[] => g.columns.map((_, i) => g.values.get(cellKey(g, 0, i)) ?? "");

  /** Three occurrences by hand at Eager (two silent hits prove it), then one Caret run taken with Tab, whose end brings the keep offer. */
  const proveAndRun = async (): Promise<CaretRun> => {
    for (let i = 0; i < 3; i++) expect(byHand()).toEqual([]);
    await helper.patterns.skills.namesSettled();
    const r = await caretRun();
    finish(r);
    return r;
  };
  const keep = async (): Promise<string> => {
    const r = await proveAndRun();
    const offer = r.skillOffers.find((o) => o.kind === "keep");
    expect(offer).toBeDefined();
    answer(offer!, "accept");
    return skills()[0]!.id;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-skills-"));
    store = new Store(dir);
    sent = [];
    asked = [];
    day = 0;
    buttons = undefined;
    frontmost = "other";
    takeOverAtAct = null;
    namingHeld = null;
    desk = new Desk();
    desk.enforceGrants = true;
    helper = new Helper({
      store,
      askJev: namer,
      shadow: false,
      allowBackgroundFocus: false,
      publish: (m) => sent.push(HelperMessage.parse(m)),
      readerLink: desk,
      settings: { roles: ["fill", "repeat", "watch", "calendar", "words"], level: "eager", paused: false },
      executorHooks: {
        beforeAct: async (taskId) => {
          if (takeOverAtAct === taskId) await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId, action: "takeOver" });
        },
      },
    });
    desk.attach(helper);
    desk.grants.now = () => Date.now();
  });
  afterEach(() => {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("names a routine once when it is proven, from labels only, and offers to keep it after a Caret run", async () => {
    const r = await proveAndRun();
    // Named once, at the hit that proved it; Jev saw labels and app names, never a value.
    expect(asked).toHaveLength(1);
    const body = JSON.stringify([asked[0]!.state, asked[0]!.questions]);
    for (let d = 1; d <= 4; d++) for (const v of calendar(d).lines) expect(body.includes(v), v).toBe(false);
    const routine = routines()[0]!;
    expect(routine.fields.name).not.toBeNull();
    const name = routine.fields.name!;
    expect(name.split(/\s+/).length).toBeLessThanOrEqual(6);
    expect(/Mail Fixture|Subject|To|Link/.test(name)).toBe(true);

    expect(r.offer?.says).toBe("Fill 3 values from Caret Fixture");
    expect(r.result?.outcome).toBe("done");
    expect(r.skillOffers).toEqual([
      expect.objectContaining({ kind: "keep", taskId: r.offer!.id, routineId: routine.id, skillId: null, name, says: `Keep this as ${name}?`, detail: "Caret will offer it when you start it again." }),
    ]);
    answer(r.skillOffers[0]!, "accept");
    expect(sent.at(-1)).toMatchObject({ type: "offerWithdrawn", id: r.skillOffers[0]!.id, reason: "taken" });
    const [skill] = skills();
    expect(skill).toMatchObject({ status: "learning", fields: { routineId: routine.id, name, trigger: "a Mail Fixture window opens with Subject, To and Link empty", runs: 0, cleanRuns: 0, needed: PROMOTE_AFTER, onItsOwn: false, handsOff: null } });
    expect(skill!.says).toBe(`${name}: when a Mail Fixture window opens with Subject, To and Link empty (ran 0 times; asks first; 0 of 10 clean runs in a row)`);
    // The whole list carries the skill too.
    expect(ask("list").entries.some((e) => e.kind === "skill")).toBe(true);

    // A kept routine is offered by its name, and its runs count.
    const next = await caretRun();
    finish(next);
    expect(next.offer?.says).toBe(name);
    expect(skills()[0]!.fields).toMatchObject({ runs: 1, cleanRuns: 1 });
    // Naming is never asked again.
    expect(asked).toHaveLength(1);
  });

  it("keeps the first name: a keep offer made while Jev's answer is on its way shows code's name, and the late answer changes nothing", async () => {
    let release: () => void = () => undefined;
    namingHeld = new Promise<void>((r) => (release = r));
    for (let i = 0; i < 3; i++) byHand();
    const r = await caretRun();
    finish(r);
    const shown = r.skillOffers[0]!.name;
    expect(helper.memory.routine(routines()[0]!.id)?.nameBy).toBe("code");
    release();
    await helper.patterns.skills.namesSettled();
    expect(routines()[0]!.fields.name).toBe(shown);
    answer(r.skillOffers[0]!, "accept");
    expect(skills()[0]!.fields.name).toBe(shown);
  });

  it("remembers a declined keep offer, and asks again after a later run when nobody answered", async () => {
    const r = await proveAndRun();
    answer(r.skillOffers[0]!, "decline");
    expect(sent.at(-1)).toMatchObject({ type: "offerWithdrawn", reason: "dismissed" });
    for (let i = 0; i < 2; i++) {
      const again = await caretRun();
      finish(again);
      expect(again.result?.outcome).toBe("done");
      expect(again.skillOffers).toEqual([]);
    }
    expect(skills()).toEqual([]);
    // Answering an offer that is gone is refused, loudly.
    const errors = sent.length;
    answer(r.skillOffers[0]!, "accept");
    expect(since("error", errors)[0]?.message).toMatch(/no such offer/);
  });

  it("makes the keep offer again after one expired unanswered", async () => {
    const r = await proveAndRun();
    desk.advance(3 * 60 * 1000);
    expect(sent.some((m) => m.type === "offerWithdrawn" && m.id === r.skillOffers[0]!.id && m.reason === "expired")).toBe(true);
    const again = await caretRun();
    finish(again);
    expect(again.skillOffers.map((o) => o.kind)).toEqual(["keep"]);
  });

  it("earns running on its own: one offer after ten clean runs, a run with no Tab that undo restores, and back on Tab after an undo or a mismatch", async () => {
    setRule("writeElsewhere", "actIfApproved");
    const skillId = await keep();
    for (let i = 1; i < PROMOTE_AFTER; i++) {
      const r = await caretRun();
      finish(r);
      expect(r.result?.outcome).toBe("done");
      expect(r.skillOffers, `run ${i}`).toEqual([]);
    }
    const tenth = await caretRun();
    finish(tenth);
    const promote = tenth.skillOffers.find((o) => o.kind === "promote")!;
    expect(promote).toMatchObject({ skillId, says: "Do this one on your own from now on?", detail: "You'll see it happen and can undo it.", taskId: tenth.offer!.id });
    expect(skills()[0]!.fields.cleanRuns).toBe(PROMOTE_AFTER);
    answer(promote, "accept");
    expect(skills()[0]).toMatchObject({ status: "active", fields: { onItsOwn: true } });

    // Run 11 starts from the trigger: no offer, every progress marked unprompted, values verified.
    const own = await caretRun();
    expect(own.offer).toBeNull();
    expect(own.progress.length).toBeGreaterThan(3);
    expect(own.progress.every((p) => p.unprompted === true)).toBe(true);
    expect(own.progress.at(-1)?.phase).toBe("done");
    expect(values(own.window)).toEqual(calendar(day).lines);
    // It ran under an act grant for its window, as an accepted offer does.
    expect(desk.grants.log.some((g) => g.type === "actGrant" && g.taskId === own.progress[0]!.taskId && g.windowId === own.window.windowId)).toBe(true);
    // The toast's undo restores it, and resets the count: the skill is back on Tab.
    const undo = await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: own.progress[0]!.taskId, action: "undo" });
    expect(undo).toMatchObject({ restored: 3 });
    expect(values(own.window)).toEqual(["", "", ""]);
    expect(sent.filter((m): m is TaskProgress => m.type === "taskProgress" && m.taskId === own.progress[0]!.taskId).at(-1)).toMatchObject({ phase: "undone", unprompted: true });
    finish(own);
    expect(skills()[0]).toMatchObject({ status: "learning", fields: { onItsOwn: false, cleanRuns: 0 } });
    const afterUndo = await caretRun();
    finish(afterUndo);
    expect(afterUndo.offer).not.toBeNull();

    // Earned again, then a forced mismatch on a run with no Tab resets it, and the next run needs Tab.
    for (let i = 2; i <= PROMOTE_AFTER; i++) {
      const r = await caretRun();
      finish(r);
      if (i === PROMOTE_AFTER) answer(r.skillOffers.find((o) => o.kind === "promote")!, "accept");
    }
    desk.rewriteNext = (v) => v.toUpperCase();
    const bad = await caretRun();
    expect(bad.offer).toBeNull();
    expect(bad.progress.at(-1)).toMatchObject({ phase: "stopped", stopReason: "mismatch", unprompted: true });
    finish(bad);
    expect(skills()[0]).toMatchObject({ status: "learning", fields: { onItsOwn: false, cleanRuns: 0 } });
    const needsTab = await caretRun();
    finish(needsTab);
    expect(needsTab.offer).not.toBeNull();
    expect(needsTab.progress.every((p) => p.unprompted === undefined)).toBe(true);
  });

  it("resets on a take over, and never offers again after a declined promote offer", async () => {
    frontmost = "mail";
    await keep();
    for (let i = 1; i <= PROMOTE_AFTER; i++) {
      const r = await caretRun();
      finish(r);
      if (i === PROMOTE_AFTER) answer(r.skillOffers.find((o) => o.kind === "promote")!, "decline");
    }
    expect(skills()[0]!.fields).toMatchObject({ cleanRuns: PROMOTE_AFTER, onItsOwn: false });
    // A take over mid-run is not a clean run.
    const next = open();
    void next;
    const offer = sent.filter((m): m is PatternOffer => m.type === "patternOffer").at(-1)!;
    takeOverAtAct = offer.id;
    const r = (await helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: offer.id, action: "take" })) as TaskResult;
    expect(r.outcome).toBe("paused");
    takeOverAtAct = null;
    desk.close(next.windowId);
    expect(skills()[0]!.fields.cleanRuns).toBe(0);
    // Ten more clean runs: the declined offer is not made again.
    for (let i = 1; i <= PROMOTE_AFTER + 1; i++) {
      const again = await caretRun();
      finish(again);
      expect(again.skillOffers).toEqual([]);
    }
  });

  it("is capped by the permission rule: nothing elsewhere is promoted past ask first, and a promoted skill asks again once the rule goes back", async () => {
    await keep();
    for (let i = 1; i <= PROMOTE_AFTER; i++) {
      const r = await caretRun();
      finish(r);
      expect(r.skillOffers, `run ${i}`).toEqual([]);
    }
    setRule("writeElsewhere", "actIfApproved");
    const r = await caretRun();
    finish(r);
    answer(r.skillOffers.find((o) => o.kind === "promote")!, "accept");
    const own = await caretRun();
    finish(own);
    expect(own.offer).toBeNull();
    setRule("writeElsewhere", "ask");
    const capped = await caretRun();
    finish(capped);
    expect(capped.offer).not.toBeNull();
    expect(capped.progress.every((p) => p.unprompted === undefined)).toBe(true);
  });

  it("learns a Send at the end, hands it off on every run, and never promotes the skill", async () => {
    buttons = ["Send"];
    setRule("writeElsewhere", "actIfApproved");
    setRule("writeHere", "act");
    await keep();
    expect(skills()[0]!.fields.handsOff).toEqual({ label: "Send", why: "outbound" });
    expect(skills()[0]!.says).toContain("you press 'Send' yourself");
    for (let i = 1; i <= PROMOTE_AFTER + 2; i++) {
      const r = await caretRun();
      finish(r);
      expect(r.result).toMatchObject({ outcome: "handoff", step: 3 });
      expect(r.progress.at(-1)).toMatchObject({ phase: "handoff", says: "You press 'Send'" });
      expect(values(r.window)).toEqual(calendar(day).lines);
      expect(r.skillOffers).toEqual([]);
    }
    expect(skills()[0]!.fields).toMatchObject({ runs: PROMOTE_AFTER + 2, cleanRuns: PROMOTE_AFTER + 2, onItsOwn: false });
    // Caret never pressed it, nor asked the reader to.
    expect(desk.pressed).toEqual([]);
    expect(desk.verbs.some((v) => v.kind === "press")).toBe(false);
    expect(buttonKey(compose(1, buttons), "Send")).toMatch(/button:send~0$/);
  });

  it("forgets a skill without relearning the keep offer, pauses its offers with it, and renames it", async () => {
    const skillId = await keep();
    expect(ask("edit", { id: skillId, fields: { name: "  Reply to the review  " } }).entries[0]).toMatchObject({ fields: { name: "Reply to the review" } });
    expect(ask("edit", { id: skillId, fields: { name: "a\nb" } }).error).toMatch(/one line/);
    expect(ask("pause", { id: skillId }).entries[0]?.status).toBe("paused");
    const paused = await caretRun();
    finish(paused);
    expect(paused.offer).toBeNull();
    expect(ask("resume", { id: skillId }).entries[0]?.status).toBe("learning");
    expect(ask("forget", { id: skillId }).error).toBeNull();
    expect(skills()).toEqual([]);
    const after = await caretRun();
    finish(after);
    expect(after.result?.outcome).toBe("done");
    expect(after.skillOffers).toEqual([]);
    // Forgetting the routine takes a skill with it.
    const routineId = routines()[0]!.id;
    expect(ask("forget", { id: routineId }).error).toBeNull();
    expect(ask("list").entries.filter((e) => e.kind === "skill" || e.kind === "routine")).toEqual([]);
  });

  it("names nothing and offers nothing for a routine whose predictions miss", async () => {
    // Two lines copied each day, swapped from the day before, so each prediction (yesterday's positions) misses.
    for (let i = 0; i < 5; i++) {
      const c = open();
      const [a, b] = i % 2 === 0 ? [0, 2] : [2, 0];
      desk.fill(c, 0, 0, calendar(day).lines[a]!);
      desk.fill(c, 0, 2, calendar(day).lines[b]!);
      desk.close(c.windowId);
    }
    expect(routines()[0]!.fields.silent).toEqual({ hits: 0, misses: 4 });
    await helper.patterns.skills.namesSettled();
    expect(asked).toEqual([]);
    expect(routines().every((r) => r.fields.name === null)).toBe(true);
    expect(sent.some((m) => m.type === "skillOffer")).toBe(false);
  });
});
