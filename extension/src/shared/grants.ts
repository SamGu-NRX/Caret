// The worker's grant table (memo section 2, "where the final check lives"). A ScopedActGrant covers one frame of
// one tab in this engine session, at an origin and navigation generation. It ends at its `expires` or 120 s after
// it arrived, whichever is first, measured for the latter on the monotonic clock so a wall-clock change cannot
// stretch it; at the task's actRevoke; and with the port, since the table lives only in this worker instance.

export const GRANT_MAX_MS = 120_000;

export interface PageScope {
  kind: "page";
  engine: string;
  tabId: number;
  frameId: number;
  origin: string;
  navGen: number;
}

interface Held {
  scope: PageScope;
  /** Wall-clock end the helper set. */
  expires: number;
  /** Monotonic end: arrival plus GRANT_MAX_MS. */
  monoEnd: number;
}

export type GrantCheck = { ok: true; scope: PageScope; expires: number } | { ok: false; reason: string };

export class GrantTable {
  private readonly byTask = new Map<string, Held[]>();
  private readonly wall: () => number;
  private readonly mono: () => number;

  constructor(clocks: { wall: () => number; mono: () => number }) {
    this.wall = clocks.wall;
    this.mono = clocks.mono;
  }

  /** Takes a grant for this engine; a grant for another engine or a native window is refused with why. */
  grant(taskId: string, scope: { kind: string; [k: string]: unknown }, expires: number, engine: string | null): string | null {
    if (scope.kind !== "page") return "a native grant reached the page engine";
    if (engine === null || scope.engine !== engine) return `a grant for engine ${String(scope.engine)}, this is ${String(engine)}`;
    const s = scope as unknown as PageScope;
    const held = (this.byTask.get(taskId) ?? []).filter((h) => h.scope.tabId !== s.tabId || h.scope.frameId !== s.frameId);
    held.push({ scope: s, expires, monoEnd: this.mono() + GRANT_MAX_MS });
    this.byTask.set(taskId, held);
    return null;
  }

  /** Ends the task's grants; returns the frames they covered, as "tabId:frameId". */
  revoke(taskId: string): string[] {
    const held = this.byTask.get(taskId) ?? [];
    this.byTask.delete(taskId);
    return held.map((h) => `${h.scope.tabId}:${h.scope.frameId}`);
  }

  /** Every grant held, live or not yet pruned, with its task. */
  scopes(): { taskId: string; scope: PageScope }[] {
    return [...this.byTask].flatMap(([taskId, held]) => held.map((h) => ({ taskId, scope: h.scope })));
  }

  /** Tasks whose grant, live or not yet pruned, covers this frame. */
  tasksIn(tabId: number, frameId: number): string[] {
    return [...this.byTask].filter(([, held]) => held.some((h) => h.scope.tabId === tabId && h.scope.frameId === frameId)).map(([t]) => t);
  }

  /** When the last live grant covering this frame ends (epoch ms), or 0 when none covers it. */
  coverUntil(tabId: number, frameId: number): number {
    return Math.max(0, ...this.tasksIn(tabId, frameId).map((t) => this.check(t, tabId, frameId)).map((g) => (g.ok ? g.expires : 0)));
  }

  /** Whether any task holds a live grant for this frame. */
  covers(tabId: number, frameId: number): boolean {
    return this.tasksIn(tabId, frameId).some((t) => this.check(t, tabId, frameId).ok);
  }

  clear(): void {
    this.byTask.clear();
  }

  /**
   * The live grant for this task in this frame, or why there is none. The caller then compares the grant's origin
   * and navGen with the frame as it is now.
   */
  check(taskId: string, tabId: number, frameId: number): GrantCheck {
    const held = this.byTask.get(taskId);
    if (held === undefined) return { ok: false, reason: `no live grant for task ${taskId}` };
    const h = held.find((x) => x.scope.tabId === tabId && x.scope.frameId === frameId);
    if (h === undefined) return { ok: false, reason: `task ${taskId} holds no grant for tab ${tabId} frame ${frameId}` };
    if (this.wall() >= h.expires || this.mono() >= h.monoEnd) return { ok: false, reason: `task ${taskId}'s grant for tab ${tabId} frame ${frameId} expired` };
    return { ok: true, scope: h.scope, expires: Math.min(h.expires, this.wall() + (h.monoEnd - this.mono())) };
  }
}
