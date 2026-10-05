// Memory and permissions edited from the host change what the helper does (brief A11, acceptance 2).
//
// The helper runs in this process on a temporary data directory, with its real pattern engine,
// memory store and socket server. Its reader is the pattern tests' desk (helper/test/scene.ts): a
// roster window and seating grids in "Caret Fixture" (pid 5150) and "Mail Fixture" (pid 6160), sent
// as reader snapshots. Taking a prediction (the user's Tab) and the user's own typing happen on the
// desk; every memory read and write goes through the host. The host is the built Caret binary,
// started with nothing on screen (`--surfaces headless --perch hidden --status-item off`) and
// driven only through its debug socket's `memory` commands, which make the same MemoryBook calls as
// the memory window's controls. The recordings' pids must not be live processes; the script checks.
//
//   1. About: a corrected value becomes an About entry; the host edits it (Edit, type, Save); the
//      next row offered in a new seating chart carries the edited value. Pause and resume through
//      the host take it out and put it back.
//   2. Routine: three proven days make a routine the helper offers; the host forgets it (Forget,
//      then the confirmation); the next two days offer nothing.
//   3. Permissions: a change reads back on the host and in the helper's store; outbound to Act is
//      refused by the host and never reaches the helper.
//   4. A typed value (onboarding's) is sent as the host's `add` contract and kept by the helper
//      (B17); Forget on the host removes it from the helper.
//
//   node apps/caret/scripts/memory_socket_acceptance.ts --out DIR [--runs 3]
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Helper } from "../../../helper/src/helper.ts";
import { HelperServer } from "../../../helper/src/server.ts";
import { Store } from "../../../helper/src/store.ts";
import { PROTOCOL_VERSION, type HelperMessage, type MemoryRequest, type PatternOffer } from "../../../helper/src/protocol.ts";
import { Desk, grid, roster, type GridWindow, type ListWindow } from "../../../helper/test/scene.ts";
import { FIXTURE_APP, MAIL_APP } from "../../../helper/test/builders.ts";
import { routedJev, routingHarness, routingOptions, type RoutingHarness } from "./routing_option.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const CARET = resolve(ROOT, "apps", "caret", ".build", "Caret.app", "Contents", "MacOS", "Caret");
const { values: a } = parseArgs({ options: { out: { type: "string" }, runs: { type: "string", default: "3" }, ...routingOptions } });
// H6: --routing live runs D2-02's router with live Jev; this desk asks Jev nothing else (routing_option.ts).
const routed = routedJev(a.routing, null);
if (a.out === undefined) throw new Error("--out is required");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const RUNS = Number(a.runs);
const SOCKETS = join(homedir(), ".caret-run", "sockets");
const HELPER_SOCK = join(SOCKETS, "a11-memory-helper.sock");
const HOST_SOCK = join(SOCKETS, "a11-memory-host.sock");
const PIDS = [FIXTURE_APP.pid, MAIL_APP.pid];
const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];

for (const pid of PIDS) {
  let live = true;
  try {
    process.kill(pid, 0);
  } catch (e) {
    live = (e as NodeJS.ErrnoException).code === "EPERM";
  }
  if (live) throw new Error(`pid ${pid} is a live process; the desk's pids must not exist. Nothing was started.`);
}

// MARK: - the helper, fresh for each run

interface Session {
  helper: Helper;
  server: HelperServer;
  desk: Desk;
  store: Store;
  dir: string;
  sent: HelperMessage[];
  /** memoryRequests as the helper received them. */
  asked: MemoryRequest[];
  /** The router's timers (H6, --routing live): offers wait for its decision. */
  routing: RoutingHarness;
}

async function openSession(): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "caret-a11-memory-"));
  const store = new Store(join(dir, "data"));
  const sent: HelperMessage[] = [];
  const asked: MemoryRequest[] = [];
  const desk = new Desk();
  let server: HelperServer | null = null;
  const routing = routingHarness(a.routing);
  const helper = new Helper({
    store,
    askJev: routed.askJev,
    ...routing.options,
    shadow: false,
    allowBackgroundFocus: false,
    publish: (m) => {
      sent.push(m);
      server?.publish(m);
    },
    readerLink: desk,
    warn: (l) => log.push(`helper: ${l}`),
  });
  desk.attach(helper);
  const handle = helper.handleMemory.bind(helper);
  helper.handleMemory = (m) => (asked.push(m), handle(m));
  server = new HelperServer(HELPER_SOCK, () => helper, (l) => log.push(`server: ${l}`));
  await server.listen();
  return { helper, server, desk, store, dir, sent, asked, routing };
}

async function closeSession(s: Session): Promise<void> {
  await s.routing.stop(s.helper);
  s.helper.shutdown();
  await s.server.close();
  s.helper.memory.close();
  s.store.close();
  rmSync(s.dir, { recursive: true, force: true });
  await until("the host to notice the helper left", async () => ((await state()).helper?.connected === false ? true : null), 5000);
}

// MARK: - the host, headless

const host: ChildProcess = spawn(CARET, [
  "--helper-socket", HELPER_SOCK, "--socket", HOST_SOCK, "--no-ghost", "--perch", "hidden", "--surfaces", "headless",
  "--allow-pids", PIDS.join(","), "--test-hooks",
  "--status-item", "off", "--settings", join(SOCKETS, "a11-memory-settings.json"),
]);
host.stderr?.setEncoding("utf8");
host.stderr?.on("data", (d: string) => log.push(`host: ${d.trim().slice(0, 300)}`));
process.on("exit", () => host.kill("SIGTERM"));

function hostCommand(command: string): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const s: Socket = createConnection(HOST_SOCK);
    let buf = "";
    s.setEncoding("utf8");
    s.on("connect", () => s.write(command + "\n"));
    s.on("data", (d: string) => (buf += d));
    s.on("end", () => {
      try {
        res(JSON.parse(buf) as Record<string, unknown>);
      } catch {
        rej(new Error(`host ${command}: ${buf.slice(0, 200)}`));
      }
    });
    s.on("error", rej);
  });
}

interface BookEntry {
  id: string;
  kind: string;
  status: string;
  says: string;
  rule?: string;
}
interface Book {
  connected: boolean;
  loaded: boolean;
  entries: BookEntry[];
  busy: Record<string, string>;
  problems: Record<string, string>;
  typed: { id: string; label: string; valueLength: number; phase: string }[];
  sent: string[];
}
interface HostState {
  helper?: { connected: boolean; offers: number; memoryReplies: number; errors: number; lastError?: string };
}
const state = async (): Promise<HostState> => (await hostCommand("state")) as HostState;
const memory = async (command = ""): Promise<{ book: Book; sent?: boolean; windowShown: boolean }> =>
  (await hostCommand(`memory${command === "" ? "" : ` ${command}`}`)) as unknown as { book: Book; sent?: boolean; windowShown: boolean };

async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 10_000, every = 20): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

/** Lists again through the host and waits for an entry the predicate picks. */
async function hostEntry(what: string, pick: (e: BookEntry) => boolean, ms = 5000): Promise<BookEntry> {
  await memory("list");
  return until(what, async () => (await memory()).book.entries.find(pick) ?? null, ms);
}

const checks: Record<string, unknown>[] = [];
const check = (name: string, ok: boolean, detail: Record<string, unknown> = {}): void => {
  checks.push({ check: name, ...detail, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail).slice(0, 300)}`);
};

// MARK: - desk scenes (helper/test/patterns.test.ts)

const offers = (s: Session, kind?: PatternOffer["kind"]): PatternOffer[] =>
  s.sent.filter((m): m is PatternOffer => m.type === "patternOffer" && (kind === undefined || m.kind === kind));

/**
 * A later sitting, on a new day: another seating chart of the same shape, two rows filled from the
 * roster, and the third row's prediction. A new day, because offers walked past twice in one day
 * are held there (helper/src/patterns/gate.ts IGNORED_LIMIT). Null when no new offer was made.
 */
async function sitting(s: Session, windowId: string): Promise<{ value: string | undefined; window: GridWindow } | null> {
  s.desk.at += DAY;
  const before = offers(s, "loopNext").length;
  const g = grid(["Guest"], 6, windowId);
  startLoop(s, g);
  await s.routing.settle(s.helper);
  const made = offers(s, "loopNext").slice(before);
  s.desk.close(g.windowId);
  return made.length === 0 ? null : { value: made.at(-1)!.cells[0]?.value, window: g };
}

/** Two rows filled from the roster: the third is predicted. */
function startLoop(s: Session, dst: GridWindow, src: ListWindow = roster()): void {
  s.desk.showList(src);
  s.desk.advance(1000);
  s.desk.showGrid(dst);
  s.desk.fill(dst, 0, 0, src.lines[0]!);
  s.desk.fill(dst, 1, 0, src.lines[1]!);
}

const calendar = (day: number): ListWindow => ({
  windowId: "5150-20",
  app: FIXTURE_APP,
  title: "Calendar",
  group: "Event",
  lines: [`Design review ${day}`, `priya.raman+${day}@northwind.example`, `https://meet.example.com/day-${day}`],
});
const compose = (day: number): GridWindow => ({ windowId: `6160-${100 + day}`, app: MAIL_APP, title: `New message ${day}`, columns: ["Subject", "To", "Link"], rows: 1, values: new Map() });

/** One day: the calendar shows the day's event, a compose window opens, three values are copied, it closes. */
async function occurrence(s: Session, day: number): Promise<PatternOffer[]> {
  s.desk.at += DAY;
  const before = offers(s, "routine").length;
  const cal = calendar(day);
  s.desk.showList(cal);
  s.desk.advance(1000);
  const c = compose(day);
  s.desk.showGrid(c);
  await s.routing.settle(s.helper);
  const opened = offers(s, "routine").slice(before);
  for (let i = 0; i < 3; i++) s.desk.fill(c, 0, i, cal.lines[i]!);
  s.desk.close(c.windowId);
  return opened;
}

const result: Record<string, unknown> = {
  at: new Date().toISOString(),
  runs: RUNS,
  mode: "socket only: real helper in process on a temporary data dir, the pattern tests' desk as its reader, host --surfaces headless --perch hidden --no-ghost --test-hooks",
  routing: a.routing,
  hostRouting: a["host-routing"],
};
const editToReadBackMs: number[] = [];

try {
  await until("the host's socket", async () => {
    try {
      return (await state()) ? true : null;
    } catch {
      return null;
    }
  }, 15_000, 200);
  await hostCommand(`settings set routing ${a["host-routing"]}`);

  for (let run = 1; run <= RUNS; run++) {
    const s = await openSession();
    await until("the host on the helper", async () => ((await state()).helper?.connected ? true : null), 8000, 50);
    const initial = await until("the host's first list", async () => {
      const m = await memory();
      return m.book.loaded ? m : null;
    });
    check(`run ${run}: on connect the host lists the helper's memory: seven permissions, nothing else`,
      initial.book.entries.length === 7 && initial.book.entries.every((e) => e.kind === "permission"), { entries: initial.book.entries.length });

    // 1. About: learn, edit through the host, see the next offer change.
    const first = grid();
    startLoop(s, first);
    await s.routing.settle(s.helper);
    const predicted = offers(s, "loopNext")[0];
    await s.helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: predicted!.id, action: "take" });
    s.desk.fill(first, 2, 0, "Marcus Lowe (ops)");
    const about = await hostEntry("the About entry on the host", (e) => e.kind === "about");
    check(`run ${run}: a corrected value shows on the host as an About entry`, about.says === "Guest: Marcus Lowe (ops) (from your edit)", { says: about.says });
    s.desk.close(first.windowId);
    const before = (await sitting(s, "6160-3"))?.value;
    check(`run ${run}: the next chart is offered the corrected value`, before === "Marcus Lowe (ops)", { value: before });

    const t0 = Date.now();
    await memory(`edit ${about.id}`);
    await memory("draft value Marcus Lowe, Operations");
    const saved = await memory("save");
    const edited = await until("the edit read back on the host", async () => (await memory()).book.entries.find((e) => e.id === about.id && e.says.includes("Operations")) ?? null);
    editToReadBackMs.push(Date.now() - t0);
    check(`run ${run}: Edit, typing and Save on the host change the helper's entry`,
      saved.sent === true && edited.says === "Guest: Marcus Lowe, Operations (from your edit)", { sent: saved.sent, says: edited.says });
    const after = (await sitting(s, "6160-4"))?.value;
    check(`run ${run}: the next offer carries the edited value`, after === "Marcus Lowe, Operations", { value: after });
    const hostOffers = await until("the offer at the host", async () => ((await state()).helper?.offers ?? 0) > 0 ? (await state()).helper!.offers : null);
    check(`run ${run}: the host received the helper's offers`, hostOffers > 0, { offers: hostOffers });

    // Pause through the host: the next offer goes back to the source text; resume restores it.
    const paused = await memory(`pause ${about.id}`);
    await until("paused on the host", async () => (await memory()).book.entries.find((e) => e.id === about.id && e.status === "paused") ?? null);
    const whilePaused = (await sitting(s, "6160-5"))?.value;
    const resumed = await memory(`resume ${about.id}`);
    await until("resumed on the host", async () => (await memory()).book.entries.find((e) => e.id === about.id && e.status === "active") ?? null);
    const afterResume = (await sitting(s, "6160-6"))?.value;
    check(`run ${run}: Pause on the host takes the value out of the next offer; Resume puts it back`,
      paused.sent === true && resumed.sent === true && whilePaused === "Marcus Lowe" && afterResume === "Marcus Lowe, Operations",
      { whilePaused, afterResume });

    // 2. Routine: proven over three days, offered on the fifth, forgotten through the host.
    const quiet: PatternOffer[] = [];
    for (const d of [1, 2, 3, 4]) quiet.push(...(await occurrence(s, d)));
    const routine = await hostEntry("the proven routine on the host", (e) => e.kind === "routine" && e.status === "active");
    const offered = await occurrence(s, 5);
    check(`run ${run}: the routine is learned silently, then offered on day 5`, quiet.length === 0 && offered.length === 1,
      { quiet: quiet.length, offered: offered.map((o) => o.cells.map((c) => c.value)) });
    const asked = await memory(`forget ${routine.id}`);
    check(`run ${run}: Forget asks first and sends nothing yet`,
      !s.asked.some((m) => m.op === "forget") && (asked as unknown as { book: { confirmingForget?: string } }).book.confirmingForget === routine.id, {});
    const confirmed = await memory("confirm");
    await until("the routine gone from the host", async () => ((await memory()).book.entries.some((e) => e.id === routine.id) ? null : true));
    const rerun: PatternOffer[] = [];
    for (const d of [6, 7]) rerun.push(...(await occurrence(s, d)));
    const helperRoutines = s.helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "check", op: "list", kind: "routine" }).entries;
    check(`run ${run}: after Forget on the host, days 6 and 7 offer nothing and nothing is relearned`,
      confirmed.sent === true && rerun.length === 0 && helperRoutines.length === 0, { rerun: rerun.length, helperRoutines: helperRoutines.length });

    // 3. Permissions.
    const r1 = await memory("rule writeElsewhere actIfApproved");
    const read = await hostEntry("the rule read back", (e) => e.id === "permission-writeElsewhere" && e.rule === "actIfApproved");
    check(`run ${run}: a permission change reads back on the host and in the helper`,
      r1.sent === true && read.says === "Reversible write elsewhere: act if pre-approved" && s.helper.memory.permission("writeElsewhere") === "actIfApproved",
      { says: read.says, helper: s.helper.memory.permission("writeElsewhere") });
    const askedBefore = s.asked.length;
    const r2 = await memory("rule outbound act");
    const r3 = await memory("rule sensitive ask");
    await sleep(100);
    check(`run ${run}: outbound to Act and money to Ask are refused by the host and never sent`,
      r2.sent === false && r3.sent === false && s.asked.length === askedBefore && s.helper.memory.permission("outbound") === "handoff"
        && s.helper.memory.permission("sensitive") === "handoff", { problems: r3.book.problems });
    const r4 = await memory("rule outbound ask");
    await hostEntry("outbound at ask", (e) => e.id === "permission-outbound" && e.rule === "ask");
    check(`run ${run}: outbound can go as far as Ask first`, r4.sent === true && s.helper.memory.permission("outbound") === "ask", {});

    // 4. A typed value (onboarding's) is kept by the helper's add (B17), and Forget on the host removes it.
    await memory("remember Name Dana Whitfield");
    const kept = await hostEntry("the typed Name kept as an About entry", (e) => e.kind === "about" && e.says.includes("Dana Whitfield"));
    const typed = (await memory()).book.typed;
    const helperAbout = () =>
      s.helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "check", op: "list", kind: "about" }).entries
        .filter((e) => e.kind === "about" && e.fields.value === "Dana Whitfield");
    check(`run ${run}: a typed value is sent as add, kept by the helper, and no longer waits on the host`,
      typed.length === 0 && helperAbout().length === 1 && s.asked.some((m) => m.op === "add"), { says: kept.says, typed });
    await memory(`forget ${kept.id}`);
    const gone = await memory("confirm");
    await until("the typed Name gone from the host", async () => ((await memory()).book.entries.some((e) => e.id === kept.id) ? null : true));
    check(`run ${run}: Forget on the host removes the typed value from the helper`, gone.sent === true && helperAbout().length === 0, {});

    await closeSession(s);
  }
  const sorted = [...editToReadBackMs].sort((x, y) => x - y);
  result.editToReadBackMs = { n: sorted.length, p50: sorted[Math.floor(sorted.length / 2)] ?? null, max: sorted.at(-1) ?? null };
} catch (e) {
  check("the run finished", false, { error: e instanceof Error ? e.message : String(e) });
} finally {
  host.kill("SIGTERM");
}

const passed = checks.filter((c) => c.ok).length;
result.passed = passed;
result.total = checks.length;
result.checks = checks;
result.routerUsage = routed.usage();
writeFileSync(join(OUT, "memory-socket.json"), JSON.stringify(result, null, 2));
writeFileSync(join(OUT, "memory-socket.log"), log.join("\n"));
console.log(`${passed}/${checks.length} passed`);
process.exit(passed === checks.length && checks.length > 0 ? 0 : 1);
