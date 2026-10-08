// Every eval set, slowly, on free Laya (brief R1). Started detached by scripts/slow-eval.sh, it works through the sets
// below with --engine gateway:convaiinnovations/laya-free, the J1 replay cache in its own directory, and the slow layer
// (engines/decide/slow.ts) pacing and guarding every request; the loop and its rules are in slow-eval-core.ts.
//
//   node scripts/slow-eval.ts [--dir DIR] [--only id,id] [--pace-ms MS] [--engine NAME] [--spend-limit USD]
//
// --engine is any harness engine but canned (default Laya); a paid one (jev) needs --spend-limit, passed to each eval,
// and stays under J1's daily cap (CARET_JEV_DAILY_CAP). Give each engine its own --dir.
//
// DIR (~/.caret-run/evidence/screen/r1) holds:
//   status.json          the run's state, rewritten at every step: phase, current set and pass, each set's counts
//   summary.log          one line per finished set
//   results.md           each finished set's Laya numbers beside canned and Jev's last live run
//   cache/               the replay cache (CARET_JEV_CACHE) and cache/failures/, the answers the client could not use
//   sets/<id>/pass-<n>/  each pass's eval output, with pass-<n>.log (stdout and stderr) and pass-<n>.events.ndjson
//   STOPPED              written on a stop a person must clear (cost, auth, billing, the cap, a refused answer);
//                        slow-eval.sh will not start while it exists
// Fixture text only: every set runs on fixture pages, notes and memory, and GW1's guard refuses anything else.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { engineName } from "../src/engines/decide/port.ts";
import { DEFAULT_PACE_MS, DISK_FLOOR_GIB, HOLD_FILE, REAL_CLOCK, runStop, type SlowEvent } from "../src/engines/decide/slow.ts";
import { MAX_SETTLE, newStatus, passCounts, Runner, type EvalSet, type Held, type PassHandle, type RunnerStatus, type SetStatus } from "./slow-eval-core.ts";
import { cell, eligibleByPage, percentile, reportFile, scoreDir, type SetScore } from "./slow-eval-score.ts";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(HELPER, "..");
const EVIDENCE = join(homedir(), ".caret-run", "evidence", "screen");
const LAYA = "gateway:convaiinnovations/laya-free";
/** The signing identity every page eval in this run has used (C2, J1, P3 run scripts). */
const SIGN_ID = "DC7B5D99A0E1EE3CFA464E216C400A5A91F7F439";
const LOCK_FILE = join(homedir(), ".caret-run", "locks", "laya.lock");
const WITH_HEAVY = join(homedir(), ".long-run", "rig", "bin", "with-heavy.sh");
/** C2's estimate for one page-eval run (c2/run-evals.sh under with-heavy.sh 2.5 0.5). */
const LEASE_EST = ["2.5", "0.5"];

const { values: args } = parseArgs({
  options: {
    dir: { type: "string", default: join(EVIDENCE, "r1") },
    only: { type: "string" },
    "pace-ms": { type: "string", default: String(DEFAULT_PACE_MS) },
    engine: { type: "string", default: LAYA },
    "spend-limit": { type: "string" },
  },
});
const ENGINE = engineName(args.engine as string);
if (ENGINE === "canned") throw new Error("--engine canned needs no slow runner: its answers come from the key");
const PAID = ENGINE !== LAYA;
/** The worktree the runner runs and its HEAD, read once at start, for results.md (it said "v2/evals (e7dd882 + R1's runner)" whatever ran). */
const CODE = (() => {
  const git = (...a: string[]): string => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }).trim();
  try {
    const dirty = git("status", "--short", "--untracked-files=no") === "" ? "" : " with uncommitted changes";
    return `${ROOT.replace(homedir(), "~")} at ${git("rev-parse", "--short", "HEAD")} (${git("rev-parse", "--abbrev-ref", "HEAD")})${dirty}`;
  } catch (e) {
    return `${ROOT.replace(homedir(), "~")} (git unreadable: ${e instanceof Error ? e.message.slice(0, 80) : String(e)})`;
  }
})();
if (PAID && args["spend-limit"] === undefined) throw new Error(`--engine ${ENGINE} costs money: give --spend-limit USD, the most each eval run may spend`);
/** Each eval's own spend limit, for a paid engine. */
const SPEND = PAID ? ["--spend-limit", args["spend-limit"] as string] : [];
const DIR = args.dir as string;
const CACHE = join(DIR, "cache");
const PACE_MS = Number(args["pace-ms"]);
if (!(PACE_MS >= 0)) throw new Error("--pace-ms is milliseconds, 0 or more");
const ENV_FILE = process.env.CARET_ENV_FILE;
if (ENV_FILE === undefined || !existsSync(ENV_FILE)) throw new Error("CARET_ENV_FILE must name Caret's .env (slow-eval.sh sets it)");

interface SetDef extends EvalSet {
  cwd: string;
  argv(out: string): string[];
  drop?: boolean;
  /** Reference runs scored the same way: [label, run folder]. */
  refs: { canned?: [string, string][]; jev?: [string, string][] };
}

const MIN = 60_000;
const asks = (id: string, title: string, file: string, jev: string): SetDef => ({
  id,
  title,
  kind: "asks",
  browser: false,
  timeoutMs: 180 * MIN,
  cwd: HELPER,
  argv: (out) => ["scripts/realfill-asks.ts", "--out", out, "--asks-file", file, "--maker", "heads", "--engine", ENGINE, "--log-jev", join(out, "jev.ndjson"), ...SPEND],
  refs: { jev: [[`P1 ${jev}`, join(EVIDENCE, "p1", jev)]] },
});
const page = (id: string, title: string, kind: "tasks" | "corpus" | "fill" | "wizard", extra: string[], refs: SetDef["refs"], drop = false): SetDef => ({
  id,
  title,
  kind,
  browser: true,
  // The heavy lease's TTL is 60 min (with-heavy.sh --ttl 60).
  timeoutMs: 55 * MIN,
  cwd: ROOT,
  argv: (out) => ["fixtures/web-form/page-loop-eval.ts", "--sign-identity", SIGN_ID, "--engine", ENGINE, "--out", out, "--log-jev", join(out, "jev.ndjson"), ...SPEND, ...extra],
  refs,
  drop,
});
// The label names the run's own evidence folder; it said "J1 canned at 242b146 (same fill code)", which was true of no
// run after J1's branch (STATE 01:51Z correction).
const j1 = (name: string): [string, string] => [`J1 canned run ${name} (evidence/screen/j1/runs)`, join(EVIDENCE, "j1", "runs", name)];
const c2 = (name: string): [string, string] => [`C2 canned ${name} (v2/screen 1e52e70)`, join(EVIDENCE, "c2", name)];

// Ask sets first: no browser, no lease, and minutes each, so the first numbers come early.
const ALL: SetDef[] = [
  asks("b24", "B24 Asks (calibration set)", "asks.json", "asks-b24-heads-final"),
  asks("b25", "B25 Asks (held out)", "asks-heldout.json", "asks-heldout-heads-final"),
  asks("b26", "B26 Asks (held out)", "asks-heldout-2.json", "asks-heldout2-heads-final"),
  page("tasks-blind", "P2 tasks, blind notes", "tasks", ["--path", "goal", "--suite", "tasks"], { canned: [j1("tasks-blind-canned"), c2("tasks-blind-c2c")] }),
  page("tasks-labelled", "P2 tasks, labelled notes", "tasks", ["--path", "goal", "--suite", "tasks", "--sources", "labelled"], { canned: [j1("tasks-labelled-canned"), c2("tasks-labelled-c2c")] }),
  page("wizard-labelled", "P3 wizard journey (file input), labelled", "wizard", ["--suite", "tasks", "--path", "goal", "--journey", "wizard", "--sources", "labelled"], { canned: [c2("wizard-labelled-c2b")] }),
  page("wizard-drop-labelled", "P3 wizard journey (dropzone), labelled", "wizard", ["--suite", "tasks", "--path", "goal", "--journey", "wizard-drop", "--sources", "labelled"], { canned: [c2("wizard-drop-labelled-c2b")] }, true),
  {
    id: "tab-source",
    title: "P4 tab-source journey",
    kind: "journey",
    browser: true,
    timeoutMs: 55 * MIN,
    cwd: ROOT,
    argv: (out) => ["fixtures/web-form/tab-source-journey.ts", "--sign-identity", SIGN_ID, "--engine", ENGINE, "--out", out, ...SPEND],
    refs: { canned: [c2("journey-c2b")] },
  },
  page("corpus-goal", "Corpus + W4 goal (Ask on the page)", "corpus", ["--path", "goal"], { canned: [j1("corpus-goal-canned"), c2("corpus-goal-c2c")], jev: [["P2 goal-live-3 (live Jev)", join(EVIDENCE, "p2", "goal-live-3")]] }),
  page("corpus-fill", "Corpus + W4 Fill all", "fill", ["--path", "fill"], { canned: [c2("corpus-fill-c2c"), ["F2 canned corpus-fill-f2a (v2/screen 2a48e3e)", join(EVIDENCE, "f2", "corpus-fill-f2a")]], jev: [["P1 loop-live (live Jev)", join(EVIDENCE, "p1", "loop-live")]] }),
];
const only = args.only === undefined ? null : new Set(args.only.split(","));
if (only !== null) for (const id of only) if (!ALL.some((s) => s.id === id)) throw new Error(`--only names '${id}', which is not a set: ${ALL.map((s) => s.id).join(", ")}`);
const SETS = only === null ? ALL : ALL.filter((s) => only.has(s.id));

// ---- files ----
const setDir = (s: EvalSet): string => join(DIR, "sets", s.id);
const passDir = (s: EvalSet, pass: number): string => join(setDir(s), `pass-${pass}`);
const eventsFile = (s: EvalSet, pass: number): string => join(setDir(s), `pass-${pass}.events.ndjson`);
const STATUS = join(DIR, "status.json");
const writeAtomic = (file: string, body: string): void => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
};
const log = (line: string): void => void process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const readEvents = (file: string): SlowEvent[] => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as SlowEvent);
};

// ---- holders: a lock or a lease held by a child that lives until its stdin closes ----
/**
 * Runs `argv`, whose last command prints "held" once it holds what it waited for and then reads stdin until it closes.
 * Resolves with a release (close stdin, wait for the exit) once "held" is printed, or null when the command exits
 * without printing it. If this runner dies, the pipe closes and the holder exits with it: nothing is left held.
 */
function holder(argv: string[], what: string): Promise<Held | null> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(argv[0] as string, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let held = false;
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString();
      if (!held && /^held$/m.test(out)) {
        held = true;
        resolve({
          release: async () => {
            child.stdin?.end();
            await exited;
          },
        });
      }
    });
    child.stderr?.on("data", (b: Buffer) => void (err += b.toString()));
    child.once("exit", (code) => {
      if (!held) {
        log(`${what}: not taken (exit ${code}${err.trim() === "" ? "" : `: ${err.trim().split("\n").at(-1)}`})`);
        resolve(null);
      }
    });
  });
}
const HOLD_CMD = ["/bin/sh", "-c", "echo held; exec cat > /dev/null"];
const lockArgv = (wait: boolean): string[] => ["/usr/bin/lockf", "-k", ...(wait ? [] : ["-t", "0"]), LOCK_FILE, ...HOLD_CMD];
const ownerNote = (): void => writeAtomic(`${LOCK_FILE}.owner`, `${JSON.stringify({ pid: process.pid, who: "R1 slow-eval", dir: DIR, since: new Date().toISOString() })}\n`);
const withOwner = (h: Held | null): Held | null => {
  if (h === null) return null;
  ownerNote();
  return {
    release: async () => {
      rmSync(`${LOCK_FILE}.owner`, { force: true });
      await h.release();
    },
  };
};

// ---- passes ----
function runPass(set: EvalSet, pass: number, heavy: boolean): PassHandle {
  const def = set as SetDef;
  const out = passDir(set, pass);
  mkdirSync(out, { recursive: true });
  const fd = openSync(join(setDir(set), `pass-${pass}.log`), "a");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CARET_ENV_FILE: ENV_FILE,
    CARET_JEV_CACHE: CACHE,
    CARET_JEV_CACHE_MODE: "replay-or-record",
    CARET_SLOW_EVAL_EVENTS: eventsFile(set, pass),
    CARET_SLOW_EVAL_PACE_MS: String(PACE_MS),
    ...(heavy ? { CARET_HEAVY_LOCK_HELD: "1" } : {}),
  };
  const child = spawn(process.execPath, def.argv(out), { cwd: def.cwd, env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  log(`${set.id} pass ${pass}: pid ${child.pid}${heavy ? " (heavy lease held)" : ""}`);
  const done = new Promise<{ code: number | null; signal: string | null }>((r) => child.once("exit", (code, signal) => r({ code, signal })));
  let killed = false;
  return {
    done,
    kill: () => {
      if (killed || child.exitCode !== null || child.signalCode !== null) return;
      killed = true;
      // The eval's own SIGTERM handler closes Chrome and its launchd job; a minute later it is ended outright.
      child.kill("SIGTERM");
      const t = setTimeout(() => void (child.exitCode === null && child.signalCode === null && child.kill("SIGKILL")), 60_000);
      void done.then(() => clearTimeout(t));
    },
  };
}

// ---- scores and the results table ----
const corpusEligible = (): Map<string, number> => eligibleByPage(join(EVIDENCE, "j1", "runs", "corpus-goal-canned"));
function scoreOf(set: SetDef, dir: string): SetScore {
  return scoreDir(set.kind, dir, { ...(set.drop === undefined ? {} : { drop: set.drop }), ...(set.kind === "corpus" ? { fallbackEligible: corpusEligible() } : {}) });
}
/** `rejected`: requests Laya or the client could not answer (a 422, a malformed reply), recorded and replayed as failures. */
interface Totals { sent: number; rejected: number; rate: number; transient: number; waitMs: number; latencies: number[] }
function totals(set: EvalSet, st: SetStatus): Totals {
  const t: Totals = { sent: 0, rejected: 0, rate: 0, transient: 0, waitMs: st.backoffMs, latencies: [] };
  for (let p = 1; p <= st.passes; p++) {
    const ev = readEvents(eventsFile(set, p));
    const c = passCounts(ev);
    t.sent += c.sent;
    t.rejected += c.rejected;
    t.rate += c.rate;
    t.transient += c.transient;
    t.waitMs += c.paceWaitMs;
    for (const e of ev) if (e.t === "sent") t.latencies.push(e.latencyMs);
  }
  return t;
}
const ms = (x: number | null): string => (x === null ? "-" : `${Math.round(x)}`);
const mins = (x: number): string => (x < 120_000 ? `${Math.round(x / 1000)} s` : `${(x / 60_000).toFixed(1)} min`);
function summaryLine(set: EvalSet, st: SetStatus): string {
  const t = totals(set, st);
  if (st.state === "failed" || st.score === undefined) return `${set.id}: FAILED (${st.error ?? "?"}) after ${st.passes} passes; requests ${t.sent}, 429s ${t.rate}`;
  const s = st.score;
  return `${set.id}: right ${s.right}, wrong ${s.wrong}, abstained ${s.abstained ?? "-"}, written ${s.written} of ${s.eligible ?? "-"} ${s.unit}; requests ${t.sent} (${t.rejected} rejected), 429s ${t.rate}${t.transient > 0 ? `, transient ${t.transient}` : ""}, wait ${mins(t.waitMs)}, latency p50 ${ms(percentile(t.latencies, 0.5))} ms p95 ${ms(percentile(t.latencies, 0.95))} ms; ${s.extra}; pass ${st.scoredPass}${st.settled === true ? "" : " (UNSETTLED: still sent requests)"}`;
}
function refCell(refs: [string, string][] | undefined, set: SetDef): string {
  if (refs === undefined) return "none";
  return refs.map(([label, dir]) => {
    try {
      const s = scoreOf(set, dir);
      return `${label}: ${cell(s)}${s.unit === "fields" && s.abstained !== null ? `, ${s.abstained} left` : ""}`;
    } catch (e) {
      return `${label}: unreadable (${e instanceof Error ? e.message.slice(0, 80) : String(e)})`;
    }
  }).join("<br>");
}
function writeResults(status: RunnerStatus): void {
  const rows = SETS.map((set) => {
    const st = status.sets[set.id];
    const ours = st === undefined || st.state !== "done" || st.score === undefined ? `${st?.state ?? "pending"}${st !== undefined && st.passes > 0 ? ` (pass ${st.passes})` : ""}` : `${cell(st.score)}${st.score.abstained === null ? "" : `, ${st.score.abstained} ${st.score.unit === "asks" ? "asked or refused" : "left"}`}; ${st.score.extra}${st.settled === true ? "" : "; UNSETTLED"}`;
    const t = st === undefined ? null : totals(set, st);
    const traffic = t === null || st?.passes === 0 ? "-" : `${t.sent} sent, ${t.rejected} rejected, ${t.rate} × 429, wait ${mins(t.waitMs)}; p50 ${ms(percentile(t.latencies, 0.5))} / p95 ${ms(percentile(t.latencies, 0.95))} ms`;
    return `| ${set.title} | ${ours} | ${traffic} | ${refCell(set.refs.canned, set)} | ${refCell(set.refs.jev, set)} |`;
  });
  const md = [
    `# Slow evals on ${ENGINE} (R1)`,
    "",
    `Engine ${ENGINE}${PAID ? `, at most $${args["spend-limit"]} per eval run` : " (free, provider boundless)"}, J1's replay cache in ${CACHE.replace(homedir(), "~")}, at most one request per ${PACE_MS / 1000} s. Code: ${CODE}. Updated ${new Date().toISOString()}; runner ${status.state}${status.stopReason === undefined ? "" : ` (${status.stopReason})`}, ${status.phase}.`,
    "",
    "A Laya row is the set's last pass, whose every answer replayed from the cache (UNSETTLED when it still sent requests). Fields: right / eligible, wrong, left = eligible fields Caret left alone. Asks: right of 20, wrong includes an Ask continued after a pick. Requests are those sent to Laya over all passes; wait = pacing + backoff; latency is Laya's time to the response headers. References are scored by the same code (helper/scripts/slow-eval-score.ts). Canned runs answer from the key, so they measure the loop, not a model: J1's ran this branch's fill code, C2's and F2's later v2/screen code.",
    "",
    "| Set | This run | Requests sent | Canned | Jev, last live run |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ];
  writeAtomic(join(DIR, "results.md"), md.join("\n"));
}

/** The cache holds Laya's answers only, so none can replay as Jev's (other directory) or canned's (canned has no cache). */
function cacheEngines(): string {
  const seen = new Map<string, number>();
  for (const sub of existsSync(CACHE) ? readdirSync(CACHE) : []) {
    if (!/^[0-9a-f]{2}$/.test(sub)) continue;
    for (const f of readdirSync(join(CACHE, sub))) {
      if (!f.endsWith(".json")) continue;
      const e = JSON.parse(readFileSync(join(CACHE, sub, f), "utf8")) as { engine: string; model: string; answeredBy: string };
      const k = `${e.engine} | ${e.model} | ${e.answeredBy}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }
  return [...seen].map(([k, n]) => `${n} × ${k}`).join("; ") || "empty";
}

// ---- main ----
mkdirSync(join(DIR, "sets"), { recursive: true });
mkdirSync(CACHE, { recursive: true, mode: 0o700 });
const old = existsSync(STATUS) ? (JSON.parse(readFileSync(STATUS, "utf8")) as RunnerStatus) : null;
const status = newStatus(process.pid, Date.now(), SETS, old);
const where = { holdFile: HOLD_FILE, diskPath: homedir(), floorGiB: DISK_FLOOR_GIB };
const runner = new Runner(SETS, {
  clock: REAL_CLOCK,
  settlePasses: PAID ? 0 : MAX_SETTLE,
  stopCheck: () => runStop(where, Date.now()),
  lease: () => holder([WITH_HEAVY, ...LEASE_EST, ...HOLD_CMD], "heavy lease"),
  tryLock: async () => withOwner(await holder(lockArgv(false), "Laya lock (try)")),
  lock: async () => {
    for (;;) {
      const h = withOwner(await holder(lockArgv(true), "Laya lock"));
      if (h !== null) return h;
      await REAL_CLOCK.sleep(30_000);
    }
  },
  runPass,
  events: (set, pass) => readEvents(eventsFile(set, pass)),
  reported: (set, pass) => existsSync(join(passDir(set, pass), reportFile(set.kind, (set as SetDef).drop))),
  score: (set, pass) => scoreOf(set as SetDef, passDir(set, pass)),
  save: (s) => writeAtomic(STATUS, `${JSON.stringify(s, null, 1)}\n`),
  say: log,
  finished: (set, st) => {
    const line = summaryLine(set, st);
    appendFileSync(join(DIR, "summary.log"), `${new Date().toISOString()} ${line}\n`);
    log(line);
    log(`cache entries by engine | model | answered by: ${cacheEngines()}`);
    writeResults(status);
  },
  markStopped: (reason, detail) => writeAtomic(join(DIR, "STOPPED"), `${new Date().toISOString()} ${reason}: ${detail}\nslow-eval.sh will not start while this file exists; remove it once the cause is dealt with.\n`),
}, status);

let ending = false;
// No SIGHUP handler: nohup's ignore stands, so the run outlives the shell that started it.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (ending) return;
    ending = true;
    log(`${sig}: stopping the pass in flight`);
    void runner.interrupt(sig).then(() => {
      status.state = "stopped";
      status.stopReason = `signal: ${sig}`;
      status.updatedAt = new Date().toISOString();
      writeAtomic(STATUS, `${JSON.stringify(status, null, 1)}\n`);
      writeResults(status);
      process.exit(143);
    });
  });
}

log(`slow-eval pid ${process.pid}: ${SETS.length} sets (${SETS.map((s) => s.id).join(", ")}), pace ${PACE_MS} ms, dir ${DIR}`);
writeResults(status);
const end = await runner.run();
writeResults(status);
log(`slow-eval ${end}${status.stopReason === undefined ? "" : `: ${status.stopReason}`}`);
process.exit(end === "done" ? 0 : 3);
