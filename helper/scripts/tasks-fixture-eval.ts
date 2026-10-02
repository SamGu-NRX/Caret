// Task controls end to end on caret-fixture's executor window, with the real reader. A consumer on
// the helper's socket runs a six-step plan and controls it the way the host's activity view will:
//
//   pause:    after step 2 is verified, `pause`; the run must stop before step 3 writes anything,
//             then `resume` must finish it with all six end states verified.
//   takeOver: after step 3 is verified, `takeOver`; the record must name step 4 as the step it
//             reached and list three remaining end states; then `stop`, then `undo`.
//
// The fixture's own report of its fields (`dump`), not the executor's reading, is the check. Every
// target is an exact key, so no Jev call is made. It opens a window, so it runs while holding the GUI
// lock, and it stops its own two processes if either is ever the frontmost app:
//
//   /usr/bin/lockf -k ~/.long-run/locks/gui.lock env CARET_GUI_LOCK=held \
//     node scripts/tasks-fixture-eval.ts --bin ../apps/screen-reader/.build/debug --out DIR
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection, type Socket } from "node:net";
import { parseArgs, promisify } from "node:util";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type Activity, type TaskProgress, type TaskRecord } from "../src/protocol.ts";
import type { Plan, Step } from "../src/executor/schema.ts";

const { values: a } = parseArgs({
  options: {
    bin: { type: "string" },
    out: { type: "string" },
    runs: { type: "string", default: "5" },
    socket: { type: "string", default: join(homedir(), ".caret-run", "sockets", "b4-tasks.sock") },
  },
});
if (a.bin === undefined || a.out === undefined) throw new Error("--bin and --out are required");
if (process.env.CARET_GUI_LOCK !== "held") throw new Error("run under /usr/bin/lockf -k ~/.long-run/locks/gui.lock env CARET_GUI_LOCK=held ...");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const RUNS = Number(a.runs);
const TITLE = "Caret Fixture — Executor";

// MARK: - the plan: six fields, each with a label no other field shares

const FIELDS: { name: string; key: string; label: string; role: string }[] = [
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
    end: { kind: "valueEquals", window: { titleStartsWith: TITLE }, target: { key: `unbundled.caret-fixture/standard/${f.key}`, label: f.label, role: f.role, describe: `the ${f.label} field` }, value: VALUES[i]! },
  };
};
const PLAN: Plan = { id: "six-fields", title: "Fill the six fields", slots: {}, steps: FIELDS.map((_, i) => step(i)) };

// MARK: - frontmost app, read without blocking the event loop

const run = promisify(execFile);
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
const frontBefore = await front();
const fronts: Front[] = [frontBefore];

// MARK: - helper in process, reached only through its socket

const log: string[] = [];
const dataDir = mkdtempSync(join(tmpdir(), "caret-tasks-eval-"));
const store = new Store(dataDir);
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  askJev: null,
  shadow: false,
  allowBackgroundFocus: false,
  publish: (m) => server?.publish(m),
  sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
  warn: (l) => log.push(l),
});
server = new HelperServer(a.socket, () => helper, (l) => log.push(l));
await server.listen();
const tick = setInterval(() => helper.tick(), 250);

/** The consumer: what the host will be. Every message it sees is kept with the time it arrived. */
const seen: { at: number; m: Activity | TaskProgress | { type: "error"; message: string } }[] = [];
const consumer: Socket = await new Promise((res, rej) => {
  const s = createConnection(a.socket!);
  s.once("connect", () => res(s));
  s.once("error", rej);
});
let cbuf = "";
const onMessage: ((m: Activity | TaskProgress) => void)[] = [];
consumer.setEncoding("utf8");
consumer.on("data", (d: string) => {
  cbuf += d;
  let nl: number;
  while ((nl = cbuf.indexOf("\n")) >= 0) {
    const m = JSON.parse(cbuf.slice(0, nl)) as Activity | TaskProgress | { type: "error"; message: string };
    cbuf = cbuf.slice(nl + 1);
    seen.push({ at: Date.now(), m });
    if (m.type !== "error") for (const f of onMessage) f(m);
  }
});
const send = (m: unknown): void => void consumer.write(JSON.stringify(m) + "\n");
send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: process.pid, version: "tasks-fixture-eval" });
const control = (taskId: string, action: "pause" | "resume" | "stop" | "takeOver" | "undo"): void => send({ type: "taskControl", v: PROTOCOL_VERSION, taskId, action });
const records = (id: string): TaskRecord[] => seen.flatMap((x) => (x.m.type === "activity" && x.m.task.id === id ? [x.m.task] : []));
const latest = (id: string): TaskRecord | undefined => records(id).at(-1);
const phases = (id: string): string[] => seen.flatMap((x) => (x.m.type === "taskProgress" && x.m.taskId === id ? [`${x.m.phase}${x.m.step === null ? "" : `@${x.m.step}`}`] : []));

// MARK: - fixture and reader: the only processes this script may signal

const fixture: ChildProcessWithoutNullStreams = spawn(join(a.bin, "caret-fixture"), ["--windows", "executor", "--duration", "900", "--background-only"]);
let reader: ChildProcessWithoutNullStreams | null = null;
process.on("exit", () => {
  reader?.kill("SIGTERM");
  fixture.kill("SIGTERM");
});
let fixturePid = 0;
let foreground: Front | null = null;
const ours = (pid: number): boolean => pid > 0 && (pid === fixture.pid || pid === fixturePid || pid === (reader?.pid ?? -1));
let polling = false;
const frontPoll = setInterval(() => {
  if (polling) return;
  polling = true;
  void front()
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
  if (foreground !== null) throw new Error("deferred: foreground");
  return new Promise((res) => {
    replies.push(res);
    fixture.stdin.write(cmd + "\n");
  });
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (foreground !== null) throw new Error("deferred: foreground");
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
/** The fixture's own field values, in plan order. */
async function fields(): Promise<string[]> {
  const d = await fx("dump");
  const f = d.fields as Record<string, string | null>;
  return FIELDS.map((x) => f[x.name] ?? "(gone)");
}
/** Starts the plan and sends `action` the moment step `after` is verified, as a consumer would on seeing it. */
async function runUntil(taskId: string, after: number, action: "pause" | "takeOver"): Promise<void> {
  let sentAt = 0;
  const hook = (m: Activity | TaskProgress): void => {
    if (sentAt === 0 && m.type === "taskProgress" && m.taskId === taskId && m.phase === "verified" && m.step === after) {
      sentAt = Date.now();
      control(taskId, action);
    }
  };
  onMessage.push(hook);
  send({ type: "runPlan", v: PROTOCOL_VERSION, taskId, plan: PLAN, slots: {} });
  await until(`${taskId} to stop`, () => ["paused", "failed", "done"].includes(latest(taskId)?.state ?? ""));
  onMessage.splice(onMessage.indexOf(hook), 1);
}

const result: Record<string, unknown> = { frontBefore, runs: RUNS };
const pauseRuns: Record<string, unknown>[] = [];
const takeOverRuns: Record<string, unknown>[] = [];
let ok = false;
try {
  await until("the fixture", () => fixturePid > 0);
  await sleep(800);
  reader = spawn(join(a.bin, "caret-screen"), ["--socket", a.socket, "--only-pids", String(fixturePid), "--event-pids", String(fixturePid), "--act-pids", String(fixturePid)]);
  reader.stderr.setEncoding("utf8");
  reader.stderr.on("data", (d: string) => log.push(`reader: ${d.trim()}`));
  await until("the executor window", () => [...helper.model.windows.values()].some((w) => w.window.title.startsWith(TITLE)));

  for (let i = 0; i < RUNS; i++) {
    // Pause after step 2, then resume.
    await fx("reset");
    await sleep(500);
    const id = `pause-${i + 1}`;
    await runUntil(id, 1, "pause");
    const paused = latest(id)!;
    const atPause = await fields();
    const actedOnStep3 = phases(id).includes("acting@2");
    control(id, "resume");
    await until(`${id} to finish`, () => latest(id)?.state === "done" || latest(id)?.state === "failed");
    const done = latest(id)!;
    const atEnd = await fields();
    pauseRuns.push({
      run: i + 1,
      pausedState: paused.state,
      pausedBeforeStep: paused.step === null ? null : paused.step + 1,
      pausedDetail: paused.detail,
      fieldsAtPause: atPause.map((v) => v !== ""),
      step3ActedBeforePause: actedOnStep3,
      finalState: done.state,
      allSixVerified: atEnd.every((v, k) => v === VALUES[k]),
      phases: phases(id),
      states: records(id).map((r) => r.state),
      ok: paused.state === "paused" && paused.step === 2 && atPause.map((v) => v !== "").join() === "true,true,false,false,false,false" && !actedOnStep3 && done.state === "done" && atEnd.every((v, k) => v === VALUES[k]),
    });

    // Take over after step 3, then stop, then undo.
    await fx("reset");
    await sleep(500);
    const tid = `takeover-${i + 1}`;
    await runUntil(tid, 2, "takeOver");
    const handed = latest(tid)!;
    const atHand = await fields();
    control(tid, "stop");
    await until(`${tid} to stop`, () => latest(tid)?.state === "failed");
    const stopped = latest(tid)!;
    control(tid, "undo");
    await until(`${tid} to undo`, () => latest(tid)?.state === "undone");
    const atUndo = await fields();
    takeOverRuns.push({
      run: i + 1,
      state: handed.state,
      reachedStep: handed.step === null ? null : handed.step + 1,
      detail: handed.detail,
      stepSays: handed.stepSays,
      remaining: handed.remaining,
      fieldsAtTakeOver: atHand.map((v) => v !== ""),
      afterStop: { state: stopped.state, cause: stopped.cause, detail: stopped.detail },
      restoredByUndo: atUndo.every((v) => v === ""),
      states: records(tid).map((r) => r.state),
      ok:
        handed.state === "paused" && handed.step === 3 && handed.remaining.length === 3 && handed.detail === "Caret handed this back to you before step 4 of 6" &&
        atHand.map((v) => v !== "").join() === "true,true,true,false,false,false" && stopped.cause === "you" && atUndo.every((v) => v === ""),
    });
  }
  ok = [...pauseRuns, ...takeOverRuns].every((r) => r.ok === true);
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e);
} finally {
  clearInterval(tick);
  clearInterval(frontPoll);
  fronts.push(await front());
  consumer.destroy();
  reader?.kill("SIGTERM");
  fixture.kill("SIGTERM");
  await server.close();
  helper.memory.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}

result.pause = { ok: pauseRuns.filter((r) => r.ok === true).length, of: pauseRuns.length, runs: pauseRuns };
result.takeOver = { ok: takeOverRuns.filter((r) => r.ok === true).length, of: takeOverRuns.length, runs: takeOverRuns };
result.errors = seen.flatMap((x) => (x.m.type === "error" ? [x.m.message] : []));
result.frontChanges = fronts.slice(1).map((f) => ({ at: f.at, pid: f.pid, name: f.name }));
result.fixtureOrReaderWasFront = foreground !== null;
result.log = log.slice(-20);
result.ok = ok && foreground === null;
writeFileSync(join(OUT, "tasks-fixture.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, error: result.error ?? null, pause: `${(result.pause as { ok: number }).ok}/${pauseRuns.length}`, takeOver: `${(result.takeOver as { ok: number }).ok}/${takeOverRuns.length}`, errors: result.errors, first: { pause: pauseRuns[0], takeOver: takeOverRuns[0] } }, null, 1));
process.exit(result.ok ? 0 : 1);
