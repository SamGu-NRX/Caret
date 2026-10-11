// Which tab the user just left, and whether it may still be read (P4, brief rules 1 and 2). Pure: the worker feeds it
// the tab the user is in after every tab or window change, and what the tab's frames are now when a read is asked.
//
// Rule 1, one tab: only the tab the user was in when they moved to another tab, another browser window or another app.
// Coming back to it makes it the tab they are in again, which is never read (fill never fills from the page's own text).
// Rule 2, recent and unchanged: within LEFT_TAB_MS of leaving it, and still the document it was. Each frame's document
// and navigation generation are noted as the user leaves; a navigation, a reload or a closed tab means no read. A child
// frame that navigated or appeared since is left out; the top frame changing refuses the whole read.

/**
 * How long after the user leaves a tab it may still be read. Two minutes, the window fill already treats as recent
 * (fill/candidates.ts RECENT_MS): long enough to switch to a form and focus a field, short enough that a tab the user
 * left behind long ago is not read. Brief P4 rule 2.
 */
export const LEFT_TAB_MS = 120_000;

/** The tab the user is in: the active tab of the focused browser window. */
export interface Front {
  tabId: number;
  windowId: number;
}

/** One frame as it was when the user left its tab, or as it is now. */
export interface FrameMark {
  frameId: number;
  documentId: string;
  navGen: number;
}

export interface Left {
  tabId: number;
  /** When the user left it (epoch ms), taken in the event that said so. */
  at: number;
  /**
   * Every frame the tab held at that moment, with its document and navigation generation, from the worker's own frame
   * registry in the same event (P4 review: a frame read after the event could be one that appeared since). Null when
   * the worker did not know the tab's top document then: such a tab is never read.
   */
  frames: FrameMark[] | null;
}

export type ReadCheck = { ok: true; frames: FrameMark[] } | { ok: false; why: string };

export class LeftTab {
  private front: Front | null = null;
  private left: Left | null = null;

  /** The tab the user is in now, as last told. */
  current(): Front | null {
    return this.front;
  }

  /** The tab the user left last, if any. */
  last(): Left | null {
    return this.left;
  }

  /**
   * The user is now in `next` (null: no browser window of this profile has focus). Called in the event that says so,
   * with `frames`, the frames of the tab being left (current()) as the worker knows them in that same event, so nothing
   * that changed after the user left can become what they left. Returns the record of the tab just left when this move
   * left one; null otherwise.
   */
  moved(next: Front | null, now: number, frames: (tabId: number) => FrameMark[]): Left | null {
    const prev = this.front;
    this.front = next;
    // Back in the tab they left: it is the tab they are in again.
    if (next !== null && this.left?.tabId === next.tabId) this.left = null;
    if (prev === null || (next !== null && next.tabId === prev.tabId)) return null;
    const known = frames(prev.tabId);
    this.left = { tabId: prev.tabId, at: now, frames: known.some((f) => f.frameId === 0) ? known : null };
    return this.left;
  }

  /** A tab closed: if it is the one the user left, it is never read. */
  closed(tabId: number): void {
    if (this.left?.tabId === tabId) this.left = null;
    if (this.front?.tabId === tabId) this.front = null;
  }

  /** Forgets everything: the engine reconnected, and any record is from before. */
  reset(): void {
    this.front = null;
    this.left = null;
  }

  /**
   * Whether `tabId` may be read now, and which of its frames: only frames whose document and navigation generation are
   * the ones noted when the user left. `framesNow` is the tab's frames as Chrome and the worker's counters say now.
   */
  check(tabId: number, now: number, framesNow: readonly FrameMark[]): ReadCheck {
    const l = this.left;
    if (l === null || l.tabId !== tabId) return { ok: false, why: "it is not the tab you just left" };
    if (this.front?.tabId === tabId) return { ok: false, why: "it is the tab you are in" };
    if (now - l.at > LEFT_TAB_MS) return { ok: false, why: `you left it more than ${LEFT_TAB_MS / 1000} s ago` };
    if (l.frames === null) return { ok: false, why: "Caret did not know the tab's document when you left it" };
    const same = (a: FrameMark, b: FrameMark | undefined): boolean => b !== undefined && a.documentId === b.documentId && a.navGen === b.navGen;
    const topThen = l.frames.find((f) => f.frameId === 0);
    const topNow = framesNow.find((f) => f.frameId === 0);
    if (topThen === undefined || !same(topThen, topNow)) return { ok: false, why: "the tab navigated or reloaded since you left it" };
    const frames = l.frames.filter((f) => same(f, framesNow.find((x) => x.frameId === f.frameId)));
    return { ok: true, frames };
  }
}

/**
 * Sites whose pages Caret never reads text from, whatever the user's "Not on this site" list says: the web side of the
 * reader's deny list (apps/screen-reader DenyList, ~/.caret-run/deny-apps.txt), which keeps password managers and the
 * system's password store out of every read. A vault's page shows passwords and recovery codes as ordinary text.
 * The helper keeps a copy (helper/src/privacy/denied-origins.ts), checked equal to this one by its test.
 */
export const DENIED_HOSTS: readonly RegExp[] = [
  /(^|\.)1password\.(com|eu|ca)$/,
  /(^|\.)bitwarden\.(com|eu)$/,
  /(^|\.)lastpass\.com$/,
  /(^|\.)dashlane\.com$/,
  /(^|\.)keepersecurity\.(com|eu)$/,
  /(^|\.)nordpass\.com$/,
  /^pass\.proton\.me$/,
  /^account\.proton\.me$/,
  /(^|\.)enpass\.io$/,
  /^passwords\.google\.com$/,
  /^accounts\.google\.com$/,
  /^myaccount\.google\.com$/,
  /^appleid\.apple\.com$/,
  /^account\.apple\.com$/,
];

/** Whether an http(s) origin is one Caret never reads text from (DENIED_HOSTS). Anything that is not an http(s) origin is denied. */
export function deniedOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return true;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  // "accounts.google.com." is the same host as "accounts.google.com": a fully qualified name's trailing dot goes.
  const host = u.hostname.toLowerCase().replace(/\.$/u, "");
  return DENIED_HOSTS.some((h) => h.test(host));
}

/** An origin without its host's trailing dot ("https://example.com.:8443" gives "https://example.com:8443"). */
export function bareOrigin(origin: string): string {
  return origin.replace(/\.(?=(:\d+)?$)/u, "");
}

/**
 * The one form every site-policy comparison uses, for the origins the helper configures and the ones a frame has: the
 * URL parser's origin (lower case, default port dropped), without the host's trailing dot. The helper applies the same
 * function to its own sets (helper/src/privacy/denied-origins.ts canonicalOrigin).
 */
export function canonicalOrigin(origin: string): string {
  try {
    return bareOrigin(new URL(origin).origin);
  } catch {
    return bareOrigin(origin.trim().toLowerCase());
  }
}
