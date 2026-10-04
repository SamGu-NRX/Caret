// B23 acceptance 3 (S1 audit #11): SIGKILL the helper between two writes of a three-field skill run, then check what
// a restart recovers. Synthetic windows only; no app, no GUI, no model.
//   node scripts/crash-recovery-eval.ts --out DIR
//
// Phase 1, in process: a routine is learned and kept as a skill, earns ten clean runs and is promoted to run on its
// own, on a temporary data directory (the same scene as test/skills.test.ts).
// Phase 2, across processes: the real helper (src/main.ts) runs as a child on that data directory. This script plays
// the reader over the socket (it checks the helper's proof, answers its commands as caret-screen would, and keeps the
// elements its writes recorded) and the host (hello with host: true). The calendar window shows, a compose window
// opens, and the skill runs with no Tab. When the command for its second write arrives, the child is killed with
// SIGKILL and the write is never applied. The child is started again with the same secret, as src/launch.ts does;
// the reader reconnects under the same launch id and sends the screen again. Then:
//   1. the skill is back on Tab;
//   2. the activity list shows the run as "Stopped when Caret restarted, at step 2 of 3", with undo;
//   3. undo restores the first field (the verified prefix) through the element its write recorded, and the journal
//      row is gone;
//   4. the next trigger is offered with Tab, not run on its own.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { RecoveryJournal } from "../src/executor/journal.ts";
import { helperProof } from "../src/server.ts";
import { newLaunchSecret, sendSecret } from "../src/launch.ts";
import { HelperToReader, PROTOCOL_VERSION, type ActivityReply, type HelperMessage, type MemoryReply, type ReaderMessage, type TaskProgress } from "../src/protocol.ts";
import { Desk, cellKey, type DeskSink, type GridWindow, type ListWindow } from "../test/scene.ts";
import { FIXTURE_APP, MAIL_APP } from "../test/builders.ts";
import { LineClient, until } from "../test/socket-reader.ts";

const { values: a } = parseArgs({ options: { out: { type: "string" } } });
if (a.out === undefined) throw new Error("usage: node scripts/crash-recovery-eval.ts --out DIR");
const OUT = a.out;
mkdirSync(OUT, { recursive: true });

const DAY = 24 * 60 * 60 * 1000;
const SETTINGS = { roles: ["fill", "repeat", "watch", "calendar", "words"] as ("fill" | "repeat" | "watch" | "calendar" | "words")[], level: "eager" as const, paused: false };
const READER_SESSION = "reader-crash-eval-0001";
const work = mkdtempSync(join(tmpdir(), "caret-crash-"));
const dataDir = join(work, "data");
const sockDir = join(work, "sock");
mkdirSync(sockDir, { mode: 0o700 });
const SOCK = join(sockDir, "s.sock");
const log: string[] = [];
const say = (line: string): void => {
  log.push(`${new Date().toISOString()} ${line}`);
  process.stdout.write(`${line}\n`);
};
const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: unknown): void => {
  checks.push({ name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  say(`${pass ? "PASS" : "FAIL"} ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};

const calendar = (day: number): ListWindow => ({
  windowId: "5150-20",
  app: FIXTURE_APP,
  title: "Calendar",
  group: "Event",
  lines: [`Design review ${day}`, `priya.raman+${day}@northwind.example`, `https://meet.example.com/day-${day}`],
});
const compose = (day: number): GridWindow => ({ windowId: `6160-${100 + day}`, app: MAIL_APP, title: `New message ${day}`, columns: ["Subject", "To", "Link"], rows: 1, values: new Map() });
const values = (g: GridWindow): string[] => g.columns.map((_, i) => g.values.get(cellKey(g, 0, i)) ?? "");

// MARK: - phase 1: earn the skill in process

const desk = new Desk();
desk.enforceGrants = true;
desk.grants.now = () => Date.now();
let day = 0;
let skillId = "";
{
  const store = new Store(dataDir);
  const sent: HelperMessage[] = [];
  const helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), readerLink: desk, settings: SETTINGS });
  desk.attach(helper);
  helper.hostConnected("phase-1-host");
  const rule = helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "r", op: "edit", id: "permission-writeElsewhere", fields: { rule: "actIfApproved" } });
  if (rule.error !== null) throw new Error(rule.error);
  const open = (): GridWindow => {
    day++;
    desk.at += DAY;
    desk.showList(calendar(day));
    desk.advance(1000);
    const c = compose(day);
    desk.showGrid(c);
    return c;
  };
  const finish = (c: GridWindow): void => {
    desk.advance(2000);
    desk.close(c.windowId);
  };
  for (let i = 0; i < 3; i++) {
    const c = open();
    for (let k = 0; k < 3; k++) desk.fill(c, 0, k, calendar(day).lines[k] as string);
    desk.close(c.windowId);
  }
  await helper.patterns.skills.namesSettled();
  const run = async (): Promise<{ took: boolean; skillOffers: Extract<HelperMessage, { type: "skillOffer" }>[] }> => {
    const at = sent.length;
    const c = open();
    await helper.patterns.unpromptedSettled();
    const offer = sent.slice(at).find((m): m is Extract<HelperMessage, { type: "patternOffer" }> => m.type === "patternOffer" && m.kind === "routine");
    if (offer !== undefined) await helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: offer.id, action: "take" });
    finish(c);
    return { took: offer !== undefined, skillOffers: sent.slice(at).flatMap((m) => (m.type === "skillOffer" ? [m] : [])) };
  };
  const first = await run();
  const keep = first.skillOffers.find((o) => o.kind === "keep");
  if (keep === undefined) throw new Error("phase 1: no keep offer after the first Caret run");
  helper.handleSkillAnswer({ type: "skillAnswer", v: PROTOCOL_VERSION, id: keep.id, answer: "accept", at: desk.at });
  for (let i = 1; i <= 10; i++) {
    const r = await run();
    if (!r.took) throw new Error(`phase 1: run ${i} was not offered`);
    const promote = r.skillOffers.find((o) => o.kind === "promote");
    if (promote !== undefined) helper.handleSkillAnswer({ type: "skillAnswer", v: PROTOCOL_VERSION, id: promote.id, answer: "accept", at: desk.at });
  }
  const skill = helper.memory.list("skill")[0];
  if (skill?.kind !== "skill" || !skill.fields.onItsOwn) throw new Error(`phase 1: the skill was not promoted: ${JSON.stringify(skill?.fields)}`);
  skillId = skill.id;
  say(`phase 1: skill ${skillId} runs on its own after ${day} occurrences`);
  helper.shutdown();
  helper.memory.close();
  helper.journal.close();
  store.close();
}

// MARK: - phase 2: the real helper as a child, killed mid-run

const secret = newLaunchSecret();
const helperMain = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const childLog: string[] = [];
let child: ChildProcessWithoutNullStreams | null = null;
const startChild = async (name: string): Promise<ChildProcessWithoutNullStreams> => {
  const c = spawn(process.execPath, [helperMain, "--auth-fd", "0", "--socket", SOCK, "--data-dir", dataDir, "--no-jev", "--status-every", "600"]);
  sendSecret(c, secret);
  c.stderr.setEncoding("utf8");
  c.stderr.on("data", (d: string) => {
    for (const line of d.split("\n")) if (line.trim() !== "") childLog.push(`${name}: ${line.trim()}`);
  });
  // A killed helper leaves its socket file behind, so the new one is ready only once it says it is listening.
  await until(() => childLog.some((l) => l.startsWith(`${name}: `) && l.includes("listening on")), 10_000);
  say(`${name}: pid ${c.pid}`);
  return c;
};

/** Resolves once the process has exited, at once if it already has. */
const exited = (c: ChildProcessWithoutNullStreams): Promise<void> =>
  new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once("exit", () => r())));

/** Forwards the desk's snapshots to the child over the reader's connection, and knows which windows it sent. */
class SocketSink implements DeskSink {
  client: LineClient | null = null;
  private readonly shown = new Set<string>();
  readonly model = { windows: { has: (id: string): boolean => this.shown.has(id) } };
  handleReader(m: ReaderMessage): null {
    if (m.type === "snapshot") this.shown.add(m.window.windowId);
    if (m.type === "windowClosed") this.shown.delete(m.windowId);
    this.client?.send(m);
    return null;
  }
  tick(): void {}
}
const sink = new SocketSink();
desk.attach(sink);
desk.at = Date.now();

/** Called with each command before it is answered; returning true leaves it unanswered. */
let intercept: ((verb: Extract<HelperToReader, { type: "readerCommand" }>["verb"]) => boolean) | null = null;
const connectReader = async (): Promise<LineClient> => {
  const r = await LineClient.connect(SOCK);
  const challenge = randomBytes(32).toString("base64");
  r.send({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: process.pid, version: "crash-eval", session: READER_SESSION, challenge });
  const auth = await r.waitFor((m) => m.type === "helperAuth" || m.type === "error", 5000);
  if (auth.type !== "helperAuth" || auth.proof !== helperProof(secret, challenge)) throw new Error(`the helper did not prove itself: ${JSON.stringify(auth)}`);
  r.onMessage = (raw) => {
    const m = HelperToReader.safeParse(raw);
    if (!m.success || m.data.type === "helperAuth") return;
    if (m.data.type !== "readerCommand") return desk.grant(m.data);
    const cmd = m.data;
    if (intercept?.(cmd.verb) === true) return;
    void desk.run(cmd.verb).then((res) => r.send({ ...res, id: cmd.id }));
  };
  sink.client = r;
  return r;
};
const connectHost = async (): Promise<LineClient> => {
  const h = await LineClient.connect(SOCK);
  h.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: process.pid, version: "crash-eval-host", host: true });
  h.send({ type: "settings", v: PROTOCOL_VERSION, at: Date.now(), ...SETTINGS });
  return h;
};

let failure: unknown = null;
try {
  child = await startChild("helper-1");
  await connectReader();
  const host1 = await connectHost();
  await new Promise((r) => setTimeout(r, 300));

  // The trigger: the day's calendar entry, then an empty compose window. The run starts with no Tab.
  day++;
  desk.at = Date.now();
  desk.showList(calendar(day));
  await new Promise((r) => setTimeout(r, 300));
  const c = compose(day);
  const second = cellKey(c, 0, 1);
  let killedAt: string[] | null = null;
  let killedMark: string | undefined;
  const victim = child;
  intercept = (verb) => {
    if (killedAt !== null) return true;
    if (verb.kind === "write" && verb.attribute === "value" && verb.key === second && verb.mark !== undefined) {
      killedAt = values(c);
      killedMark = verb.mark;
      victim.kill("SIGKILL");
      say(`SIGKILL helper-1 as the command for write 2 arrived; fields then ${JSON.stringify(killedAt)}`);
      return true;
    }
    return false;
  };
  desk.at = Date.now();
  desk.showGrid(c);
  await until(() => killedAt !== null, 15_000);
  await exited(victim);
  const unprompted = host1.received.filter((m): m is TaskProgress => (m as { type?: string }).type === "taskProgress" && (m as TaskProgress).unprompted === true);
  check("the run started with no Tab and verified its first write before the kill", unprompted.some((p) => p.phase === "verified" && p.step === 0), unprompted.map((p) => `${p.phase}:${p.step}`).join(","));
  check("the kill came between write 1 and write 2", JSON.stringify(killedAt) === JSON.stringify([calendar(day).lines[0], "", ""]), killedAt ?? []);
  intercept = null;
  host1.close();

  // The helper comes back with the same secret; the reader, still running, reconnects under its launch id.
  child = await startChild("helper-2");
  await connectReader();
  desk.at = Date.now();
  desk.showList(calendar(day));
  desk.showGrid(c);
  const host = await connectHost();
  await new Promise((r) => setTimeout(r, 300));

  host.send({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "m1", op: "list", kind: "skill" });
  const mem = await host.waitFor<MemoryReply>((m) => m.type === "memoryReply" && m.requestId === "m1");
  const skill = mem.entries.find((e) => e.id === skillId);
  check("1. the skill is back on Tab", skill?.kind === "skill" && !skill.fields.onItsOwn && skill.fields.cleanRuns === 0, skill?.says ?? "no skill");

  host.send({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "a1", op: "list" });
  const act = await host.waitFor<ActivityReply>((m) => m.type === "activityReply" && m.requestId === "a1");
  const row = act.tasks.find((t) => t.detail?.startsWith("Stopped when Caret restarted") === true);
  check("2. the activity list shows the interrupted run, with undo", row !== undefined && row.detail === "Stopped when Caret restarted, at step 2 of 3" && row.state === "failed" && row.undoable, row ?? "no row");

  if (row !== undefined) {
    host.send({ type: "taskControl", v: PROTOCOL_VERSION, taskId: row.id, action: "undo" });
    const undone = await host.waitFor<TaskProgress>((m) => m.type === "taskProgress" && m.taskId === row.id && m.phase === "undone", 10_000);
    const restores = desk.verbs.filter((v) => v.kind === "write" && v.sameAs !== undefined);
    check(
      "3. undo restores the verified prefix, into the element its write recorded",
      undone.restored === 1 && undone.notRestored === 0 && JSON.stringify(values(c)) === JSON.stringify(["", "", ""]) && restores.some((v) => v.kind === "write" && v.key === cellKey(c, 0, 0)),
      { restored: undone.restored, notRestored: undone.notRestored, detail: undone.detail, fields: values(c), killedMark: killedMark !== undefined },
    );
  }

  // The next trigger needs Tab.
  desk.close(c.windowId);
  await new Promise((r) => setTimeout(r, 300));
  const from = host.received.length;
  day++;
  desk.at = Date.now();
  desk.showList(calendar(day));
  await new Promise((r) => setTimeout(r, 300));
  desk.at = Date.now();
  const next = compose(day);
  desk.showGrid(next);
  await new Promise((r) => setTimeout(r, 1500));
  const after = host.received.slice(from) as { type?: string; kind?: string; unprompted?: boolean }[];
  check("4. the next trigger is offered with Tab, not run on its own", after.some((m) => m.type === "patternOffer" && m.kind === "routine") && !after.some((m) => m.type === "taskProgress" && m.unprompted === true), after.map((m) => m.type).join(","));

  const last = child;
  say(`helper-2 before the stop: exit ${last.exitCode ?? "none"}, signal ${last.signalCode ?? "none"}`);
  last.kill("SIGTERM");
  await exited(last);
  const journal = new RecoveryJournal(dataDir);
  const left = journal.load(Date.now());
  journal.close();
  check("the journal holds no row once the undo is done", left.records.length === 0 && left.unreadable.length === 0, left.records.map((r) => r.taskId));
} catch (e) {
  failure = e;
  say(`ERROR ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
} finally {
  if (child !== null && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  writeFileSync(join(OUT, "crash-summary.json"), `${JSON.stringify({ checks, failure: failure === null ? null : String(failure), at: new Date().toISOString() }, null, 2)}\n`);
  writeFileSync(join(OUT, "crash-log.txt"), `${[...log, "--- child stderr ---", ...childLog].join("\n")}\n`);
  rmSync(work, { recursive: true, force: true });
}
const ok = failure === null && checks.length === 7 && checks.every((c) => c.pass);
say(ok ? "crash test passed" : "crash test FAILED");
process.exit(ok ? 0 : 1);
