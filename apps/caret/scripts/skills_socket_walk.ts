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
import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const { values: a } = parseArgs({ options: { bin: { type: "string" }, caret: { type: "string" }, out: { type: "string" } } });
if (a.bin === undefined || a.out === undefined || a.caret === undefined) throw new Error("--bin, --caret and --out are required");
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
      if (step === 0 && holdFirstStep > 0) await sleep(holdFirstStep);
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

const fixture: ChildProcessWithoutNullStreams = spawn(fixtureExecutable(a.bin), ["--windows", "forms", "--duration", "1800"]);
let reader: ChildProcessWithoutNullStreams | null = null;
let host: ChildProcess | null = null;
let hostLog = "";
const stopAll = (): void => {
  host?.kill("SIGTERM");
  reader?.kill("SIGTERM");
  fixture.kill("SIGTERM");
};
process.on("exit", stopAll);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(143));
let fixturePid = 0;
let foreground: Front | null = null;
const ours = (pid: number): boolean => pid > 0 && (pid === fixture.pid || pid === fixturePid || pid === (reader?.pid ?? -1) || pid === (host?.pid ?? -1));
const frontPoll = setInterval(() => {
  const f = front();
  fronts.push(f);
  if (foreground === null && ours(f.pid)) {
    foreground = f;
    stopAll();
  }
}, 100);
/** Each fixture command waits for its reply line; all of them fail at once if the fixture goes. */
const replies: { ok: (o: Record<string, unknown>) => void; fail: (e: Error) => void }[] = [];
const failReplies = (why: string): void => {
  for (const r of replies.splice(0)) r.fail(new Error(`fixture: ${why}`));
};
fixture.on("exit", (code, sig) => failReplies(`exited (${code ?? sig})`));
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
    if (foreground !== null) throw new Error(`deferred: foreground (${JSON.stringify(foreground)})`);
    const v = await f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

function hostCommand(command: string): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
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
  book: { loaded: boolean; entries: { id: string; kind: string; status: string; says: string }[]; onTheirOwn: string[]; problems: Record<string, string>; busy: Record<string, string> };
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
async function caretRun(expect: Record<string, string>, opts: { answer?: "tab" | "esc" } = {}): Promise<{ run: Run; windowId: string; taskId: string; offers: SkillOffer[] }> {
  const at = sent.length;
  const t0 = Date.now();
  const id = await openForm();
  const own = (): TaskProgress | undefined => since("taskProgress", at).find((p) => p.unprompted === true);
  const first = await until(`a routine offer or a run with no Tab in ${id}`, () => since("patternOffer", at).find((o: PatternOffer) => o.kind === "routine" && o.windowId === id) ?? own(), 8000);
  let taskId: string;
  let hostShown = false;
  if ("kind" in first) {
    taskId = first.id;
    hostShown = (await until("the host to show the routine offer", async () => ((await surface()).offerKey === taskId ? true : null), 5000).catch(() => false)) === true;
    if (!(await key("tab"))) throw new Error("the host did not take Tab on the routine offer");
  } else {
    taskId = first.taskId;
  }
  const end = await until("the run to end", () => since("taskProgress", at).find((p) => p.taskId === taskId && ["done", "stopped", "handoff", "paused"].includes(p.phase)), 15_000);
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
  process.stdout.write(`run ${run.n} ${run.tab ? "tab" : "no tab"} ${run.outcome} ${verified ? "verified" : "NOT VERIFIED"} toast '${run.toast}' question '${run.question}' ${run.skillOffers.join(",")}\n`);
  if (opts.answer !== undefined && offers.length > 0) {
    if (!(await key(opts.answer))) throw new Error(`the host did not take ${opts.answer} on the question`);
  }
  return { run, windowId: id, taskId, offers };
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
    "--helper-socket", HELPER_SOCK, "--socket", HOST_SOCK, "--no-ghost", "--perch", "hidden", "--surfaces", "headless",
    "--allow-pids", String(fixturePid), "--test-hooks", "--status-item", "off", "--onboarding", "off", "--settings", join(sockDir, "settings.json"),
  ]);
  host.stderr?.setEncoding("utf8");
  host.stderr?.on("data", (d: string) => (hostLog += d));
  await until("the host's socket", () => existsSync(HOST_SOCK), 15_000);
  await until("the host on the helper", async () => (((await hostCommand("state")).helper as { connected?: boolean } | undefined)?.connected === true ? true : null), 15_000, 200);
  // The host sends its own gate settings on connect (B10) and a fresh settings file says Balanced,
  // which overrides the helper's Eager: the level is set at the host, as the user would.
  const level = await hostCommand("settings set level eager");
  if (level.error !== undefined) throw new Error(`settings: ${String(level.error)}`);
  await sleep(500);
  await until("the order queue", () => windowTitled(QUEUE));
  await until("the host's memory list", async () => ((await memory()).book.loaded ? true : null), 5000);
  await hostCommand("memory rule writeElsewhere actIfApproved");
  await until("the rule from the host", () => memoryReplies.find((r) => r.op.startsWith("edit permission-writeElsewhere") && r.error === null), 5000);

  // 1. Learned by hand, then Caret's first run taken with Tab; the keep question accepted with Tab.
  for (let i = 0; i < 3; i++) await byHand(intakeOf(await nextOrder()));
  await helper.patterns.skills.namesSettled();
  let r = await caretRun(intakeOf(await nextOrder()), { answer: "tab" });
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
    r = await caretRun(intakeOf(await nextOrder()), { answer: i === PROMOTE_AFTER ? "tab" : undefined });
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
  holdFirstStep = 1500;
  const order11 = await nextOrder();
  const at11 = sent.length;
  const id11 = await openForm();
  const started = await until("run 11 to start with no Tab", () => since("taskProgress", at11).find((p) => p.unprompted === true), 8000);
  const working = await until("the host's line for it", async () => {
    const s = await surface();
    return s.workingOn === started.taskId && s.unprompted === true ? s : null;
  }, 3000);
  const perchWorking = await until("the perch working on it", async () => {
    const p = await perch();
    return p.subject?.taskId === started.taskId && p.subject.mood === "working" ? p.subject : null;
  }, 3000).catch(() => null);
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
  await hostCommand("memory list");
  await until("the host's list to show it on its own", async () => ((await memory()).book.onTheirOwn.length > 0 ? true : null), 3000);
  const skillId = skill()?.id ?? "";
  const backOnTab = await hostCommand(`memory backontab ${skillId}`);
  await until("the helper's answer", () => memoryReplies.find((x) => x.op.includes("onItsOwn")), 3000);
  await sleep(300);
  const afterBack = await memory();
  result.putBackOnTab = { sent: backOnTab.sent, helper: memoryReplies.find((x) => x.op.includes("onItsOwn")), hostProblem: afterBack.book.problems[skillId] ?? null };
  checks.putBackOnTabSentFromTheHost = backOnTab.sent === true;
  r = await caretRun(intakeOf(await nextOrder()));
  checks.nextRunNeedsTabAfterPutBackOnTab = r.run.tab;
  await closeForm(r.windowId);

  result.skills = helper.memory.list("skill");
  ok = Object.values(checks).every((v) => v);
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e);
} finally {
  clearInterval(tick);
  clearInterval(frontPoll);
  fronts.push(front());
  stopAll();
  await server.close();
  helper.memory.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sockDir, { recursive: true, force: true });
}

const foreign = fronts.filter((f) => ours(f.pid));
result.frontSamples = fronts.length;
result.fixtureOrHostWasFront = foreign.length > 0;
result.fromHost = fromHost.map((x) => `${x.type} ${x.detail}`);
result.memoryReplies = memoryReplies;
result.log = log.slice(-20);
result.hostLog = hostLog.split("\n").slice(-10);
result.ok = ok && foreign.length === 0;
writeFileSync(join(OUT, "skills-walk.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ok: result.ok, error: result.error ?? null, checks, runs: runs.length }, null, 1));
process.exit(result.ok ? 0 : 1);
