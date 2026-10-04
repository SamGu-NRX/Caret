// B21 part 3 on caret-fixture with the real reader: a press by key is observed in a watched window, read only.
// The fixture's Keys window has Send as its default button (Return), a plain Save draft button and a Note field;
// its Keys other window has a default button OK and is never watched. Each case gives a control focus through
// the fixture's own stdin (no activation), posts one key to the fixture's pid with experiments/key-post.swift
// (built at --poster; never through the HID stream), and reads back what the reader reported as userPress and
// what the fixture's buttons ran, as AppKit decided.
//
//   return-default   focus on the window itself, Return        -> a press of Send by return
//   enter-default    focus on the window itself, keypad Enter  -> a press of Send by enter
//   space-focused    focus on Save draft, Space                -> a press of Save draft by space
//   return-text      focus in Note, Return                     -> no press reported
//   space-text       focus in Note, Space                      -> no press reported
//   return-unwatched focus in Keys other, Return               -> no press reported (not watched)
//
// --foreground starts the fixture with the accessory policy; it still never activates itself, so its windows are
// never key and AppKit runs no key equivalent (Return on a default button) for a posted key. --front (implies
// --foreground) activates the fixture so its window is key, as the user's app is when they press Return:
// LaunchServices must name the fixture frontmost before every key (here and in the poster), or the run ends as
// deferred: foreground, and at the end the fixture hands activation back to the app that had it.
//
//   gui.sh 10 env CARET_GUI_LOCK=held node scripts/key-press-eval.ts --bin ../apps/screen-reader/.build/debug --poster PATH --out DIR [--runs 5] [--foreground | --front]
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { HelperMessage, UserPress } from "../src/protocol.ts";
import { fixtureExecutable } from "./fixture-path.ts";
import { userInput } from "./synthetic-input.ts";

const run = promisify(execFile);
const { values: a } = parseArgs({
  options: { bin: { type: "string" }, poster: { type: "string" }, out: { type: "string" }, runs: { type: "string", default: "5" }, foreground: { type: "boolean", default: false }, front: { type: "boolean", default: false } },
});
if (a.bin === undefined || a.out === undefined || a.poster === undefined) throw new Error("--bin, --poster and --out are required");
if (process.env.CARET_GUI_LOCK !== "held") throw new Error("run under the GUI wrapper: gui.sh 10 env CARET_GUI_LOCK=held node scripts/key-press-eval.ts ...");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const POSTER = resolve(a.poster);
const RUNS = Number(a.runs);
const FRONT = a.front === true;
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
class Deferred extends Error {}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const sent: HelperMessage[] = [];
const presses: UserPress[] = [];
const log: string[] = [];
const dataDir = mkdtempSync(join(tmpdir(), "caret-key-press-"));
const sockDir = mkdtempSync(join(tmpdir(), "caret-key-press-sock-"));
const store = new Store(dataDir);
let server: HelperServer | null = null;
// No Jev and no offers: the eval reads what the reader reports, nothing else.
const helper = new Helper({
  store,
  askJev: null,
  shadow: false,
  allowBackgroundFocus: false,
  publish: (m) => {
    sent.push(m);
    if (m.type === "error") log.push(`helper error: ${m.message}`);
  },
  sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
  warn: (l) => log.push(l),
});
const origHandle = helper.handleReader.bind(helper);
helper.handleReader = (m) => {
  if (m.type === "userPress") presses.push(m);
  return origHandle(m);
};
server = new HelperServer(join(sockDir, "s.sock"), () => helper, (l) => log.push(l));
await server.listen();

const fixture: ChildProcessWithoutNullStreams = spawn(fixtureExecutable(a.bin), ["--windows", "keys", "--duration", "900", ...(a.foreground === true || FRONT ? ["--foreground"] : [])]);
let handBackTo: number | null = null;
let reader: ChildProcessWithoutNullStreams | null = null;
process.on("exit", () => {
  reader?.kill("SIGTERM");
  fixture.kill("SIGTERM");
  const gone = (pid: number | undefined): boolean => pid === undefined || spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().replace(/^Z.*/, "") === "";
  const until = Date.now() + 10_000;
  while (!(gone(reader?.pid) && gone(fixture.pid)) && Date.now() < until) spawnSync("/bin/sleep", ["0.2"]);
  rmSync(dataDir, { recursive: true, force: true });
  if (gone(reader?.pid)) rmSync(sockDir, { recursive: true, force: true });
});
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(143));

// Someone using the Mac ends the run and closes its windows; the keys this script posts are told apart.
const idleWatch = setInterval(() => {
  const out = spawnSync("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8" }).stdout;
  const ns = Number(/"HIDIdleTime" = (\d+)/.exec(out)?.[1] ?? NaN);
  if (!Number.isFinite(ns) || (ns / 1e9 < 5 && userInput(ns / 1e9))) {
    process.stderr.write(`deferred: user active (HID idle ${(ns / 1e9).toFixed(1)} s)\n`);
    process.exit(3);
  }
}, 1000);
idleWatch.unref();

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

interface Case {
  name: string;
  focus: "none" | "draft" | "note" | "other";
  code: 36 | 49 | 76;
  /** The press the reader must report, or null for none. */
  want: { label: string; via: UserPress["via"] } | null;
}
const CASES: Case[] = [
  { name: "return-default", focus: "none", code: 36, want: { label: "Send", via: "return" } },
  { name: "enter-default", focus: "none", code: 76, want: { label: "Send", via: "enter" } },
  { name: "space-focused", focus: "draft", code: 49, want: { label: "Save draft", via: "space" } },
  { name: "return-text", focus: "note", code: 36, want: null },
  { name: "space-text", focus: "note", code: 49, want: null },
  { name: "return-unwatched", focus: "other", code: 36, want: null },
];
interface Row {
  case: string;
  run: number;
  reported: { label: string; via: string; role: string; keyed: boolean; windowId: string }[];
  /** What the fixture's buttons ran, as AppKit decided: the press count delta per button. */
  appPressed: Record<string, number>;
  focusReply: Record<string, unknown>;
  ok: boolean;
}
const rows: Row[] = [];
const result: Record<string, unknown> = { foreground: a.foreground === true, front: FRONT, runs: RUNS };
let ok = false;
let readerErr = "";
try {
  await until("the fixture", () => fixturePid > 0);
  await sleep(800);
  reader = spawn(join(a.bin, "caret-screen"), ["--socket", join(sockDir, "s.sock"), "--only-pids", String(fixturePid), "--event-pids", String(fixturePid)]);
  reader.stderr.setEncoding("utf8");
  reader.stderr.on("data", (d: string) => (readerErr += d));
  const main = await until("the Keys window", () => windowTitled("Caret Fixture — Keys"));
  const other = await until("the Keys other window", () => windowTitled("Caret Fixture — Keys other"));
  result.windows = { main: main.window.windowId, other: other.window.windowId };
  const watch = async (): Promise<void> => {
    const r = await helper.readerVerb({ kind: "watchPresses", windows: [{ pid: fixturePid, windowId: main.window.windowId }] });
    if (r.outcome !== "ok") throw new Error(`watchPresses: ${r.outcome} ${r.detail ?? ""}`);
  };
  if (FRONT) {
    handBackTo = await lsFrontPid();
    await fx("activate legacy");
    const t0 = Date.now();
    while ((await lsFrontPid()) !== fixturePid) {
      if (Date.now() - t0 > 5000) throw new Deferred(`deferred: foreground (LaunchServices names pid ${await lsFrontPid()} frontmost, not the fixture ${fixturePid})`);
      await sleep(100);
    }
    result.frontFrom = handBackTo;
  }
  for (const c of CASES) {
    for (let r = 0; r < RUNS; r++) {
      await fx("keys reset");
      // The helper's own press watch follows the windows being edited; this eval's watch is set again each time.
      await watch();
      const focusReply = await fx(`keys focus ${c.focus}`);
      // Let the reader read the new focus before the key goes down, as a person's typing would follow it.
      await sleep(600);
      const before = presses.length;
      if (FRONT && (await lsFrontPid()) !== fixturePid) throw new Deferred(`deferred: foreground (the fixture lost the front before ${c.name} ${r})`);
      const env = FRONT ? { ...process.env, CARET_REQUIRE_FRONT: "1" } : process.env;
      const { stdout } = await run(POSTER, [String(fixturePid), String(c.code)], { timeout: 10_000, env });
      const posted = JSON.parse(stdout) as { ok: boolean; error?: string };
      if (!posted.ok) throw (posted.error ?? "").startsWith("deferred: foreground") ? new Deferred(String(posted.error)) : new Error(`key-post: ${stdout}`);
      await sleep(1000);
      const dump = (await fx("keys dump")) as { pressed: Record<string, number> };
      const reported = presses.slice(before).map((p) => ({ label: p.label, via: p.via, role: p.role, keyed: p.key !== null, windowId: p.windowId }));
      const okRow =
        c.want === null
          ? reported.length === 0
          : reported.length === 1 && reported[0]?.label === c.want.label && reported[0].via === c.want.via && reported[0].windowId === main.window.windowId && reported[0].role === "AXButton" && reported[0].keyed;
      rows.push({ case: c.name, run: r, reported, appPressed: dump.pressed, focusReply, ok: okRow });
      process.stdout.write(`${c.name} ${r}: ${okRow ? "ok" : "FAIL"} reported=${JSON.stringify(reported)} app=${JSON.stringify(dump.pressed)} focus=${JSON.stringify(focusReply)}\n`);
    }
  }
  ok = rows.every((x) => x.ok);
} catch (e) {
  result.error = e instanceof Deferred ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
} finally {
  if (FRONT && handBackTo !== null) {
    // The fixture hands activation back to the app that had it (caret-fixture `quit PID`), then exits.
    fixture.stdin.write(`quit ${handBackTo}\n`);
    await sleep(600);
  }
  reader?.kill("SIGTERM");
  fixture.kill("SIGTERM");
  await server.close();
  helper.memory.close();
  store.close();
}
const table = CASES.map((c) => {
  const xs = rows.filter((x) => x.case === c.name);
  const appRan = xs.filter((x) => Object.values(x.appPressed).some((n) => n > 0)).length;
  return `| ${c.name} | ${c.want === null ? "none" : `${c.want.label} by ${c.want.via}`} | ${xs.length} | ${xs.filter((x) => x.ok).length} | ${xs.reduce((n, x) => n + x.reported.length, 0)} | ${appRan} (${[...new Set(xs.flatMap((x) => Object.keys(x.appPressed)))].join(", ") || "none"}) |`;
});
const md = [
  `# Presses by key on caret-fixture (${FRONT ? "fixture activated and frontmost, its window key" : a.foreground === true ? "accessory fixture, not active" : "background-only fixture"})`,
  "",
  "Reported is what the reader sent as userPress; App ran is how many runs had any fixture button action run, as AppKit decided from the posted key.",
  "",
  "| Case | Expected report | Runs | As expected | Presses reported | App ran |",
  "| --- | --- | --- | --- | --- | --- |",
  ...table,
  "",
  result.error === undefined ? "" : `Error: ${String(result.error)}`,
];
writeFileSync(join(OUT, "key-press-eval.md"), md.join("\n") + "\n");
result.rows = rows;
result.log = log.slice(-20);
result.readerLogTail = readerErr.split("\n").slice(-12);
result.ok = ok;
writeFileSync(join(OUT, "key-press-eval.json"), JSON.stringify(result, null, 2) + "\n");
console.log(md.join("\n"));
process.exit(ok ? 0 : 1);
