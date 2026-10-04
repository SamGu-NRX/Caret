// B20 part 3: B19's skill flow in a real app this script starts itself, under act grants only (the reader has no
// --act-pids), with a fake Jev that names the routine by the first of code's names.
//   chromium  Google Chrome (direct exec) with a temporary profile. Each occurrence opens the web form
//             (fixtures/web/form.html) in a new Chrome window and closes it afterwards, through DevTools.
//   electron  the minimal Electron app (fixtures/electron/main.cjs) run from a temporary directory, from an
//             Electron installed by scripts/electron-setup.sh into --electron DIR; each occurrence is a new
//             window on the same form, opened and closed over the app's stdin.
// The destination is fixtures/web/intake.html: three fields and no buttons, so no risky press is learned as the
// routine's finish (B19 never promotes a skill that ends in one).
// The source is caret-fixture's order queue (`--windows forms`), which shows one invented order at a time, so
// no earlier window showed the values. The user's part, copying Name, Email and the order number into the
// form, is played through the page's own JavaScript, and the page's own state is the check for every value.
//
// The flow: three occurrences by hand at Eager, then Caret's run taken with Tab, whose end brings the keep
// offer (accepted); ten clean runs with Tab, the tenth bringing the promote offer (accepted); one run with no
// Tab, verified by the page, then undone and checked empty; then a run taken over by the user at its second
// step, which must stop writing there and put the skill back on Tab.
//
// It opens windows, so run it under the GUI wrapper (gui.lock, idle Mac):
//   gui.sh 30 env CARET_GUI_LOCK=held node scripts/skills-real-eval.ts --target chromium|electron --bin ../apps/screen-reader/.build/debug --out DIR [--electron DIR]
import { execFileSync, spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { AskJev } from "../src/fill/jev.ts";
import type { TaskResult } from "../src/executor/executor.ts";
import { PROTOCOL_VERSION, type HelperMessage, type PatternOffer, type SkillOffer, type TaskProgress } from "../src/protocol.ts";
import { PROMOTE_AFTER } from "../src/patterns/skills.ts";
import { Cdp } from "./cdp.ts";
import { fixtureExecutable } from "./fixture-path.ts";
import { userInput } from "./synthetic-input.ts";

const { values: a } = parseArgs({ options: { target: { type: "string", default: "chromium" }, bin: { type: "string" }, out: { type: "string" }, electron: { type: "string" } } });
const TARGET = a.target;
if (TARGET !== "chromium" && TARGET !== "electron") throw new Error("--target is chromium or electron");
if (TARGET === "electron" && a.electron === undefined) throw new Error("--target electron needs --electron DIR (scripts/electron-setup.sh)");
if (a.bin === undefined || a.out === undefined) throw new Error("--bin and --out are required");
if (process.env.CARET_GUI_LOCK !== "held") throw new Error("run under the GUI wrapper: gui.sh 30 env CARET_GUI_LOCK=held node scripts/skills-real-eval.ts ...");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const FORM = resolve(import.meta.dirname, "../fixtures/web/intake.html");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TITLE = "Caret Intake — Web";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// MARK: - processes this script started, and only those

const own: ChildProcess[] = [];
const tempDirs: string[] = [];
/** True while `pid` exists and is not a zombie. Read from ps: in the exit handler no child-exit events arrive. */
function alive(pid: number): boolean {
  const st = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return st !== "" && !st.startsWith("Z");
}
/**
 * Stops what this script started, waits up to 10 s for it to exit, then stops any process whose arguments carry
 * one of this script's temporary profiles as a whole argument (Chrome's helpers), waits for those too, and only
 * then deletes the directories; one still in use is left in place. Synchronous, so the exit handler can run it.
 */
function cleanup(): void {
  const pids = own.flatMap((p) => (p.pid === undefined || p.exitCode !== null || p.signalCode !== null ? [] : [p.pid]));
  for (const p of own) if (p.exitCode === null && p.signalCode === null) p.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (pids.some(alive) && Date.now() < deadline) spawnSync("/bin/sleep", ["0.2"]);
  for (const p of own) if (p.pid !== undefined && alive(p.pid)) p.kill("SIGKILL");
  const killed = Date.now() + 2000;
  while (pids.some(alive) && Date.now() < killed) spawnSync("/bin/sleep", ["0.2"]);
  // A folder is deleted only when no process this script started is left, and none of Chrome's helpers.
  const ownLeft = pids.some(alive);
  for (const d of tempDirs.splice(0)) {
    const left = execFileSync("/bin/ps", ["-axww", "-o", "pid=,args="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.split(/\s+/).includes(`--user-data-dir=${d}`))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((p) => p > 1 && p !== process.pid);
    for (const p of left) {
      try {
        process.kill(p, "SIGTERM");
      } catch {
        // already gone
      }
    }
    const until = Date.now() + 5000;
    while (left.some(alive) && Date.now() < until) spawnSync("/bin/sleep", ["0.2"]);
    if (!ownLeft && !left.some(alive)) rmSync(d, { recursive: true, force: true });
    else process.stderr.write(`kept ${d}: a process using it did not exit\n`);
  }
}
process.on("exit", cleanup);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(143));

// Someone using the Mac ends the run and closes its windows (the GUI gate's rule; gui.sh enforces it too).
// This script posts no input of its own, so any HID idle under 5 s is someone else's.
const idleWatch = setInterval(() => {
  const out = spawnSync("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8" }).stdout;
  const ns = Number(/"HIDIdleTime" = (\d+)/.exec(out)?.[1] ?? NaN);
  if (!Number.isFinite(ns) || (ns / 1e9 < 5 && userInput(ns / 1e9))) {
    process.stderr.write(`deferred: user active (HID idle ${(ns / 1e9).toFixed(1)} s)\n`);
    process.exit(3);
  }
}, 1000);
idleWatch.unref();

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

// MARK: - helper in process

const fakeJev: AskJev = async (req) => ({
  model: "fake",
  answers: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, { choice: k === "name" ? (Object.keys(q.criteria).find((c) => c !== "none") ?? "none") : "none", confidence: 0.9 }])),
  inputTokens: 0,
  latencyMs: 0,
  costUsd: 0,
});
const sent: HelperMessage[] = [];
const log: string[] = [];
const verbs: string[] = [];
const dataDir = mkdtempSync(join(tmpdir(), "caret-skills-real-"));
tempDirs.push(dataDir);
const sockDir = mkdtempSync(join(tmpdir(), "caret-skills-real-sock-"));
tempDirs.push(sockDir);
const store = new Store(dataDir);
let server: HelperServer | null = null;
/** The task to take over at its second step's act, as the user grabbing the window mid-run. */
let takeOverTask: string | null = null;
let helper: Helper;
helper = new Helper({
  store,
  askJev: fakeJev,
  shadow: false,
  allowBackgroundFocus: false,
  settings: { roles: ["fill", "repeat", "watch", "calendar", "words"], level: "eager", paused: false },
  // About 20 routine offers in a few minutes; Eager's hourly budget is 8.
  offersPerHour: 1000,
  publish: (m) => {
    sent.push(m);
    if (m.type === "error") log.push(`helper error: ${m.message}`);
    server?.publish(m);
  },
  sendToReader: (cmd) => {
    if (cmd.type === "readerCommand") verbs.push(cmd.verb.kind);
    return server?.sendToReader(cmd) ?? false;
  },
  executorHooks: {
    beforeAct: async (taskId, step) => {
      if (takeOverTask === taskId && step === 1) {
        takeOverTask = null;
        await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId, action: "takeOver" });
      }
    },
  },
  warn: (l) => log.push(l),
});
server = new HelperServer(join(sockDir, "s.sock"), () => helper, (l) => log.push(l));
// This script answers offers itself, in process, so it is the host session a run with no Tab is bound to (B22, S1 audit #5).
helper.hostConnected("eval");
await server.listen();
const tick = setInterval(() => helper.tick(), 250);

const since = <T extends HelperMessage["type"]>(type: T, from: number): Extract<HelperMessage, { type: T }>[] =>
  sent.slice(from).filter((m): m is Extract<HelperMessage, { type: T }> => m.type === type);
async function until<T>(what: string, f: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const walk = async (windowId: string): Promise<void> => {
  const w = helper.model.windows.get(windowId);
  if (w === undefined) throw new Error(`window ${windowId} is gone`);
  const r = await helper.readerVerb({ kind: "walk", pid: w.app.pid, windowId });
  if (r.outcome !== "ok") throw new Error(`walk ${windowId}: ${r.outcome} ${r.detail ?? ""}`);
};

// MARK: - the source: caret-fixture's order queue

const fixture: ChildProcessWithoutNullStreams = spawn(fixtureExecutable(a.bin), ["--windows", "forms", "--duration", "3600"]);
own.push(fixture);
let fixturePid = 0;
const replies: ((o: Record<string, unknown>) => void)[] = [];
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
    else if (line.startsWith("{")) replies.shift()?.(JSON.parse(line) as Record<string, unknown>);
  }
});
/** Fails after `ms`, so a child that stops answering ends the run with a report instead of hanging it. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`no answer to ${what} within ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}
const fx = (cmd: string): Promise<Record<string, unknown>> =>
  within(
    new Promise((res) => {
      replies.push(res);
      fixture.stdin.write(cmd + "\n");
    }),
    15_000,
    `the fixture's '${cmd}'`,
  );
const QUEUE = "Caret Fixture — Order queue";
interface Order {
  name: string;
  email: string;
  order: string;
}
const windowTitled = (title: string, pid?: number) => [...helper.model.windows.values()].find((w) => w.window.title === title && (pid === undefined || w.app.pid === pid));
async function nextOrder(): Promise<Order> {
  const r = (await fx("form next")) as unknown as Order;
  const q = windowTitled(QUEUE);
  if (q === undefined) throw new Error("the order queue is not in the screen model");
  await walk(q.window.windowId);
  await until(`the queue to show ${r.order}`, () => [...(windowTitled(QUEUE)?.nodes.values() ?? [])].some((n) => (n.label ?? "").includes(r.order)), 5000);
  return { name: r.name, email: r.email, order: r.order };
}
/** The form's fields by element id, as the page names them, for what each occurrence copies. */
const fieldsOf = (o: Order): Record<string, string> => ({ name: o.name, email: o.email, reference: o.order });

// MARK: - the target

/** A window of the target showing the form, with its page's JavaScript. */
interface Page {
  id: string;
  windowId: string;
  js(expr: string): Promise<unknown>;
}
/** Opens and closes form windows in the target app, which this script started. */
interface Browser {
  pid: number;
  open(n: number): Promise<{ id: string; js(expr: string): Promise<unknown> }>;
  close(id: string): Promise<void>;
  /** Ends the connection to the app; the process itself is stopped with the others. */
  quit(): void;
}

async function chromeBrowser(): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "caret-chromium-profile-"));
  tempDirs.push(profile);
  const chrome = spawn(CHROME, [
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--remote-debugging-port=0",
    "--disable-extensions", "--disable-background-networking", "--new-window", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  own.push(chrome);
  chrome.stderr?.setEncoding("utf8");
  chrome.stderr?.on("data", (d: string) => (targetLog = (targetLog + d).slice(-20_000)));
  const portFile = join(profile, "DevToolsActivePort");
  await until("Chrome's DevTools port", () => existsSync(portFile), 30_000);
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
  return {
    pid: chrome.pid ?? -1,
    open: async (n) => {
      const { targetId } = (await cdp.send("Target.createTarget", { url: `${pathToFileURL(FORM).href}?occ=${n}`, newWindow: true })) as { targetId: string };
      const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
      return { id: targetId, js: (expr) => cdp.evaluate(sessionId, expr) };
    },
    close: async (id) => void (await cdp.send("Target.closeTarget", { targetId: id })),
    quit: () => cdp.close(),
  };
}

async function electronBrowser(): Promise<Browser> {
  const exe = join(resolve(a.electron ?? ""), "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  if (!existsSync(exe)) throw new Error(`no ${exe}; run scripts/electron-setup.sh first`);
  const appDir = mkdtempSync(join(tmpdir(), "caret-electron-app-"));
  tempDirs.push(appDir);
  copyFileSync(resolve(import.meta.dirname, "../fixtures/electron/main.cjs"), join(appDir, "main.cjs"));
  // main.cjs loads form.html from its directory; here that is the intake page.
  copyFileSync(FORM, join(appDir, "form.html"));
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "caret-electron-eval", main: "main.cjs" }) + "\n");
  const profile = mkdtempSync(join(tmpdir(), "caret-electron-profile-"));
  tempDirs.push(profile);
  // A blank first window, so the form windows each occurrence opens are the only ones titled as the form.
  // Without ELECTRON_RUN_AS_NODE, which an Electron host such as the agent's own sets for its children: with it
  // the binary runs as plain Node and cannot load the app (B20 exploration).
  const { ELECTRON_RUN_AS_NODE: _asNode, ...env } = process.env;
  const proc: ChildProcessWithoutNullStreams = spawn(exe, [appDir, `--user-data-dir=${profile}`, "--caret-blank"], { env });
  own.push(proc);
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d: string) => (targetLog = (targetLog + d).slice(-20_000)));
  let ebuf = "";
  const waiting: ((l: string) => void)[] = [];
  const ready: string[] = [];
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d: string) => {
    ebuf += d;
    let nl: number;
    while ((nl = ebuf.indexOf("\n")) >= 0) {
      const l = ebuf.slice(0, nl);
      ebuf = ebuf.slice(nl + 1);
      const w = waiting.shift();
      if (w !== undefined) w(l);
      else ready.push(l);
    }
  });
  const line = (): Promise<string> => within(new Promise((r) => (ready.length > 0 ? r(ready.shift() as string) : waiting.push(r))), 30_000, "the electron app");
  const first = await line();
  if (!first.startsWith(`caret-electron pid ${proc.pid}`)) throw new Error(`the electron app said '${first}'`);
  const ask = async (cmd: string): Promise<Record<string, unknown>> => {
    proc.stdin.write(cmd + "\n");
    const r = JSON.parse(await line()) as Record<string, unknown>;
    if (r.ok !== true) throw new Error(`electron ${cmd.split(" ")[0]}: ${String(r.error)}`);
    return r;
  };
  return {
    pid: proc.pid ?? -1,
    open: async (n) => {
      const id = String((await ask(`open occ=${n}`)).id);
      return { id, js: async (expr) => (await ask(`in ${id} ${expr}`)).value };
    },
    close: async (id) => void (await ask(`close ${id}`)),
    quit: () => proc.stdin.end(),
  };
}

let targetLog = "";
const browser = TARGET === "chromium" ? await chromeBrowser() : await electronBrowser();
const targetPid = browser.pid;
let occurrence = 0;
const openPages = new Set<string>();
/** Opens the form in a new window and waits until the screen model holds it with its three fields. */
async function openForm(): Promise<Page> {
  occurrence++;
  const p = await browser.open(occurrence);
  await until("the page to load", async () => {
    try {
      return (await p.js("typeof caretState")) === "function";
    } catch {
      return false;
    }
  }, 20_000);
  const w = await until("the form window with its fields in the screen model", () =>
    [...helper.model.windows.values()].find(
      (x) => x.app.pid === targetPid && x.window.title.startsWith(TITLE) && !openPages.has(x.window.windowId) && ["Name", "Email", "Reference"].every((l) => [...x.nodes.values()].some((n) => n.editable === true && n.label === l)),
    ), 30_000);
  openPages.add(w.window.windowId);
  return { id: p.id, windowId: w.window.windowId, js: p.js };
}
async function closeForm(p: Page): Promise<void> {
  await browser.close(p.id);
  await until(`window ${p.windowId} to close`, () => !helper.model.windows.has(p.windowId));
  openPages.delete(p.windowId);
}
const state = async (p: Page): Promise<Record<string, string>> => ((await p.js("caretState()")) as { fields: Record<string, string> }).fields;

// MARK: - occurrences

/** The user copies each value from the queue into a fresh form, one field at a time, then closes it. */
async function byHand(values: Record<string, string>): Promise<void> {
  const p = await openForm();
  await walk(p.windowId);
  for (const [field, value] of Object.entries(values)) {
    await p.js(`caretSeed(${JSON.stringify(field)}, ${JSON.stringify(value)})`);
    await walk(p.windowId);
    await sleep(300);
  }
  // Each edit settles before it is judged (transfers.ts SETTLE_MS).
  await sleep(2200);
  await closeForm(p);
}

interface Run {
  n: number;
  tab: boolean;
  outcome: string;
  step: number | null;
  stopReason: string | null;
  unprompted: boolean;
  verified: boolean;
  page: Record<string, string>;
  skillOffers: string[];
  ms: number;
}
const runs: Run[] = [];
/** One occurrence for Caret: a routine offer taken with Tab, or a run that starts on its own. The form stays open. */
async function caretRun(expect: Record<string, string>, opts: { takeOver?: boolean } = {}): Promise<{ run: Run; page: Page; taskId: string; offers: SkillOffer[] }> {
  const at = sent.length;
  const t0 = Date.now();
  const p = await openForm();
  const ownRun = (): TaskProgress | undefined => since("taskProgress", at).find((x) => x.unprompted === true);
  const offer = await until(`a routine offer or a run with no Tab in ${p.windowId}`, () => since("patternOffer", at).find((o: PatternOffer) => o.kind === "routine" && o.windowId === p.windowId) ?? ownRun(), 10_000);
  let result: { outcome: string; step: number | null } | null = null;
  let taskId: string;
  if ("kind" in offer) {
    taskId = offer.id;
    if (opts.takeOver === true) takeOverTask = taskId;
    const r = (await helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: offer.id, action: "take" })) as TaskResult | null;
    result = r === null ? null : { outcome: r.outcome, step: r.step };
  } else {
    taskId = offer.taskId;
    await helper.patterns.unpromptedSettled();
  }
  const progress = since("taskProgress", at).filter((x) => x.taskId === taskId);
  const last = progress.at(-1);
  const page = await state(p);
  const verified = Object.entries(expect).every(([k, v]) => page[k] === v);
  const offers = since("skillOffer", at);
  const run: Run = {
    n: runs.length + 1,
    tab: "kind" in offer,
    outcome: result?.outcome ?? last?.phase ?? "none",
    step: result?.step ?? last?.step ?? null,
    stopReason: last?.phase === "stopped" ? last.stopReason : null,
    unprompted: progress.length > 0 && progress.every((x) => x.unprompted === true),
    verified,
    page,
    skillOffers: offers.map((o) => o.kind),
    ms: Date.now() - t0,
  };
  runs.push(run);
  process.stdout.write(`run ${run.n} ${run.tab ? "tab" : "no tab"} ${run.outcome}${run.stopReason === null ? "" : ` (${run.stopReason})`} ${verified ? "verified" : "NOT VERIFIED"} ${run.skillOffers.join(",")} ${run.ms} ms\n`);
  return { run, page: p, taskId, offers };
}
const answer = (o: SkillOffer | undefined, ans: "accept" | "decline"): void => {
  if (o === undefined) throw new Error("expected a skill offer");
  helper.handleSkillAnswer({ type: "skillAnswer", v: PROTOCOL_VERSION, id: o.id, answer: ans, at: Date.now() });
};
const skill = () => helper.memory.list("skill").find((e) => e.kind === "skill") as { status: string; fields: { cleanRuns: number; onItsOwn: boolean; handsOff: unknown } } | undefined;

// MARK: - the run

const checks: Record<string, boolean> = {};
const result: Record<string, unknown> = { checks, runs };
let reader: ChildProcessWithoutNullStreams | null = null;
let readerErr = "";
let ok = false;
try {
  await until("the fixture", () => fixturePid > 0);
  reader = spawn(join(a.bin, "caret-screen"), ["--socket", join(sockDir, "s.sock"), "--only-pids", `${fixturePid},${targetPid}`, "--event-pids", `${fixturePid},${targetPid}`]);
  own.push(reader);
  reader.stderr.setEncoding("utf8");
  reader.stderr.on("data", (d: string) => (readerErr += d));
  await until("the order queue", () => windowTitled(QUEUE), 20_000);
  const rule = helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "rule", op: "edit", id: "permission-writeElsewhere", fields: { rule: "actIfApproved" } });
  if (rule.error !== null) throw new Error(rule.error);

  for (let i = 0; i < 3; i++) await byHand(fieldsOf(await nextOrder()));
  await helper.patterns.skills.namesSettled();
  result.routine = helper.memory.list("routine");
  let o = await nextOrder();
  let r = await caretRun(fieldsOf(o));
  await closeForm(r.page);
  checks.firstRunVerified = r.run.tab && r.run.outcome === "done" && r.run.verified;
  checks.keepOffer = r.offers.some((x) => x.kind === "keep");
  answer(r.offers.find((x) => x.kind === "keep"), "accept");
  checks.kept = skill()?.status === "learning";

  // Ten clean runs with Tab; the promote offer comes with the tenth and not before.
  let early = 0;
  for (let i = 1; i <= PROMOTE_AFTER; i++) {
    r = await caretRun(fieldsOf(await nextOrder()));
    await closeForm(r.page);
    if (i < PROMOTE_AFTER && r.offers.length > 0) early++;
  }
  checks.noOfferBeforeTen = early === 0;
  checks.tenCleanTabRuns = runs.slice(-PROMOTE_AFTER).every((x) => x.tab && x.outcome === "done" && x.verified);
  const promote = r.offers.find((x) => x.kind === "promote");
  checks.promoteAtTenth = promote !== undefined;
  answer(promote, "accept");
  checks.onItsOwn = skill()?.status === "active";

  // No Tab: verified by the page; undo restores it, checked by the page.
  o = await nextOrder();
  r = await caretRun(fieldsOf(o));
  checks.unpromptedVerified = !r.run.tab && r.run.unprompted && r.run.outcome === "done" && r.run.verified;
  const undo = await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: r.taskId, action: "undo" });
  const afterUndo = await state(r.page);
  result.undo = { result: undo, page: afterUndo };
  checks.undoRestored = ["name", "email", "reference"].every((k) => afterUndo[k] === "");
  checks.undoResetToTab = skill()?.status === "learning" && skill()?.fields.cleanRuns === 0;
  await closeForm(r.page);

  // Take over at the second step of a Tab run: the plan's first field is written, the rest are not, and the count goes back to 0.
  for (let i = 1; i <= 2; i++) {
    r = await caretRun(fieldsOf(await nextOrder()));
    await closeForm(r.page);
  }
  const cleanBefore = skill()?.fields.cleanRuns ?? -1;
  o = await nextOrder();
  r = await caretRun(fieldsOf(o), { takeOver: true });
  result.takeOver = { run: r.run, cleanBefore, skillAfter: skill() };
  const written = ["name", "email", "reference"].filter((k) => r.run.page[k] !== "");
  const want = fieldsOf(o);
  checks.takeOverPaused = r.run.outcome === "paused" && written.length === 1 && written.every((k) => r.run.page[k] === want[k]);
  checks.takeOverResets = cleanBefore === 2 && skill()?.fields.cleanRuns === 0 && skill()?.status === "learning";
  await closeForm(r.page);

  result.skills = helper.memory.list("skill");
  ok = Object.values(checks).every((v) => v);
} catch (e) {
  result.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
} finally {
  clearInterval(tick);
  // Why an occurrence got no offer: the gate's last decisions, and the windows the model held.
  result.decisions = helper.memory.decisions().slice(-30);
  result.windows = [...helper.model.windows.values()].map((w) => ({ id: w.window.windowId, app: w.app.name, title: w.window.title, editable: [...w.nodes.values()].filter((n) => n.editable === true).map((n) => [n.label, n.value ?? ""]) }));
  fronts.push(front());
  browser.quit();
  await server.close();
  helper.memory.close();
  store.close();
}
result.frontSamples = fronts;
result.verbs = Object.fromEntries([...new Set(verbs)].map((v) => [v, verbs.filter((x) => x === v).length]));
result.log = log.slice(-30);
result.readerLogTail = readerErr.split("\n").slice(-10);
result.target = TARGET;
result.targetLogTail = targetLog.split("\n").slice(-5);
result.ok = ok;
writeFileSync(join(OUT, "skills-real.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ok, error: result.error ?? null, checks, runs: runs.length }, null, 1));
process.exit(ok ? 0 : 1);
