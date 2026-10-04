// Tab acts end to end (brief A12, part 2): an action offer taken with a real Tab runs in an app this
// script started, under an act grant, and the host shows the run, its toast, ⌘Z and Esc.
//
// Processes, all started here and only these signalled: the target (TextEdit on an untitled document,
// or Chrome on helper/fixtures/web/form.html with a temporary profile), the reader (caret-screen)
// WITHOUT --act-pids, and the built Caret host with its overlays drawn. The helper runs in this process
// with its real executor, offer registry and socket server; Jev is off, so plans name their targets
// exactly.
//
// How an offer gets in: the helper must know an offer for its offerAccept to run anything, so this
// script records the offer in the helper's registry with the plan an accept runs (as a producer
// does), then hands the same `action` line to the host through its debug socket (`inject helperLine`),
// which routes it exactly as a line from the helper socket. Everything after that is the real path:
// a real Tab at the HID level (fixture-keys, which refuses unless the target owns the frontmost app
// and the focused element) reaches the host's event tap; the host sends offerAccept; the helper
// grants, acts through the reader and revokes; the host shows progress and the toast.
//
// Per run: the value is read back from the target without the reader (TextEdit through ax-probe,
// Chrome through its page's own JavaScript over DevTools); the helper's actRevoke for the task is
// seen on the way to the reader; a second write under the task's id answers notAllowed and changes
// nothing; a real ⌘Z restores the field, read back again. Esc runs slow the plan's second step, wait
// for the working line to offer Esc, press a real Esc, and check the host's stopped line names the
// step and the field holds only the first step's write.
//
//   node apps/caret/scripts/act_end_to_end.ts --target textedit|chrome --out DIR
//        --bin <screen-reader build dir> --probe <ax-probe> --keys <fixture-keys> --caret <Caret binary>
//        [--runs 10] [--esc-runs 3] [--idle-min 300] [--shots DIR]
//
// --shots: screenshots come from the caller's own capture loop (a process macOS already approved for
// screen capture), which takes DIR/request's name and deletes the file; this script never captures.
//
// GUI gates (shared Mac, long-run SKILL.md): the caller holds gui.lock. HID idle must be at least
// --idle-min at the start; the run stops, closes its windows and reports `deferred: user active` as soon
// as an input that is not one of this script's own keys arrives. A QUIET-UNTIL in the future refuses.
// Keys are only ever posted through fixture-keys, which checks the frontmost app and the focused
// element's pid immediately before each key. This script's keys are told from a person's by time
// alone (HID idle against the windows when it posted): a person's input inside one of those windows,
// or while fixture-keys runs, is missed. Tagging events would need an event tap of its own.
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Helper } from "../../../helper/src/helper.ts";
import { HelperServer } from "../../../helper/src/server.ts";
import { Store } from "../../../helper/src/store.ts";
import type { Plan, Step, WindowSel } from "../../../helper/src/executor/schema.ts";
import { HelperMessage, PROTOCOL_VERSION, type OfferAccept, type OfferAction, type OfferStop, type RunPlan, type TaskControl, type TaskProgress, type VerbResult } from "../../../helper/src/protocol.ts";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const { values: a } = parseArgs({
  options: {
    target: { type: "string" },
    out: { type: "string" },
    bin: { type: "string" },
    probe: { type: "string" },
    keys: { type: "string" },
    caret: { type: "string" },
    chrome: { type: "string", default: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    runs: { type: "string", default: "10" },
    "esc-runs": { type: "string", default: "3" },
    "idle-min": { type: "string", default: "300" },
    /** A directory a screenshot server watches (the rig job's bash loop): this script asks it for shots. */
    shots: { type: "string" },
  },
});
const TARGET = a.target;
if (TARGET !== "textedit" && TARGET !== "chrome") throw new Error("--target is textedit or chrome");
for (const k of ["out", "bin", "probe", "keys", "caret"] as const) if (a[k] === undefined) throw new Error(`--${k} is required`);
const OUT = resolve(a.out as string);
mkdirSync(OUT, { recursive: true });
const BIN = resolve(a.bin as string);
const PROBE = resolve(a.probe as string);
const KEYS = resolve(a.keys as string);
const CARET = resolve(a.caret as string);
const RUNS = Number(a.runs);
const ESC_RUNS = Number(a["esc-runs"]);
const IDLE_MIN = Number(a["idle-min"]);
if (!Number.isInteger(RUNS) || !Number.isInteger(ESC_RUNS) || RUNS < 0 || ESC_RUNS < 0 || RUNS + ESC_RUNS === 0) throw new Error("--runs and --esc-runs are whole numbers, and at least one run is asked for");
if (!Number.isFinite(IDLE_MIN) || IDLE_MIN < 0) throw new Error("--idle-min is a number of seconds");
const FORM = resolve(ROOT, "helper", "fixtures", "web", "form.html");
const TEXTEDIT = "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SHOTS = a.shots === undefined ? null : resolve(a.shots);
/** Asks the capture loop for one screenshot and waits up to 3 s for it. */
async function shot(name: string): Promise<void> {
  if (SHOTS === null) return;
  const req = join(SHOTS, "request");
  writeFileSync(req, `${TARGET}-${name}`);
  for (let i = 0; i < 30 && existsSync(req); i++) await sleep(100);
}
const log: string[] = [];
const say = (l: string): void => {
  log.push(`${new Date().toISOString()} ${l}`);
  process.stdout.write(l + "\n");
};

// MARK: - processes this script started, and only those

const own = new Map<number, { label: string; proc: ChildProcess }>();
const tempDirs: string[] = [];
function started(label: string, proc: ChildProcess): number {
  const pid = proc.pid;
  if (pid === undefined || pid <= 1) throw new Error(`${label} did not start`);
  own.set(pid, { label, proc });
  say(`started ${label} pid ${pid}`);
  return pid;
}
function alive(pid: number): boolean {
  const st = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return st !== "" && !st.startsWith("Z");
}
function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone.
  }
}
/** Stops what this script started, waits up to 10 s, kills what is left, removes its own temp dirs. */
function finalCleanup(): void {
  for (const { proc } of own.values()) if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  for (const [pid, { proc }] of own) {
    if (proc.exitCode !== null || proc.signalCode !== null) continue;
    while (alive(pid) && Date.now() < deadline) spawnSync("/bin/sleep", ["0.2"]);
    if (alive(pid)) signal(pid, "SIGKILL");
  }
  own.clear();
  for (const d of tempDirs.splice(0)) {
    // Chrome's helpers carry the profile in their arguments; compared as text.
    const left = spawnSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((l) => l.includes(`--user-data-dir=${d}`))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((p) => p > 1);
    for (const p of left) signal(p, "SIGTERM");
    rmSync(d, { recursive: true, force: true });
  }
}
process.on("exit", finalCleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// MARK: - GUI gates

function quietUntil(): number {
  const p = join(homedir(), ".long-run", "QUIET-UNTIL");
  if (!existsSync(p)) return 0;
  return Number(readFileSync(p, "utf8").trim().split(/\s+/)[0]) || 0;
}
function hidIdleSeconds(): number {
  const out = spawnSync("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8" }).stdout;
  const m = /"HIDIdleTime" = (\d+)/.exec(out);
  if (m?.[1] === undefined) throw new Error("no HIDIdleTime in ioreg output");
  return Number(m[1]) / 1e9;
}
class Deferred extends Error {}
let deferred: string | null = null;
/** When this script's keys were posted, start to end: input inside one of these is its own. */
const ownKeys: { start: number; end: number }[] = [];
if (quietUntil() * 1000 > Date.now()) {
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ deferred: "quiet window" }) + "\n");
  console.log("deferred: quiet window");
  process.exit(3);
}
const idleAtStart = hidIdleSeconds();
if (idleAtStart < IDLE_MIN) {
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ deferred: `user active: HID idle ${idleAtStart.toFixed(0)} s < ${IDLE_MIN} s` }) + "\n");
  console.log("deferred: user active");
  process.exit(3);
}
const idleWatch = setInterval(() => {
  try {
    const s = hidIdleSeconds();
    const lastInputAt = Date.now() - s * 1000;
    // HIDIdleTime counts from the last input of any kind; the last input is ours only when it falls
    // inside one of our posts (with 300 ms for the event to land). Anything else is a person.
    const ours = ownKeys.some((k) => lastInputAt >= k.start - 100 && lastInputAt <= k.end + 300);
    if (s < 5 && !ours && deferred === null) {
      deferred = `HID idle dropped to ${s.toFixed(1)} s at ${new Date().toISOString()} with no key of this script's`;
      for (const { proc } of own.values()) proc.kill("SIGTERM");
    }
  } catch (e) {
    if (deferred === null) deferred = `cannot read HID idle: ${String(e)}`;
  }
}, 500);
function checkDeferred(): void {
  if (deferred !== null) throw new Deferred(deferred);
}
async function until<T>(what: string, ok: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 15_000, every = 100): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    checkDeferred();
    const v = await ok();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

/** On-screen windows over a point, front to back, as the host's gate reads them: owner, pid, layer,
 * alpha and bounds only (no pixels, no titles). Through JavaScript for Automation's CoreGraphics
 * bridge, which sends no Apple Event to any app. */
async function windowsAt(x: number, y: number): Promise<unknown> {
  const script = `ObjC.import("CoreGraphics"); ObjC.import("Foundation");
var l = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)); var o = [];
for (var i = 0; i < l.count; i++) { var w = l.objectAtIndex(i); var b = w.objectForKey("kCGWindowBounds");
  var X = b.objectForKey("X").doubleValue, Y = b.objectForKey("Y").doubleValue, W = b.objectForKey("Width").doubleValue, H = b.objectForKey("Height").doubleValue;
  if (X <= ${x} && ${x} <= X + W && Y <= ${y} && ${y} <= Y + H) o.push({ owner: ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")), pid: w.objectForKey("kCGWindowOwnerPID").intValue,
    layer: w.objectForKey("kCGWindowLayer").intValue, alpha: w.objectForKey("kCGWindowAlpha").doubleValue, bounds: [X, Y, W, H] }); }
JSON.stringify(o);`;
  try {
    return JSON.parse((await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script])).stdout) as unknown;
  } catch (e) {
    return String(e);
  }
}

/** The pid of LaunchServices' front application, the one that receives keys. */
async function frontPid(): Promise<number | null> {
  const asn = (await run("/usr/bin/lsappinfo", ["front"])).stdout.trim();
  if (asn === "") return null;
  const m = /=\s*(\d+)/.exec((await run("/usr/bin/lsappinfo", ["info", "-only", "pid", asn])).stdout);
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** Brings the target forward when it is not (or always, with `force`), and waits up to 3 s for
 * LaunchServices to agree. */
async function ensureFront(t: Target, force = false): Promise<void> {
  if (!force && (await frontPid()) === t.pid) return;
  await t.front();
  await until("the target to be the front app", async () => ((await frontPid()) === t.pid ? true : null), 3000).catch(async () => {
    throw new Deferred(`deferred: foreground (front app is pid ${await frontPid()}, not ${t.pid})`);
  });
}

/** One real key at the HID level, refused by fixture-keys unless `pid` owns the front app and the focus. */
async function key(pid: number, name: "tab" | "escape" | "cmd-z"): Promise<void> {
  checkDeferred();
  const post = { start: Date.now(), end: Number.POSITIVE_INFINITY };
  ownKeys.push(post);
  try {
    await run(KEYS, [String(pid), "key", name]);
  } catch (e) {
    const err = (e as { stderr?: string }).stderr ?? String(e);
    throw new Deferred(`deferred: foreground (fixture-keys ${name}: ${err.trim()})`);
  } finally {
    post.end = Date.now();
  }
}

// MARK: - the helper, in process

const progress: TaskProgress[] = [];
/** Grant messages for the reader, and whether the socket took each one. */
const toReader: { at: number; type: string; taskId?: string; sent: boolean }[] = [];
const fromHost: { at: number; m: OfferAccept | OfferStop | TaskControl | RunPlan }[] = [];
const errors: string[] = [];
/** Tasks whose second step waits, so Esc lands mid-run. */
const slow = new Set<string>();
const SLOW_MS = 5000;
const storeDir = mkdtempSync(join(tmpdir(), "caret-a12-store-"));
tempDirs.push(storeDir);
const sockDir = mkdtempSync(join(tmpdir(), "caret-a12-sock-"));
tempDirs.push(sockDir);
const HELPER_SOCK = join(sockDir, "helper.sock");
const HOST_SOCK = join(sockDir, "host.sock");
const store = new Store(storeDir);
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  askJev: null,
  shadow: false,
  allowBackgroundFocus: false,
  publish: (m: HelperMessage) => {
    if (m.type === "taskProgress") progress.push(m);
    if (m.type === "error") errors.push(m.message);
    server?.publish(m);
  },
  sendToReader: (m) => {
    const sent = server?.sendToReader(m) ?? false;
    if (m.type === "actGrant" || m.type === "actRevoke") toReader.push({ at: Date.now(), type: m.type, taskId: m.taskId, sent });
    return sent;
  },
  executorHooks: {
    beforeStep: async (taskId, step) => {
      if (slow.has(taskId) && step === 1) await sleep(SLOW_MS);
    },
  },
});
const origAccept = helper.handleOfferAccept.bind(helper);
helper.handleOfferAccept = (m) => (fromHost.push({ at: Date.now(), m }), origAccept(m));
const origStop = helper.handleOfferStop.bind(helper);
helper.handleOfferStop = (m) => (fromHost.push({ at: Date.now(), m }), origStop(m));
const origTask = helper.handleTask.bind(helper);
helper.handleTask = (m) => (fromHost.push({ at: Date.now(), m }), origTask(m));
server = new HelperServer(HELPER_SOCK, () => helper, (l) => errors.push(l));
await server.listen();
const tick = setInterval(() => helper.tick(), 250);

// MARK: - the host's debug socket

function hostCommand(command: string): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const c = createConnection(HOST_SOCK);
    let buf = "";
    const t = setTimeout(() => (c.destroy(), rej(new Error(`no answer to '${command.slice(0, 30)}'`))), 5000);
    c.on("connect", () => c.write(command + "\n"));
    c.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.includes("\n")) {
        clearTimeout(t);
        c.end();
        res(JSON.parse(buf) as Record<string, unknown>);
      }
    });
    c.on("error", (e) => (clearTimeout(t), rej(e)));
  });
}
interface Surface {
  lastAccepted?: { offerKey?: string };
  offerKey?: string;
  kind?: string;
  lineText?: string;
  working?: number;
  workingOn?: string;
  toast?: { kind: string; caption: string; grantID?: number };
}
const surface = async (): Promise<Surface> => ((await hostCommand("state")).surface ?? {}) as Surface;

/** Counters that say why a line left: hidden by its watch, stopped, corrected, or a new offer drawn. */
const LINE_COUNTERS = /^surface\.(lineHidden|workStopped|stop\.|withdrawn|shown|progress|held|toast|undo)/;

/** On-screen windows over `frame` (any overlap), front to back: owner, pid, layer, alpha, bounds. */
async function windowsOver(frame: [number, number, number, number]): Promise<unknown> {
  const [fx, fy, fw, fh] = frame;
  const script = `ObjC.import("CoreGraphics"); ObjC.import("Foundation");
var l = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)); var o = [];
for (var i = 0; i < l.count; i++) { var w = l.objectAtIndex(i); var b = w.objectForKey("kCGWindowBounds");
  var X = b.objectForKey("X").doubleValue, Y = b.objectForKey("Y").doubleValue, W = b.objectForKey("Width").doubleValue, H = b.objectForKey("Height").doubleValue;
  if (X < ${fx + fw} && ${fx} < X + W && Y < ${fy + fh} && ${fy} < Y + H) o.push({ owner: ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")), pid: w.objectForKey("kCGWindowOwnerPID").intValue,
    layer: w.objectForKey("kCGWindowLayer").intValue, alpha: w.objectForKey("kCGWindowAlpha").doubleValue, bounds: [X, Y, W, H] }); }
JSON.stringify(o);`;
  try {
    return JSON.parse((await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script])).stdout) as unknown;
  } catch (e) {
    return String(e);
  }
}

/**
 * Samples the host every 100 ms until stopped: its line, the work it runs, and the counters above,
 * plus the windows over the field whenever a counter moved. An Esc run writes this beside its row, so
 * a failure says which path took the line down instead of leaving only "gone 200 ms later" (A14).
 */
function sampleHost(frame: [number, number, number, number]): { stop: () => Promise<unknown[]> } {
  const t0 = Date.now();
  const rows: unknown[] = [];
  let on = true;
  let last: Record<string, number> = {};
  const loop = (async () => {
    while (on) {
      try {
        const st = await hostCommand("state");
        const s = (st.surface ?? {}) as Surface;
        const all = (st.counters ?? {}) as Record<string, number>;
        const counters = Object.fromEntries(Object.entries(all).filter(([k]) => LINE_COUNTERS.test(k)));
        const moved = Object.entries(counters).filter(([k, v]) => last[k] !== v).map(([k, v]) => `${k}=${v}`);
        const row: Record<string, unknown> = { ms: Date.now() - t0, lineText: s.lineText ?? null, workingOn: s.workingOn ?? null, working: s.working ?? null, toast: s.toast?.caption ?? null };
        if (moved.length > 0 && Object.keys(last).length > 0) {
          row.moved = moved;
          row.windows = await windowsOver(frame);
        }
        last = counters;
        rows.push(row);
      } catch (e) {
        rows.push({ ms: Date.now() - t0, error: String(e) });
      }
      await sleep(100);
    }
  })();
  return { stop: async () => ((on = false), await loop, rows) };
}

// MARK: - targets

interface Target {
  pid: number;
  app: string;
  /** The plan's window, as the executor binds it. */
  win: WindowSel;
  titlePrefix: string;
  /** The field the offer is shown at and that the run writes first: its name in `read()`. */
  first: string;
  reset(): Promise<void>;
  /** Puts focus in the first field, as the user would be there. */
  focus(): Promise<void>;
  /** Brings this script's own app to the front the normal way (never an AX frontmost write). */
  front(): Promise<void>;
  read(): Promise<Record<string, string>>;
  plan(r: number, steps: 1 | 3): { plan: Plan; slots: Record<string, string>; want: Record<string, string>; afterFirst: Record<string, string> };
  stop(): Promise<void>;
}

const node = (win: WindowSel, role: string, label: string | undefined, value: string, says: string): Step => ({
  says,
  end: { kind: "valueEquals", window: win, target: { role, ...(label === undefined ? {} : { label }), describe: `the ${label ?? "document"} field` }, value },
});

async function texteditTarget(): Promise<Target> {
  const te = spawn(TEXTEDIT, ["-NSShowAppCentricOpenPanelInsteadOfUntitledFile", "NO", "-ApplePersistenceIgnoreState", "YES", "-NSQuitAlwaysKeepsWindows", "NO"], { stdio: "ignore" });
  const pid = started("textedit", te);
  const probe = async (...args: string[]): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse((await run(PROBE, [args[0] ?? "", String(pid), ...args.slice(1)])).stdout) as Record<string, unknown>;
    } catch (e) {
      const so = (e as { stdout?: string }).stdout;
      return so !== undefined && so.startsWith("{") ? (JSON.parse(so) as Record<string, unknown>) : { ok: false, error: String(e) };
    }
  };
  const TITLE = "Untitled";
  await until("TextEdit's untitled window", async () => (await probe("text", TITLE)).ok === true, 30_000);
  const win: WindowSel = { bundleId: "com.apple.TextEdit", titleStartsWith: TITLE };
  return {
    pid,
    app: "TextEdit",
    win,
    titlePrefix: TITLE,
    first: "body",
    reset: async () => {
      const r = await probe("set-text", TITLE, "");
      if (r.ok !== true) throw new Error(`probe reset: ${JSON.stringify(r)}`);
    },
    // A new document's text view has the focus from launch.
    focus: async () => undefined,
    // LaunchServices activation by bundle id, only while the one TextEdit running is this script's,
    // so it can never bring the user's own TextEdit forward.
    front: async () => {
      const { stdout } = await run("/usr/bin/pgrep", ["-x", "TextEdit"]).catch(() => ({ stdout: "" }));
      const pids = stdout.split("\n").filter((l) => l.trim() !== "").map(Number);
      if (pids.length !== 1 || pids[0] !== pid) throw new Deferred(`deferred: foreground (TextEdit processes ${JSON.stringify(pids)}, this script's is ${pid})`);
      await run("/usr/bin/open", ["-b", "com.apple.TextEdit"]);
      // Activation alone left the document window behind other apps' windows when TextEdit was
      // launched from the background (the host then held every offer as covered, A12 desktop run 1).
      // TextEdit's own Window menu raises it.
      const raised = await probe("menu", "Window", "Bring All to Front");
      if (raised.ok !== true) throw new Error(`Bring All to Front: ${JSON.stringify(raised)}`);
    },
    read: async () => {
      const r = await probe("text", TITLE);
      if (r.ok !== true) throw new Error(`probe text: ${JSON.stringify(r)}`);
      return { body: String(r.value ?? "") };
    },
    plan: (r, steps) => {
      const one = `Notes for Thursday, item ${r}`;
      const two = `${one}\nSecond line ${r}`;
      const three = `${two}\nThird line ${r}`;
      const ss = steps === 1 ? [node(win, "AXTextArea", undefined, one, "The document says the note")] : [one, two, three].map((v, i) => node(win, "AXTextArea", undefined, v, `The document has ${i + 1} line${i === 0 ? "" : "s"}`));
      return {
        plan: { id: `a12-te-${steps}`, title: "Write the note", slots: {}, steps: ss },
        slots: {},
        want: { body: steps === 1 ? one : three },
        afterFirst: { body: one },
      };
    },
    stop: async () => {
      te.kill("SIGTERM");
      await until("TextEdit to exit", () => te.exitCode !== null || te.signalCode !== null, 10_000).catch(() => te.kill("SIGKILL"));
    },
  };
}

/** A minimal Chrome DevTools Protocol client over Node's WebSocket. */
class Cdp {
  private n = 0;
  private readonly pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private readonly ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error !== undefined) p?.fail(new Error(m.error.message));
      else p?.ok(m.result);
    });
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => (ws.close(), rej(new Error(`no DevTools connection to ${url}`))), 15_000);
      ws.addEventListener("open", () => (clearTimeout(t), res(new Cdp(ws))));
      ws.addEventListener("error", () => (clearTimeout(t), rej(new Error(`cannot reach ${url}`))));
    });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = ++this.n;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    return new Promise((ok, fail) => {
      const t = setTimeout(() => (this.pending.delete(id), fail(new Error(`no DevTools answer to ${method}`))), 15_000);
      this.pending.set(id, { ok: (v) => (clearTimeout(t), ok(v)), fail: (e) => (clearTimeout(t), fail(e)) });
    });
  }
  close(): void {
    this.ws.close();
  }
}

async function chromeTarget(): Promise<Target> {
  const profile = mkdtempSync(join(tmpdir(), "caret-a12-chrome-"));
  tempDirs.push(profile);
  const chrome = spawn(a.chrome as string, [
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--use-mock-keychain",
    "--remote-debugging-port=0", "--disable-extensions", "--disable-background-networking", "--new-window", pathToFileURL(FORM).href,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const pid = started("chrome", chrome);
  const portFile = join(profile, "DevToolsActivePort");
  await until("Chrome's DevTools port", () => existsSync(portFile), 30_000);
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
  let session: string | null = null;
  const js = async (expr: string): Promise<unknown> => {
    if (session === null) {
      const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
      const t = targetInfos.find((x) => x.type === "page" && x.url.startsWith("file:"));
      if (t === undefined) throw new Error("no page with the form");
      session = ((await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })) as { sessionId: string }).sessionId;
    }
    const r = (await cdp.send("Runtime.evaluate", { expression: `JSON.stringify(${expr})`, returnByValue: true }, session)) as { result: { value?: string }; exceptionDetails?: unknown };
    if (r.exceptionDetails !== undefined || r.result.value === undefined) throw new Error(`chrome: ${JSON.stringify(r.exceptionDetails ?? r.result)}`);
    return JSON.parse(r.result.value) as unknown;
  };
  await until("the page to load", async () => {
    try {
      return (await js("typeof caretState")) === "function";
    } catch {
      return false;
    }
  }, 30_000);
  const win: WindowSel = { titleStartsWith: "Caret Form — Web" };
  const names = ["Dana Whitfield", "Priya Raman", "Marcus Lowe", "Ines Okafor", "Tomas Brandt"];
  return {
    pid,
    app: "Google Chrome",
    win,
    titlePrefix: "Caret Form — Web",
    first: "name",
    reset: async () => void (await js("caretReset()")),
    focus: async () => void (await js("(document.getElementById('name').focus(), true)")),
    // DevTools on this script's own profile: Chrome raises its window and activates itself.
    front: async () => {
      const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
      const page = targetInfos.find((x) => x.type === "page" && x.url.startsWith("file:"));
      if (page === undefined) throw new Error("no page with the form");
      await cdp.send("Target.activateTarget", { targetId: page.targetId });
    },
    read: async () => {
      const s = (await js("caretState()")) as { fields: Record<string, string> };
      return { name: s.fields.name ?? "", email: s.fields.email ?? "", notes: s.fields.notes ?? "" };
    },
    plan: (r, steps) => {
      const name = names[r % names.length] as string;
      const email = `${name.split(" ")[0]?.toLowerCase()}.${r}@example.com`;
      const notes = `Call back about order ORD-2026-${48200 + r}`;
      const all = [
        node(win, "AXTextField", "Name", name, "Name holds the name"),
        node(win, "AXTextField", "Email", email, "Email holds the address"),
        node(win, "AXTextArea", "Notes", notes, "Notes hold the note"),
      ];
      return {
        plan: { id: `a12-chrome-${steps}`, title: "Fill the contact fields", slots: {}, steps: steps === 1 ? all.slice(0, 1) : all },
        slots: {},
        want: steps === 1 ? { name, email: "", notes: "" } : { name, email, notes },
        afterFirst: { name, email: "", notes: "" },
      };
    },
    stop: async () => {
      cdp.close();
      chrome.kill("SIGTERM");
      await until("Chrome to exit", () => chrome.exitCode !== null || chrome.signalCode !== null, 15_000).catch(() => chrome.kill("SIGKILL"));
    },
  };
}

// MARK: - start everything

interface Row {
  kind: "tab" | "esc";
  run: number;
  shown: boolean;
  accepted: boolean;
  outcome: string;
  readBack: Record<string, string>;
  valueOk: boolean;
  revoked: boolean;
  secondAct: string;
  secondActDetail: string | null;
  secondActChanged: boolean;
  toast: string | null;
  undoOk: boolean | null;
  afterUndo: Record<string, string> | null;
  stoppedLine: string | null;
  stopOk: boolean | null;
  ms: number;
  problem: string | null;
}
const rows: Row[] = [];
let target: Target | null = null;
let hostLog = "";
let readerLog = "";
const result: Record<string, unknown> = { target: TARGET, startedAt: new Date().toISOString(), idleAtStart, runs: RUNS, escRuns: ESC_RUNS };

try {
  target = TARGET === "textedit" ? await texteditTarget() : await chromeTarget();
  const t = target;
  const reader = spawn(join(BIN, "caret-screen"), ["--socket", HELPER_SOCK, "--only-pids", String(t.pid), "--event-pids", String(t.pid)]);
  started("reader (no --act-pids)", reader);
  reader.stderr.setEncoding("utf8");
  reader.stderr.on("data", (d: string) => (readerLog += d));
  const settings = join(sockDir, "settings.json");
  const host = spawn(CARET, [
    "--helper-socket", HELPER_SOCK, "--socket", HOST_SOCK, "--no-ghost", "--perch", "hidden", "--allow-pids", String(t.pid),
    "--test-hooks", "--status-item", "off", "--onboarding", "off", "--settings", settings,
  ]);
  started("caret host", host);
  host.stderr?.setEncoding("utf8");
  host.stderr?.on("data", (d: string) => (hostLog += d));
  await until("the host's socket", () => existsSync(HOST_SOCK), 15_000);
  await until("the host on the helper", async () => (((await hostCommand("state")).helper as { connected?: boolean } | undefined)?.connected === true ? true : null), 15_000, 200);
  const windowOf = () => [...helper.model.windows.values()].find((w) => w.app.pid === t.pid && w.window.title.startsWith(t.titlePrefix));
  await until("the target window in the screen model", () => windowOf(), 30_000);
  await t.focus();
  const fieldRole = TARGET === "textedit" ? "AXTextArea" : "AXTextField";
  /** The focused field as the reader last read it. */
  const focused = () => {
    const w = windowOf();
    if (w === undefined || w.focusedKey === null) return undefined;
    const n = w.nodes.get(w.focusedKey);
    return n !== undefined && n.role === fieldRole && n.frame !== undefined ? { w, n } : undefined;
  };
  await until("the focused field in the screen model", () => focused(), 30_000);
  // The target must own the front app and the focus before any key; fixture-keys checks without posting.
  await ensureFront(t, true);
  await t.focus();
  try {
    await run(KEYS, [String(t.pid), "check"]);
  } catch (e) {
    throw new Deferred(`deferred: foreground (${((e as { stderr?: string }).stderr ?? String(e)).trim()})`);
  }
  await t.reset();
  await sleep(500);

  const offerKeyFor = (kind: string, r: number) => `a12-${TARGET}-${kind}-${r}`;
  const doRun = async (kind: "tab" | "esc", r: number): Promise<void> => {
    checkDeferred();
    const row: Row = { kind, run: r, shown: false, accepted: false, outcome: "", readBack: {}, valueOk: false, revoked: false, secondAct: "", secondActDetail: null, secondActChanged: false, toast: null, undoOk: null, afterUndo: null, stoppedLine: null, stopOk: null, ms: 0, problem: null };
    rows.push(row);
    const t0 = Date.now();
    let sampler: { stop: () => Promise<unknown[]> } | null = null;
    try {
      await ensureFront(t);
      await t.reset();
      await t.focus();
      await sleep(400);
      const valuesBefore = await t.read();
      const f = await until("the focused field", () => focused(), 10_000);
      const { plan, want, afterFirst } = t.plan(r, kind === "tab" ? 1 : 3);
      const offerKey = offerKeyFor(kind, r);
      if (kind === "esc") slow.add(offerKey);
      if (kind === "esc" && f.n.frame !== undefined) sampler = sampleHost(f.n.frame as [number, number, number, number]);
      const msg: OfferAction = {
        type: "action",
        v: PROTOCOL_VERSION,
        offerKey,
        at: Date.now(),
        field: { pid: t.pid, windowId: f.w.window.windowId, key: f.n.key, frame: f.n.frame ?? null, window: { number: f.w.window.number ?? null, title: f.w.window.title } },
        app: t.app,
        endState: { text: plan.title, ref: { rule: "a12Harness", derived: [{ node: `${f.w.window.windowId}/${f.n.key}` }] } },
        actions: [{ id: "run", label: "Do it", key: "tab" }],
      };
      HelperMessage.parse(msg);
      helper.offers.record(msg, () => helper.executor.run(offerKey, plan, {}, undefined, { grant: true }));
      const injected = await hostCommand(`inject ${JSON.stringify({ kind: "helperLine", line: msg })}`);
      if (injected.ok !== true) throw new Error(`inject: ${JSON.stringify(injected)}`);
      await until("the action line on the host", async () => ((await surface()).offerKey === offerKey ? true : null), 8000).catch(async (e: unknown) => {
        // What the host saw instead: its focus, surface and counters, beside the field the offer named.
        const fr = msg.field.frame ?? [0, 0, 0, 0];
        writeFileSync(join(OUT, `diag-${kind}-${r}.json`), JSON.stringify({ field: msg.field, windowsAtField: await windowsAt(fr[0] + fr[2] / 2, fr[1] + fr[3] / 2), host: await hostCommand("state").catch(String) }, null, 1) + "\n");
        throw e;
      });
      row.shown = true;
      if (r === 0) await shot(`${kind}-offer`);
      await key(t.pid, "tab");
      await until("offerAccept at the helper", () => fromHost.find((x) => "actionId" in x.m && x.m.offerId === offerKey), 5000);
      row.accepted = true;
      const ended = (phases: string[]) => progress.find((p) => p.taskId === offerKey && phases.includes(p.phase));
      /** The run's grant is gone: the last grant message for the task that reached the reader is a
       * revoke, and a write under the task's id is refused and changes nothing. Checked right after
       * the run ends, before ⌘Z, whose own grant and revoke could otherwise hide a missing one. */
      const checkRevoked = async (): Promise<void> => {
        row.revoked = await until("actRevoke for the task", () => {
          const sent = toReader.filter((x) => x.taskId === offerKey && x.sent);
          return sent.length > 0 && sent.at(-1)?.type === "actRevoke";
        }, 5000).then(() => true, () => false);
        const w = windowOf();
        const n = w?.nodes.get(f.n.key);
        if (w === undefined || n === undefined) {
          row.secondAct = "field gone";
          return;
        }
        const now = await t.read();
        const res: VerbResult = await helper.readerVerb({ kind: "write", pid: t.pid, windowId: w.window.windowId, key: n.key, role: n.role, attribute: "value", expect: n.value ?? "", value: "SHOULD NOT APPEAR", taskId: offerKey });
        row.secondAct = res.outcome;
        row.secondActDetail = res.detail;
        await sleep(200);
        row.secondActChanged = JSON.stringify(await t.read()) !== JSON.stringify(now);
      };
      if (kind === "esc") {
        // One snapshot per poll, and it must be this task's working line.
        await until("the working line to offer Esc", async () => {
          const x = await surface();
          return x.workingOn === offerKey && (x.working ?? 0) >= 3.2 ? x : null;
        }, 10_000);
        if (r === 0) await shot("esc-working");
        await key(t.pid, "escape");
        await until("the stopped line", async () => {
          const x = await surface();
          return x.workingOn === undefined && /^(You stopped|Stopped)/.test(x.lineText ?? "") ? x : null;
        }, 8000);
        const end = await until("the run to end", () => ended(["stopped", "done"]), 10_000);
        row.outcome = end.phase === "stopped" ? `stopped:${end.stopReason}` : end.phase;
        // The helper's own ending may correct the step the line named; read the line after it.
        await sleep(200);
        row.stoppedLine = (await surface()).lineText ?? null;
        if (r === 0) await shot("esc-stopped");
        await sleep(200);
        row.readBack = await t.read();
        row.valueOk = JSON.stringify(row.readBack) === JSON.stringify(afterFirst);
        row.stopOk = end.phase === "stopped" && end.stopReason === "you" && end.step === 1 && row.stoppedLine === "You stopped it before step 2 of 3";
        await checkRevoked();
      } else {
        const end = await until("the run to end", () => ended(["stopped", "done", "handoff", "paused"]), 15_000);
        row.outcome = end.phase === "stopped" ? `stopped:${end.stopReason}` : end.phase;
        await sleep(300);
        row.readBack = await t.read();
        row.valueOk = end.phase === "done" && JSON.stringify(row.readBack) === JSON.stringify(want);
        // This task's toast: the host's last accept is this offer and its toast holds an undo grant.
        const s = await until("the toast", async () => {
          const x = await surface();
          return x.toast?.grantID !== undefined && x.lastAccepted?.offerKey === offerKey ? x : null;
        }, 4000).catch(() => null);
        row.toast = s?.toast?.caption ?? null;
        await checkRevoked();
        if (row.toast !== null) {
          // ⌘Z first: the toast lives 5 s. The screenshot of the first run's toast is quick, and
          // the toast is checked again before the key.
          if (r === 0) await shot("tab-toast");
          const still = await surface();
          if (still.toast?.grantID === undefined) throw new Error("the toast ended before ⌘Z");
          const before = toReader.length;
          await key(t.pid, "cmd-z");
          await until("the undo at the helper", () => fromHost.find((x) => "action" in x.m && x.m.taskId === offerKey && x.m.action === "undo"), 5000);
          const undone = await until("the undone progress", () => progress.find((p) => p.taskId === offerKey && p.phase === "undone"), 15_000);
          await sleep(300);
          row.afterUndo = await t.read();
          if (r === 0) await shot("tab-undone");
          // Undo acts under a grant of its own, revoked when it ends.
          const undoGrants = toReader.slice(before).filter((x) => x.taskId === offerKey && x.sent).map((x) => x.type);
          row.undoOk = JSON.stringify(row.afterUndo) === JSON.stringify(valuesBefore) && (undone.restored ?? 0) >= 1 && undone.notRestored === 0
            && undoGrants[0] === "actGrant" && undoGrants.at(-1) === "actRevoke";
        }
      }
    } catch (e) {
      if (e instanceof Deferred) throw e;
      row.problem = e instanceof Error ? e.message : String(e);
    } finally {
      row.ms = Date.now() - t0;
      if (sampler !== null) {
        // The line lives 3 s after the helper's ending; sample past it so its exit is on record.
        await sleep(3500);
        writeFileSync(join(OUT, `timeline-${kind}-${r}.json`), JSON.stringify(await sampler.stop(), null, 1) + "\n");
      }
      say(`${kind} ${r}: shown ${row.shown} accepted ${row.accepted} ${row.outcome} value ${row.valueOk} revoked ${row.revoked} second ${row.secondAct}${row.secondActChanged ? " CHANGED" : ""} toast '${row.toast}' undo ${row.undoOk} stop '${row.stoppedLine}'${row.problem === null ? "" : ` PROBLEM ${row.problem}`}`);
      // The host's line and toast go before the next offer.
      await sleep(kind === "esc" ? 2500 : 2500);
    }
  };
  for (let r = 0; r < RUNS; r++) await doRun("tab", r);
  for (let r = 0; r < ESC_RUNS; r++) await doRun("esc", r);
} catch (e) {
  if (e instanceof Deferred || deferred !== null) result.deferred = deferred ?? (e as Error).message;
  else result.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
} finally {
  clearInterval(idleWatch);
  clearInterval(tick);
  await target?.stop().catch(() => undefined);
  await server?.close().catch(() => undefined);
  store.close();
  finalCleanup();
}

const tabs = rows.filter((r) => r.kind === "tab");
const escs = rows.filter((r) => r.kind === "esc");
const count = (xs: Row[], f: (r: Row) => boolean): string => `${xs.filter(f).length}/${xs.length}`;
result.table = {
  valueReadBack: count(tabs, (r) => r.valueOk),
  revokedAfter: count(rows, (r) => r.revoked),
  secondActNotAllowed: count(rows, (r) => r.secondAct === "notAllowed" && !r.secondActChanged),
  toastWithUndo: count(tabs, (r) => r.toast !== null),
  undoRestored: count(tabs, (r) => r.undoOk === true),
  escStopsAndNamesStep: count(escs, (r) => r.stopOk === true && r.valueOk),
};
result.rows = rows;
result.errors = errors.slice(0, 50);
result.finishedAt = new Date().toISOString();
writeFileSync(join(OUT, "results.json"), JSON.stringify(result, null, 2) + "\n");
writeFileSync(join(OUT, "run.log"), log.join("\n") + "\n");
writeFileSync(join(OUT, "host.log"), hostLog);
writeFileSync(join(OUT, "reader.log"), readerLog);
say(JSON.stringify(result.table));
const ok = result.deferred === undefined && result.error === undefined && rows.length === RUNS + ESC_RUNS
  && rows.every((r) => r.problem === null && r.valueOk && r.revoked && r.secondAct === "notAllowed" && !r.secondActChanged)
  && tabs.every((r) => r.undoOk === true) && escs.every((r) => r.stopOk === true);
process.exit(result.deferred !== undefined ? 3 : ok ? 0 : 1);
