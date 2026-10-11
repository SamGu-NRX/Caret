// The slow runner's loop (brief R1), apart from processes and files so tests drive it on a fake clock
// (test/slow-eval.test.ts). scripts/slow-eval.ts gives it the real ones.
//
// Each set runs in passes. A pass is one run of the set's eval, with the replay cache and the slow layer
// (engines/decide/slow.ts) in front of Laya. A pass ends one of three ways:
// - its eval finished: if it sent anything to Laya, the set runs again, so the scored pass is one whose every answer came
//   from the cache. Pacing stretches a page past the helper's two-minute windows (goals/runs.ts ACCEPT_MS and CARRY_MS,
//   protocol.ts LEFT_TAB_MS) and past the evals' own waits (page-loop-eval's 5 s for a carried page's preview), so a pass
//   that waited on Laya can score a wait as a miss; a replayed pass cannot. After MAX_SETTLE such passes the last is
//   scored and marked unsettled;
// - a limit ended it (429, or a transient failure): the runner releases the heavy lease, waits 30 s doubling to 10 min,
//   and runs the set again; the answered requests replay, so the next request sent is the one that met the limit;
// - a stop ended it (cost above 0, a refused gateway answer, auth, billing, the daily cap, HOLD, low disk): the run ends.
// A pass's eval that ends with no report and no stop is a crash: retried after a minute, and after three in a row the set
// is marked failed and the runner goes on to the next.
//
// Neighbours: one Laya runner at a time on this Mac (a lockf lock A1's evals take too), held only while a pass runs; a
// heavy lease only for browser sets, released on every wait and between sets, and taken at least 60 s after the last
// one was released.
import { STOPS, type PassEnd, type SlowClock, type SlowEvent, type SlowStop } from "../src/engines/decide/slow.ts";
import type { SetKind, SetScore } from "./slow-eval-score.ts";

export const BACKOFF_START_MS = 30_000;
export const BACKOFF_MAX_MS = 600_000;
export const LEASE_GAP_MS = 60_000;
export const CRASH_WAIT_MS = 60_000;
export const MAX_CRASHES = 3;
/** Passes that sent requests and finished, before the last is scored unsettled. */
export const MAX_SETTLE = 4;
/** How often the runner checks HOLD and disk while a pass runs. */
export const POLL_MS = 5000;

export function backoffMs(step: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** step);
}

export interface EvalSet {
  id: string;
  title: string;
  kind: SetKind;
  /** Runs Chrome, so it needs the heavy lease. */
  browser: boolean;
  /** A pass running longer is stopped (the heavy lease's TTL is 60 min). */
  timeoutMs: number;
}

export interface SetStatus {
  state: "pending" | "running" | "done" | "failed";
  passes: number;
  /** Passes that finished after sending requests (see MAX_SETTLE). */
  settling: number;
  crashes: number;
  /** Backoff waited for this set's limits. */
  backoffMs: number;
  scoredPass?: number;
  settled?: boolean;
  score?: SetScore;
  error?: string;
  finishedAt?: string;
}

export interface RunnerStatus {
  pid: number;
  startedAt: string;
  updatedAt: string;
  state: "running" | "done" | "stopped";
  stopReason?: string;
  phase: string;
  /** When the current wait ends, if waiting. */
  until?: string;
  current?: { set: string; pass: number };
  backoffStep: number;
  nextAttemptAt: number;
  lastLeaseReleasedAt: number;
  sets: Record<string, SetStatus>;
}

export interface Held {
  release(): Promise<void>;
}

export interface PassHandle {
  done: Promise<{ code: number | null; signal: string | null }>;
  kill(): void;
}

export interface RunnerDeps {
  clock: SlowClock;
  stopCheck(): { reason: "hold" | "disk"; detail: string } | null;
  /** Waits for a heavy lease and holds it; null when the lease wrapper gave up (the runner tries again). */
  lease(): Promise<Held | null>;
  /** The Laya lock if free now, else null. */
  tryLock(): Promise<Held | null>;
  /** Waits for the Laya lock and holds it. */
  lock(): Promise<Held>;
  runPass(set: EvalSet, pass: number, heavy: boolean): PassHandle;
  events(set: EvalSet, pass: number): SlowEvent[];
  reported(set: EvalSet, pass: number): boolean;
  score(set: EvalSet, pass: number): SetScore;
  save(s: RunnerStatus): void;
  say(line: string): void;
  /** A set finished (done or failed): its summary line and the results table. */
  finished(set: EvalSet, st: SetStatus): void;
  /** A stop that must not be restarted from without a person (cost, auth, billing, the cap, a refused answer). */
  markStopped(reason: SlowStop, detail: string): void;
}

export function newStatus(pid: number, now: number, sets: readonly EvalSet[], old: RunnerStatus | null): RunnerStatus {
  const s: RunnerStatus = old === null
    ? { pid, startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), state: "running", phase: "starting", backoffStep: 0, nextAttemptAt: 0, lastLeaseReleasedAt: 0, sets: {} }
    : { ...old, pid, startedAt: new Date(now).toISOString(), state: "running", phase: "resuming" };
  delete s.stopReason;
  for (const set of sets) {
    const x = (s.sets[set.id] ??= { state: "pending", passes: 0, settling: 0, crashes: 0, backoffMs: 0 });
    // A set a killed runner left running resumes: its answered requests are in the cache.
    if (x.state === "running") x.state = "pending";
  }
  return s;
}

/** What one pass's events add up to. */
export function passCounts(ev: readonly SlowEvent[]): { sent: number; ok: number; rejected: number; rate: number; transient: number; paceWaitMs: number; end: Extract<SlowEvent, { t: "end" }> | undefined } {
  let sent = 0;
  let rejected = 0;
  let ok = 0;
  let rate = 0;
  let transient = 0;
  let paceWaitMs = 0;
  for (const e of ev) {
    if (e.t === "sent" || e.t === "answerFailed" || e.t === "rate" || e.t === "transient") {
      sent++;
      paceWaitMs += e.paceWaitMs;
    }
    if (e.t === "sent" || e.t === "answerFailed") ok++;
    if (e.t === "answerFailed") rejected++;
    if (e.t === "rate") rate++;
    if (e.t === "transient") transient++;
  }
  return { sent, ok, rejected, rate, transient, paceWaitMs, end: ev.find((e): e is Extract<SlowEvent, { t: "end" }> => e.t === "end") };
}

export class Runner {
  private heavy: Held | null = null;
  private live: PassHandle | null = null;
  private stopping: string | null = null;
  private readonly sets: readonly EvalSet[];
  private readonly d: RunnerDeps;
  readonly status: RunnerStatus;

  constructor(sets: readonly EvalSet[], d: RunnerDeps, status: RunnerStatus) {
    this.sets = sets;
    this.d = d;
    this.status = status;
  }

  private save(phase: string, until?: number): void {
    this.status.phase = phase;
    if (until === undefined) delete this.status.until;
    else this.status.until = new Date(until).toISOString();
    this.status.updatedAt = new Date(this.d.clock.now()).toISOString();
    this.d.save(this.status);
  }

  private async releaseLease(): Promise<void> {
    if (this.heavy === null) return;
    const h = this.heavy;
    this.heavy = null;
    await h.release();
    this.status.lastLeaseReleasedAt = this.d.clock.now();
    this.d.save(this.status);
  }

  /** Sleeps until `until`, checking HOLD and disk on the way; the stop, if one came. */
  private async waitUntil(until: number, phase: string): Promise<{ reason: "hold" | "disk"; detail: string } | null> {
    this.save(phase, until);
    for (;;) {
      if (this.stopping !== null) return null;
      const stop = this.d.stopCheck();
      if (stop !== null) return stop;
      const left = until - this.d.clock.now();
      if (left <= 0) return null;
      await this.d.clock.sleep(Math.min(left, POLL_MS));
    }
  }

  private async stop(reason: string, detail: string): Promise<"stopped"> {
    await this.releaseLease();
    this.status.state = "stopped";
    this.status.stopReason = `${reason}: ${detail}`;
    delete this.status.current;
    this.save("stopped");
    if ((STOPS as readonly string[]).includes(reason) && reason !== "hold" && reason !== "disk") this.d.markStopped(reason as SlowStop, detail);
    this.d.say(`STOPPED ${reason}: ${detail}`);
    return "stopped";
  }

  /** Ends the run from outside (a signal): the pass running is stopped and nothing new starts. */
  async interrupt(why: string): Promise<void> {
    this.stopping = why;
    this.live?.kill();
    if (this.live !== null) await this.live.done;
  }

  async run(): Promise<"done" | "stopped"> {
    for (const set of this.sets) {
      const st = this.status.sets[set.id] as SetStatus;
      if (st.state === "done" || st.state === "failed") continue;
      const r = await this.runSet(set, st);
      if (r === "stopped") return "stopped";
    }
    await this.releaseLease();
    delete this.status.current;
    this.status.state = "done";
    this.save("done");
    return "done";
  }

  private async runSet(set: EvalSet, st: SetStatus): Promise<"next" | "stopped"> {
    st.state = "running";
    for (;;) {
      if (this.stopping !== null) return this.stop("signal", this.stopping);
      const pre = this.d.stopCheck();
      if (pre !== null) return this.stop(pre.reason, pre.detail);
      // A limit's wait (kept across restarts): no lease and no Laya lock held through it.
      if (this.status.nextAttemptAt > this.d.clock.now()) {
        await this.releaseLease();
        const stop = await this.waitUntil(this.status.nextAttemptAt, `backoff before ${set.id}`);
        if (stop !== null) return this.stop(stop.reason, stop.detail);
        continue;
      }
      let lock = await this.d.tryLock();
      if (lock === null) {
        // Another Laya runner has it (A1's evals): wait for it without holding a lease.
        await this.releaseLease();
        this.save(`waiting for the Laya lock (${set.id})`);
        lock = await this.d.lock();
      }
      if (!set.browser) await this.releaseLease();
      else if (this.heavy === null) {
        const gap = await this.waitUntil(this.status.lastLeaseReleasedAt + LEASE_GAP_MS, `60 s after the last heavy lease (${set.id})`);
        if (gap !== null) {
          await lock.release();
          return this.stop(gap.reason, gap.detail);
        }
        this.save(`waiting for a heavy lease (${set.id})`);
        this.heavy = await this.d.lease();
        if (this.heavy === null) {
          await lock.release();
          continue;
        }
      }
      st.passes++;
      const pass = st.passes;
      this.status.current = { set: set.id, pass };
      this.save(`running ${set.id} pass ${pass}`);
      const started = this.d.clock.now();
      const h = this.d.runPass(set, pass, this.heavy !== null);
      this.live = h;
      const exit: { x: { code: number | null; signal: string | null } | null } = { x: null };
      let timedOut = false;
      let stopped: { reason: string; detail: string } | null = null;
      void h.done.then((x) => (exit.x = x));
      for (;;) {
        await Promise.race([h.done, this.d.clock.sleep(POLL_MS)]);
        if (exit.x !== null) break;
        const stop = this.d.stopCheck();
        if (stop !== null || this.stopping !== null) {
          stopped = stop ?? { reason: "signal", detail: String(this.stopping) };
          h.kill();
          await h.done;
          break;
        }
        if (this.d.clock.now() - started > set.timeoutMs) {
          timedOut = true;
          h.kill();
          await h.done;
          break;
        }
      }
      this.live = null;
      await lock.release();
      const c = passCounts(this.d.events(set, pass));
      if (stopped !== null) return this.stop(stopped.reason, stopped.detail);
      if (c.end !== undefined && (STOPS as readonly string[]).includes(c.end.reason)) return this.stop(c.end.reason, c.end.detail);
      if (c.ok > 0) this.status.backoffStep = 0;
      if (c.end?.reason === "rate" || c.end?.reason === "transient") {
        const wait = backoffMs(this.status.backoffStep);
        this.status.backoffStep++;
        this.status.nextAttemptAt = this.d.clock.now() + wait;
        st.backoffMs += wait;
        this.d.say(`${set.id} pass ${pass}: ${c.end.reason === "rate" ? "429" : `transient failure (${c.end.detail})`} after ${c.ok} answered; waiting ${Math.round(wait / 1000)} s, then the same request`);
        await this.releaseLease();
        this.d.save(this.status);
        continue;
      }
      if (!this.d.reported(set, pass)) {
        if (timedOut && c.ok > 0) {
          this.d.say(`${set.id} pass ${pass}: stopped after ${Math.round(set.timeoutMs / 60_000)} min with ${c.ok} new answers; the next pass replays them`);
          continue;
        }
        st.crashes++;
        const why = timedOut ? `no report after ${Math.round(set.timeoutMs / 60_000)} min` : `exit ${exit.x?.code ?? exit.x?.signal ?? "?"} with no report`;
        this.d.say(`${set.id} pass ${pass}: ${why} (crash ${st.crashes} of ${MAX_CRASHES})`);
        if (st.crashes >= MAX_CRASHES) {
          st.state = "failed";
          st.error = why;
          st.finishedAt = new Date(this.d.clock.now()).toISOString();
          await this.releaseLease();
          this.d.finished(set, st);
          this.save(`${set.id} failed`);
          return "next";
        }
        await this.releaseLease();
        const stop = await this.waitUntil(this.d.clock.now() + CRASH_WAIT_MS, `after a crash in ${set.id}`);
        if (stop !== null) return this.stop(stop.reason, stop.detail);
        continue;
      }
      st.crashes = 0;
      if (c.ok > 0 && st.settling < MAX_SETTLE) {
        st.settling++;
        this.d.say(`${set.id} pass ${pass}: finished with ${c.ok} new answers; running it again from the cache to score`);
        continue;
      }
      st.state = "done";
      st.scoredPass = pass;
      st.settled = c.ok === 0;
      st.score = this.d.score(set, pass);
      st.finishedAt = new Date(this.d.clock.now()).toISOString();
      delete this.status.current;
      await this.releaseLease();
      this.save(`${set.id} done`);
      this.d.finished(set, st);
      return "next";
    }
  }
}
