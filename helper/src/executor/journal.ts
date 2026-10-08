// The recovery journal (B23, S1 audit #11). Before B23 a task's undo ledger lived only in the executor's memory,
// so a helper that crashed after a run's first write lost the undo for it, while a skill that ran with no Tab
// stayed promoted. Now the executor saves the task here, synchronously, before every write, press and calendar
// add (with what it is about to do) and after each one lands (with the ledger entry). A row stays while the run
// is under way or paused and is dropped when the run ends or its undo finishes. At start, every row left is a run
// a crash interrupted: the helper puts its skill back on Tab, lists it as stopped, and offers undo for what the
// row says it wrote (helper.ts recoverInterrupted).
//
// Rows hold field values and the plan, so each is sealed with AES-256-GCM under the memory key (sealed.ts), in
// recovery.sqlite beside the memory store. Writes are one statement each in WAL mode. The skill a row's run counts for
// is also kept in the clear (a skill id, no value), so a row that has expired or cannot be opened still puts its skill
// back on Tab (B23 review).
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as z from "zod";
import { AppRef, Frame } from "../protocol.ts";
import { loadKey, open, seal } from "../sealed.ts";
import { Plan } from "./schema.ts";
import { assertLocalStorePath } from "../privacy/store-path.ts";

const step = z.number().int().nonnegative();

/**
 * One undo ledger entry. A write records the value it replaced and the mark under which the reader keeps the
 * element it wrote (null when none was recorded: such a write is never restored). `after` is always the value Caret
 * meant to write, never a later read (B29). `unconfirmed`: a fault, missing read-back or partial result left the
 * write unverified. `partialWrite`: a read found a proper prefix of the intended whole-field replacement;
 * guarded undo may restore it under S1's rule. `mayIncludeInput`: an unrecognized read-back may hold the user's
 * typing, and undo refuses it. A calendar entry's `eventId` is null for an add whose answer the crash lost; undo then
 * looks the event up by its slot.
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
    /** A read found a non-empty proper prefix of the intended whole-field replacement (S1). */
    partialWrite: z.literal(true).optional(),
    mayIncludeInput: z.literal(true).optional(),
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
  /**
   * Every write entry's `after` is the value Caret meant to write (B29). A row without it was saved before B29, when a
   * native write could keep its read-back, the user's keystroke included; recovery then refuses the undo of its writes.
   */
  afterIntended: z.literal(true).optional(),
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
    // Held to the store path policy before anything is made (INT1 review 2); SQLite writes through the file opened here.
    assertLocalStorePath(dir);
    assertLocalStorePath(join(dir, "recovery.sqlite"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.key = loadKey(join(dir, "memory.key"));
    const path = join(dir, "recovery.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS journal (task_id TEXT PRIMARY KEY, saved_at INTEGER NOT NULL, sealed BLOB NOT NULL, skill_id TEXT)");
    const columns = this.db.prepare("PRAGMA table_info(journal)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "skill_id")) this.db.exec("ALTER TABLE journal ADD COLUMN skill_id TEXT");
    this.put = this.db.prepare("INSERT OR REPLACE INTO journal (task_id, saved_at, sealed, skill_id) VALUES (?, ?, ?, ?)");
    this.del = this.db.prepare("DELETE FROM journal WHERE task_id = ?");
  }

  save(r: JournalRecord): void {
    this.put.run(r.taskId, r.savedAt, seal(this.key, JSON.stringify(JournalRecord.parse(r))), r.skillId);
  }

  drop(taskId: string): void {
    this.del.run(taskId);
  }

  /**
   * Every row a run left, oldest first. Nothing is deleted here: the caller demotes `skills` first and then calls
   * pruneExpired, so a crash between the two loses no marker (B23 second review).
   * - `skills`: the skill of every row, expired and unreadable ones included, from the clear column, or for a row
   *   written before that column, from the sealed record. All go back on Tab.
   * - `unknownSkill`: some row that cannot be opened was written before the column, so its skill is unknown; the
   *   caller puts every skill that runs on its own back on Tab.
   * - `records`: the rows younger than JOURNAL_KEEP_MS that open, whose runs are offered for undo.
   * - `unreadable`: rows that do not open or parse; they stay for inspection.
   */
  load(now: number): { records: JournalRecord[]; unreadable: string[]; skills: string[]; unknownSkill: boolean } {
    const all = this.db.prepare("SELECT task_id, saved_at, sealed, skill_id FROM journal ORDER BY saved_at").all() as { task_id: string; saved_at: number; sealed: Uint8Array; skill_id: string | null }[];
    const skills = new Set<string>();
    const records: JournalRecord[] = [];
    const unreadable: string[] = [];
    let unknownSkill = false;
    for (const row of all) {
      if (row.skill_id !== null) skills.add(row.skill_id);
      let r: JournalRecord | null = null;
      try {
        r = JournalRecord.parse(JSON.parse(open(this.key, Buffer.from(row.sealed))));
      } catch {
        unreadable.push(row.task_id);
        if (row.skill_id === null) unknownSkill = true;
      }
      if (r === null) continue;
      if (r.skillId !== null) skills.add(r.skillId);
      if (Number(row.saved_at) >= now - JOURNAL_KEEP_MS) records.push(r);
    }
    return { records, unreadable, skills: [...skills], unknownSkill };
  }

  /** Deletes rows older than JOURNAL_KEEP_MS; called once their skills have been put back on Tab. */
  pruneExpired(now: number): void {
    this.db.prepare("DELETE FROM journal WHERE saved_at < ?").run(now - JOURNAL_KEEP_MS);
  }

  /** The raw rows, for tests that check nothing is stored in the clear. */
  rawRows(): { task_id: string; sealed: Uint8Array }[] {
    return this.db.prepare("SELECT task_id, sealed FROM journal").all() as { task_id: string; sealed: Uint8Array }[];
  }

  close(): void {
    this.db.close();
  }
}
