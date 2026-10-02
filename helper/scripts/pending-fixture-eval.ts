// The pending-state watch end to end on caret-fixture, with the real reader and live Jev.
//
//   1. False watches: the scripted user moves through the fixture's ordinary windows (focus only,
//      inside the fixture), leaving each one twice. No watch may be registered.
//   2. Ten runs: the user leaves the test-run window and the upload window while they work; then the
//      test run finishes and the upload asks for approval. The feed must show done and needsYou, and
//      the latency is measured from the fixture's own timestamp of each change to the activity message.
//   3. Idle CPU: a second reader without event-driven flags, so the watch alone adds the observer,
//      measured with and without a watch on an upload window that does not change.
//
// It opens windows, so it runs while holding the GUI lock, and it stops its own two processes if
// either is ever the frontmost app:
//
//   /usr/bin/lockf -k ~/.long-run/locks/gui.lock env CARET_GUI_LOCK=held CARET_ENV_FILE=/path/to/.env \
//     node scripts/pending-fixture-eval.ts --bin ../apps/screen-reader/.build/debug --out DIR
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { loadJevKey, makeJevClient } from "../src/fill/jev.ts";
import { PROTOCOL_VERSION, type Activity, type HelperMessage, type TaskState } from "../src/protocol.ts";

const { values: a } = parseArgs({
  options: {
    bin: { type: "string" },
    out: { type: "string" },
    runs: { type: "string", default: "10" },
    "cpu-seconds": { type: "string", default: "45" },
    socket: { type: "string", default: join(homedir(), ".caret-run", "sockets", "b4-pending.sock") },
  },
});
if (a.bin === undefined || a.out === undefined) throw new Error("--bin and --out are required");
if (process.env.CARET_GUI_LOCK !== "held") throw new Error("run under /usr/bin/lockf -k ~/.long-run/locks/gui.lock env CARET_GUI_LOCK=held ...");
loadJevKey(); // fail now, not at the first question
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const RUNS = Number(a.runs);
const CPU_S = Number(a["cpu-seconds"]);
const TEST = "Caret Fixture — Test run";
const UPLOAD = "Caret Fixture — Upload";
const ORDINARY = ["reference", "distractors", "claim", "schedule", "roster", "executor", "notes"];

// MARK: - frontmost app, from LaunchServices

interface Front {
  at: number;
  pid: number;
  name: string;
}
function front(): Front {
  const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
  const info = execFileSync("lsappinfo", ["info", "-only", "pid", "-only", "name", asn], { encoding: "utf8" });
  return { at: Date.now(), pid: Number(/"pid"=(\d+)/.exec(info)?.[1] ?? -1), name: /"LSDisplayName"="([^"]*)"/.exec(info)?.[1] ?? "" };
}
/**
 * The same read without blocking: execFileSync every 100 ms held the event loop for each spawn and
 * added 150 to 250 ms to every measured latency (pending-run5).
 */
const run = promisify(execFile);
async function frontAsync(): Promise<Front> {
  const asn = (await run("lsappinfo", ["front"], { encoding: "utf8" })).stdout.trim();
  const info = (await run("lsappinfo", ["info", "-only", "pid", "-only", "name", asn], { encoding: "utf8" })).stdout;
  return { at: Date.now(), pid: Number(/"pid"=(\d+)/.exec(info)?.[1] ?? -1), name: /"LSDisplayName"="([^"]*)"/.exec(info)?.[1] ?? "" };
}
const frontBefore = front();
const fronts: Front[] = [frontBefore];

// MARK: - helper in process, with live Jev

const sent: HelperMessage[] = [];
const log: string[] = [];
const dataDir = mkdtempSync(join(tmpdir(), "caret-pending-eval-"));
const store = new Store(dataDir);
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  askJev: makeJevClient(() => loadJevKey()),
  shadow: false,
  allowBackgroundFocus: false,
  publish: (m) => {
    sent.push(m);
    server?.publish(m);
  },
  sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
  warn: (l) => log.push(`${new Date().toISOString()} ${l}`),
});
// Counts snapshots as they arrive, by reason, for the idle measurement.
const snapshots = { all: 0, watch: 0 };
/** Snapshot arrivals for the job windows: reader time, helper time, reason, partial or full. Bounded. */
const arrivals: { windowId: string; readerAt: number; recvAt: number; reason: string; partial: boolean }[] = [];
let hellos = 0;
const handleReader = helper.handleReader.bind(helper);
helper.handleReader = (m) => {
  if (m.type === "hello") hellos++;
  if (m.type === "snapshot") {
    if ((m.window.title === TEST || m.window.title === UPLOAD) && arrivals.length < 20_000) {
      arrivals.push({ windowId: m.window.windowId, readerAt: m.at, recvAt: Date.now(), reason: m.reason, partial: m.root !== null });
    }
    snapshots.all++;
    if (m.reason === "watch") snapshots.watch++;
  }
  return handleReader(m);
};
server = new HelperServer(a.socket, () => helper, (l) => log.push(l));
await server.listen();
const tick = setInterval(() => helper.tick(), 250);

// MARK: - fixture and reader: the only processes this script may signal

const fixture: ChildProcessWithoutNullStreams = spawn(join(a.bin, "caret-fixture"), [
  "--windows", "jobs,reference,distractors,claim,schedule,roster,executor", "--duration", "1500", "--background-only",
]);
let reader: ChildProcessWithoutNullStreams | null = null;
const readerPids: number[] = [];
process.on("exit", () => {
  reader?.kill("SIGTERM");
  fixture.kill("SIGTERM");
});
let fixturePid = 0;
let fixtureErr = "";
let foreground: Front | null = null;
const ours = (pid: number): boolean => pid > 0 && (pid === fixture.pid || pid === fixturePid || readerPids.includes(pid));
let polling = false;
const frontPoll = setInterval(() => {
  if (polling) return;
  polling = true;
  void frontAsync()
    .then((f) => {
      if (f.pid !== fronts[fronts.length - 1]?.pid) fronts.push(f);
      if (foreground === null && ours(f.pid)) {
        foreground = f;
        reader?.kill("SIGTERM");
        fixture.kill("SIGTERM");
      }
    })
    .finally(() => (polling = false));
}, 100);

const replies: ((o: Record<string, unknown>) => void)[] = [];
let buf = "";
fixture.stderr.setEncoding("utf8");
fixture.stderr.on("data", (d: string) => (fixtureErr += d));
fixture.stdout.setEncoding("utf8");
fixture.stdout.on("data", (d: string) => {
  buf += d;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    const m = /^caret-fixture pid (\d+)/.exec(line);
    if (m?.[1] !== undefined) fixturePid = Number(m[1]);
    else if (line.startsWith("{")) replies.shift()?.(JSON.parse(line) as Record<string, unknown>);
  }
});
const fx = async (cmd: string): Promise<Record<string, unknown>> => {
  if (foreground !== null) throw new Error("deferred: foreground");
  const r = await new Promise<Record<string, unknown>>((res) => {
    replies.push(res);
    fixture.stdin.write(cmd + "\n");
  });
  if (r.ok !== true) throw new Error(`fixture ${cmd}: ${JSON.stringify(r)}`);
  return r;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (foreground !== null) throw new Error("deferred: foreground");
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const win = (title: string) => [...helper.model.windows.values()].find((w) => w.window.title === title);
const activities = (): Activity[] => sent.filter((m): m is Activity => m.type === "activity");
const watchRecords = () => activities().filter((m) => m.task.kind === "watch");

function startReader(eventDriven: boolean): ChildProcessWithoutNullStreams {
  const args = ["--socket", a.socket, "--only-pids", String(fixturePid)];
  if (eventDriven) args.push("--event-pids", String(fixturePid));
  const r = spawn(join(a.bin!, "caret-screen"), args);
  readerPids.push(r.pid ?? -1);
  r.stderr.setEncoding("utf8");
  r.stderr.on("data", (d: string) => {
    for (const line of d.split("\n")) if (line.trim() !== "") log.push(`${Date.now()} reader: ${line.trim()}`);
  });
  return r;
}

async function stopAllWatches(): Promise<void> {
  for (const r of helper.tasks.list()) {
    if (r.kind === "watch" && helper.pending.has(r.id)) await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: r.id, action: "stop" });
  }
}

/** The user moves into a window, then into the notes window: the first window is left. */
async function visitThenLeave(name: string): Promise<void> {
  await fx(`focus ${name}`);
  await sleep(350);
  await fx("focus notes");
  await sleep(350);
}

function cpuSeconds(pid: number): number {
  const t = execFileSync("ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const parts = t.split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

interface Judged {
  expected: TaskState;
  got: TaskState | null;
  latencyMs: number | null;
  jevMs: number | null;
  confidence: unknown;
  /** Milliseconds after the change: each snapshot of the window (reader time), the question that decided, and its answer. */
  timeline: { snapshots: string[]; askStart: number | null; answered: number | null } | null;
}

interface RunResult {
  run: number;
  watchedTest: boolean;
  watchedUpload: boolean;
  askedWhileTicking: number;
  test: Judged;
  upload: Judged;
  error?: string;
}

const result: Record<string, unknown> = { frontBefore, runs: RUNS };
const runs: RunResult[] = [];
let ok = false;
try {
  await until("the fixture", () => fixturePid > 0);
  await sleep(800);
  reader = startReader(true);
  await until("the job windows", () => win(TEST) !== undefined && win(UPLOAD) !== undefined && win("Caret Fixture — Notes") !== undefined, 15_000);
  result.fixturePid = fixturePid;

  // 1. False watches on the ordinary windows. The fixture starts with the test run focused, so the
  // first visit leaves it and watches it, correctly; only watches on the ordinary windows count here.
  const before = { ...helper.pending.stats };
  const seqBefore = helper.tasks.latestSeq;
  for (let round = 0; round < 2; round++) for (const name of ORDINARY) await visitThenLeave(name);
  await sleep(500);
  const registeredOn = watchRecords().filter((m) => m.seq > seqBefore && m.from === null).map((m) => m.task.windowTitle);
  result.falseWatches = {
    windowsLeft: ORDINARY.length * 2,
    checked: helper.pending.stats.checked - before.checked,
    noMarkers: helper.pending.stats.noMarkers - before.noMarkers,
    watchesOnJobWindows: registeredOn.filter((t) => t === TEST || t === UPLOAD).length,
    falseWatches: registeredOn.filter((t) => t !== TEST && t !== UPLOAD),
  };

  // 2. Ten runs with live Jev.
  for (let i = 0; i < RUNS; i++) {
    const r: RunResult = {
      run: i + 1,
      watchedTest: false,
      watchedUpload: false,
      askedWhileTicking: 0,
      test: { expected: "done", got: null, latencyMs: null, jevMs: null, confidence: null, timeline: null },
      upload: { expected: "needsYou", got: null, latencyMs: null, jevMs: null, confidence: null, timeline: null },
    };
    runs.push(r);
    try {
      // Both jobs start again. A watch that ended as done is registered anew when the user leaves the
      // window; the upload's watch, left waiting on the user last run, sees its text change back and
      // is asked about again, so it is running before this run's question appears.
      await fx("jobs reset");
      const testId = win(TEST)!.window.windowId;
      const uploadId = win(UPLOAD)!.window.windowId;
      await sleep(700);
      await helper.pending.whenIdle();
      await visitThenLeave("test");
      const wt = await until(`a watch on ${testId}`, () => helper.pending.watchOf(testId), 5000);
      r.watchedTest = true;
      await visitThenLeave("upload");
      const wu = await until(`a watch on ${uploadId}`, () => helper.pending.watchOf(uploadId), 5000);
      r.watchedUpload = true;
      await until("the upload watch running", () => helper.tasks.get(wu)?.state === "running", 8000);
      // The test run keeps counting; none of that may cost a question.
      const asks0 = helper.pending.stats.asks + helper.pending.stats.errors;
      await sleep(1500);
      r.askedWhileTicking = helper.pending.stats.asks + helper.pending.stats.errors - asks0;

      const judge = async (cmd: string, id: string, slot: RunResult["test"]): Promise<void> => {
        const change = Number((await fx(cmd)).at);
        log.push(`${change} eval: ${cmd} changed the fixture`);
        const seq = helper.tasks.latestSeq;
        const settled = await until(`the answer for ${cmd}`, () => activities().find((m) => m.seq > seq && m.task.id === id && m.task.state !== "running"), 10_000).catch(() => null);
        if (settled === null) return;
        slot.got = settled.task.state;
        slot.latencyMs = settled.at - change;
        const ask = helper.pending.asks.filter((q) => q.watchId === id).at(-1);
        slot.jevMs = ask?.latencyMs ?? null;
        const windowId = settled.task.windowId;
        slot.timeline = {
          snapshots: arrivals.filter((x) => x.windowId === windowId && x.recvAt >= change && x.recvAt <= settled.at).map((x) => `${x.reason}${x.partial ? "/part" : ""}@${x.readerAt - change}`),
          askStart: ask === undefined ? null : ask.at - change,
          answered: settled.at - change,
        };
        slot.confidence = { finished: settled.task.pending?.finished, waiting: settled.task.pending?.waiting };
      };
      await judge(`jobs finish ${i}`, wt, r.test);
      await judge(`jobs ask ${i}`, wu, r.upload);
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      if (foreground !== null) throw e;
    }

  }

  // 3. Idle CPU with and without a watch, with a reader that is not event-driven for the fixture.
  await stopAllWatches();
  reader.kill("SIGTERM");
  await sleep(500);
  await fx("jobs reset");
  await fx("jobs finish 0"); // the test run stops counting; the upload keeps its spinner and its text
  const hellos0 = hellos;
  reader = startReader(false);
  await until("the new reader", () => hellos > hellos0, 10_000);
  await until("the upload window", () => win(UPLOAD), 15_000);
  await sleep(2000);
  const measure = async (): Promise<{ readerPct: number; helperPct: number; snapshots: number; watchWalksSent: number; seconds: number }> => {
    const pid = reader!.pid!;
    const r0 = cpuSeconds(pid);
    const h0 = process.cpuUsage();
    const t0 = Date.now();
    const s0 = { ...snapshots };
    await sleep(CPU_S * 1000);
    const secs = (Date.now() - t0) / 1000;
    const h = process.cpuUsage(h0);
    return {
      readerPct: ((cpuSeconds(pid) - r0) / secs) * 100,
      helperPct: ((h.user + h.system) / 1e6 / secs) * 100,
      snapshots: snapshots.all - s0.all,
      watchWalksSent: snapshots.watch - s0.watch,
      seconds: secs,
    };
  };
  const noWatch = await measure();
  const uploadId = win(UPLOAD)!.window.windowId;
  const watchId = helper.pending.left(uploadId);
  if (watchId === null) throw new Error("the idle upload window got no watch");
  await sleep(1000);
  const withWatch = await measure();
  await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: watchId, action: "stop" });
  result.idleCpu = { noWatch, withWatch, note: "reader without --event-pids, so the watch alone registers the fixture's observer; helper CPU includes this script's own polling" };

  ok = true;
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e);
} finally {
  clearInterval(tick);
  clearInterval(frontPoll);
  fronts.push(front());
  reader?.kill("SIGTERM");
  fixture.kill("SIGTERM");
  await server.close();
  helper.memory.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}

// MARK: - summary

const lat = runs.flatMap((r) => [r.test.latencyMs, r.upload.latencyMs]).filter((x): x is number => x !== null).sort((x, y) => x - y);
const q = (p: number): number | null => (lat.length === 0 ? null : (lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? null));
const judgments = runs.flatMap((r) => [r.test, r.upload]);
const right = judgments.filter((j) => j.got === j.expected).length;
const within2s = judgments.filter((j) => j.got === j.expected && j.latencyMs !== null && j.latencyMs <= 2000).length;
const jevMs = runs.flatMap((r) => [r.test.jevMs, r.upload.jevMs]).filter((x): x is number => x !== null);
result.summary = {
  judgments: judgments.length,
  right,
  rightWithin2s: within2s,
  latencyMs: { min: lat[0] ?? null, p50: q(0.5), p90: q(0.9), max: lat.at(-1) ?? null },
  jevLatencyMs: { mean: jevMs.length === 0 ? null : Math.round(jevMs.reduce((s, x) => s + x, 0) / jevMs.length), max: jevMs.length === 0 ? null : Math.max(...jevMs) },
  questions: helper.pending.stats.asks,
  stale: helper.pending.stats.stale,
  errors: helper.pending.stats.errors,
  askedWhileTicking: runs.reduce((s, r) => s + r.askedWhileTicking, 0),
};
result.runResults = runs;
result.pendingStats = helper.pending.stats;
result.asks = helper.pending.asks;
result.frontAfter = fronts[fronts.length - 1];
result.frontChanges = fronts.slice(1).map((f) => ({ at: f.at, pid: f.pid, name: f.name }));
result.fixtureOrReaderWasFront = foreground !== null;
result.deferred = foreground === null ? null : `deferred: foreground (${JSON.stringify(foreground)})`;
result.fixtureStderr = fixtureErr.split("\n").filter((l) => l.length > 0).slice(-5);
result.helperLog = log.slice(-30);
result.ok = ok && foreground === null;
writeFileSync(join(OUT, "pending-fixture.json"), JSON.stringify(result, null, 2));
// Reader and helper log lines: timings, counts and window titles of the synthetic fixture only.
writeFileSync(join(OUT, "log.txt"), log.join("\n") + "\n");
console.log(JSON.stringify({ ok: result.ok, error: result.error ?? null, falseWatches: result.falseWatches, summary: result.summary, idleCpu: result.idleCpu, frontChanges: result.frontChanges }, null, 1));
process.exit(result.ok ? 0 : 1);
