// The loop recognizer end to end on caret-fixture, with the real reader. A scripted user fills seats
// 1 and 2 of 6 through the reader's AX write verb (pid-checked, fixture only); Caret predicts seat 3,
// the prediction is taken, "Finish the rest" runs through the executor, and the fixture's own report
// of its six fields is the check. No Jev call is needed: every target is an exact element key.
//
// The fixture opens windows, so this must run while holding the GUI lock, and it checks that the
// frontmost app is the same before and after and never the fixture or the reader in between:
//
//   /usr/bin/lockf -k ~/.long-run/locks/gui.lock env CARET_GUI_LOCK=held \
//     node scripts/patterns-fixture-eval.ts --bin ../apps/screen-reader/.build/debug --out DIR
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type HelperMessage, type PatternOffer, type TaskProgress } from "../src/protocol.ts";

const { values: a } = parseArgs({
  options: {
    bin: { type: "string" },
    out: { type: "string" },
    socket: { type: "string", default: join(homedir(), ".caret-run", "sockets", "patterns-fixture.sock") },
  },
});
if (a.bin === undefined || a.out === undefined) throw new Error("--bin and --out are required");
if (process.env.CARET_GUI_LOCK !== "held") throw new Error("run under /usr/bin/lockf -k ~/.long-run/locks/gui.lock env CARET_GUI_LOCK=held ...");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const NAMES = ["Dana Whitfield", "Priya Raman", "Marcus Lowe", "Ines Okafor", "Tomas Brandt", "Keiko Sato", "Rafael Duarte", "Amara Nwosu"];
const SEATING = "Caret Fixture — Seating";
const ROSTER = "Caret Fixture — Roster";

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

const sent: HelperMessage[] = [];
const log: string[] = [];
const dataDir = mkdtempSync(join(tmpdir(), "caret-patterns-fixture-"));
const store = new Store(dataDir);
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  askJev: null,
  shadow: false,
  allowBackgroundFocus: false,
  publish: (m) => {
    sent.push(m);
    server?.publish(m);
  },
  sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
  warn: (l) => log.push(l),
});
server = new HelperServer(a.socket, () => helper, (l) => log.push(l));
await server.listen();
const tick = setInterval(() => helper.tick(), 250);

// MARK: - fixture and reader, the only processes this script may signal

const fixture: ChildProcessWithoutNullStreams = spawn(join(a.bin, "caret-fixture"), ["--windows", "roster,seating", "--duration", "600", "--background-only"]);
let reader: ChildProcessWithoutNullStreams | null = null;
process.on("exit", () => {
  reader?.kill("SIGTERM");
  fixture.kill("SIGTERM");
});
let fixturePid = 0;
let fixtureErr = "";
/** Set when the fixture or the reader was seen frontmost; both are stopped at once and the run is deferred. */
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
const fx = (cmd: string): Promise<Record<string, unknown>> =>
  new Promise((res) => {
    replies.push(res);
    fixture.stdin.write(cmd + "\n");
  });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => T | null | undefined | false, ms = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const result: Record<string, unknown> = { frontBefore };
let ok = false;
try {
  await until("the fixture", () => fixturePid > 0);
  await sleep(800);
  reader = spawn(join(a.bin, "caret-screen"), [
    "--socket", a.socket, "--only-pids", String(fixturePid), "--event-pids", String(fixturePid), "--act-pids", String(fixturePid),
  ]);
  let readerErr = "";
  reader.stderr.setEncoding("utf8");
  reader.stderr.on("data", (d: string) => (readerErr += d));
  const win = (title: string) => [...helper.model.windows.values()].find((w) => w.window.title === title);
  const seating = await until("the seating window", () => win(SEATING));
  await until("the roster window", () => win(ROSTER));
  const seats = [...seating.nodes.values()].filter((n) => n.role === "AXTextField" && n.label === "Guest").map((n) => n.key);
  if (seats.length !== 6) throw new Error(`expected 6 Guest fields, found ${seats.length}`);
  result.fixturePid = fixturePid;
  result.readerPid = reader.pid;
  result.seatKeys = seats;

  // The scripted user: seats 1 and 2, each an AX write into the fixture, then a pause while the edit settles.
  const userWrites: { seat: number; at: number; outcome: string }[] = [];
  for (const r of [0, 1]) {
    const w = win(SEATING)!;
    // The reader writes only elements it has walked for this link, as it does for the executor.
    const walk = await helper.readerVerb({ kind: "walk", pid: fixturePid, windowId: w.window.windowId });
    if (walk.outcome !== "ok") throw new Error(`walk before seat ${r + 1}: ${walk.outcome} ${walk.detail ?? ""}`);
    const res = await helper.readerVerb({ kind: "write", pid: fixturePid, windowId: w.window.windowId, key: seats[r]!, role: "AXTextField", attribute: "value", expect: "", value: NAMES[r]! });
    userWrites.push({ seat: r + 1, at: res.at, outcome: res.outcome });
    if (res.outcome !== "ok") throw new Error(`user write to seat ${r + 1}: ${res.outcome} ${res.detail ?? ""}`);
    await until(`the transfer into seat ${r + 1}`, () => helper.recentTransfers.find((t) => t.dst.key === seats[r]), 10_000);
  }
  result.userWrites = userWrites;
  const offers = (kind: PatternOffer["kind"]) => sent.filter((m): m is PatternOffer => m.type === "patternOffer" && m.kind === kind);

  const next = await until("the seat 3 prediction", () => offers("loopNext")[0], 10_000);
  const row2Write = userWrites[1]!.at;
  result.prediction = { cells: next.cells.map((c) => ({ key: c.key, value: c.value, source: c.source.windowTitle })), says: next.says, showProbability: next.showProbability, msAfterSeat2Write: next.at - row2Write };
  if (next.cells.length !== 1 || next.cells[0]!.key !== seats[2] || next.cells[0]!.value !== NAMES[2]) throw new Error(`wrong seat 3 prediction: ${JSON.stringify(next.cells)}`);

  const t1 = Date.now();
  const took = await helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: next.id, action: "take" });
  result.takeNext = { outcome: took?.outcome ?? null, detail: took?.detail ?? null, ms: Date.now() - t1 };
  if (took?.outcome !== "done") throw new Error(`taking the prediction: ${JSON.stringify(took)}`);

  const finish = await until("Finish the rest", () => offers("loopFinish")[0], 5000);
  result.finishOffer = { says: finish.says, cells: finish.cells.map((c) => ({ key: c.key, value: c.value })), showProbability: finish.showProbability };
  const t2 = Date.now();
  const ran = await helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: finish.id, action: "take" });
  result.takeFinish = { outcome: ran?.outcome ?? null, detail: ran?.detail ?? null, acted: ran?.acted ?? null, ms: Date.now() - t2 };
  if (ran?.outcome !== "done") throw new Error(`Finish the rest: ${JSON.stringify(ran)}`);

  // The fixture's own report, not the helper's reading, is the check.
  await sleep(500);
  const dump = await fx("dump");
  result.fixtureDump = dump;
  const guests = dump.guests as string[];
  const verified = guests.map((g, i) => g === NAMES[i]);
  result.verifiedCells = verified.filter(Boolean).length;
  result.progress = sent.filter((m): m is TaskProgress => m.type === "taskProgress").map((p) => `${p.taskId} ${p.phase} ${p.step ?? "-"} ${p.says ?? ""}`);
  result.decisions = helper.memory.decisions();
  result.readerLogTail = readerErr.split("\n").slice(-5);
  ok = verified.every(Boolean);
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
const foreign = fronts.filter((f) => ours(f.pid) || f.pid === result.readerPid);
result.frontAfter = frontAfter;
result.frontSamples = fronts.length;
result.frontChanged = fronts.filter((f) => f.pid !== frontBefore.pid).map((f) => ({ at: f.at, pid: f.pid, name: f.name }));
result.fixtureOrReaderWasFront = foreign.length > 0;
result.deferred = foreground === null ? null : `deferred: foreground (${JSON.stringify(foreground)})`;
result.fixtureStderr = fixtureErr.split("\n").filter((l) => l.length > 0).slice(-5);
result.ok = ok && frontAfter.pid === frontBefore.pid && foreign.length === 0;
writeFileSync(join(OUT, "fixture-loop.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, error: result.error ?? null, verifiedCells: result.verifiedCells, prediction: result.prediction, frontBefore, frontAfter, frontChanged: result.frontChanged }, null, 1));
process.exit(result.ok ? 0 : 1);
