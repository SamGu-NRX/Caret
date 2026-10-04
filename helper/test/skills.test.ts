// B19: Caret names a proven routine, offers once to keep it as a skill, counts the skill's clean runs,
// and after PROMOTE_AFTER of them offers to run it without a Tab. Everything here is synthetic.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { ScreenModel } from "../src/model.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { HelperMessage, PROTOCOL_VERSION, ConsumerMessage, type MemoryEntry, type MemoryReply, type PatternOffer, type PressVia, type SkillOffer, type TaskProgress } from "../src/protocol.ts";
import { checkName, fallbackName, nameCandidates, nameRoutine, safeFacts, type RoutineFacts } from "../src/patterns/naming.ts";
import { cleanRun, handedPress, mayRunUnasked, PROMOTE_AFTER, trigger } from "../src/patterns/skills.ts";
import { PRESS_ENDS_MS } from "../src/patterns/routines.ts";
import { dontOfferMatch } from "../src/patterns/memory.ts";
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

  it("keeps an app named like a copied value, and short values, out of the request and the name", async () => {
    // "Airtable" copied into Airtable: the app name is a value here.
    const app = safeFacts(facts({ dstApp: "Airtable", values: [...values, "Airtable"] }));
    expect(app.dstApp).toBe("");
    expect(nameCandidates(app).every((n) => !/airtable/i.test(n))).toBe(true);
    const seen: JevRequest[] = [];
    await nameRoutine(facts({ dstApp: "Airtable", values: [...values, "Airtable"] }), answering(first, 0.9, seen), () => model.windows.values(), () => 0);
    expect(JSON.stringify([seen[0]!.state, seen[0]!.questions]).includes("Airtable")).toBe(false);
    // A two-character value is a word, not a substring: "42" knocks out "Account 42", not "Link".
    const short = safeFacts(facts({ dstLabels: ["Account 42", "Link"], values: ["42"] }));
    expect(short.dstLabels).toEqual(["Link"]);
    expect(checkName("Account 42 into Mail Fixture", facts({ values: ["42"] }))).toMatch(/holds a value/);
    expect(checkName("Link into Mail Fixture", facts({ values: ["42"] }))).toBeNull();
    // A value with no letters or digits is looked for as it is.
    expect(safeFacts(facts({ dstLabels: ["Subject -", "Link"], values: ["-"] })).dstLabels).toEqual(["Link"]);
    expect(checkName("Copy Subject - into Mail Fixture", facts({ values: ["-"] }))).toMatch(/holds a value/);
  });

  it("declares a line another window shows when a composed name holds it", async () => {
    const m = new ScreenModel();
    m.apply(snap([...dst.nodes.values()], { at: 1, windowId: "6160-1", app: MAIL_APP, title: "New message" }));
    m.apply(snap([{ key: "n/line", parent: null, role: "AXStaticText", label: "Subject and To into Mail Fixture" }], { at: 1, windowId: "9090-1", title: "Notes" }));
    const seen: JevRequest[] = [];
    await nameRoutine(facts({ dstWindow: m.windows.get("6160-1")! }), answering(first, 0.9, seen), () => m.windows.values(), () => 0);
    expect(seen[0]!.snippets).toContainEqual({ windowId: "9090-1", kind: "candidate", text: "Subject and To into Mail Fixture" });
    // At least the line; the ledger also charges the labels and app name the line contains, counting overlaps twice.
    expect(seen[0]!.charged["9090-1"]).toBeGreaterThanOrEqual("Subject and To into Mail Fixture".length);
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
  it("says a keep offer's trigger with the article its app's name takes", () => {
    const facts = (dstApp: string) => ({ routineId: "r", dstApp, dstWindow: null, dstLabels: ["Name", "Email"], srcApps: [], srcLabels: [], count: 3, values: [] });
    expect(trigger(facts("Electron"))).toBe("an Electron window opens with Name and Email empty");
    expect(trigger(facts("Google Chrome"))).toBe("a Google Chrome window opens with Name and Email empty");
    expect(trigger(facts(""))).toBe("a window opens with Name and Email empty");
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
  const HOST = "test-host";
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
  /** Set to leave any run hanging, for good, right before its act at this step: a helper that died there. */
  let hangAtStep: number | null;

  const namer: AskJev = async (req) => {
    asked.push(req);
    if (namingHeld !== null) await namingHeld;
    const choice = Object.keys(req.questions.name?.criteria ?? {}).find((k) => k !== "none") ?? "none";
    return { model: "jev-test", answers: { name: { choice, confidence: 0.9 } }, inputTokens: 300, latencyMs: 1, costUsd: 0 };
  };
  const ask = (op: "list" | "edit" | "pause" | "resume" | "forget" | "offerOnItsOwn", rest: { id?: string; kind?: "routine" | "skill" | "permission"; fields?: Record<string, unknown> } = {}): MemoryReply =>
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
    hangAtStep = null;
    desk = new Desk();
    desk.enforceGrants = true;
    helper = makeHelper();
    desk.attach(helper);
    desk.grants.now = () => Date.now();
  });
  /** A helper on this test's store and desk; called again to stand for a restart. */
  const makeHelper = (): Helper => {
    const h = new Helper({
      store,
      askJev: namer,
      shadow: false,
      allowBackgroundFocus: false,
      publish: (m) => sent.push(HelperMessage.parse(m)),
      readerLink: desk,
      settings: { roles: ["fill", "repeat", "watch", "calendar", "words"], level: "eager", paused: false },
      executorHooks: {
        beforeAct: async (taskId, step) => {
          if (hangAtStep !== null && step === hangAtStep) await new Promise<void>(() => undefined);
          if (takeOverAtAct === taskId) await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId, action: "takeOver" });
        },
      },
    });
    // The host these tests play, in process: a run with no Tab starts only while a host session is connected (S1 audit #5).
    h.hostConnected(HOST);
    return h;
  };
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

  it("sends each skill's wrote, in the host's shape (memory.ndjson's last line), and empties it when the skill goes back on Tab", async () => {
    setRule("writeElsewhere", "actIfApproved");
    await keep();
    const r = await caretRun();
    finish(r);
    const golden = readFileSync(fileURLToPath(new URL("../fixtures/golden/memory.ndjson", import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { entries?: { fields: Record<string, unknown> }[] });
    const hostFields = golden.at(-1)?.entries?.[0]?.fields ?? {};
    const [skill] = skills();
    expect(skill!.fields.wrote).toEqual(["writeElsewhere"]);
    expect(Object.keys(skill!.fields).sort()).toEqual(Object.keys(hostFields).sort());
    expect(ask("edit", { id: skill!.id, fields: { onItsOwn: false } }).entries[0]).toMatchObject({ fields: { wrote: [] } });
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

  /** Kept, ten clean runs, and the promote offer accepted: the skill runs on its own from the next trigger. */
  const promoted = async (): Promise<string> => {
    setRule("writeElsewhere", "actIfApproved");
    const skillId = await keep();
    for (let i = 1; i <= PROMOTE_AFTER; i++) {
      const r = await caretRun();
      finish(r);
      if (i === PROMOTE_AFTER) answer(r.skillOffers.find((o) => o.kind === "promote")!, "accept");
    }
    expect(skills()[0]).toMatchObject({ status: "active", fields: { onItsOwn: true } });
    return skillId;
  };
  const undoOf = (taskId: string) => helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId, action: "undo" });

  // S1 audit #15: before B22 the skill went back on Tab only after the restore returned.
  it("puts a skill back on Tab the moment its undo is asked for, before the first restore lands", async () => {
    await promoted();
    const own = await caretRun();
    expect(own.offer).toBeNull();
    const during: string[] = [];
    desk.afterWrite = () => during.push(skills()[0]!.status);
    expect(await undoOf(own.progress[0]!.taskId)).toMatchObject({ restored: 3 });
    desk.afterWrite = null;
    expect(during).toEqual(["learning", "learning", "learning"]);
    finish(own);
  });

  it("puts a skill back on Tab when its undo is refused, as after a reader restart (S1 audit #15)", async () => {
    await promoted();
    const own = await caretRun();
    expect(own.offer).toBeNull();
    finish(own);
    void helper.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "restarted" });
    const errors = sent.length;
    expect(await undoOf(own.progress[0]!.taskId)).toBeNull();
    expect(since("error", errors)[0]?.message).toMatch(/reader that has since restarted/);
    expect(skills()[0]).toMatchObject({ status: "learning", fields: { onItsOwn: false, cleanRuns: 0 } });
  });

  // S1 audit #11: before B23 a crash lost the run's undo, and the skill stayed promoted.
  it("recovers a run with no Tab that a crash cut off between its writes: back on Tab, listed as stopped, and undo restores what it wrote", async () => {
    const skillId = await promoted();
    hangAtStep = 1;
    const at = sent.length;
    const c = open();
    for (let i = 0; i < 500 && !since("taskProgress", at).some((p) => p.phase === "verified" && p.step === 0); i++) await new Promise((r) => setImmediate(r));
    expect(values(c)).toEqual([calendar(day).lines[0], "", ""]);
    expect(skills()[0]!.fields.onItsOwn).toBe(true);
    // The helper dies here. A new one starts on the same data; the reader, still running, sends the screen again.
    hangAtStep = null;
    helper = makeHelper();
    desk.attach(helper);
    desk.showList(calendar(day));
    desk.showGrid(c);
    expect(skills()[0]).toMatchObject({ id: skillId, status: "learning", fields: { onItsOwn: false, cleanRuns: 0 } });
    const row = helper.handleActivity({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "r", op: "list" }).tasks.find((t) => t.detail?.startsWith("Stopped when Caret restarted") === true);
    expect(row).toMatchObject({ state: "failed", cause: "caret", detail: "Stopped when Caret restarted, at step 2 of 3", step: 1, steps: 3, undoable: true, windowId: c.windowId });
    expect(await undoOf(row!.id)).toMatchObject({ restored: 1, notRestored: [], notUndoable: 0 });
    expect(values(c)).toEqual(["", "", ""]);
    expect(helper.journal.load(Date.now()).records).toEqual([]);
    // Nothing of it runs again, and the next trigger asks for Tab.
    finish({ offer: null, result: null, progress: [], skillOffers: [], window: c });
    const next = await caretRun();
    finish(next);
    expect(next.offer).not.toBeNull();
  });

  it("keeps a run's saved row sealed: no value it wrote is in the journal's file in the clear", async () => {
    await promoted();
    hangAtStep = 2;
    const at = sent.length;
    const c = open();
    for (let i = 0; i < 500 && !since("taskProgress", at).some((p) => p.phase === "verified" && p.step === 1); i++) await new Promise((r) => setImmediate(r));
    const rows = helper.journal.rawRows();
    expect(rows).toHaveLength(1);
    const bytes = Buffer.from(rows[0]!.sealed).toString("latin1");
    for (const v of calendar(day).lines) expect(bytes.includes(v), v).toBe(false);
    expect(helper.journal.load(Date.now()).records[0]).toMatchObject({ next: 2, pending: null, skillId: skills()[0]!.id, ledger: [expect.objectContaining({ step: 0 }), expect.objectContaining({ step: 1 })] });
    void c;
  });

  /**
   * Runs one occurrence on its own and calls `change` once, as the run's first write answers. Returns the run,
   * whether the grant was revoked by the change itself (before any later verb), and how many values landed.
   */
  const changeMidRun = async (change: () => void): Promise<{ own: CaretRun; revokedAtOnce: boolean; landed: number }> => {
    let revokedAtOnce = false;
    desk.afterWrite = (v) => {
      desk.afterWrite = null;
      const before = desk.grants.log.length;
      change();
      const taskId = v.kind === "write" ? v.taskId : undefined;
      revokedAtOnce = desk.grants.log.slice(before).some((g) => g.type === "actRevoke" && g.taskId === taskId);
    };
    const own = await caretRun();
    desk.afterWrite = null;
    finish(own);
    return { own, revokedAtOnce, landed: values(own.window).filter((x) => x !== "").length };
  };
  const settings = (s: { roles?: ("fill" | "repeat" | "watch" | "calendar" | "words")[]; paused?: boolean }): void =>
    helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: desk.at, roles: s.roles ?? ["fill", "repeat", "watch", "calendar", "words"], level: "eager", paused: s.paused ?? false });

  // S1 audit #4: before B22 these changes withdrew offers but let a run already going write every field.
  for (const [name, change] of [
    ["the user puts it back on Tab", () => expect(ask("edit", { id: skills()[0]!.id, fields: { onItsOwn: false } }).error).toBeNull()],
    ["the user pauses the skill", () => expect(ask("pause", { id: skills()[0]!.id }).error).toBeNull()],
    ["the user forgets the skill", () => expect(ask("forget", { id: skills()[0]!.id }).error).toBeNull()],
    ["the user sets Reversible write elsewhere back to ask first", () => setRule("writeElsewhere", "ask")],
    ["the user turns routines off", () => settings({ roles: ["fill", "watch", "calendar", "words"] })],
    ["the user pauses Caret", () => settings({ paused: true })],
  ] as const) {
    it(`revokes a run with no Tab at once when ${name}, and writes nothing more`, async () => {
      await promoted();
      const { own, revokedAtOnce, landed } = await changeMidRun(change);
      expect(own.offer).toBeNull();
      expect(revokedAtOnce).toBe(true);
      expect(landed).toBe(1);
      expect(own.progress.at(-1)).toMatchObject({ phase: "stopped", stopReason: "you", unprompted: true });
    });
  }

  // B22 review: a run the user accepted with Tab still depends on its routine, its skill and the settings family.
  for (const [name, change] of [
    ["the user pauses the skill", () => expect(ask("pause", { id: skills()[0]!.id }).error).toBeNull()],
    ["the user forgets the skill", () => expect(ask("forget", { id: skills()[0]!.id }).error).toBeNull()],
    ["the user forgets the routine", () => expect(ask("forget", { id: routines()[0]!.id }).error).toBeNull()],
    ["the user turns routines off", () => settings({ roles: ["fill", "watch", "calendar", "words"] })],
  ] as const) {
    it(`revokes a run the user accepted with Tab at once when ${name}`, async () => {
      await keep();
      const { own, revokedAtOnce, landed } = await changeMidRun(change);
      expect(own.offer).not.toBeNull();
      expect(revokedAtOnce).toBe(true);
      expect(landed).toBe(1);
      expect(own.progress.at(-1)).toMatchObject({ phase: "stopped", stopReason: "you" });
    });
  }

  it("lets a run the user accepted with Tab finish when the write permission changes: the user answered for this run", async () => {
    setRule("writeElsewhere", "actIfApproved");
    await keep();
    const { own, revokedAtOnce } = await changeMidRun(() => setRule("writeElsewhere", "ask"));
    expect(own.offer).not.toBeNull();
    expect(revokedAtOnce).toBe(false);
    expect(own.progress.at(-1)).toMatchObject({ phase: "done" });
  });

  // S1 audit #5: before B22 nothing tied a run to a host that could show it.
  it("revokes a run with no Tab at once when the host disconnects, as Caret's own stop", async () => {
    await promoted();
    const { own, revokedAtOnce, landed } = await changeMidRun(() => helper.hostDisconnected(HOST));
    expect(own.offer).toBeNull();
    expect(revokedAtOnce).toBe(true);
    expect(landed).toBe(1);
    expect(own.progress.at(-1)).toMatchObject({ phase: "stopped", stopReason: "error", unprompted: true });
    expect(own.progress.at(-1)?.detail).toMatch(/the host that started it disconnected/);
  });

  // B23 (Sol #6 on B22): before the hello's host flag every consumer counted as a host and a run bound to all of them.
  it("binds a run with no Tab to the host alone: another consumer closing leaves it running, and that consumer never counts as a host", async () => {
    helper.consumerConnected("eval-script");
    await promoted();
    const { own, revokedAtOnce } = await changeMidRun(() => helper.hostDisconnected("eval-script"));
    expect(own.offer).toBeNull();
    expect(revokedAtOnce).toBe(false);
    expect(own.progress.at(-1)).toMatchObject({ phase: "done", unprompted: true });
    // With only a non-host consumer connected, the skill is offered with Tab.
    helper.consumerConnected("eval-script-2");
    helper.hostDisconnected(HOST);
    expect(helper.hostPresent).toBe(false);
    const tab = await caretRun();
    finish(tab);
    expect(tab.offer).not.toBeNull();
  });

  it("starts no run on its own while no host is connected: the skill is offered with Tab, and runs on its own again once a host is back", async () => {
    await promoted();
    helper.hostDisconnected(HOST);
    const tab = await caretRun();
    finish(tab);
    expect(tab.offer).not.toBeNull();
    expect(tab.progress.length).toBeGreaterThan(0);
    expect(tab.progress.every((p) => p.unprompted === undefined)).toBe(true);
    helper.hostConnected("another-host");
    const own = await caretRun();
    finish(own);
    expect(own.offer).toBeNull();
    expect(own.progress.at(-1)).toMatchObject({ phase: "done", unprompted: true });
  });

  it("rechecks the permission before each write as the user moves: a write where they were becomes a write elsewhere, which needs its own permission", async () => {
    // Promoted while the user works in Mail, with Reversible write elsewhere left at ask first.
    frontmost = "mail";
    await keep();
    for (let i = 1; i <= PROMOTE_AFTER; i++) {
      const r = await caretRun();
      finish(r);
      if (i === PROMOTE_AFTER) answer(r.skillOffers.find((o) => o.kind === "promote")!, "accept");
    }
    expect(skills()[0]!.fields.onItsOwn).toBe(true);
    // The user switches to another app as the first write answers: nothing tells the helper but the switch itself.
    // The switch revokes at once (B22 review), so a write already queued in the reader is refused there too.
    const { own, landed, revokedAtOnce } = await changeMidRun(() => void helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: desk.at, from: MAIL_APP, to: FIXTURE_APP }));
    expect(own.offer).toBeNull();
    expect(revokedAtOnce).toBe(true);
    expect(landed).toBe(1);
    expect(own.progress.at(-1)).toMatchObject({ phase: "stopped", stopReason: "you", unprompted: true });
    expect(own.progress.at(-1)?.detail).toMatch(/Reversible write elsewhere/);
  });

  it("keeps a write where the user is when a background app's request walk moves the model's focused window (B22 review)", async () => {
    frontmost = "mail";
    await keep();
    for (let i = 1; i <= PROMOTE_AFTER; i++) {
      const r = await caretRun();
      finish(r);
      if (i === PROMOTE_AFTER) answer(r.skillOffers.find((o) => o.kind === "promote")!, "accept");
    }
    // A request walk of a window in another app marks that window focused in its own app; the user is still in
    // Mail, so the run's writes stay "write where you are", which Reversible write elsewhere at ask first would stop.
    let focusedThen: string | null = null;
    const walked = await changeMidRun(() => {
      void helper.handleReader(snap([], { at: desk.at, windowId: "5150-99", title: "Elsewhere", focused: true, reason: "request" }));
      focusedThen = helper.model.focusedWindowId;
    });
    expect(focusedThen).toBe("5150-99");
    expect(walked.own.offer).toBeNull();
    expect(walked.revokedAtOnce).toBe(false);
    expect(walked.own.progress.at(-1)).toMatchObject({ phase: "done", unprompted: true });
  });

  it("revokes a run with no Tab still going when the user asks to undo it, as the skill goes back on Tab (B22 review)", async () => {
    await promoted();
    let id = "";
    const { own, revokedAtOnce, landed } = await changeMidRun(() => {
      id = sent.filter((m): m is TaskProgress => m.type === "taskProgress").at(-1)!.taskId;
      void helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: id, action: "undo" });
    });
    expect(own.offer).toBeNull();
    expect(revokedAtOnce).toBe(true);
    expect(landed).toBe(1);
    expect(own.progress.at(-1)).toMatchObject({ taskId: id, phase: "stopped", stopReason: "you", unprompted: true });
    expect(skills()[0]).toMatchObject({ status: "learning", fields: { onItsOwn: false } });
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

  it("puts a skill that runs on its own back on Tab when the host asks, and never lets an edit make one run on its own (B21)", async () => {
    setRule("writeElsewhere", "actIfApproved");
    const skillId = await keep();
    // An edit cannot grant autonomy, before or after the offer.
    expect(ask("edit", { id: skillId, fields: { onItsOwn: true } }).error).toMatch(/only after you accept Caret's offer/);
    for (let i = 1; i <= PROMOTE_AFTER; i++) {
      const r = await caretRun();
      finish(r);
      if (i === PROMOTE_AFTER) answer(r.skillOffers.find((o) => o.kind === "promote")!, "accept");
    }
    expect(skills()[0]!.fields).toMatchObject({ onItsOwn: true });
    const own = await caretRun();
    finish(own);
    expect(own.offer).toBeNull();
    // The host's line (fixtures/golden/memory.ndjson host-memory-6), sent for this skill.
    const golden = readFileSync(fileURLToPath(new URL("../fixtures/golden/memory.ndjson", import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const line = golden.find((l) => l.requestId === "host-memory-6" && l.type === "memoryRequest")!;
    const want = golden.find((l) => l.requestId === "host-memory-6" && l.type === "memoryReply") as unknown as MemoryReply;
    const reply = helper.handleMemory(ConsumerMessage.parse({ ...line, id: skillId }) as Parameters<typeof helper.handleMemory>[0]);
    expect(reply.error).toBeNull();
    expect(reply.entries[0]).toMatchObject({ kind: "skill", id: skillId, status: want.entries[0]!.status, fields: { onItsOwn: false, cleanRuns: 0, needed: PROMOTE_AFTER } });
    expect(reply.entries[0]?.says).toMatch(/asks first; 0 of 10 clean runs in a row\)$/);
    // The next run needs Tab, and the count starts again from there.
    const needsTab = await caretRun();
    finish(needsTab);
    expect(needsTab.offer).not.toBeNull();
    expect(needsTab.progress.every((p) => p.unprompted === undefined)).toBe(true);
    expect(skills()[0]!.fields).toMatchObject({ onItsOwn: false, cleanRuns: 1 });
    // Still never through an edit, and an edit that names nothing is refused.
    expect(ask("edit", { id: skillId, fields: { onItsOwn: true } }).error).toMatch(/only after you accept Caret's offer/);
    expect(ask("edit", { id: skillId, fields: {} }).error).toMatch(/changes its name or puts it back on Tab/);
    expect(skills()[0]!.fields.onItsOwn).toBe(false);
  });

  it("never offers a skill put back on Tab to run on its own again unasked, and makes the normal offer when the user asks from its row (B22)", async () => {
    const skillId = await promoted();
    expect(ask("edit", { id: skillId, fields: { onItsOwn: false } }).error).toBeNull();
    const cleanRunsOnTab = async (n: number): Promise<void> => {
      for (let i = 1; i <= n; i++) {
        const r = await caretRun();
        finish(r);
        expect(r.offer, `run ${i}`).not.toBeNull();
        expect(r.skillOffers, `run ${i}`).toEqual([]);
      }
    };
    // Past the ten clean runs that brought the offer before: no offer.
    await cleanRunsOnTab(PROMOTE_AFTER + 1);
    expect(skills()[0]!.fields).toMatchObject({ onItsOwn: false, cleanRuns: PROMOTE_AFTER + 1 });

    // The host's request (fixtures/golden/memory.ndjson host-memory-7) for this skill: the skill back unchanged, and the
    // offer published as fixtures/golden/protocol.ndjson's skill-offer-3, under the request's id.
    const read = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/golden/${name}`, import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const line = read("memory.ndjson").find((l) => l.requestId === "host-memory-7" && l.type === "memoryRequest")!;
    const want = read("memory.ndjson").find((l) => l.requestId === "host-memory-7" && l.type === "memoryReply") as unknown as MemoryReply;
    const wantOffer = read("protocol.ndjson").find((l) => l.id === "skill-offer-3") as unknown as SkillOffer;
    const request = (): MemoryReply => helper.handleMemory(ConsumerMessage.parse({ ...line, id: skillId }) as Parameters<typeof helper.handleMemory>[0]);
    let at = sent.length;
    let reply = request();
    expect(reply.error).toBeNull();
    expect(reply.entries[0]).toMatchObject({ kind: "skill", id: skillId, status: want.entries[0]!.status, fields: { onItsOwn: false } });
    const { id: _i, at: _a, skillId: _s, routineId: _r, name: _n, ...shape } = wantOffer;
    expect(since("skillOffer", at)).toEqual([expect.objectContaining({ ...shape, skillId, taskId: "host-memory-7" })]);
    // Asked again while it is out: refused, and no second offer.
    expect(request().error).toMatch(/already out/);
    // Nobody answers: it expires, and Caret still never makes it on its own.
    desk.advance(3 * 60 * 1000);
    expect(sent.some((m) => m.type === "offerWithdrawn" && m.id === since("skillOffer", at)[0]!.id && m.reason === "expired")).toBe(true);
    await cleanRunsOnTab(2);

    // Asked again and accepted: the next run starts with no Tab.
    at = sent.length;
    reply = request();
    expect(reply.error).toBeNull();
    answer(since("skillOffer", at)[0]!, "accept");
    expect(skills()[0]).toMatchObject({ status: "active", fields: { onItsOwn: true } });
    const own = await caretRun();
    finish(own);
    expect(own.offer).toBeNull();
    expect(own.progress.at(-1)).toMatchObject({ phase: "done", unprompted: true });
    expect(request().error).toMatch(/already runs on its own/);
  });

  it("refuses the request to run on its own for a paused skill, an entry that is not a skill, and while Caret is paused", async () => {
    const skillId = await keep();
    expect(ask("pause", { id: skillId }).error).toBeNull();
    expect(ask("offerOnItsOwn", { id: skillId }).error).toMatch(/is paused; resume it first/);
    expect(ask("resume", { id: skillId }).error).toBeNull();
    expect(ask("offerOnItsOwn", { id: "permission-writeHere" }).error).toMatch(/is for a skill, not a permission entry/);
    expect(ask("offerOnItsOwn").error).toMatch(/needs the entry's id/);
    helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: desk.at, roles: ["fill", "repeat", "watch", "calendar", "words"], level: "eager", paused: true });
    expect(ask("offerOnItsOwn", { id: skillId }).error).toMatch(/Caret is paused/);
    expect(since("skillOffer", 0).filter((o) => o.kind === "promote")).toEqual([]);
  });

  it("withdraws a promote offer still out when the skill is put back on Tab (B21)", async () => {
    setRule("writeElsewhere", "actIfApproved");
    const skillId = await keep();
    let promote: SkillOffer | undefined;
    for (let i = 1; i <= PROMOTE_AFTER; i++) {
      const r = await caretRun();
      finish(r);
      promote = r.skillOffers.find((o) => o.kind === "promote") ?? promote;
    }
    expect(promote).toBeDefined();
    expect(ask("edit", { id: skillId, fields: { onItsOwn: false } }).error).toBeNull();
    expect(sent.some((m) => m.type === "offerWithdrawn" && m.id === promote!.id && m.reason === "stale")).toBe(true);
    expect(skills()[0]!.fields).toMatchObject({ onItsOwn: false, cleanRuns: 0 });
    // Accepting the withdrawn offer is refused and changes nothing.
    answer(promote!, "accept");
    expect(skills()[0]!.fields.onItsOwn).toBe(false);
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

  /** Kept, then ten clean runs with Tab, then the promote offer accepted. */
  const promote = async (): Promise<string> => {
    const skillId = await keep();
    for (let i = 1; i <= PROMOTE_AFTER; i++) {
      const r = await caretRun();
      finish(r);
      if (i === PROMOTE_AFTER) answer(r.skillOffers.find((o) => o.kind === "promote")!, "accept");
    }
    expect(skills()[0]!.status).toBe("active");
    return skillId;
  };
  const unprompted = (from: number): TaskProgress[] => since("taskProgress", from).filter((p) => p.unprompted === true);

  it("checks everything again when a run with no Tab is about to start (review B19)", async () => {
    setRule("writeElsewhere", "actIfApproved");
    const skillId = await promote();
    // Paused between the window opening and the run's start: nothing runs, and a paused skill is not offered.
    let at = sent.length;
    let c = open();
    expect(ask("pause", { id: skillId }).error).toBeNull();
    await helper.patterns.unpromptedSettled();
    expect(unprompted(at)).toEqual([]);
    expect(since("patternOffer", at)).toEqual([]);
    desk.close(c.windowId);
    ask("resume", { id: skillId });
    // The rule went back to ask first: offered with Tab instead.
    at = sent.length;
    c = open();
    setRule("writeElsewhere", "ask");
    await helper.patterns.unpromptedSettled();
    expect(unprompted(at)).toEqual([]);
    expect(since("patternOffer", at).map((o) => o.kind)).toEqual(["routine"]);
    expect(values(c)).toEqual(["", "", ""]);
    desk.close(c.windowId);
    setRule("writeElsewhere", "actIfApproved");
    // A source changed before the start: nothing is written from the old value, and nothing is offered.
    at = sent.length;
    c = open();
    desk.showList({ ...calendar(day), lines: ["Moved to Friday", ...calendar(day).lines.slice(1)] });
    await helper.patterns.unpromptedSettled();
    expect(unprompted(at)).toEqual([]);
    expect(values(c)).toEqual(["", "", ""]);
    desk.close(c.windowId);
    // The rule went back to ask first and the user had said "Don't offer this here": the Tab offer is held too.
    at = sent.length;
    c = open();
    setRule("writeElsewhere", "ask");
    helper.memory.upsert("preference", dontOfferMatch("routine", MAIL_APP.bundleId), { rule: "dontOffer", offerKind: "routine", bundleId: MAIL_APP.bundleId, appName: MAIL_APP.name }, desk.at, MAIL_APP.name);
    await helper.patterns.unpromptedSettled();
    expect(unprompted(at)).toEqual([]);
    expect(since("patternOffer", at)).toEqual([]);
    desk.close(c.windowId);
    setRule("writeElsewhere", "actIfApproved");
    // Caret paused: nothing.
    at = sent.length;
    c = open();
    helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: desk.at, roles: ["fill", "repeat", "watch", "calendar", "words"], level: "eager", paused: true });
    await helper.patterns.unpromptedSettled();
    expect(unprompted(at)).toEqual([]);
    desk.close(c.windowId);
  });

  it("resets a skill whose run ends in an error rather than a result", async () => {
    setRule("writeElsewhere", "actIfApproved");
    await promote();
    desk.refuseLastWatch = true;
    const at = sent.length;
    const r = await caretRun();
    desk.refuseLastWatch = false;
    finish(r);
    expect(since("error", at).some((e) => e.message.includes("cannot watch for input"))).toBe(true);
    expect(skills()[0]).toMatchObject({ status: "learning", fields: { onItsOwn: false, cleanRuns: 0 } });
  });

  it("does not count a run the user took over while its last write was answering", async () => {
    await keep();
    for (let i = 0; i < 2; i++) finish(await caretRun());
    expect(skills()[0]!.fields.cleanRuns).toBe(2);
    let link = "";
    desk.afterWrite = (v) => {
      if (v.kind === "write" && v.key === link && v.taskId !== undefined) void helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: v.taskId, action: "takeOver" });
    };
    link = cellKey(compose(day + 1), 0, 2);
    const r = await caretRun();
    desk.afterWrite = null;
    finish(r);
    expect(r.result).toMatchObject({ outcome: "paused", step: null, detail: "Caret handed this back to you after the last of 3 steps" });
    expect(skills()[0]!.fields).toMatchObject({ cleanRuns: 0, runs: 3 });
    // A later take over or stop of that paused run names no step past the last either.
    const taskId = r.offer!.id;
    for (const action of ["takeOver", "stop"] as const) {
      const at = sent.length;
      await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId, action });
      expect(since("taskProgress", at).at(-1)).toMatchObject({ step: null, steps: 3 });
    }
  });

  it("counts no run of a re-offer that only fills what the user left", async () => {
    await keep();
    const at = sent.length;
    const c = open();
    desk.fill(c, 0, 0, calendar(day).lines[0]!);
    desk.fill(c, 0, 1, calendar(day).lines[1]!);
    const last = since("patternOffer", at).at(-1)!;
    expect(last.cells.map((x) => x.value)).toEqual([calendar(day).lines[2]]);
    const r = (await helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: last.id, action: "take" })) as TaskResult;
    expect(r.outcome).toBe("done");
    desk.close(c.windowId);
    expect(skills()[0]!.fields).toMatchObject({ runs: 0, cleanRuns: 0 });
    expect(since("skillOffer", at)).toEqual([]);
  });

  it("resets a skill when the user changes a value its run wrote", async () => {
    await keep();
    finish(await caretRun());
    const r = await caretRun();
    expect(skills()[0]!.fields.cleanRuns).toBe(2);
    desk.fill(r.window, 0, 0, "Design review, moved");
    expect(skills()[0]!.fields.cleanRuns).toBe(0);
    finish(r);
  });

  it("forgets an offer that was out when the helper stopped, and never reuses its id", async () => {
    const r = await proveAndRun();
    const old = r.skillOffers[0]!;
    const routineId = routines()[0]!.id;
    expect(helper.memory.routine(routineId)?.keep).toBe("offered");
    helper.shutdown();
    helper.memory.close();
    helper = makeHelper();
    desk.attach(helper);
    expect(helper.memory.routine(routineId)?.keep).toBeNull();
    const at = sent.length;
    answer(old, "accept");
    expect(since("error", at)[0]?.message).toMatch(/no such offer/);
    const again = await caretRun();
    finish(again);
    expect(again.skillOffers.map((o) => o.kind)).toEqual(["keep"]);
    expect(again.skillOffers[0]!.id).not.toBe(old.id);
  });

  it("never promotes a skill whose window has two sends it cannot tell apart, and hands neither off", async () => {
    buttons = ["Send", "Send later"];
    setRule("writeElsewhere", "actIfApproved");
    await keep();
    expect(skills()[0]!.fields.handsOff).toEqual({ label: "Send or Send later", why: "outbound" });
    for (let i = 1; i <= PROMOTE_AFTER + 1; i++) {
      const r = await caretRun();
      finish(r);
      expect(r.result?.outcome).toBe("done");
      expect(r.skillOffers).toEqual([]);
    }
    expect(desk.pressed).toEqual([]);
  });

  it("holds a kept skill on Tab once its window turns out to end in a press", async () => {
    setRule("writeElsewhere", "actIfApproved");
    await keep();
    expect(skills()[0]!.fields.handsOff).toBeNull();
    buttons = ["Send", "Send later"];
    for (let i = 1; i <= PROMOTE_AFTER + 1; i++) {
      const r = await caretRun();
      finish(r);
      expect(r.skillOffers, `run ${i}`).toEqual([]);
    }
    expect(skills()[0]!.fields).toMatchObject({ handsOff: { label: "Send or Send later", why: "outbound" }, onItsOwn: false });
  });

  // MARK: - B20: the press an occurrence ends with, learned from the user's own click

  /** The reader saw the user press `label` in the window (protocol.ts UserPress); `keyed` false stands for a walk that did not keep the button. */
  const press = (g: GridWindow, label: string, keyed = true, via: PressVia = "click"): void =>
    void helper.handleReader({ type: "userPress", v: PROTOCOL_VERSION, at: desk.at, pid: g.app.pid, windowId: g.windowId, key: keyed ? buttonKey(g, label) : null, role: "AXButton", label, via });
  /** One occurrence by hand that ends with the user pressing `label`, which closes the window as Send does. */
  const byHandPressing = (label: string | null, keyed = true, via: PressVia = "click"): void => {
    const c = open();
    for (let i = 0; i < 3; i++) desk.fill(c, 0, i, calendar(day).lines[i]!);
    if (label !== null) press(c, label, keyed, via);
    desk.close(c.windowId);
  };
  const pressWatches = (): string[][] =>
    desk.verbs.flatMap((v) => (v.kind === "watchPresses" ? [v.windows.map((w) => w.windowId)] : []));

  it("learns the Send the user clicked where the buttons alone cannot tell, and hands it off on the next run", async () => {
    buttons = ["Send", "Send later"];
    setRule("writeElsewhere", "actIfApproved");
    for (let i = 0; i < 3; i++) byHandPressing("Send");
    await helper.patterns.skills.namesSettled();
    // The press, not the buttons: one finish, named exactly, learned from the click.
    expect(helper.memory.list("routine")[0]).toMatchObject({ kind: "routine" });
    const routine = helper.memory.routine(routines()[0]!.id);
    expect(routine?.finish).toMatchObject({ label: "Send", why: "outbound", by: "click" });
    expect(routine?.finish?.ambiguous).toBeUndefined();
    const r = await caretRun();
    expect(r.result).toMatchObject({ outcome: "handoff", step: 3 });
    expect(r.progress.at(-1)).toMatchObject({ phase: "handoff", says: "You press 'Send'" });
    expect(values(r.window)).toEqual(calendar(day).lines);
    finish(r);
    answer(r.skillOffers.find((o) => o.kind === "keep")!, "accept");
    expect(skills()[0]!.fields.handsOff).toEqual({ label: "Send", why: "outbound" });
    // Later occurrences close with no click seen; the guess from the buttons never replaces what the user did.
    for (let i = 1; i <= PROMOTE_AFTER + 1; i++) {
      const again = await caretRun();
      finish(again);
      expect(again.result, `run ${i}`).toMatchObject({ outcome: "handoff", step: 3 });
      expect(again.skillOffers).toEqual([]);
    }
    expect(helper.memory.routine(routine!.id)?.finish).toMatchObject({ label: "Send", by: "click" });
    expect(skills()[0]!.fields).toMatchObject({ handsOff: { label: "Send", why: "outbound" }, onItsOwn: false });
    // Read only: the reader was never asked to press.
    expect(desk.pressed).toEqual([]);
    expect(desk.verbs.some((v) => v.kind === "press")).toBe(false);
  });

  it("learns the Send the user pressed with Return as a press seen by key, which a later guess from the buttons never replaces (B21)", async () => {
    buttons = ["Send", "Send later"];
    for (let i = 0; i < 3; i++) byHandPressing("Send", true, "return");
    const routine = helper.memory.routine(routines()[0]!.id);
    expect(routine?.finish).toMatchObject({ label: "Send", why: "outbound", by: "key" });
    expect(routine?.finish?.ambiguous).toBeUndefined();
    byHandPressing(null);
    expect(helper.memory.routine(routine!.id)?.finish).toMatchObject({ label: "Send", by: "key" });
    expect(desk.verbs.some((v) => v.kind === "press")).toBe(false);
  });

  it("places a click the walk did not key by its label, and learns Send later when that is what the user clicked", async () => {
    buttons = ["Send", "Send later"];
    for (let i = 0; i < 3; i++) byHandPressing("Send later", false);
    expect(helper.memory.routine(routines()[0]!.id)?.finish).toMatchObject({ label: "Send later", why: "outbound", by: "click" });
    const r = await caretRun();
    finish(r);
    expect(r.result).toMatchObject({ outcome: "handoff", step: 3 });
    expect(r.progress.at(-1)).toMatchObject({ says: "You press 'Send later'" });
  });

  it("guesses from the buttons only when no click was seen, and learns no finish from a click that is not a send", async () => {
    buttons = ["Save draft", "Send"];
    // The user saves drafts: the window's one Send is not what these occurrences end with.
    for (let i = 0; i < 3; i++) byHandPressing("Save draft");
    expect(helper.memory.routine(routines()[0]!.id)?.finish).toBeNull();
    // With no click seen, the window's one Send is the guess, as in B19.
    byHandPressing(null);
    expect(helper.memory.routine(routines()[0]!.id)?.finish).toMatchObject({ label: "Send", by: "buttons" });
  });

  it("predicts for a window whose fields arrive after it opened, as a web page's do, once", async () => {
    setRule("writeElsewhere", "actIfApproved");
    for (let i = 0; i < 3; i++) expect(byHand()).toEqual([]);
    await helper.patterns.skills.namesSettled();
    // The window is first read with no fields, as a browser window is before its page loads.
    const at = sent.length;
    day++;
    desk.at += DAY;
    desk.showList(calendar(day));
    desk.advance(1000);
    const c = compose(day);
    desk.showGrid({ ...c, rows: 0 });
    expect(since("patternOffer", at)).toEqual([]);
    desk.advance(500);
    desk.showGrid(c);
    const offers = since("patternOffer", at).filter((o) => o.kind === "routine");
    expect(offers).toHaveLength(1);
    expect(offers[0]?.windowId).toBe(c.windowId);
    // A later read of the same fields makes no second prediction.
    desk.showGrid({ ...c, rows: 0 });
    desk.showGrid(c);
    expect(since("patternOffer", at).filter((o) => o.kind === "routine")).toHaveLength(1);
  });

  it("asks the reader to watch presses in a window the user is filling, and stops when it closes", () => {
    byHandPressing(null);
    const c = compose(day);
    const watches = pressWatches();
    expect(watches.at(-2)).toEqual([c.windowId]);
    expect(watches.at(-1)).toEqual([]);
  });

  it("learns the clicked Send when the closing window reaches the model with its controls gone (B20 press-learn run 2)", () => {
    buttons = ["Send", "Send later"];
    for (let i = 0; i < 3; i++) {
      const c = open();
      for (let j = 0; j < 3; j++) desk.fill(c, 0, j, calendar(day).lines[j]!);
      press(c, "Send");
      // A last walk of the closing window finds none of its controls.
      desk.showGrid({ ...c, rows: 0, buttons: [] });
      desk.close(c.windowId);
    }
    expect(helper.memory.routine(routines()[0]!.id)?.finish).toMatchObject({ label: "Send", by: "click" });
  });

  it("learns the clicked Send when that emptied walk reaches the model before the click does", () => {
    buttons = ["Send", "Send later"];
    for (let i = 0; i < 3; i++) {
      const c = open();
      for (let j = 0; j < 3; j++) desk.fill(c, 0, j, calendar(day).lines[j]!);
      desk.showGrid({ ...c, rows: 0, buttons: [] });
      press(c, "Send");
      desk.close(c.windowId);
    }
    expect(helper.memory.routine(routines()[0]!.id)?.finish).toMatchObject({ label: "Send", by: "click" });
  });

  it("scores Caret's verified run as a hit when its window loses its fields before it closes, as a Chrome page does (B20)", async () => {
    for (let i = 0; i < 3; i++) expect(byHand()).toEqual([]);
    await helper.patterns.skills.namesSettled();
    const id = routines()[0]!.id;
    const before = helper.memory.routine(id)!;
    const r = await caretRun();
    expect(r.result?.outcome).toBe("done");
    // Closed at once: the run's edits have not settled, and a last walk finds the page's fields gone.
    desk.showGrid({ ...r.window, rows: 0 });
    desk.close(r.window.windowId);
    const after = helper.memory.routine(id)!;
    expect(after.misses).toBe(before.misses);
    expect(after.hits).toBe(before.hits + 1);
    expect(after.count).toBe(before.count + 1);
  });

  it("keeps a Send clicked before the copied values settled, as a fast user's is (B20 review)", () => {
    buttons = ["Send", "Send later"];
    // The first occurrence, so no prediction made a bundle when the window opened.
    const c = open();
    // Typed in quick succession, then Send at once: no transfer has settled when the click comes.
    for (let j = 0; j < 3; j++) {
      c.values.set(cellKey(c, 0, j), calendar(day).lines[j]!);
      desk.showGrid(c);
      desk.advance(200);
    }
    expect(pressWatches().at(-1)).toEqual([c.windowId]);
    press(c, "Send");
    desk.close(c.windowId);
    expect(helper.memory.routine(routines()[0]!.id)?.finish).toMatchObject({ label: "Send", by: "click" });
  });

  it("does not take a safe click as how an occurrence ended unless the window closed right after it", () => {
    buttons = ["Save draft", "Send"];
    for (let i = 0; i < 3; i++) {
      const c = open();
      for (let j = 0; j < 3; j++) desk.fill(c, 0, j, calendar(day).lines[j]!);
      press(c, "Save draft");
      // More work after the save, then the window closes some seconds later, as after a keyboard Send.
      desk.advance(PRESS_ENDS_MS + 1000);
      desk.close(c.windowId);
    }
    expect(helper.memory.routine(routines()[0]!.id)?.finish).toMatchObject({ label: "Send", by: "buttons" });
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
