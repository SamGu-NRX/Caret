// The page the user is in, in one browser process, read now (H10). Ask plans in it (Helper.pageFront). A walk, rather than
// the model's last page focus, because the worker reports focus moving inside a page, and a tab chosen in the tab strip
// may not have reported yet: the walk names the tab that is active in the focused window as the Ask arrives, and puts
// that page in the screen model before the planner reads it.
import type { EngineRegistry } from "./registry.ts";
import { pageWindowId } from "./windows.ts";

/**
 * The page window of the active tab of the focused browser window of process `pid`, or null when no connected engine
 * can say. Each browser profile is its own engine with its own last-focused window, and only one window has focus, so
 * every session of the process is asked until one walk says its tab is active in a focused window.
 *
 * With `windowFrame` (a reader window of that browser the request named), only a page whose window the walk puts at that
 * frame, within a point, counts; a walk that does not say where its window is (a worker before H10) counts for none.
 */
export async function pageFront(registry: EngineRegistry, pid: number, windowFrame?: readonly [number, number, number, number]): Promise<string | null> {
  for (const s of registry.list()) {
    if (s.hello === null || s.closed || s.info.browser.pid !== pid) continue;
    const a = await s.command({ kind: "pageWalk", tabId: null });
    if (a.result.outcome !== "ok" || a.snapshot === null || !a.snapshot.active || !a.snapshot.inFocusedWindow) continue;
    if (windowFrame !== undefined) {
      const w = a.snapshot.view?.window;
      if (w === undefined || w.some((v, i) => Math.abs(v - (windowFrame[i] as number)) > 1)) continue;
    }
    return pageWindowId(s.info.engine, a.snapshot.tabId);
  }
  return null;
}
