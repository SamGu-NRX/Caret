import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type HelperMessage, type TaskProgress } from "../src/protocol.ts";
import { FakeCalendar } from "../src/executor/means.ts";
import { classifyLabel } from "../src/executor/risk.ts";
import { fillSlots, Plan, PlanError, type Step } from "../src/executor/schema.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { FIXTURE_APP, snap } from "./builders.ts";
import { executorWindow, FakeApp, K, TITLE, WIN, wireButtons } from "./fake-app.ts";

const W = { titleStartsWith: TITLE };
const write = (key: string, value: string, says = `${key} holds ${value}`): Step => ({ says, end: { kind: "valueEquals", window: W, target: { key, describe: says }, value } });
const plan = (steps: Step[], id = "p"): Plan => ({ id, title: id, slots: {}, steps });

describe("executor", () => {
  let dir: string;
  let store: Store;
  let app: FakeApp;
  let helper: Helper;
  let published: HelperMessage[];
  let calendar: FakeCalendar;
  let askJev: AskJev | null;

  const progress = (taskId: string): TaskProgress[] => published.filter((m): m is TaskProgress => m.type === "taskProgress" && m.taskId === taskId);
  const acts = () => app.verbs.filter((v) => v.kind === "write" || v.kind === "press");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-exec-"));
    store = new Store(join(dir, "data"));
    app = new FakeApp(executorWindow());
    wireButtons(app);
    published = [];
    calendar = new FakeCalendar();
    askJev = null;
    helper = new Helper({
      store,
      askJev: (req) => (askJev === null ? Promise.reject(new Error("no Jev in this test")) : askJev(req)),
      shadow: false,
      allowBackgroundFocus: false,
      publish: (m) => published.push(m),
      readerLink: app,
      calendar,
    });
    app.helper = helper;
    app.show();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes each value, verifies it against the change log, and reports every phase", async () => {
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana Whitfield"), write(K("textfield:email~0"), "dana@example.com")]), {});
    expect(r).toMatchObject({ outcome: "done", acted: 2, skipped: 0 });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana Whitfield");
    expect(progress("t1").map((p) => p.phase)).toEqual(["started", "acting", "verified", "acting", "verified", "done"]);
  });

  it("brings a window to the front with a raise, writes nothing, and skips the step when the window is already in front", async () => {
    const front: Step = { says: "The executor window is in front", end: { kind: "windowFocused", window: W } };
    // The fake app refuses to raise, as a reader without --act-pids for it would.
    const r = await helper.executor.run("t1", plan([front]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0, detail: "the reader refused: notAllowed (the fake app does not raise its window)" });
    expect(app.verbs.filter((v) => v.kind === "raise")).toEqual([{ kind: "raise", pid: FIXTURE_APP.pid, windowId: WIN }]);
    expect(helper.executor.ledger("t1")).toEqual([]);

    void helper.handleReader(snap(structuredClone(app.nodes), { at: 5000, windowId: WIN, title: TITLE, focused: true }));
    expect(await helper.executor.run("t2", plan([front], "p2"), {})).toMatchObject({ outcome: "done", acted: 0, skipped: 1 });
  });

  it("aborts on a mismatch and names the step: the write reports success but nothing changed", async () => {
    app.dropWrites = true;
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@example.com")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(r.detail).toMatch(/^mismatch/);
    expect(progress("t1").at(-1)).toMatchObject({ phase: "stopped", step: 0, says: `${K("textfield:name~0")} holds Dana` });
    expect(acts()).toHaveLength(1); // the second step never ran
  });

  it("aborts when a field the step did not target changes while it acts", async () => {
    app.afterVerb = (a, v) => {
      if (v.kind === "write") {
        a.setValue(K("group:billing/textfield:city~0"), "Austin");
        a.show();
      }
    };
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(r.detail).toMatch(/billing.*changed although the step did not touch it/);
  });

  it("reruns a finished plan as a no-op: every step already holds and nothing is written or pressed", async () => {
    const p = plan([
      write(K("textfield:name~0"), "Dana"),
      { says: "the order is archived", end: { kind: "exists", window: W, target: { label: "Status: Archived", describe: "archived status" } }, via: { kind: "press", target: { label: "Archive", role: "AXButton", describe: "Archive button" } } },
      { says: "page 2 is showing", end: { kind: "windowTitle", window: W, title: `${TITLE} (page 2)` }, via: { kind: "press", target: { label: "Next page", describe: "Next page button" } } },
    ]);
    expect((await helper.executor.run("first", p, {})).outcome).toBe("done");
    const before = acts().length;
    expect(before).toBe(3);
    const again = await helper.executor.run("second", p, {});
    expect(again).toMatchObject({ outcome: "done", acted: 0, skipped: 3 });
    expect(acts()).toHaveLength(before);
  });

  it("refuses a press whose label reads as send and hands it to the user, after doing the steps before it", async () => {
    const p = plan([
      write(K("textfield:name~0"), "Dana"),
      { says: "the message is sent", end: { kind: "exists", window: W, target: { label: "Sent!", describe: "sent notice" } }, via: { kind: "press", target: { label: "Send", describe: "Send button" } } },
    ]);
    const r = await helper.executor.run("t1", p, {});
    expect(r).toMatchObject({ outcome: "handoff", step: 1 });
    expect(r.detail).toMatch(/'Send' reads as outbound/);
    expect(app.verbs.some((v) => v.kind === "press")).toBe(false);
    expect(app.node(K("statictext:sent!~0"))).toBeUndefined();
    expect(progress("t1").at(-1)?.phase).toBe("handoff");
  });

  it("hands off a press on a control with no label, since its effect cannot be classified", async () => {
    const p = plan([{ says: "something happens", end: { kind: "exists", window: W, target: { label: "Done", describe: "done" } }, via: { kind: "press", target: { key: K("button:~0"), describe: "the unnamed button" } } }]);
    expect(await helper.executor.run("t1", p, {})).toMatchObject({ outcome: "handoff", step: 0 });
    expect(acts()).toHaveLength(0);
  });

  it("keeps an undo ledger and restores every write, newest first", async () => {
    const p = plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "dana@example.com")]);
    await helper.executor.run("t1", p, {});
    expect(helper.executor.ledger("t1")).toEqual([
      expect.objectContaining({ kind: "write", step: 0, key: K("textfield:name~0"), before: "", after: "Dana" }),
      expect.objectContaining({ kind: "write", step: 1, key: K("textfield:email~0"), before: "old@example.com", after: "dana@example.com" }),
    ]);
    const u = await helper.executor.undo("t1");
    expect(u).toEqual({ restored: 2, notRestored: [], notUndoable: 0 });
    expect(app.node(K("textfield:name~0"))?.value).toBeUndefined();
    expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
    expect(helper.executor.ledger("t1")).toEqual([]);
  });

  it("does not restore a field the user changed after Caret wrote it", async () => {
    await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "dana@example.com")]), {});
    app.setValue(K("textfield:name~0"), "Dana W. (edited by hand)");
    const u = await helper.executor.undo("t1");
    expect(u.restored).toBe(1);
    expect(u.notRestored).toEqual([{ step: 0, reason: expect.stringMatching(/changed after Caret wrote it/) }]);
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana W. (edited by hand)");
  });

  it("stops and names the step when a field changes after the plan started", async () => {
    app.afterVerb = (a, v) => {
      // After step 0's write, the user's other app changes step 2's field; nobody walks the window.
      if (v.kind === "write" && v.key === K("textfield:name~0")) a.setValue(K("textfield:email~0"), "typed@example.com");
    };
    const p = plan([write(K("textfield:name~0"), "Dana"), write(K("group:billing/textfield:city~0"), "Austin"), write(K("textfield:email~0"), "d@example.com")]);
    const r = await helper.executor.run("t1", p, {});
    expect(r).toMatchObject({ outcome: "stopped", step: 1 });
    expect(r.detail).toMatch(/email.*changed since the plan started/);
    expect(app.node(K("textfield:email~0"))?.value).toBe("typed@example.com");
  });

  it("stops and names the step when its target is removed", async () => {
    app.afterVerb = (a, v) => {
      if (v.kind === "write") a.nodes = a.nodes.filter((n) => n.key !== K("textfield:email~0"));
    };
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@example.com")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 1 });
    expect(r.detail).toMatch(/not found/);
  });

  it("stops and names the step when a sheet covers the window", async () => {
    app.afterVerb = (a, v) => {
      if (v.kind === "write") a.nodes.push({ key: K("sheet:~0"), parent: null, role: "AXSheet" });
    };
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@example.com")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 1 });
    expect(r.detail).toMatch(/a sheet covers/);
  });

  it("pauses at the next step boundary on real input in the target window, and continues on resume", async () => {
    app.afterVerb = (_, v) => {
      if (v.kind === "write" && v.key === K("textfield:name~0")) {
        void helper.handleReader({ type: "userInput", v: PROTOCOL_VERSION, at: 5, pid: FIXTURE_APP.pid, kind: "mouse", point: [50, 50] });
      }
    };
    const p = plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@example.com")]);
    const r = await helper.executor.run("t1", p, {});
    expect(r).toMatchObject({ outcome: "paused", step: 1 });
    expect(progress("t1").at(-1)).toMatchObject({ phase: "paused", step: 1 });
    app.afterVerb = null;
    expect(await helper.executor.resume("t1")).toMatchObject({ outcome: "done", acted: 2 });
  });

  it("ignores input in other processes and clicks outside the window", async () => {
    app.afterVerb = (_, v) => {
      if (v.kind !== "write") return;
      void helper.handleReader({ type: "userInput", v: PROTOCOL_VERSION, at: 5, pid: 999, kind: "key", point: null });
      void helper.handleReader({ type: "userInput", v: PROTOCOL_VERSION, at: 5, pid: FIXTURE_APP.pid, kind: "mouse", point: [5000, 5000] });
    };
    expect((await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@x.example")]), {})).outcome).toBe("done");
  });

  it("tries a failed walk again, but stops after three failures in a row", async () => {
    app.failWalks = 2;
    expect((await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {})).outcome).toBe("done");
    app.failWalks = 3;
    const r = await helper.executor.run("t2", plan([write(K("textfield:email~0"), "x@example.com")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(r.detail).toMatch(/cannot re-read/);
  });

  it("keeps a step's end target and its press target apart", async () => {
    const p = plan([
      {
        says: "page 2 is showing",
        end: { kind: "valueEquals", window: W, target: { key: K("statictext:page~0"), describe: "the page line" }, value: "Page 2" },
        via: { kind: "press", target: { label: "Next page", role: "AXButton", describe: "Next page button" } },
      },
    ]);
    expect(await helper.executor.run("t1", p, {})).toMatchObject({ outcome: "done", acted: 1 });
    expect(app.verbs.filter((v) => v.kind === "press").map((v) => (v.kind === "press" ? v.key : ""))).toEqual([K("button:next page~0")]);
  });

  it("asks the reader to watch the task's process while it runs, and stops watching after", async () => {
    await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    const watches = app.verbs.filter((v) => v.kind === "watchInput").map((v) => (v.kind === "watchInput" ? v.pids : []));
    expect(watches).toEqual([[FIXTURE_APP.pid], []]);
  });

  it("records a write the app reformatted, stops on the mismatch, and can still undo it", async () => {
    app.normalize = (v) => v.toUpperCase();
    const r = await helper.executor.run("t1", plan([write(K("textfield:email~0"), "dana@example.com")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(helper.executor.ledger("t1")).toEqual([expect.objectContaining({ before: "old@example.com", after: "DANA@EXAMPLE.COM" })]);
    app.normalize = null;
    expect(await helper.executor.undo("t1")).toMatchObject({ restored: 1 });
    expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
  });

  it("records a write whose answer was lost, so undo can still restore it", async () => {
    app.timeoutAfterWrite = true;
    const r = await helper.executor.run("t1", plan([write(K("textfield:email~0"), "dana@example.com")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(app.node(K("textfield:email~0"))?.value).toBe("dana@example.com");
    app.timeoutAfterWrite = false;
    expect(await helper.executor.undo("t1")).toMatchObject({ restored: 1 });
    expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
  });

  it("refuses to undo or resume across a reader restart, since window ids start over", async () => {
    await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    void helper.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "t" });
    await expect(helper.executor.undo("t1")).rejects.toThrow(/earlier reader session/);
  });

  describe("an ambiguous target", () => {
    const shippingCity: Step = {
      says: "the shipping city is Austin",
      end: { kind: "valueEquals", window: W, target: { role: "AXTextField", label: "City", describe: "the city field of the shipping address" }, value: "Austin" },
    };
    /** Picks the shipping field in ask 1, and `second` in ask 2. */
    const jev = (second: "shipping" | "billing"): AskJev => {
      let n = 0;
      return async (req) => {
        const which = ++n % 2 === 1 ? "shipping" : second;
        const q = req.questions.target!;
        const id = Object.entries(q.criteria).find(([, d]) => d?.includes(`inside '${which === "shipping" ? "Shipping" : "Billing"}'`))?.[0] ?? "none";
        return { model: "t", answers: { target: { choice: id, confidence: 0.9 } }, inputTokens: 100, latencyMs: 1, costUsd: 0 };
      };
    };

    it("acts when both asks pick the same element", async () => {
      askJev = jev("shipping");
      const r = await helper.executor.run("t1", plan([shippingCity]), {});
      expect(r).toMatchObject({ outcome: "done", jevCalls: 2 });
      expect(app.node(K("group:shipping/textfield:city~0"))?.value).toBe("Austin");
      expect(app.node(K("group:billing/textfield:city~0"))?.value).toBeUndefined();
    });

    it("stops without acting when the asks disagree", async () => {
      askJev = jev("billing");
      const r = await helper.executor.run("t1", plan([shippingCity]), {});
      expect(r).toMatchObject({ outcome: "stopped", step: 0 });
      expect(r.detail).toMatch(/did not agree/);
      expect(acts()).toHaveLength(0);
    });
  });

  it("adds a calendar event through the calendar interface, skips it on rerun, and undoes it", async () => {
    const ev: Step = {
      says: "Coffee with Dana is on the Caret Test calendar",
      end: { kind: "calendarEvent", calendar: "Caret Test", title: "Coffee with {{who}}", start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00" },
    };
    const p: Plan = { id: "cal", title: "cal", slots: { who: "the person" }, steps: [ev] };
    expect(await helper.executor.run("t1", p, { who: "Dana" })).toMatchObject({ outcome: "done", acted: 1 });
    expect([...calendar.events.values()].map((e) => e.title)).toEqual(["Coffee with Dana"]);
    expect(await helper.executor.run("t2", p, { who: "Dana" })).toMatchObject({ outcome: "done", skipped: 1, acted: 0 });
    expect(await helper.executor.undo("t1")).toEqual({ restored: 1, notRestored: [], notUndoable: 0 });
    expect(calendar.events.size).toBe(0);
  });

  it("rejects an invalid plan and a duplicate task id loudly", async () => {
    await expect(helper.executor.run("t1", { id: "x", steps: [] }, {})).rejects.toThrow(PlanError);
    await helper.executor.run("t2", plan([write(K("textfield:name~0"), "Dana")]), {});
    await expect(helper.executor.run("t2", plan([write(K("textfield:name~0"), "Dana")]), {})).rejects.toThrow(/already exists/);
  });

  it("publishes a request error instead of throwing when a consumer sends a bad plan", async () => {
    await helper.handleTask({ type: "runPlan", v: PROTOCOL_VERSION, taskId: "bad", plan: { nope: true }, slots: {} });
    expect(published.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/task bad: invalid plan/) });
  });

  it("stops when the window the plan names is not open", async () => {
    const r = await helper.executor.run("t1", plan([{ says: "x", end: { kind: "exists", window: { title: "Nope" }, target: { label: "A", describe: "a" } } }]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(r.detail).toMatch(/no window matches/);
    void WIN;
  });
});

describe("risk class table", () => {
  it.each([
    ["Send", "outbound"],
    ["Send now", "outbound"],
    ["Submit application", "outbound"],
    ["Delete draft", "destructive"],
    ["Move to Trash", "destructive"],
    ["Pay $12.00", "money"],
    ["Place order", "money"],
    ["Archive", "safe"],
    ["Next page", "safe"],
    ["Sender", "safe"],
    ["Payroll report", "safe"],
    ["Add note", "safe"],
  ])("%s is %s", (label, cls) => {
    expect(classifyLabel(label)).toBe(cls);
  });
});

describe("plan slots", () => {
  const p: Plan = { id: "s", title: "s", slots: { name: "the person's name" }, steps: [write(K("textfield:name~0"), "{{name}}")] };
  it("fills declared slots everywhere", () => {
    const f = fillSlots(p, { name: "Dana" });
    expect(f.steps[0]?.end).toMatchObject({ value: "Dana" });
  });
  it("refuses a missing value and an undeclared slot", () => {
    expect(() => fillSlots(p, {})).toThrow(/slot name has no value/);
    const bad: Plan = { ...p, steps: [write(K("textfield:name~0"), "{{other}}")] };
    expect(() => fillSlots(bad, { name: "Dana" })).toThrow(/not a declared slot/);
  });
});
