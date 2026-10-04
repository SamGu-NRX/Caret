// The recovery journal (B23, S1 audit #11). Before B23 a task's undo ledger lived only in the executor's memory,
// so a helper that crashed after a run's first write lost the undo for it, while a skill that ran with no Tab
// stayed promoted. Now the executor saves the task here, synchronously, before every write, press and calendar
// add (with what it is about to do) and after each one lands (with the ledger entry). A row stays while the run
// is under way or paused and is dropped when the run ends or its undo finishes. At start, every row left is a run
// a crash interrupted: the helper puts its skill back on Tab, lists it as stopped, and offers undo for what the
// row says it wrote (helper.ts recoverInterrupted).
//
// Rows hold field values and the plan, so each is sealed with AES-256-GCM under the memory key (sealed.ts), in
// recovery.sqlite beside the memory store. Writes are one statement each in WAL mode.
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as z from "zod";
import { AppRef, Frame } from "../protocol.ts";
import { loadKey, open, seal } from "../sealed.ts";
import { Plan } from "./schema.ts";

const step = z.number().int().nonnegative();

/**
 * One undo ledger entry. A write records the value it replaced and the mark under which the reader keeps the
 * element it wrote (null when none was recorded: such a write is never restored). `unconfirmed`: the helper
 * stopped while the write was on its way, so it may not have landed. A calendar entry's `eventId` is null for an
 * add whose answer the crash lost; undo then looks the event up by its slot.
 */
export const LedgerEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("write"),
    step,
    pid: z.number().int(),
    windowId: z.string(),
    key: z.string(),
    role: z.string(),
    before: z.string(),
    after: z.string(),
    mark: z.string().min(1).nullable(),
    unconfirmed: z.literal(true).optional(),
  }),
  z.object({ kind: z.literal("calendar"), step, eventId: z.string().min(1).nullable(), calendar: z.string(), title: z.string(), start: z.string(), end: z.string() }),
  z.object({ kind: z.literal("press"), step, label: z.string(), windowId: z.string() }),
]);
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** What the executor is about to dispatch: saved before the reader gets it, so a crash during it is known. */
export const PendingAct = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("write"), step, pid: z.number().int(), windowId: z.string(), key: z.string(), role: z.string(), before: z.string(), value: z.string(), mark: z.string().min(1) }),
  z.object({ kind: z.literal("press"), step, label: z.string(), windowId: z.string() }),
  z.object({ kind: z.literal("calendar"), step, calendar: z.string(), title: z.string(), start: z.string(), end: z.string() }),
]);
export type PendingAct = z.infer<typeof PendingAct>;

export const JournalRecord = z.object({
  taskId: z.string().min(1),
  startedAt: z.number().int(),
  savedAt: z.number().int(),
  /** The plan with its slots filled, as the executor ran it. */
  plan: Plan,
  unprompted: z.boolean(),
  /** Started from an accepted offer, so its undo may hold a grant. */
  granted: z.boolean(),
  /** The reader's launch id when the task last acted (Hello.session); null for an in-process reader. */
  readerId: z.string().nullable(),
  /** The first step not yet verified. */
  next: step,
  ledger: z.array(LedgerEntrySchema),
  pending: PendingAct.nullable(),
  /** The in-progress skill marker: the skill this run counts for, or null. */
  skillId: z.string().min(1).nullable(),
  /** The first window the plan bound, for the activity row. */
  window: z.object({ app: AppRef, windowId: z.string(), title: z.string(), frame: Frame.nullable() }).nullable(),
});
export type JournalRecord = z.infer<typeof JournalRecord>;

/** Rows older than this are dropped at start, as the activity list forgets a finished task after a day (tasks/registry.ts). */
export const JOURNAL_KEEP_MS = 24 * 60 * 60 * 1000;

/** Where the executor saves tasks. The helper adds the skill a run counts for and saves to a RecoveryJournal. */
export interface JournalPort {
  save(r: Omit<JournalRecord, "skillId">): void;
  drop(taskId: string): void;
}

export class RecoveryJournal {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly put: StatementSync;
  private readonly del: StatementSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.key = loadKey(join(dir, "memory.key"));
    const path = join(dir, "recovery.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS journal (task_id TEXT PRIMARY KEY, saved_at INTEGER NOT NULL, sealed BLOB NOT NULL)");
    this.put = this.db.prepare("INSERT OR REPLACE INTO journal (task_id, saved_at, sealed) VALUES (?, ?, ?)");
    this.del = this.db.prepare("DELETE FROM journal WHERE task_id = ?");
  }

  save(r: JournalRecord): void {
    this.put.run(r.taskId, r.savedAt, seal(this.key, JSON.stringify(JournalRecord.parse(r))));
  }

  drop(taskId: string): void {
    this.del.run(taskId);
  }

  /**
   * Every row a run left, oldest first, after dropping rows older than JOURNAL_KEEP_MS. A row that does not
   * open or parse is left in place and named in `unreadable`, so the helper can say so rather than guess.
   */
  load(now: number): { records: JournalRecord[]; unreadable: string[] } {
    this.db.prepare("DELETE FROM journal WHERE saved_at < ?").run(now - JOURNAL_KEEP_MS);
    const rows = this.db.prepare("SELECT task_id, sealed FROM journal ORDER BY saved_at").all() as { task_id: string; sealed: Uint8Array }[];
    const records: JournalRecord[] = [];
    const unreadable: string[] = [];
    for (const row of rows) {
      try {
        records.push(JournalRecord.parse(JSON.parse(open(this.key, Buffer.from(row.sealed)))));
      } catch {
        unreadable.push(row.task_id);
      }
    }
    return { records, unreadable };
  }

  /** The raw rows, for tests that check nothing is stored in the clear. */
  rawRows(): { task_id: string; sealed: Uint8Array }[] {
    return this.db.prepare("SELECT task_id, sealed FROM journal").all() as { task_id: string; sealed: Uint8Array }[];
  }

  close(): void {
    this.db.close();
  }
}
