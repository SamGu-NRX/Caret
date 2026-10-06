// Markers for agent-thread windows, on synthetic trees shaped like T3 Code, Codex and a browser chat
// (test/agent-fixtures.ts): the composer's stop button marks a running turn, sidebar statuses of other
// threads do not, and B5's statusWord misfire is gone. Then the watcher end to end on a T3 window
// whose composer sits past the first 400 lines.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { PROTOCOL_VERSION, type Activity, type HelperMessage, type Node, type ReaderVerb, type TaskRecord, type VerbResult } from "../src/protocol.ts";
import type { JevRequest, JevResult } from "../src/fill/jev.ts";
import type { ReaderLink } from "../src/executor/means.ts";
import { RULE_SETS } from "../src/audit.ts";
import { allWatchLines, buildPendingRequest, isStopLabel, signature, watchLines, windowMarkers } from "../src/tasks/pending.ts";
import { agentSnap, BROWSER, browserChat, CODEX, codexWindow, T3, t3Window } from "./agent-fixtures.ts";
import { field, node, snap, text } from "./builders.ts";

const OTHERS = [
  { title: "Venue shortlist", status: "Working" },
  { title: "Seating chart", status: "Working" },
  { title: "Badge printing" },
];

function windowOf(app: typeof T3, nodes: Node[]): WindowState {
  const m = new ScreenModel();
  m.apply(agentSnap(app, nodes, { at: 1000, windowId: `${app.pid}-1`, title: "Thread" }));
  return m.windows.get(`${app.pid}-1`) as WindowState;
}
const rules = (w: WindowState): string[] => windowMarkers(w).map((m) => m.rule);
const b5Rules = (w: WindowState): string[] => RULE_SETS.b5(w).map((m) => m.rule);

describe("stop labels", () => {
  it.each(["Stop", "Stop generation", "Stop generating", "Stop streaming", "Stop response", "Interrupt", "Abort", "Cancel run", "Stop ⌘."])("counts %s", (l) =>
    expect(isStopLabel(l)).toBe(true),
  );
  it.each(["Cancel", "Stop sharing", "Stop recording", "Stop presenting", "Stopwatch", "Send message", "Stop Venue shortlist", "Run tests", undefined])(
    "does not count %s",
    (l) => expect(isStopLabel(l)).toBe(false),
  );
});

describe("agent-thread markers", () => {
  describe("T3 Code", () => {
    it("marks the open thread's running turn by the composer's stop button only", () => {
      const w = windowOf(T3, t3Window({ running: true, threads: OTHERS }));
      expect(windowMarkers(w)).toEqual([{ rule: "stopButton", line: "[button] Stop generation" }]);
    });

    it("finds nothing when the open thread is idle, though other threads work in the sidebar: B5's statusWord misfire", () => {
      const w = windowOf(T3, t3Window({ running: false, threads: OTHERS }));
      expect(rules(w)).toEqual([]);
      // B5's rules fire on each sidebar "Working", and would hold a watch until those threads end.
      expect(b5Rules(w)).toEqual(["statusWord", "statusWord"]);
    });

    it("clears when the turn ends, with the composer past the first 400 lines", () => {
      const running = windowOf(T3, t3Window({ running: true, threads: OTHERS, transcriptLines: 450 }));
      const done = windowOf(T3, t3Window({ running: false, threads: OTHERS, transcriptLines: 450, last: ["All four seating files are updated."] }));
      expect(rules(running)).toEqual(["stopButton"]);
      expect(rules(done)).toEqual([]);
      // B5 read only the first 400 lines: it never saw the stop button, and only the sidebar fired.
      expect(b5Rules(running)).toEqual(["statusWord", "statusWord"]);
      expect(b5Rules(done)).toEqual(["statusWord", "statusWord"]);
    });
  });

  describe("Codex", () => {
    it("marks a running turn by its Stop button and ignores sidebar statuses, a thread title with an ellipsis and the header's Thinking", () => {
      const threads = [...OTHERS, { title: "Rendering the floor plan…", status: "Working" }];
      const w = windowOf(CODEX, codexWindow({ running: true, threads }));
      expect(windowMarkers(w)).toEqual([{ rule: "stopButton", line: "[button] Stop" }]);
      const idle = windowOf(CODEX, codexWindow({ running: false, threads }));
      expect(rules(idle)).toEqual([]);
      expect(new Set(b5Rules(idle))).toEqual(new Set(["statusWord", "verbEllipsis"]));
    });
  });

  describe("browser chat", () => {
    it.each([false, true])("marks a streaming answer by the composer's stop button (Claude labels: %s)", (claude) => {
      const w = windowOf(BROWSER, browserChat({ running: true, claude, threads: [{ title: "Packing list", status: "Thinking" }] }));
      expect(windowMarkers(w)).toEqual([{ rule: "stopButton", line: `[button] ${claude ? "Stop response" : "Stop streaming"}` }]);
      expect(rules(windowOf(BROWSER, browserChat({ running: false, claude, threads: [{ title: "Packing list", status: "Thinking" }] })))).toEqual([]);
    });

    it("reads no status from a chat's text: in a window with a composer it is history", () => {
      const history = [text("h/statictext:a~0", "Running tests…", [600, 300, 300, 18]), text("h/statictext:b~0", "All tests passed.", [600, 330, 300, 18])];
      expect(rules(windowOf(BROWSER, browserChat({ running: false, extra: history })))).toEqual([]);
      expect(rules(windowOf(T3, t3Window({ running: false, extra: history })))).toEqual([]);
      expect(b5Rules(windowOf(T3, t3Window({ running: false, extra: history })))).toEqual(["verbEllipsis"]);
    });

    it("keeps a page's own status in its main pane when the page has no composer, and drops its sidebar's", () => {
      const nodes = [
        node("d/webarea~0", "AXWebArea", { label: "Deploys", frame: [0, 0, 1400, 900] }),
        text("d/statictext:side~0", "Working on 2 of 4", [20, 200, 200, 18], "d/webarea~0"),
        text("d/statictext:main~0", "Deploying 3 of 5", [600, 300, 300, 18], "d/webarea~0"),
      ];
      expect(windowMarkers(windowOf(BROWSER, nodes))).toEqual([{ rule: "verbCount", line: "Deploying 3 of 5" }]);
    });
  });

  describe("what is not an agent's running turn", () => {
    it("ignores a disabled toolbar Stop with no composer (Activity Monitor)", () => {
      const nodes = [
        node("am/button:stop~0", "AXButton", { label: "Stop", states: ["disabled"], frame: [20, 10, 30, 30] }),
        text("am/statictext:a~0", "kernel_task", [100, 100, 200, 18]),
      ];
      expect(rules(windowOf(T3, nodes))).toEqual([]);
    });

    it("ignores a Cancel button by an edit box (editing a sent message)", () => {
      const nodes = [field("e/textarea~0", "Draft reply", { role: "AXTextArea", frame: [340, 700, 900, 80] }), node("e/button:cancel~0", "AXButton", { label: "Cancel", frame: [1100, 790, 60, 30] })];
      expect(rules(windowOf(BROWSER, nodes))).toEqual([]);
    });

    it("ignores a stop button far from any composer", () => {
      const nodes = [field("e/textarea~0", "", { role: "AXTextArea", frame: [340, 780, 900, 80] }), node("e/button:stop~0", "AXButton", { label: "Stop", frame: [1300, 40, 30, 30] })];
      expect(rules(windowOf(BROWSER, nodes))).toEqual([]);
    });

    it("still marks a small job window's status at its left margin", () => {
      const m = new ScreenModel();
      const s = snap([text("j/statictext:status~0", "Running", [16, 96, 120, 20])], { at: 1, windowId: "j-1" });
      m.apply({ ...s, window: { ...s.window, frame: [0, 0, 440, 170] } });
      expect(rules(m.windows.get("j-1") as WindowState)).toEqual(["statusWord"]);
    });
  });
});

describe("the watch's text for a long agent thread", () => {
  it("keeps the transcript's end and sees the stop button change in the signature", () => {
    const running = windowOf(T3, t3Window({ running: true, transcriptLines: 600 }));
    const done = windowOf(T3, t3Window({ running: false, transcriptLines: 600, last: ["All four seating files are updated."] }));
    const lines = watchLines(done);
    expect(lines).toHaveLength(400);
    expect(lines.at(-2)).toBe("All four seating files are updated.");
    expect(watchLines(done, "head")).not.toContain("All four seating files are updated.");
    expect(signature(running, watchLines(running), windowMarkers(running))).not.toBe(signature(done, lines, windowMarkers(done)));
  });

  it("reproduces B5's first 400 lines in head mode, a node that runs past 400 included", () => {
    const big = Array.from({ length: 600 }, (_, i) => (i === 150 ? "Indexing 3 of 9" : `line ${i}`)).join("\n");
    const w = windowOf(BROWSER, [text("b/statictext:a~0", "first"), text("b/statictext:b~0", big), text("b/statictext:c~0", "after")]);
    const head = watchLines(w, "head");
    expect(head).toHaveLength(601);
    expect(head).toContain("Indexing 3 of 9");
    expect(head).not.toContain("after");
    expect(b5Rules(w)).toEqual(["verbCount"]);
  });

  it("changes the signature when a line in the middle of a long window changes", () => {
    const lines = (mid: string): Node[] => Array.from({ length: 1000 }, (_, i) => text(`m/statictext:${i}~0`, i === 500 ? mid : `entry ${i}`, [300, 20 * i, 400, 18]));
    const a = windowOf(BROWSER, lines("Copy finished"));
    const b = windowOf(BROWSER, lines("Approve the copy of 3 files?"));
    expect(watchLines(a)).toEqual(watchLines(b));
    expect(signature(a, allWatchLines(a), windowMarkers(a))).not.toBe(signature(b, allWatchLines(b), windowMarkers(b)));
  });

  it("names at most four marker lines in a question, within the window's budget", () => {
    const many = Array.from({ length: 50 }, (_, i) => text(`s/statictext:${i}~0`, `Exporting part ${i} of 50`, [600, 20 * i, 300, 18]));
    const w = windowOf(BROWSER, many);
    const req = buildPendingRequest(w, [w], watchLines(w), watchLines(w), windowMarkers(w), windowMarkers(w));
    expect(String((req.state as Record<string, string>).signs_of_running_work_now).split("\n")).toHaveLength(4);
  });

  it("tells Jev the signs of running work then and now", () => {
    const running = windowOf(T3, t3Window({ running: true }));
    const done = windowOf(T3, t3Window({ running: false, last: ["All four seating files are updated."] }));
    const req = buildPendingRequest(done, [done], watchLines(running), watchLines(done), windowMarkers(running), windowMarkers(done));
    const state = req.state as Record<string, string>;
    expect(state.signs_of_running_work_when_the_user_left).toBe("[button] Stop generation");
    expect(state.signs_of_running_work_now).toBe("none");
    expect(state.lines_that_changed).toContain("All four seating files are updated.");
  });
});

class Reader implements ReaderLink {
  readonly verbs: ReaderVerb[] = [];
  async run(verb: ReaderVerb): Promise<VerbResult> {
    this.verbs.push(verb);
    return { type: "verbResult", v: PROTOCOL_VERSION, id: "r", at: 0, outcome: "ok", detail: null };
  }
}

describe("watching a T3 Code thread", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let sent: HelperMessage[];
  let requests: JevRequest[];
  let at: number;
  const T3W = "8101-1";
  const NOTES = "5150-9";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-agent-"));
    store = new Store(dir);
    sent = [];
    requests = [];
    at = 1000;
    // Answers from the markers alone: a stop button now means still running.
    const ask = async (req: JevRequest): Promise<JevResult> => {
      requests.push(req);
      const running = (req.state as Record<string, string>).signs_of_running_work_now !== "none";
      return {
        model: "jev-test",
        answers: { finished: { choice: running ? "no" : "yes", confidence: 0.9 }, waiting: { choice: "no", confidence: 0.9 } },
        inputTokens: 300,
        latencyMs: 40,
        costUsd: 0,
      };
    };
    helper = new Helper({ store, askJev: ask, shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), readerLink: new Reader() });
  });
  afterEach(() => {
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const show = (nodes: Node[], focused: boolean, reason: "focus" | "leave" | "watch"): void => {
    at += 100;
    void helper.handleReader(agentSnap(T3, nodes, { at, windowId: T3W, title: "Seating chart", focused, reason }));
  };
  const toNotes = (): void => {
    at += 100;
    void helper.handleReader(snap([field("n/textfield~0", "")], { at, windowId: NOTES, title: "Notes", focused: true, reason: "focus" }));
  };
  const watches = (): TaskRecord[] => sent.filter((m): m is Activity => m.type === "activity" && m.task.kind === "watch").map((m) => m.task);

  it("watches a running turn left behind a long transcript and reports it done when the stop button goes", async () => {
    show(t3Window({ running: true, threads: OTHERS, transcriptLines: 450 }), true, "focus");
    show(t3Window({ running: true, threads: OTHERS, transcriptLines: 450 }), false, "leave");
    toNotes();
    expect(watches().at(-1)).toMatchObject({ state: "running", windowId: T3W, pending: { markedBy: "[button] Stop generation" } });
    show(t3Window({ running: false, threads: OTHERS, transcriptLines: 450, last: ["All four seating files are updated."] }), false, "watch");
    await helper.pending.whenIdle();
    expect(requests).toHaveLength(1);
    expect(watches().at(-1)).toMatchObject({ state: "done", cause: "screen" });
  });

  it("asks nothing about a truncated walk, which may have missed the stop button", async () => {
    show(t3Window({ running: true, threads: OTHERS }), true, "focus");
    show(t3Window({ running: true, threads: OTHERS }), false, "leave");
    toNotes();
    at += 100;
    const cut = agentSnap(T3, t3Window({ running: true, threads: OTHERS }).slice(0, 20), { at, windowId: T3W, title: "Seating chart", reason: "watch" });
    void helper.handleReader({ ...cut, stats: { walkMs: 400, visited: 6000, truncated: true } });
    await helper.pending.whenIdle();
    expect(requests).toHaveLength(0);
    expect(watches().at(-1)).toMatchObject({ state: "running" });
  });

  it("registers no watch for a window whose open thread is idle while sidebar threads work", () => {
    show(t3Window({ running: false, threads: OTHERS }), true, "focus");
    show(t3Window({ running: false, threads: OTHERS }), false, "leave");
    toNotes();
    expect(watches()).toEqual([]);
    expect(helper.pending.stats).toMatchObject({ registered: 0, noMarkers: 2 });
  });
});
