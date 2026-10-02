// Live Jev on the pending question for agent-thread windows, on the synthetic trees in
// test/agent-fixtures.ts (no real window text goes to Jev). Each window is left mid-turn behind a
// 450-line transcript, so its composer and its newest lines are past the first 400 lines, and then
// shows one of four outcomes: the turn finished, it is still running, it waits for an approval, or
// it failed. Each case is asked in B6's form (first 100 and last 300 lines, the markers then and now)
// and in B5's (the first 400 lines, no markers), REPS times each. B4's fixture job windows follow, in
// B6's form only, to check the B6 change to the waiting criteria on the texts B4 was measured on.
//
//   CARET_ENV_FILE=/path/to/.env node scripts/pending-agent-eval.ts --out DIR [--reps N]
//
// Writes results.json and summary.md. The key is read when a request is made and never printed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadJevKey, makeJevClient, type JevRequest } from "../src/fill/jev.ts";
import { ScreenModel, type WindowState } from "../src/model.ts";
import type { AppRef, Node, TaskState } from "../src/protocol.ts";
import { buildPendingRequest, mask, pendingMarkers, readPendingAnswer, stateFor, watchLines, windowMarkers } from "../src/tasks/pending.ts";
import { agentSnap, BROWSER, browserChat, CODEX, codexWindow, T3, t3Window, type AgentWindow } from "../test/agent-fixtures.ts";

const { values: a } = parseArgs({ options: { out: { type: "string" }, reps: { type: "string", default: "2" } } });
if (a.out === undefined) throw new Error("--out is required");
const OUT = a.out;
const REPS = Number(a.reps);
mkdirSync(OUT, { recursive: true });
loadJevKey(); // fail now, not at the first question
const ask = makeJevClient(() => loadJevKey());

type Build = (o: AgentWindow) => Node[];
const APPS: { name: string; app: AppRef; build: Build }[] = [
  { name: "T3 Code", app: T3, build: t3Window },
  { name: "Codex", app: CODEX, build: codexWindow },
  { name: "ChatGPT in a browser", app: BROWSER, build: (o) => browserChat(o) },
  { name: "Claude in a browser", app: BROWSER, build: (o) => browserChat({ ...o, claude: true }) },
];
const THREADS = [{ title: "Venue shortlist", status: "Working" }, { title: "Badge printing" }];
const LINES = 450;
const APPROVAL: Node[] = [
  { key: "x/statictext:approve~0", parent: null, role: "AXStaticText", label: "The agent wants to run: pnpm install --frozen-lockfile. Allow this command?", frame: [340, 720, 900, 18] },
  { key: "x/button:approve~0", parent: null, role: "AXButton", label: "Approve", frame: [340, 745, 90, 28] },
  { key: "x/button:deny~0", parent: null, role: "AXButton", label: "Deny", frame: [440, 745, 90, 28] },
];
const CASES: { id: string; expect: TaskState; now: AgentWindow }[] = [
  { id: "finished", expect: "done", now: { running: false, threads: THREADS, transcriptLines: LINES, last: ["Updated all four seating files and ran the checks: 48 of 48 passed."] } },
  { id: "stillRunning", expect: "running", now: { running: true, threads: THREADS, transcriptLines: LINES + 3, last: ["Reading the venue notes for table sizes"] } },
  { id: "approval", expect: "needsYou", now: { running: true, threads: THREADS, transcriptLines: LINES, extra: APPROVAL } },
  { id: "failed", expect: "failed", now: { running: false, threads: THREADS, transcriptLines: LINES, last: ["Error: the seating export failed: 3 tables reference a missing room."] } },
];

function windowOf(app: AppRef, nodes: Node[]): WindowState {
  const m = new ScreenModel();
  m.apply(agentSnap(app, nodes, { at: 1000, windowId: `${app.pid}-1`, title: "Seating chart" }));
  return m.windows.get(`${app.pid}-1`) as WindowState;
}

/** B5's request: the first 400 lines then and now, changed lines and word markers kept first, no markers named. */
function b5Request(w: WindowState, then: WindowState): JevRequest {
  const thenLines = watchLines(then, "head");
  const now = watchLines(w, "head");
  const before = new Set(thenLines.map(mask));
  const keep = new Set<string>([...now.slice(0, 3), ...now.filter((l) => !before.has(mask(l))), ...pendingMarkers(now)]);
  for (const l of now) {
    if (keep.size >= 30) break;
    keep.add(l);
  }
  const req = buildPendingRequest(w, thenLines, now);
  const state = req.state as Record<string, string>;
  return {
    ...req,
    state: {
      window: state.window,
      situation: state.situation,
      when_the_user_left: thenLines.slice(0, 20).join("\n"),
      now: now.filter((l) => keep.has(l)).slice(0, 30).join("\n"),
    },
  };
}

interface Row {
  app: string;
  case: string;
  form: "b6" | "b5";
  expect: TaskState;
  got: TaskState | "error";
  finished: string;
  waiting: string;
  confidence: number;
  latencyMs: number;
}
const rows: Row[] = [];
for (const { name, app, build } of APPS) {
  const then = windowOf(app, build({ running: true, threads: THREADS, transcriptLines: LINES }));
  for (const c of CASES) {
    const now = windowOf(app, build(c.now));
    const forms: { form: "b6" | "b5"; req: JevRequest }[] = [
      { form: "b6", req: buildPendingRequest(now, watchLines(then), watchLines(now), windowMarkers(then), windowMarkers(now)) },
      { form: "b5", req: b5Request(now, then) },
    ];
    for (const { form, req } of forms) {
      for (let r = 0; r < REPS; r++) {
        try {
          const res = await ask(req);
          const ans = readPendingAnswer(res);
          const got = stateFor(ans.finished.choice, ans.waiting.choice);
          rows.push({ app: name, case: c.id, form, expect: c.expect, got, finished: ans.finished.choice, waiting: ans.waiting.choice, confidence: Math.min(ans.finished.confidence, ans.waiting.confidence), latencyMs: Math.round(res.latencyMs) });
        } catch (e) {
          rows.push({ app: name, case: c.id, form, expect: c.expect, got: "error", finished: "", waiting: "", confidence: 0, latencyMs: 0 });
          process.stderr.write(`${name} ${c.id} ${form}: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
      const last = rows.at(-1);
      process.stdout.write(`${name} ${c.id} ${form}: expect ${c.expect}, got ${last?.got}\n`);
    }
  }
}

// B4's fixture job windows (caret-fixture --windows jobs), as trees: the waiting criteria changed in
// B6, so the ordinary finish and approval texts are asked again in the current form.
const JOBS: AppRef = { pid: 8404, bundleId: "dev.caret.fixture", name: "Caret Fixture" };
const job = (title: string, status: string, indicator: string | null, buttons: string[] = []): WindowState => {
  const nodes: Node[] = [
    { key: "j/statictext:head~0", parent: null, role: "AXStaticText", label: title, frame: [96, 450, 400, 20] },
    { key: "j/statictext:status~0", parent: null, role: "AXStaticText", label: status, frame: [96, 484, 400, 20] },
    ...(indicator === null ? [] : [{ key: "j/indicator~0", parent: null, role: indicator, frame: [96, 520, 400, 20] } as Node]),
    ...buttons.map((b, i): Node => ({ key: `j/button:${i}~0`, parent: null, role: "AXButton", label: b, frame: [96 + i * 110, 540, 100, 30] })),
  ];
  const m = new ScreenModel();
  const sn = agentSnap(JOBS, nodes, { at: 1000, windowId: "8404-1", title: "Caret Fixture — Job" });
  m.apply({ ...sn, window: { ...sn.window, frame: [80, 420, 440, 170] } });
  return m.windows.get("8404-1") as WindowState;
};
const JOB_CASES: { id: string; expect: TaskState; then: WindowState; now: WindowState }[] = [
  ...["Done. 48 of 48 tests passed in 1 min 12 s.", "Build succeeded. All 48 tests passed.", "Finished: 48 tests passed, 0 failed."].map((t, i) => ({
    id: `jobFinished${i + 1}`,
    expect: "done" as TaskState,
    then: job("Test suite: checkout service", "Running tests… 12 of 48", "AXProgressIndicator"),
    now: job("Test suite: checkout service", t, null),
  })),
  ...[
    "Approve? Three files with these names already exist on the shared drive. Replace them?",
    "Waiting for your approval: replace 3 existing files on the shared drive?",
    "Approve? Sign in again to continue uploading to the shared drive.",
  ].map((t, i) => ({
    id: `jobApproval${i + 1}`,
    expect: "needsYou" as TaskState,
    then: job("Shared drive: Q4 planning", "Uploading 3 files to the shared drive…", "AXBusyIndicator"),
    now: job("Shared drive: Q4 planning", t, null, ["Approve", "Cancel"]),
  })),
];
for (const c of JOB_CASES) {
  const req = buildPendingRequest(c.now, watchLines(c.then), watchLines(c.now), windowMarkers(c.then), windowMarkers(c.now));
  for (let r = 0; r < REPS; r++) {
    try {
      const res = await ask(req);
      const ans = readPendingAnswer(res);
      const got = stateFor(ans.finished.choice, ans.waiting.choice);
      rows.push({ app: "Fixture job window", case: c.id, form: "b6", expect: c.expect, got, finished: ans.finished.choice, waiting: ans.waiting.choice, confidence: Math.min(ans.finished.confidence, ans.waiting.confidence), latencyMs: Math.round(res.latencyMs) });
    } catch (e) {
      rows.push({ app: "Fixture job window", case: c.id, form: "b6", expect: c.expect, got: "error", finished: "", waiting: "", confidence: 0, latencyMs: 0 });
      process.stderr.write(`job ${c.id}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  process.stdout.write(`job ${c.id}: expect ${c.expect}, got ${rows.at(-1)?.got}\n`);
}

writeFileSync(join(OUT, "results.json"), `${JSON.stringify({ at: new Date().toISOString(), reps: REPS, rows }, null, 2)}\n`);
const right = (form: "b6" | "b5", id?: string): string => {
  const rs = rows.filter((r) => r.form === form && (id === undefined || r.case === id || (id === "agent" && r.app !== "Fixture job window")));
  return `${rs.filter((r) => r.got === r.expect).length} of ${rs.length}`;
};
const lat = rows.map((r) => r.latencyMs).filter((x) => x > 0).sort((x, y) => x - y);
const md = [
  "# Live Jev on agent-thread watches (synthetic windows)",
  "",
  `\`node scripts/pending-agent-eval.ts --reps ${REPS}\`, ${new Date().toISOString().slice(0, 16)}Z. Synthetic trees from test/agent-fixtures.ts for ${APPS.map((x) => x.name).join(", ")}, each left mid-turn behind a ${LINES}-line transcript, so the composer and the newest lines are past the first 400 lines. Every case was asked ${REPS} times in each form. Latency p50 ${lat[Math.floor(lat.length / 2)] ?? "-"} ms, max ${lat.at(-1) ?? "-"} ms.`,
  "",
  "- *B6 form*: the first 100 and last 300 lines, and the markers when the user left and now.",
  "- *B5 form*: the first 400 lines and no markers, as B4's watch asked.",
  "",
  "| Case | Expected state | B6 form right | B5 form right |",
  "|---|---|---:|---:|",
  ...CASES.map((c) => `| ${c.id} | ${c.expect} | ${right("b6", c.id)} | ${right("b5", c.id)} |`),
  `| all agent cases | | ${right("b6", "agent")} | ${right("b5", "agent")} |`,
  "",
  "B4's fixture job windows (a test run finishing, an upload asking for approval, as caret-fixture shows them), asked in the B6 form only, since the waiting criteria changed in B6:",
  "",
  "| Case | Expected state | Right |",
  "|---|---|---:|",
  ...JOB_CASES.map((c) => `| ${c.id} | ${c.expect} | ${right("b6", c.id)} |`),
  "",
  "## Every answer",
  "",
  "| App | Case | Form | Expected | Got | Finished | Waiting | Lower confidence |",
  "|---|---|---|---|---|---|---|---:|",
  ...rows.map((r) => `| ${r.app} | ${r.case} | ${r.form} | ${r.expect} | ${r.got} | ${r.finished} | ${r.waiting} | ${r.confidence.toFixed(2)} |`),
  "",
];
writeFileSync(join(OUT, "summary.md"), md.join("\n"));
