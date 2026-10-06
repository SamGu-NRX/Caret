// C1: a focus Caret's own write causes asks for no fill. Writing a field, picking an option or ticking a box focuses the
// control, the content script reports that focus as it reports the user's, and an ambient Fill all was asked on a form
// Caret was filling, which spent Jev calls (P2's fixture runs). The user's own focus still asks for one.
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type Focus, type HelperToEngine, type PageSnapshot } from "../src/protocol.ts";
import { ACT_FOCUS_TAIL_MS, EngineSession } from "../src/engines/session.ts";
import { PageFocus } from "../src/engines/page-focus.ts";
import { ScreenModel } from "../src/model.ts";

const X = "kcmlnoabcdefghijklmnopabcdefghij";
const chrome = { pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing" };

function snapshot(id: string): PageSnapshot {
  return {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id, at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
    frames: [{
      frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/form", navGen: 1, title: "Apply", headings: [], iframes: [], excluded: {}, truncated: false,
      controls: [{ id: "e1", key: "form[apply]/textbox:email~0", strongKey: null, kind: "email", role: "textbox", name: "Email", value: "", form: "form#apply", rect: [0, 0, 200, 20] }],
    }],
    missing: [],
    focused: { frameId: 0, id: "e1", selection: [0, 0] },
  };
}

/**
 * A session whose engine answers walks at once and holds every other command until `answer` is called, so a test can
 * report focus while Caret's act is in flight.
 */
function rig() {
  const sent: HelperToEngine[] = [];
  const held: string[] = [];
  const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
    sent.push(m);
    if (m.type !== "pageCommand") return true;
    if (m.verb.kind !== "pageWalk") {
      held.push(m.id);
      return true;
    }
    queueMicrotask(() => {
      session.receive(snapshot(m.id));
      session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, outcome: "ok", detail: null });
    });
    return true;
  }, 5000);
  session.receive({ type: "pageHello", v: 1, extensionId: X, version: "0.1.0", profile: "p", instance: "w", startedAt: 1, capabilities: [] });
  const answer = (): void => {
    for (const id of held.splice(0)) session.receive({ type: "pageResult", v: 1, id, at: 1, outcome: "ok", detail: null });
  };
  const walks = (): number => sent.filter((m) => m.type === "pageCommand" && m.verb.kind === "pageWalk").length;
  return { session, answer, walks };
}

function wired() {
  const r = rig();
  const model = new ScreenModel();
  model.frontmostPid = chrome.pid;
  // The page window enters the model as the page engine's walks put it there (engines/page-link.ts does this in the helper).
  r.session.onSnapshot = (s) => void model.apply(toWindow(s));
  const fills: Focus[] = [];
  const own: number[] = [];
  const focus = new PageFocus({ model, focus: (m) => fills.push(m), warn: () => {}, ownFocus: (t) => own.push(t) });
  focus.attach(r.session);
  return { ...r, fills, own };
}

/** The page window as the helper's model holds it, with the focused control as its focused node. */
function toWindow(s: PageSnapshot): Parameters<ScreenModel["apply"]>[0] {
  return {
    type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: s.at, reason: "focus", app: chrome,
    window: { windowId: "page:eng1:7", kind: "page", title: s.title, frame: null },
    focused: true, root: null,
    nodes: [{ key: "f0/form[apply]/textbox:email~0", parent: null, role: "AXTextField", label: "Email", value: "", editable: true }],
    values: [], focusedKey: "f0/form[apply]/textbox:email~0", stats: { walkMs: 0, visited: 1, truncated: false },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 2));
};
const write = { kind: "pageWrite" as const, tabId: 7, frameId: 0, documentId: "D0", navGen: 1, key: "form[apply]/textbox:email~0", expect: "", value: "robin@example.test", taskId: "t1" };

describe("focus Caret's own write causes", () => {
  it("asks no fill while Caret's write is in flight in that tab, or just after it", async () => {
    const { session, answer, walks, fills, own } = wired();
    const pending = session.command(write as never);
    session.receive({ type: "pageFocus", v: 1, at: 1, tabId: 7, frameId: 0 });
    await settle();
    expect([walks(), fills.length, own]).toEqual([0, 0, [7]]);
    answer();
    await pending;
    session.receive({ type: "pageFocus", v: 1, at: 2, tabId: 7, frameId: 0 });
    await settle();
    expect([walks(), fills.length, own]).toEqual([0, 0, [7, 7]]);
  });

  it("still asks for a fill on the user's own focus: in another tab, or after the write's tail", async () => {
    const { session, answer, walks, fills } = wired();
    const pending = session.command(write as never);
    answer();
    await pending;
    // Another tab is not the one Caret wrote in.
    expect(session.actedRecently(8)).toBe(false);
    expect(session.actedRecently(7, Date.now() + ACT_FOCUS_TAIL_MS + 1)).toBe(false);
    await new Promise((r) => setTimeout(r, ACT_FOCUS_TAIL_MS + 50));
    session.receive({ type: "pageFocus", v: 1, at: 3, tabId: 7, frameId: 0 });
    await settle();
    expect(walks()).toBe(1);
    expect(fills.map((f) => [f.windowId, f.key, f.empty])).toEqual([["page:eng1:7", "f0/form[apply]/textbox:email~0", true]]);
  });

  it("does not count Caret's own walks as acts", async () => {
    const { session, fills } = wired();
    await session.command({ kind: "pageWalk", tabId: 7 });
    expect(session.actedRecently(7)).toBe(false);
    session.receive({ type: "pageFocus", v: 1, at: 4, tabId: 7, frameId: 0 });
    await settle();
    expect(fills.length).toBe(1);
  });
});
