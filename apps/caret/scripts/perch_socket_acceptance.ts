// The perch and the activity list against the real helper, with nothing on screen (brief A4,
// acceptance 3, socket-only variant for when someone is using the Mac).
//
// The helper runs in this process with its real task registry, executor and socket server. The
// reader is the helper's own test stand-in (`helper/test/fake-app.ts`): one synthetic window that
// answers write verbs the way caret-screen does. The host runs with `--perch hidden`, so it
// computes the perch and the list and reports them on its debug socket but never draws, and with
// ghost text off and offers limited to a pid that does not exist, so it takes no key from anyone.
// It has a temporary home (its settings stay out of the user's) and no menu bar item.
// No fixture, no window, no screenshot, no event posted.
//
//   1. watch records Running -> Done and Running -> needs you, driven through the real registry:
//      the time from the helper's activity message to the host's perch state.
//   2. a six-step plan; after step 2 is verified, one key headed for the app goes through the
//      host's tap routing (debug-socket `key`); the host must send taskControl pause, and the row
//      must say where the run stopped. Continue from the row's own path finishes it.
//   3. the same plan; Take over from the row after step 3 reports step 4.
//   4. a click attributed to the app pauses a run the same way (`click`).
//   5. the rim and the task-window perch (v3), H3's side of it: the fake reader's window belongs to a
//      pid that does not exist, so the host finds no window on screen for the task. No rim, no perch
//      and no caption go up; the menu bar glyph is lit instead and goes out when the task ends.
//      `perch-avoid`, the old corner perch's command, is refused with its reason. The drawn side (a
//      clear window gets the rim, perch and caption) needs a real window on screen: PerchTests'
//      Rim.seen cases and the rim-* renders cover it.
//
//   node apps/caret/scripts/perch_socket_acceptance.ts --out DIR [--runs 5]
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Helper } from "../../../helper/src/helper.ts";
import { HelperServer } from "../../../helper/src/server.ts";
import { Store } from "../../../helper/src/store.ts";
import { PROTOCOL_VERSION, type Activity, type HelperMessage, type Node, type TaskProgress, type TaskRecord } from "../../../helper/src/protocol.ts";
import type { Plan, Step } from "../../../helper/src/executor/schema.ts";
import { FakeApp, K, TITLE } from "../../../helper/test/fake-app.ts";
import { FIXTURE_APP } from "../../../helper/test/builders.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const CARET = resolve(ROOT, "apps", "caret", ".build", "Caret.app", "Contents", "MacOS", "Caret");
const { values: a } = parseArgs({ options: { out: { type: "string" }, runs: { type: "string", default: "5" } } });
if (a.out === undefined) throw new Error("--out is required");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const RUNS = Number(a.runs);
const SOCKETS = join(homedir(), ".caret-run", "sockets");
const HELPER_SOCK = join(SOCKETS, "a4-socket-helper.sock");
const HOST_SOCK = join(SOCKETS, "a4-socket-host.sock");
const run = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];
const result: Record<string, unknown> = { at: new Date().toISOString(), runs: RUNS, mode: "socket only: real helper, fake reader, host --perch hidden" };

// MARK: - helper in process, with the fake reader

const FIELDS = ["Name", "Email", "Reference", "Message", "Event title", "Notes"];
const VALUES = ["Dana Whitfield", "dana.whitfield@lumenlabs.example", "ORD-2026-48213", "Thanks for the quick turnaround", "Design review", "Bring the Q4 numbers"];
const key = (label: string): string => K(`textfield:${label.toLowerCase()}~0`);
const nodes = (): Node[] => FIELDS.map((label, i) => ({ key: key(label), parent: null, role: "AXTextField", label, editable: true, frame: [100, 40 + 40 * i, 240, 24] }));
const app = new FakeApp(nodes());
// Each verb takes 150 ms, about what caret-screen takes on a small window, so a control sent the
// moment a step is verified arrives while the run is still going.
const perform = app.run.bind(app);
app.run = async (v) => {
  await sleep(150);
  return perform(v);
};
const sent: { at: number; m: HelperMessage }[] = [];
const dataDir = mkdtempSync(join(tmpdir(), "caret-a4-socket-"));
const store = new Store(dataDir);
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  askJev: null,
  shadow: false,
  allowBackgroundFocus: false,
  readerLink: app,
  publish: (m) => {
    sent.push({ at: Date.now(), m });
    server?.publish(m);
  },
  warn: (l) => log.push(`helper: ${l}`),
});
app.helper = helper;
app.show();
server = new HelperServer(HELPER_SOCK, () => helper, (l) => log.push(`server: ${l}`));
await server.listen();
const tick = setInterval(() => helper.tick(), 250);
const progress = (id: string): TaskProgress[] => sent.flatMap((x) => (x.m.type === "taskProgress" && x.m.taskId === id ? [x.m] : []));
const activityAt = (id: string, state: string, after: number): number | null =>
  sent.find((x): x is { at: number; m: Activity } => x.m.type === "activity" && x.m.task.id === id && x.m.task.state === state && x.at >= after)?.at ?? null;
const latest = (id: string): TaskRecord | undefined => helper.tasks.get(id);

const step = (i: number): Step => ({
  says: `The ${FIELDS[i]} field holds '${VALUES[i]}'`,
  end: { kind: "valueEquals", window: { titleStartsWith: TITLE }, target: { key: key(FIELDS[i]!), label: FIELDS[i]!, role: "AXTextField", describe: `the ${FIELDS[i]} field` }, value: VALUES[i]! },
});
const PLAN: Plan = { id: "six-fields", title: "Fill the six fields", slots: {}, steps: FIELDS.map((_, i) => step(i)) };

// MARK: - the host, hidden

// --test-hooks: `key`, `control` and `click` on the debug socket need it (CodeRabbit on PR #9).
const hostHome = mkdtempSync(join(tmpdir(), "caret-a4-home-"));
const host: ChildProcess = spawn(CARET, [
  "--home", hostHome, "--helper-socket", HELPER_SOCK, "--socket", HOST_SOCK, "--test-hooks", "--no-ghost",
  "--allow-pids", String(FIXTURE_APP.pid), "--perch", "hidden", "--status-item", "off",
]);
host.stderr?.setEncoding("utf8");
host.stderr?.on("data", (d: string) => log.push(`host: ${d.trim().slice(0, 300)}`));
process.on("exit", () => host.kill("SIGTERM"));

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
      } catch {
        rej(new Error(`host ${command}: ${buf.slice(0, 200)}`));
      }
    });
    s.on("error", rej);
  });
}
/** The host's `perch` reply. Its JSON leaves out nil keys, so every optional field may be absent. */
interface PerchInfo {
  presented: boolean;
  onScreen: boolean;
  drawsOnScreen: boolean;
  subject?: { taskId: string; mood: string; needsYou: number; pid?: number };
  figure?: string;
  /** The menu bar glyph is lit. */
  lit: boolean;
  /** H3: `clear`, `covered` or `notFound`, for the task's window. */
  seen: string;
  targetWindow?: number[];
  frame?: number[];
  rim?: number[];
  rimShown: boolean;
  caption?: string;
  isKey: boolean;
  listOpen: boolean;
  listOnScreen: boolean;
  rows: { id: string; section: string; progress: string | null; actions: string[]; says: string }[];
  listed: boolean;
  pausable: Record<string, string[]>;
  activity: { inputPauses: string[]; controlsSent: string[]; lists: number; gaps: number };
}
const perch = async (): Promise<PerchInfo> => (await hostCommand("perch")) as unknown as PerchInfo;

async function until<T>(what: string, f: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 10_000, every = 10): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

/** A consumer of our own: runPlan, and cleanup controls. The controls under test come from the host. */
const consumer: Socket = await new Promise((res, rej) => {
  const s = createConnection(HELPER_SOCK);
  s.once("connect", () => res(s));
  s.once("error", rej);
});
consumer.on("data", () => {});
const send = (m: unknown): void => void consumer.write(JSON.stringify(m) + "\n");
send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: process.pid, version: "a4-socket-acceptance" });
const control = (taskId: string, action: "pause" | "resume" | "stop" | "takeOver" | "undo"): void => send({ type: "taskControl", v: PROTOCOL_VERSION, taskId, action });

function resetFields(): void {
  app.nodes = nodes();
  app.show();
}
const values = (): string[] => FIELDS.map((f) => app.node(key(f))?.value ?? "");

/** Starts the plan and calls `act` the moment step `after` (zero-based) is verified. */
async function runUntil(taskId: string, after: number, act: () => Promise<void>): Promise<void> {
  send({ type: "runPlan", v: PROTOCOL_VERSION, taskId, plan: PLAN, slots: {} });
  await until(`${taskId} step ${after + 1} verified`, () => progress(taskId).some((p) => p.phase === "verified" && p.step === after), 20_000, 2);
  await act();
  await until(`${taskId} to stop`, () => ["paused", "failed", "done"].includes(latest(taskId)?.state ?? ""), 20_000);
}

function watchRecord(id: string, title: string): void {
  helper.tasks.create({
    id, kind: "watch", state: "running", cause: null, says: `Watching '${title}' in ${FIXTURE_APP.name}`, app: FIXTURE_APP,
    windowId: `${FIXTURE_APP.pid}-${id}`, windowTitle: title, frame: null, step: null, steps: null, stepSays: null, remaining: [], detail: null,
    undoable: false, pending: null,
  });
}

const checks: Record<string, unknown>[] = [];
const check = (name: string, ok: boolean, detail: Record<string, unknown> = {}): void => {
  checks.push({ check: name, ...detail, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail).slice(0, 240)}`);
};
const pct = (xs: number[], p: number): number | null => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length === 0 ? null : s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

try {
  await until("the host's list", async () => {
    try {
      return (await perch()).listed;
    } catch {
      return false;
    }
  }, 15_000, 200);
  const first = await perch();
  check("hidden mode draws nothing", first.drawsOnScreen === false && first.onScreen === false && first.listOnScreen === false, { drawsOnScreen: first.drawsOnScreen });

  // 1. Done and needs you, through the registry.
  const doneMs: number[] = [];
  const needsMs: number[] = [];
  for (let i = 0; i < RUNS * 2; i++) {
    const test = `watch-test-${i}`, upload = `watch-upload-${i}`;
    watchRecord(test, "Caret Fixture — Test run");
    await until("the perch working", async () => ((await perch()).subject?.taskId === test && (await perch()).subject?.mood === "working") || null, 3000);
    const t0 = Date.now();
    helper.tasks.update(test, { state: "done", cause: "screen", detail: "The run finished." });
    const at = activityAt(test, "done", t0)!;
    const p = await until("the perch done", async () => {
      const q = await perch();
      return q.subject?.taskId === test && q.subject.mood === "done" ? { q, t: Date.now() } : null;
    }, 3000);
    doneMs.push(p.t - at);

    watchRecord(upload, "Caret Fixture — Upload");
    // A newer running task, so needs you has to outrank it.
    helper.tasks.create({ id: `plan-newer-${i}`, kind: "plan", state: "running", cause: null, says: "Fill the claim form", app: FIXTURE_APP, windowId: `${FIXTURE_APP.pid}-claim`, windowTitle: "Caret Fixture — Claim form", frame: null, step: 0, steps: 4, stepSays: null, remaining: [], detail: null, undoable: false, pending: null });
    const t1 = Date.now();
    helper.tasks.update(upload, { state: "needsYou", cause: "screen", detail: "The window is waiting for you." });
    helper.tasks.update(`plan-newer-${i}`, { step: 1 });
    const at1 = activityAt(upload, "needsYou", t1)!;
    const n = await until("the perch needs you", async () => {
      const q = await perch();
      return q.subject?.taskId === upload && q.subject.mood === "needsYou" ? { q, t: Date.now() } : null;
    }, 3000);
    needsMs.push(n.t - at1);
    if (i === 0) {
      check("needs you outranks newer running work", n.q.subject?.taskId === upload, { subject: n.q.subject, needsYouCount: n.q.subject?.needsYou });
      check("needs you row with the watch", n.q.rows.some((r) => r.id === upload && r.section === "needsYou"), { rows: n.q.rows.length });
      result.windowWithoutFrame = { seen: n.q.seen, targetWindow: n.q.targetWindow ?? null, rimShown: n.q.rimShown, note: "the reader's window is synthetic (its pid does not exist), so the host finds no window on screen" };
    }
    // Clear this round: the watch ends as done by the user, the plan is withdrawn.
    helper.tasks.update(upload, { state: "done", cause: "you" });
    helper.tasks.update(`plan-newer-${i}`, { state: "undone", cause: "you" });
  }
  result.doneActivityToPerchMs = { n: doneMs.length, p50: pct(doneMs, 0.5), p95: pct(doneMs, 0.95), max: Math.max(...doneMs) };
  result.needsYouActivityToPerchMs = { n: needsMs.length, p50: pct(needsMs, 0.5), p95: pct(needsMs, 0.95), max: Math.max(...needsMs) };
  check("perch done within 2 s of the activity", Math.max(...doneMs) <= 2000, result.doneActivityToPerchMs as Record<string, unknown>);
  check("perch needs you within 2 s of the activity", Math.max(...needsMs) <= 2000, result.needsYouActivityToPerchMs as Record<string, unknown>);

  // 2. A real key through the host's tap routing pauses the run; Continue from the row finishes it.
  const pauseRuns: Record<string, unknown>[] = [];
  for (let i = 0; i < RUNS; i++) {
    resetFields();
    const id = `a4-pause-${i + 1}`;
    const before = (await perch()).activity.inputPauses.length;
    let keyAt = 0;
    await runUntil(id, 1, async () => {
      keyAt = Date.now();
      await hostCommand(`key char:a ${FIXTURE_APP.pid}`);
    });
    const paused = latest(id)!;
    const p = await until("the paused row", async () => {
      const q = await perch();
      return q.rows.find((x) => x.id === id && x.section === "needsYou") !== undefined ? q : null;
    }, 3000);
    const row = p.rows.find((x) => x.id === id)!;
    const filled = values().map((v) => v !== "");
    await hostCommand(`control ${id} resume`);
    await until(`${id} to finish`, () => latest(id)?.state === "done" || latest(id)?.state === "failed", 20_000);
    const r = {
      run: i + 1,
      hostSentPause: p.activity.inputPauses.slice(before),
      pausedAt: activityAt(id, "paused", keyAt) === null ? null : activityAt(id, "paused", keyAt)! - keyAt,
      state: paused.state,
      stoppedBeforeStep: paused.step === null ? null : paused.step + 1,
      detail: paused.detail,
      row: { progress: row.progress, actions: row.actions },
      perch: p.subject?.taskId === id ? p.subject.mood : null,
      fieldsAtPause: filled,
      final: latest(id)!.state,
      allSixVerified: values().every((v, k) => v === VALUES[k]),
    };
    pauseRuns.push({ ...r, ok: r.hostSentPause.includes(`${id}:key`) && r.state === "paused" && (r.stoppedBeforeStep ?? 99) <= 4 && row.progress === `Stopped before step ${r.stoppedBeforeStep} of 6` && r.perch === "waiting" && r.final === "done" && r.allSixVerified });
  }
  result.pause = pauseRuns;
  check("real key pauses the run; the row says where; Continue finishes", pauseRuns.every((r) => r.ok === true), { ok: pauseRuns.filter((r) => r.ok === true).length, of: pauseRuns.length, first: pauseRuns[0] });

  // 3. Take over from the row after step 3.
  const takeRuns: Record<string, unknown>[] = [];
  for (let i = 0; i < RUNS; i++) {
    resetFields();
    const id = `a4-takeover-${i + 1}`;
    await runUntil(id, 2, async () => {
      await hostCommand(`control ${id} takeOver`);
    });
    const handed = latest(id)!;
    const p = await until("the handed-back row", async () => {
      const q = await perch();
      return q.rows.find((x) => x.id === id && x.section === "needsYou") !== undefined ? q : null;
    }, 3000);
    const row = p.rows.find((x) => x.id === id)!;
    control(id, "stop");
    await until(`${id} to stop`, () => latest(id)?.state === "failed");
    control(id, "undo");
    await until(`${id} to undo`, () => latest(id)?.state === "undone");
    const r = { run: i + 1, state: handed.state, reachedStep: handed.step === null ? null : handed.step + 1, detail: handed.detail, remaining: handed.remaining.length, row: { progress: row.progress, actions: row.actions }, hostControls: p.activity.controlsSent.filter((c) => c.startsWith(`${id}:`)), restoredByUndo: values().every((v) => v === "") };
    takeRuns.push({ ...r, ok: r.state === "paused" && r.reachedStep === 4 && r.remaining === 3 && row.progress === "Stopped before step 4 of 6" && r.hostControls.includes(`${id}:takeOver`) && r.restoredByUndo });
  }
  result.takeOver = takeRuns;
  check("Take over reports step 4 of 6", takeRuns.every((r) => r.ok === true), { ok: takeRuns.filter((r) => r.ok === true).length, of: takeRuns.length, first: takeRuns[0] });

  // 4. A click attributed to the app.
  resetFields();
  const cid = "a4-click-1";
  const cBefore = (await perch()).activity.inputPauses.length;
  await runUntil(cid, 1, async () => {
    await hostCommand(`click ${FIXTURE_APP.pid}`);
  });
  const cp = await perch();
  check("a click in the app pauses the run", latest(cid)?.state === "paused" && cp.activity.inputPauses.slice(cBefore).includes(`${cid}:mouse`), { state: latest(cid)?.state, sent: cp.activity.inputPauses.slice(cBefore) });
  control(cid, "stop");
  await until("click run stopped", () => latest(cid)?.state === "failed");

  // 5. The rim and the task-window perch, H3: no window on screen for the task means nothing drawn
  // on it and the glyph lit; the glyph goes out with the task. The old corner command is refused.
  watchRecord("watch-rim", "Caret Fixture — Upload");
  await until("a working subject", async () => {
    const q = await perch();
    return q.subject?.taskId === "watch-rim" && q.subject.mood === "working" ? q : null;
  }, 3000);
  // The window locator answers off the main thread; one Accessibility round (2 s) has come back empty by now.
  await sleep(2500);
  const r1 = await perch();
  check("no window on screen for the task: no rim, perch or caption; the glyph is lit (H3)",
    r1.seen === "notFound" && !r1.rimShown && !r1.presented && r1.caption === undefined && r1.rim === undefined && r1.lit,
    { seen: r1.seen, rimShown: r1.rimShown, presented: r1.presented, caption: r1.caption ?? null, lit: r1.lit });
  helper.tasks.update("watch-rim", { state: "done", cause: "screen" });
  const r2 = await until("the glyph out", async () => {
    const q = await perch();
    return q.lit ? null : q;
  }, 5000, 50);
  check("the glyph goes out when the task ends", !r2.lit && !r2.rimShown, { subject: r2.subject ?? null });
  const avoid = await hostCommand("perch-avoid 0 0 10 10");
  check("perch-avoid is refused, with the reason", typeof avoid.error === "string" && avoid.error.includes("no longer applies"), { avoid });
  await hostCommand("activity open");
  const lo = await perch();
  await hostCommand("activity close");
  // Hidden mode only: drawn, the desk takes key focus by design (DIRECTION.md H4).
  check("hidden, the desk opens without drawing or taking key", lo.listOpen && !lo.listOnScreen && !lo.isKey, { rows: lo.rows.length, listOnScreen: lo.listOnScreen });

  // Host CPU over 10 s with nothing to report, then with a task running; nothing drawn either way.
  const cpu = async (): Promise<number> => (await run("ps", ["-o", "cputime=", "-p", String(host.pid)], { encoding: "utf8" })).stdout.trim().split(":").map(Number).reduce((s, x) => s * 60 + x, 0);
  const measure = async (): Promise<number> => {
    const c0 = await cpu();
    const t0 = Date.now();
    await sleep(10_000);
    return Math.round(((await cpu()) - c0) / ((Date.now() - t0) / 1000) * 1000) / 10;
  };
  const gone = await until("the perch gone", async () => (await perch()).subject == null || null, 10_000, 200).catch(async () => (await perch()).subject);
  if (gone !== true) throw new Error(`the perch stayed for ${JSON.stringify(gone)}`);
  result.hostCpuHiddenIdlePct = await measure();
  watchRecord("watch-cpu", "Caret Fixture — Upload");
  await sleep(500);
  result.hostCpuHiddenWorkingPct = await measure();
  result.hostActivity = (await perch()).activity;
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e);
} finally {
  clearInterval(tick);
  consumer.destroy();
  host.kill("SIGTERM");
  await server.close();
  helper.memory.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(hostHome, { recursive: true, force: true });
}
result.checks = checks;
result.helperErrors = sent.flatMap((x) => (x.m.type === "error" ? [x.m.message] : []));
result.ok = result.error === undefined && checks.every((c) => c.ok === true);
writeFileSync(join(OUT, "perch-socket.json"), JSON.stringify(result, null, 2));
writeFileSync(join(OUT, "log.txt"), log.join("\n") + "\n");
console.log(JSON.stringify({ ok: result.ok, error: result.error ?? null, done: result.doneActivityToPerchMs, needsYou: result.needsYouActivityToPerchMs, cpu: { idle: result.hostCpuHiddenIdlePct, working: result.hostCpuHiddenWorkingPct } }, null, 1));
process.exit(result.ok ? 0 : 1);
