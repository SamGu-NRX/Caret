// B20 acceptance 4 on caret-fixture with the real reader, under act grants only: a routine learns the press it
// ends with from the user's click, which the reader observes and never makes. The destination is the fixture's
// invite form, whose Send later and Send both read as outbound, so the window's buttons alone cannot say which
// one ends an occurrence (B19 learned "Send later or Send", ambiguous, and handed neither off).
//
// Three occurrences by hand: the order queue moves on, an invite form opens, the user's To and Order number are
// set, and the user clicks Send. The click is posted to the fixture's pid alone by experiments/press-observe.swift
// (built at --clicker), never through the HID stream, since that would land in whatever window is in front. Then
// Caret's run of the routine fills both fields and hands Send to the user, and the user clicks it again.
//
// --foreground starts the fixture with the accessory policy (it still never activates itself): a click posted to it
// then presses the button, and the reader places it by hit-test. The background-only default takes no posted
// click and cannot hit-test a covered window, so the reader places the click from its latest walk's frames and
// the fixture presses Send itself (B20 experiment, press-explore-results.log).
//
//   gui.sh 20 env CARET_GUI_LOCK=held node scripts/press-learn-eval.ts --bin ../apps/screen-reader/.build/debug --clicker PATH --out DIR [--foreground]
import { writeStore, writeStoreJson } from "../src/privacy/send.ts";
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { AskJev } from "../src/fill/jev.ts";
import type { TaskResult } from "../src/executor/executor.ts";
import { PROTOCOL_VERSION, type HelperMessage, type PatternOffer, type UserPress } from "../src/protocol.ts";
import { fixtureExecutable } from "./fixture-path.ts";
import { userInput } from "./synthetic-input.ts";
import { newLaunchSecret, sendSecret } from "../src/launch.ts";
/** The secret caret-screen gets on its standard input and the in-process helper proves itself with (B23). */
const launchSecret = newLaunchSecret();

const run = promisify(execFile);
const { values: a } = parseArgs({ options: { bin: { type: "string" }, clicker: { type: "string" }, out: { type: "string" }, foreground: { type: "boolean", default: false } } });
if (a.bin === undefined || a.out === undefined || a.clicker === undefined) throw new Error("--bin, --clicker and --out are required");
if (process.env.CARET_GUI_LOCK !== "held") throw new Error("run under the GUI wrapper: gui.sh 20 env CARET_GUI_LOCK=held node scripts/press-learn-eval.ts ...");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const CLICKER = resolve(a.clicker);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const fakeJev: AskJev = async (req) => ({
  model: "fake",
  answers: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, { choice: k === "name" ? (Object.keys(q.criteria).find((c) => c !== "none") ?? "none") : "none", confidence: 0.9 }])),
  inputTokens: 0,
  latencyMs: 0,
  costUsd: 0,
});
const sent: HelperMessage[] = [];
const presses: UserPress[] = [];
const log: string[] = [];
const verbs: string[] = [];
const dataDir = mkdtempSync(join(tmpdir(), "caret-press-learn-"));
const sockDir = mkdtempSync(join(tmpdir(), "caret-press-learn-sock-"));
const store = new Store(dataDir);
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  askJev: fakeJev,
  shadow: false,
  allowBackgroundFocus: false,
  settings: { roles: ["fill", "repeat", "watch", "calendar", "words"], level: "eager", paused: false },
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
  warn: (l) => log.push(l),
});
const origHandle = helper.handleReader.bind(helper);
helper.handleReader = (m) => {
  if (m.type === "userPress") presses.push(m);
  return origHandle(m);
};
server = new HelperServer(join(sockDir, "s.sock"), () => helper, (l) => log.push(l), launchSecret);
await server.listen();
const tick = setInterval(() => helper.tick(), 250);

const fixture: ChildProcessWithoutNullStreams = spawn(fixtureExecutable(a.bin), ["--windows", "forms", "--duration", "1800", ...(a.foreground === true ? ["--foreground"] : [])]);
let reader: ChildProcessWithoutNullStreams | null = null;
process.on("exit", () => {
  reader?.kill("SIGTERM");
  fixture.kill("SIGTERM");
  // The reader's socket lives in sockDir: both are deleted once the reader is gone (ps, as no exit events arrive here).
  const gone = (pid: number | undefined): boolean => pid === undefined || spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().replace(/^Z.*/, "") === "";
  const until = Date.now() + 10_000;
  while (!(gone(reader?.pid) && gone(fixture.pid)) && Date.now() < until) spawnSync("/bin/sleep", ["0.2"]);
  rmSync(dataDir, { recursive: true, force: true });
  if (gone(reader?.pid)) rmSync(sockDir, { recursive: true, force: true });
});
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(143));

// Someone using the Mac ends the run and closes its windows; the clicks this script posts are told apart.
const idleWatch = setInterval(() => {
  const out = spawnSync("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8" }).stdout;
  const ns = Number(/"HIDIdleTime" = (\d+)/.exec(out)?.[1] ?? NaN);
  if (!Number.isFinite(ns) || (ns / 1e9 < 5 && userInput(ns / 1e9))) {
    process.stderr.write(`deferred: user active (HID idle ${(ns / 1e9).toFixed(1)} s)\n`);
    process.exit(3);
  }
}, 1000);
idleWatch.unref();
/** Fails after `ms`, so a fixture that stops answering ends the run with a report instead of hanging it. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`no answer to ${what} within ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}
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
const fx = (cmd: string): Promise<Record<string, unknown>> =>
  within(
    new Promise((res) => {
      replies.push(res);
      fixture.stdin.write(cmd + "\n");
    }),
    15_000,
    `the fixture's '${cmd}'`,
  );
async function until<T>(what: string, f: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const windowTitled = (title: string) => [...helper.model.windows.values()].find((w) => w.window.title === title);
const walk = async (windowId: string): Promise<void> => {
  const w = helper.model.windows.get(windowId);
  if (w === undefined) throw new Error(`window ${windowId} is gone`);
  const r = await helper.readerVerb({ kind: "walk", pid: w.app.pid, windowId });
  if (r.outcome !== "ok") throw new Error(`walk ${windowId}: ${r.outcome} ${r.detail ?? ""}`);
};
const since = <T extends HelperMessage["type"]>(type: T, from: number): Extract<HelperMessage, { type: T }>[] =>
  sent.slice(from).filter((m): m is Extract<HelperMessage, { type: T }> => m.type === type);

const QUEUE = "Caret Fixture — Order queue";
async function nextOrder(): Promise<{ email: string; order: string }> {
  const r = (await fx("form next")) as unknown as { email: string; order: string };
  const q = windowTitled(QUEUE);
  if (q === undefined) throw new Error("the order queue is not in the screen model");
  await walk(q.window.windowId);
  await until(`the queue to show ${r.order}`, () => [...(windowTitled(QUEUE)?.nodes.values() ?? [])].some((n) => (n.label ?? "").includes(r.order)), 5000);
  return r;
}
async function openInvite(): Promise<{ title: string; windowId: string }> {
  const r = await fx("form open invite");
  const title = String(r.title);
  const w = await until(`the ${title} window`, () => windowTitled(title));
  return { title, windowId: w.window.windowId };
}

interface Click {
  observedBy: Record<string, string[]>;
  pressedByClick: boolean;
  userPresses: number;
}
const clicks: Click[] = [];
/**
 * The user clicks Send: posted to the fixture's pid at the button's centre. Whether the click itself pressed
 * the button is read from the fixture's own count; when it did not, the fixture presses it, so the occurrence
 * still ends the way the user ended it, and the report says so.
 */
async function clickSend(title: string, windowId: string): Promise<void> {
  const before = Number((await fx("form dump invite")).sent);
  const pressesBefore = presses.length;
  // The clicker marks CARET_SYNTHETIC_FILE around the click it posts, so the idle watch knows it for its own.
  const { stdout } = await run(CLICKER, [String(fixturePid), title, "Send"], { timeout: 20_000 });
  const probe = JSON.parse(stdout) as { seen?: Record<string, string[]> };
  await sleep(500);
  const pressedByClick = Number((await fx("form dump invite")).sent) > before;
  if (!pressedByClick) await fx("form press invite Send");
  await until(`window ${windowId} to close`, () => !helper.model.windows.has(windowId));
  clicks.push({ observedBy: probe.seen ?? {}, pressedByClick, userPresses: presses.length - pressesBefore });
}

const checks: Record<string, boolean> = {};
const result: Record<string, unknown> = { foreground: a.foreground === true, checks, clicks };
let ok = false;
try {
  await until("the fixture", () => fixturePid > 0);
  await sleep(800);
  reader = spawn(join(a.bin, "caret-screen"), ["--auth-fd", "0", "--socket", join(sockDir, "s.sock"), "--only-pids", String(fixturePid), "--event-pids", String(fixturePid)]);
  let readerErr = "";
  reader.stderr.setEncoding("utf8");
  sendSecret(reader, launchSecret);
  reader.stderr.on("data", (d: string) => (readerErr += d));
  await until("the order queue", () => windowTitled(QUEUE));
  const rule = helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "rule", op: "edit", id: "permission-writeElsewhere", fields: { rule: "actIfApproved" } });
  if (rule.error !== null) throw new Error(rule.error);

  for (let i = 0; i < 3; i++) {
    const o = await nextOrder();
    const w = await openInvite();
    await walk(w.windowId);
    for (const [field, value] of [["to", o.email], ["order", o.order]] as const) {
      await fx(`form set invite ${field} ${value}`);
      await walk(w.windowId);
      await sleep(300);
    }
    await sleep(2200);
    await clickSend(w.title, w.windowId);
  }
  await helper.patterns.skills.namesSettled();
  const routine = helper.memory.list("routine")[0];
  const record = routine === undefined ? null : helper.memory.routine(routine.id);
  result.routine = record;
  checks.everyClickReported = clicks.every((c) => c.userPresses === 1) && presses.every((p) => p.label === "Send" && p.role === "AXButton" && p.key !== null);
  checks.learnedFromClick = record?.finish?.label === "Send" && record.finish.by === "click" && record.finish.ambiguous !== true;

  // The next occurrence: Caret fills both fields and hands Send to the user.
  const o = await nextOrder();
  const at = sent.length;
  const w = await openInvite();
  const offer = await until("the routine offer", () => since("patternOffer", at).find((x: PatternOffer) => x.kind === "routine" && x.windowId === w.windowId), 8000);
  const pressVerbs = verbs.filter((v) => v === "press").length;
  const r = (await helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: offer.id, action: "take" })) as TaskResult | null;
  const dump = (await fx("form dump invite")) as { fields: Record<string, string> };
  const last = since("taskProgress", at).filter((p) => p.taskId === offer.id).at(-1);
  result.nextRun = { result: r, last, fixture: dump.fields };
  checks.nextRunHandsSendOff = r?.outcome === "handoff" && r.step === 2 && last?.phase === "handoff" && last.says === "You press 'Send'";
  checks.nextRunFilled = dump.fields.to === o.email && dump.fields.order === o.order;
  checks.caretNeverPressed = verbs.filter((v) => v === "press").length === pressVerbs && !verbs.includes("press");
  await clickSend(w.title, w.windowId);
  checks.watchAsked = verbs.includes("watchPresses");
  result.readerLogTail = readerErr.split("\n").slice(-8);
  ok = Object.values(checks).every((v) => v);
} catch (e) {
  result.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
} finally {
  clearInterval(tick);
  reader?.kill("SIGTERM");
  fixture.kill("SIGTERM");
  await server.close();
  helper.memory.close();
  store.close();
}
result.presses = presses;
result.verbs = Object.fromEntries([...new Set(verbs)].map((v) => [v, verbs.filter((x) => x === v).length]));
result.log = log.slice(-20);
result.ok = ok;
writeStoreJson(join(OUT, "press-learn.json"), result, 2);
console.log(JSON.stringify({ ok, error: result.error ?? null, checks, clicks }, null, 1));
process.exit(ok ? 0 : 1);
