// Decisions evaluations have a lifetime budget, not Jev's daily budget. Unknown billing keeps its reservation:
// a timeout or crash is not evidence that OpenAI charged nothing. A documented usage count settles a hold, and so does
// a documented error reply with no usage (the request was refused before any input was processed).
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import * as z from "zod";
import { ENV, processEnv, type HostEnv } from "../../host-env.ts";
import { assertLocalStorePath, writeLocalFile } from "../../privacy/store-path.ts";
import { SPEND_DIR } from "./daily-cap.ts";

/**
 * Chosen by the lead for the whole comparison across days and processes; not tuned. The ledger holds Decisions
 * requests only, so this total is also the provider cap (the separate $0.20 provider cap was dropped, 2026-10-09).
 */
export const DECISIONS_TOTAL_CAP_USD = 0.50;
/** Chosen by the lead for probes within the same lifetime total; not tuned. */
export const DECISIONS_PROBE_CAP_USD = 0.10;
/** Official Decisions guide: $0.10 per million input tokens, no output or cache charges. */
export const DECISIONS_USD_PER_TOKEN = 0.10 / 1_000_000;
/** Chosen by the lead because the multiplier boundary is unconfirmed; largest observed fill is about 47K. */
export const DECISIONS_MAX_ESTIMATED_TOKENS = 200_000;

export type DecisionsKeySource = "org" | "personal";

const Lock = z.object({ pid: z.number().int().positive(), startedAt: z.string(), id: z.string() }).strict();
const Row = z.discriminatedUnion("type", [
  z.object({ provider: z.literal("openai-decisions"), type: z.literal("reserve"), id: z.string(), probe: z.boolean(), usd: z.number().finite().nonnegative(), at: z.string(), key: z.enum(["org", "personal"]).optional() }).strict(),
  z.object({ provider: z.literal("openai-decisions"), type: z.literal("settle"), id: z.string(), usd: z.number().finite().nonnegative(), tokens: z.number().int().nonnegative(), at: z.string(), status: z.number().int().optional() }).strict(),
]);

export class DecisionsBudgetError extends Error {
  readonly kind = "cap" as const;
  constructor(message: string) { super(message); this.name = "DecisionsBudgetError"; }
}

export interface DecisionsSpendOptions {
  dir: string;
  /** Test seams may lower, never raise, the authorized limits. */
  totalCapUsd?: number;
  probeCapUsd?: number;
  /**
   * This process's own ceiling (--max-usd). It counts every attempt's hold, retries and the key fallback included, and an
   * unsettled hold at its full reserved amount.
   */
  runCapUsd?: number;
}

export interface DecisionsHold {
  readonly reservedTokens: number;
  /** Settles at the billed input tokens; throws DecisionsBudgetError (after recording) when billing exceeded the hold. */
  settle: (tokens: number) => number;
  /** Settles at $0 for a documented error reply that carries no usage. */
  settleRejected: (status: number) => void;
}

export interface DecisionsRunSpend {
  /** Settled holds at their billed amount plus unsettled holds at their reserved amount. */
  usd: number;
  billedUsd: number;
  unsettledUsd: number;
  holds: number;
}

export class DecisionsSpend {
  private folder: string | null = null;
  private lockId: string | null = null;
  private blocked = false;
  private readonly caps: { total: number; probe: number; run: number };
  private readonly options: DecisionsSpendOptions;
  private readonly mine = new Map<string, { usd: number; settled: boolean }>();
  constructor(options: DecisionsSpendOptions) {
    this.options = options;
    const lower = (value: number | undefined, maximum: number): number => {
      const cap = value ?? maximum;
      if (!Number.isFinite(cap) || cap <= 0 || cap > maximum) throw new Error("Decisions budget limits must be positive and no higher than the authorized caps");
      return cap;
    };
    this.caps = { total: lower(options.totalCapUsd, DECISIONS_TOTAL_CAP_USD), probe: lower(options.probeCapUsd, DECISIONS_PROBE_CAP_USD), run: lower(options.runCapUsd, DECISIONS_TOTAL_CAP_USD) };
  }
  static fromEnv(env: HostEnv = processEnv(), runCapUsd?: number): DecisionsSpend {
    const dir = env[ENV.caret_decisions_spend_dir];
    // Keep Decisions separate from Jev but beside it unless the harness supplies a dedicated local directory.
    return new DecisionsSpend({ dir: dir || join(dirname(env[ENV.caret_jev_spend_dir] || SPEND_DIR), "decisions-spend"), ...(runCapUsd === undefined ? {} : { runCapUsd }) });
  }
  private root(): string {
    this.folder ??= dirname(assertLocalStorePath(`${this.options.dir}/comparison.ndjson`));
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    return this.folder;
  }
  private acquire(): void {
    if (this.lockId !== null) return;
    const lock = join(this.root(), "run.lock");
    const take = (): void => {
      const id = randomUUID();
      writeLocalFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), id }), { exclusive: true, mode: 0o600 });
      this.lockId = id;
      process.once("exit", this.onExit);
    };
    try { take(); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    // Serialize stale-lock reclamation too: two starters must never unlink a newly acquired live lock.
    // An interrupted reclaimer fails closed; its cleanup lock is never removed automatically.
    const cleanup = join(this.root(), "reclaim.lock");
    try { writeLocalFile(cleanup, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { exclusive: true, mode: 0o600 }); }
    catch { throw new Error("Decisions run lock is being checked, or a prior lock cleanup was interrupted; no request was sent"); }
    try {
      let held: z.infer<typeof Lock>;
      try { held = Lock.parse(JSON.parse(readFileSync(lock, "utf8"))); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") { take(); return; }
        throw new Error("Decisions run lock is malformed; no request was sent");
      }
      let dead = false;
      try { process.kill(held.pid, 0); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") dead = true; }
      if (!dead) throw new Error("Another live run holds the Decisions comparison lock; no request was sent");
      unlinkSync(lock);
      take();
    } finally { unlinkSync(cleanup); }
  }
  private readonly onExit = (): void => { this.close(); };
  close(): void {
    if (this.lockId === null) return;
    const lock = join(this.root(), "run.lock");
    const held = Lock.parse(JSON.parse(readFileSync(lock, "utf8")));
    if (held.id !== this.lockId || held.pid !== process.pid) throw new Error("Decisions run lock ownership changed; refusing to remove it");
    unlinkSync(lock);
    this.lockId = null;
    process.removeListener("exit", this.onExit);
  }
  private append(row: z.infer<typeof Row>): void {
    const file = join(this.root(), "comparison.ndjson");
    writeLocalFile(file, `${JSON.stringify(row)}\n`, { append: true, mode: 0o600 });
  }
  private amounts(): { total: number; probe: number } {
    let text: string;
    try { text = readFileSync(join(this.root(), "comparison.ndjson"), "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { total: 0, probe: 0 }; throw e; }
    if (text !== "" && !text.endsWith("\n")) throw new Error("Decisions spend file has an incomplete record; no request was sent");
    const holds = new Map<string, { usd: number; probe: boolean; settled: boolean }>();
    for (const line of text.split("\n").filter(Boolean)) {
      let json: unknown;
      try { json = JSON.parse(line); }
      catch { throw new Error("Decisions spend file has malformed JSON; no request was sent"); }
      const row = Row.safeParse(json);
      if (!row.success) throw new Error("Decisions spend file has an invalid record; no request was sent");
      const r = row.data;
      if (r.type === "reserve") {
        if (holds.has(r.id)) throw new Error("Decisions spend file repeats a reservation");
        holds.set(r.id, { usd: r.usd, probe: r.probe, settled: false });
      } else {
        const hold = holds.get(r.id);
        if (hold === undefined || hold.settled) throw new Error("Decisions spend file settles a missing or closed reservation");
        hold.usd = r.usd; hold.settled = true;
      }
    }
    return [...holds.values()].reduce((s, h) => ({ total: s.total + h.usd, probe: s.probe + (h.probe ? h.usd : 0) }), { total: 0, probe: 0 });
  }
  /** What this process has spent or still holds (DecisionsRunSpend). */
  run(): DecisionsRunSpend {
    let billed = 0; let open = 0;
    for (const h of this.mine.values()) { if (h.settled) billed += h.usd; else open += h.usd; }
    return { usd: billed + open, billedUsd: billed, unsettledUsd: open, holds: this.mine.size };
  }
  /**
   * Reserves `tokens` of input before one HTTP attempt. Callers pass an upper bound on what the attempt can bill (the
   * body's UTF-8 bytes plus a framing allowance per question); the default is the admitted ceiling.
   */
  reserve(probe = false, tokens: number = DECISIONS_MAX_ESTIMATED_TOKENS, key?: DecisionsKeySource): DecisionsHold {
    if (this.blocked) throw new DecisionsBudgetError("Decisions comparison is blocked for this process after reaching a cap");
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > DECISIONS_MAX_ESTIMATED_TOKENS) throw new Error("Decisions reservation must be a positive token count within the admitted ceiling");
    this.acquire();
    const spent = this.amounts();
    const usd = tokens * DECISIONS_USD_PER_TOKEN;
    if (spent.total + usd > this.caps.total || (probe && spent.probe + usd > this.caps.probe) || this.run().usd + usd > this.caps.run) {
      this.blocked = true;
      throw new DecisionsBudgetError("Decisions lifetime, probe, or per-run cap would be exceeded; no request was sent");
    }
    const id = randomUUID();
    this.append({ provider: "openai-decisions", type: "reserve", id, probe, usd, at: new Date().toISOString(), ...(key === undefined ? {} : { key }) });
    const own = { usd, settled: false };
    this.mine.set(id, own);
    let settled = false;
    const close = (cost: number, tokensBilled: number, status?: number): void => {
      if (settled) throw new Error("Decisions usage must be settled exactly once");
      this.append({ provider: "openai-decisions", type: "settle", id, usd: cost, tokens: tokensBilled, at: new Date().toISOString(), ...(status === undefined ? {} : { status }) });
      settled = true; own.usd = cost; own.settled = true;
    };
    return {
      reservedTokens: tokens,
      settle: (billed) => {
        if (!Number.isSafeInteger(billed) || billed < 0) throw new Error("Decisions usage must be a nonnegative integer and settled exactly once");
        const cost = billed * DECISIONS_USD_PER_TOKEN;
        close(cost, billed);
        // Billing above the hold means the estimate is not an upper bound: stop rather than keep under-reserving.
        if (billed > tokens) { this.blocked = true; throw new DecisionsBudgetError("Decisions billed input exceeded its reservation; comparison blocked"); }
        return cost;
      },
      settleRejected: (status) => close(0, 0, status),
    };
  }
}
