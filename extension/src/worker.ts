// Caret for Chrome's service worker. It is the only holder of the Native Messaging port to caret-bridge, and the
// last check before anything touches a page: for every mutating verb it checks the task's grant (engine, tab,
// frame, expiry, revocation), then the frame as it is now (document, navigation generation, origin), then hands the
// verb to that frame's content script pinned to the exact document, with a deadline. It walks only when the helper
// asks, composes a tab from each frame's own report, and drops every grant when the port closes.
import type { ActAnswer, ActVerb, FrameReport, NavChanged, ToContent } from "./shared/messages.ts";
import { GrantTable } from "./shared/grants.ts";
import { classifyPress } from "./shared/risk.ts";
import { NavGens, frameOrigin } from "./worker/frames.ts";
import { Chunks, parseFromHelper, type FromHelper } from "./worker/wire.ts";

const HOST = "ai.caret.bridge";
const VERSION = chrome.runtime.getManifest().version;
/** How long a frame has to answer a walk. Assumed: a walk of a large form measured in tens of milliseconds. */
const FRAME_WALK_MS = 1500;
/** Border plus padding an <iframe> box may add around its document's viewport. Assumed: UA default is 2 px of border each side. */
const FRAME_CHROME_PX = 24;
const instance = crypto.randomUUID();
const startedAt = Date.now();

const grants = new GrantTable({ wall: () => Date.now(), mono: () => performance.now() });
const navGens = new NavGens();
let port: chrome.runtime.Port | null = null;
let engine: string | null = null;
let retryMs = 2000;
let chunks = new Chunks();

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

function result(id: string, a: ActAnswer): void {
  send({ type: "pageResult", v: 1, id, at: Date.now(), outcome: a.outcome, detail: a.detail, ...(a.readings === undefined ? {} : { readings: a.readings }), ...(a.risk === undefined ? {} : { risk: a.risk }) });
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
    chunks = new Chunks();
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
      send({ type: "pageHello", v: 1, extensionId: chrome.runtime.id, version: VERSION, profile: await profileId(), instance, startedAt, capabilities: ["pageWalk", "pageWrite", "pageSelect", "pageSetChecked", "pagePress"] });
      return;
    case "pagePing":
      send({ type: "pagePong", v: 1, id: m.id, at: Date.now(), instance, startedAt });
      return;
    case "scopedActGrant": {
      const why = grants.grant(m.taskId, m.scope, m.expires, engine);
      if (why !== null) log("grant refused:", why);
      return;
    }
    case "actRevoke":
      grants.revoke(m.taskId);
      return;
    case "pageChunk":
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
  const missing: { frameId: number; reason: string }[] = [];
  const reports = await Promise.all(
    frames.map(async (f) => {
      const origin = frameOrigin(frames, f.frameId);
      if (origin === null) {
        missing.push({ frameId: f.frameId, reason: "not an http(s) frame" });
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
  const answered = reports.filter((x): x is NonNullable<typeof x> => x !== null).sort((a, b) => a.f.frameId - b.f.frameId);
  // A frame is kept only when its document's own origin (self.origin, which is opaque for a sandboxed frame) is the
  // one the worker derived from Chrome's URL for it (W1 review #8), and, below the top, when it can be shown to sit in
  // a visible <iframe> of its parent (#5): its own viewport is more than a pixel each way (an iframe its embedder hides
  // with display:none or zero size gives its document a 0 by 0 viewport), and one visible parent iframe, not already
  // matched to a sibling, has its size (the iframe's box less at most FRAME_CHROME_PX of border and padding),
  // preferring one with the same src. Size, not src alone, so a frame that redirected still matches. Chrome gives
  // content scripts no frame id for an iframe element (chrome.runtime.getFrameId is undefined there in Chrome 154),
  // so a sibling hidden only by opacity, visibility or clipping that has a visible twin of the same size can take
  // the twin's match; that case is not closed.
  const kept: typeof answered = [];
  const used = new Set<string>();
  for (const k of answered.filter((x) => x.f.parentFrameId < 0).concat(answered.filter((x) => x.f.parentFrameId >= 0))) {
    if (k.r.origin !== k.origin) {
      missing.push({ frameId: k.f.frameId, reason: `its document's origin ${k.r.origin} is not ${k.origin}` });
      continue;
    }
    if (k.f.parentFrameId >= 0) {
      const parent = kept.find((p) => p.f.frameId === k.f.parentFrameId);
      const [vw, vh] = k.r.viewport;
      const src = k.f.url.startsWith("about:") ? "about:" : (() => {
        const u = new URL(k.f.url);
        return `${u.origin}${u.pathname}`;
      })();
      const fits = (i: { rect: [number, number, number, number] }): boolean => i.rect[2] - vw >= 0 && i.rect[2] - vw <= FRAME_CHROME_PX && i.rect[3] - vh >= 0 && i.rect[3] - vh <= FRAME_CHROME_PX;
      const candidates = parent === undefined || vw <= 1 || vh <= 1 ? [] : parent.r.iframes.map((i, n) => ({ i, key: `${parent.f.frameId}:${n}` })).filter((c) => !used.has(c.key) && fits(c.i));
      const pick = candidates.find((c) => c.i.src.startsWith(src)) ?? candidates[0];
      if (pick === undefined) {
        missing.push({ frameId: k.f.frameId, reason: "its <iframe> is not visible in the parent frame" });
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
    browserWindowId: tab.windowId,
    active: tab.active,
    title: tab.title ?? "",
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
      iframes: r.iframes,
      excluded: r.excluded,
      truncated: r.truncated,
    })),
    missing: missing.sort((a, b) => a.frameId - b.frameId),
    focused: focusedFrame?.r.focused === undefined || focusedFrame.r.focused === null ? null : { frameId: focusedFrame.f.frameId, ...focusedFrame.r.focused },
  });
  result(id, { outcome: "ok", detail: null });
}

async function act(verb: ActVerb, expires: number): Promise<ActAnswer> {
  if (verb.kind === "pageChooseOption" || verb.kind === "pageAttachFile") return { outcome: "unsupported", detail: `${verb.kind} arrives in batch 2` };
  if (verb.kind === "pagePress") {
    // Every page press is a hand-off in v1: the button runs the page's own script (content/actions.ts). The page is not touched.
    const risk = classifyPress(verb.name);
    return { outcome: "handoff", detail: `'${verb.name}' runs the page's own script, so you press it`, risk: risk === "safe" || risk === "unclassified" ? "pageScript" : risk };
  }
  const g = grants.check(verb.taskId, verb.tabId, verb.frameId);
  if (!g.ok) return { outcome: "notAllowed", detail: g.reason };
  const frame = await chrome.webNavigation.getFrame({ tabId: verb.tabId, frameId: verb.frameId }).catch(() => null);
  if (frame === null || frame === undefined) return { outcome: "stale", detail: "the frame is gone" };
  if (frame.documentId !== verb.documentId) return { outcome: "stale", detail: "the frame holds another document than when it was walked" };
  const gen = navGens.get(verb.tabId, verb.frameId);
  if (gen !== g.scope.navGen) return { outcome: "stale", detail: `the frame navigated since the grant (navGen ${g.scope.navGen}, now ${gen})` };
  const all = (await chrome.webNavigation.getAllFrames({ tabId: verb.tabId })) ?? [];
  const origin = frameOrigin(all, verb.frameId);
  if (origin !== g.scope.origin) return { outcome: "notAllowed", detail: `the grant covers ${g.scope.origin}, the frame is at ${String(origin)}` };
  // The frame lookups above awaited; a revoke or expiry that landed meanwhile stops the act here, before the page.
  const live = grants.check(verb.taskId, verb.tabId, verb.frameId);
  if (!live.ok) return { outcome: "notAllowed", detail: live.reason };
  // Read the generation again now, not the one taken before the awaits: a history change meanwhile is stale (W1 review #4).
  const genNow = navGens.get(verb.tabId, verb.frameId);
  if (live.scope.navGen !== genNow || live.scope.origin !== origin) return { outcome: "stale", detail: `the frame moved during the check (navGen ${live.scope.navGen}, now ${genNow})` };
  const deadline = Math.min(expires, live.expires);
  try {
    const msg: ToContent = { caret: 1, op: "act", verb, deadline };
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
chrome.tabs.onRemoved.addListener((tabId) => navGens.forgetTab(tabId));

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

// Tabs open before install have no content script; give them one. A tab that already has one keeps it (content.ts).
chrome.runtime.onInstalled.addListener(() => {
  void chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).then((tabs) => {
    for (const t of tabs) if (t.id !== undefined) void chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ["content.js"] }).catch(() => {});
  });
});

connect();
