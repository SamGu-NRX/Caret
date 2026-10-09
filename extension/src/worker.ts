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
//
// P4 adds one read that is not a walk: the visible text of the tab the user just left, once, when the helper asks
// because a fill needs its source (readText). The worker alone knows which tab that is (worker/left-tab.ts): it notes
// the tab, its frames' documents and their navigation generations as the user leaves it, and reads it only within
// LEFT_TAB_MS, only while every one of those is unchanged, never on a site Caret is off for or denies, and only by one
// message to each of that tab's own frames. No other tab is touched and no observer is attached.
import type { ActAnswer, ActVerb, FrameReport, FrameSelfAnswer, FrameTextAnswer, NavChanged, TabText, ToContent, UserActed } from "./shared/messages.ts";
import { GrantTable } from "./shared/grants.ts";
import { classifyPress } from "./shared/risk.ts";
import { FrameDocs, NavGens, frameOrigin } from "./worker/frames.ts";
import { composeFrames, isCaptchaUrl, type CaptchaFrame } from "./worker/compose.ts";
import { judgePress, type FrameMarks } from "./worker/press-guard.ts";
import { Chunks, parseFromHelper, type FromHelper } from "./worker/wire.ts";
import { LEFT_TAB_MS, LeftTab, deniedOrigin, type FrameMark } from "./worker/left-tab.ts";
import { joinFrames } from "./shared/tab-text.ts";
import { sectionTokens, type FrameSections } from "./worker/section-names.ts";

/** SCP1: a frame's sections as the snapshot carries them: tokens, never digests or the salt. */
function sectionsOf(s: FrameSections | undefined): { sections?: FrameSections["sections"]; sectionNames?: string[]; sectionsCut?: true } {
  if (s === undefined) return {};
  return { ...(s.sections.length === 0 ? {} : { sections: s.sections }), ...(s.sectionNames.length === 0 ? {} : { sectionNames: s.sectionNames }), ...(s.sectionsCut ? { sectionsCut: true as const } : {}) };
}

const HOST = "ai.caret.bridge";
const VERSION = chrome.runtime.getManifest().version;
/** How long a frame has to answer a walk. Assumed: a walk of a large form measured in tens of milliseconds. */
const FRAME_WALK_MS = 1500;
const instance = crypto.randomUUID();
const startedAt = Date.now();

const grants = new GrantTable({ wall: () => Date.now(), mono: () => performance.now() });
const navGens = new NavGens();
/** Navigations begun in each frame (webNavigation.onBeforeNavigate), counted as navGens are: a Yes/No press checks it (B28). */
const navStarts = new NavGens();
/**
 * How long after a Yes/No press's answer the worker still watches its frame for a navigation the click began. Assumed,
 * not measured: browser-side navigation events reach the worker within a few tens of milliseconds.
 */
const POST_PRESS_MS = 250;
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
    ...(a.pageChanged === undefined ? {} : { pageChanged: a.pageChanged }),
    ...(a.text === undefined ? {} : { text: a.text }),
    ...(a.insert === undefined ? {} : { insert: a.insert }),
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
      send({ type: "pageHello", v: 1, extensionId: chrome.runtime.id, version: VERSION, profile: await profileId(), instance, startedAt, capabilities: ["pageWalk", "pageWrite", "pageSelect", "pageSetChecked", "pagePress", "pageChooseOption", "pageAttachFile", "pageFocus", "pageSitesOff", "pageInput", "pageReadText", "pageInsertText"] });
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
    case "pageReadText": {
      if (engine === null) return;
      if (Date.now() >= m.expires) return result(m.id, { outcome: "error", detail: "the read expired before it arrived" });
      const a = await readText(m.tabId).catch((e: unknown): ActAnswer => ({ outcome: "error", detail: e instanceof Error ? e.message : String(e) }));
      // The helper stopped waiting: the text is not sent at all.
      if (Date.now() >= m.expires) return result(m.id, { outcome: "error", detail: "the read took longer than the helper waits" });
      return result(m.id, a);
    }
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
  // P1: the walk's time in the extension, from the command to the snapshot sent (frames asked in parallel).
  const t0 = performance.now();
  const tab = tabId === null ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] : await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.id === undefined) return result(id, { outcome: "noElement", detail: tabId === null ? "no active tab in the focused window" : `no tab ${tabId}` });
  const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) ?? [];
  const top = frameOrigin(frames, 0);
  if (top !== null && sitesOff.has(top)) return result(id, { outcome: "siteOff", detail: `Caret is off on ${top}` });
  // A tab whose page is on the deny list (password managers, account pages) is not walked at all: no frame of it is
  // asked, so no title, heading, label or value of it leaves the page.
  if (top !== null && deniedOrigin(top)) return result(id, { outcome: "siteOff", detail: "Caret never reads this site" });
  const missing: { frameId: number; reason: string }[] = [];
  const captchas: CaptchaFrame[] = [];
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
      if (deniedOrigin(origin)) {
        missing.push({ frameId: f.frameId, reason: "Caret never reads this site" });
        return null;
      }
      // A captcha frame is never walked; only its viewport is asked, for the frame count (compose.ts, W4).
      if (isCaptchaUrl(f.url)) {
        const msg: ToContent = { caret: 1, op: "viewport" };
        const v = (await withTimeout(chrome.tabs.sendMessage(tab.id as number, msg, { frameId: f.frameId, documentId: f.documentId }), FRAME_WALK_MS, `frame ${f.frameId}`).catch(() => null)) as unknown;
        const ok = Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));
        captchas.push({ f, viewport: ok ? (v as [number, number]) : null });
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
  const answered = reports.filter((x): x is NonNullable<typeof x> => x !== null);
  // Which answered frames are kept, and why the others are not: compose.ts.
  const composed = composeFrames(frames, answered, captchas);
  const kept = composed.kept;
  missing.push(...composed.missing);
  if (kept.length === 0) return result(id, { outcome: "noElement", detail: `no frame of tab ${tab.id} answered: ${missing.map((m) => m.reason).join("; ")}` });
  const focusedFrame = kept.filter((k) => k.r.focused !== null).sort((a, b) => Number(b.r.hasFocus) - Number(a.r.hasFocus))[0];
  // H10: where the tab's viewport is on screen, so the helper can give each control a screen frame. From the top frame
  // only: a child frame reports its own viewport, and the window is the same for every frame.
  const topReport = answered.find((x) => x.f.frameId === 0)?.r;
  const zoom = await chrome.tabs.getZoom(tab.id).catch(() => null);
  // SCP1: section name tokens across every kept frame, under one salt made for this snapshot (worker/section-names.ts).
  const named = await sectionTokens(kept.map((k) => k.r));
  const view = topReport !== undefined && Array.isArray(topReport.screen) && zoom !== null && zoom > 0 ? { window: topReport.screen, viewport: topReport.viewport, zoom } : null;
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
    frames: kept.map(({ f, r, origin }, i) => ({
      frameId: f.frameId,
      parentFrameId: f.parentFrameId,
      documentId: f.documentId,
      origin,
      path: r.path,
      navGen: navGens.get(tab.id as number, f.frameId),
      title: r.title,
      headings: r.headings,
      ...sectionsOf(named[i]),
      controls: r.controls,
      iframes: r.iframes.map((i) => ({ src: i.src, rect: i.rect })),
      excluded: r.excluded,
      truncated: r.truncated,
      ...(typeof r.walkMs === "number" ? { walkMs: r.walkMs } : {}),
    })),
    missing: missing.sort((a, b) => a.frameId - b.frameId),
    focused:
      focusedFrame?.r.focused === undefined || focusedFrame.r.focused === null
        ? null
        : {
            frameId: focusedFrame.f.frameId,
            ...focusedFrame.r.focused,
            // H13 review: whether that frame's document has focus now; after a click in the address bar none does, and
            // the host takes its inline text down rather than let Tab take it.
            hasFocus: focusedFrame.r.hasFocus === true,
          },
    view,
    walkMs: Math.round((performance.now() - t0) * 10) / 10,
  });
  result(id, { outcome: "ok", detail: null });
}

/** A frame's answer about itself (no text), checked for the shape composition reads; anything else is no answer. */
function isFrameSelf(x: unknown): x is FrameSelfAnswer {
  if (typeof x !== "object" || x === null) return false;
  const a = x as Record<string, unknown>;
  return typeof a.origin === "string" && Array.isArray(a.viewport) && a.viewport.length === 2 && Array.isArray(a.iframes);
}

/** A frame's text, checked for the shape the worker reads; anything else is no answer. */
function isTextAnswer(x: unknown): x is FrameTextAnswer {
  if (typeof x !== "object" || x === null) return false;
  const a = x as Record<string, unknown>;
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === "string");
  return strings(a.selection) && strings(a.blocks) && typeof a.cut === "boolean" && (a.docsText === null || a.docsText === "on" || a.docsText === "off");
}

/**
 * P4: the visible text of `tabId`, which must be the tab the user just left (rules 1 and 2: worker/left-tab.ts), on no
 * site Caret is off for or denies (rule 5). Each frame noted when the user left, still the same document, is first
 * asked about itself only (its viewport and visible iframes, no text); only frames composition shows visible (item 5)
 * are then asked for their text, once each (rule 3), pinned to that document, so no hidden frame's text ever leaves it.
 * The tab is checked again after the frames answered, so a navigation during the read discards it. The text is capped
 * over all frames (rule 4).
 */
async function readText(tabId: number): Promise<ActAnswer> {
  const marksOf = (rows: chrome.webNavigation.GetAllFrameResultDetails[]) => rows.map((f) => ({ frameId: f.frameId, documentId: f.documentId, navGen: navGens.get(tabId, f.frameId) }));
  const rows = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? [];
  const ok = leftTab.check(tabId, Date.now(), marksOf(rows));
  if (!ok.ok) return { outcome: "notAllowed", detail: ok.why };
  const record = leftTab.last();
  if (record === null) return { outcome: "notAllowed", detail: "it is not the tab you just left" };
  const top = frameOrigin(rows, 0);
  if (top === null || sitesOff.has(top) || deniedOrigin(top)) return { outcome: "siteOff", detail: "Caret never reads this site" };
  // A frame refuses to give text after the moment the read may no longer happen (rule 2's LEFT_TAB_MS).
  const until = record.at + LEFT_TAB_MS;
  const ask = async (frameId: number, documentId: string, op: "frame" | "text"): Promise<unknown> => {
    const msg: ToContent = op === "frame" ? { caret: 1, op } : { caret: 1, op, until };
    return withTimeout(chrome.tabs.sendMessage(tabId, msg, { frameId, documentId }), FRAME_WALK_MS, `frame ${frameId}`).catch(() => null);
  };
  const selves = await Promise.all(
    ok.frames.map(async (m) => {
      const f = rows.find((r) => r.frameId === m.frameId);
      const origin = frameOrigin(rows, m.frameId);
      if (f === undefined || origin === null) return null;
      // Never asked: a frame on a site that is off or denied, and a captcha's, which is the user's to answer.
      if (sitesOff.has(origin) || deniedOrigin(origin) || isCaptchaUrl(f.url)) return null;
      const r = await ask(m.frameId, m.documentId, "frame");
      return isFrameSelf(r) ? { f, r, origin } : null;
    }),
  );
  const composed = composeFrames(rows, selves.filter((x): x is NonNullable<typeof x> => x !== null), []);
  if (!composed.kept.some((k) => k.f.frameId === 0)) return { outcome: "noElement", detail: "the tab's top frame did not answer" };
  // Everything that allowed the read is checked again before any text is asked for: the frames answered over time,
  // and meanwhile the user may have come back to the tab, it may have moved, or a site may have been turned off.
  const rowsNow = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? [];
  const still = leftTab.check(tabId, Date.now(), marksOf(rowsNow));
  if (!still.ok) return { outcome: "stale", detail: still.why };
  const topNow = frameOrigin(rowsNow, 0);
  if (topNow === null || sitesOff.has(topNow) || deniedOrigin(topNow) || composed.kept.some((k) => sitesOff.has(k.origin))) return { outcome: "siteOff", detail: "Caret never reads this site" };
  const texts = await Promise.all(composed.kept.filter((k) => still.frames.some((m) => m.frameId === k.f.frameId)).map(async (k) => {
    const t = await ask(k.f.frameId, k.f.documentId, "text");
    return isTextAnswer(t) ? { ...k, t } : null;
  }));
  const again = leftTab.check(tabId, Date.now(), marksOf((await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? []));
  if (!again.ok) return { outcome: "stale", detail: again.why };
  const kept = texts.filter((k): k is NonNullable<typeof k> => k !== null && again.frames.some((m) => m.frameId === k.f.frameId));
  if (!kept.some((k) => k.f.frameId === 0)) return { outcome: "noElement", detail: "the tab's top frame gave no text" };
  const joined = joinFrames(kept.map((k) => ({ selection: k.t.selection, blocks: k.t.blocks })));
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const text: TabText = {
    tabId,
    leftAt: record.at,
    title: tab?.title ?? "",
    frames: kept.map((k) => ({ frameId: k.f.frameId, origin: k.origin })),
    selection: joined.selection,
    blocks: joined.blocks,
    cut: joined.cut || kept.some((k) => k.t.cut),
    docsText: kept.find((k) => k.f.frameId === 0)?.t.docsText ?? null,
  };
  return { outcome: "ok", detail: null, text };
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
  // A Yes/No press (W4) must not navigate or submit (B28): the frame is read before it and after its answer.
  const press = verb.kind === "pageChooseOption" && verb.question !== undefined;
  const marks = (): FrameMarks => ({ navGen: navGens.get(verb.tabId, verb.frameId), starts: navStarts.get(verb.tabId, verb.frameId) });
  const before = marks();
  let a: ActAnswer | null;
  try {
    const msg: ToContent = { caret: 1, op: "act", verb, deadline, guardUntil: live.expires };
    const got = (await withTimeout(chrome.tabs.sendMessage(verb.tabId, msg, { frameId: verb.frameId, documentId: verb.documentId }), Math.max(100, deadline - Date.now() + 1000), "the frame")) as ActAnswer | undefined;
    if (got === undefined || typeof got !== "object" || typeof got.outcome !== "string") {
      if (!press) return { outcome: "error", detail: "the frame gave no answer" };
      a = { outcome: "error", detail: "the frame gave no answer" };
    } else a = got;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A press was delivered and its document went before it answered (the channel closed under it, or the page went
    // into the back-forward cache): it may have landed, so it is judged below as a change, never as stale.
    if (press && /message (?:channel|port) closed|back\/forward cache/i.test(msg)) a = null;
    // The pinned document is gone between the check and the delivery: a navigation won the race.
    else if (/Could not establish connection|Receiving end does not exist|No frame|document/i.test(msg)) return { outcome: "stale", detail: `the document is gone: ${msg}` };
    else if (!press) return { outcome: "error", detail: msg };
    else a = { outcome: "error", detail: msg };
  }
  if (!press) return a as ActAnswer;
  if (a?.outcome === "ok") await new Promise((r) => setTimeout(r, POST_PRESS_MS));
  const judged = judgePress(a, before, marks());
  // The run stops at once: the task's grants end here, before the helper hears of it, so nothing else of it acts.
  if (judged.pageChanged !== undefined) revokeTask(verb.taskId);
  return judged;
}

// Navigation generations: every way a frame's document or history entry changes.
chrome.webNavigation.onCommitted.addListener((d) => void navGens.bump(d.tabId, d.frameId));
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => void navGens.bump(d.tabId, d.frameId));
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => void navGens.bump(d.tabId, d.frameId));
chrome.webNavigation.onBeforeNavigate.addListener((d) => void navStarts.bump(d.tabId, d.frameId));
chrome.tabs.onRemoved.addListener((tabId) => {
  navGens.forgetTab(tabId);
  navStarts.forgetTab(tabId);
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
 * Focus moved in a frame of a tab, or (H13) the user typed in its focused field. Passed to the helper only when the tab
 * is the active tab of the last focused browser window, its site and its frame's site are not off, and an engine is
 * connected; at most one per FOCUS_EVERY_MS per tab. One that comes sooner is held and sent when that time is up, the
 * latest frame's, so the last keystroke of a burst is never lost: the host's inline text would stay on the text before
 * it. Nothing about the element travels. A page on the deny list reports too, with the same three numbers: the walk
 * the helper then asks for is refused (siteOff), which tells the host no field of Caret's has focus there.
 */
const heldFocus = new Map<number, { frameId: number; timer: ReturnType<typeof setTimeout> }>();
function forwardFocus(tabId: number, frameId: number): void {
  const now = Date.now();
  lastFocus.set(tabId, now);
  void (async () => {
    const [tab, win, all] = await Promise.all([chrome.tabs.get(tabId).catch(() => undefined), chrome.windows.getLastFocused().catch(() => undefined), chrome.webNavigation.getAllFrames({ tabId })]);
    if (engine === null || tab === undefined || !tab.active || win === undefined || tab.windowId !== win.id || !win.focused) return;
    const top = frameOrigin(all ?? [], 0);
    const here = frameOrigin(all ?? [], frameId);
    if ((top !== null && sitesOff.has(top)) || (here !== null && sitesOff.has(here))) return;
    send({ type: "pageFocus", v: 1, at: now, tabId, frameId });
  })();
}
chrome.runtime.onMessage.addListener((m: unknown, sender) => {
  const x = m as { caret?: unknown; op?: unknown } | null;
  if (x?.caret !== 1 || x.op !== "focusMoved") return false;
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId === undefined || engine === null) return false;
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  const wait = (lastFocus.get(tabId) ?? 0) + FOCUS_EVERY_MS - Date.now();
  if (wait <= 0) {
    forwardFocus(tabId, frameId);
    return false;
  }
  const held = heldFocus.get(tabId);
  if (held !== undefined) held.frameId = frameId;
  else {
    const entry = {
      frameId,
      timer: setTimeout(() => {
        heldFocus.delete(tabId);
        forwardFocus(tabId, entry.frameId);
      }, wait),
    };
    heldFocus.set(tabId, entry);
  }
  return false;
});

/**
 * H10: the tab the user is in changed (another tab selected, another browser window focused) or its zoom changed. The
 * helper walks the new active tab as for a focus report, so the host learns which field, if any, has focus there now,
 * rather than keeping the field of a tab the user left. Sent only for the active tab of the focused window. Sent for a
 * site Caret is off for too: the walk is refused there (siteOff), which tells the host no field of Caret's has focus,
 * so an offer drawn for the tab the user left goes (H10 review). Nothing about the site travels.
 */
async function frontTabChanged(): Promise<void> {
  if (engine === null) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [] as chrome.tabs.Tab[]);
  const win = await chrome.windows.getLastFocused().catch(() => undefined);
  if (tab?.id === undefined || win === undefined || !win.focused || tab.windowId !== win.id) return;
  const now = Date.now();
  if (now - (lastFocus.get(tab.id) ?? 0) < FOCUS_EVERY_MS) return;
  lastFocus.set(tab.id, now);
  send({ type: "pageFocus", v: 1, at: now, tabId: tab.id, frameId: 0 });
}
chrome.tabs.onActivated.addListener(() => void frontTabChanged());
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void frontTabChanged();
});
chrome.tabs.onZoomChange.addListener(() => void frontTabChanged());

/**
 * P4: which tab the user just left (worker/left-tab.ts). The tab the user is in is kept from the events themselves, in
 * their order: each window's active tab (tabs.onActivated) and the focused window (windows.onFocusChanged). So every
 * move is seen, a quick Ctrl-Tab through three tabs included, and the tab being left has its time, its frames, their
 * documents and their navigation generations taken in the very event that left it (rule 2), from the frame registry
 * webNavigation keeps up to date (FrameDocs). Kept whether or not an engine is connected: it is what
 * the user did, and nothing is sent.
 */
const leftTab = new LeftTab();
const frameDocs = new FrameDocs();
let focusedWindow: number | null = null;
/** Whether a windows.onFocusChanged came before the start-up read; then that read must not overwrite it. */
let focusSeen = false;
const activeByWindow = new Map<number, number>();
/** The frames of a tab as the worker knows them now, each with its document and navigation generation. */
const framesNow = (tabId: number): FrameMark[] => frameDocs.of(tabId).map((f) => ({ ...f, navGen: navGens.get(tabId, f.frameId) }));
function frontNow(): void {
  const tabId = focusedWindow === null ? undefined : activeByWindow.get(focusedWindow);
  const next = focusedWindow === null || tabId === undefined ? null : { tabId, windowId: focusedWindow };
  leftTab.moved(next, Date.now(), framesNow);
}
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  activeByWindow.set(windowId, tabId);
  if (windowId === focusedWindow) frontNow();
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  focusSeen = true;
  focusedWindow = windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId;
  frontNow();
});
chrome.windows.onRemoved.addListener((windowId) => {
  activeByWindow.delete(windowId);
  if (focusedWindow !== windowId) return;
  focusedWindow = null;
  frontNow();
});
// A tab dragged out of a window is no longer that window's active tab; the window it lands in reports its own.
chrome.tabs.onDetached.addListener((tabId, info) => {
  if (activeByWindow.get(info.oldWindowId) !== tabId) return;
  activeByWindow.delete(info.oldWindowId);
  if (info.oldWindowId === focusedWindow) frontNow();
});
chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (activeByWindow.get(info.windowId) === tabId) activeByWindow.delete(info.windowId);
  leftTab.closed(tabId);
  frameDocs.forgetTab(tabId);
});
chrome.tabs.onReplaced.addListener((_added, removed) => {
  leftTab.closed(removed);
  frameDocs.forgetTab(removed);
});
chrome.webNavigation.onCommitted.addListener((d) => frameDocs.committed(d.tabId, d.frameId, d.documentId));
// Where the user is when the worker starts, and the frames already open, merged under what events said first. No
// move is recorded from it.
void Promise.all([
  chrome.windows.getLastFocused().catch(() => undefined),
  chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]),
]).then(async ([win, tabs]) => {
  for (const t of tabs) if (t.active && t.id !== undefined && !activeByWindow.has(t.windowId)) activeByWindow.set(t.windowId, t.id);
  if (!focusSeen && focusedWindow === null && win?.focused === true && win.id !== undefined) focusedWindow = win.id;
  frontNow();
  for (const t of tabs) {
    if (t.id === undefined) continue;
    const rows = (await chrome.webNavigation.getAllFrames({ tabId: t.id }).catch(() => null)) ?? [];
    frameDocs.seed(t.id, rows);
  }
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
