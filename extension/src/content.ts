// Caret's content script, in every http(s) frame and the about:blank and srcdoc frames they own. It stays dormant:
// no observer, no timer and no walk until the worker asks. It answers only the extension's own worker (a message
// with no tab, from this extension's id), never window.postMessage or the page. On its own it tells the worker two
// things, neither naming an element: that the document moved in history, so the worker bumps the frame's
// navigation generation at once; and that focus moved while this document is visible and focused, so the helper
// can walk the tab the user is in (W2). The second is one focusin listener, at most one message per 150 ms, and none
// for a focus change Caret's own act makes (C1, content/own-acts.ts). P3 sends the same focus report when a top-frame
// document becomes ready (three times at most, the last from one timer a second after load), so the helper can offer a
// page's fill when it loads.
//
// W3 adds a third, only while the worker has armed this frame because a grant covers it: the user pressed a pointer
// or a key here. Only events the browser marks trusted count, so neither the page's script nor Caret's own synthetic
// events (the combobox handler's presses) can raise it; nothing about the element or the key travels.
//
// S1 adds a passive input listener that sends nothing: per text field, in memory, it notes whether the text came from
// the user's own typing (content/entry.ts). A walk reports that one word per field, so Caret saves an answer as the
// user's words only when they typed it.
//
// P4 adds one more message the worker may ask, never sent on its own: "text", the frame's visible text, read once
// for the tab the user just left (content/text.ts). A walk also reports the text around the caret of the focused
// field it kept (content/field-text.ts), for the host's inline text.
import type { FieldLook, FocusMoved, FrameReport, FrameSelfAnswer, FrameTextAnswer, GrantAlive, NavChanged, ToContent, UserActed } from "./shared/messages.ts";
import { act } from "./content/actions.ts";
import { isUsersOwn } from "./shared/input.ts";
import { clean, composedParent } from "./content/names.ts";
import { Registry, navigationEntry } from "./content/registry.ts";
import { deepActiveElement, visible, walkControls } from "./content/walker.ts";
import { EntryTracker } from "./content/entry.ts";
import { UserInputs, isUserInput } from "./content/user-input.ts";
import { FOCUS_EVERY_MS, FocusReporter } from "./content/own-acts.ts";
import { docsKind, readFrameText } from "./content/text.ts";
import { docsFocus, fieldText, trackEdits } from "./content/field-text.ts";
import { caretRect } from "./content/caret-rect.ts";
import { trackComposition } from "./content/insert.ts";

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

/** The focused field's text geometry (FieldLook): where its text starts, its size, a placeholder showing, light text. */
function lookOf(el: Element): FieldLook {
  const cs = getComputedStyle(el);
  const px = (v: string): number => Number.parseFloat(v) || 0;
  const t = el as HTMLInputElement;
  const placeholder = typeof t.placeholder === "string" && t.placeholder !== "" && typeof t.value === "string" && t.value === "";
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cs.color);
  const light = rgb !== null && 0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3]) > 140;
  return { inset: px(cs.paddingLeft) + px(cs.borderLeftWidth), fontSize: px(cs.fontSize), placeholder, dark: light };
}

/**
 * Each visible iframe with a content box over a pixel each way, and that box's size, which is exactly its child
 * document's viewport: the worker matches child frames to these (worker/compose.ts). Chrome gives content scripts no
 * frame id for an element (chrome.runtime.getFrameId is undefined there in Chrome 154).
 */
function visibleIframes(): FrameReport["iframes"] {
  const r = (el: Element): [number, number, number, number] => {
    const b = el.getBoundingClientRect();
    return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
  };
  return [...document.querySelectorAll("iframe")].filter((f) => visible(f) && contentBox(f)[0] > 1 && contentBox(f)[1] > 1).map((f) => ({ src: srcOf(f), rect: r(f), inner: contentBox(f) }));
}

/** P4: what the worker needs to tell whether this frame is visible in its parent, before it asks for any text. */
function selfOf(): FrameSelfAnswer {
  return { origin: self.origin, viewport: [window.innerWidth, window.innerHeight], iframes: visibleIframes() };
}

/**
 * P4: this frame's visible text, read once on the worker's message for the tab the user just left (content/text.ts).
 * None after `until`, or while this frame's own viewport is a pixel or less: its iframe was hidden since the worker
 * judged it visible.
 */
function textOf(until: number): FrameTextAnswer {
  if (Date.now() > until || window.innerWidth <= 1 || window.innerHeight <= 1) return { selection: [], blocks: [], cut: false, docsText: null };
  const path = location.protocol === "about:" ? location.href : location.pathname;
  const t = readFrameText(self.origin, path, window.self === window.top);
  return { selection: t.selection, blocks: t.blocks, cut: t.cut, docsText: t.docsText };
}

function walk(reg: Registry, entries: EntryTracker | null, inputs: UserInputs<Element>, caretText: boolean): FrameReport {
  const t0 = performance.now();
  const href = location.href;
  const nav = navigationEntry();
  const now = Date.now();
  const out = walkControls(
    (el) => reg.idOf(el),
    (el, c) => reg.remember(c.id, el, { strongKey: c.strongKey, kind: c.kind, name: c.name, href, nav, form: c.form }),
    (el, value) => entries?.entryOf(el, value),
    (el) => inputs.at(el, now),
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
      // H13: the caret's rect with its text, for the host's inline text; neither on a site on the deny list. SC1 2a: a
      // marked secret field says only that it has focus, never its text, selection, caret or whether it is empty.
      focused = c.excluded !== undefined
        ? { id: c.id, selection: null, text: null, caret: null }
        : { id: c.id, selection, look: lookOf(active), text: caretText ? fieldText(active) : null, caret: caretText ? caretRect(active) : null };
    }
  }
  const docs = window.self === window.top ? docsKind(self.origin, location.pathname) : null;
  return {
    // The document's own origin, not its URL's: opaque ("null") for a sandboxed frame, the parent's for an
    // about:blank or srcdoc frame that inherits it (W1 review, round 2, #8).
    origin: self.origin,
    path: location.protocol === "about:" ? location.href : location.pathname,
    title: clean(document.title, 200),
    // SCP1: one source of section text: the heading list comes from the walk's section outline, after its exclusions
    // by name and by where a heading is, never from a separate read of the page's headings.
    headings: out.headings,
    sections: out.sections,
    ...(out.sectionOverflow.length === 0 ? {} : { sectionOverflow: out.sectionOverflow }),
    ...(out.sectionsCut ? { sectionsCut: true as const } : {}),
    controls: out.controls,
    iframes: visibleIframes(),
    viewport: [window.innerWidth, window.innerHeight],
    screen: [window.screenX, window.screenY, window.outerWidth, window.outerHeight],
    excluded: out.excluded,
    truncated: out.truncated,
    focused,
    ...(docs === null ? {} : { docs: docsFocus(document, docs) }),
    hasFocus: document.hasFocus(),
    walkMs: Math.round((performance.now() - t0) * 10) / 10,
  };
}

function isToContent(m: unknown): m is ToContent {
  if (typeof m !== "object" || m === null) return false;
  const x = m as Record<string, unknown>;
  return x.caret === 1 && (x.op === "walk" || x.op === "frame" || (x.op === "text" && typeof x.until === "number") || x.op === "viewport" || (x.op === "guard" && typeof x.until === "number") || (x.op === "act" && typeof x.verb === "object" && x.verb !== null && typeof x.deadline === "number" && typeof x.guardUntil === "number"));
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

  // Issue #26: when the user's own input last reached each control, which the walk reports (content/user-input.ts).
  // Capture on the window from document_start, so the page's listeners cannot hide it; passive, so it never delays it.
  const inputs = new UserInputs<Element>((inner, outer) => {
    let n: Element | null = inner;
    for (let i = 0; n !== null && i < 256; i++, n = composedParent(n)) if (n === outer) return true;
    return false;
  });
  const noteInput = (e: Event): void => {
    if (!isUserInput(e)) return;
    const at = Date.now();
    const target = e.composedPath()[0];
    if (target instanceof Element) inputs.noted(target, at);
    const active = deepActiveElement();
    if (active !== null && active !== target) inputs.noted(active, at);
  };
  for (const type of ["keydown", "beforeinput", "input"]) addEventListener(type, noteInput, { capture: true, passive: true });

  // H13 review: an inline insert never lands inside an input method's composition (content/insert.ts).
  trackComposition();
  trackEdits();

  const focus = new FocusReporter({
    inFront: () => document.visibilityState === "visible" && document.hasFocus(),
    later: (f, ms) => void setTimeout(f, ms),
    report: () => {
      const m: FocusMoved = { caret: 1, op: "focusMoved" };
      chrome.runtime.sendMessage(m).catch(() => {});
    },
  });
  addEventListener("focusin", () => focus.focusIn(), { capture: true, passive: true });
  // focusout too: focus that leaves a field for no other field (a click on the page's background) sends no focusin, and
  // the host would keep a fill offer drawn at a field the user left (H10).
  addEventListener("focusout", () => focus.focusIn(), { capture: true, passive: true });
  // H13: typing in the field, or moving its caret, is reported too, so the host's inline text follows the text around
  // the caret. Only while an editable control has focus; nothing about the text travels with the report.
  const typedIn = (): void => {
    const el = deepActiveElement();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || (el instanceof HTMLElement && el.isContentEditable)) focus.typed();
  };
  addEventListener("input", typedIn, { capture: true, passive: true });
  // H13 review: the document losing focus (the address bar, another window) is reported too; only the window's own
  // blur, not a field's (blur does not bubble, but a capturing listener would see every element's).
  window.addEventListener("blur", (e) => {
    if (e.target === window) focus.left();
  });
  document.addEventListener("selectionchange", typedIn, { passive: true });
  // H10: a scroll moves the focused field on screen, so the host's offer drawn at it must move with it. Only while a
  // control has focus: a page read with nothing focused has no offer to move.
  addEventListener(
    "scroll",
    () => {
      if (deepActiveElement() !== null) focus.focusIn();
    },
    { capture: true, passive: true },
  );

  chrome.runtime.onMessage.addListener((m: unknown, sender, reply) => {
    // Only this extension's worker: a content script's own message would carry a tab, and nothing else can reach here.
    if (sender.id !== chrome.runtime.id || sender.tab !== undefined || !isToContent(m)) return false;
    if (m.op === "walk") {
      reply(walk(reg, entries, inputs, m.caretText !== false));
      return false;
    }
    if (m.op === "frame") {
      reply(selfOf());
      return false;
    }
    if (m.op === "text") {
      reply(textOf(m.until));
      return false;
    }
    if (m.op === "viewport") {
      reply([window.innerWidth, window.innerHeight]);
      return false;
    }
    if (m.op === "guard") {
      guardUntil = m.until;
      inputs.armed(m.until, Date.now());
      reply(true);
      return false;
    }
    if (late) {
      reply({ outcome: "notAllowed", detail: "this page was open before Caret was installed; reload it, so Caret can tell your own clicks from its writes there" });
      return false;
    }
    // The act arms this document itself for as long as its grant runs, whatever became of the worker's guard message.
    guardUntil = Math.max(guardUntil, m.guardUntil);
    inputs.armed(m.guardUntil, Date.now());
    const taskId = m.verb.taskId;
    const start = takeovers;
    const alive = async (): Promise<boolean> => {
      if (takeovers !== start) return false;
      const q: GrantAlive = { caret: 1, op: "grantAlive", taskId };
      const ok = await chrome.runtime.sendMessage(q).then((r: unknown) => r === true, () => false);
      return ok && takeovers === start;
    };
    focus.actStarted();
    act(reg, m.verb, m.deadline, alive)
      .then(reply, (e: unknown) => reply({ outcome: "error", detail: e instanceof Error ? e.message : String(e) }))
      .finally(() => focus.actEnded());
    return true;
  });

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
