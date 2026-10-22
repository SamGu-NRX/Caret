// What not to ask again (design CU-COUNSEL-20261009, H4's negative half). An Ask that asks the same question about the
// same form, and is dismissed twice within QUESTION_QUIET_DAYS, stops asking it: the next time it proceeds as an empty
// answer would (a fields question fills only the fields Caret settled beside it) and says it left the rest to the user,
// as before. Answering the question once lifts that.
//
// A question is known by its form, its part and the fields it offers (AskedKey), each already a digest of the redacted
// view (fill/ask-scope.ts fieldFingerprint, planner/ask.ts titleSeen); the table keeps only a keyed hash of the three,
// so it holds no screen text. It lives in the helper's protected memory database (Internal/memory.sqlite), beside the
// gate's decisions and the user's reactions to offers.
import { createHmac } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/** The window a dismissal counts in. Assumed, not measured (design CU-COUNSEL-20261009). */
export const QUESTION_QUIET_DAYS = 7;
/** Dismissals within the window after which a question goes quiet: the design's "dismissed twice". */
export const QUIET_AFTER_DISMISSALS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A question an Ask asked: the form (its redacted title's digest), the part, and the offered fields' fingerprints. */
export interface AskedKey {
  form: string;
  part: string;
  fields: readonly string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS question_memory (
  id INTEGER PRIMARY KEY,
  -- HMAC-SHA256 of the AskedKey under the memory key: never screen text, and not a digest anyone else can recompute.
  question TEXT NOT NULL,
  at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('dismissed', 'answered'))
);
CREATE INDEX IF NOT EXISTS question_memory_question ON question_memory (question, at);
`;

export class QuestionMemory {
  private readonly stmts = new Map<string, StatementSync>();
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(db: DatabaseSync, key: Buffer) {
    this.db = db;
    this.key = key;
    db.exec(SCHEMA);
  }

  /** Whether `k` was dismissed QUIET_AFTER_DISMISSALS times within the window, with no answer after the first of them. */
  quiet(k: AskedKey, now: number): boolean {
    const id = this.id(k);
    const since = now - QUESTION_QUIET_DAYS * DAY_MS;
    const answered = this.stmt("SELECT MAX(at) AS at FROM question_memory WHERE question = ? AND outcome = 'answered'").get(id) as { at: number | null } | undefined;
    const from = Math.max(since, (answered?.at ?? -Infinity) + 1);
    const row = this.stmt("SELECT COUNT(*) AS n FROM question_memory WHERE question = ? AND outcome = 'dismissed' AND at >= ? AND at <= ?").get(id, from, now) as { n: number };
    return row.n >= QUIET_AFTER_DISMISSALS;
  }

  /** The user put the question away without answering it, or it expired unanswered. */
  dismissed(k: AskedKey, at: number): void {
    this.record(k, at, "dismissed");
  }

  /** The user answered the question: it is asked again from now on. */
  answered(k: AskedKey, at: number): void {
    this.record(k, at, "answered");
  }

  private record(k: AskedKey, at: number, outcome: "dismissed" | "answered"): void {
    this.stmt("INSERT INTO question_memory (question, at, outcome) VALUES (?, ?, ?)").run(this.id(k), at, outcome);
    // Nothing older than the window can make a question quiet; an answer older than it lifts nothing it could still count.
    this.stmt("DELETE FROM question_memory WHERE at < ?").run(at - QUESTION_QUIET_DAYS * DAY_MS);
  }

  private id(k: AskedKey): string {
    const fields = [...new Set(k.fields)].sort();
    return createHmac("sha256", this.key).update(JSON.stringify(["question-memory-v1", k.form, k.part, fields])).digest("hex");
  }

  private stmt(sql: string): StatementSync {
    let st = this.stmts.get(sql);
    if (st === undefined) this.stmts.set(sql, (st = this.db.prepare(sql)));
    return st;
  }
}
