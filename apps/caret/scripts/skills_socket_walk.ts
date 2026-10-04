// A15 acceptance 2: B19's skills through the host, over its sockets, on caret-fixture with the real reader
// under act grants only, the real helper in this process and a fake Jev that names each routine by the
// first of code's names. The host runs headless (`--surfaces headless --perch hidden`): it draws nothing,
// and every key is the debug socket's `key <name> <pid>` hook, which routes a constructed key through the
// same arbiter as the event tap and posts no event anywhere. The fixture's windows open behind other apps
// and are never brought forward (checked from LaunchServices every 100 ms, as B19's eval does).
//
//   1. three occurrences by hand make the routine; Caret's first run of it is taken with Tab at the host,
//      and the keep question under its toast is accepted with Tab (skillAnswer accept);
//   2. ten clean runs, each taken with Tab; the promote question comes with the tenth, never before, and
//      Tab accepts it;
//   3. run 11 starts with no Tab: the host shows it ("On its own: <skill>") and the perch works on it; it
//      ends on a toast naming the skill; the skill is in the host's memory list as on its own and named as
//      an exception on the permissions page; a ⌘Z restores the fields, read back from the fixture;
//   4. ten more Tab runs earn it again (an undo resets it, B19's rule), Tab accepts the promote question,
//      "Put back on Tab" goes from the host, and the next run is checked for whether it needed Tab.
// "Undoable changes in other apps" is set to act if approved first, through the host's own memory command:
// the fixture is never the window the user is in, so every write is "write elsewhere".
//
//   gui.sh node apps/caret/scripts/skills_socket_walk.ts --bin <screen-reader build dir> --caret <Caret binary> --out DIR
//
// --drawn light|dark (A16): the same walk with the host drawing its surfaces at a real caret. Only
// under gui.lock, the gui lease (the caller's), 300 s without input and no quiet window. The fixture
// runs --foreground in that appearance and takes the front once ('activate legacy'); each Caret run's
// form is raised and its first field focused through Accessibility (fixture-ax raise/focus), so the
// host draws at that field's caret. Nothing posts input, so any HID input under 5 s old is a person:
// the walk stops and closes its windows (exit 76). Screenshots are of the fixture's form window and
// the host's panels, each by window number, joined by compose-shot: the keep and promote questions,
// the "On its own" line, and the line after Esc takes over a run with no Tab, which replaces "Put back
// on Tab" (a take over puts the skill back on Tab itself). The panel's frames around each question are
// recorded, to check its re-placement when the question makes it taller.
import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Helper } from "../../../helper/src/helper.ts";
import { HelperServer } from "../../../helper/src/server.ts";
import { Store } from "../../../helper/src/store.ts";
import type { AskJev } from "../../../helper/src/fill/jev.ts";
import { type HelperMessage, type PatternOffer, type SkillOffer, type TaskProgress } from "../../../helper/src/protocol.ts";
import { PROMOTE_AFTER } from "../../../helper/src/patterns/skills.ts";
import { fixtureExecutable } from "../../../helper/scripts/fixture-path.ts";

const { values: a } = parseArgs({ options: { bin: { type: "string" }, caret: { type: "string" }, out: { type: "string" }, drawn: { type: "string" } } });
if (a.bin === undefined || a.out === undefined || a.caret === undefined) throw new Error("--bin, --caret and --out are required");
if (a.drawn !== undefined && a.drawn !== "light" && a.drawn !== "dark") throw new Error("--drawn takes light or dark");
const DRAWN = a.drawn ?? null;
const HOST_BUILD = resolve(a.caret, "..", "..", "..", "..");
const FIXTURE_AX = join(HOST_BUILD, "fixture-ax");
const COMPOSE = join(HOST_BUILD, "compose-shot");
const ANNOUNCEMENTS = join(HOST_BUILD, "ax-announcements");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const sockDir = mkdtempSync(join(tmpdir(), "caret-a15-skills-"));
const HELPER_SOCK = join(sockDir, "helper.sock");
const HOST_SOCK = join(sockDir, "host.sock");
const QUEUE = "Caret Fixture — Order queue";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];

// MARK: - the frontmost app, read from LaunchServices

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
const fronts: Front[] = [front()];

// MARK: - the drawn walk's gates (shared-Mac GUI rules)

function hidIdle(): number {
  const out = execFileSync("ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8" });
  const m = /"HIDIdleTime" = (\d+)/.exec(out);
  return m?.[1] === undefined ? 0 : Number(m[1]) / 1e9;
}
/** Sam is presenting or in a call. A file that is empty or unreadable (being rewritten) counts as quiet. */
function quietNow(): boolean {
  const path = join(process.env.HOME ?? "", ".long-run", "QUIET-UNTIL");
  if (!existsSync(path)) return false;
  let first = "";
  try {
    first = readFileSync(path, "utf8").trim().split(/\s+/)[0] ?? "";
  } catch {
    return true;
  }
  const until = Number(first);
  return first === "" || !Number.isFinite(until) || until > Date.now() / 1000;
}
const GUI_LOCK = join(process.env.HOME ?? "", ".long-run", "locks", "gui.lock");
/**
 * gui.lock is held, and by this walk's own launcher: some ancestor process is `lockf ... gui.lock`.
 * A held lock alone could be another run's, which must not share the desktop with this one.
 */
function guiLockHeldByUs(): boolean {
  try {
    execFileSync("/usr/bin/lockf", ["-t", "0", GUI_LOCK, "true"], { stdio: "ignore" });
    return false;
  } catch (e) {
    if ((e as { status?: number }).status !== 75) return false;
  }
  for (let pid = process.ppid, hops = 0; pid > 1 && hops < 8; hops++) {
    const line = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (m === null) return false;
    if (/\blockf\b/.test(m[2]!) && m[2]!.includes(GUI_LOCK)) return true;
    pid = Number(m[1]);
  }
  return false;
}
// 300 s on Sam's Mac (long-run GUI rules). The rig's VM has no user and its idle count starts at boot,
// so its job lowers this (CARET_DRAWN_IDLE_MIN=30, as the A10 VM job does for its own bar).
const IDLE_MIN = Number(process.env.CARET_DRAWN_IDLE_MIN ?? "300");
if (DRAWN !== null) {
  const why = !guiLockHeldByUs() ? "refused: run under lockf -k ~/.long-run/locks/gui.lock" : quietNow() ? "deferred: quiet window" : hidIdle() < IDLE_MIN ? `deferred: user active (idle ${Math.round(hidIdle())} s)` : null;
  if (why !== null) {
    console.log(why);
    process.exit(75);
  }
}
/** Set when a person's input or a foreign front app stops a drawn walk. */
let stoppedBy: string | null = null;

// MARK: - the helper, in process

const fakeJev: AskJev = async (req) => ({
  model: "fake",
  answers: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, { choice: k === "name" ? (Object.keys(q.criteria).find((c) => c !== "none") ?? "none") : "none", confidence: 0.9 }])),
  inputTokens: 0,
  latencyMs: 0,
  costUsd: 0,
});
const sent: HelperMessage[] = [];
const fromHost: { at: number; type: string; detail: string }[] = [];
const dataDir = mkdtempSync(join(tmpdir(), "caret-a15-store-"));
const store = new Store(dataDir);
let server: HelperServer | null = null;
/** Holds a run's first step this long, so the host's line and the perch can be read while it works. */
let holdFirstStep = 0;
const helper = new Helper({
  store,
  askJev: fakeJev,
  shadow: false,
  allowBackgroundFocus: false,
  settings: { roles: ["fill", "repeat", "watch", "calendar", "words"], level: "eager", paused: false },
  // About 30 routine offers in a few minutes; Eager's hourly budget is 8.
  offersPerHour: 1000,
  publish: (m) => {
    sent.push(m);
    if (m.type === "error") log.push(`helper error: ${m.message}`);
    server?.publish(m);
  },
  sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
  executorHooks: {
    beforeStep: async (_taskId, step) => {
      // Drawn: step 0 waits 1.5 s, so its progress reaches the host after the form has focus (the host
      // draws a run with no Tab at its next progress once the user is there), and step 1 waits the
      // full hold, so the line stays up for its picture and for Esc.
      if (holdFirstStep > 0 && DRAWN === null && step === 0) await sleep(holdFirstStep);
      if (holdFirstStep > 0 && DRAWN !== null && step <= 1) await sleep(step === 0 ? 1500 : holdFirstStep);
    },
  },
  warn: (l) => log.push(l),
});
// What the host sends, as the helper hears it.
const origAccept = helper.handleOfferAccept.bind(helper);
helper.handleOfferAccept = (m) => (fromHost.push({ at: Date.now(), type: "offerAccept", detail: m.offerId }), origAccept(m));
const origAnswer = helper.handleSkillAnswer.bind(helper);
helper.handleSkillAnswer = (m) => (fromHost.push({ at: Date.now(), type: "skillAnswer", detail: `${m.answer} ${m.id}` }), origAnswer(m));
const origTask = helper.handleTask.bind(helper);
helper.handleTask = (m) => (fromHost.push({ at: Date.now(), type: "taskControl", detail: `${m.action} ${m.taskId}` }), origTask(m));
const origMemory = helper.handleMemory.bind(helper);
const memoryReplies: { op: string; error: string | null }[] = [];
helper.handleMemory = (m) => {
  const r = origMemory(m);
  memoryReplies.push({ op: `${m.op}${m.id === undefined ? "" : ` ${m.id}`}${m.fields === undefined ? "" : ` ${JSON.stringify(m.fields)}`}`, error: r.error });
  return r;
};
server = new HelperServer(HELPER_SOCK, () => helper, (l) => log.push(l));
await server.listen();
const tick = setInterval(() => helper.tick(), 250);

// MARK: - fixture, reader and host: the only processes this script signals

const fixture: ChildProcessWithoutNullStreams = spawn(
  fixtureExecutable(a.bin),
  ["--windows", "forms", "--duration", "1800", ...(DRAWN === null ? [] : ["--foreground", "--appearance", DRAWN])],
);
let reader: ChildProcessWithoutNullStreams | null = null;
let host: ChildProcess | null = null;
let hostLog = "";
/** Drawn: what the host asked VoiceOver to say, from an AXObserver on the host (ax-announcements). */
let announcer: ChildProcess | null = null;
const announced: { atMs: number; text: string | null; keys: string[] }[] = [];
const stopAll = (): void => {
  announcer?.kill("SIGTERM");
  host?.kill("SIGTERM");
  reader?.kill("SIGTERM");
  fixture.kill("SIGTERM");
};
process.on("exit", stopAll);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(143));
let fixturePid = 0;
let foreground: Front | null = null;
const ours = (pid: number): boolean => pid > 0 && (pid === fixture.pid || pid === fixturePid || pid === (reader?.pid ?? -1) || pid === (host?.pid ?? -1));
/** Drawn: the fixture took the front at this time; any other app after it stops the walk. */
let activatedAt: number | null = null;
const frontPoll = setInterval(() => {
  const f = front();
  fronts.push(f);
  if (DRAWN === null) {
    if (foreground === null && ours(f.pid)) {
      foreground = f;
      stopAll();
    }
    return;
  }
  if (activatedAt !== null && foreground === null && !ours(f.pid)) {
    foreground = f;
    // Someone else's app came forward: leave it there, close ours.
    stopNow(`deferred: foreground (${f.name} ${f.pid} took the front)`);
  }
}, 100);
/**
 * Drawn: the walk posts no input, and it started after 300 s without any, so HID input under 5 s old is
 * a person's. It stops the walk at once: the fixture is killed (taking its windows) and every later step
 * refuses (`guard`).
 */
const idleWatch = setInterval(() => {
  if (DRAWN === null || stoppedBy !== null) return;
  const idle = hidIdle();
  if (idle < 5) stopNow(`deferred: user active (input ${idle.toFixed(1)} s ago)`);
  else if (quietNow()) stopNow("deferred: quiet window began");
}, 200);
function stopNow(why: string): void {
  if (stoppedBy !== null) return;
  stoppedBy = why;
  stopAll();
}
/** Every step that touches the host, the fixture or the screen checks this first. */
function guard(): void {
  if (stoppedBy !== null) throw new Error(stoppedBy);
}
/** Each fixture command waits for its reply line; all of them fail at once if the fixture goes. */
const replies: { ok: (o: Record<string, unknown>) => void; fail: (e: Error) => void }[] = [];
const failReplies = (why: string): void => {
  for (const r of replies.splice(0)) r.fail(new Error(`fixture: ${why}`));
};
/** How the fixture ended, and the end of what it wrote to stderr, for a walk it leaves early. */
let fixtureEnd: { at: number; code: number | null; signal: string | null } | null = null;
let fixtureErr = "";
fixture.stderr.setEncoding("utf8");
fixture.stderr.on("data", (d: string) => (fixtureErr = (fixtureErr + d).slice(-4000)));
fixture.on("exit", (code, sig) => {
  fixtureEnd = { at: Date.now(), code, signal: sig };
  failReplies(`exited (${code ?? sig})`);
});
fixture.on("error", (e) => failReplies(e.message));
fixture.stdout.on("close", () => failReplies("stdout closed"));
let buf = "";
fixture.stdout.setEncoding("utf8");
fixture.stdout.on("data", (d: string) => {
  buf += d;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    const m = /^caret-fixture pid (\d+)/.exec(line);
    if (m?.[1] !== undefined) fixturePid = Number(m[1]);
    else if (line.startsWith("{")) replies.shift()?.ok(JSON.parse(line) as Record<string, unknown>);
  }
});
/** One fixture command and its reply, within 10 s; replies come back in the order commands went. */
const fx = (cmd: string): Promise<Record<string, unknown>> =>
  new Promise((res, rej) => {
    if (stoppedBy !== null && !cmd.startsWith("quit ")) return rej(new Error(stoppedBy));
    const entry = {
      ok: (o: Record<string, unknown>) => (clearTimeout(t), res(o)),
      fail: (e: Error) => (clearTimeout(t), rej(e)),
    };
    const t = setTimeout(() => {
      const i = replies.indexOf(entry);
      if (i >= 0) replies.splice(i, 1);
      rej(new Error(`fixture: no reply to '${cmd}' in 10 s`));
    }, 10_000);
    replies.push(entry);
    fixture.stdin.write(cmd + "\n");
  });
async function until<T>(what: string, f: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 15_000, every = 50): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    if (stoppedBy !== null) throw new Error(stoppedBy);
    if (foreground !== null) throw new Error(`deferred: foreground (${JSON.stringify(foreground)})`);
    const v = await f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

function hostCommand(command: string): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    if (stoppedBy !== null) return rej(new Error(stoppedBy));
    const c = createConnection(HOST_SOCK);
    let b = "";
    const t = setTimeout(() => (c.destroy(), rej(new Error(`no answer to '${command}'`))), 5000);
    c.setEncoding("utf8");
    c.on("connect", () => c.write(command + "\n"));
    c.on("data", (d: string) => {
      b += d;
      if (b.includes("\n")) {
        clearTimeout(t);
        c.end();
        res(JSON.parse(b) as Record<string, unknown>);
      }
    });
    c.on("error", (e) => (clearTimeout(t), rej(e)));
  });
}
interface Surface {
  offerKey?: string;
  lineText?: string;
  workingOn?: string;
  unprompted?: boolean;
  question?: string;
  questionAnswered?: boolean;
  toast?: { kind: string; caption: string; grantID?: number };
}
const surface = async (): Promise<Surface> => ((await hostCommand("state")).surface ?? {}) as Surface;
const key = async (name: string): Promise<boolean> => (await hostCommand(`key ${name} ${fixturePid}`)).consumed === true;
interface MemoryInfo {
  book: {
    loaded: boolean;
    entries: { id: string; kind: string; status: string; says: string }[];
    onTheirOwn: string[];
    underRules?: { action: string; rule: string; runs: boolean; title: string; skills: string[] }[];
    problems: Record<string, string>;
    busy: Record<string, string>;
  };
}
const memory = async (): Promise<MemoryInfo> => (await hostCommand("memory")) as unknown as MemoryInfo;
interface PerchInfo {
  subject?: { taskId: string; mood: string } | null;
}
const perch = async (): Promise<PerchInfo> => (await hostCommand("perch")) as unknown as PerchInfo;

// MARK: - occurrences (B19's fixture driving)

const windowTitled = (title: string) => [...helper.model.windows.values()].find((w) => w.window.title === title);
const walk = async (windowId: string): Promise<void> => {
  const w = helper.model.windows.get(windowId);
  if (w === undefined) throw new Error(`window ${windowId} is gone`);
  const r = await helper.readerVerb({ kind: "walk", pid: w.app.pid, windowId });
  if (r.outcome !== "ok") throw new Error(`walk ${windowId}: ${r.outcome} ${r.detail ?? ""}`);
};
const since = <T extends HelperMessage["type"]>(type: T, from: number): Extract<HelperMessage, { type: T }>[] =>
  sent.slice(from).filter((m): m is Extract<HelperMessage, { type: T }> => m.type === type);
interface Order {
  name: string;
  email: string;
  order: string;
}
const intakeOf = (o: Order): Record<string, string> => ({ customer: o.name, email: o.email, order: o.order });
async function nextOrder(): Promise<Order> {
  const r = (await fx("form next")) as unknown as Order;
  const q = windowTitled(QUEUE);
  if (q === undefined) throw new Error("the order queue is not in the screen model");
  await walk(q.window.windowId);
  await until(`the queue to show ${r.order}`, () => [...(windowTitled(QUEUE)?.nodes.values() ?? [])].some((n) => (n.label ?? "").includes(r.order)), 5000);
  return { name: r.name, email: r.email, order: r.order };
}
async function openForm(): Promise<string> {
  const r = await fx("form open intake");
  const title = String(r.title);
  return (await until(`the ${title} window`, () => windowTitled(title))).window.windowId;
}
async function closeForm(windowId: string): Promise<void> {
  await fx("form close intake");
  await until(`window ${windowId} to close`, () => !helper.model.windows.has(windowId));
}
const dump = async (): Promise<Record<string, string>> => ((await fx("form dump intake")) as unknown as { fields: Record<string, string> }).fields;
// MARK: - drawn: the form where the user is, and pictures of it

/**
 * One window capture by number. In the rig's VM only the job's bash is approved for screen capture, so
 * CARET_SHOT_SERVER names a directory where the job's bash takes requests: this writes the arguments,
 * tab-separated, to req-<n>, and the server runs screencapture with them and writes done-<n>.
 */
let shotSeq = 0;
async function capture(args: string[]): Promise<void> {
  const server = process.env.CARET_SHOT_SERVER;
  if (server === undefined) {
    execFileSync("screencapture", args);
    return;
  }
  // Named by this process too: the light and dark walks share one server directory, and a done-<n> left
  // by the light walk answered the dark walk's first request before its picture existed (A16 VM run 2).
  const n = `${process.pid}-${++shotSeq}`;
  writeFileSync(join(server, `req-${n}.tmp`), args.join("\t"));
  execFileSync("mv", [join(server, `req-${n}.tmp`), join(server, `req-${n}`)]);
  await until(`capture ${n}`, () => (existsSync(join(server, `done-${n}`)) ? true : null), 10_000, 50);
}

const ax = (...args: string[]): Record<string, unknown> =>
  (guard(), JSON.parse(execFileSync(FIXTURE_AX, args, { encoding: "utf8", env: { ...process.env, CARET_TEST_PIDS: String(fixturePid) } })) as Record<string, unknown>);
/** The form window Caret is filling, by title, for the pictures. */
let formTitle = "";
/**
 * Drawn: the form comes to the front of the fixture (which holds the front) and its first field takes
 * focus, as a person clicking into it would, so the host has a caret to draw at. Undrawn: nothing.
 */
/** Drawn: the form's editable nodes as the screen model keys them, before and after its field takes focus. */
const focusKeys: { windowId: string; before: string[]; after: string[] }[] = [];
const editableKeys = (windowId: string): string[] =>
  [...(helper.model.windows.get(windowId)?.nodes.entries() ?? [])].filter(([, n]) => n.editable === true).map(([k, n]) => `${k}=${JSON.stringify(n.value ?? "")}`);
async function present(windowId: string): Promise<void> {
  if (DRAWN === null) return;
  const before = editableKeys(windowId);
  const title = helper.model.windows.get(windowId)?.window.title ?? "";
  formTitle = title;
  const raised = ax("raise", String(fixturePid), title);
  if (raised.ok !== true) throw new Error(`raise ${title}: ${JSON.stringify(raised)}`);
  const fields = JSON.parse(execFileSync(FIXTURE_AX, ["fields", String(fixturePid)], { encoding: "utf8", env: { ...process.env, CARET_TEST_PIDS: String(fixturePid) } })) as { window: string; frame: number[] }[];
  const first = fields.find((f) => f.window === title);
  if (first === undefined) throw new Error(`no field in ${title}`);
  const focused = ax("focus", String(fixturePid), first.frame.join(","));
  if (focused.ok !== true) throw new Error(`focus in ${title}: ${JSON.stringify(focused)}`);
  if (focusKeys.length < 4) {
    await sleep(600);
    focusKeys.push({ windowId, before, after: editableKeys(windowId) });
  }
}
/**
 * Drawn, the keep run only: the host's placement bounds (test hook `placement-bounds`, which stands in
 * for the screen's visible frame) end this far below the form's first field, as on a screen whose
 * bottom edge is that close. The question growing the result line downward then runs out of room and
 * the host must place the panel again. On Sam's screen the form opens 260 pt above the bottom, where the
 * grown panel fits where it was. Moving the window instead was tried and fails: the offer names the
 * field by its frame at the window's opening, and a moved field no longer matches it.
 */
// 40: A16's light run measured the "right" spot's panel at the field's top edge, 75 pt tall with the
// question; at 70 pt below the field the grown panel still fit. Below 57 pt it cannot.
const LOW_FIELD_GAP = 40;
async function boundsLow(windowId: string): Promise<Record<string, unknown>> {
  const title = helper.model.windows.get(windowId)?.window.title ?? "";
  const visible = (ax("visible-frame", String(fixturePid), title).frame ?? []) as number[];
  const fields = JSON.parse(execFileSync(FIXTURE_AX, ["fields", String(fixturePid)], { encoding: "utf8", env: { ...process.env, CARET_TEST_PIDS: String(fixturePid) } })) as { window: string; frame: number[] }[];
  const first = fields.find((f) => f.window === title);
  if (first === undefined || visible.length !== 4) throw new Error(`no field or screen for ${title}`);
  const bottom = first.frame[1]! + first.frame[3]! + LOW_FIELD_GAP;
  const bounds = [visible[0]!, visible[1]!, visible[2]!, bottom - visible[1]!];
  const set = await hostCommand(`placement-bounds ${bounds.join(" ")}`);
  if (set.ok !== true) throw new Error(`placement-bounds: ${JSON.stringify(set)}`);
  return { visible, field: first.frame, bounds };
}
interface Panel {
  windowNumber: number;
  frame: number[];
  text?: string | null;
}
const shots: Record<string, string | null> = {};
let hostReduceMotion: boolean | null = null;
/**
 * The form window and every panel the host has up, each captured by window number (never a region,
 * so nothing else on the screen can be in it) and joined over a flat background.
 */
async function shot(name: string): Promise<void> {
  if (DRAWN === null) return;
  guard();
  const dir = join(OUT, "shots");
  mkdirSync(dir, { recursive: true });
  type Listed = { windows: { window_id: number; title: string; bounds: { x: number; y: number; width: number; height: number } }[] };
  // The window list can lag a just-raised window: tried for a second, then the walk fails without the picture.
  const base = await until(`the ${formTitle} window to picture`, () => {
    const listed = JSON.parse(execFileSync("cua-driver", ["list_windows", JSON.stringify({ pid: fixturePid })], { encoding: "utf8" })) as Listed;
    return listed.windows.find((w) => w.title === formTitle) ?? null;
  }, 1000, 100).catch(() => null);
  if (base === null) {
    shots[name] = null;
    throw new Error(`no picture of ${name}: ${formTitle} is not in the window list`);
  }
  const layers: string[] = [];
  const basePath = join(dir, `${name}-window.png`);
  await capture(["-x", "-o", `-l${base.window_id}`, basePath]);
  layers.push(`${basePath}:${base.bounds.x},${base.bounds.y},${base.bounds.width},${base.bounds.height}`);
  const state = await hostCommand("state");
  const sf = (state.surface ?? {}) as Record<string, Panel | undefined>;
  const panels = [sf.ghostPanel, sf.decor, sf.panel, sf.list].filter((p): p is Panel => p !== undefined && p !== null && !(p.text ?? "").startsWith("(exiting)"));
  for (const [i, p] of panels.entries()) {
    const path = join(dir, `${name}-host${i}.png`);
    await capture(["-x", "-o", `-l${p.windowNumber}`, path]);
    layers.push(`${path}:${p.frame.join(",")}`);
  }
  const out = join(dir, `${name}.png`);
  execFileSync(COMPOSE, [out, ...layers]);
  for (const l of layers) rmSync(l.slice(0, l.lastIndexOf(":")), { force: true });
  shots[name] = out;
}
/** The panel's frames after a run ends, each change once, to see it re-placed when a question grows it. */
interface Placement {
  ms: number;
  frame: number[] | null;
  spot: string | null;
  field: number[] | null;
  question: string | null;
  text: string | null;
}
async function placements(ms: number): Promise<Placement[]> {
  const seen: Placement[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const sf = ((await hostCommand("state")).surface ?? {}) as { panel?: Panel; panelPlacement?: { spot: string; field: number[] }; question?: string; lineText?: string };
    const p: Placement = { ms: Date.now() - t0, frame: sf.panel?.frame ?? null, spot: sf.panelPlacement?.spot ?? null, field: sf.panelPlacement?.field ?? null, question: sf.question ?? null, text: sf.lineText ?? null };
    const last = seen.at(-1);
    if (last === undefined || JSON.stringify([last.frame, last.question, last.spot]) !== JSON.stringify([p.frame, p.question, p.spot])) seen.push(p);
    await sleep(40);
  }
  return seen;
}

const overlaps = (p: number[], q: number[]): boolean =>
  p.length === 4 && q.length === 4 && p[0]! < q[0]! + q[2]! && q[0]! < p[0]! + p[2]! && p[1]! < q[1]! + q[3]! && q[1]! < p[1]! + p[3]!;
/** The panel before the question (the toast alone) and with it: taller, where it went, and clear of the field. */
const inside = (p: number[], q: number[]): boolean =>
  p.length === 4 && q.length === 4 && p[0]! >= q[0]! && p[1]! >= q[1]! && p[0]! + p[2]! <= q[0]! + q[2]! && p[1]! + p[3]! <= q[1]! + q[3]!;
/**
 * The panel with the question: clear of the field and inside `bounds` (the screen's visible frame, or the
 * narrowed placement bounds). The toast alone is recorded when a sample caught it; the question usually
 * arrives with the run's ending, so the panel is mostly first seen already grown.
 */
function replacement(placed: Placement[], bounds: number[]): Record<string, unknown> {
  const before = placed.find((p) => p.frame !== null && p.question === null) ?? null;
  const after = [...placed].reverse().find((p) => p.frame !== null && p.question !== null) ?? null;
  return {
    before, after, bounds,
    taller: before !== null && after !== null ? after.frame![3]! > before.frame![3]! : null,
    moved: before !== null && after !== null ? before.frame![1] !== after.frame![1] || before.spot !== after.spot : null,
    clearOfField: after?.frame != null && after.field != null ? !overlaps(after.frame, after.field) : false,
    insideBounds: after?.frame != null ? inside(after.frame, bounds) : false,
  };
}

async function byHand(values: Record<string, string>): Promise<void> {
  const id = await openForm();
  await walk(id);
  for (const [field, value] of Object.entries(values)) {
    await fx(`form set intake ${field} ${value}`);
    await walk(id);
    await sleep(300);
  }
  await sleep(2200);
  await closeForm(id);
}

interface Run {
  n: number;
  tab: boolean;
  outcome: string;
  verified: boolean;
  hostShown: boolean;
  toast: string | null;
  question: string | null;
  skillOffers: string[];
  ms: number;
}
const runs: Run[] = [];

/**
 * One occurrence. With a routine offer: the host must show it, and Tab at the host takes it. With a run
 * that starts on its own: nothing is pressed. Either way the fields are read back from the fixture, and
 * the host's toast and any question under it are recorded. The form stays open.
 */
async function caretRun(
  expect: Record<string, string>,
  opts: { answer?: "tab" | "esc"; shot?: string; low?: boolean } = {},
): Promise<{ run: Run; windowId: string; taskId: string; offers: SkillOffer[]; placed: Placement[] }> {
  const at = sent.length;
  const t0 = Date.now();
  const id = await openForm();
  await present(id);
  if (opts.low === true && DRAWN !== null) result.lowBounds = await boundsLow(id);
  const own = (): TaskProgress | undefined => since("taskProgress", at).find((p) => p.unprompted === true);
  const first = await until(`a routine offer or a run with no Tab in ${id}`, () => since("patternOffer", at).find((o: PatternOffer) => o.kind === "routine" && o.windowId === id) ?? own(), 8000);
  let taskId: string;
  let hostShown = false;
  if ("kind" in first) {
    taskId = first.id;
    hostShown = (await until("the host to show the routine offer", async () => ((await surface()).offerKey === taskId ? true : null), 5000).catch(() => false)) === true;
    if (!(await key("tab"))) {
      // Why: the offer the host holds back (SurfaceGate.Hold) or what it shows instead.
      const sf = await surface().catch(() => ({}) as Surface);
      throw new Error(`the host did not take Tab on the routine offer (shown ${JSON.stringify(sf.offerKey ?? null)}, held ${JSON.stringify((sf as { held?: string }).held ?? null)})`);
    }
  } else {
    taskId = first.taskId;
  }
  const end = await until("the run to end", () => since("taskProgress", at).find((p) => p.taskId === taskId && ["done", "stopped", "handoff", "paused"].includes(p.phase)), 15_000);
  // Drawn: the panel from the run's ending through the question the host asks under its toast.
  const placed = DRAWN === null ? [] : await placements(1200);
  await helper.patterns.unpromptedSettled();
  const d = await dump();
  const verified = Object.entries(expect).every(([k, v]) => d[k] === v);
  // The keep or promote question follows the run's ending at once; the host asks it under the toast.
  await sleep(300);
  const s = await surface();
  const offers = since("skillOffer", at);
  const run: Run = {
    n: runs.length + 1, tab: "kind" in first, outcome: end.phase, verified, hostShown,
    toast: s.toast?.caption ?? null, question: s.question ?? null, skillOffers: offers.map((o) => o.kind), ms: Date.now() - t0,
  };
  runs.push(run);
  // Each routine's silent record, to see which run scored a miss.
  const silent = helper.memory.list("routine").map((e) => (e.kind === "routine" ? `${e.id.slice(-8)} ${e.fields.silent.hits}/${e.fields.silent.misses}` : "")).join(", ");
  process.stdout.write(`run ${run.n} ${run.tab ? "tab" : "no tab"} ${run.outcome} ${verified ? "verified" : "NOT VERIFIED"} toast '${run.toast}' question '${run.question}' ${run.skillOffers.join(",")} [${silent}]\n`);
  if (opts.shot !== undefined && offers.length > 0) await shot(opts.shot);
  if (opts.answer !== undefined && offers.length > 0) {
    if (!(await key(opts.answer))) throw new Error(`the host did not take ${opts.answer} on the question`);
    if (opts.shot !== undefined) {
      await sleep(250);
      await shot(`${opts.shot}-answered`);
    }
  }
  if (opts.low === true && DRAWN !== null) await hostCommand("placement-bounds clear");
  // Drawn: the form stays open a while, as a person reading it would. In A16's drawn runs, closing it
  // 1.7 s after the run ended left a bundle with two of the three copies, scored as a miss (try 4:
  // a 2-value routine recorded beside the 3-value one, 3 hits and 1 miss after run 2), and the
  // routine fell under the 0.8 precision it needs to be offered. The keep run, open ~4 s, scored a hit.
  if (DRAWN !== null) await sleep(3000);
  return { run, windowId: id, taskId, offers, placed };
}
const skill = () => helper.memory.list("skill").find((e) => e.kind === "skill");

// MARK: - the walk

const checks: Record<string, boolean> = {};
const result: Record<string, unknown> = { at: new Date().toISOString(), checks, runs };
let ok = false;
try {
  await until("the fixture", () => fixturePid > 0);
  await sleep(800);
  reader = spawn(join(a.bin, "caret-screen"), ["--socket", HELPER_SOCK, "--only-pids", String(fixturePid), "--event-pids", String(fixturePid)]);
  host = spawn(resolve(a.caret), [
    "--helper-socket", HELPER_SOCK, "--socket", HOST_SOCK, "--no-ghost", "--perch", "hidden",
    ...(DRAWN === null ? ["--surfaces", "headless"] : ["--appearance", DRAWN]),
    "--allow-pids", String(fixturePid), "--test-hooks", "--status-item", "off", "--onboarding", "off", "--settings", join(sockDir, "settings.json"),
  ]);
  host.stderr?.setEncoding("utf8");
  host.stderr?.on("data", (d: string) => (hostLog += d));
  await until("the host's socket", () => existsSync(HOST_SOCK), 15_000);
  await until("the host on the helper", async () => (((await hostCommand("state")).helper as { connected?: boolean } | undefined)?.connected === true ? true : null), 15_000, 200);
  if (DRAWN !== null && host.pid !== undefined) {
    announcer = spawn(ANNOUNCEMENTS, [String(host.pid)], { env: { ...process.env, CARET_TEST_PIDS: String(host.pid) } });
    let abuf = "";
    announcer.stdout?.setEncoding("utf8");
    announcer.stdout?.on("data", (d: string) => {
      abuf += d;
      let nl: number;
      while ((nl = abuf.indexOf("\n")) >= 0) {
        const line = JSON.parse(abuf.slice(0, nl)) as { atMs?: number; text?: string | null; keys?: string[]; ready?: boolean };
        abuf = abuf.slice(nl + 1);
        if (line.ready !== true) announced.push({ atMs: line.atMs ?? 0, text: line.text ?? null, keys: line.keys ?? [] });
      }
    });
    announcer.stderr?.setEncoding("utf8");
    announcer.stderr?.on("data", (d: string) => log.push(`ax-announcements: ${d.trim()}`));
  }
  // The host sends its own gate settings on connect (B10) and a fresh settings file says Balanced,
  // which overrides the helper's Eager: the level is set at the host, as the user would.
  const level = await hostCommand("settings set level eager");
  if (level.error !== undefined) throw new Error(`settings: ${String(level.error)}`);
  await sleep(500);
  await until("the order queue", () => windowTitled(QUEUE));
  await until("the host's memory list", async () => ((await memory()).book.loaded ? true : null), 5000);
  await hostCommand("memory rule writeElsewhere actIfApproved");
  await until("the rule from the host", () => memoryReplies.find((r) => r.op.startsWith("edit permission-writeElsewhere") && r.error === null), 5000);
  if (DRAWN !== null) {
    hostReduceMotion = (((await hostCommand("state")).surface ?? {}) as { reduceMotion?: boolean }).reduceMotion ?? null;
    const asked = await fx("activate legacy");
    await until("the fixture at the front", () => (front().pid === fixturePid ? true : null), 3000).catch(() => {
      throw new Error(`deferred: foreground (activate legacy: ${JSON.stringify(asked)}, front ${JSON.stringify(front())})`);
    });
    activatedAt = Date.now();
  }

  // 1. Learned by hand, then Caret's first run taken with Tab; the keep question accepted with Tab.
  for (let i = 0; i < 3; i++) await byHand(intakeOf(await nextOrder()));
  await helper.patterns.skills.namesSettled();
  let r = await caretRun(intakeOf(await nextOrder()), { answer: "tab", shot: "keep", low: true });
  if (DRAWN !== null) {
    result.keepPlaced = r.placed;
    const replaced = replacement(r.placed, ((result.lowBounds as { bounds?: number[] } | undefined)?.bounds) ?? []);
    result.keepReplacement = replaced;
    checks.keepQuestionPanelClearOfTheField = replaced.clearOfField === true;
    checks.keepQuestionPanelInsideTheNarrowedBounds = replaced.insideBounds === true;
  }
  checks.firstRunTakenWithTabAtTheHost = r.run.tab && r.run.hostShown && r.run.outcome === "done" && r.run.verified;
  checks.keepQuestionUnderTheToast = r.run.skillOffers.includes("keep") && (r.run.question ?? "").startsWith("Keep this as ") && r.run.toast !== null;
  await until("the keep answer at the helper", () => fromHost.find((x) => x.type === "skillAnswer" && x.detail.startsWith("accept")), 3000);
  checks.keepAcceptedWithTab = skill()?.status === "learning";
  await closeForm(r.windowId);
  result.skillName = skill()?.kind === "skill" ? (skill() as { fields: { name: string } }).fields.name : null;

  // 2. Ten clean runs with Tab; the promote question with the tenth, accepted with Tab.
  let early = 0;
  let promoteQuestion: string | null = null;
  for (let i = 1; i <= PROMOTE_AFTER; i++) {
    r = await caretRun(intakeOf(await nextOrder()), { answer: i === PROMOTE_AFTER ? "tab" : undefined, shot: i === PROMOTE_AFTER ? "promote" : undefined });
    if (i === PROMOTE_AFTER && DRAWN !== null) {
      result.promotePlaced = r.placed;
      const visible = (ax("visible-frame", String(fixturePid), formTitle).frame ?? []) as number[];
      const replaced = replacement(r.placed, visible);
      result.promoteReplacement = replaced;
      checks.promoteQuestionPanelClearOfTheField = replaced.clearOfField === true;
      checks.promoteQuestionPanelOnScreen = replaced.insideBounds === true;
    }
    if (i < PROMOTE_AFTER && r.offers.length > 0) early++;
    if (i === PROMOTE_AFTER) promoteQuestion = r.run.question;
    await closeForm(r.windowId);
  }
  checks.tenCleanTabRunsAtTheHost = runs.slice(-PROMOTE_AFTER).every((x) => x.tab && x.hostShown && x.outcome === "done" && x.verified);
  checks.noQuestionBeforeTheTenth = early === 0;
  checks.promoteQuestionTellsTheTruth = promoteQuestion === "Do this one on your own from now on?";
  await until("the promote answer at the helper", () => fromHost.filter((x) => x.type === "skillAnswer").length >= 2 ? true : null, 3000);
  checks.promoteAcceptedWithTab = skill()?.status === "active";

  // 3. Run 11 with no Tab: the line, the perch, the toast; memory and permissions; then ⌘Z.
  // Drawn: long enough to raise and focus the form and take its picture while the run works.
  holdFirstStep = DRAWN === null ? 1500 : 4000;
  const order11 = await nextOrder();
  const at11 = sent.length;
  const id11 = await openForm();
  await present(id11);
  const started = await until("run 11 to start with no Tab", () => since("taskProgress", at11).find((p) => p.unprompted === true), 8000);
  const working = await until("the host's line for it", async () => {
    const s = await surface();
    return s.workingOn === started.taskId && s.unprompted === true ? s : null;
  }, DRAWN === null ? 3000 : 6000);
  const perchWorking = await until("the perch working on it", async () => {
    const p = await perch();
    return p.subject?.taskId === started.taskId && p.subject.mood === "working" ? p.subject : null;
  }, 3000).catch(() => null);
  await shot("on-its-own");
  holdFirstStep = 0;
  await until("run 11 to end", () => since("taskProgress", at11).find((p) => p.taskId === started.taskId && p.phase === "done"), 15_000);
  const toast = await until("the toast naming the skill", async () => {
    const s = await surface();
    return s.toast?.grantID !== undefined && (s.toast.caption ?? "").startsWith("Done on its own: ") ? s.toast : null;
  }, 3000);
  const filled = await dump();
  const run11: Record<string, unknown> = { taskId: started.taskId, line: working.lineText, perch: perchWorking, toast: toast.caption, fixture: filled };
  result.run11 = run11;
  checks.run11StartedWithNoTab = !fromHost.some((x) => x.type === "offerAccept" && x.detail === started.taskId);
  checks.run11Filled = Object.entries(intakeOf(order11)).every(([k, v]) => filled[k] === v);
  checks.run11LineNamesTheSkill = working.lineText === `On its own: ${String(result.skillName)}`;
  checks.run11PerchWorking = perchWorking !== null;
  checks.run11ToastNamesTheSkill = toast.caption === `Done on its own: ${String(result.skillName)}`;
  await hostCommand("memory list");
  const listed = await until("the host's list to show it on its own", async () => {
    const m = await memory();
    return m.book.entries.some((e) => e.kind === "skill" && e.status === "active") ? m : null;
  }, 3000);
  checks.skillInTheMemoryList = listed.book.entries.some((e) => e.kind === "skill" && e.status === "active");
  checks.skillIsAPermissionsException = listed.book.onTheirOwn.includes(String(result.skillName));
  // Today's helper does not say where a skill wrote, so the page lists it under each write rule that lets
  // it run now: Write where you are at Ask first, and Undoable changes at Act if approved (set above).
  const under = listed.book.underRules ?? [];
  result.underRules = under;
  checks.permissionsListItWhereItMayRun = ["writeHere", "writeElsewhere"].every((action) =>
    under.some((u) => u.action === action && u.runs && u.skills.includes(String(result.skillName))));
  if (!(await key("cmd-z"))) throw new Error("the host did not take ⌘Z on run 11's toast");
  await until("the undo at the helper", () => fromHost.find((x) => x.type === "taskControl" && x.detail === `undo ${started.taskId}`), 3000);
  await until("the undone progress", () => since("taskProgress", at11).find((p) => p.taskId === started.taskId && p.phase === "undone"), 10_000);
  const afterUndo = await dump();
  run11.afterUndo = afterUndo;
  checks.commandZRestoredTheFields = Object.values(afterUndo).every((v) => v === "");
  await closeForm(id11);

  // 4. Earned again, then "Put back on Tab" from the host; is the next run on Tab?
  for (let i = 1; i <= PROMOTE_AFTER; i++) {
    r = await caretRun(intakeOf(await nextOrder()), { answer: i === PROMOTE_AFTER ? "tab" : undefined });
    await closeForm(r.windowId);
  }
  await until("the skill on its own again", () => (skill()?.status === "active" ? true : null), 3000);
  if (DRAWN !== null) await takeOverWithEsc();
  else await putBackOnTab();
  result.skills = helper.memory.list("skill");
  ok = Object.values(checks).every((v) => v);
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e);
  // What the helper decided and said last, to read a stall from.
  result.lastDecisions = helper.memory.decisions().slice(-10);
  result.lastSent = sent.slice(-20).map((m) => JSON.stringify(m).slice(0, 240));
  result.routines = helper.memory.list("routine");
} finally {
  clearInterval(tick);
  clearInterval(frontPoll);
  clearInterval(idleWatch);
  fronts.push(front());
  // Drawn: the front goes back to the app that had it, and the fixture exits; unless someone else's app
  // came forward meanwhile, which is left where it is. What happened is recorded.
  if (DRAWN !== null && fixturePid > 0 && stoppedBy === null) {
    const reply = await fx(`quit ${fronts[0]?.pid ?? 0}`).catch((e: unknown) => ({ error: String(e) }));
    await sleep(500);
    result.handBack = { to: fronts[0] ?? null, reply, frontAfter: front() };
  }
  stopAll();
  await server.close();
  helper.memory.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sockDir, { recursive: true, force: true });
}

/** Undrawn part 4: "Put back on Tab" from the host; is the next run on Tab? */
async function putBackOnTab(): Promise<void> {
  await hostCommand("memory list");
  await until("the host's list to show it on its own", async () => ((await memory()).book.onTheirOwn.length > 0 ? true : null), 3000);
  const skillId = skill()?.id ?? "";
  const backOnTab = await hostCommand(`memory backontab ${skillId}`);
  await until("the helper's answer", () => memoryReplies.find((x) => x.op.includes("onItsOwn")), 3000);
  await sleep(300);
  const afterBack = await memory();
  result.putBackOnTab = { sent: backOnTab.sent, helper: memoryReplies.find((x) => x.op.includes("onItsOwn")), hostProblem: afterBack.book.problems[skillId] ?? null };
  checks.putBackOnTabSentFromTheHost = backOnTab.sent === true;
  const r = await caretRun(intakeOf(await nextOrder()));
  checks.nextRunNeedsTabAfterPutBackOnTab = r.run.tab;
  await closeForm(r.windowId);
}

/** Drawn part 4: the next run starts with no Tab, and Esc takes it over at the caret. */
async function takeOverWithEsc(): Promise<void> {
  holdFirstStep = 4000;
  await nextOrder();
  const at = sent.length;
  const id = await openForm();
  await present(id);
  const started = await until("a run with no Tab", () => since("taskProgress", at).find((p) => p.unprompted === true), 8000);
  await until("its line at the caret", async () => {
    const s = await surface();
    return s.workingOn === started.taskId && s.unprompted === true ? s : null;
  }, 6000);
  await shot("on-its-own-2");
  checks.escTakenAtTheHost = await key("esc");
  holdFirstStep = 0;
  checks.escSentTakeOver = (await until("the take over at the helper", () => fromHost.find((x) => x.type === "taskControl" && x.detail === `takeOver ${started.taskId}`), 3000).catch(() => null)) !== null;
  const line = await until("the took-over line", async () => {
    const s = await surface();
    return (s.lineText ?? "").startsWith("You took over") ? s.lineText : null;
  }, 8000).catch(() => null);
  result.tookOver = { taskId: started.taskId, line };
  checks.tookOverLineShown = line !== null;
  await shot("took-over");
  // The executor stops at its next step boundary, after the held step, and only then does the run's
  // result put the skill back on Tab (skills.ts reset); 400 ms after Esc was too early (A16 VM run 2).
  const paused = await until("the helper's paused progress", () => since("taskProgress", at).find((p) => p.taskId === started.taskId && p.phase === "paused"), 10_000).catch(() => null);
  result.tookOverPaused = paused?.at ?? null;
  checks.takeOverPutTheSkillBackOnTab = (await until("the skill back on Tab", () => (skill()?.status === "learning" ? true : null), 3000).catch(() => false)) === true;
  await closeForm(id);
}

// Undrawn: the fixture and host never take the front. Drawn: once the fixture took it, nobody else did.
const foreign = DRAWN === null ? fronts.filter((f) => ours(f.pid)) : fronts.filter((f) => activatedAt !== null && f.at > activatedAt && f.at < (fronts.at(-1)?.at ?? 0) && !ours(f.pid));
result.frontSamples = fronts.length;
result.fixtureOrHostWasFront = DRAWN === null ? foreign.length > 0 : null;
result.otherAppTookTheFront = DRAWN === null ? null : foreign.length > 0;
result.drawn = DRAWN;
result.fixtureEnd = fixtureEnd;
result.fixtureErr = fixtureErr.split("\n").slice(-15);
// The host's own reading of Reduce Motion while it drew (null for a host that does not report it).
result.hostReduceMotion = DRAWN === null ? null : hostReduceMotion;
result.focusKeys = focusKeys;
result.announced = announced;
result.shots = shots;
result.stoppedBy = stoppedBy;
result.fromHost = fromHost.map((x) => `${x.type} ${x.detail}`);
result.memoryReplies = memoryReplies;
result.log = log.slice(-20);
result.hostLog = hostLog.split("\n").slice(-10);
result.ok = ok && foreign.length === 0 && stoppedBy === null;
// Drawn: VoiceOver's words for the three moments, as the host posted them (no VoiceOver needed).
if (DRAWN !== null) {
  const said = (start: string) => announced.some((x) => (x.text ?? "").startsWith(start));
  checks.announcedTheKeepQuestion = said("Keep this as ");
  checks.announcedThePromoteQuestion = said("Do this one on your own from now on?");
  checks.announcedOnItsOwn = said("On its own: ");
  checks.everyPictureTaken = ["keep", "promote", "on-its-own", "on-its-own-2", "took-over"].every((n) => typeof shots[n] === "string");
  result.ok = result.ok === true && checks.announcedTheKeepQuestion && checks.announcedThePromoteQuestion && checks.announcedOnItsOwn && checks.everyPictureTaken;
}
writeFileSync(join(OUT, "skills-walk.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ok: result.ok, error: result.error ?? null, checks, runs: runs.length }, null, 1));
process.exit(stoppedBy !== null ? 76 : result.ok ? 0 : 1);
