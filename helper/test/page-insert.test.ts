// P4 item 8: the page link's insert at the caret, for an accepted inline offer on a page. Only into the field the tab's
// last walk shows focused, only a kind with a caret, under the task's grant, and the page answers for the rest
// (extension content/insert.ts; in a real browser in fixtures/web-form/tests/tab-text.test.ts).
import { describe, expect, it } from "vitest";
import { EngineSession } from "../src/engines/session.ts";
import { PageEngineLink, toVerbOutcome } from "../src/engines/page-link.ts";
import { PROTOCOL_VERSION, PageResult, VerbResult, type HelperToEngine, type PageControl, type PageSnapshot } from "../src/protocol.ts";
import { X, chrome, hello } from "./fake-page.ts";

const ctl = (id: string, kind: PageControl["kind"], name: string): PageControl => ({ id, key: `form[a]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: "textbox", name, form: "form#a", rect: [0, 0, 100, 20], value: "" });
const CONTROLS = [ctl("e1", "textarea", "Cover letter"), ctl("e2", "email", "Email"), ctl("e3", "checkbox", "Subscribe")];
const KEY = (id: string): string => `f0/${CONTROLS.find((c) => c.id === id)?.key ?? id}`;

function link(focusedId: string): { link: PageEngineLink; sent: HelperToEngine[] } {
  const sent: HelperToEngine[] = [];
  let session: EngineSession;
  session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
    sent.push(m);
    if (m.type === "pageCommand") queueMicrotask(() => {
      if (m.verb.kind === "pageWalk") session.receive({ ...snap(focusedId), id: m.id });
      session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, outcome: "ok", detail: null });
    });
    return true;
  }, 200);
  session.receive(hello);
  session.tabs.set(7, snap(focusedId));
  return { link: new PageEngineLink(session, () => {}), sent };
}
function snap(focusedId: string): PageSnapshot {
  return {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w", at: 1, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/apply", navGen: 1, title: "Apply", headings: [], controls: CONTROLS, iframes: [], excluded: {}, truncated: false }],
    missing: [], focused: { frameId: 0, id: focusedId, selection: [0, 0], text: { before: "", after: "", selection: "" } },
  };
}

describe("insert at the caret (item 8)", () => {
  it("sends one pageInsertText for the focused field, naming the text before its caret and its task", async () => {
    const { link: l, sent } = link("e1");
    const r = await l.insertText("page:eng1:7", KEY("e1"), "I am writing to apply for the ", "Field Robotics Technician role", "inline-1");
    expect(r.outcome).toBe("ok");
    const v = sent.flatMap((m) => (m.type === "pageCommand" && m.verb.kind === "pageInsertText" ? [m.verb] : []));
    expect(v).toEqual([{ kind: "pageInsertText", tabId: 7, frameId: 0, documentId: "D0", id: "e1", control: "textarea", name: "Cover letter", taskId: "inline-1", expect: "I am writing to apply for the ", text: "Field Robotics Technician role" }]);
  });

  it("sends nothing for a field that does not have focus, one without a caret, or one the walk never kept", async () => {
    const { link: l, sent } = link("e2");
    expect((await l.insertText("page:eng1:7", KEY("e1"), "", "x", "t")).outcome).toBe("changed");
    // Refused before anything is sent: changed, which the helper says as refused (axError would read as unverified).
    expect((await l.insertText("page:eng1:7", KEY("e2"), "", "x", "t")).outcome).toBe("changed");
    expect((await l.insertText("page:eng1:7", KEY("e3"), "", "x", "t")).outcome).toBe("changed");
    expect((await l.insertText("page:eng1:7", "f0/password~0", "", "x", "t")).outcome).toBe("noElement");
    expect((await l.insertText("page:other:7", KEY("e1"), "", "x", "t")).outcome).toBe("noWindow");
    expect(sent.filter((m) => m.type === "pageCommand")).toEqual([]);
  });
});

describe("an insert's read-back (H13 review)", () => {
  const result = (extra: object) => ({ type: "pageResult" as const, v: 1 as const, id: "x", at: 1, outcome: "failed" as const, detail: "d", ...extra });
  it("keeps whether the field was left unchanged or changed unverified", () => {
    expect(toVerbOutcome(PageResult.parse(result({ insert: "unchanged" })))).toMatchObject({ outcome: "changed", insert: "unchanged" });
    expect(toVerbOutcome(PageResult.parse(result({ insert: "unverified" })))).toMatchObject({ outcome: "axError", insert: "unverified" });
    expect(VerbResult.safeParse(toVerbOutcome(PageResult.parse(result({ insert: "unverified" })))).success).toBe(true);
    expect(PageResult.safeParse({ ...result({ insert: "unchanged" }), outcome: "ok" }).success).toBe(false);
  });
});
