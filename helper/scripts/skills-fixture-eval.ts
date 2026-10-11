// B19 acceptance 3 on caret-fixture with the real reader, under act grants only (no --act-pids), with a fake
// Jev that names each routine by the first of code's names. Two routines copy the fixture's next order (its
// Order queue window shows one invented record at a time; `form next` moves on, so no earlier window showed
// the values) into forms the fixture opens fresh for each occurrence:
//   intake: Customer, Email and Order number, no buttons. Learned by hand three times at Eager, then run by
//     Caret: keep accepted, ten clean runs bring the promote offer, run 11 starts with no Tab, verifies, and
//     undo restores it. Undo resets the count (the brief's rule), so it earns the offer again over ten more
//     runs; then a forced mismatch on a run with no Tab resets it, and the next run needs Tab.
//   reply: To and Order number, with Save draft and Send. The user presses Send each time by hand. Caret's
//     runs fill both fields and hand Send to the user; the skill is never offered to run on its own, and
//     the reader is never asked to press anything.
// "Undoable changes in other apps" is set to act if pre-approved first: the fixture is never the window the
// user is in, so every write is "write elsewhere", which the permission caps at ask first otherwise.
// The fixture's own dump, not the helper's reading, is the check for every value.
//
// The fixture opens windows (behind others), so run it under the GUI wrapper, which holds gui.lock and waits
// until nobody is using the Mac:
//   gui.sh env CARET_GUI_LOCK=held node scripts/skills-fixture-eval.ts --bin ../apps/screen-reader/.build/debug --out DIR
import { writeStore, writeStoreJson } from "../src/privacy/send.ts";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { AskJev } from "../src/fill/jev.ts";
import type { TaskResult } from "../src/executor/executor.ts";
import { PROTOCOL_VERSION, type HelperMessage, type PatternOffer, type SkillOffer, type TaskProgress } from "../src/protocol.ts";
import { PROMOTE_AFTER } from "../src/patterns/skills.ts";
import { fixtureExecutable } from "./fixture-path.ts";
import { newLaunchSecret, sendSecret } from "../src/launch.ts";
/** The secret caret-screen gets on its standard input and the in-process helper proves itself with (B23). */
const launchSecret = newLaunchSecret();

const { values: a } = parseArgs({ options: { bin: { type: "string" }, out: { type: "string" }, socket: { type: "string", default: join(homedir(), ".caret-run", "sockets", "skills-fixture.sock") } } });
if (a.bin === undefined || a.out === undefined) throw new Error("--bin and --out are required");
if (process.env.CARET_GUI_LOCK !== "held") throw new Error("run under the GUI wrapper: gui.sh env CARET_GUI_LOCK=held node scripts/skills-fixture-eval.ts ...");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });

const QUEUE = "Caret Fixture — Order queue";
interface Order {
  name: string;
  email: string;
  order: string;
}
const intakeOf = (o: Order): Record<string, string> => ({ customer: o.name, email: o.email, order: o.order });
const replyOf = (o: Order): Record<string, string> => ({ to: o.email, order: o.order });

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
const frontBefore = front();
const fronts: Front[] = [frontBefore];

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
const dataDir = mkdtempSync(join(tmpdir(), "caret-skills-fixture-"));
const store = new Store(dataDir);
let server: HelperServer | null = null;
/** Set before the forced-mismatch run: its second step's act turns on the fixture's mangling, once. */
let mangleNext = false;
let fx: (cmd: string) => Promise<Record<string, unknown>> = async () => ({});
const helper = new Helper({
  store,
  askJev: fakeJev,
  shadow: false,
  allowBackgroundFocus: false,
  settings: { roles: ["fill", "repeat", "watch", "calendar", "words"], level: "eager", paused: false },
  // About 40 routine offers in a few minutes; Eager's hourly budget is 8.
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
    beforeAct: async (_taskId, step) => {
      if (mangleNext && step === 1) {
        mangleNext = false;
        await fx("form mangle intake on");
      }
    },
  },
  warn: (l) => log.push(l),
});
server = new HelperServer(a.socket, () => helper, (l) => log.push(l), launchSecret);
// This script answers offers itself, in process, so it is the host session a run with no Tab is bound to (B22, S1 audit #5).
helper.hostConnected("eval");
await server.listen();
const tick = setInterval(() => helper.tick(), 250);

// MARK: - fixture and reader, the only processes this script may signal

const fixture: ChildProcessWithoutNullStreams = spawn(fixtureExecutable(a.bin), ["--windows", "forms", "--duration", "1800"]);
let reader: ChildProcessWithoutNullStreams | null = null;
process.on("exit", () => {
  reader?.kill("SIGTERM");
  fixture.kill("SIGTERM");
});
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(143));
let fixturePid = 0;
let fixtureErr = "";
let foreground: Front | null = null;
const ours = (pid: number): boolean => pid > 0 && (pid === fixture.pid || pid === fixturePid || pid === (reader?.pid ?? -1));
const frontPoll = setInterval(() => {
  const f = front();
  fronts.push(f);
  if (foreground === null && ours(f.pid)) {
    foreground = f;
    reader?.kill("SIGTERM");
    fixture.kill("SIGTERM");
  }
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
fx = (cmd: string): Promise<Record<string, unknown>> =>
  new Promise((res) => {
    replies.push(res);
    fixture.stdin.write(cmd + "\n");
  });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    if (foreground !== null) throw new Error("deferred: foreground");
    const v = f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// MARK: - occurrences

const windowTitled = (title: string) => [...helper.model.windows.values()].find((w) => w.window.title === title);
const walk = async (windowId: string): Promise<void> => {
  const w = helper.model.windows.get(windowId);
  if (w === undefined) throw new Error(`window ${windowId} is gone`);
  const r = await helper.readerVerb({ kind: "walk", pid: w.app.pid, windowId });
  if (r.outcome !== "ok") throw new Error(`walk ${windowId}: ${r.outcome} ${r.detail ?? ""}`);
};
const since = <T extends HelperMessage["type"]>(type: T, from: number): Extract<HelperMessage, { type: T }>[] =>
  sent.slice(from).filter((m): m is Extract<HelperMessage, { type: T }> => m.type === type);

/** The queue moves to the next order, and the screen model reads it before the form opens. */
async function nextOrder(): Promise<Order> {
  const r = (await fx("form next")) as unknown as Order;
  const q = windowTitled(QUEUE);
  if (q === undefined) throw new Error("the order queue is not in the screen model");
  await walk(q.window.windowId);
  await until(`the queue to show ${r.order}`, () => [...(windowTitled(QUEUE)?.nodes.values() ?? [])].some((n) => (n.label ?? "").includes(r.order)), 5000);
  return { name: r.name, email: r.email, order: r.order };
}

/** Opens a fresh form and waits until the screen model holds it. */
async function openForm(form: "intake" | "reply"): Promise<string> {
  const r = await fx(`form open ${form}`);
  const title = String(r.title);
  const w = await until(`the ${title} window`, () => windowTitled(title));
  return w.window.windowId;
}
async function closeForm(form: "intake" | "reply", windowId: string, pressSend = false): Promise<void> {
  await fx(pressSend ? `form press ${form} Send` : `form close ${form}`);
  await until(`window ${windowId} to close`, () => !helper.model.windows.has(windowId));
}
async function dump(form: "intake" | "reply"): Promise<{ open: boolean; fields: Record<string, string>; sent: number }> {
  return (await fx(`form dump ${form}`)) as unknown as { open: boolean; fields: Record<string, string>; sent: number };
}

/** The user copies each value from the Reference window into a fresh form, then closes it (or presses Send). */
async function byHand(form: "intake" | "reply", values: Record<string, string>): Promise<void> {
  const id = await openForm(form);
  await walk(id);
  for (const [field, value] of Object.entries(values)) {
    await fx(`form set ${form} ${field} ${value}`);
    await walk(id);
    await sleep(300);
  }
  // Each edit settles before it is judged (transfers.ts SETTLE_MS).
  await sleep(2200);
  await closeForm(form, id, form === "reply");
}

interface Run {
  n: number;
  form: string;
  tab: boolean;
  outcome: string;
  step: number | null;
  stopReason: string | null;
  unprompted: boolean;
  verified: boolean;
  fixture: Record<string, string>;
  skillOffers: { kind: string; says: string; name: string }[];
  ms: number;
}
const runs: Run[] = [];

/** One occurrence for Caret: a routine offer taken with Tab, or a run that starts on its own. The form stays open. */
async function caretRun(form: "intake" | "reply", expect: Record<string, string>): Promise<{ run: Run; windowId: string; taskId: string; offers: SkillOffer[] }> {
  const at = sent.length;
  const t0 = Date.now();
  const id = await openForm(form);
  const own = (): TaskProgress | undefined => since("taskProgress", at).find((p) => p.unprompted === true);
  const offer = await until(`a routine offer or a run with no Tab in ${id}`, () => since("patternOffer", at).find((o: PatternOffer) => o.kind === "routine" && o.windowId === id) ?? own(), 8000);
  let result: { outcome: string; step: number | null } | null = null;
  let taskId: string;
  if ("kind" in offer) {
    taskId = offer.id;
    const r = (await helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: offer.id, action: "take" })) as TaskResult | null;
    result = r === null ? null : { outcome: r.outcome, step: r.step };
  } else {
    taskId = offer.taskId;
    await helper.patterns.unpromptedSettled();
  }
  const progress = since("taskProgress", at).filter((p) => p.taskId === taskId);
  const last = progress.at(-1);
  const d = await dump(form);
  const verified = Object.entries(expect).every(([k, v]) => d.fields[k] === v);
  const offers = since("skillOffer", at);
  const run: Run = {
    n: runs.length + 1,
    form,
    tab: "kind" in offer,
    outcome: result?.outcome ?? last?.phase ?? "none",
    step: result?.step ?? last?.step ?? null,
    stopReason: last?.phase === "stopped" ? last.stopReason : null,
    unprompted: progress.length > 0 && progress.every((p) => p.unprompted === true),
    verified,
    fixture: d.fields,
    skillOffers: offers.map((o) => ({ kind: o.kind, says: o.says, name: o.name })),
    ms: Date.now() - t0,
  };
  runs.push(run);
  process.stdout.write(`run ${run.n} ${form} ${run.tab ? "tab" : "no tab"} ${run.outcome}${run.stopReason === null ? "" : ` (${run.stopReason})`} ${verified ? "verified" : "NOT VERIFIED"} ${run.skillOffers.map((o) => o.kind).join(",")}\n`);
  return { run, windowId: id, taskId, offers };
}
const answer = (o: SkillOffer | undefined, ans: "accept" | "decline"): void => {
  if (o === undefined) throw new Error("expected a skill offer");
  helper.handleSkillAnswer({ type: "skillAnswer", v: PROTOCOL_VERSION, id: o.id, answer: ans, at: Date.now() });
};
/** Both forms are Caret Fixture windows, so a skill is told by the fields its trigger names. */
const SKILL_FIELDS = { Intake: "Customer, Email and Order number", Reply: "To and Order number" } as const;
const skill = (form: keyof typeof SKILL_FIELDS) => helper.memory.list("skill").find((e) => e.kind === "skill" && e.fields.trigger.includes(SKILL_FIELDS[form]));

// MARK: - the run

const checks: Record<string, boolean | string> = {};
const result: Record<string, unknown> = { frontBefore, checks, runs };
let ok = false;
try {
  await until("the fixture", () => fixturePid > 0);
  await sleep(800);
  reader = spawn(join(a.bin, "caret-screen"), ["--auth-fd", "0", "--socket", a.socket, "--only-pids", String(fixturePid), "--event-pids", String(fixturePid)]);
  let readerErr = "";
  reader.stderr.setEncoding("utf8");
  sendSecret(reader, launchSecret);
  reader.stderr.on("data", (d: string) => (readerErr += d));
  await until("the order queue", () => windowTitled(QUEUE));
  const rule = helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "rule", op: "edit", id: "permission-writeElsewhere", fields: { rule: "actIfApproved" } });
  if (rule.error !== null) throw new Error(rule.error);

  // Intake: learned by hand, then kept.
  for (let i = 0; i < 3; i++) await byHand("intake", intakeOf(await nextOrder()));
  await helper.patterns.skills.namesSettled();
  const intakeRoutine = helper.memory.list("routine").find((e) => e.kind === "routine" && e.fields.srcApps.length > 0 && e.fields.steps === 3);
  result.intakeRoutine = intakeRoutine;
  let r = await caretRun("intake", intakeOf(await nextOrder()));
  await closeForm("intake", r.windowId);
  checks.keepOfferAfterFirstRun = r.offers.some((o) => o.kind === "keep");
  answer(r.offers.find((o) => o.kind === "keep"), "accept");
  checks.keptLearning = skill("Intake")?.status === "learning";

  // Ten clean runs with Tab; the promote offer comes with the tenth and not before.
  let early = 0;
  for (let i = 1; i <= PROMOTE_AFTER; i++) {
    r = await caretRun("intake", intakeOf(await nextOrder()));
    await closeForm("intake", r.windowId);
    if (i < PROMOTE_AFTER && r.offers.length > 0) early++;
  }
  checks.noOfferBeforeTen = early === 0;
  checks.tenCleanTabRuns = runs.slice(-PROMOTE_AFTER).every((x) => x.tab && x.outcome === "done" && x.verified);
  const promote = r.offers.find((o) => o.kind === "promote");
  checks.promoteOfferAfterTen = promote !== undefined;
  answer(promote, "accept");
  checks.onItsOwnAfterAccept = skill("Intake")?.status === "active";

  // Run 11: no Tab; verified by the fixture; undo restores it.
  r = await caretRun("intake", intakeOf(await nextOrder()));
  checks.run11Unprompted = !r.run.tab && r.run.unprompted && r.run.outcome === "done" && r.run.verified;
  const undo = await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: r.taskId, action: "undo" });
  const afterUndo = await dump("intake");
  result.undo = { result: undo, fixture: afterUndo.fields };
  checks.undoRestored = Object.values(afterUndo.fields).every((v) => v === "");
  await closeForm("intake", r.windowId);
  checks.undoResetToTab = skill("Intake")?.status === "learning" && (skill("Intake") as { fields: { cleanRuns: number } } | undefined)?.fields.cleanRuns === 0;

  // Earned again: ten more clean runs with Tab bring the offer again.
  for (let i = 1; i <= PROMOTE_AFTER; i++) {
    r = await caretRun("intake", intakeOf(await nextOrder()));
    await closeForm("intake", r.windowId);
  }
  checks.reearned = r.offers.some((o) => o.kind === "promote");
  answer(r.offers.find((o) => o.kind === "promote"), "accept");

  // A forced mismatch on a run with no Tab: the fixture upper-cases what is written from the second step on.
  const before = sent.length;
  await nextOrder();
  mangleNext = true;
  const id = await openForm("intake");
  await until("the run with no Tab to start", () => since("taskProgress", before).find((p) => p.unprompted === true), 8000);
  await helper.patterns.unpromptedSettled();
  mangleNext = false;
  await fx("form mangle intake off");
  const bad = since("taskProgress", before).filter((p) => p.unprompted === true).at(-1);
  const badDump = await dump("intake");
  result.mismatchRun = { last: bad, fixture: badDump.fields };
  checks.mismatchStopped = bad?.phase === "stopped" && bad.stopReason === "mismatch";
  // Read before the clean-up undo below, which would reset the count on its own.
  const afterMismatch = skill("Intake") as { status: string; fields: { cleanRuns: number; onItsOwn: boolean } } | undefined;
  result.afterMismatch = afterMismatch;
  checks.mismatchResetToTab = afterMismatch?.status === "learning" && afterMismatch.fields.cleanRuns === 0 && !afterMismatch.fields.onItsOwn;
  await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: bad?.taskId ?? "", action: "undo" });
  await closeForm("intake", id);
  r = await caretRun("intake", intakeOf(await nextOrder()));
  await closeForm("intake", r.windowId);
  checks.nextRunNeedsTab = r.run.tab && r.run.outcome === "done" && r.run.verified;

  // Reply with Send: learned by hand, the user pressing Send each time; Caret never presses it.
  for (let i = 0; i < 3; i++) await byHand("reply", replyOf(await nextOrder()));
  await helper.patterns.skills.namesSettled();
  const pressesBefore = verbs.filter((v) => v === "press").length;
  const sentBefore = (await dump("reply")).sent;
  r = await caretRun("reply", replyOf(await nextOrder()));
  checks.replyHandoff = r.run.outcome === "handoff" && r.run.step === 2 && r.run.verified;
  answer(r.offers.find((o) => o.kind === "keep"), "accept");
  await closeForm("reply", r.windowId, true);
  const replySkill = skill("Reply");
  result.replySkill = replySkill;
  checks.replyHandsOffSend = (replySkill as { fields: { handsOff: { label: string } | null } } | undefined)?.fields.handsOff?.label === "Send";
  let promoted = 0;
  for (let i = 1; i <= PROMOTE_AFTER + 2; i++) {
    r = await caretRun("reply", replyOf(await nextOrder()));
    if (r.offers.some((o) => o.kind === "promote")) promoted++;
    // The user presses Send after each run, as they did when learning it.
    await closeForm("reply", r.windowId, true);
  }
  checks.replyNeverPromoted = promoted === 0 && skill("Reply")?.status === "learning";
  checks.replyEveryRunHandedSendOff = runs.filter((x) => x.form === "reply").every((x) => x.outcome === "handoff" && x.step === 2 && x.verified);
  checks.readerNeverAskedToPress = verbs.filter((v) => v === "press").length === pressesBefore;
  checks.sendPressesAreTheUsers = (await dump("reply")).sent - sentBefore === PROMOTE_AFTER + 3;
  result.skills = helper.memory.list("skill");
  result.readerLogTail = readerErr.split("\n").slice(-8);
  ok = Object.values(checks).every((v) => v === true);
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

const frontAfter = fronts[fronts.length - 1]!;
const foreign = fronts.filter((f) => ours(f.pid));
result.frontAfter = frontAfter;
result.frontSamples = fronts.length;
result.fixtureOrReaderWasFront = foreign.length > 0;
result.deferred = foreground === null ? null : `deferred: foreground (${JSON.stringify(foreground)})`;
result.verbs = Object.fromEntries([...new Set(verbs)].map((v) => [v, verbs.filter((x) => x === v).length]));
result.log = log.slice(-20);
result.fixtureStderr = fixtureErr.split("\n").filter((l) => l.length > 0).slice(-5);
result.ok = ok && foreign.length === 0;
writeStoreJson(join(OUT, "skills-fixture.json"), result, 2);
console.log(JSON.stringify({ ok: result.ok, error: result.error ?? null, checks, runs: runs.length, deferred: result.deferred }, null, 1));
process.exit(result.ok ? 0 : 1);
