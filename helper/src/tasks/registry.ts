// The task registry: one record per piece of Caret's work (executor runs, loop finishes and routines
// offered, pending-state watches), with the state the activity view shows. Every transition, and
// every step change of a running task, is published as an `activity` message with a rising sequence
// number, and kept in a bounded buffer so a consumer that reconnects can ask for what it missed.
// Records live in memory only: they hold window titles and status lines.
import { PROTOCOL_VERSION, type Activity, type ActivityReply, type ActivityRequest, type TaskRecord, type TaskState } from "../protocol.ts";

/** Activity messages kept for `since` requests. No measurement behind the number. */
const MAX_EVENTS = 1000;
/** A finished record stays listed this long, for "Done today". */
const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;
/**
 * The most an activityReply's records or events may take as JSON, in UTF-8 bytes. The host drops lines
 * over 4 MiB without an error (A4); this stays under 1 MiB with room for the envelope.
 */
export const MAX_REPLY_BYTES = 1024 * 1024 - 4096;

export const FINISHED: ReadonlySet<TaskState> = new Set(["done", "failed", "undone"]);

/** Moves the registry rejects: nothing leaves a finished state except a finished run's undo. */
function allowed(from: TaskState, to: TaskState): boolean {
  if (from === to) return true;
  if (from === "undone") return false;
  if (from === "done" || from === "failed") return to === "undone";
  return true;
}

export class TransitionError extends Error {}

export class TaskRegistry {
  private readonly records = new Map<string, TaskRecord>();
  private readonly events: Activity[] = [];
  private seq = 0;
  private readonly publish: (m: Activity) => void;
  private readonly now: () => number;

  private readonly maxReplyBytes: number;

  constructor(publish: (m: Activity) => void, now: () => number = Date.now, maxReplyBytes = MAX_REPLY_BYTES) {
    this.publish = publish;
    this.now = now;
    this.maxReplyBytes = maxReplyBytes;
  }

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  get latestSeq(): number {
    return this.seq;
  }

  /** Adds a record and publishes it. An id already in use is an error: task ids name one piece of work. */
  create(r: Omit<TaskRecord, "startedAt" | "updatedAt">): TaskRecord {
    if (this.records.has(r.id)) throw new TransitionError(`task ${r.id} already exists`);
    const at = this.now();
    const rec: TaskRecord = { ...r, startedAt: at, updatedAt: at };
    this.records.set(rec.id, rec);
    this.emit(null, rec, at);
    return rec;
  }

  /**
   * Applies a change and publishes it when anything the activity view shows changed. Returns the
   * record, or throws when the record is unknown or the move leaves a finished state.
   */
  update(id: string, patch: Partial<Omit<TaskRecord, "id" | "kind" | "startedAt" | "updatedAt">>): TaskRecord {
    const old = this.records.get(id);
    if (old === undefined) throw new TransitionError(`no task ${id}`);
    const to = patch.state ?? old.state;
    if (!allowed(old.state, to)) throw new TransitionError(`task ${id} is ${old.state}; it cannot become ${to}`);
    const next: TaskRecord = { ...old, ...patch };
    if (sameShown(old, next)) return old;
    const at = this.now();
    next.updatedAt = at;
    this.records.set(id, next);
    this.emit(old.state, next, at);
    return next;
  }

  /** Every record, newest change first. */
  list(): TaskRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * `list` gives records newest first and `since` events oldest first, each until the next one would
   * pass maxReplyBytes. `truncated` says the reply is incomplete: records were left out, or events after
   * `since` were dropped from the buffer or left out, in which case the consumer lists instead.
   */
  answer(m: ActivityRequest): ActivityReply {
    const base: ActivityReply = { type: "activityReply", v: PROTOCOL_VERSION, requestId: m.requestId, error: null, seq: this.seq, tasks: [], events: [], truncated: false };
    if (m.op === "list") {
      const all = this.list();
      const tasks = this.fit(all);
      return { ...base, tasks, truncated: tasks.length < all.length };
    }
    if (m.since === undefined) return { ...base, error: "since needs a `since` sequence number" };
    if (m.since > this.seq) return { ...base, error: `since ${m.since} is past the latest sequence number ${this.seq}` };
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    const since = m.since;
    const after = this.events.filter((e) => e.seq > since);
    const events = this.fit(after);
    return { ...base, events, truncated: since + 1 < oldest || events.length < after.length };
  }

  /** The longest prefix of `items` whose JSON, with a comma between items, fits maxReplyBytes. */
  private fit<T>(items: readonly T[]): T[] {
    let bytes = 0;
    let n = 0;
    for (const item of items) {
      bytes += Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
      if (bytes > this.maxReplyBytes) break;
      n++;
    }
    return items.slice(0, n);
  }

  /** Forgets finished records older than a day. */
  prune(now = this.now()): void {
    for (const [id, r] of this.records) if (FINISHED.has(r.state) && now - r.updatedAt > KEEP_FINISHED_MS) this.records.delete(id);
  }

  private emit(from: TaskState | null, task: TaskRecord, at: number): void {
    const m: Activity = { type: "activity", v: PROTOCOL_VERSION, seq: ++this.seq, at, from, task: structuredClone(task) };
    this.events.push(m);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.publish(m);
  }
}

/** Equal in everything but the update time, so a repeated report publishes nothing. */
function sameShown(a: TaskRecord, b: TaskRecord): boolean {
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
}
