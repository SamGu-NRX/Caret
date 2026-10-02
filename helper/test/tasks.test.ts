// Task controls on the executor (pause, stop, take over) and the task registry behind the activity feed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type Activity, type HelperMessage, type TaskRecord } from "../src/protocol.ts";
import { PlanError, type Plan, type Step } from "../src/executor/schema.ts";
import { TaskRegistry, TransitionError } from "../src/tasks/registry.ts";
import { executorWindow, FakeApp, K, TITLE, WIN } from "./fake-app.ts";
import { FIXTURE_APP } from "./builders.ts";

const W = { titleStartsWith: TITLE };
const FIELDS = ["name", "email", "reference", "message", "eventtitle", "group:billing/textfield:city"];
const key = (f: string): string => K(f.includes("/") ? `${f}~0` : `textfield:${f}~0`);
const write = (f: string, value: string): Step => ({ says: `${f} holds ${value}`, end: { kind: "valueEquals", window: W, target: { key: key(f), describe: f }, value } });
const SIX: Plan = { id: "six", title: "Fill six fields", slots: {}, steps: FIELDS.map((f, i) => write(f, `v${i + 1}`)) };

describe("task controls on a six-step run", () => {
  let dir: string;
  let store: Store;
  let app: FakeApp;
  let helper: Helper;
  let published: HelperMessage[];
  /** The task's activity records, in the order they were published. */
  const records = (id = "t"): TaskRecord[] => published.filter((m): m is Activity => m.type === "activity" && m.task.id === id).map((m) => m.task);
  /** Called with the zero-based index of each step whose write just landed. */
  let onWrite: (step: number) => void;

  const writes = () => app.verbs.filter((v) => v.kind === "write").length;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-tasks-"));
    store = new Store(join(dir, "data"));
    app = new FakeApp(executorWindow());
    for (const [f, y] of [["reference", 120], ["message", 160], ["eventtitle", 200]] as const) {
      app.nodes.push({ key: key(f), parent: null, role: "AXTextField", label: f, editable: true, frame: [100, y, 200, 24] });
    }
    published = [];
    onWrite = () => {};
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => published.push(m), readerLink: app });
    app.afterVerb = (_a, v) => {
      if (v.kind === "write") onWrite(writes() - 1);
    };
    app.helper = helper;
    app.show();
  });
  afterEach(() => {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("pause after step 2 stops the run before step 3 acts; resume finishes every step", async () => {
    onWrite = (i) => {
      if (i === 1) helper.executor.pause("t", false);
    };
    const r = await helper.executor.run("t", SIX, {});
    expect(r).toMatchObject({ outcome: "paused", step: 2 });
    expect(writes()).toBe(2);
    expect(app.node(key(FIELDS[2]!))?.value).toBeUndefined();
    expect(records().at(-1)).toMatchObject({ kind: "plan", state: "paused", step: 2, cause: "you", says: "Fill six fields", windowTitle: TITLE, remaining: SIX.steps.slice(2).map((s) => s.says) });

    onWrite = () => {};
    const done = await helper.executor.resume("t");
    expect(done).toMatchObject({ outcome: "done", acted: 6 });
    FIELDS.forEach((f, i) => expect(app.node(key(f))?.value).toBe(`v${i + 1}`));
    expect(records().at(-1)).toMatchObject({ state: "done", cause: "caret", remaining: [], undoable: true });
    expect(new Set(records().map((r) => r.state))).toEqual(new Set(["running", "paused", "done"]));
  });

  it("a pause that arrives while a step is still reading stops it before it acts", async () => {
    // The walk that starts step 3's reads is the fifth verb: two per step so far (write, then the next step's walk).
    let walks = 0;
    app.afterVerb = (_a, v) => {
      if (v.kind === "walk" && ++walks === 4) helper.executor.pause("t", false);
    };
    const r = await helper.executor.run("t", SIX, {});
    expect(r.outcome).toBe("paused");
    expect(writes()).toBe(r.step);
    expect(published.some((m) => m.type === "taskProgress" && m.phase === "acting" && m.step === r.step)).toBe(false);
  });

  it("take over pauses and reports the step it reached and what remains", async () => {
    onWrite = (i) => {
      if (i === 1) helper.executor.pause("t", true);
    };
    const r = await helper.executor.run("t", SIX, {});
    expect(r).toMatchObject({ outcome: "paused", step: 2 });
    expect(r.detail).toBe("Caret handed this back to you before step 3 of 6");
    expect(records().at(-1)).toMatchObject({ state: "paused", cause: "you", step: 2, stepSays: SIX.steps[2]!.says, remaining: SIX.steps.slice(2).map((s) => s.says), undoable: true });
    expect(records().at(-1)?.detail).toBe("Caret handed this back to you before step 3 of 6");
    // A plain pause, then take over: the record changes to say it was handed back.
    onWrite = (i) => {
      if (i === 2) helper.executor.pause("u", false);
    };
    await helper.executor.run("u", { ...SIX, id: "six-u" }, {});
    expect(records("u").at(-1)?.detail).toMatch(/^paused before step 4 of 6/);
    helper.executor.pause("u", true);
    expect(records("u").at(-1)).toMatchObject({ state: "paused", step: 3, detail: "Caret handed this back to you before step 4 of 6" });
  });

  it("stop ends a running task at the boundary, and a paused one at once; neither resumes", async () => {
    onWrite = (i) => {
      if (i === 0) helper.executor.stop("t");
    };
    const r = await helper.executor.run("t", SIX, {});
    expect(r).toMatchObject({ outcome: "stopped", step: 1, detail: "stopped by you before step 2 of 6" });
    expect(records().at(-1)).toMatchObject({ state: "failed", cause: "you", detail: "stopped by you before step 2 of 6" });
    await expect(helper.executor.resume("t")).rejects.toThrow(PlanError);

    onWrite = (i) => {
      if (i === 0) helper.executor.pause("u", false);
    };
    app.verbs.length = 0;
    // Step 1 already holds from task t, so u's first write is step 2 and it pauses before step 3.
    const paused = await helper.executor.run("u", { ...SIX, id: "six-u" }, {});
    expect(paused).toMatchObject({ outcome: "paused", step: 2 });
    helper.executor.stop("u");
    expect(records("u").at(-1)).toMatchObject({ state: "failed", cause: "you", step: 2, detail: "stopped by you before step 3 of 6" });
    expect(() => helper.executor.pause("u", false)).toThrow(PlanError);
  });

  it("undo of a paused run restores its writes, and the run can no longer resume", async () => {
    onWrite = (i) => {
      if (i === 1) helper.executor.pause("t", false);
    };
    await helper.executor.run("t", SIX, {});
    onWrite = () => {};
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 2 });
    expect(records().at(-1)).toMatchObject({ state: "undone", cause: "you" });
    await expect(helper.executor.resume("t")).rejects.toThrow(/not paused/);
  });

  it("undo of a paused run cannot race a resume or a second undo", async () => {
    onWrite = (i) => {
      if (i === 1) helper.executor.pause("t", false);
    };
    await helper.executor.run("t", SIX, {});
    onWrite = () => {};
    // All three are issued before the first restore's await returns, as two consumers racing would.
    const undoing = helper.executor.undo("t");
    const resumed = helper.executor.resume("t");
    const again = helper.executor.undo("t");
    await expect(resumed).rejects.toThrow(/not paused/);
    await expect(again).rejects.toThrow(/already being undone/);
    expect(await undoing).toMatchObject({ restored: 2 });
    expect(writes()).toBe(4); // two writes, two restores, and nothing from a resumed run
  });

  it("a pause that arrives as the step announces its act still stops it before the write", async () => {
    const seen: string[] = [];
    const inner = helper;
    helper = new Helper({
      store,
      askJev: null,
      shadow: false,
      allowBackgroundFocus: false,
      readerLink: app,
      publish: (m) => {
        published.push(m);
        if (m.type === "taskProgress" && m.taskId === "t" && m.phase === "acting" && m.step === 2) {
          seen.push("acting@2");
          helper.executor.pause("t", false);
        }
      },
    });
    app.helper = helper;
    app.show();
    const r = await helper.executor.run("t", SIX, {});
    expect(seen).toEqual(["acting@2"]);
    expect(r).toMatchObject({ outcome: "paused", step: 2 });
    expect(app.node(key(FIELDS[2]!))?.value).toBeUndefined();
    helper.memory.close();
    helper = inner;
  });

  it("a take-over that lands while a step reads pauses the run even if the user is already editing", async () => {
    let walks = 0;
    app.afterVerb = (a, v) => {
      // Step 3's opening walk: the user takes over and types into a field the plan already wrote.
      if (v.kind === "walk" && ++walks === 4) {
        helper.executor.pause("t", true);
        a.setValue(key(FIELDS[0]!), "Dana W.");
        a.show();
      }
    };
    const r = await helper.executor.run("t", SIX, {});
    expect(r.outcome).toBe("paused");
    expect(records().at(-1)).toMatchObject({ state: "paused", cause: "you" });
  });

  describe("a host pause for input", () => {
    const clicking = (): void => void helper.handleReader({ type: "userInput", v: PROTOCOL_VERSION, at: 5, pid: FIXTURE_APP.pid, kind: "mouse", point: [50, 50] });
    const hostPause = (reason?: "input"): void => void helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: "t", action: "pause", ...(reason === undefined ? {} : { reason }) });
    const readerDetail = `paused before step 3 of 6: a click in '${TITLE}'`;

    it("keeps the reader's wording when the reader's input came first", async () => {
      onWrite = (i) => {
        if (i !== 1) return;
        clicking();
        hostPause("input");
      };
      expect(await helper.executor.run("t", SIX, {})).toMatchObject({ outcome: "paused", step: 2, detail: readerDetail });
      expect(records().at(-1)).toMatchObject({ state: "paused", cause: "you", detail: readerDetail });
    });

    it("takes the reader's wording when the reader's input comes second", async () => {
      onWrite = (i) => {
        if (i !== 1) return;
        hostPause("input");
        clicking();
      };
      expect(await helper.executor.run("t", SIX, {})).toMatchObject({ outcome: "paused", detail: readerDetail });
    });

    it("says 'your input' when the reader saw none", async () => {
      onWrite = (i) => {
        if (i === 1) hostPause("input");
      };
      expect(await helper.executor.run("t", SIX, {})).toMatchObject({ outcome: "paused", detail: "paused before step 3 of 6: your input" });
    });

    it("lets a plain pause, the user's own control, replace the reader's wording as before", async () => {
      onWrite = (i) => {
        if (i !== 1) return;
        clicking();
        hostPause();
      };
      expect(await helper.executor.run("t", SIX, {})).toMatchObject({ outcome: "paused", detail: "paused before step 3 of 6: you paused it" });
    });

    it("refuses a reason on anything but pause", async () => {
      await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: "t", action: "stop", reason: "input" });
      expect(published.find((m) => m.type === "error")).toMatchObject({ message: "task t: reason input goes only with pause, not stop" });
    });
  });

  it("puts the task window's frame on its records", async () => {
    await helper.executor.run("t", SIX, {});
    const frame = helper.model.windows.get(WIN)?.window.frame;
    expect(frame).not.toBeNull();
    expect(records().at(-1)?.frame).toEqual(frame);
  });

  it("refuses a runPlan whose task id is already a record", async () => {
    await helper.executor.run("t", SIX, {});
    await helper.handleTask({ type: "runPlan", v: PROTOCOL_VERSION, taskId: "t", plan: SIX, slots: {} });
    expect(published.at(-1)).toMatchObject({ type: "error", message: "task t: task id t is already in use" });
  });

  it("a stop requested over the socket is answered as a control, not as undo", async () => {
    onWrite = (i) => {
      if (i === 1) void helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: "t", action: "stop" });
    };
    const r = await helper.executor.run("t", SIX, {});
    expect(r.outcome).toBe("stopped");
    expect(app.node(key(FIELDS[0]!))?.value).toBe("v1"); // nothing was restored
  });
});

describe("task registry", () => {
  const rec = (id: string, extra: Partial<TaskRecord> = {}): Omit<TaskRecord, "startedAt" | "updatedAt"> => ({
    id,
    kind: "plan",
    state: "running",
    cause: null,
    says: "Fill six fields",
    frame: null,
    app: null,
    windowId: null,
    windowTitle: null,
    step: null,
    steps: 6,
    stepSays: null,
    remaining: [],
    detail: null,
    undoable: false,
    pending: null,
    ...extra,
  });
  let now = 1000;
  let out: Activity[];
  let reg: TaskRegistry;
  beforeEach(() => {
    now = 1000;
    out = [];
    reg = new TaskRegistry((m) => out.push(m), () => now);
  });

  it("publishes every transition and step change with a rising sequence number, and nothing for a repeat", () => {
    reg.create(rec("a"));
    now = 1100;
    reg.update("a", { step: 1 });
    reg.update("a", { step: 1 });
    reg.update("a", { state: "paused", cause: "you" });
    expect(out.map((m) => [m.seq, m.from, m.task.state, m.task.step])).toEqual([
      [1, null, "running", null],
      [2, "running", "running", 1],
      [3, "running", "paused", 1],
    ]);
    expect(out[2]?.task.updatedAt).toBe(1100);
    expect(out[0]?.task.startedAt).toBe(1000);
  });

  it("refuses to leave a finished state, except a finished run's undo", () => {
    reg.create(rec("a"));
    reg.update("a", { state: "done" });
    expect(() => reg.update("a", { state: "running" })).toThrow(TransitionError);
    reg.update("a", { state: "undone" });
    expect(() => reg.update("a", { state: "done" })).toThrow(TransitionError);
    expect(() => reg.create(rec("a"))).toThrow(/already exists/);
    expect(() => reg.update("nope", { state: "done" })).toThrow(/no task nope/);
  });

  it("answers list newest first, since with the events after a number, and flags a gap", () => {
    reg.create(rec("a"));
    now = 2000;
    reg.create(rec("b"));
    const list = reg.answer({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "r", op: "list" });
    expect(list).toMatchObject({ error: null, seq: 2, events: [], truncated: false });
    expect(list.tasks.map((t) => t.id)).toEqual(["b", "a"]);
    const since = reg.answer({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "r", op: "since", since: 1 });
    expect(since.events.map((e) => e.seq)).toEqual([2]);
    expect(reg.answer({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "r", op: "since" }).error).toMatch(/needs a `since`/);
    expect(reg.answer({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "r", op: "since", since: 9 }).error).toMatch(/past the latest/);
    for (let i = 0; i < 1100; i++) reg.update("a", { step: i });
    const gap = reg.answer({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "r", op: "since", since: 1 });
    expect(gap.truncated).toBe(true);
    expect(gap.events).toHaveLength(1000);
  });

  it("stops a reply at its byte cap, envelope included, and flags it truncated", () => {
    const bytes = (x: unknown): number => Buffer.byteLength(JSON.stringify(x));
    const big = (id: string): Omit<TaskRecord, "startedAt" | "updatedAt"> => rec(id, { says: "x".repeat(400) });
    const envelope = bytes({ type: "activityReply", v: PROTOCOL_VERSION, requestId: "r", error: null, seq: 5, tasks: [], events: [], truncated: false });
    const one = bytes({ ...big("a0"), startedAt: 1000, updatedAt: 1000 });
    const cap = envelope + 3 * one + 2;
    const small = new TaskRegistry(() => {}, () => now, cap);
    for (let i = 0; i < 5; i++) small.create(big(`a${i}`));
    const list = small.answer({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "r", op: "list" });
    expect(list.tasks).toHaveLength(3);
    expect(list.truncated).toBe(true);
    expect(bytes(list)).toBeLessThanOrEqual(cap);
    const since = small.answer({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "r", op: "since", since: 0 });
    expect(since.truncated).toBe(true);
    expect(bytes(since)).toBeLessThanOrEqual(cap);
    expect(since.events.map((e) => e.seq)).toEqual([1, 2]);
    const whole = small.answer({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "r", op: "since", since: 4 });
    expect(whole).toMatchObject({ truncated: false, events: [{ seq: 5 }] });
  });

  it("leaves out a record too big for the reply and still lists the older ones", () => {
    const small = new TaskRegistry(() => {}, () => now, 4000);
    small.create(rec("old"));
    now = 2000;
    small.create(rec("huge", { says: "x".repeat(5000) }));
    const list = small.answer({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "r", op: "list" });
    expect(list.tasks.map((t) => t.id)).toEqual(["old"]);
    expect(list.truncated).toBe(true);
  });

  it("keeps the default cap under 1 MiB however many records there are", () => {
    for (let i = 0; i < 1500; i++) reg.create(rec(`r${i}`, { says: "y".repeat(1000), remaining: ["z".repeat(500)] }));
    const reply = reg.answer({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "r", op: "list" });
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(1024 * 1024);
    expect(reply.truncated).toBe(true);
    expect(reply.tasks.length).toBeGreaterThan(0);
  });

  it("forgets finished records after a day and keeps unfinished ones", () => {
    reg.create(rec("a"));
    reg.create(rec("b"));
    reg.update("a", { state: "done" });
    reg.prune(1000 + 25 * 60 * 60 * 1000);
    expect(reg.list().map((t) => t.id)).toEqual(["b"]);
  });
});
