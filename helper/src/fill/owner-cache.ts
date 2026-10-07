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

export class OwnerVerdicts {
  private readonly entries = new Map<string, { answers: readonly [OwnerAnswer, OwnerAnswer]; windows: ReadonlySet<string> }>();

  /** The key of one owner question: everything it asks, and the notes it showed by digest. */
  static key(question: string, span: string, digests: readonly string[], criteria: Readonly<Record<string, string>>): string {
    return createHash("sha256").update(JSON.stringify([question, span, [...digests].sort(), criteria])).digest("hex");
  }

  get(key: string): readonly [OwnerAnswer, OwnerAnswer] | undefined {
    return this.entries.get(key)?.answers;
  }

  set(key: string, answers: readonly [OwnerAnswer, OwnerAnswer], windows: Iterable<string>): void {
    this.entries.set(key, { answers: [{ ...answers[0] }, { ...answers[1] }], windows: new Set(windows) });
  }

  /** Drops every entry whose notes any of these windows gave. */
  forget(windows: ReadonlySet<string>): void {
    for (const [k, e] of this.entries) if ([...e.windows].some((w) => windows.has(w))) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
