// Caret's content script, in every http(s) frame and the about:blank and srcdoc frames they own. It stays dormant:
// no observer, no timer and no walk until the worker asks. It answers only the extension's own worker (a message
// with no tab, from this extension's id), never window.postMessage or the page. On its own it tells the worker two
// things, neither naming an element: that the document moved in history, so the worker bumps the frame's
// navigation generation at once; and that focus moved while this document is visible and focused, so the helper
// can walk the tab the user is in (W2). The second is one focusin listener, at most one message per 150 ms.
import type { FocusMoved, FrameReport, GrantAlive, NavChanged, ToContent } from "./shared/messages.ts";
import { act } from "./content/actions.ts";
import { clean } from "./content/names.ts";
import { Registry, navigationEntry } from "./content/registry.ts";
import { deepActiveElement, visible, walkControls } from "./content/walker.ts";

declare global {
  // Set once per isolated world, so a script injected again after install (worker onInstalled) does nothing.
  var __caretContent: true | undefined;
}

function srcOf(f: HTMLIFrameElement): string {
  if (f.hasAttribute("srcdoc")) return "about:srcdoc";
  try {
    const u = new URL(f.src, location.href);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : `${u.protocol}`;
  } catch {
    return "";
  }
}

/** An iframe's content box, which is its child document's viewport: client size less padding. */
function contentBox(f: HTMLIFrameElement): [number, number] {
  const cs = getComputedStyle(f);
  const px = (v: string): number => Number.parseFloat(v) || 0;
  return [f.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight), f.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom)];
}

function walk(reg: Registry): FrameReport {
  const href = location.href;
  const nav = navigationEntry();
  const out = walkControls((el) => reg.idOf(el), (el, c) => reg.remember(c.id, el, { strongKey: c.strongKey, kind: c.kind, name: c.name, href, nav, form: c.form }));
  const active = deepActiveElement();
  let focused: FrameReport["focused"] = null;
  if (active !== null) {
    const c = out.controls.find((x) => reg.entry(x.id)?.ref.deref() === active);
    if (c !== undefined) {
      let selection: [number, number] | null = null;
      try {
        const t = active as HTMLInputElement;
        if (typeof t.selectionStart === "number" && typeof t.selectionEnd === "number") selection = [t.selectionStart, t.selectionEnd];
      } catch {
        selection = null;
      }
      focused = { id: c.id, selection };
    }
  }
  const r = (el: Element): [number, number, number, number] => {
    const b = el.getBoundingClientRect();
    return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
  };
  return {
    // The document's own origin, not its URL's: opaque ("null") for a sandboxed frame, the parent's for an
    // about:blank or srcdoc frame that inherits it (W1 review, round 2, #8).
    origin: self.origin,
    path: location.protocol === "about:" ? location.href : location.pathname,
    title: clean(document.title, 200),
    headings: [...document.querySelectorAll("h1, h2")].filter((x) => visible(x)).slice(0, 10).map((h) => clean(h.textContent, 120)).filter((t) => t !== ""),
    controls: out.controls,
    // Each visible iframe with a content box over a pixel each way, and that box's size, which is exactly its child
    // document's viewport: the worker matches child frames to these (worker.ts walk). Chrome gives content scripts no
    // frame id for an element (chrome.runtime.getFrameId is undefined there in Chrome 154).
    iframes: [...document.querySelectorAll("iframe")].filter((f) => visible(f) && contentBox(f)[0] > 1 && contentBox(f)[1] > 1).map((f) => ({ src: srcOf(f), rect: r(f), inner: contentBox(f) })),
    viewport: [window.innerWidth, window.innerHeight],
    excluded: out.excluded,
    truncated: out.truncated,
    focused,
    hasFocus: document.hasFocus(),
  };
}

function isToContent(m: unknown): m is ToContent {
  if (typeof m !== "object" || m === null) return false;
  const x = m as Record<string, unknown>;
  return x.caret === 1 && (x.op === "walk" || (x.op === "act" && typeof x.verb === "object" && x.verb !== null && typeof x.deadline === "number"));
}

if (globalThis.__caretContent === undefined) {
  globalThis.__caretContent = true;
  const reg = new Registry();

  chrome.runtime.onMessage.addListener((m: unknown, sender, reply) => {
    // Only this extension's worker: a content script's own message would carry a tab, and nothing else can reach here.
    if (sender.id !== chrome.runtime.id || sender.tab !== undefined || !isToContent(m)) return false;
    if (m.op === "walk") {
      reply(walk(reg));
      return false;
    }
    const taskId = m.verb.taskId;
    const alive = async (): Promise<boolean> => {
      const q: GrantAlive = { caret: 1, op: "grantAlive", taskId };
      return chrome.runtime.sendMessage(q).then((r: unknown) => r === true, () => false);
    };
    act(reg, m.verb, m.deadline, alive).then(reply, (e: unknown) => reply({ outcome: "error", detail: e instanceof Error ? e.message : String(e) }));
    return true;
  });

  /** Assumed: one report per burst of focus changes is enough for the helper to walk once. */
  const FOCUS_EVERY_MS = 150;
  let focusTimer: ReturnType<typeof setTimeout> | null = null;
  addEventListener(
    "focusin",
    () => {
      if (focusTimer !== null || document.visibilityState !== "visible" || !document.hasFocus()) return;
      focusTimer = setTimeout(() => {
        focusTimer = null;
        if (document.visibilityState !== "visible" || !document.hasFocus()) return;
        const m: FocusMoved = { caret: 1, op: "focusMoved" };
        chrome.runtime.sendMessage(m).catch(() => {});
      }, FOCUS_EVERY_MS);
    },
    { capture: true, passive: true },
  );

  const moved = (why: NavChanged["why"]): void => {
    const m: NavChanged = { caret: 1, op: "navChanged", why };
    chrome.runtime.sendMessage(m).catch(() => {});
  };
  addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    reg.clear();
    moved("pageshow");
  });
  addEventListener("popstate", () => moved("popstate"));
  addEventListener("hashchange", () => moved("hashchange"));
}
