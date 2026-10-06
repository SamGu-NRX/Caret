// The worker's frame registry: each frame's navigation generation (memo section 1, navGen). It rises on every
// committed navigation, history-state change and fragment change webNavigation reports, and when a frame's own
// content script says its document came back from the back-forward cache or moved in history. A grant pins the
// generation it was given at; any difference is stale. The page can raise a generation (by navigating), never
// lower one or name another frame's: the worker counts, the page only triggers.

export class NavGens {
  private readonly gens = new Map<string, number>();

  private static key(tabId: number, frameId: number): string {
    return `${tabId}:${frameId}`;
  }

  /** The frame's generation, starting at 1 for a frame this worker has not seen move. */
  get(tabId: number, frameId: number): number {
    return this.gens.get(NavGens.key(tabId, frameId)) ?? 1;
  }

  bump(tabId: number, frameId: number): number {
    const k = NavGens.key(tabId, frameId);
    const n = (this.gens.get(k) ?? 1) + 1;
    this.gens.set(k, n);
    return n;
  }

  /** P4: every frame of a tab that has moved, with its generation now; a frame not listed is at 1. */
  ofTab(tabId: number): Map<number, number> {
    const out = new Map<number, number>();
    for (const [k, n] of this.gens) if (k.startsWith(`${tabId}:`)) out.set(Number(k.slice(k.indexOf(":") + 1)), n);
    return out;
  }

  forgetTab(tabId: number): void {
    for (const k of [...this.gens.keys()]) if (k.startsWith(`${tabId}:`)) this.gens.delete(k);
  }
}

/** A frame's origin as the worker knows it from its URL; about:blank and srcdoc frames take their parent's. */
export function frameOrigin(frames: readonly { frameId: number; parentFrameId: number; url: string }[], frameId: number): string | null {
  for (let id = frameId, hops = 0; hops < 32; hops++) {
    const f = frames.find((x) => x.frameId === id);
    if (f === undefined) return null;
    let u: URL;
    try {
      u = new URL(f.url);
    } catch {
      return null;
    }
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    if (u.protocol !== "about:" || f.parentFrameId < 0) return null;
    id = f.parentFrameId;
  }
  return null;
}
