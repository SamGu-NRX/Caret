// A hard daily dollar cap on Jev (brief J1, part A4). Jev's $5 of credits went in four days (TypeSafe's console,
// Oct 2 to 5: 23,725 requests, 137 M input tokens), so every live Jev call on this Mac now checks one day's total
// before it is sent and adds its cost after. The total is kept per local calendar day in one file that every process
// appends to (the helper, each evaluation script), because the account the cap protects is shared by all of them.
//
// The cap is CARET_JEV_DAILY_CAP, from the environment or the .env file named by CARET_ENV_FILE (where the Jev key
// comes from), in dollars. Without it the cap is DEFAULT_DAILY_CAP_USD. The day's file is in CARET_JEV_SPEND_DIR, or
// SPEND_DIR by default.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The cap when none is configured: $0.50 a day, the lead's development default (brief J1). It is also the shipped
 * helper's default, since nothing else is configured yet. R3's real-day replay put routed Caret on Sam's own day at
 * most $0.0033 an active hour (evidence/screen/r3/day-replay-final.md), so ordinary use stays far under it; the
 * evaluation runs are what reached $5.
 */
export const DEFAULT_DAILY_CAP_USD = 0.5;
export const SPEND_DIR = join(homedir(), "Library", "Application Support", "CaretV2", "jev-spend");
const CAP_VAR = "CARET_JEV_DAILY_CAP";

/**
 * Body characters per Jev input token, low on purpose: a reservation (DailySpend.reserve) should overestimate a
 * request. Measured: 3.39 characters per billed token, the median of 28 page-and-stage matches between a fill
 * request's body and the tokens live Jev billed for it (evidence/screen/j1, probe/fill-base.ndjson against
 * p1/loop-live); the lowest of the 28 was 1.15, from one page whose request changed between the runs.
 */
const CHARS_PER_TOKEN = 3;

/** A Jev request refused before it was sent, because the day's spend has reached the cap. */
export class JevCapError extends Error {
  readonly kind = "cap" as const;
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly day: string;
  constructor(capUsd: number, spentUsd: number, day: string) {
    super(`Jev's daily cap is ${usd(capUsd)} (${CAP_VAR}) and ${usd(spentUsd)} is spent or in flight on ${day}; the request was not sent`);
    this.name = "JevCapError";
    this.capUsd = capUsd;
    this.spentUsd = spentUsd;
    this.day = day;
  }
}

/** Dollars as a person reads them: cents, or four places under a cent. */
export function usd(x: number): string {
  return Math.abs(x) >= 0.01 || x === 0 ? `$${x.toFixed(2)}` : `$${x.toFixed(4)}`;
}

/** The local calendar day of `d`, as YYYY-MM-DD. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The cap the environment configures, in dollars. A value that is not a dollar amount above zero fails here, at start. */
export function capFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  let raw = env[CAP_VAR];
  const file = env.CARET_ENV_FILE;
  if ((raw === undefined || raw === "") && file !== undefined && file !== "") {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?CARET_JEV_DAILY_CAP\s*=\s*(.*)\s*$/.exec(line);
      if (m?.[1] !== undefined) raw = m[1].replace(/^(['"])(.*)\1$/, "$2").trim();
    }
  }
  if (raw === undefined || raw === "") return DEFAULT_DAILY_CAP_USD;
  const cap = Number(raw.replace(/^\$/, ""));
  if (!Number.isFinite(cap) || cap <= 0) throw new Error(`${CAP_VAR} is '${raw}'; it must be a dollar amount above 0, such as 0.50`);
  return cap;
}

export interface DailySpendOptions {
  dir: string;
  capUsd: number;
  now?: () => Date;
}

/** One request's hold on the day's budget, from before it is sent until it is answered or fails. */
export interface Reservation {
  /** The request was answered: its real cost goes in the day's file. */
  settle(costUsd: number, inputTokens: number): void;
  /** The request failed: it cost nothing. */
  release(): void;
}

/**
 * The day's Jev spend on this Mac, read from and added to `<dir>/<day>.ndjson`, one line per answered request.
 * Lines are appended with O_APPEND and are far shorter than the size the file system writes whole, so processes never
 * interleave inside a line. Another process's request in flight is not seen until it lands, so several processes that
 * start requests together can pass the cap by those requests' cost (at most about $0.002 for Jev's largest request).
 */
export class DailySpend {
  readonly dir: string;
  readonly capUsd: number;
  private readonly now: () => Date;
  private day = "";
  private offset = 0;
  private landed = 0;
  /** Estimates held by this process's requests in flight, by the day they were reserved on. */
  private readonly inFlight = new Map<string, number>();

  constructor(opts: DailySpendOptions) {
    if (!Number.isFinite(opts.capUsd) || opts.capUsd <= 0) throw new Error(`the daily Jev cap must be above $0, not ${opts.capUsd}`);
    this.dir = opts.dir;
    this.capUsd = opts.capUsd;
    this.now = opts.now ?? (() => new Date());
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): DailySpend {
    const dir = env.CARET_JEV_SPEND_DIR;
    return new DailySpend({ dir: dir === undefined || dir === "" ? SPEND_DIR : dir, capUsd: capFromEnv(env) });
  }

  /** Dollars answered requests cost today, in every process. */
  spent(): number {
    this.catchUp();
    return this.landed;
  }

  /**
   * Holds `estimateUsd` of today's budget for a request about to be sent, or throws JevCapError when the day's spend,
   * this process's requests in flight and the estimate would pass the cap.
   */
  reserve(estimateUsd: number): Reservation {
    this.catchUp();
    const day = this.day;
    const held = this.landed + (this.inFlight.get(day) ?? 0);
    if (held + estimateUsd > this.capUsd) throw new JevCapError(this.capUsd, held, day);
    this.inFlight.set(day, (this.inFlight.get(day) ?? 0) + estimateUsd);
    let open = true;
    const close = (): void => {
      if (!open) throw new Error("a Jev spend reservation was closed twice");
      open = false;
      const left = (this.inFlight.get(day) ?? 0) - estimateUsd;
      if (left > 1e-12) this.inFlight.set(day, left);
      else this.inFlight.delete(day);
    };
    return {
      settle: (costUsd, inputTokens) => {
        close();
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        // The day the request was reserved on, so one sent at 23:59:59 counts against the day that let it through.
        appendFileSync(join(this.dir, `${day}.ndjson`), `${JSON.stringify({ at: this.now().toISOString(), usd: costUsd, tokens: inputTokens, pid: process.pid })}\n`, { mode: 0o600 });
      },
      release: close,
    };
  }

  /** The estimate a reservation holds for a request body of `chars` characters. */
  static estimateUsd(chars: number, usdPerToken: number): number {
    return Math.ceil(chars / CHARS_PER_TOKEN) * usdPerToken;
  }

  /** Reads the lines appended to today's file since the last read; a new day starts from zero. */
  private catchUp(): void {
    const day = localDay(this.now());
    if (day !== this.day) {
      this.day = day;
      this.offset = 0;
      this.landed = 0;
    }
    const path = join(this.dir, `${day}.ndjson`);
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      const text = buf.toString("utf8");
      // Only whole lines; a line still being written is read next time.
      const end = text.lastIndexOf("\n") + 1;
      for (const line of text.slice(0, end).split("\n")) {
        if (line === "") continue;
        const usdSpent = (JSON.parse(line) as { usd?: unknown }).usd;
        if (typeof usdSpent !== "number" || !Number.isFinite(usdSpent) || usdSpent < 0) throw new Error(`${path} has a line without a dollar amount: ${line.slice(0, 120)}`);
        this.landed += usdSpent;
      }
      this.offset += Buffer.byteLength(text.slice(0, end), "utf8");
    } finally {
      closeSync(fd);
    }
  }
}
