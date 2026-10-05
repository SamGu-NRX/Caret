// Page window ids: `page:<engine>:<tabId>`. A new engine session (a worker restart, another bridge) has another
// id, so window ids from an earlier session match nothing, as the reader's do after readerRestarted().
const PREFIX = "page:";

/** A page engine's window's kind (WindowRef.kind), which no reader window has. */
export const PAGE_WINDOW_KIND = "page";

export function pageWindowId(engine: string, tabId: number): string {
  return `${PREFIX}${engine}:${tabId}`;
}

export function isPageWindow(windowId: string): boolean {
  return windowId.startsWith(PREFIX);
}

/** The engine and tab a page window id names, or null for any other id. */
export function parsePageWindow(windowId: string): { engine: string; tabId: number } | null {
  const m = /^page:([^:]+):(\d+)$/.exec(windowId);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const tabId = Number(m[2]);
  return Number.isSafeInteger(tabId) ? { engine: m[1], tabId } : null;
}
