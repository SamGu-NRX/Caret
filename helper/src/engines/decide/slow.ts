// The slow runner's layer in an eval process (brief R1): free Laya rate-limits quick requests (GW1: four in a row get a
// 429), so the overnight runner (scripts/slow-eval.ts) runs every set paced and lets a limit only wait, never shorten a
// set. This layer sits between the replay cache and the engine, so only requests the cache cannot answer reach it.
//
// For each request it:
// - stops the pass before sending when ~/.caret-run/HOLD holds or free disk is under the floor;
// - spaces requests at least `paceMs` apart, measured from the last request any slow runner on this Mac sent (a shared
//   file), so a new pass or a second process does not burst;
// - sends with the client's own 429 retry off, so the runner's backoff (30 s doubling to 10 min) is the only one;
// - ends the pass on a 429 or a transient failure, and stops the run on any cost above 0 (free models), a refused gateway answer, an
//   auth or billing failure, or the daily cap. Ending a pass never answers the eval: the request stays unanswered and
//   the process is terminated, so the eval cannot score a limit as an abstention. The runner waits, then reruns the set,
//   whose answered requests replay from the cache, so the request that met the limit is the next one sent;
// - records an answer the model gave that the client could not use (a malformed reply, a 4xx other than auth or rate),
//   so a rerun replays that failure instead of asking again.
//
// Harness-only: harness.ts installs it when CARET_SLOW_EVAL_EVENTS is set, and the Laya guard and the cache's fixture
// checks run above it.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CacheRefused } from "./cache.ts";
import { JevCapError } from "./daily-cap.ts";
import { JevGatewayPolicyError, JevHttpError, JevNetworkError, type AskJev, type JevRequest } from "../../fill/jev.ts";

/** Reasons that stop the whole run: the runner exits and does not retry. */
export type SlowStop = "cost" | "policy" | "auth" | "billing" | "cap" | "hold" | "disk";
/** How a pass can end early: a stop, or a limit the runner waits out before rerunning the set. */
export type PassEnd = SlowStop | "rate" | "transient";
export const STOPS: readonly SlowStop[] = ["cost", "policy", "auth", "billing", "cap", "hold", "disk"];

export type SlowEvent =
  | { t: "sent"; at: number; key: string; paceWaitMs: number; latencyMs: number }
  | { t: "rate"; at: number; key: string; paceWaitMs: number }
  | { t: "transient"; at: number; key: string; paceWaitMs: number; detail: string }
  | { t: "answerFailed"; at: number; key: string; paceWaitMs: number; latencyMs: number; error: string }
  | { t: "failureReplayed"; at: number; key: string }
  | { t: "end"; at: number; reason: PassEnd; detail: string };

export interface SlowClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const REAL_CLOCK: SlowClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export interface SlowOptions {
  clock: SlowClock;
  /** A free model (Laya): any cost above 0 stops the run. A paid engine (Jev) is held to J1's daily cap instead. */
  freeOnly: boolean;
  paceMs: number;
  /** When the last request any slow runner sent left (epoch ms), shared between processes. */
  pace: { read(): number | null; write(at: number): void };
  /** Answers the model gave that the client could not use, by request key. */
  failures: { get(key: string): string | undefined; put(key: string, error: string): void };
  keyOf(req: JevRequest): string;
  /** A reason to stop before sending, or null. */
  stopCheck(): { reason: "hold" | "disk"; detail: string } | null;
  log(e: SlowEvent): void;
  /** Ends this process's pass. The ask that called it never settles. */
  endPass(reason: PassEnd, detail: string): void;
}

/** A recorded answer failure, replayed without sending. */
export class SlowAnswerFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlowAnswerFailure";
  }
}

type Outcome = { kind: "stop"; reason: SlowStop; detail: string } | { kind: "rate" } | { kind: "transient"; detail: string } | { kind: "answer"; detail: string } | { kind: "pass" };

const text = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);

/** What a failed request means for the run (see the file's header). */
export function classify(e: unknown): Outcome {
  if (e instanceof JevGatewayPolicyError) {
    return { kind: "stop", reason: /cost/i.test(e.message) || e.usage.costUsd > 0 ? "cost" : "policy", detail: text(e) };
  }
  if (e instanceof JevCapError) return { kind: "stop", reason: "cap", detail: text(e) };
  if (e instanceof CacheRefused) return { kind: "pass" };
  if (e instanceof JevNetworkError) return { kind: "transient", detail: text(e) };
  if (e instanceof JevHttpError) {
    if (e.status === 429) return { kind: "rate" };
    if (e.kind === "auth" || e.kind === "card" || e.kind === "paidCredits") return { kind: "stop", reason: "auth", detail: text(e) };
    if (e.kind === "billing") return { kind: "stop", reason: "billing", detail: text(e) };
    if (e.status >= 500 || e.status === 408) return { kind: "transient", detail: text(e) };
    return { kind: "answer", detail: text(e) };
  }
  return { kind: "answer", detail: text(e) };
}

const never = <T>(): Promise<T> => new Promise<T>(() => {});

export function slowAsk(inner: AskJev, o: SlowOptions): AskJev {
  let queue: Promise<unknown> = Promise.resolve();
  let last = Number.NEGATIVE_INFINITY;
  let ended = false;
  const end = (reason: PassEnd, detail: string): void => {
    if (ended) return;
    ended = true;
    o.log({ t: "end", at: o.clock.now(), reason, detail });
    o.endPass(reason, detail);
  };
  /** Waits for this request's turn; null when the pass ended first. */
  const turn = (): Promise<{ at: number; waited: number } | null> => {
    const t = queue.then(async () => {
      if (ended) return null;
      const t0 = o.clock.now();
      for (;;) {
        const stop = o.stopCheck();
        if (stop !== null) {
          end(stop.reason, stop.detail);
          return null;
        }
        const due = Math.max(last, o.pace.read() ?? Number.NEGATIVE_INFINITY) + o.paceMs;
        const now = o.clock.now();
        if (due <= now) break;
        // Another process can move the shared time while this one sleeps, so it is read again after each wake.
        await o.clock.sleep(due - now);
        if (ended) return null;
      }
      const at = o.clock.now();
      last = at;
      o.pace.write(at);
      return { at, waited: at - t0 };
    });
    queue = t.catch(() => {});
    return t;
  };
  return async (req) => {
    if (ended) return never();
    const key = o.keyOf(req);
    const failed = o.failures.get(key);
    if (failed !== undefined) {
      o.log({ t: "failureReplayed", at: o.clock.now(), key });
      throw new SlowAnswerFailure(failed);
    }
    const slot = await turn();
    if (slot === null) return never();
    let r: Awaited<ReturnType<AskJev>>;
    try {
      r = await inner({ ...req, retry429: false });
    } catch (e) {
      const c = classify(e);
      switch (c.kind) {
        case "stop":
          end(c.reason, c.detail);
          return never();
        case "rate":
          o.log({ t: "rate", at: slot.at, key, paceWaitMs: slot.waited });
          end("rate", "HTTP 429");
          return never();
        case "transient":
          o.log({ t: "transient", at: slot.at, key, paceWaitMs: slot.waited, detail: c.detail });
          end("transient", c.detail);
          return never();
        case "answer":
          o.failures.put(key, c.detail);
          o.log({ t: "answerFailed", at: slot.at, key, paceWaitMs: slot.waited, latencyMs: o.clock.now() - slot.at, error: c.detail });
          throw e;
        case "pass":
          throw e;
      }
    }
    if (!Number.isFinite(r.costUsd) || (o.freeOnly && r.costUsd !== 0)) {
      end("cost", `an answer cost $${r.costUsd}; free Laya must cost 0`);
      return never();
    }
    o.log({ t: "sent", at: slot.at, key, paceWaitMs: slot.waited, latencyMs: r.latencyMs });
    return r;
  };
}

// ---- the environment's pieces, for harness.ts ----

/** Stops sending under this much free disk (brief R1). */
export const DISK_FLOOR_GIB = 10;
export const DEFAULT_PACE_MS = 3000;
export const HOLD_FILE = join(homedir(), ".caret-run", "HOLD");
export const PACE_FILE = join(homedir(), ".caret-run", "locks", "laya.last");

/**
 * The lead's hold, read as ~/.long-run/rig/bin/lead-hold reads it: held while the first field (epoch seconds) is in the
 * future, and held when that field is not a number, so a typo stops runs rather than letting them through.
 */
export function holdReason(file: string, nowMs: number): string | null {
  let line: string;
  try {
    line = readFileSync(file, "utf8").split("\n")[0] ?? "";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const [until, ...rest] = line.trim().split(/\s+/);
  if (until === undefined || !/^\d+$/.test(until)) return `unreadable hold marker ${file} (first field '${until ?? ""}' is not epoch seconds)`;
  if (Number(until) * 1000 <= nowMs) return null;
  return `${rest.join(" ") || "no reason given"} (until ${new Date(Number(until) * 1000).toISOString()})`;
}

export function freeDiskGiB(path: string): number {
  const s = statfsSync(path);
  return (s.bavail * s.bsize) / 2 ** 30;
}

/** Hold and disk, as the layer and the runner both check them. */
export function runStop(env: { holdFile: string; diskPath: string; floorGiB: number }, nowMs: number): { reason: "hold" | "disk"; detail: string } | null {
  const hold = holdReason(env.holdFile, nowMs);
  if (hold !== null) return { reason: "hold", detail: hold };
  const free = freeDiskGiB(env.diskPath);
  if (free < env.floorGiB) return { reason: "disk", detail: `${free.toFixed(2)} GiB free, under ${env.floorGiB} GiB` };
  return null;
}

export function filePace(file: string): SlowOptions["pace"] {
  return {
    read: () => {
      try {
        const n = Number(readFileSync(file, "utf8").trim());
        return Number.isFinite(n) ? n : null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    write: (at) => {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${at}\n`);
      renameSync(tmp, file);
    },
  };
}

/** Answer failures as one small file each, beside the replay cache's entries. */
export function fileFailures(dir: string): SlowOptions["failures"] {
  return {
    get: (key) => {
      try {
        return (JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as { error: string }).error;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
    put: (key, error) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `${key}.${process.pid}.tmp`);
      writeFileSync(tmp, `${JSON.stringify({ error, recordedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      renameSync(tmp, join(dir, `${key}.json`));
    },
  };
}

export function fileLog(file: string): (e: SlowEvent) => void {
  return (e) => appendFileSync(file, `${JSON.stringify(e)}\n`);
}

/** Ends this eval process the way a user's Ctrl-C would, so its own handler closes Chrome and its launchd job. */
export function terminateSelf(): void {
  process.kill(process.pid, "SIGTERM");
}
