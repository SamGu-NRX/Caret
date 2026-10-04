// Caret for Chrome's service worker. It is the only holder of the Native Messaging port to caret-bridge, and the
// last check before anything touches a page: for every mutating verb it checks the task's grant (engine, tab,
// frame, expiry, revocation), then the frame as it is now (document, navigation generation, origin), then hands the
// verb to that frame's content script pinned to the exact document, with a deadline. It walks only when the helper
// asks, composes a tab from each frame's own report, and drops every grant when the port closes.
//
// W2 adds: the combobox and attach verbs (checked like every other act; the file's bytes are checked against its
// size and digest here, before any page sees them), a grant-liveness answer for a content script mid-act, focus
// reports from the tab the user is in, and "Not on this site": the helper's list of origins Caret is off for, where
// the worker walks nothing, acts on nothing and reports no focus.
//
// W3 adds: a snapshot says whether its tab's window is the one Chrome last focused, since a background window's
// selected tab is not the user's; and the user's own input in a frame under a grant. The worker arms each frame a
// grant covers; an armed frame reports a trusted pointer or key press, and the worker then drops every grant of the
// tasks acting there, at once, before telling the helper (pageInput), which pauses them.
import type { ActAnswer, ActVerb, FrameReport, NavChanged, ToContent, UserActed } from "./shared/messages.ts";
import { GrantTable } from "./shared/grants.ts";
import { classifyPress } from "./shared/risk.ts";
import { NavGens, frameOrigin } from "./worker/frames.ts";
import { Chunks, parseFromHelper, type FromHelper } from "./worker/wire.ts";

const HOST = "ai.caret.bridge";
const VERSION = chrome.runtime.getManifest().version;
/** How long a frame has to answer a walk. Assumed: a walk of a large form measured in tens of milliseconds. */
const FRAME_WALK_MS = 1500;
const instance = crypto.randomUUID();
const startedAt = Date.now();

const grants = new GrantTable({ wall: () => Date.now(), mono: () => performance.now() });
const navGens = new NavGens();
let port: chrome.runtime.Port | null = null;
let engine: string | null = null;
let retryMs = 2000;
let chunks = new Chunks();
/** "Not on this site": origins the helper says Caret is off for. Kept in this worker only; the helper resends it after every hello. */
let sitesOff = new Set<string>();
/** Frames armed to report the user's input ("tabId:frameId"), and until when. */
const armed = new Map<string, number>();
/** Last focus report per tab, for the 150 ms limit. */
const lastFocus = new Map<number, number>();
const FOCUS_EVERY_MS = 150;

function log(...a: unknown[]): void {
  console.log("[caret]", ...a);
}

async function profileId(): Promise<string> {
  const got = await chrome.storage.local.get("profile");
  if (typeof got.profile === "string") return got.profile;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ profile: id });
  return id;
}

function send(m: object): void {
  try {
    port?.postMessage(m);
  } catch (e) {
    log("send failed", e);
  }
}

/**
 * Arms a frame's report of the user's input until `until`, or disarms it (0). Sent every time, never skipped from a
 * cache: the frame may hold a new document since it was last armed (W3 review #6). An act arms its document as well,
 * so a guard message that does not arrive leaves no act unarmed.
 */
function guard(tabId: number, frameId: number, until: number): void {
  const k = `${tabId}:${frameId}`;
  // `until` is the end of the last grant covering the frame (GrantTable.coverUntil), never one task's alone.
  if (until === 0) {
    if (!armed.delete(k)) return;
  } else armed.set(k, until);
  const msg: ToContent = { caret: 1, op: "guard", until };
  chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => armed.delete(k));
}

/** Ends a task's grants; each frame it covered is armed until its other tasks' grants end, or disarmed. */
function revokeTask(taskId: string): void {
  for (const f of grants.revoke(taskId)) {
    const [tabId, frameId] = f.split(":").map(Number) as [number, number];
    guard(tabId, frameId, grants.coverUntil(tabId, frameId));
  }
}

function result(id: string, a: ActAnswer): void {
  send({
    type: "pageResult",
    v: 1,
    id,
    at: Date.now(),
    outcome: a.outcome,
    detail: a.detail,
    ...(a.readings === undefined ? {} : { readings: a.readings }),
    ...(a.risk === undefined ? {} : { risk: a.risk }),
    ...(a.choice === undefined ? {} : { choice: a.choice }),
    ...(a.attached === undefined ? {} : { attached: a.attached }),
  });
}

function connect(): void {
  if (port !== null) return;
  log("connecting to", HOST);
  const p = chrome.runtime.connectNative(HOST);
  port = p;
  p.onMessage.addListener((raw: unknown) => void onHelper(raw));
  p.onDisconnect.addListener(() => {
    log("bridge disconnected:", chrome.runtime.lastError?.message ?? "closed");
    if (port === p) port = null;
    engine = null;
    grants.clear();
    for (const k of [...armed.keys()]) {
      const [tabId, frameId] = k.split(":").map(Number) as [number, number];
      guard(tabId, frameId, 0);
    }
    chunks = new Chunks();
    sitesOff = new Set();
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 60_000);
  });
}

async function onHelper(raw: unknown): Promise<void> {
  let m: FromHelper | null = parseFromHelper(raw);
  if (m?.type === "pageChunk") {
    const whole = chunks.add(m);
    if (whole === null) return;
    try {
      m = parseFromHelper(JSON.parse(whole));
    } catch {
      m = null;
    }
  }
  if (m === null) return log("dropped a malformed message from the bridge");
  switch (m.type) {
    case "engineReady":
      engine = m.engine;
      retryMs = 2000;
      send({ type: "pageHello", v: 1, extensionId: chrome.runtime.id, version: VERSION, profile: await profileId(), instance, startedAt, capabilities: ["pageWalk", "pageWrite", "pageSelect", "pageSetChecked", "pagePress", "pageChooseOption", "pageAttachFile", "pageFocus", "pageSitesOff", "pageInput"] });
      return;
    case "pagePing":
      send({ type: "pagePong", v: 1, id: m.id, at: Date.now(), instance, startedAt });
      return;
    case "scopedActGrant": {
      const why = grants.grant(m.taskId, m.scope, m.expires, engine);
      if (why !== null) return log("grant refused:", why);
      // A page grant (grants.grant refused every other kind); wire.ts checked these are integers.
      const { tabId, frameId } = m.scope;
      if (typeof tabId !== "number" || typeof frameId !== "number") return;
      // Armed until the last grant covering the frame ends, so a shorter grant never cuts another task's coverage short.
      const until = grants.coverUntil(tabId, frameId);
      if (until > 0) guard(tabId, frameId, until);
      return;
    }
    case "actRevoke":
      revokeTask(m.taskId);
      return;
    case "pageChunk":
      return;
    case "pageSitesOff":
      sitesOff = new Set(m.origins);
      return;
    case "pageCommand":
      if (engine === null) return;
      if (Date.now() >= m.expires) return result(m.id, { outcome: "error", detail: "the command expired before it arrived" });
      try {
        if (m.verb.kind === "pageWalk") await walk(m.id, m.verb.tabId);
        else result(m.id, await act(m.verb, m.expires));
      } catch (e) {
        result(m.id, { outcome: "error", detail: e instanceof Error ? e.message : String(e) });
      }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms))]);
}

async function walk(id: string, tabId: number | null): Promise<void> {
  const tab = tabId === null ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] : await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.id === undefined) return result(id, { outcome: "noElement", detail: tabId === null ? "no active tab in the focused window" : `no tab ${tabId}` });
  const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) ?? [];
  const top = frameOrigin(frames, 0);
  if (top !== null && sitesOff.has(top)) return result(id, { outcome: "siteOff", detail: `Caret is off on ${top}` });
  const missing: { frameId: number; reason: string }[] = [];
  const reports = await Promise.all(
    frames.map(async (f) => {
      const origin = frameOrigin(frames, f.frameId);
      if (origin === null) {
        missing.push({ frameId: f.frameId, reason: "not an http(s) frame" });
        return null;
      }
      // Not asked at all: a frame on a site Caret is off for is never walked.
      if (sitesOff.has(origin)) {
        missing.push({ frameId: f.frameId, reason: "Caret is off on this site" });
        return null;
      }
      try {
        const msg: ToContent = { caret: 1, op: "walk" };
        const r = (await withTimeout(chrome.tabs.sendMessage(tab.id as number, msg, { frameId: f.frameId, documentId: f.documentId }), FRAME_WALK_MS, `frame ${f.frameId}`)) as FrameReport | undefined;
        if (r === undefined || typeof r !== "object" || !Array.isArray(r.controls)) throw new Error("no report");
        // The worker's own view of the frame wins over what its script says: origin from the URL Chrome reports.
        return { f, r, origin };
      } catch (e) {
        missing.push({ frameId: f.frameId, reason: e instanceof Error ? e.message : String(e) });
        return null;
      }
    }),
  );
  // The tab and the window Chrome last focused, read again once the frames answered, so the snapshot says where focus is
  // as it is sent: the user may have switched tabs meanwhile (W3 review #13). Each browser profile is its own engine
  // with its own last-focused window, so the window must also say it has focus now; with two profiles open, only one
  // window does.
  const [tabNow, lastFocused] = await Promise.all([chrome.tabs.get(tab.id).catch(() => undefined), chrome.windows.getLastFocused().catch(() => undefined)]);
  if (tabNow === undefined) return result(id, { outcome: "noElement", detail: `tab ${tab.id} closed during the walk` });
  const answered = reports.filter((x): x is NonNullable<typeof x> => x !== null).sort((a, b) => a.f.frameId - b.f.frameId);
  // A frame is kept only when its document's own origin (self.origin, which is opaque for a sandboxed frame) is the
  // one the worker derived from Chrome's URL for it (W1 review #8), and, below the top, when it can be shown to sit in
  // a visible <iframe> of its parent (#5). Chrome gives content scripts no frame id for an iframe element
  // (chrome.runtime.getFrameId is undefined there in Chrome 154), so identity is argued from counts and sizes, and
  // where that argument fails every child of the parent is dropped:
  //   - a child whose own viewport is a pixel or less sits in an iframe hidden by display:none or zero size, and is
  //     dropped by itself;
  //   - every other child, answered or not, is "sized". If a parent has more sized children than visible iframes,
  //     some sized child is hidden and nothing says which, so all of that parent's children are dropped (review
  //     round 3: a decoy iframe sized to vouch for a hidden one);
  //   - otherwise each sized child must take a distinct visible iframe whose content box is exactly its viewport
  //     (src preferred), or it is dropped.
  const kept: typeof answered = [];
  const used = new Set<string>();
  const sizedChildren = (parentId: number): number =>
    frames.filter((f) => f.parentFrameId === parentId).filter((f) => {
      const a = answered.find((x) => x.f.frameId === f.frameId);
      return a === undefined || (a.r.viewport[0] > 1 && a.r.viewport[1] > 1);
    }).length;
  for (const k of answered.filter((x) => x.f.parentFrameId < 0).concat(answered.filter((x) => x.f.parentFrameId >= 0))) {
    if (k.r.origin !== k.origin) {
      missing.push({ frameId: k.f.frameId, reason: `its document's origin ${k.r.origin} is not ${k.origin}` });
      continue;
    }
    if (k.f.parentFrameId >= 0) {
      const parent = kept.find((p) => p.f.frameId === k.f.parentFrameId);
      const [vw, vh] = k.r.viewport;
      if (parent === undefined || vw <= 1 || vh <= 1) {
        missing.push({ frameId: k.f.frameId, reason: "its <iframe> is not visible in the parent frame" });
        continue;
      }
      if (sizedChildren(parent.f.frameId) > parent.r.iframes.length) {
        missing.push({ frameId: k.f.frameId, reason: "its parent holds more frames than visible iframes, so which are seen cannot be told" });
        continue;
      }
      const src = k.f.url.startsWith("about:") ? "about:" : (() => {
        const u = new URL(k.f.url);
        return `${u.origin}${u.pathname}`;
      })();
      const candidates = parent.r.iframes.map((i, n) => ({ i, key: `${parent.f.frameId}:${n}` })).filter((c) => !used.has(c.key) && Math.abs(c.i.inner[0] - vw) <= 1 && Math.abs(c.i.inner[1] - vh) <= 1);
      const pick = candidates.find((c) => c.i.src.startsWith(src)) ?? candidates[0];
      if (pick === undefined) {
        missing.push({ frameId: k.f.frameId, reason: "no visible <iframe> in the parent has its size" });
        continue;
      }
      used.add(pick.key);
    }
    kept.push(k);
  }
  kept.sort((a, b) => a.f.frameId - b.f.frameId);
  if (kept.length === 0) return result(id, { outcome: "noElement", detail: `no frame of tab ${tab.id} answered: ${missing.map((m) => m.reason).join("; ")}` });
  const focusedFrame = kept.filter((k) => k.r.focused !== null).sort((a, b) => Number(b.r.hasFocus) - Number(a.r.hasFocus))[0];
  send({
    type: "pageSnapshot",
    v: 1,
    id,
    at: Date.now(),
    tabId: tab.id,
    browserWindowId: tabNow.windowId,
    active: tabNow.active,
    inFocusedWindow: lastFocused?.id !== undefined && lastFocused.id === tabNow.windowId && lastFocused.focused,
    title: tabNow.title ?? "",
    frames: kept.map(({ f, r, origin }) => ({
      frameId: f.frameId,
      parentFrameId: f.parentFrameId,
      documentId: f.documentId,
      origin,
      path: r.path,
      navGen: navGens.get(tab.id as number, f.frameId),
      title: r.title,
      headings: r.headings,
      controls: r.controls,
      iframes: r.iframes.map((i) => ({ src: i.src, rect: i.rect })),
      excluded: r.excluded,
      truncated: r.truncated,
    })),
    missing: missing.sort((a, b) => a.frameId - b.frameId),
    focused: focusedFrame?.r.focused === undefined || focusedFrame.r.focused === null ? null : { frameId: focusedFrame.f.frameId, ...focusedFrame.r.focused },
  });
  result(id, { outcome: "ok", detail: null });
}

/** Hex SHA-256 of `bytes`. */
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Why the file's bytes are not the file the verb describes, or null. Checked before any page sees them. */
async function fileProblem(f: { size: number; sha256: string; data: string }): Promise<string | null> {
  let bin: string;
  try {
    bin = atob(f.data);
  } catch {
    return "the file's data is not base64";
  }
  if (bin.length !== f.size) return `the file's data holds ${bin.length} bytes, not ${f.size}`;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return (await sha256(bytes)) === f.sha256 ? null : "the file's data does not match its digest";
}

async function act(verb: ActVerb, expires: number): Promise<ActAnswer> {
  if (verb.kind === "pagePress") {
    // Every page press is a hand-off in v1: the button runs the page's own script (content/actions.ts). The page is not touched.
    const risk = classifyPress(verb.name);
    return { outcome: "handoff", detail: `'${verb.name}' runs the page's own script, so you press it`, risk: risk === "safe" || risk === "unclassified" ? "pageScript" : risk };
  }
  const g = grants.check(verb.taskId, verb.tabId, verb.frameId);
  if (!g.ok) return { outcome: "notAllowed", detail: g.reason };
  if (sitesOff.has(g.scope.origin)) return { outcome: "siteOff", detail: `Caret is off on ${g.scope.origin}` };
  if (verb.kind === "pageAttachFile") {
    const bad = await fileProblem(verb.file);
    if (bad !== null) return { outcome: "error", detail: bad };
  }
  const frame = await chrome.webNavigation.getFrame({ tabId: verb.tabId, frameId: verb.frameId }).catch(() => null);
  if (frame === null || frame === undefined) return { outcome: "stale", detail: "the frame is gone" };
  if (frame.documentId !== verb.documentId) return { outcome: "stale", detail: "the frame holds another document than when it was walked" };
  const gen = navGens.get(verb.tabId, verb.frameId);
  if (gen !== g.scope.navGen) return { outcome: "stale", detail: `the frame navigated since the grant (navGen ${g.scope.navGen}, now ${gen})` };
  const all = (await chrome.webNavigation.getAllFrames({ tabId: verb.tabId })) ?? [];
  const origin = frameOrigin(all, verb.frameId);
  if (origin !== g.scope.origin) return { outcome: "notAllowed", detail: `the grant covers ${g.scope.origin}, the frame is at ${String(origin)}` };
  const topNow = frameOrigin(all, 0);
  if (topNow !== null && sitesOff.has(topNow)) return { outcome: "siteOff", detail: `Caret is off on ${topNow}` };
  // The frame lookups above awaited; a revoke or expiry that landed meanwhile stops the act here, before the page.
  const live = grants.check(verb.taskId, verb.tabId, verb.frameId);
  if (!live.ok) return { outcome: "notAllowed", detail: live.reason };
  // Read the generation again now, not the one taken before the awaits: a history change meanwhile is stale (W1 review #4).
  const genNow = navGens.get(verb.tabId, verb.frameId);
  if (live.scope.navGen !== genNow || live.scope.origin !== origin) return { outcome: "stale", detail: `the frame moved during the check (navGen ${live.scope.navGen}, now ${genNow})` };
  const deadline = Math.min(expires, live.expires);
  try {
    const msg: ToContent = { caret: 1, op: "act", verb, deadline, guardUntil: live.expires };
    const a = (await withTimeout(chrome.tabs.sendMessage(verb.tabId, msg, { frameId: verb.frameId, documentId: verb.documentId }), Math.max(100, deadline - Date.now() + 1000), "the frame")) as ActAnswer | undefined;
    if (a === undefined || typeof a !== "object" || typeof a.outcome !== "string") return { outcome: "error", detail: "the frame gave no answer" };
    return a;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The pinned document is gone between the check and the delivery: a navigation won the race.
    if (/Could not establish connection|Receiving end does not exist|No frame|document/i.test(msg)) return { outcome: "stale", detail: `the document is gone: ${msg}` };
    return { outcome: "error", detail: msg };
  }
}

// Navigation generations: every way a frame's document or history entry changes.
chrome.webNavigation.onCommitted.addListener((d) => void navGens.bump(d.tabId, d.frameId));
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => void navGens.bump(d.tabId, d.frameId));
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => void navGens.bump(d.tabId, d.frameId));
chrome.tabs.onRemoved.addListener((tabId) => {
  navGens.forgetTab(tabId);
  lastFocus.delete(tabId);
});

/**
 * A content script mid-act asks whether its task's grant still covers its own frame: the grant is live, the frame's
 * navigation generation is the one the grant pinned, and its site is not off. Answered only for the asking frame.
 */
chrome.runtime.onMessage.addListener((m: unknown, sender, reply) => {
  const x = m as { caret?: unknown; op?: unknown; taskId?: unknown } | null;
  if (x?.caret !== 1 || x.op !== "grantAlive" || typeof x.taskId !== "string") return false;
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId === undefined) {
    reply(false);
    return false;
  }
  const g = grants.check(x.taskId, sender.tab.id, sender.frameId);
  reply(g.ok && navGens.get(sender.tab.id, sender.frameId) === g.scope.navGen && !sitesOff.has(g.scope.origin));
  return false;
});

/**
 * Focus moved in a frame of a tab. Passed to the helper only when the tab is the active tab of the last focused
 * browser window, its site and its frame's site are not off, an engine is connected, and the tab sent none in the
 * last 150 ms. Nothing about the element travels.
 */
chrome.runtime.onMessage.addListener((m: unknown, sender) => {
  const x = m as { caret?: unknown; op?: unknown } | null;
  if (x?.caret !== 1 || x.op !== "focusMoved") return false;
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId === undefined || engine === null) return false;
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  const now = Date.now();
  if (now - (lastFocus.get(tabId) ?? 0) < FOCUS_EVERY_MS) return false;
  lastFocus.set(tabId, now);
  void (async () => {
    const [tab, win, all] = await Promise.all([chrome.tabs.get(tabId).catch(() => undefined), chrome.windows.getLastFocused().catch(() => undefined), chrome.webNavigation.getAllFrames({ tabId })]);
    if (tab === undefined || !tab.active || win === undefined || tab.windowId !== win.id || !win.focused) return;
    const top = frameOrigin(all ?? [], 0);
    const here = frameOrigin(all ?? [], frameId);
    if ((top !== null && sitesOff.has(top)) || (here !== null && sitesOff.has(here))) return;
    send({ type: "pageFocus", v: 1, at: now, tabId, frameId });
  })();
  return false;
});

/**
 * The user pressed a pointer or a key in a frame this worker armed (W3). Accepted only from this extension's content
 * script in a tab, and only while some task's grant covers that frame: every such task loses all its grants here,
 * before the helper hears of it, so an act on its way is refused at the worker and a multi-stage act stops at its
 * next stage. Then the helper pauses those tasks (pageInput). Nothing about the element or the key is passed on.
 */
chrome.runtime.onMessage.addListener((m: unknown, sender) => {
  const x = m as Partial<UserActed> | null;
  if (x?.caret !== 1 || x.op !== "userInput" || (x.kind !== "key" && x.kind !== "mouse")) return false;
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId === undefined || engine === null) return false;
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  if (!grants.covers(tabId, frameId)) return false;
  for (const t of grants.tasksIn(tabId, frameId)) revokeTask(t);
  send({ type: "pageInput", v: 1, at: Date.now(), tabId, frameId, kind: x.kind });
  return false;
});

// A frame's own word that its document moved. Accepted only from this extension's content script in a tab, for the
// document Chrome says that frame holds now, at the origin its URL has.
chrome.runtime.onMessage.addListener((m: unknown, sender) => {
  const x = m as Partial<NavChanged> | null;
  if (x?.caret !== 1 || x.op !== "navChanged") return false;
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId === undefined || sender.documentId === undefined || sender.origin === undefined) return false;
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  void chrome.webNavigation.getAllFrames({ tabId }).then((all) => {
    const now = all?.find((f) => f.frameId === frameId);
    if (now === undefined || now.documentId !== sender.documentId || frameOrigin(all ?? [], frameId) !== sender.origin) return;
    navGens.bump(tabId, frameId);
  });
  return false;
});

// Tabs open before install have no content script; give them one, for walks. It is marked late first, in the same
// isolated world, so it takes no act until the page reloads with the script in from document_start: listeners the page
// registered before ours could hide the user's clicks from it (W3 review #5). A tab that already has one keeps it.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).then((tabs) => {
    for (const t of tabs) {
      if (t.id === undefined) continue;
      const target = { tabId: t.id, allFrames: true };
      void chrome.scripting
        // A document still loading gets the declared script at document_start, before any page listener; it is not late.
        .executeScript({ target, func: () => void (globalThis.__caretContent === undefined && document.readyState !== "loading" && (globalThis.__caretLate = true)) })
        .then(() => chrome.scripting.executeScript({ target, files: ["content.js"] }))
        .catch(() => {});
    }
  });
});

connect();
