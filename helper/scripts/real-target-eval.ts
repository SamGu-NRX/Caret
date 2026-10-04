// The executor in real apps that this script starts itself (brief B15), with the reader started without
// --act-pids, so every act goes through an act grant:
//   textedit  a new TextEdit process (direct exec) on a fresh untitled document
//   webkit    caret-fixture's WKWebView window showing fixtures/web/form.html
//   chromium  Google Chrome (direct exec) with a temporary --user-data-dir, on the same form by file:// URL
//   electron  a minimal Electron app (fixtures/electron/main.cjs) run from a temporary directory on the same
//             form, from an Electron installed by scripts/electron-setup.sh into --electron DIR (B20)
//
//   node scripts/real-target-eval.ts --target T --bin ../apps/screen-reader/.build/debug --probe PATH --out DIR
//        [--runs 20] [--safety-runs 10] [--means-runs 10] [--plans a,b] [--background | --front]
//        [--electron DIR] [--candidates PATH] [--responder]
//
// --candidates (web targets) adds B20's table of ways to write a field whose window is not key, each tried
// alone by experiments/write-candidates.swift, built at PATH, and read back from the page. --responder
// (webkit) makes the WebKit window's web view its first responder without making the window key, as a
// browser left in the background holds it, before anything runs.
//
// --background puts this script's own bystander fixture in front (started with --foreground, then
// `activate legacy`), so the target's window is not key while the executor acts, as for a form the user
// is not looking at. --front (webkit only) starts the WebKit fixture with --foreground, activates it and
// makes its WebKit window key, as Chrome and TextEdit are when launched. The means table runs each reader
// means alone, N times, read back from the target.
//
// Per plan and run: reset the target, seed prior values, run the plan the way an accepted offer runs it
// (with a grant), read the target's true state (the page's own JavaScript, or for TextEdit the probe's
// separate Accessibility read), rerun and count acts, undo and read again. Then the safety cases: acts
// under a grant for another process, an expired grant, and a grant for another window of the same app,
// each read back from the target. Only processes this script started are ever signalled, and Chrome's
// temporary profile is deleted at the end. It opens windows, so the caller holds gui.lock and checks the
// GUI gates first; this script stops, closes its windows and reports `deferred: user active` as soon as
// HID idle drops under 5 s. Needs CARET_ENV_FILE for Jev (the shipping plan's ambiguous targets).
import { execFile, spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { loadJevKey, makeJevClient, type AskJev } from "../src/fill/jev.ts";
import type { Plan, Step, WindowSel } from "../src/executor/schema.ts";
import type { TaskResult, UndoResult } from "../src/executor/executor.ts";
import { GRANT_MAX_MS, PROTOCOL_VERSION, type AppSwitch, type HelperMessage, type ReaderVerb, type TaskProgress, type VerbResult } from "../src/protocol.ts";
import { Cdp } from "./cdp.ts";
import { fixtureExecutable } from "./fixture-path.ts";
import { userInput } from "./synthetic-input.ts";
import { newLaunchSecret, sendSecret } from "../src/launch.ts";
/** The secret caret-screen gets on its standard input and the in-process helper proves itself with (B23). */
const launchSecret = newLaunchSecret();

const run = promisify(execFile);
const { values: a } = parseArgs({
  options: {
    target: { type: "string" },
    bin: { type: "string" },
    probe: { type: "string" },
    out: { type: "string" },
    runs: { type: "string", default: "20" },
    "safety-runs": { type: "string", default: "10" },
    "means-runs": { type: "string", default: "10" },
    background: { type: "boolean", default: false },
    front: { type: "boolean", default: false },
    plans: { type: "string" },
    electron: { type: "string" },
    candidates: { type: "string" },
    responder: { type: "boolean", default: false },
  },
});
const TARGET = a.target;
if (TARGET !== "textedit" && TARGET !== "webkit" && TARGET !== "chromium" && TARGET !== "electron") throw new Error("--target is textedit, webkit, chromium or electron");
if (TARGET === "electron" && a.electron === undefined) throw new Error("--target electron needs --electron DIR (scripts/electron-setup.sh)");
if (a.bin === undefined || a.out === undefined || a.probe === undefined) throw new Error("--bin, --probe and --out are required");
const BIN = resolve(a.bin);
const PROBE = resolve(a.probe);
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const RUNS = Number(a.runs);
const SAFETY_RUNS = Number(a["safety-runs"]);
const MEANS_RUNS = Number(a["means-runs"]);
const BACKGROUND = a.background === true;
const FRONT = a.front === true;
if (FRONT && (BACKGROUND || TARGET !== "webkit")) throw new Error("--front is for --target webkit, without --background");
const RESPONDER = a.responder === true;
if (RESPONDER && TARGET !== "webkit") throw new Error("--responder is for --target webkit");
const CANDIDATES = a.candidates === undefined ? null : resolve(a.candidates);
if (CANDIDATES !== null && TARGET === "textedit") throw new Error("--candidates is for the web targets");
const FORM = resolve(import.meta.dirname, "../fixtures/web/form.html");
const TEXTEDIT = "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ELECTRON_MAIN = resolve(import.meta.dirname, "../fixtures/electron/main.cjs");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const t0 = Date.now();
  while (!(await ok())) {
    checkAbort();
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};

// MARK: - processes this script started, and only those

const own = new Map<number, { label: string; proc: ChildProcess }>();
/** Directories this script created; Chrome's profile among them. Nothing else is ever deleted. */
const tempDirs: string[] = [];
function started(label: string, proc: ChildProcess): number {
  const pid = proc.pid;
  if (pid === undefined || pid <= 1) throw new Error(`${label} did not start`);
  own.set(pid, { label, proc });
  // After an abort no window of this script may stay open, including one launched while it was decided.
  if (aborted !== null) {
    proc.kill("SIGTERM");
    throw new Aborted(aborted);
  }
  return pid;
}
function stopAll(): void {
  for (const { proc } of own.values()) if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
}
/** True while `pid` exists and is not a zombie. Synchronous, for the exit handler, where no events arrive. */
function alive(pid: number): boolean {
  const st = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return st !== "" && !st.startsWith("Z");
}
/**
 * Stops every process this script started, waits up to 10 s for them, kills what is left of them, then
 * stops any process still carrying one of this script's temporary directories in its arguments (Chrome's
 * helpers) and deletes those directories. Synchronous and idempotent, so the exit handler runs it on every
 * way out, an exception included.
 */
function finalCleanup(): void {
  stopAll();
  const deadline = Date.now() + 10_000;
  for (const [pid, { proc }] of own) {
    // A child Node has already reaped may have handed its pid to another process: never signal it again.
    if (proc.exitCode !== null || proc.signalCode !== null) continue;
    while (alive(pid) && Date.now() < deadline) spawnSync("/bin/sleep", ["0.2"]);
    if (alive(pid)) signal(pid, "SIGKILL");
  }
  const killed = Date.now() + 2000;
  while ([...own.keys()].some(alive) && Date.now() < killed) spawnSync("/bin/sleep", ["0.2"]);
  // A folder is deleted only when no process this script started is left.
  const ownLeft = [...own.keys()].some(alive);
  own.clear();
  for (const d of tempDirs.splice(0)) {
    // Chrome's helpers name the profile as --user-data-dir=<d>; compared as text, not as a pattern.
    const left = spawnSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((l) => l.includes(`--user-data-dir=${d}`))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((p) => p > 1);
    for (const p of left) signal(p, "SIGTERM");
    leftoverHelpers += left.length;
    // Deleted only once nothing that used it is left; otherwise kept, and named in the report.
    const until = Date.now() + 5000;
    while (left.some(alive) && Date.now() < until) spawnSync("/bin/sleep", ["0.2"]);
    if (ownLeft || left.some(alive)) keptDirs.push(d);
    else rmSync(d, { recursive: true, force: true });
  }
}
/** A process that has exited meanwhile is not an error during cleanup. */
function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // ESRCH: already gone.
  }
}
let leftoverHelpers = 0;
/** Temporary directories left in place because a process that used them did not exit in time. */
const keptDirs: string[] = [];
process.on("exit", finalCleanup);
// Ctrl-C or a kill from the wrapper: leave through exit, so the cleanup above runs.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.on("uncaughtException", (e) => {
  if (e instanceof Aborted) {
    // Someone used the Mac before the runs began: nothing was measured.
    writeFileSync(join(OUT, "real-target-eval.md"), `# Executor on ${TARGET}\n\n**deferred: user active**: ${e.message}, during startup. Nothing was measured.\n`);
    process.exit(3);
  }
  process.stderr.write(`real-target-eval: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});

// MARK: - the GUI gate while running: abort as soon as someone uses the Mac

let aborted: string | null = null;
async function hidIdleSeconds(): Promise<number> {
  const { stdout } = await run("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"]);
  const m = /"HIDIdleTime" = (\d+)/.exec(stdout);
  if (m?.[1] === undefined) throw new Error("no HIDIdleTime in ioreg output");
  return Number(m[1]) / 1e9;
}
const idleWatch = setInterval(() => {
  void hidIdleSeconds()
    .then(
      (s) => {
        // The write candidates post input to the target, which resets HID idle too; only input after it is someone's.
        if (s < 5 && userInput(s) && aborted === null) aborted = `HID idle dropped to ${s.toFixed(1)} s at ${new Date().toISOString()}`;
      },
      (e: unknown) => {
        if (aborted === null) aborted = `cannot read HID idle (${String(e)}), so whether someone is using the Mac is unknown`;
      },
    )
    .then(() => {
      if (aborted !== null) stopAll();
    });
}, 1000);
function checkAbort(): void {
  if (aborted !== null) throw new Aborted(aborted);
}

/** The frontmost app's pid as LaunchServices has it (`lsappinfo`), or null when it cannot be read. */
async function lsFrontPid(): Promise<number | null> {
  try {
    const asn = (await run("/usr/bin/lsappinfo", ["front"])).stdout.trim();
    const m = /"pid"=(\d+)/.exec((await run("/usr/bin/lsappinfo", ["info", "-only", "pid", asn])).stdout);
    return m?.[1] === undefined ? null : Number(m[1]);
  } catch {
    return null;
  }
}
/**
 * A --front run measures the WebKit fixture while it is the frontmost app, so LaunchServices must say so before
 * every run; otherwise the run ends as deferred: foreground rather than measuring something else (B21).
 */
async function checkFront(): Promise<void> {
  if (!FRONT) return;
  const front = await lsFrontPid();
  if (front !== target.pid) {
    aborted = `deferred: foreground (LaunchServices names pid ${front ?? "unknown"} frontmost, not the WebKit fixture ${target.pid})`;
    throw new Aborted(aborted);
  }
}
class Aborted extends Error {}

// MARK: - helper in process

let jevCalls = 0;
let jevCost = 0;
const realJev = makeJevClient(() => loadJevKey());
const askJev: AskJev = async (req) => {
  const r = await realJev(req);
  jevCalls++;
  jevCost += r.costUsd;
  return r;
};
const progress: TaskProgress[] = [];
const errors: string[] = [];
const switches: AppSwitch[] = [];
let server: HelperServer | null = null;
const storeDir = mkdtempSync(join(tmpdir(), "caret-real-eval-"));
tempDirs.push(storeDir);
const store = new Store(storeDir);
// The socket lives in a directory of this run's own, so the server's removal of a stale socket file can
// only ever remove its own.
const sockDir = mkdtempSync(join(tmpdir(), "caret-real-eval-sock-"));
tempDirs.push(sockDir);
const SOCKET = join(sockDir, "s.sock");
const helper = new Helper({
  store,
  askJev,
  shadow: false,
  allowBackgroundFocus: false,
  publish: (m: HelperMessage) => {
    if (m.type === "taskProgress") progress.push(m);
    if (m.type === "error") errors.push(m.message);
    server?.publish(m);
  },
  sendToReader: (m) => server?.sendToReader(m) ?? false,
});
const origHandle = helper.handleReader.bind(helper);
helper.handleReader = (m) => {
  if (m.type === "appSwitch") switches.push(m);
  return origHandle(m);
};
server = new HelperServer(SOCKET, () => helper, (l) => errors.push(l), launchSecret);
await server.listen();
const tick = setInterval(() => helper.tick(), 250);

// MARK: - targets

/** The target's true state, read without the reader. `fields` holds every value a plan may write. */
interface State {
  title: string;
  fields: Record<string, string>;
  status?: string;
  page?: string;
  note?: boolean;
  sent?: boolean;
  focused?: string | null;
}
interface PlanCase {
  plan: Plan;
  slots: (r: number) => Record<string, string>;
  seed: Record<string, string>;
  expect: (slots: Record<string, string>, s: State) => string | null;
}
interface Target {
  pid: number;
  /** Window selector of the plan's window. */
  win: WindowSel;
  plans: Record<string, PlanCase>;
  reset(): Promise<void>;
  seed(field: string, value: string): Promise<void>;
  state(): Promise<State>;
  /** Opens a second window of the same process and returns its title prefix. */
  secondWindow(): Promise<string>;
  /** The field the safety cases write to, as a role and label locator and as its state name. */
  safetyField: { role: string; label: string; name: string };
  /** Whether the safety field has the app's focus, read without the reader. */
  fieldFocused(): Promise<boolean>;
  /** A press with a checkable effect: the button's label and a check on the target's state; null when the target has none. */
  press: { label: string; done: (s: State) => boolean } | null;
  /** Makes the target the active app with its form window key (--front); only the WebKit fixture can be asked. */
  front?(): Promise<void>;
  /** Makes the form window's web view its first responder without making the window key (--responder); WebKit fixture only. */
  responder?(): Promise<void>;
  /** The plan window's window server number, once the reader has read it; a target whose checks find windows by title switches to it. */
  bind?(number: number): void;
  stop(): Promise<void>;
}

const eq = (want: Record<string, string>, s: State): string | null => {
  for (const [k, v] of Object.entries(want)) if (s.fields[k] !== v) return `${k} is '${s.fields[k]}', expected '${v}'`;
  return null;
};
const names = ["Dana Whitfield", "Priya Raman", "Marcus Lowe", "Ines Okafor", "Tomas Brandt"];
const cities = ["Austin", "Lisbon", "Osaka", "Tucson", "Leeds"];
const pick = <T,>(xs: T[], r: number): T => xs[r % xs.length] as T;

function field(win: WindowSel, role: string, label: string, value: string, says: string): Step {
  return { says, end: { kind: "valueEquals", window: win, target: { role, label, describe: `the ${label} field` }, value } };
}

function webPlans(win: WindowSel): Record<string, PlanCase> {
  const text = (label: string, describe: string) => ({ role: "AXStaticText", label, describe });
  return {
    contact: {
      plan: {
        id: "contact",
        title: "Fill the contact fields",
        slots: { name: "full name", email: "email address", note: "note text" },
        steps: [
          field(win, "AXTextField", "Name", "{{name}}", "Name holds {{name}}"),
          field(win, "AXTextField", "Email", "{{email}}", "Email holds {{email}}"),
          field(win, "AXTextArea", "Notes", "{{note}}", "Notes hold the note"),
        ],
      },
      slots: (r) => ({ name: pick(names, r), email: `${pick(names, r).split(" ")[0]?.toLowerCase()}.${r}@example.com`, note: `Call back about order ORD-2026-${48200 + r}` }),
      seed: { email: "old.address@example.com", notes: "Earlier note" },
      expect: (s, d) => eq({ name: s.name ?? "", email: s.email ?? "", notes: s.note ?? "" }, d),
    },
    shipping: {
      plan: {
        id: "shipping",
        title: "Fill the shipping address (two fields share each label)",
        slots: { city: "shipping city", street: "shipping street" },
        steps: [
          { says: "The shipping city is {{city}}", end: { kind: "valueEquals", window: win, target: { role: "AXTextField", label: "City", describe: "the City field in the Shipping section" }, value: "{{city}}" } },
          { says: "The shipping street is {{street}}", end: { kind: "valueEquals", window: win, target: { role: "AXTextField", label: "Street", describe: "the Street field in the Shipping section" }, value: "{{street}}" } },
        ],
      },
      slots: (r) => ({ city: pick(cities, r), street: `${100 + r} Barton Springs Rd` }),
      seed: { billingCity: "Billing Town", billingStreet: "1 Billing Way" },
      expect: (s, d) => eq({ shippingCity: s.city ?? "", shippingStreet: s.street ?? "", billingCity: "Billing Town", billingStreet: "1 Billing Way" }, d),
    },
    archive: {
      plan: {
        id: "archive",
        title: "Archive the order and add a note",
        slots: {},
        steps: [
          { says: "The order is archived", end: { kind: "exists", window: win, target: text("Status: Archived", "the archived status line") }, via: { kind: "press", target: { role: "AXButton", label: "Archive", describe: "the Archive button" } } },
          { says: "The active status line is gone", end: { kind: "absent", window: win, target: text("Status: Active", "the active status line") } },
          { says: "A note was added", end: { kind: "exists", window: win, target: text("Note added", "the note-added line") }, via: { kind: "press", target: { role: "AXButton", label: "Add note", describe: "the Add note button" } } },
        ],
      },
      slots: () => ({}),
      seed: {},
      expect: (_, d) => (d.status !== "Status: Archived" ? `status is '${d.status}'` : d.note !== true ? "no note" : null),
    },
    nextPage: {
      plan: {
        id: "nextPage",
        title: "Record the reference and go to page 2",
        slots: { ref: "reference number" },
        steps: [
          field(win, "AXTextField", "Reference", "{{ref}}", "Reference holds {{ref}}"),
          { says: "Page 2 is showing", end: { kind: "exists", window: win, target: text("Page 2 of 2", "the page line") }, via: { kind: "press", target: { role: "AXButton", label: "Next page", describe: "the Next page button" } } },
        ],
      },
      slots: (r) => ({ ref: `REF-${7000 + r}` }),
      seed: { reference: "REF-OLD" },
      expect: (s, d) => (d.page !== "Page 2 of 2" ? `page is '${d.page}'` : eq({ reference: s.ref ?? "" }, d)),
    },
    focus: {
      plan: {
        id: "focus",
        title: "Put the cursor in Email and fill it",
        slots: { email: "email address" },
        steps: [
          { says: "Email has the focus", end: { kind: "focused", window: win, target: { role: "AXTextField", label: "Email", describe: "the Email field" } } },
          field(win, "AXTextField", "Email", "{{email}}", "Email holds {{email}}"),
        ],
      },
      slots: (r) => ({ email: `focus.${r}@example.com` }),
      seed: {},
      expect: (s, d) => (d.focused !== "email" ? `focus is on '${d.focused}'` : eq({ email: s.email ?? "" }, d)),
    },
  };
}

/** A web target: the page's own functions report and set its state, reached through `js`. */
function webTarget(pid: number, win: WindowSel, js: (expr: string) => Promise<unknown>, secondWindow: () => Promise<string>, stop: () => Promise<void>): Target {
  return {
    pid,
    win,
    plans: webPlans(win),
    reset: async () => void (await js("caretReset()")),
    seed: async (f, v) => void (await js(`caretSeed(${JSON.stringify(f)}, ${JSON.stringify(v)})`)),
    state: async () => (await js("caretState()")) as State,
    secondWindow,
    safetyField: { role: "AXTextField", label: "Name", name: "name" },
    fieldFocused: async () => ((await js("caretState()")) as State).focused === "name",
    press: { label: "Archive", done: (s) => s.status === "Status: Archived" },
    stop,
  };
}

async function webkitTarget(): Promise<Target> {
  checkAbort();
  const fixture: ChildProcessWithoutNullStreams = spawn(fixtureExecutable(BIN), ["--windows", "executor", "--webkit", pathToFileURL(FORM).href, "--duration", "3600", ...(FRONT ? ["--foreground"] : [])]);
  started("webkit fixture", fixture);
  const lines = lineReader(fixture, "the webkit fixture");
  const first = await lines.next();
  const pid = Number(/^caret-fixture pid (\d+)/.exec(first)?.[1]);
  if (!(pid > 0)) throw new Error(`the fixture said '${first}'`);
  const ask = async (cmd: string): Promise<Record<string, unknown>> => {
    fixture.stdin.write(cmd + "\n");
    return JSON.parse(await lines.next()) as Record<string, unknown>;
  };
  const js = async (expr: string): Promise<unknown> => {
    const r = await ask(`web ${expr}`);
    if (r.ok !== true) throw new Error(`webkit: ${String(r.error)}`);
    return r.value;
  };
  await until("the page to load", async () => (await ask("web typeof caretState")).value === "function");
  // A --front run hands activation back to the app that was frontmost before it (the fixture's `quit PID`).
  let handBackTo: number | null = null;
  const stop = async (): Promise<void> => {
    if (handBackTo !== null) {
      fixture.stdin.write(`quit ${handBackTo}\n`);
      await sleep(600);
    }
    fixture.kill("SIGTERM");
  };
  const t = webTarget(pid, { titleStartsWith: "Caret Fixture — WebKit" }, js, async () => "Caret Fixture — Executor", stop);
  t.responder = async () => {
    const r = await ask("responder webkit");
    if (r.ok !== true) throw new Error(`webkit responder: ${JSON.stringify(r)}`);
  };
  t.front = async () => {
    handBackTo = await lsFrontPid();
    for (const cmd of ["activate legacy", "focus webkit"]) {
      const r = await ask(cmd);
      if (r.ok !== true) throw new Error(`webkit ${cmd}: ${String(r.error)}`);
    }
  };
  return t;
}

async function chromiumTarget(): Promise<Target> {
  const profile = mkdtempSync(join(tmpdir(), "caret-chromium-profile-"));
  tempDirs.push(profile);
  checkAbort();
  const chrome = spawn(CHROME, [
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--remote-debugging-port=0",
    "--disable-extensions", "--disable-background-networking", "--new-window", pathToFileURL(FORM).href,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const pid = started("chromium", chrome);
  const portFile = join(profile, "DevToolsActivePort");
  await until("Chrome's DevTools port", () => existsSync(portFile), 30_000);
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`, (m) => (aborted !== null ? new Aborted(aborted) : new Error(`no DevTools answer to ${m} within 15 s`)));
  const page = async (): Promise<string> => {
    const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
    const t = targetInfos.find((x) => x.type === "page" && x.url.startsWith("file:") && !x.url.includes("?second"));
    if (t === undefined) throw new Error("no page with the form");
    return t.targetId;
  };
  let session: string | null = null;
  const js = async (expr: string): Promise<unknown> => {
    if (session === null) session = ((await cdp.send("Target.attachToTarget", { targetId: await page(), flatten: true })) as { sessionId: string }).sessionId;
    return cdp.evaluate(session, expr);
  };
  await until("the page to load", async () => {
    try {
      return (await js("typeof caretState")) === "function";
    } catch {
      return false;
    }
  }, 30_000);
  return webTarget(
    pid,
    { titleStartsWith: "Caret Form — Web" },
    js,
    async () => {
      await cdp.send("Target.createTarget", { url: `${pathToFileURL(FORM).href}?second`, newWindow: true });
      return "Caret Form — Web";
    },
    async () => {
      cdp.close();
      chrome.kill("SIGTERM");
      await until("Chrome to exit", () => chrome.exitCode !== null || chrome.signalCode !== null, 15_000).catch(() => chrome.kill("SIGKILL"));
    },
  );
}

async function electronTarget(): Promise<Target> {
  const exe = join(resolve(a.electron ?? ""), "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  if (!existsSync(exe)) throw new Error(`no ${exe}; run scripts/electron-setup.sh first`);
  // The app and its page in a directory of this run's own, deleted at the end with the others.
  const appDir = mkdtempSync(join(tmpdir(), "caret-electron-app-"));
  tempDirs.push(appDir);
  copyFileSync(ELECTRON_MAIN, join(appDir, "main.cjs"));
  copyFileSync(FORM, join(appDir, "form.html"));
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "caret-electron-eval", main: "main.cjs" }) + "\n");
  // Electron keeps its profile under the app's name in Application Support unless told otherwise.
  const profile = mkdtempSync(join(tmpdir(), "caret-electron-profile-"));
  tempDirs.push(profile);
  checkAbort();
  // Without ELECTRON_RUN_AS_NODE, which an Electron host such as the agent's own sets for its children: with it
  // the binary runs as plain Node and cannot load the app (B20 exploration).
  const { ELECTRON_RUN_AS_NODE: _asNode, ...env } = process.env;
  const proc: ChildProcessWithoutNullStreams = spawn(exe, [appDir, `--user-data-dir=${profile}`], { env });
  const pid = started("electron", proc);
  // Drained, so a chatty Electron cannot fill the pipe and stall; the tail goes in the report's folder.
  let electronLog = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d: string) => (electronLog = (electronLog + d).slice(-20_000)));
  process.on("exit", () => writeFileSync(join(OUT, "electron.log"), electronLog));
  const lines = lineReader(proc, "the electron app");
  const first = await lines.next(30_000);
  const said = Number(/^caret-electron pid (\d+)/.exec(first)?.[1]);
  if (said !== pid) throw new Error(`the electron app said '${first}', expected pid ${pid}`);
  const ask = async (cmd: string): Promise<Record<string, unknown>> => {
    proc.stdin.write(cmd + "\n");
    return JSON.parse(await lines.next()) as Record<string, unknown>;
  };
  const js = async (expr: string): Promise<unknown> => {
    const r = await ask(`web ${expr}`);
    if (r.ok !== true) throw new Error(`electron: ${String(r.error)}`);
    return r.value;
  };
  await until("the page to load", async () => {
    try {
      return (await js("typeof caretState")) === "function";
    } catch {
      return false;
    }
  }, 30_000);
  return webTarget(
    pid,
    { titleStartsWith: "Caret Form — Web" },
    js,
    async () => {
      const r = await ask("second");
      if (r.ok !== true) throw new Error(`electron second: ${String(r.error)}`);
      return "Caret Form — Web";
    },
    async () => {
      proc.stdin.end();
      await until("Electron to exit", () => proc.exitCode !== null || proc.signalCode !== null, 15_000).catch(() => proc.kill("SIGKILL"));
    },
  );
}

async function texteditTarget(): Promise<Target> {
  // Untitled document at launch, no restored windows, nothing kept for the next launch.
  checkAbort();
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
  // The probe finds the window by title until the reader has its number; "Untitled 2" also starts with the title.
  let TITLE = "Untitled";
  await until("TextEdit's untitled window", async () => (await probe("text", TITLE)).ok === true, 30_000);
  const win: WindowSel = { bundleId: "com.apple.TextEdit", titleStartsWith: TITLE };
  const body = (value: string, says: string): Step => ({ says, end: { kind: "valueEquals", window: win, target: { role: "AXTextArea", describe: "the document text" }, value } });
  const text = async (): Promise<string> => {
    const r = await probe("text", TITLE);
    if (r.ok !== true) throw new Error(`probe: ${String(r.error)}`);
    return String(r.value ?? "");
  };
  const plans: Record<string, PlanCase> = {
    write: {
      plan: { id: "write", title: "Write a sentence into the empty document", slots: { t: "text" }, steps: [body("{{t}}", "The document says the sentence")] },
      slots: (r) => ({ t: `Meeting notes for Thursday, item ${r}` }),
      seed: {},
      expect: (s, d) => eq({ body: s.t ?? "" }, d),
    },
    replace: {
      plan: { id: "replace", title: "Replace the draft", slots: { t: "text" }, steps: [body("{{t}}", "The draft is replaced")] },
      slots: (r) => ({ t: `Final text ${r}` }),
      seed: { body: "Earlier draft text" },
      expect: (s, d) => eq({ body: s.t ?? "" }, d),
    },
    multiline: {
      plan: { id: "multiline", title: "Write three lines", slots: { t: "text" }, steps: [body("{{t}}", "The document holds three lines")] },
      slots: (r) => ({ t: `Line one\nLine two ${r}\nLine three` }),
      seed: {},
      expect: (s, d) => eq({ body: s.t ?? "" }, d),
    },
    unicode: {
      plan: { id: "unicode", title: "Write accented text", slots: { t: "text" }, steps: [body("{{t}}", "The document holds the accented text")] },
      slots: (r) => ({ t: `Café — naïve résumé ✓ ${r}` }),
      seed: {},
      expect: (s, d) => eq({ body: s.t ?? "" }, d),
    },
    focus: {
      plan: {
        id: "focus",
        title: "Put the cursor in the document and write",
        slots: { t: "text" },
        steps: [{ says: "The document has the focus", end: { kind: "focused", window: win, target: { role: "AXTextArea", describe: "the document text" } } }, body("{{t}}", "The document says the sentence")],
      },
      slots: (r) => ({ t: `Focused entry ${r}` }),
      seed: {},
      expect: (s, d) => eq({ body: s.t ?? "" }, d),
    },
  };
  return {
    pid,
    win,
    plans,
    reset: async () => {
      const r = await probe("set-text", TITLE, "");
      if (r.ok !== true) throw new Error(`probe reset: ${JSON.stringify(r)}`);
    },
    seed: async (_, v) => {
      const r = await probe("set-text", TITLE, v);
      if (r.ok !== true) throw new Error(`probe seed: ${JSON.stringify(r)}`);
    },
    state: async () => ({ title: TITLE, fields: { body: await text() } }),
    secondWindow: async () => {
      const r = await probe("menu", "File", "New");
      if (r.ok !== true) throw new Error(`probe menu: ${JSON.stringify(r)}`);
      return "Untitled 2";
    },
    safetyField: { role: "AXTextArea", label: "", name: "body" },
    fieldFocused: async () => (await probe("focused", TITLE)).focused === true,
    press: null,
    bind: (n) => {
      TITLE = `#${n}`;
    },
    stop: async () => {
      te.kill("SIGTERM");
      await until("TextEdit to exit", () => te.exitCode !== null || te.signalCode !== null, 10_000).catch(() => te.kill("SIGKILL"));
    },
  };
}

// MARK: - small clients

/** Reads a child's stdout a line at a time. A wait fails after `ms`, and every wait fails when the child's output ends. */
function lineReader(p: ChildProcessWithoutNullStreams, label: string): { next(ms?: number): Promise<string> } {
  let buf = "";
  let ended = false;
  const ready: string[] = [];
  const waiting: { ok: (l: string) => void; fail: (e: Error) => void }[] = [];
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const w = waiting.shift();
      if (w !== undefined) w.ok(l);
      else ready.push(l);
    }
  });
  p.stdout.on("close", () => {
    ended = true;
    for (const w of waiting.splice(0)) w.fail(new Error(`${label} closed its output`));
  });
  return {
    next: (ms = 15_000) =>
      new Promise((ok, fail) => {
        if (ready.length > 0) return ok(ready.shift() as string);
        if (ended) return fail(new Error(`${label} closed its output`));
        const w = {
          ok: (l: string) => {
            clearTimeout(t);
            ok(l);
          },
          fail: (e: Error) => {
            clearTimeout(t);
            fail(e);
          },
        };
        const t = setTimeout(() => {
          waiting.splice(waiting.indexOf(w), 1);
          fail(aborted !== null ? new Aborted(aborted) : new Error(`no line from ${label} within ${ms} ms`));
        }, ms);
        waiting.push(w);
      }),
  };
}

// MARK: - reader, bystander and target

/** A second process the reader reads, for the "pid outside the grant" case: a fixture with its executor window. */
checkAbort();
const bystander: ChildProcessWithoutNullStreams = spawn(fixtureExecutable(BIN), ["--windows", "executor", "--duration", "3600", ...(BACKGROUND ? ["--foreground"] : [])]);
started("bystander fixture", bystander);
const bystanderLines = lineReader(bystander, "the bystander fixture");
const bystanderPid = Number(/^caret-fixture pid (\d+)/.exec(await bystanderLines.next())?.[1]);

const textEditBefore = await pgrep("-x", "TextEdit");
const autosaveBefore = new Set(textEditLeftovers());
checkAbort();
const target = TARGET === "textedit" ? await texteditTarget() : TARGET === "webkit" ? await webkitTarget() : TARGET === "electron" ? await electronTarget() : await chromiumTarget();
await sleep(1000);
checkAbort();
checkAbort();
const reader = spawn(join(BIN, "caret-screen"), ["--auth-fd", "0", "--socket", SOCKET, "--only-pids", `${target.pid},${bystanderPid}`, "--event-pids", `${target.pid},${bystanderPid}`]);
started("reader", reader);
let readerLog = "";
reader.stderr.setEncoding("utf8");
sendSecret(reader, launchSecret);
reader.stderr.on("data", (d: string) => (readerLog += d));
const windowOf = (pid: number, prefix: string) => [...helper.model.windows.values()].find((w) => w.app.pid === pid && w.window.title.startsWith(prefix));
const titlePrefix = target.win.titleStartsWith ?? target.win.title ?? "";
await until("the target window in the screen model", () => windowOf(target.pid, titlePrefix) !== undefined, 30_000);
await until("the bystander window in the screen model", () => windowOf(bystanderPid, "Caret Fixture — Executor") !== undefined);
// The target window as the reader sees it, for checking locators: synthetic form text or this script's own text only.
writeFileSync(join(OUT, "target-nodes.json"), JSON.stringify([...(windowOf(target.pid, titlePrefix)?.nodes.values() ?? [])].map((n) => ({ key: n.key, role: n.role, label: n.label, value: n.value, editable: n.editable })), null, 1) + "\n");
const mainNumber = windowOf(target.pid, titlePrefix)?.window.number;
if (target.bind !== undefined) {
  if (mainNumber === undefined) throw new Error("the reader read no window number for the target window");
  target.bind(mainNumber);
}
// Chrome builds its web tree some time after the reader asks for it: plans start once the fields are there.
const sf = target.safetyField;
await until("the target's fields in the screen model", () => [...(windowOf(target.pid, titlePrefix)?.nodes.values() ?? [])].some((n) => n.role === sf.role && (sf.label === "" || n.label === sf.label)), 30_000);
if (RESPONDER) await target.responder?.();
if (FRONT) {
  await target.front?.();
  await until("the WebKit fixture to be frontmost", () => switches.at(-1)?.to.pid === target.pid, 5000).catch((e: unknown) => {
    throw new Error(`${String(e)}; app switches seen: ${JSON.stringify(switches.map((x) => [x.to.name, x.to.pid]))}, fixture pid ${target.pid}`);
  });
}
if (BACKGROUND) {
  // The bystander is this script's own process; it takes the foreground so the target's window is not key.
  bystander.stdin.write("activate legacy\n");
  await bystanderLines.next();
  await until("the bystander to be frontmost", () => switches.at(-1)?.to.pid === bystanderPid, 5000).catch((e: unknown) => {
    throw new Error(`${String(e)}; app switches seen: ${JSON.stringify(switches.map((x) => [x.to.name, x.to.pid]))}, bystander pid ${bystanderPid}`);
  });
}

// MARK: - plans

let taskN = 0;
const newTask = (p: string): string => `${TARGET}-${p}-${++taskN}`;
const acts = (taskId: string) => progress.filter((p) => p.taskId === taskId && p.phase === "acting");
const reset = async (seed: Record<string, string>): Promise<void> => {
  await target.reset();
  for (const [k, v] of Object.entries(seed)) await target.seed(k, v);
  // Let the reader report the reset before the run reads the window, as a person's edit would be seen.
  await sleep(300);
};

interface Row {
  plan: string;
  run: number;
  outcome: string;
  step: number | null;
  detail: string | null;
  claimedDone: boolean;
  checkFailure: string | null;
  rerunOutcome: string;
  rerunActs: number;
  undo: UndoResult | null;
  undoCheck: string | null;
  ms: number;
  means: string[];
}
const rows: Row[] = [];
const only = a.plans === undefined ? null : new Set(a.plans.split(","));
// Filled row by row, so an abort keeps every row finished before it.
const safety: SafetyRow[] = [];
const means: MeansRow[] = [];
// Above the runs, not beside candidatesTable: the runs below call it before the module reaches that point.
// B20's paste-cg is gone: it wrote the general pasteboard, which no test may (BUILD-ORDER clipboard rule).
const CANDIDATE_NAMES = ["value", "focus-value", "main-value", "insert", "type-cg", "type-sl"] as const;
const candidates: CandidateRow[] = [];
try {
  for (const [name, pc] of Object.entries(target.plans)) {
    if (only !== null && !only.has(name)) continue;
    for (let r = 0; r < RUNS; r++) {
      checkAbort();
      await checkFront();
      await reset(pc.seed);
      const before = await target.state();
      const slots = pc.slots(r);
      const id = newTask(name);
      const t0 = Date.now();
      // As an accepted offer runs it: with an act grant for the plan's window.
      const res = await helper.executor.run(id, pc.plan, slots, undefined, { grant: true }).catch((e: unknown) => ({ outcome: "error", step: null, detail: String(e) }) as unknown as TaskResult);
      const ms = Date.now() - t0;
      await sleep(150);
      const after = await target.state();
      const claimedDone = res.outcome === "done";
      const checkFailure = pc.expect(slots, after);
      const rid = newTask(`${name}-rerun`);
      const rerun = await helper.executor.run(rid, pc.plan, slots, undefined, { grant: true }).catch(() => null);
      let undo: UndoResult | null = null;
      let undoCheck: string | null = null;
      if (claimedDone) {
        undo = await helper.executor.undo(id).catch(() => null);
        await sleep(150);
        const u = await target.state();
        for (const [k, v] of Object.entries(before.fields)) if (u.fields[k] !== v) undoCheck = `${k} is '${u.fields[k]}', was '${v}'`;
      }
      const used = acts(id).map((p) => (p.detail ?? "").split(";")[0] ?? "");
      rows.push({ plan: name, run: r, outcome: res.outcome, step: res.step, detail: res.detail, claimedDone, checkFailure, rerunOutcome: rerun?.outcome ?? "error", rerunActs: acts(rid).length, undo, undoCheck, ms, means: used });
      process.stdout.write(`${name} ${r}: ${res.outcome}${checkFailure === null ? "" : ` CHECK ${checkFailure}`}${res.outcome === "done" ? "" : ` (${res.detail})`} rerun ${rerun?.outcome}/${acts(rid).length} undo ${undo === null ? "-" : `${undo.restored}/${undo.notRestored.length}`}${undoCheck === null ? "" : ` UNDO ${undoCheck}`}\n`);
    }
  }

  await meansTable();
  if (CANDIDATES !== null) await candidatesTable(CANDIDATES);

  // MARK: - safety cases: each must answer notAllowed and leave the field as it was

  await safetyCases();
} catch (e) {
  // An abort stops this script's processes, so whatever was waiting on them fails with its own error.
  if (!(e instanceof Aborted) && aborted === null) throw e;
}

interface MeansRow {
  means: "value" | "focused" | "insert" | "press";
  run: number;
  outcome: string;
  detail: string | null;
  /** Read from the target after the act: the field holds the value written, it has the focus, or the press's effect shows. */
  landed: boolean;
  /** For writes: what the field held before and after, as the target reports it. */
  before: string;
  after: string;
  /** The field's value as the reader's next walk saw it; undefined when the reader's tree lost the field. */
  readerSaw: string | undefined;
}

/** Each reader means alone under a valid grant, read back from the target. */
async function meansTable(): Promise<void> {
  const out = means;
  const main = windowOf(target.pid, titlePrefix);
  if (main === undefined) throw new Error("means: the target window is missing");
  const kinds: MeansRow["means"][] = ["value", "focused", "insert", ...(target.press === null ? [] : (["press"] as const))];
  for (const kind of kinds) {
    for (let r = 0; r < MEANS_RUNS; r++) {
      checkAbort();
      await checkFront();
      await reset({});
      // Insert replaces what is there; value starts from empty, as most fills do.
      if (kind === "insert") await target.seed(sf.name, `old text ${r}`);
      await sleep(300);
      const walked = await helper.readerVerb({ kind: "walk", pid: target.pid, windowId: main.window.windowId });
      if (walked.outcome !== "ok") throw new Error(`walk: ${walked.outcome} ${walked.detail}`);
      const w = helper.model.windows.get(main.window.windowId);
      const pressLabel = target.press?.label ?? "";
      const node = [...(w?.nodes.values() ?? [])].find((n) => (kind === "press" ? n.role === "AXButton" && n.label === pressLabel : n.role === sf.role && (sf.label === "" || n.label === sf.label)));
      if (node === undefined) throw new Error(`means ${kind}: no target element`);
      const taskId = `means-${kind}-${r}`;
      const at = Date.now();
      server?.sendToReader({ type: "actGrant", v: PROTOCOL_VERSION, taskId, pid: target.pid, windowId: main.window.windowId, at, expires: at + GRANT_MAX_MS });
      const before = (await target.state()).fields[sf.name] ?? "";
      const value = `means ${kind} ${r}`;
      const verb: ReaderVerb =
        kind === "press"
          ? { kind: "press", pid: target.pid, windowId: main.window.windowId, key: node.key, role: node.role, label: pressLabel, taskId }
          : { kind: "write", pid: target.pid, windowId: main.window.windowId, key: node.key, role: node.role, attribute: kind, expect: node.value ?? "", value: kind === "focused" ? "" : value, taskId };
      const res = await helper.readerVerb(verb);
      server?.sendToReader({ type: "actRevoke", v: PROTOCOL_VERSION, taskId, at: Date.now() });
      await sleep(300);
      const s = await target.state();
      const after = s.fields[sf.name] ?? "";
      const landed = kind === "press" ? (target.press?.done(s) ?? false) : kind === "focused" ? await target.fieldFocused() : after === value;
      const readerSaw = helper.model.windows.get(main.window.windowId)?.nodes.get(node.key)?.value;
      out.push({ means: kind, run: r, outcome: res.outcome, detail: res.detail, landed, before, after, readerSaw: kind === "press" ? undefined : (readerSaw ?? (helper.model.windows.get(main.window.windowId)?.nodes.has(node.key) === true ? "" : undefined)) });
      process.stdout.write(`means ${kind} ${r}: ${res.outcome}${res.detail === null ? "" : ` (${res.detail})`} landed=${landed} '${before}' -> '${after}'\n`);
    }
  }
}

/** B20: the ways to write a web field whose window is not key, each alone, judged by the page itself. */
interface CandidateRow {
  candidate: (typeof CANDIDATE_NAMES)[number];
  run: number;
  /** The probe acted (or skipped: the pasteboard held something it could not restore). */
  acted: boolean;
  skipped: boolean;
  /** The page's own field holds the value written. */
  landed: boolean;
  /** The candidate's own after-check, an Accessibility read of the field, says it landed. */
  claimed: boolean;
  /** Another field of the form changed, or the page's Send ran: keys that went somewhere else. */
  collateral: string | null;
  /** The target's window moved up the on-screen order, or the target app became active, or the frontmost app changed. */
  raised: boolean;
  activated: boolean;
  frontChanged: boolean;
  detail: string;
  error: string | null;
}

async function candidatesTable(probe: string): Promise<void> {
  const title = target.win.titleStartsWith ?? target.win.title ?? "";
  for (const candidate of CANDIDATE_NAMES) {
    for (let r = 0; r < MEANS_RUNS; r++) {
      checkAbort();
      await checkFront();
      await reset({});
      await target.seed("name", `old text ${r}`);
      await sleep(300);
      const before = await target.state();
      const value = `cand ${candidate} ${r}`;
      // The probe acts only on the target's pid, which this script started.
      let o: Record<string, unknown>;
      try {
        // The probe marks CARET_SYNTHETIC_FILE around the input it posts, so the idle watch knows it for its own.
        // In a --front run the probe checks LaunchServices names the target frontmost before every key it posts.
        const env = FRONT ? { ...process.env, CARET_REQUIRE_FRONT: "1" } : process.env;
        o = JSON.parse((await run(probe, [String(target.pid), title, "name", candidate, value], { timeout: 30_000, env })).stdout) as Record<string, unknown>;
      } catch (e) {
        o = { ok: false, error: String(e) };
      }
      // The probe saw another app frontmost before a key: the run is not measuring a frontmost target any more.
      if (FRONT && String(o.error ?? "").startsWith("deferred: foreground")) {
        aborted = `${String(o.error)} (candidate ${candidate}, run ${r})`;
        throw new Aborted(aborted);
      }
      await sleep(300);
      const after = await target.state();
      const others = Object.keys(before.fields).filter((k) => k !== "name" && before.fields[k] !== after.fields[k]);
      const collateral = others.length > 0 ? `changed: ${others.join(", ")}` : after.sent === true ? "the page's Send ran" : after.title !== before.title ? `title became '${after.title}'` : null;
      const row: CandidateRow = {
        candidate,
        run: r,
        acted: o.acted === true,
        skipped: o.skipped === true,
        landed: after.fields.name === value,
        claimed: o.axSaysLanded === true,
        collateral,
        raised: o.raised === true,
        activated: o.activeAfter === true && o.activeBefore !== true,
        frontChanged: o.frontBefore !== o.frontAfter,
        detail: String(o.detail ?? ""),
        error: o.ok === true ? null : String(o.error ?? "probe failed"),
      };
      candidates.push(row);
      process.stdout.write(`candidate ${candidate} ${r}: landed=${row.landed} claimed=${row.claimed} raised=${row.raised} activated=${row.activated} front=${row.frontChanged}${collateral === null ? "" : ` COLLATERAL ${collateral}`}${row.error === null ? "" : ` ERROR ${row.error}`} (${row.detail}) '${before.fields.name}' -> '${after.fields.name}'\n`);
    }
  }
}

interface SafetyRow {
  kind: "pidOutside" | "expired" | "otherWindow" | "control";
  run: number;
  outcome: string;
  detail: string | null;
  before: string;
  after: string;
  /** For a refusal, the field still holds `before`; for the control, it holds what the write asked for. */
  asExpected: boolean;
}
async function safetyCases(): Promise<void> {
  const out = safety;
  const main = windowOf(target.pid, titlePrefix);
  const by = windowOf(bystanderPid, "Caret Fixture — Executor");
  if (main === undefined || by === undefined) throw new Error("safety cases: a window is missing from the model");
  const second = await target.secondWindow();
  await until("the second window of the target", () => [...helper.model.windows.values()].some((w) => w.app.pid === target.pid && w.window.windowId !== main.window.windowId && w.window.title.startsWith(second)), 15_000);
  const other = [...helper.model.windows.values()].find((w) => w.app.pid === target.pid && w.window.windowId !== main.window.windowId && w.window.title.startsWith(second));
  if (other === undefined) throw new Error("no second window");
  const f = target.safetyField;
  const grant = (taskId: string, pid: number, windowId: string, forMs: number): void => {
    const at = Date.now();
    server?.sendToReader({ type: "actGrant", v: PROTOCOL_VERSION, taskId, pid, windowId, at, expires: at + forMs });
  };
  const revoke = (taskId: string): void => void server?.sendToReader({ type: "actRevoke", v: PROTOCOL_VERSION, taskId, at: Date.now() });
  const attempt = async (kind: SafetyRow["kind"], r: number): Promise<void> => {
    checkAbort();
    await checkFront();
    await reset({});
    const seeded = `safety ${kind} ${r}`;
    await target.seed(f.name, seeded);
    await sleep(300);
    // A walk of the executor's own, so the only thing standing between the write and the field is the grant.
    const walked = await helper.readerVerb({ kind: "walk", pid: target.pid, windowId: main.window.windowId });
    if (walked.outcome !== "ok") throw new Error(`walk: ${walked.outcome} ${walked.detail}`);
    const w = helper.model.windows.get(main.window.windowId);
    const node = [...(w?.nodes.values() ?? [])].find((n) => n.role === f.role && (f.label === "" || n.label === f.label));
    if (node === undefined) throw new Error(`no ${f.role} '${f.label}' in the target window`);
    const before = (await target.state()).fields[f.name] ?? "";
    const taskId = `safety-${kind}-${r}`;
    if (kind === "pidOutside") grant(taskId, bystanderPid, by.window.windowId, GRANT_MAX_MS);
    else if (kind === "otherWindow") grant(taskId, target.pid, other.window.windowId, GRANT_MAX_MS);
    else if (kind === "expired") {
      grant(taskId, target.pid, main.window.windowId, 300);
      await sleep(600);
    } else grant(taskId, target.pid, main.window.windowId, GRANT_MAX_MS);
    const value = kind === "control" ? `written under a valid grant ${r}` : `SHOULD NOT APPEAR ${r}`;
    const verb: ReaderVerb = { kind: "write", pid: target.pid, windowId: main.window.windowId, key: node.key, role: node.role, attribute: "value", expect: node.value ?? "", value, taskId };
    const res: VerbResult = await helper.readerVerb(verb);
    revoke(taskId);
    await sleep(200);
    const after = (await target.state()).fields[f.name] ?? "";
    out.push({ kind, run: r, outcome: res.outcome, detail: res.detail, before, after, asExpected: kind === "control" ? after === value : after === before });
    process.stdout.write(`safety ${kind} ${r}: ${res.outcome} (${res.detail}) field '${before}' -> '${after}'\n`);
  };
  for (const kind of ["pidOutside", "expired", "otherWindow"] as const) for (let r = 0; r < SAFETY_RUNS; r++) await attempt(kind, r);
  // The same write under a valid grant does land, so the refusals above came from the grant alone.
  for (let r = 0; r < Math.min(3, SAFETY_RUNS); r++) await attempt("control", r);
  await target.reset();
}

// MARK: - report

clearInterval(tick);
clearInterval(idleWatch);
await target.stop().catch(() => undefined);
await server.close();
store.close();
finalCleanup();
const textEditAfter = await pgrep("-x", "TextEdit");
// Reported, never deleted: whether an entry is this run's or the user's cannot be told from here.
const autosave = TARGET === "textedit" ? textEditLeftovers().filter((x) => !autosaveBefore.has(x)) : [];

const md: string[] = [`# Executor on ${TARGET}, under act grants`, ""];
md.push(`Started by this script: ${TARGET} pid ${target.pid}, bystander fixture pid ${bystanderPid}. Reader without --act-pids. ${RUNS} runs per plan.`, "");
if (aborted !== null) md.push(`**deferred: user active**: ${aborted}. Rows below are the runs finished before that.`, "");
md.push("| Plan | Runs | Done and verified by the target | Claimed done but check failed | Rerun: done with 0 acts | Undo fully restored | Median ms per run | Means used |");
md.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
const med = (xs: number[]): number => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length === 0 ? NaN : (s[Math.floor(s.length / 2)] as number);
};
for (const name of Object.keys(target.plans)) {
  const rs = rows.filter((x) => x.plan === name);
  if (rs.length === 0) continue;
  const verified = rs.filter((x) => x.claimedDone && x.checkFailure === null).length;
  const lie = rs.filter((x) => x.claimedDone && x.checkFailure !== null).length;
  const rerun = rs.filter((x) => x.rerunOutcome === "done" && x.rerunActs === 0).length;
  const writes = rs.some((x) => x.means.some((m) => m.startsWith("write value")));
  const undoOk = rs.filter((x) => x.undo !== null && x.undoCheck === null).length;
  md.push(`| ${name} | ${rs.length} | ${verified} | ${lie} | ${rerun} | ${writes ? undoOk : "n/a (no value writes)"} | ${med(rs.map((x) => x.ms)).toFixed(0)} | ${JSON.stringify(count(rs.flatMap((x) => x.means)))} |`);
}
const notDone = rows.filter((x) => !x.claimedDone);
if (notDone.length > 0) md.push("", "Runs that did not finish:", ...notDone.map((x) => `- ${x.plan} ${x.run}: ${x.outcome} at step ${x.step}: ${x.detail}`));
md.push(
  "",
  `## Means, each alone (${BACKGROUND ? "target in the background: this script's fixture is in front" : FRONT ? "WebKit fixture activated, its form window key" : "target as launched"})`,
  "",
  "Landed is read from the target: the field holds the value written, it has the focus, or the press's effect shows. Silent means the reader answered ok and nothing landed.",
  "",
  "| Means | Runs | Reader ok | Landed | Silent | Reader lost the field | Example |",
  "| --- | --- | --- | --- | --- | --- | --- |",
);
for (const k of ["value", "focused", "insert", "press"] as const) {
  const xs = means.filter((x) => x.means === k);
  if (xs.length === 0) continue;
  const ex = xs.find((x) => !x.landed) ?? xs[0];
  md.push(`| ${k} | ${xs.length} | ${xs.filter((x) => x.outcome === "ok").length} | ${xs.filter((x) => x.landed).length} | ${xs.filter((x) => x.outcome === "ok" && !x.landed).length} | ${k === "press" || k === "focused" ? "n/a" : xs.filter((x) => x.readerSaw === undefined).length} | ${ex === undefined ? "" : `${ex.outcome}${ex.detail === null ? "" : ` (${ex.detail})`}: '${ex.before}' -> '${ex.after}'`} |`);
}
const sr = safety;
md.push(
  "",
  "## Safety cases",
  "",
  "Each refusal case must answer notAllowed and leave the field as it was; the control, the same write under a valid grant, must answer ok and write. Fields are read from the target, not the reader.",
  "",
  "| Case | Runs | Outcomes | Field as expected | Example detail |",
  "| --- | --- | --- | --- | --- |",
);
for (const k of ["pidOutside", "expired", "otherWindow", "control"] as const) {
  const xs = sr.filter((x) => x.kind === k);
  if (xs.length === 0) continue;
  md.push(`| ${k === "control" ? "control (valid grant)" : k} | ${xs.length} | ${JSON.stringify(count(xs.map((x) => x.outcome)))} | ${xs.filter((x) => x.asExpected).length} | ${xs[0]?.detail ?? ""} |`);
}
if (candidates.length > 0) {
  md.push(
    "",
    `## Write candidates, each alone (${RESPONDER ? "web view first responder, window not key" : BACKGROUND ? "this script's fixture in front" : FRONT ? "WebKit fixture frontmost, its form window key" : "target as launched"})`,
    "",
    "Landed is read from the page. Claimed is the candidate's own Accessibility read-back saying it landed; claimed but not landed must be 0. Raised: the window moved up the on-screen order. Activated: the target app became active. Collateral: another field or the page's Send changed. B20's paste-cg is not run: it wrote the general pasteboard, which no test may.",
    "",
    "| Candidate | Runs | Landed | Claimed | Claimed, not landed | Raised | Activated | Front app changed | Collateral | Skipped or errors | Example |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const k of CANDIDATE_NAMES) {
    const xs = candidates.filter((x) => x.candidate === k);
    if (xs.length === 0) continue;
    const ex = xs.find((x) => !x.landed) ?? xs[0];
    md.push(`| ${k} | ${xs.length} | ${xs.filter((x) => x.landed).length} | ${xs.filter((x) => x.claimed).length} | ${xs.filter((x) => x.claimed && !x.landed).length} | ${xs.filter((x) => x.raised).length} | ${xs.filter((x) => x.activated).length} | ${xs.filter((x) => x.frontChanged).length} | ${xs.filter((x) => x.collateral !== null).length} | ${xs.filter((x) => x.skipped || x.error !== null).length} | ${ex === undefined ? "" : `${ex.detail}${ex.error === null ? "" : `; ${ex.error}`}`} |`);
  }
}
md.push("", `## Frontmost app changes during the run`, "", switches.length === 0 ? "none" : switches.map((s) => `- ${new Date(s.at).toISOString()} ${s.from?.name ?? "?"} (${s.from?.pid ?? "?"}) -> ${s.to.name} (${s.to.pid})`).join("\n"));
md.push("", `## Cleanup`, "", `Processes still carrying this run's temporary profile after Chrome exited, then stopped: ${leftoverHelpers}. Temporary folders kept because one did not exit in time: ${JSON.stringify(keptDirs)}. TextEdit processes before: [${textEditBefore.join(", ")}], after: [${textEditAfter.join(", ")}]. New entries in TextEdit's autosave and saved-state folders: ${JSON.stringify(autosave)}.`);
md.push("", `Jev: ${jevCalls} calls, $${jevCost.toFixed(5)}. Helper errors: ${errors.length}.`);
writeFileSync(join(OUT, "real-target-eval.md"), md.join("\n") + "\n");
writeFileSync(join(OUT, "real-target-eval.json"), JSON.stringify({ target: TARGET, background: BACKGROUND, front: FRONT, responder: RESPONDER, aborted, rows, means, candidates, safety: sr, progress, errors, switches, jevCalls, jevCost, targetChoices: helper.executor.targetChoices }, null, 2) + "\n");
writeFileSync(join(OUT, "reader.log"), readerLog);
console.log(md.join("\n"));
process.exit(aborted === null ? 0 : 3);

function count(xs: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}

async function pgrep(...args: string[]): Promise<number[]> {
  try {
    return (await run("/usr/bin/pgrep", args)).stdout.trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** The entries of TextEdit's autosave and saved-state folders. */
function textEditLeftovers(): string[] {
  const c = join(homedir(), "Library/Containers/com.apple.TextEdit/Data/Library");
  return ["Autosave Information", "Saved Application State"].flatMap((d) => {
    const p = join(c, d);
    return existsSync(p) ? readdirSync(p).map((f) => `${d}/${f}`) : [];
  });
}
