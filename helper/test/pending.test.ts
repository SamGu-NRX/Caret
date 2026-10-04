// The pending-state watch: markers found by code, one watch per left window, Jev asked only when the
// window's text changes (digits ignored), and the answer as the watch's task state.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type Activity, type HelperMessage, type Node, type ReaderVerb, type TaskRecord, type VerbResult } from "../src/protocol.ts";
import type { JevRequest, JevResult } from "../src/fill/jev.ts";
import type { ReaderLink } from "../src/executor/means.ts";
import { pendingMarkers, stateFor } from "../src/tasks/pending.ts";
import { field, node, snap, text } from "./builders.ts";

describe("pending markers", () => {
  it.each([
    "Running tests… 12 of 48",
    "Uploading 3 files to the shared drive…",
    "Building",
    "● Running",
    "Exporting 40%",
    "Status: running",
    "Thinking...",
    "Compiling 3/12 files",
    "In progress",
    "[progress bar]",
    "[busy indicator]",
  ])("marks %s", (line) => expect(pendingMarkers([line])).toEqual([line]));

  it.each([
    "Room 4B, Building C",
    "Shipping address:",
    "Status: Active",
    "Running shoes, size 10",
    "[button] Run tests",
    "[button] Building…",
    "Testing notes",
    "Order number: ORD-2026-48213",
    "Working hours: 9 to 5",
    "Loading…",
    "Saving...",
    "Done. 48 of 48 tests passed in 1 min 12 s.",
    "Approve? Three files with these names already exist on the shared drive. Replace them?",
  ])("leaves %s alone", (line) => expect(pendingMarkers([line])).toEqual([]));

  it("lets waiting on the user win over finished", () => {
    expect(stateFor("yes", "yes")).toBe("needsYou");
    expect(stateFor("yes", "no")).toBe("done");
    expect(stateFor("failed", "no")).toBe("failed");
    expect(stateFor("no", "no")).toBe("running");
  });
});

const JOB = "5150-3";
const NOTES = "5150-4";
const K = (s: string): string => `dev.caret.fixture/standard/${s}`;
const STATUS = K("statictext:status~0");

class Reader implements ReaderLink {
  readonly verbs: ReaderVerb[] = [];
  async run(verb: ReaderVerb): Promise<VerbResult> {
    this.verbs.push(verb);
    return { type: "verbResult", v: PROTOCOL_VERSION, id: "r", at: 0, outcome: "ok", detail: null };
  }
  watched(): string[][] {
    const last = this.verbs.filter((v) => v.kind === "watchWindows").at(-1);
    return last?.kind === "watchWindows" ? last.windows.map((w) => [String(w.pid), w.windowId]) : [];
  }
}

/** A scripted Jev: answers from the lines that changed by the rules the test sets, and records every request. */
class Jev {
  readonly requests: JevRequest[] = [];
  delayMs = 0;
  answer = (now: string): { finished: string; waiting: string } =>
    /approve\?/i.test(now) ? { finished: "no", waiting: "yes" } : /done|passed/i.test(now) ? { finished: "yes", waiting: "no" } : { finished: "no", waiting: "no" };
  readonly ask = async (req: JevRequest): Promise<JevResult> => {
    this.requests.push(req);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const now = String((req.state as Record<string, unknown>).lines_that_changed);
    const a = this.answer(now);
    return { model: "jev-test", answers: { finished: { choice: a.finished, confidence: 0.9 }, waiting: { choice: a.waiting, confidence: 0.95 } }, inputTokens: 300, latencyMs: 40, costUsd: 0.0000126 };
  };
}

describe("pending-state watch", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let sent: HelperMessage[];
  let reader: Reader;
  let jev: Jev;
  let at: number;

  const jobNodes = (status: string, extra: Node[] = [node(K("progressindicator:~0"), "AXProgressIndicator")]): Node[] => [
    text(K("statictext:test suite~0"), "Test suite: checkout service"),
    text(STATUS, status),
    field(K("textfield:comment~0"), "my private note"),
    ...extra,
  ];
  const show = (windowId: string, nodes: Node[], o: { focused?: boolean; reason?: "focus" | "leave" | "watch" | "event"; title?: string } = {}): void => {
    at += 100;
    void helper.handleReader(snap(nodes, { at, windowId, title: o.title ?? (windowId === JOB ? "Test run" : "Notes"), focused: o.focused ?? false, reason: o.reason ?? "watch" }));
  };
  /** The user is in the job window, then moves to the notes window. */
  const leaveJob = (status: string, extra?: Node[]): void => {
    show(JOB, jobNodes(status, extra), { focused: true, reason: "focus" });
    show(JOB, jobNodes(status, extra), { reason: "leave" });
    show(NOTES, [field(K("textfield:notes~0"), "")], { focused: true, reason: "focus" });
  };
  const records = (): TaskRecord[] => sent.filter((m): m is Activity => m.type === "activity" && m.task.kind === "watch").map((m) => m.task);
  const last = (): TaskRecord | undefined => records().at(-1);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-pending-"));
    store = new Store(dir);
    sent = [];
    reader = new Reader();
    jev = new Jev();
    at = 1000;
    helper = new Helper({ store, askJev: jev.ask, shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), readerLink: reader });
  });
  afterEach(() => {
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // CodeRabbit on PR #5: the watch's reader promise had no rejection handler, so a link that rejects ended the helper.
  it("survives a reader link that rejects the watch, and says so", async () => {
    helper.shutdown();
    helper.memory.close();
    const warnings: string[] = [];
    const failing: ReaderLink = {
      run: async (v) => {
        if (v.kind === "watchWindows") throw new Error("the reader's connection is gone");
        return reader.run(v);
      },
    };
    helper = new Helper({ store, askJev: jev.ask, shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), readerLink: failing, warn: (l) => warnings.push(l) });
    leaveJob("Running tests… 12 of 48");
    await new Promise((r) => setImmediate(r));
    expect(warnings).toContain("pending: watchWindows failed: the reader's connection is gone");
    expect(last()).toMatchObject({ state: "running" });
  });

  it("watches a left job window, asks nothing while only its counter moves, and reports done when it finishes", async () => {
    leaveJob("Running tests… 12 of 48");
    expect(last()).toMatchObject({ state: "running", windowId: JOB, says: "Watching 'Test run' in Caret Fixture", pending: { markedBy: "Running tests… 12 of 48", asks: 0 } });
    expect(reader.watched()).toEqual([["5150", JOB]]);
    for (let n = 13; n < 20; n++) show(JOB, jobNodes(`Running tests… ${n} of 48`));
    await helper.pending.whenIdle();
    expect(jev.requests).toHaveLength(0);

    show(JOB, jobNodes("Done. 48 of 48 tests passed in 1 min 12 s.", []));
    await helper.pending.whenIdle();
    expect(jev.requests).toHaveLength(1);
    expect(last()).toMatchObject({ state: "done", cause: "screen", pending: { status: "Done. 48 of 48 tests passed in 1 min 12 s.", finished: { choice: "yes" }, waiting: { choice: "no" }, asks: 1 } });
    expect(reader.watched()).toEqual([]);
    expect(helper.pending.watchOf(JOB)).toBeNull();
  });

  it("reports needsYou for an approval prompt, running again once it goes on, and failed if the window closes", async () => {
    leaveJob("Uploading 3 files to the shared drive…", [node(K("busyindicator:~0"), "AXBusyIndicator")]);
    show(JOB, jobNodes("Approve? Three files already exist. Replace them?", [node(K("button:approve~0"), "AXButton", { label: "Approve" })]));
    await helper.pending.whenIdle();
    expect(last()).toMatchObject({ state: "needsYou", cause: "screen", detail: "the window is waiting for you", says: "'Test run' in Caret Fixture is waiting for you", frame: [0, 0, 800, 600] });
    show(JOB, jobNodes("Uploading 3 files to the shared drive…", [node(K("busyindicator:~0"), "AXBusyIndicator")]));
    await helper.pending.whenIdle();
    expect(last()).toMatchObject({ state: "running", cause: null, says: "Watching 'Test run' in Caret Fixture" });
    void helper.handleReader({ type: "windowClosed", v: PROTOCOL_VERSION, at: at + 1, windowId: JOB });
    expect(last()).toMatchObject({ state: "failed", cause: "screen", detail: "the window closed before Caret saw the work finish" });
    expect(records().map((r) => r.state)).toEqual(["running", "needsYou", "running", "failed"]);
  });

  it("closing a window that waits on the user ends the watch as done by the user", async () => {
    leaveJob("Uploading 3 files…");
    show(JOB, jobNodes("Approve? Replace them?"));
    await helper.pending.whenIdle();
    void helper.handleReader({ type: "windowClosed", v: PROTOCOL_VERSION, at: at + 1, windowId: JOB });
    expect(last()).toMatchObject({ state: "done", cause: "you", detail: "you closed the window" });
  });

  it("drops an answer about a screen that changed while Jev answered, and asks again", async () => {
    leaveJob("Running tests… 12 of 48");
    jev.delayMs = 120;
    show(JOB, jobNodes("Running tests… 12 of 48 (2 failed so far)"));
    // Past the debounce, so the first question is in flight when the window finishes.
    await new Promise((r) => setTimeout(r, 200));
    expect(jev.requests).toHaveLength(1);
    show(JOB, jobNodes("Done. 48 of 48 tests passed.", []));
    await helper.pending.whenIdle();
    expect(helper.pending.stats.stale).toBe(1);
    expect(jev.requests).toHaveLength(2);
    expect(helper.pending.asks.map((a) => [a.state, a.stale])).toEqual([["running", true], ["done", false]]);
    expect(records().map((r) => r.state)).toEqual(["running", "done"]);
  });

  it("asks less and less often while a streaming window keeps saying it is still running", async () => {
    leaveJob("Running tests… 12 of 48");
    const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(" ");
    const t0 = Date.now();
    for (const w of words) {
      show(JOB, jobNodes("Running tests…", [node(K("progressindicator:~0"), "AXProgressIndicator"), text(K("statictext:log~0"), `checked ${w}`)]));
      await new Promise((r) => setTimeout(r, 120));
    }
    await helper.pending.whenIdle();
    const spanS = (Date.now() - t0) / 1000;
    // 26 changes over about 3 s: the first question, then 1 s and 2 s of backoff, so at most four.
    expect(spanS).toBeGreaterThan(2.5);
    expect(jev.requests.length).toBeGreaterThanOrEqual(2);
    expect(jev.requests.length).toBeLessThanOrEqual(4);
    expect(last()).toMatchObject({ state: "running" });
  });

  it("tries a failing question twice more, a second apart, then waits for the next change", async () => {
    const failing = (): Promise<JevResult> => {
      fails++;
      return Promise.reject(new Error("Jev HTTP 503"));
    };
    let fails = 0;
    const h = new Helper({ store, askJev: failing, shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), readerLink: reader });
    const original = helper;
    helper = h;
    leaveJob("Running tests… 12 of 48");
    show(JOB, jobNodes("Done. 48 of 48 tests passed.", []));
    await h.pending.whenIdle();
    expect(fails).toBe(3);
    await new Promise((r) => setTimeout(r, 1300));
    expect(fails).toBe(3);
    show(JOB, jobNodes("Finished with warnings.", []));
    await h.pending.whenIdle();
    expect(fails).toBe(6);
    expect(h.pending.stats.errors).toBe(6);
    h.shutdown();
    h.memory.close();
    helper = original;
  }, 15_000);

  it("registers no watch for a window without markers, nor again for work it already resolved", async () => {
    show(NOTES, [field(K("textfield:notes~0"), "Running tests…"), text(K("statictext:hint~0"), "Write anything here")], { focused: true, reason: "focus" });
    show(JOB, jobNodes("All quiet", []), { focused: true, reason: "focus" });
    expect(helper.pending.stats).toMatchObject({ checked: 1, registered: 0, noMarkers: 1 });
    expect(records()).toEqual([]);

    leaveJob("Running tests… 12 of 48");
    show(JOB, jobNodes("Done. 48 of 48 tests passed.", []));
    await helper.pending.whenIdle();
    show(JOB, jobNodes("Done. 48 of 48 tests passed.", []), { focused: true, reason: "focus" });
    show(NOTES, [field(K("textfield:notes~0"), "")], { focused: true, reason: "focus" });
    expect(helper.pending.stats.registered).toBe(1);
  });

  it("asks with snippets only: the signs then and now and the lines that changed, never a typed value or the rest of the window", async () => {
    const many = Array.from({ length: 60 }, (_, i) => text(K(`statictext:line ${i}~0`), `Log line ${i}`));
    leaveJob("Running tests… 12 of 48", [node(K("progressindicator:~0"), "AXProgressIndicator"), ...many]);
    show(JOB, jobNodes("Done. 48 of 48 tests passed.", many));
    await helper.pending.whenIdle();
    const req = jev.requests[0]!;
    const state = req.state as Record<string, string>;
    const body = JSON.stringify({ state: req.state, questions: req.questions });
    expect(body).not.toContain("my private note");
    expect(body).not.toContain("Log line");
    expect(state.lines_that_changed).toBe("Done. 48 of 48 tests passed.");
    expect(state.signs_of_running_work_when_the_user_left).toBe("Running tests… 12 of 48\n[progress bar]");
    expect(state.signs_of_running_work_now).toBe("none");
    expect(req.snippets.map((x) => x.text)).toEqual(["Test run", "Done. 48 of 48 tests passed.", "Running tests… 12 of 48"]);
    expect(Object.keys(req.questions)).toEqual(["finished", "waiting"]);
  });

  it("pauses, resumes and stops a watch through taskControl, and refuses take over", async () => {
    leaveJob("Running tests… 12 of 48");
    const id = last()!.id;
    const control = (action: "pause" | "resume" | "stop" | "takeOver") => helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: id, action });
    await control("pause");
    expect(last()).toMatchObject({ state: "paused", cause: "you" });
    expect(reader.watched()).toEqual([]);
    show(JOB, jobNodes("Done. 48 of 48 tests passed.", []));
    await helper.pending.whenIdle();
    expect(jev.requests).toHaveLength(0);
    await control("resume");
    expect(reader.watched()).toEqual([["5150", JOB]]);
    await helper.pending.whenIdle();
    expect(last()).toMatchObject({ state: "done" });

    leaveJob("Running tests… 1 of 48");
    const second = last()!.id;
    expect(second).not.toBe(id);
    await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: second, action: "takeOver" });
    expect(sent.at(-1)).toMatchObject({ type: "error", message: `task ${second}: a watch takes pause, resume and stop, not takeOver` });
    await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: second, action: "stop" });
    expect(last()).toMatchObject({ id: second, state: "failed", cause: "you", detail: "you stopped watching" });
    await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: second, action: "resume" });
    expect(sent.at(-1)).toMatchObject({ type: "error", message: `task ${second}: watch ${second} has ended` });
  });

  it("watches nothing in shadow mode or without Jev, and forgets every watch when the reader restarts", () => {
    leaveJob("Running tests… 12 of 48");
    void helper.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 1, version: "t" });
    expect(last()).toMatchObject({ state: "failed", cause: "screen" });
    const off = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), readerLink: reader });
    const shadow = new Helper({ store, askJev: jev.ask, shadow: true, allowBackgroundFocus: false, publish: (m) => sent.push(m), readerLink: reader });
    const original = helper;
    for (const h of [off, shadow]) {
      helper = h;
      leaveJob("Running tests… 12 of 48");
      expect(h.pending.stats.registered).toBe(0);
    }
    helper = original;
  });
});
