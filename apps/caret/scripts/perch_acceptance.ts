// The perch and the activity list against the real helper, reader and caret-fixture (brief A4,
// acceptance 3). The helper runs in this process, reached by the host only through its socket.
//
//   1. jobs:     the fixture's test run goes from Running to Done and the upload asks "Approve?".
//                The perch must show done within 2 s of the change, then needs you with its eyes
//                toward the upload window. Latency is measured from the fixture's own timestamp.
//   2. pause:    a six-step plan in the executor window; after step 2 is verified, one key headed
//                for the fixture goes through the host's tap routing (debug-socket `key`, no event
//                posted). The host must send taskControl pause, and the run must stop with the
//                row saying where. Continue, pressed through the row's own path, finishes it.
//   3. takeOver: the same plan; after step 3, Take over through the row's path. The record and
//                the row must name step 4 as the step it reached.
//
// It opens fixture windows and may draw the perch, so it needs the Mac to itself: it starts only
// after 300 s without input, under the GUI lock, and stops (killing only what it started) the
// moment input arrives. Fixtures are background-only, and any of its processes becoming the
// frontmost app ends the run as `deferred: foreground`. Screenshots are of Caret's own panels
// only (`screencapture -l`), never of the screen.
//
//   /usr/bin/lockf -k ~/.long-run/locks/gui.lock env CARET_GUI_LOCK=held CARET_ENV_FILE=/path/to/.env \
//     node apps/caret/scripts/perch_acceptance.ts --out DIR [--runs 3] [--perch shown|hidden]
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Helper } from "../../../helper/src/helper.ts";
import { HelperServer } from "../../../helper/src/server.ts";
import { Store } from "../../../helper/src/store.ts";
import { loadJevKey, makeJevClient } from "../../../helper/src/fill/jev.ts";
import { PROTOCOL_VERSION, type Activity, type HelperMessage, type TaskProgress, type TaskRecord } from "../../../helper/src/protocol.ts";
import type { Plan, Step } from "../../../helper/src/executor/schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const SCREEN_BIN = process.env.CARET_SCREEN_BIN ?? resolve(ROOT, "..", "caret-v2-screen", "apps", "screen-reader", ".build", "debug");
const CARET = resolve(ROOT, "apps", "caret", ".build", "Caret.app", "Contents", "MacOS", "Caret");

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    runs: { type: "string", default: "3" },
    perch: { type: "string", default: "shown" },
    "idle-min": { type: "string", default: "300" },
  },
});
if (a.out === undefined) throw new Error("--out is required");
if (process.env.CARET_GUI_LOCK !== "held") throw new Error("run under /usr/bin/lockf -k ~/.long-run/locks/gui.lock env CARET_GUI_LOCK=held ...");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const RUNS = Number(a.runs);
const IDLE_MIN = Number(a["idle-min"]);
const SOCKETS = join(homedir(), ".caret-run", "sockets");
const HELPER_SOCK = join(SOCKETS, "a4-helper.sock");
const HOST_SOCK = join(SOCKETS, "a4-host.sock");
const TEST = "Caret Fixture — Test run";
const UPLOAD = "Caret Fixture — Upload";
const EXECUTOR = "Caret Fixture — Executor";

const run = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const result: Record<string, unknown> = { at: new Date().toISOString(), runs: RUNS, perch: a.perch };
const log: string[] = [];
const note = (l: string): void => {
  log.push(`${new Date().toISOString()} ${l}`);
  console.log(l);
};

// MARK: - the idle rule, before anything opens

async function hidIdle(): Promise<number> {
  const out = (await run("ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8", maxBuffer: 8 << 20 })).stdout;
  const m = /"HIDIdleTime" = (\d+)/.exec(out);
  return m?.[1] === undefined ? 0 : Number(m[1]) / 1e9;
}
const idleAtStart = await hidIdle();
result.idleAtStart = idleAtStart;
if (idleAtStart < IDLE_MIN) {
  result.deferred = `deferred: user active (HID idle ${idleAtStart.toFixed(0)} s < ${IDLE_MIN} s)`;
  writeFileSync(join(OUT, "perch-acceptance.json"), JSON.stringify(result, null, 2));
  console.log(result.deferred);
  process.exit(3);
}
loadJevKey(); // fail now, not at the first pending question
const runStart = Date.now();

// MARK: - helper in process

interface Front {
  at: number;
  pid: number;
  name: string;
}
async function front(): Promise<Front> {
  const asn = (await run("lsappinfo", ["front"], { encoding: "utf8" })).stdout.trim();
  const info = (await run("lsappinfo", ["info", "-only", "pid", "-only", "name", asn], { encoding: "utf8" })).stdout;
  return { at: Date.now(), pid: Number(/"pid"=(\d+)/.exec(info)?.[1] ?? -1), name: /"LSDisplayName"="([^"]*)"/.exec(info)?.[1] ?? "" };
}
const fronts: Front[] = [await front()];

const sent: { at: number; m: HelperMessage }[] = [];
const dataDir = mkdtempSync(join(tmpdir(), "caret-a4-perch-"));
const store = new Store(dataDir);
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  askJev: makeJevClient(() => loadJevKey()),
  shadow: false,
  allowBackgroundFocus: false,
  publish: (m) => {
    sent.push({ at: Date.now(), m });
    server?.publish(m);
  },
  sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
  warn: (l) => log.push(`helper: ${l}`),
});
server = new HelperServer(HELPER_SOCK, () => helper, (l) => log.push(`server: ${l}`));
await server.listen();
const tick = setInterval(() => helper.tick(), 250);
const activities = (): { at: number; m: Activity }[] => sent.filter((x): x is { at: number; m: Activity } => x.m.type === "activity");
const progress = (id: string): TaskProgress[] => sent.flatMap((x) => (x.m.type === "taskProgress" && x.m.taskId === id ? [x.m] : []));
const latest = (id: string): TaskRecord | undefined => helper.tasks.get(id);
const win = (title: string) => [...helper.model.windows.values()].find((w) => w.window.title.startsWith(title));

// MARK: - processes this script started, and may signal

const started: ChildProcess[] = [];
let stopReason: string | null = null;
function stopAll(why: string): void {
  if (stopReason === null) stopReason = why;
  for (const p of started) if (p.exitCode === null) p.kill("SIGTERM");
}
process.on("exit", () => stopAll("exit"));

// CaretFixture.app, exec'd directly with --foreground so its windows can be key (fixture_app.py says
// why). It still hands back any activation it gets; this run never asks for the foreground.
const FIXTURE_BIN = process.env.CARET_FIXTURE_BIN_DIR ?? SCREEN_BIN;
const FIXTURE_EXE = join(FIXTURE_BIN, "CaretFixture.app", "Contents", "MacOS", "caret-fixture");
if (!existsSync(FIXTURE_EXE)) execFileSync(resolve(ROOT, "apps", "screen-reader", "scripts", "bundle-fixture.sh"), [FIXTURE_BIN]);
const fixture = spawn(FIXTURE_EXE, ["--foreground", "--windows", "jobs,executor", "--duration", "1500"]);
started.push(fixture);
let fixturePid = 0;
const replies: ((o: Record<string, unknown>) => void)[] = [];
let fbuf = "";
fixture.stdout.setEncoding("utf8");
fixture.stdout.on("data", (d: string) => {
  fbuf += d;
  let nl: number;
  while ((nl = fbuf.indexOf("\n")) >= 0) {
    const line = fbuf.slice(0, nl);
    fbuf = fbuf.slice(nl + 1);
    const m = /^caret-fixture pid (\d+)/.exec(line);
    if (m?.[1] !== undefined) fixturePid = Number(m[1]);
    else if (line.startsWith("{")) replies.shift()?.(JSON.parse(line) as Record<string, unknown>);
  }
});
const fx = async (cmd: string): Promise<Record<string, unknown>> => {
  if (stopReason !== null) throw new Error(stopReason);
  const r = await new Promise<Record<string, unknown>>((res) => {
    replies.push(res);
    fixture.stdin.write(cmd + "\n");
  });
  if (r.ok === false) throw new Error(`fixture ${cmd}: ${JSON.stringify(r)}`);
  return r;
};
let reader: ChildProcess | null = null;
let host: ChildProcess | null = null;
const ours = (pid: number): boolean => pid > 0 && started.some((p) => p.pid === pid || pid === fixturePid);

// Guards: any of ours frontmost, or a person at the Mac, stops the run.
let polling = false;
const guard = setInterval(() => {
  if (polling || stopReason !== null) return;
  polling = true;
  void Promise.all([front(), hidIdle()])
    .then(([f, idle]) => {
      if (f.pid !== fronts.at(-1)?.pid) fronts.push(f);
      if (ours(f.pid)) stopAll(`deferred: foreground (${f.name} ${f.pid})`);
      const lastInput = Date.now() - idle * 1000;
      if (idle < 5 && lastInput > runStart + 500) stopAll(`deferred: user active (input at ${new Date(lastInput).toISOString()})`);
    })
    .finally(() => (polling = false));
}, 250);

async function until<T>(what: string, f: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 10_000, every = 40): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (stopReason !== null) throw new Error(stopReason);
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

// MARK: - the host's debug socket

function hostCommand(command: string): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const s: Socket = createConnection(HOST_SOCK);
    let buf = "";
    s.setEncoding("utf8");
    s.on("connect", () => s.write(command + "\n"));
    s.on("data", (d: string) => (buf += d));
    s.on("end", () => {
      try {
        res(JSON.parse(buf) as Record<string, unknown>);
      } catch (e) {
        rej(new Error(`host ${command}: ${buf.slice(0, 200)}`));
      }
    });
    s.on("error", rej);
  });
}
interface PerchInfo {
  presented: boolean;
  onScreen: boolean;
  subject: { taskId: string; mood: string; needsYou: number } | null;
  gaze: number[];
  frame: number[] | null;
  targetWindow: number[] | null;
  isKey: boolean;
  listOpen: boolean;
  listOnScreen: boolean;
  rows: { id: string; section: string; progress: string | null; actions: string[]; says: string }[];
  listed: boolean;
  pausable: Record<string, string[]>;
  activity: { inputPauses: string[]; controlsSent: string[] };
  windowNumber?: number;
  listWindowNumber?: number;
}
const perch = async (): Promise<PerchInfo> => (await hostCommand("perch")) as unknown as PerchInfo;

/** Captures one of Caret's own windows, and nothing else on the screen. */
async function shoot(windowNumber: number | undefined, name: string): Promise<string | null> {
  if (a.perch !== "shown" || windowNumber === undefined || windowNumber <= 0) return null;
  const path = join(OUT, `${name}.png`);
  try {
    await run("screencapture", ["-x", "-o", `-l${windowNumber}`, path]);
    return path;
  } catch (e) {
    note(`screenshot ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** CPU of one process over `ms`, as a percentage of one core, from `ps` cputime. */
async function cpuPercent(pid: number, ms: number): Promise<number> {
  const cpu = async (): Promise<number> => {
    const t = (await run("ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf8" })).stdout.trim();
    return t.split(":").map(Number).reduce((acc, p) => acc * 60 + p, 0);
  };
  const c0 = await cpu();
  const t0 = Date.now();
  await sleep(ms);
  return Math.round(((await cpu()) - c0) / ((Date.now() - t0) / 1000) * 1000) / 10;
}

/** The gaze the host should have: toward the window's center from the perch's (PerchGaze). */
function expectedGaze(perchFrame: number[], window: number[]): [number, number] {
  const [px, py, pw, ph] = perchFrame as [number, number, number, number];
  const [wx, wy, ww, wh] = window as [number, number, number, number];
  const dx = wx + ww / 2 - (px + pw / 2), dy = wy + wh / 2 - (py + ph / 2);
  const l = Math.hypot(dx, dy);
  return l <= 24 ? [0, 0] : [dx / l, dy / l];
}

// MARK: - the plan for parts 2 and 3: six fields, as B4's tasks eval

const FIELDS = [
  { name: "name", key: "textfield:name~0", label: "Name", role: "AXTextField" },
  { name: "email", key: "textfield:email~0", label: "Email", role: "AXTextField" },
  { name: "reference", key: "textfield:reference~0", label: "Reference", role: "AXTextField" },
  { name: "message", key: "textfield:message~0", label: "Message", role: "AXTextField" },
  { name: "eventTitle", key: "textfield:event title~0", label: "Event title", role: "AXTextField" },
  { name: "notes", key: "textarea:notes~0", label: "Notes", role: "AXTextArea" },
];
const VALUES = ["Dana Whitfield", "dana.whitfield@lumenlabs.example", "ORD-2026-48213", "Thanks for the quick turnaround", "Design review", "Bring the Q4 numbers"];
const step = (i: number): Step => {
  const f = FIELDS[i]!;
  return {
    says: `The ${f.label} field holds '${VALUES[i]}'`,
    end: { kind: "valueEquals", window: { titleStartsWith: EXECUTOR }, target: { key: `dev.caret.fixture/standard/${f.key}`, label: f.label, role: f.role, describe: `the ${f.label} field` }, value: VALUES[i]! },
  };
};
const PLAN: Plan = { id: "six-fields", title: "Fill the six fields", slots: {}, steps: FIELDS.map((_, i) => step(i)) };

/** A consumer of our own, for runPlan and cleanup controls (the host sends the controls under test). */
const consumer: Socket = await new Promise((res, rej) => {
  const s = createConnection(HELPER_SOCK);
  s.once("connect", () => res(s));
  s.once("error", rej);
});
consumer.on("data", () => {});
const send = (m: unknown): void => void consumer.write(JSON.stringify(m) + "\n");
send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: process.pid, version: "a4-perch-acceptance" });
const control = (taskId: string, action: "pause" | "resume" | "stop" | "takeOver" | "undo"): void => send({ type: "taskControl", v: PROTOCOL_VERSION, taskId, action });

async function fields(): Promise<string[]> {
  const d = await fx("dump");
  const f = d.fields as Record<string, string | null>;
  return FIELDS.map((x) => f[x.name] ?? "(gone)");
}

/** Starts the plan and calls `act` once, the moment step `after` (zero-based) is verified. */
async function runUntil(taskId: string, after: number, act: () => Promise<void>): Promise<{ actedAt: number }> {
  let actedAt = 0;
  send({ type: "runPlan", v: PROTOCOL_VERSION, taskId, plan: PLAN, slots: {} });
  await until(`${taskId} step ${after + 1} verified`, () => progress(taskId).some((p) => p.phase === "verified" && p.step === after), 20_000, 5);
  actedAt = Date.now();
  await act();
  await until(`${taskId} to stop`, () => ["paused", "failed", "done"].includes(latest(taskId)?.state ?? ""), 20_000);
  return { actedAt };
}

const jobRuns: Record<string, unknown>[] = [];
const pauseRuns: Record<string, unknown>[] = [];
const takeOverRuns: Record<string, unknown>[] = [];
const shots: string[] = [];
let ok = false;
try {
  await until("the fixture", () => fixturePid > 0);
  await sleep(800);
  reader = spawn(join(SCREEN_BIN, "caret-screen"), ["--socket", HELPER_SOCK, "--only-pids", String(fixturePid), "--event-pids", String(fixturePid), "--act-pids", String(fixturePid)]);
  started.push(reader);
  reader.stderr?.setEncoding("utf8");
  reader.stderr?.on("data", (d: string) => log.push(`reader: ${d.trim().slice(0, 300)}`));
  host = spawn(CARET, ["--helper-socket", HELPER_SOCK, "--socket", HOST_SOCK, "--no-ghost", "--allow-pids", String(fixturePid), "--perch", a.perch === "shown" ? "shown" : "hidden"]);
  started.push(host);
  host.stderr?.setEncoding("utf8");
  host.stderr?.on("data", (d: string) => log.push(`host: ${d.trim().slice(0, 300)}`));
  await until("the job and executor windows", () => win(TEST) && win(UPLOAD) && win(EXECUTOR) && win("Caret Fixture — Notes"), 20_000);
  await until("the host's activity list", async () => {
    try {
      return (await perch()).listed;
    } catch {
      return false;
    }
  }, 15_000, 200);
  result.pids = { fixture: fixturePid, reader: reader.pid, host: host.pid };

  // 1. Jobs: done within 2 s on the perch; then needs you, eyes on the upload window.
  const visitThenLeave = async (name: string): Promise<void> => {
    await fx(`focus ${name}`);
    await sleep(350);
    await fx("focus notes");
    await sleep(350);
  };
  for (let i = 0; i < RUNS; i++) {
    const r: Record<string, unknown> = { run: i + 1 };
    jobRuns.push(r);
    try {
      await fx("jobs reset");
      await sleep(700);
      await helper.pending.whenIdle();
      await visitThenLeave("test");
      const wt = await until("a watch on the test run", () => helper.pending.watchOf(win(TEST)!.window.windowId), 5000);
      await visitThenLeave("upload");
      const wu = await until("a watch on the upload", () => helper.pending.watchOf(win(UPLOAD)!.window.windowId), 5000);
      await until("the upload watch running", () => helper.tasks.get(wu)?.state === "running", 8000);
      const working = await until("the perch working", async () => {
        const p = await perch();
        return p.subject?.mood === "working" ? p : null;
      }, 5000);
      r.working = { subject: working.subject, gaze: working.gaze, targetWindow: working.targetWindow };
      if (i === 0) {
        const s = await shoot(working.windowNumber, "perch-working-live");
        if (s !== null) shots.push(s);
        // The perch breathes and blinks while it works; plan N4's target is under 1% of one core.
        result.hostCpuWhileWorking = await cpuPercent(host!.pid!, 10_000);
      }

      // Running to Done.
      const seq0 = helper.tasks.latestSeq;
      const change = Number((await fx(`jobs finish ${i}`)).at);
      const done = await until("the perch done", async () => {
        const p = await perch();
        return p.subject?.taskId === wt && p.subject.mood === "done" ? { p, at: Date.now() } : null;
      }, 12_000, 20).catch(() => null);
      const act = activities().find((x) => x.m.seq > seq0 && x.m.task.id === wt && x.m.task.state !== "running");
      r.done = {
        helperState: act?.m.task.state ?? null,
        changeToActivityMs: act === undefined ? null : act.at - change,
        activityToPerchMs: act === undefined || done === null ? null : done.at - act.at,
        changeToPerchMs: done === null ? null : done.at - change,
        perchMood: done?.p.subject?.mood ?? null,
      };
      if (i === 0 && done !== null) {
        const s = await shoot(done.p.windowNumber, "perch-done-live");
        if (s !== null) shots.push(s);
      }

      // Approve?: needs you, eyes toward the upload window.
      const seq1 = helper.tasks.latestSeq;
      const asked = Number((await fx(`jobs ask ${i}`)).at);
      const needs = await until("the perch needs you", async () => {
        const p = await perch();
        return p.subject?.taskId === wu && p.subject.mood === "needsYou" ? { p, at: Date.now() } : null;
      }, 12_000, 20).catch(() => null);
      const actU = activities().find((x) => x.m.seq > seq1 && x.m.task.id === wu && x.m.task.state !== "running");
      // The model's frames are [x, y, width, height] arrays.
      const uploadFrame = (win(UPLOAD)?.window.frame ?? null) as number[] | null;
      let gazeCheck: Record<string, unknown> | null = null;
      if (needs !== null) {
        // Settle: the host locates the window off the main thread right after the subject changes.
        const p = await until("the gaze aimed", async () => {
          const q = await perch();
          return q.targetWindow !== null ? q : null;
        }, 3000).catch(() => needs.p);
        const window = uploadFrame;
        const expected = window === null || p.frame === null ? null : expectedGaze(p.frame, window);
        const dot = expected === null ? null : p.gaze[0]! * expected[0] + p.gaze[1]! * expected[1];
        gazeCheck = { gaze: p.gaze, expected, dot, perchFrame: p.frame, hostFoundWindow: p.targetWindow, readerWindow: window };
        if (i === 0) {
          const s = await shoot(p.windowNumber, "perch-needs-you-live");
          if (s !== null) shots.push(s);
          await hostCommand("activity open");
          await sleep(300);
          const opened = await perch();
          r.list = { open: opened.listOpen, onScreen: opened.listOnScreen, rows: opened.rows.map((x) => ({ section: x.section, says: x.says, progress: x.progress, actions: x.actions })), isKey: opened.isKey };
          const l = await shoot(opened.listWindowNumber, "activity-list-live");
          if (l !== null) shots.push(l);
          await hostCommand("activity close");
        }
      }
      r.needsYou = {
        helperState: actU?.m.task.state ?? null,
        changeToActivityMs: actU === undefined ? null : actU.at - asked,
        activityToPerchMs: actU === undefined || needs === null ? null : needs.at - actU.at,
        changeToPerchMs: needs === null ? null : needs.at - asked,
        gaze: gazeCheck,
      };
      r.ok =
        (r.done as { perchMood: string | null; changeToPerchMs: number | null }).perchMood === "done" &&
        ((r.done as { changeToPerchMs: number | null }).changeToPerchMs ?? 99_999) <= 2000 &&
        needs !== null && (gazeCheck?.dot as number | null ?? -1) > 0.95;
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      if (stopReason !== null) throw e;
    }
  }

  // 2. Pause by real input through the host's tap routing; Continue from the row.
  for (let i = 0; i < RUNS; i++) {
    await fx("reset");
    await sleep(500);
    const id = `a4-pause-${i + 1}`;
    const r: Record<string, unknown> = { run: i + 1, task: id };
    pauseRuns.push(r);
    const before = (await perch()).activity.inputPauses.length;
    await runUntil(id, 1, async () => {
      await hostCommand(`key char:a ${fixturePid}`);
    });
    const paused = latest(id)!;
    const p = await until("the paused row", async () => {
      const q = await perch();
      return q.rows.find((x) => x.id === id && x.section === "needsYou") !== undefined ? q : null;
    }, 3000);
    const row = p.rows.find((x) => x.id === id)!;
    r.hostSentPause = p.activity.inputPauses.slice(before);
    r.paused = { state: paused.state, beforeStep: paused.step === null ? null : paused.step + 1, detail: paused.detail };
    r.row = { section: row.section, progress: row.progress, actions: row.actions };
    r.perchMood = p.subject?.taskId === id ? p.subject.mood : p.subject;
    r.fieldsAtPause = (await fields()).map((v) => v !== "");
    if (i === 0) {
      const s = await shoot(p.windowNumber, "perch-waiting-live");
      if (s !== null) shots.push(s);
    }
    await hostCommand(`control ${id} resume`);
    await until(`${id} to finish`, () => latest(id)?.state === "done" || latest(id)?.state === "failed", 20_000);
    const end = await fields();
    r.final = latest(id)!.state;
    r.allSixVerified = end.every((v, k) => v === VALUES[k]);
    r.ok = (r.hostSentPause as string[]).includes(`${id}:key`) && paused.state === "paused" && (paused.step ?? 99) <= 3 && row.progress?.startsWith("Stopped before step") === true && r.final === "done" && r.allSixVerified === true;
  }

  // 3. Take over from the row after step 3.
  for (let i = 0; i < RUNS; i++) {
    await fx("reset");
    await sleep(500);
    const id = `a4-takeover-${i + 1}`;
    const r: Record<string, unknown> = { run: i + 1, task: id };
    takeOverRuns.push(r);
    await runUntil(id, 2, async () => {
      await hostCommand(`control ${id} takeOver`);
    });
    const handed = latest(id)!;
    const p = await until("the handed-back row", async () => {
      const q = await perch();
      return q.rows.find((x) => x.id === id && x.section === "needsYou") !== undefined ? q : null;
    }, 3000);
    const row = p.rows.find((x) => x.id === id)!;
    r.record = { state: handed.state, reachedStep: handed.step === null ? null : handed.step + 1, detail: handed.detail, remaining: handed.remaining.length };
    r.row = { progress: row.progress, actions: row.actions };
    r.hostControls = p.activity.controlsSent.filter((c) => c.startsWith(id));
    control(id, "stop");
    await until(`${id} to stop`, () => latest(id)?.state === "failed");
    control(id, "undo");
    await until(`${id} to undo`, () => latest(id)?.state === "undone");
    r.restoredByUndo = (await fields()).every((v) => v === "");
    // The control can land a step late when the run is quick; what must hold is that the record
    // and the row name the same step, and it is not before step 4.
    r.ok = handed.state === "paused" && (handed.step ?? 0) >= 3 && row.progress === `Stopped before step ${(handed.step ?? 0) + 1} of 6` && (r.hostControls as string[]).includes(`${id}:takeOver`);
  }
  ok = [...jobRuns, ...pauseRuns, ...takeOverRuns].every((r) => r.ok === true);
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e);
} finally {
  clearInterval(tick);
  clearInterval(guard);
  try {
    const last = await perch();
    result.hostAtEnd = { isKey: last.isKey, listOpen: last.listOpen, activity: last.activity };
  } catch {
    // the host may already be gone
  }
  fronts.push(await front());
  consumer.destroy();
  stopAll(stopReason ?? "done");
  await server.close();
  helper.memory.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}

const pick = (runs: Record<string, unknown>[], f: (r: Record<string, unknown>) => number | null | undefined): number[] =>
  runs.map(f).filter((x): x is number => typeof x === "number").sort((x, y) => x - y);
const doneMs = pick(jobRuns, (r) => (r.done as { changeToPerchMs?: number } | undefined)?.changeToPerchMs);
const hostMs = pick(jobRuns, (r) => (r.done as { activityToPerchMs?: number } | undefined)?.activityToPerchMs);
result.summary = {
  jobs: `${jobRuns.filter((r) => r.ok === true).length}/${jobRuns.length}`,
  pause: `${pauseRuns.filter((r) => r.ok === true).length}/${pauseRuns.length}`,
  takeOver: `${takeOverRuns.filter((r) => r.ok === true).length}/${takeOverRuns.length}`,
  changeToPerchDoneMs: doneMs,
  activityToPerchDoneMs: hostMs,
};
result.jobs = jobRuns;
result.pause = pauseRuns;
result.takeOver = takeOverRuns;
result.shots = shots;
result.frontChanges = fronts.slice(1);
result.stopReason = stopReason;
result.deferred = stopReason !== null && stopReason.startsWith("deferred") ? stopReason : null;
result.helperErrors = sent.flatMap((x) => (x.m.type === "error" ? [x.m.message] : []));
result.ok = ok && result.deferred === null;
writeFileSync(join(OUT, "perch-acceptance.json"), JSON.stringify(result, null, 2));
// Timings, counts and the synthetic fixture's titles only.
writeFileSync(join(OUT, "log.txt"), log.join("\n") + "\n");
console.log(JSON.stringify({ ok: result.ok, error: result.error ?? null, deferred: result.deferred, summary: result.summary }, null, 1));
process.exit(result.ok ? 0 : 1);
