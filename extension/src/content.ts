// Caret's content script, in every http(s) frame and the about:blank and srcdoc frames they own. It stays dormant:
// no observer, no timer and no walk until the worker asks. It answers only the extension's own worker (a message
// with no tab, from this extension's id), never window.postMessage or the page. On its own it tells the worker two
// things, neither naming an element: that the document moved in history, so the worker bumps the frame's
// navigation generation at once; and that focus moved while this document is visible and focused, so the helper
// can walk the tab the user is in (W2). The second is one focusin listener, at most one message per 150 ms. P3 sends
// the same focus report when a top-frame document becomes ready (three times at most, the last from one timer a second
// after load), so the helper can offer a page's fill when it loads.
//
// W3 adds a third, only while the worker has armed this frame because a grant covers it: the user pressed a pointer
// or a key here. Only events the browser marks trusted count, so neither the page's script nor Caret's own synthetic
// events (the combobox handler's presses) can raise it; nothing about the element or the key travels.
//
// S1 adds a passive input listener that sends nothing: per text field, in memory, it notes whether the text came from
// the user's own typing (content/entry.ts). A walk reports that one word per field, so Caret saves an answer as the
// user's words only when they typed it.
import type { FocusMoved, FrameReport, GrantAlive, NavChanged, ToContent, UserActed } from "./shared/messages.ts";
import { act } from "./content/actions.ts";
import { isUsersOwn } from "./shared/input.ts";
import { clean } from "./content/names.ts";
import { Registry, navigationEntry } from "./content/registry.ts";
import { deepActiveElement, visible, walkControls } from "./content/walker.ts";
import { EntryTracker } from "./content/entry.ts";

declare global {
  // Set once per isolated world, so a script injected again after install (worker onInstalled) does nothing.
  var __caretContent: true | undefined;
  // Set by the worker's onInstalled, in this isolated world, just before it injects this script into a document that was
  // already open: listeners the page registered before ours can hide the user's input from Caret there (W3 review #5).
  var __caretLate: true | undefined;
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

function walk(reg: Registry, entries: EntryTracker | null): FrameReport {
  const t0 = performance.now();
  const href = location.href;
  const nav = navigationEntry();
  const out = walkControls(
    (el) => reg.idOf(el),
    (el, c) => reg.remember(c.id, el, { strongKey: c.strongKey, kind: c.kind, name: c.name, href, nav, form: c.form }),
    (el, value) => entries?.entryOf(el, value),
  );
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
    walkMs: Math.round((performance.now() - t0) * 10) / 10,
  };
}

function isToContent(m: unknown): m is ToContent {
  if (typeof m !== "object" || m === null) return false;
  const x = m as Record<string, unknown>;
  return x.caret === 1 && (x.op === "walk" || x.op === "viewport" || (x.op === "guard" && typeof x.until === "number") || (x.op === "act" && typeof x.verb === "object" && x.verb !== null && typeof x.deadline === "number" && typeof x.guardUntil === "number"));
}

if (globalThis.__caretContent === undefined) {
  globalThis.__caretContent = true;
  const reg = new Registry();
  /** Until when this document reports the user's own input (a grant covers the frame); 0 when not. */
  let guardUntil = 0;
  /**
   * Trusted presses seen while armed. An act notes the count when it starts and stops at any stage once it moved, so a
   * grant reply already on its way when the user clicked cannot let the next stage through (W3 review #4).
   */
  let takeovers = 0;
  /** Injected after the document loaded: its own earlier listeners may hide the user's input, so it takes no act. */
  const late = globalThis.__caretLate === true;
  /**
   * How each text field's text was entered (S1). Not kept in a late-injected document: edits made before this script
   * arrived were never seen, so no field there can be shown to hold only the user's typing.
   */
  const entries = late ? null : new EntryTracker();
  if (entries !== null) {
    addEventListener(
      "beforeinput",
      (e) => {
        const el = e.composedPath()[0];
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) entries.onBefore(el, el.value);
      },
      { capture: true, passive: true },
    );
    addEventListener(
      "input",
      (e) => {
        const el = e.composedPath()[0];
        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
        entries.onInput(el, e.isTrusted, e instanceof InputEvent ? e.inputType : "", el.value, e instanceof InputEvent ? e.data : null);
      },
      { capture: true, passive: true },
    );
  }

  chrome.runtime.onMessage.addListener((m: unknown, sender, reply) => {
    // Only this extension's worker: a content script's own message would carry a tab, and nothing else can reach here.
    if (sender.id !== chrome.runtime.id || sender.tab !== undefined || !isToContent(m)) return false;
    if (m.op === "walk") {
      reply(walk(reg, entries));
      return false;
    }
    if (m.op === "viewport") {
      reply([window.innerWidth, window.innerHeight]);
      return false;
    }
    if (m.op === "guard") {
      guardUntil = m.until;
      reply(true);
      return false;
    }
    if (late) {
      reply({ outcome: "notAllowed", detail: "this page was open before Caret was installed; reload it, so Caret can tell your own clicks from its writes there" });
      return false;
    }
    // The act arms this document itself for as long as its grant runs, whatever became of the worker's guard message.
    guardUntil = Math.max(guardUntil, m.guardUntil);
    const taskId = m.verb.taskId;
    const start = takeovers;
    const alive = async (): Promise<boolean> => {
      if (takeovers !== start) return false;
      const q: GrantAlive = { caret: 1, op: "grantAlive", taskId };
      const ok = await chrome.runtime.sendMessage(q).then((r: unknown) => r === true, () => false);
      return ok && takeovers === start;
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

  /**
   * P3, ready on load: a top-frame document that became ready is reported the way focus is, so the helper walks the
   * tab the user is in and may offer its fill with no field in focus (helper.ts pageWalked, which asks at most once per
   * document). Nothing about the page travels; the worker checks the tab is the active one as for focus. Reported at
   * DOMContentLoaded, at load, and once more READY_LATE_MS after load for a form the page's own scripts render late.
   */
  const READY_LATE_MS = 1000;
  if (window === window.top) {
    const ready = (): void => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      const m: FocusMoved = { caret: 1, op: "focusMoved" };
      chrome.runtime.sendMessage(m).catch(() => {});
    };
    const loaded = (): void => {
      ready();
      setTimeout(ready, READY_LATE_MS);
    };
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", ready, { once: true });
    else ready();
    if (document.readyState !== "complete") addEventListener("load", loaded, { once: true });
    else setTimeout(ready, READY_LATE_MS);
  }

  /**
   * The user's own pointer or key press while a grant covers this frame: the worker drops the frame's grants and the
   * helper pauses the task (W3). Capture on the window, registered at document_start, so the page's own listeners
   * cannot hide it from Caret; passive, so it never delays the page. At most one report per 150 ms.
   */
  let lastInput = 0;
  const onInput = (e: Event): void => {
    if (!isUsersOwn(e) || Date.now() >= guardUntil) return;
    takeovers++;
    const now = Date.now();
    if (now - lastInput < FOCUS_EVERY_MS) return;
    lastInput = now;
    const m: UserActed = { caret: 1, op: "userInput", kind: e.type === "keydown" ? "key" : "mouse" };
    chrome.runtime.sendMessage(m).catch(() => {});
  };
  addEventListener("pointerdown", onInput, { capture: true, passive: true });
  addEventListener("keydown", onInput, { capture: true, passive: true });

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
