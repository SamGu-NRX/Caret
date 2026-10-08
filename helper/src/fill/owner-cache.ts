// HA2 recall lever 2: the owner verdicts of this session, so a repeat focus on the same note does not ask Jev again.
// An entry is both wordings' answers to one owner question that showed its notes whole (fill.ts noteShown). Its key is
// the question as asked, wording 0, over the candidate's description, its notes' digests (note-unit.ts, P1's digest of
// the redacted note as disclosed), the value's span and the criteria: any change in what would be asked, a changed note
// above all, misses. Held in memory only, never written to disk; the helper clears it when the session ends and when
// Sites change, and drops a window's entries when Caret forgets that window's text (a tab the user left).
import { createHash } from "node:crypto";

export interface OwnerAnswer {
  choice: string;
  confidence: number;
}

/**
 * HA2 review 2, item 3: the invalidations a fill saw when it built its owner questions (OwnerVerdicts.ticket). An answer
 * that comes back after a clear (a Sites change, a lock, a sign-out) or a forget of one of its windows is dropped.
 */
export interface CacheTicket {
  readonly cleared: number;
  readonly forgotten: ReadonlyMap<string, number>;
}

export class OwnerVerdicts {
  private readonly entries = new Map<string, { answers: readonly [OwnerAnswer, OwnerAnswer]; windows: ReadonlySet<string>; ticket: CacheTicket }>();
  /** How many times the whole cache was cleared, and each window forgotten: the invalidation generations. */
  private cleared = 0;
  private readonly forgotten = new Map<string, number>();

  /** What a fill captures before it reads or sends its owner questions, and hands back with their answers (set). */
  ticket(): CacheTicket {
    return { cleared: this.cleared, forgotten: new Map(this.forgotten) };
  }

  /** Whether nothing invalidated these windows since `t` was taken. */
  private current(t: CacheTicket, windows: Iterable<string>): boolean {
    return t.cleared === this.cleared && [...windows].every((w) => (t.forgotten.get(w) ?? 0) === (this.forgotten.get(w) ?? 0));
  }

  /**
   * The key of one owner question: everything it asks and everything that shapes how it is read (HA2 review 2, item 4:
   * `context` holds the Ask's instruction and the person it names, so "I am Odile" and "I am Bram" never share a verdict),
   * and the notes it showed by digest.
   */
  static key(question: string, span: string, digests: readonly string[], criteria: Readonly<Record<string, string>>, context: string): string {
    return createHash("sha256").update(JSON.stringify([question, span, [...digests].sort(), criteria, context])).digest("hex");
  }

  /** The session's answer to this question, unless something invalidated its windows since it was kept. */
  get(key: string): readonly [OwnerAnswer, OwnerAnswer] | undefined {
    const e = this.entries.get(key);
    if (e === undefined) return undefined;
    if (!this.current(e.ticket, e.windows)) {
      this.entries.delete(key);
      return undefined;
    }
    return e.answers;
  }

  /** Keeps answers asked under `ticket`, unless the cache was cleared or one of their windows forgotten since. */
  set(key: string, answers: readonly [OwnerAnswer, OwnerAnswer], windows: Iterable<string>, ticket: CacheTicket): void {
    const ws = new Set(windows);
    if (!this.current(ticket, ws)) return;
    this.entries.set(key, { answers: [{ ...answers[0] }, { ...answers[1] }], windows: ws, ticket: this.ticket() });
  }

  /** Drops every entry whose notes any of these windows gave, and any answer about them still in flight. */
  forget(windows: ReadonlySet<string>): void {
    for (const w of windows) this.forgotten.set(w, (this.forgotten.get(w) ?? 0) + 1);
    for (const [k, e] of this.entries) if ([...e.windows].some((w) => windows.has(w))) this.entries.delete(k);
  }

  /** Drops every entry, and every answer still in flight. */
  clear(): void {
    this.cleared++;
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
