// Real offers from the helper through the host, with nothing on screen (brief A5, acceptance 2).
//
// The helper runs in this process with its real producers, offer registry, executor and socket
// server, as in helper/test/offers-socket.test.ts. The reader is B7's simulator
// (helper/test/socket-reader.ts) replaying the recorded synthetic sessions in
// helper/fixtures/recorded. Jev is a fake that answers by rule. The host is the built Caret binary,
// started with `--surfaces headless`: it decides the helper's offers with its own arbiter and
// sends offerAccept, offerStop and taskControl on the real socket, but draws nothing and writes
// nothing (a text claim is recorded and refused as "headless"). Keys reach it through the debug
// socket's `key` hook, which runs the tap's own routing; no event is posted anywhere. The
// recordings' pids (5150, 6160, 7170) must not be live processes; the script checks first.
//
//   1. fill: the form's pop-up reaches the host; Tab sends offerAccept fillAll; every field is
//      written and verified; the host shows the toast with undo; ⌘Z undoes all three.
//   2. loop: the next row reaches the host as alternatives; typing the value instead withdraws
//      them; "Finish" arrives as an action line; Tab runs it to the last row.
//   3. loop, taking an alternative with the down arrow and Tab: the claim names candidate 1.
//   4. pending: "Open Caret Fixture" from a finished watch; Tab sends offerAccept and the window
//      is raised.
//   5. Esc on a fill that has run 3 s sends offerStop, and the run stops.
//
//   node apps/caret/scripts/offers_socket_acceptance.ts --out DIR [--runs 3]
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
import type { AskJev } from "../../../helper/src/fill/jev.ts";
import type { HelperMessage, OfferAccept, OfferStop, TaskControl } from "../../../helper/src/protocol.ts";
import { jevPickingText } from "../../../helper/test/builders.ts";
import { SocketReader, loadRecording, until as untilTrue } from "../../../helper/test/socket-reader.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const CARET = resolve(ROOT, "apps", "caret", ".build", "Caret.app", "Contents", "MacOS", "Caret");
const { values: a } = parseArgs({ options: { out: { type: "string" }, runs: { type: "string", default: "3" } } });
if (a.out === undefined) throw new Error("--out is required");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const RUNS = Number(a.runs);
const SOCKETS = join(homedir(), ".caret-run", "sockets");
const HELPER_SOCK = join(SOCKETS, "a5-offers-helper.sock");
const HOST_SOCK = join(SOCKETS, "a5-offers-host.sock");
const PIDS = [5150, 6160, 7170];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];

for (const pid of PIDS) {
  let live = true;
  try {
    process.kill(pid, 0);
  } catch (e) {
    live = (e as NodeJS.ErrnoException).code === "EPERM";
  }
  if (live) throw new Error(`pid ${pid} is a live process; the recordings' pids must not exist. Nothing was started.`);
}

// MARK: - the helper, fresh for each scenario

const F = (s: string): string => `dev.caret.fixture/standard/${s}`;
const M = (s: string): string => `dev.caret.mail/standard/${s}`;
const D = (s: string): string => `dev.caret.directory/standard/${s}`;
const FORM = "5150-2";
const SEATING = "6160-2";
const JOB = "5150-3";
const guest = (r: number): string => M(`textfield:guest~${r}`);
const FORM_KEYS = [F("textfield:name~0"), F("textfield:email~0"), F("textfield:phone~0")];
const FILL_VALUES: Record<string, string> = { Name: "Dana Whitfield", Email: "dana.whitfield@example.com", Phone: "+1 (512) 555-0142" };
/** B7's fake Jev: fill questions by field label, the pending questions by whether the window reads as finished. */
const askJev: AskJev = async (req) => {
  if (req.questions.finished !== undefined) {
    const done = /done|passed/i.test(String((req.state as Record<string, unknown>).now));
    return { model: "jev-test", answers: { finished: { choice: done ? "yes" : "no", confidence: 0.9 }, waiting: { choice: "no", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  }
  return jevPickingText((_, instructions) => FILL_VALUES[/Label: '([^']+)'/.exec(instructions)?.[1] ?? ""] ?? null)(req);
};

interface Stamped<T> {
  at: number;
  m: T;
}
interface Session {
  helper: Helper;
  server: HelperServer;
  reader: SocketReader;
  store: Store;
  dir: string;
  sent: Stamped<HelperMessage>[];
  fromHost: Stamped<OfferAccept | OfferStop | TaskControl>[];
  hooks: { applied: (windowId: string, at: number) => boolean; tick: (at: number) => void };
}

async function openSession(): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "caret-a5-offers-"));
  const store = new Store(join(dir, "data"));
  const sent: Stamped<HelperMessage>[] = [];
  const fromHost: Session["fromHost"] = [];
  let server: HelperServer | null = null;
  const helper = new Helper({
    store,
    askJev,
    shadow: false,
    allowBackgroundFocus: false,
    publish: (m) => {
      sent.push({ at: Date.now(), m });
      server?.publish(m);
    },
    sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
    warn: (l) => log.push(`helper: ${l}`),
  });
  // What the host sends, recorded as the helper receives it.
  const accept = helper.handleOfferAccept.bind(helper);
  helper.handleOfferAccept = (m) => (fromHost.push({ at: Date.now(), m }), accept(m));
  // offerStop is handled as taskControl stop inside the helper; only the host's own lines count.
  let inStop = false;
  const stop = helper.handleOfferStop.bind(helper);
  helper.handleOfferStop = (m) => {
    fromHost.push({ at: Date.now(), m });
    inStop = true;
    try {
      return stop(m);
    } finally {
      inStop = false;
    }
  };
  const task = helper.handleTask.bind(helper);
  helper.handleTask = (m) => (m.type === "taskControl" && !inStop && fromHost.push({ at: Date.now(), m }), task(m));
  server = new HelperServer(HELPER_SOCK, () => helper, (l) => log.push(`server: ${l}`));
  await server.listen();
  const reader = await SocketReader.connect(HELPER_SOCK);
  const hooks = {
    applied: (windowId: string, at: number): boolean => helper.model.windows.get(windowId)?.updatedAt === at,
    tick: (at: number): void => helper.tick(at),
  };
  return { helper, server, reader, store, dir, sent, fromHost, hooks };
}

async function closeSession(s: Session): Promise<void> {
  s.reader.close();
  s.helper.shutdown();
  await s.server.close();
  s.helper.memory.close();
  s.store.close();
  rmSync(s.dir, { recursive: true, force: true });
  // The host sees the helper go and reconnects to the next one within its 2 s backoff.
  await until("the host to notice the helper left", async () => ((await state()).helper?.connected === false ? true : null), 5000);
}

// MARK: - the host, headless

const host: ChildProcess = spawn(CARET, [
  "--helper-socket", HELPER_SOCK, "--socket", HOST_SOCK, "--no-ghost", "--perch", "hidden", "--surfaces", "headless",
  "--allow-pids", PIDS.join(","),
  // Nothing on screen, not even the menu bar item, and a settings file of the run's own.
  "--status-item", "off", "--settings", join(SOCKETS, "a5-offers-settings.json"),
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

interface Surface {
  headless?: boolean;
  offerKey?: string;
  kind?: string;
  source?: string;
  candidates?: string[];
  lineText?: string;
  figure?: string;
  workingOn?: string;
  toast?: { kind: string; caption: string; grantID?: number };
  lastAccepted?: { offerKey?: string; actionId?: string; candidate?: number; overrides?: Record<string, number>; kind: string; source: string };
}
interface HostState {
  surface?: Surface;
  helper?: { connected: boolean; offers: number; withdrawals: number; progress: number; accepts: number; stops: number; undecodable: number };
  lastClaim?: { outcome: unknown; candidate?: number; actionID?: string };
  counters?: Record<string, number>;
}
const state = async (): Promise<HostState> => (await hostCommand("state")) as HostState;
const surface = async (): Promise<Surface> => (await state()).surface ?? {};
const key = async (name: string, pid: number): Promise<boolean> => (await hostCommand(`key ${name} ${pid}`)).consumed === true;

async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 10_000, every = 5): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

const checks: Record<string, unknown>[] = [];
const check = (name: string, ok: boolean, detail: Record<string, unknown> = {}): void => {
  checks.push({ check: name, ...detail, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail).slice(0, 300)}`);
};
const pct = (xs: number[], p: number): number | null => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length === 0 ? null : s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const summary = (xs: number[]): Record<string, number | null> => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: xs.length ? Math.max(...xs) : null });

const phasesOf = (s: Session, taskId: string): string[] =>
  s.sent.flatMap((x) => (x.m.type === "taskProgress" && x.m.taskId === taskId ? [x.m.phase] : []));
const firstSent = <T extends HelperMessage["type"]>(s: Session, type: T): Stamped<Extract<HelperMessage, { type: T }>> | undefined =>
  s.sent.find((x) => x.m.type === type) as Stamped<Extract<HelperMessage, { type: T }>> | undefined;
async function connected(): Promise<void> {
  await until("the host on the helper", async () => ((await state()).helper?.connected ? true : null), 8000, 50);
}
async function terminal(s: Session, taskId: string, ms = 10_000): Promise<string[]> {
  await until(`${taskId} to end`, async () => (["done", "stopped", "handoff", "paused"].some((p) => phasesOf(s, taskId).includes(p)) ? true : null), ms);
  return phasesOf(s, taskId);
}

const result: Record<string, unknown> = {
  at: new Date().toISOString(),
  runs: RUNS,
  mode: "socket only: real helper in process, B7 socket reader replaying synthetic recordings, host --surfaces headless --perch hidden --no-ghost",
};
const offerToHostMs: number[] = [];
const keyToAcceptMs: number[] = [];
const doneToLineEndMs: number[] = [];
const withdrawToGoneMs: number[] = [];

try {
  await until("the host's socket", async () => {
    try {
      return (await state()).surface?.headless === true ? true : null;
    } catch {
      return null;
    }
  }, 15_000, 200);
  check("the host runs headless", true);

  for (let run = 1; run <= RUNS; run++) {
    // 1. Fill pop-up: Tab fills every field through the executor; the toast's ⌘Z undoes them.
    {
      const s = await openSession();
      await connected();
      await s.reader.replay(loadRecording("offers-fill.ndjson"), s.hooks);
      const popup = await until("the popup message", async () => firstSent(s, "popup") ?? null, 5000);
      const offerKey = popup.m.offerKey;
      const shown = await until("the host to hold the pop-up", async () => {
        const sf = await surface();
        return sf.kind === "popup" && sf.offerKey === offerKey ? { sf, t: Date.now() } : null;
      }, 5000);
      offerToHostMs.push(shown.t - popup.at);
      const keyAt = Date.now();
      const consumed = await key("tab", 5150);
      const accepted = await until("offerAccept at the helper", async () => s.fromHost.find((x) => x.m.type === "offerAccept") ?? null, 5000);
      keyToAcceptMs.push(accepted.at - keyAt);
      const phases = await terminal(s, offerKey);
      const doneAt = s.sent.find((x) => x.m.type === "taskProgress" && x.m.taskId === offerKey && x.m.phase === "done")?.at ?? 0;
      const toast = await until("the fill toast", async () => {
        const sf = await surface();
        return sf.toast?.kind === "done" ? { sf, t: Date.now() } : null;
      }, 5000);
      doneToLineEndMs.push(toast.t - doneAt);
      const values = FORM_KEYS.map((k) => s.reader.value(FORM, k));
      check(`run ${run} fill: Tab sends offerAccept fillAll and every field verifies`,
        consumed && JSON.stringify(accepted.m) === JSON.stringify({ type: "offerAccept", v: 1, offerId: offerKey, actionId: "fillAll", overrides: {}, at: (accepted.m as OfferAccept).at })
          && JSON.stringify(phases) === JSON.stringify(["started", "acting", "verified", "acting", "verified", "acting", "verified", "done"])
          && JSON.stringify(values) === JSON.stringify(["Dana Whitfield", "dana.whitfield@example.com", "+1 (512) 555-0142"]),
        { consumed, accept: accepted.m, phases, values });
      // B8: the toast names the popup's sourceApps, not the source block's "App, Title".
      check(`run ${run} fill: the toast names the count and the source app, with undo`,
        toast.sf.toast?.caption === "Filled 3 fields from Mail Fixture" && typeof toast.sf.toast?.grantID === "number" && toast.sf.lineText === toast.sf.toast?.caption,
        { toast: toast.sf.toast, lineText: toast.sf.lineText, figure: toast.sf.figure });
      const undoConsumed = await key("cmd-z", 5150);
      const control = await until("taskControl undo at the helper", async () => s.fromHost.find((x) => x.m.type === "taskControl") ?? null, 5000);
      await until("the undone phase", async () => (phasesOf(s, offerKey).includes("undone") ? true : null), 5000);
      const cleared = await until("the undo caption", async () => {
        const sf = await surface();
        return sf.toast?.kind === "undone" || sf.toast?.kind === "error" ? sf : null;
      }, 5000);
      const after = FORM_KEYS.map((k) => s.reader.value(FORM, k));
      check(`run ${run} fill: ⌘Z on the toast sends taskControl undo and clears the three fields`,
        undoConsumed && (control.m as TaskControl).action === "undo" && (control.m as TaskControl).taskId === offerKey
          && cleared.toast?.caption === "Cleared 3 fields" && after.every((v) => v === ""),
        { undoConsumed, control: control.m, toast: cleared.toast, after });
      if (run === 1) result.fillPopupSurface = shown.sf;
      await closeSession(s);
    }

    // 2. Loop: alternatives; the user types the value, so they are withdrawn; Finish runs.
    {
      const s = await openSession();
      await connected();
      await s.reader.replay(loadRecording("offers-loop.ndjson"), s.hooks);
      const alt = await until("the alternatives message", async () => firstSent(s, "alternatives") ?? null, 5000);
      const shown = await until("the host to hold the alternatives", async () => {
        const sf = await surface();
        return sf.kind === "ghost" && sf.offerKey === alt.m.offerKey ? { sf, t: Date.now() } : null;
      }, 5000);
      offerToHostMs.push(shown.t - alt.at);
      check(`run ${run} loop: the next row arrives as alternatives, top one first`,
        JSON.stringify(shown.sf.candidates) === JSON.stringify(["Marcus Lowe", "Lena Hartmann"]) && shown.sf.source === "helper" && shown.sf.lineText === "Marcus Lowe",
        { offerKey: shown.sf.offerKey, candidates: shown.sf.candidates, lineText: shown.sf.lineText });
      // The user types the second value instead of taking it; the helper withdraws the offer.
      const typed = s.reader.setValue(SEATING, guest(2), "Lena Hartmann");
      await untilTrue(() => s.hooks.applied(SEATING, typed.at), 3000);
      s.helper.tick(typed.at + 2000);
      const withdrawn = await until("the withdrawal", async () => s.sent.find((x) => x.m.type === "offerWithdrawn" && x.m.id === alt.m.offerKey) ?? null, 5000);
      const gone = await until("the host to drop the alternatives", async () => ((await surface()).offerKey !== alt.m.offerKey ? Date.now() : null), 5000);
      withdrawToGoneMs.push(gone - withdrawn.at);
      const action = await until("the Finish action", async () => firstSent(s, "action") ?? null, 5000);
      const line = await until("the host to hold the action line", async () => {
        const sf = await surface();
        return sf.kind === "action" && sf.offerKey === action.m.offerKey ? { sf, t: Date.now() } : null;
      }, 5000);
      offerToHostMs.push(line.t - action.at);
      const keyAt = Date.now();
      const consumed = await key("tab", 6160);
      const accepted = await until("offerAccept at the helper", async () => s.fromHost.find((x) => x.m.type === "offerAccept") ?? null, 5000);
      keyToAcceptMs.push(accepted.at - keyAt);
      const phases = await terminal(s, action.m.offerKey);
      const doneAt = s.sent.find((x) => x.m.type === "taskProgress" && x.m.taskId === action.m.offerKey && x.m.phase === "done")?.at ?? 0;
      const ended = await until("the done line", async () => {
        const sf = await surface();
        return sf.workingOn === undefined && sf.figure === "done" ? { sf, t: Date.now() } : null;
      }, 5000);
      doneToLineEndMs.push(ended.t - doneAt);
      const rows = [0, 1, 2, 3, 4, 5].map((r) => s.reader.value(SEATING, guest(r)));
      check(`run ${run} loop: typing the value withdraws the alternatives from the host`, gone > 0 && (withdrawn.m as { reason: string }).reason === "taken", { withdrawal: withdrawn.m });
      check(`run ${run} loop: Finish arrives as an action line and Tab runs it to the last row`,
        consumed && (accepted.m as OfferAccept).offerId === action.m.offerKey && (accepted.m as OfferAccept).actionId === "finish"
          && phases.at(-1) === "done" && JSON.stringify(rows) === JSON.stringify(["Dana Whitfield", "Priya Raman", "Lena Hartmann", "Oskar Lindqvist", "Yusuf Demir", "Mila Novak"]),
        { line: line.sf.lineText, accept: accepted.m, phases, rows, ended: ended.sf.lineText });
      await closeSession(s);
    }

    // 3. Loop, taking the second alternative with the keys: a text claim, refused only because a
    //    headless host writes nothing.
    {
      const s = await openSession();
      await connected();
      await s.reader.replay(loadRecording("offers-loop.ndjson"), s.hooks);
      const alt = await until("the alternatives message", async () => firstSent(s, "alternatives") ?? null, 5000);
      await until("the host to hold the alternatives", async () => ((await surface()).offerKey === alt.m.offerKey ? true : null), 5000);
      const down = await key("down", 6160);
      const opened = await surface();
      const tab = await key("tab", 6160);
      const st = await state();
      check(`run ${run} loop: down then Tab takes the second alternative, and no accept is sent`,
        down && tab && opened.lineText === "Lena Hartmann" && st.surface?.lastAccepted?.candidate === 1 && st.surface?.lastAccepted?.offerKey === alt.m.offerKey
          && JSON.stringify(st.lastClaim?.outcome) === JSON.stringify({ rejected: { _0: "headless" } }) && s.fromHost.length === 0,
        { opened: opened.lineText, lastAccepted: st.surface?.lastAccepted, claim: st.lastClaim, fromHost: s.fromHost.length });
      await closeSession(s);
    }

    // 4. Pending: Open <app> from a finished watch.
    {
      const s = await openSession();
      await connected();
      await s.reader.replay(loadRecording("offers-pending.ndjson"), s.hooks);
      await s.helper.pending.whenIdle();
      const action = await until("the Open action", async () => firstSent(s, "action") ?? null, 5000);
      const line = await until("the host to hold the Open line", async () => {
        const sf = await surface();
        return sf.kind === "action" && sf.offerKey === action.m.offerKey ? { sf, t: Date.now() } : null;
      }, 5000);
      offerToHostMs.push(line.t - action.at);
      const keyAt = Date.now();
      const consumed = await key("tab", 6160);
      const accepted = await until("offerAccept at the helper", async () => s.fromHost.find((x) => x.m.type === "offerAccept") ?? null, 5000);
      keyToAcceptMs.push(accepted.at - keyAt);
      const phases = await terminal(s, action.m.offerKey);
      const ended = await until("the done line", async () => {
        const sf = await surface();
        return sf.workingOn === undefined && sf.figure === "done" ? sf : null;
      }, 5000);
      check(`run ${run} pending: Open arrives, Tab sends offerAccept open, and the window is raised`,
        consumed && line.sf.lineText === "Caret Fixture Done. 48 of 48 tests passed." && (accepted.m as OfferAccept).actionId === "open"
          && JSON.stringify(phases) === JSON.stringify(["started", "acting", "verified", "done"]) && s.reader.focusedWindow() === JOB && s.reader.frontmostPid === 5150,
        { line: line.sf.lineText, accept: accepted.m, phases, focused: s.reader.focusedWindow(), ended: ended.lineText });
      await closeSession(s);
    }

    // 5. Esc on a fill that has run 3 s: offerStop, and the run stops at its next step.
    {
      const s = await openSession();
      await connected();
      await s.reader.replay(loadRecording("offers-fill.ndjson"), s.hooks);
      const popup = await until("the popup message", async () => firstSent(s, "popup") ?? null, 5000);
      await until("the host to hold the pop-up", async () => ((await surface()).offerKey === popup.m.offerKey ? true : null), 5000);
      // Each write takes 2.5 s, so at 3.2 s the second step is still running and the third has not begun.
      s.reader.delayMs.write = 2500;
      await key("tab", 5150);
      await until("the working line", async () => ((await surface()).workingOn === popup.m.offerKey ? true : null), 3000);
      // Esc stops work only after it has run 3 s (StatusLine.stoppableAfter).
      await sleep(3200);
      const st0 = await surface();
      const esc = await key("esc", 5150);
      const stop = await until("offerStop at the helper", async () => s.fromHost.find((x) => x.m.type === "offerStop") ?? null, 5000).catch(() => null);
      await until("the stopped phase", async () => (phasesOf(s, popup.m.offerKey).includes("stopped") ? true : null), 15_000).catch(() => null);
      await sleep(3000);
      const phases = phasesOf(s, popup.m.offerKey);
      const after = await surface();
      const values = FORM_KEYS.map((k) => s.reader.value(FORM, k));
      check(`run ${run} stop: Esc on the working line after 3 s sends offerStop and the run stops before the last field`,
        stop !== null && (stop.m as OfferStop).offerId === popup.m.offerKey && after.workingOn === undefined
          && phases.includes("stopped") && !phases.includes("done") && values[2] === "",
        { lineBeforeEsc: st0.lineText, values, escConsumed: esc, stop: stop?.m ?? null, phases, lineAfter: after.lineText, controls: s.fromHost.map((x) => x.m.type === "taskControl" ? `taskControl ${(x.m as TaskControl).action}` : x.m.type) });
      await closeSession(s);
    }
  }

  const st = await state();
  result.offerToHostMs = summary(offerToHostMs);
  result.keyToOfferAcceptMs = summary(keyToAcceptMs);
  result.doneToLineEndMs = summary(doneToLineEndMs);
  result.withdrawalToGoneMs = summary(withdrawToGoneMs);
  result.hostHelperLink = st.helper;
  result.hostCounters = Object.fromEntries(Object.entries(st.counters ?? {}).filter(([k]) => k.startsWith("surface.") || k.startsWith("offers.")));
  check("no line from the helper was undecodable by the host", (st.helper?.undecodable ?? 1) === 0, { undecodable: st.helper?.undecodable });
} catch (e) {
  check("script ran to the end", false, { error: String(e).slice(0, 400) });
  // What the host had when it stopped, for diagnosis.
  result.hostAtFailure = await state().catch(() => null);
} finally {
  result.checks = checks;
  result.passed = checks.filter((c) => c.ok).length;
  result.failed = checks.filter((c) => !c.ok).length;
  writeFileSync(join(OUT, "offers-socket.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(join(OUT, "offers-socket.log"), log.join("\n") + "\n");
  host.kill("SIGTERM");
  console.log(`${result.passed} passed, ${result.failed} failed -> ${OUT}`);
  process.exit(result.failed === 0 ? 0 : 1);
}
