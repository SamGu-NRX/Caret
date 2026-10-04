// The persisted store. It holds counts, keyed hashes, matched transfers described by hashes and
// metadata, and the times of the last hour's offers. Plain screen text never reaches it; the rolling
// text window is memory only.
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface TransferRow {
  at: number;
  valueHash: string;
  kind: string | null;
  length: number;
  match: "exact" | "normalized";
  srcBundle: string;
  srcWindowKind: string;
  srcKeyHash: string;
  dstBundle: string;
  dstWindowKind: string;
  dstKeyHash: string;
  /** Time between the source value first appearing and the destination change. */
  ageMs: number;
  attribution: "user" | "unknown" | "caret";
}

export interface ShadowRow {
  at: number;
  trigger: "focus" | "appSwitch";
  dstBundle: string;
  dstKeyHash: string;
  enteredLength: number;
  enteredHash: string;
  /** Whether the entered value existed in another readable window in the previous ten minutes. */
  existed: "exact" | "normalized" | "no";
  srcBundle: string | null;
  srcKeyHash: string | null;
  srcAgeMs: number | null;
  kind: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counts (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, metric)
);
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  value_hash TEXT NOT NULL,
  kind TEXT,
  length INTEGER NOT NULL,
  match TEXT NOT NULL,
  src_bundle TEXT NOT NULL,
  src_window_kind TEXT NOT NULL,
  src_key_hash TEXT NOT NULL,
  dst_bundle TEXT NOT NULL,
  dst_window_kind TEXT NOT NULL,
  dst_key_hash TEXT NOT NULL,
  age_ms INTEGER NOT NULL,
  attribution TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shadow_episodes (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  dst_bundle TEXT NOT NULL,
  dst_key_hash TEXT NOT NULL,
  entered_length INTEGER NOT NULL,
  entered_hash TEXT NOT NULL,
  existed TEXT NOT NULL,
  src_bundle TEXT,
  src_key_hash TEXT,
  src_age_ms INTEGER,
  kind TEXT
);
CREATE TABLE IF NOT EXISTS offer_budget (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL
);
`;

const HOUR_MS = 60 * 60 * 1000;

export class Store {
  private readonly db: DatabaseSync;
  private readonly salt: Buffer;
  private pending = new Map<string, number>();
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.salt = loadSalt(join(dir, "salt"));
    const dbPath = join(dir, "screen.sqlite");
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  /** Keyed hash, so values cannot be recovered from the store by hashing guesses without the local salt. */
  hash(text: string): string {
    return createHmac("sha256", this.salt).update(text).digest("hex").slice(0, 16);
  }

  count(metric: string, n = 1, at = Date.now()): void {
    const k = `${localDay(at)}\u0000${metric}`;
    this.pending.set(k, (this.pending.get(k) ?? 0) + n);
  }

  /** Writes buffered counts. Counts are buffered because snapshots arrive several times a second. */
  flush(): void {
    if (this.pending.size === 0) return;
    const stmt = this.db.prepare(
      "INSERT INTO counts (day, metric, n) VALUES (?, ?, ?) ON CONFLICT(day, metric) DO UPDATE SET n = n + excluded.n",
    );
    this.db.exec("BEGIN");
    try {
      for (const [k, n] of this.pending) {
        const [day, metric] = k.split("\u0000") as [string, string];
        stmt.run(day, metric, n);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.pending = new Map();
  }

  /** Returns the row id, so a later fillResult can re-attribute or remove the row. */
  addTransfer(t: TransferRow): number {
    return Number(this.db
      .prepare(
        `INSERT INTO transfers (at, value_hash, kind, length, match, src_bundle, src_window_kind, src_key_hash,
           dst_bundle, dst_window_kind, dst_key_hash, age_ms, attribution) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(t.at, t.valueHash, t.kind, t.length, t.match, t.srcBundle, t.srcWindowKind, t.srcKeyHash, t.dstBundle, t.dstWindowKind, t.dstKeyHash, t.ageMs, t.attribution)
      .lastInsertRowid);
  }

  setAttribution(id: number, attribution: TransferRow["attribution"]): void {
    this.db.prepare("UPDATE transfers SET attribution = ? WHERE id = ?").run(attribution, id);
  }

  removeTransfer(id: number): void {
    this.db.prepare("DELETE FROM transfers WHERE id = ?").run(id);
  }

  addShadow(r: ShadowRow): void {
    this.db
      .prepare(
        `INSERT INTO shadow_episodes (at, trigger, dst_bundle, dst_key_hash, entered_length, entered_hash, existed,
           src_bundle, src_key_hash, src_age_ms, kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(r.at, r.trigger, r.dstBundle, r.dstKeyHash, r.enteredLength, r.enteredHash, r.existed, r.srcBundle, r.srcKeyHash, r.srcAgeMs, r.kind);
  }

  /**
   * Records that an offer counted against the hourly budget was shown at `at` (settings.ts), and drops
   * the ones over an hour older than it. Only the time is kept: no offer text, key or window. Written at
   * once rather than buffered like counts, so a crash cannot lose one; the budget itself bounds these
   * writes to a few an hour.
   */
  recordOffer(at: number): void {
    this.db.prepare("INSERT INTO offer_budget (at) VALUES (?)").run(at);
    this.db.prepare("DELETE FROM offer_budget WHERE at <= ?").run(at - HOUR_MS);
  }

  /** The times recordOffer kept, oldest first. */
  offerTimes(): number[] {
    return (this.db.prepare("SELECT at FROM offer_budget ORDER BY at, id").all() as { at: number }[]).map((r) => Number(r.at));
  }

  counts(day?: string): Record<string, number> {
    const rows = (day === undefined
      ? this.db.prepare("SELECT metric, SUM(n) AS n FROM counts GROUP BY metric").all()
      : this.db.prepare("SELECT metric, n FROM counts WHERE day = ?").all(day)) as { metric: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.metric, Number(r.n)]));
  }

  transfers(): TransferRow[] {
    return readTransfers(this.db);
  }

  shadowEpisodes(): ShadowRow[] {
    return readShadowEpisodes(this.db);
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}

/** Rows of a store's transfers table, also for reading a copy of the store without opening it as a Store. */
export function readTransfers(db: DatabaseSync): TransferRow[] {
  return (db.prepare("SELECT * FROM transfers ORDER BY id").all() as Record<string, unknown>[]).map((r) => ({
    at: Number(r.at),
    valueHash: String(r.value_hash),
    kind: r.kind === null ? null : String(r.kind),
    length: Number(r.length),
    match: r.match as TransferRow["match"],
    srcBundle: String(r.src_bundle),
    srcWindowKind: String(r.src_window_kind),
    srcKeyHash: String(r.src_key_hash),
    dstBundle: String(r.dst_bundle),
    dstWindowKind: String(r.dst_window_kind),
    dstKeyHash: String(r.dst_key_hash),
    ageMs: Number(r.age_ms),
    attribution: r.attribution as TransferRow["attribution"],
  }));
}

export function readShadowEpisodes(db: DatabaseSync): ShadowRow[] {
  return (db.prepare("SELECT * FROM shadow_episodes ORDER BY id").all() as Record<string, unknown>[]).map((r) => ({
    at: Number(r.at),
    trigger: r.trigger as ShadowRow["trigger"],
    dstBundle: String(r.dst_bundle),
    dstKeyHash: String(r.dst_key_hash),
    enteredLength: Number(r.entered_length),
    enteredHash: String(r.entered_hash),
    existed: r.existed as ShadowRow["existed"],
    srcBundle: r.src_bundle === null ? null : String(r.src_bundle),
    srcKeyHash: r.src_key_hash === null ? null : String(r.src_key_hash),
    srcAgeMs: r.src_age_ms === null ? null : Number(r.src_age_ms),
    kind: r.kind === null ? null : String(r.kind),
  }));
}

function loadSalt(path: string): Buffer {
  if (existsSync(path)) {
    const b = readFileSync(path);
    if (b.length !== 32) throw new Error(`salt file ${path} is ${b.length} bytes, expected 32; refusing to hash with it`);
    return b;
  }
  const b = randomBytes(32);
  writeFileSync(path, b, { mode: 0o600 });
  chmodSync(path, 0o600);
  return b;
}

function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
