// The reader's act grants (CaretScreenCore/Grants.swift) for the in-process and socket fakes: the same
// rules and wording, with a clock a test can move.
import { GRANT_MAX_MS, type ActGrant, type ActRevoke, type ReaderVerb } from "../src/protocol.ts";

export class FakeGrants {
  /** Every grant and revoke received, in order. */
  readonly log: (ActGrant | ActRevoke)[] = [];
  now: () => number = Date.now;
  private readonly live = new Map<string, { g: ActGrant; until: number }>();

  receive(m: ActGrant | ActRevoke): void {
    this.log.push(m);
    if (m.type === "actGrant") this.live.set(m.taskId, { g: m, until: Math.min(m.expires, this.now() + GRANT_MAX_MS) });
    else this.live.delete(m.taskId);
  }

  /** Null when the verb may act; otherwise the reader's notAllowed detail. Verbs that only read always may. */
  refusal(verb: ReaderVerb): string | null {
    if (verb.kind !== "write" && verb.kind !== "press" && verb.kind !== "raise") return null;
    const t = verb.taskId;
    if (t === undefined) return "the command names no task, so no act grant covers it";
    const e = this.live.get(t);
    if (e === undefined) return `no act grant for task ${t}`;
    if (this.now() >= e.until) return `the act grant for task ${t} has expired`;
    if (e.g.pid !== verb.pid) return `the act grant for task ${t} covers process ${e.g.pid}, not ${verb.pid}`;
    if (e.g.windowId !== verb.windowId) return `the act grant for task ${t} covers window ${e.g.windowId}, not ${verb.windowId}`;
    return null;
  }
}
