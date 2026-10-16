// Slice 2: the page engine's open of a walked list row, through the page's own click handler, under the task's grant
// like every act. Only a row, option or listitem the walk carried is opened (engines/page-link.ts activateItem); the
// engine re-walks the tab after it, so the model catches what the open changed.
import { onWire, type TestField } from "./page-wire.ts";
import { describe, expect, it } from "vitest";
import { RoutedReaderLink } from "../src/executor/means.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PageEngineLink } from "../src/engines/page-link.ts";
import { PROTOCOL_VERSION, type HelperToEngine, type PageSnapshot } from "../src/protocol.ts";
import { X, chrome, hello } from "./fake-page.ts";

const row = (id: string, name: string): TestField => ({ id, key: `grid/${name.toLowerCase()}~0`, strongKey: null, kind: "row", role: "row", name, form: null, rect: [0, 0, 400, 28], cells: name.split(" · "), inForm: false, href: "none" });
const option = (id: string, name: string): TestField => ({ id, key: `listbox/${name.toLowerCase()}~0`, strongKey: null, kind: "option", role: "option", name, form: null, rect: [0, 0, 200, 24], cells: [name], inForm: false, href: "none" });
const button = (id: string, name: string): TestField => ({ id, key: `form[a]/button:${name.toLowerCase()}~0`, strongKey: null, kind: "button", role: "button", name, form: "form#a", rect: [0, 0, 80, 20], value: "" });
const CONTROLS = [row("r1", "Kayak · Flight itinerary · 2:10 PM"), row("r2", "Dana Whitfield · Flight itinerary · 3:40 PM"), option("o1", "Economy"), button("b1", "Next")];
const KEY = (id: string): string => `f0/${CONTROLS.find((c) => c.id === id)?.key ?? id}`;

function link(after: PageSnapshot[]): { link: PageEngineLink; sent: HelperToEngine[] } {
  const sent: HelperToEngine[] = [];
  let session: EngineSession;
  session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
    sent.push(m);
    if (m.type === "pageCommand") queueMicrotask(() => {
      if (m.verb.kind === "pageWalk" && after.length > 0) session.receive({ ...after.shift() as PageSnapshot, id: m.id });
      session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, outcome: "ok", detail: null });
    });
    return true;
  }, 200);
  session.receive(hello);
  const walked: PageSnapshot = { type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w", at: 1, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Inbox", frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/inbox", navGen: 1, title: "Inbox", headings: [], controls: CONTROLS.map((c) => onWire(c)), iframes: [], excluded: {}, truncated: false }], missing: [], focused: { frameId: 0, id: "r1", selection: [0, 0], text: { before: "", after: "", selection: "" } } };
  session.tabs.set(7, walked);
  return { link: new PageEngineLink(session, () => {}), sent };
}

const DETAIL: PageSnapshot = { type: "pageSnapshot", v: PROTOCOL_VERSION, id: "d", at: 2, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Flight itinerary", frames: [{ frameId: 0, parentFrameId: -1, documentId: "D1", origin: "http://127.0.0.1:4310", path: "/inbox/kayak", navGen: 1, title: "Flight itinerary", headings: [], controls: [button("b2", "Back")].map((c) => onWire(c)), iframes: [], excluded: {}, truncated: false }], missing: [], focused: { frameId: 0, id: "b2", selection: [0, 0], text: { before: "", after: "", selection: "" } } };

describe("open a list row (slice 2)", () => {
  it("sends one pageActivateItem for the walked row, never rebound, naming its cells and the task", async () => {
    const { link: l, sent } = link([DETAIL]);
    const r = await l.activateItem("page:eng1:7", KEY("r1"), "g1");
    expect(r.outcome).toBe("ok");
    const v = sent.flatMap((m) => (m.type === "pageCommand" && m.verb.kind === "pageActivateItem" ? [m.verb] : []));
    expect(v).toEqual([{ kind: "pageActivateItem", tabId: 7, frameId: 0, documentId: "D0", id: "r1", control: "row", name: "Kayak · Flight itinerary · 2:10 PM", taskId: "g1", rebind: false }]);
    // The re-walk follows the act, so the model catches the detail the open brought.
    expect(sent.some((m) => m.type === "pageCommand" && m.verb.kind === "pageWalk")).toBe(true);
  });

  it("opens an option of a listbox, and routes through the routed link", async () => {
    const { link: l, sent } = link([DETAIL]);
    const routed = new RoutedReaderLink(l, { engineFor: () => l, engines: () => [l] });
    expect((await routed.activateItem("page:eng1:7", KEY("o1"), "g2")).outcome).toBe("ok");
    expect(sent.find((m) => m.type === "pageCommand" && m.verb.kind === "pageActivateItem")).toMatchObject({ verb: { kind: "pageActivateItem", id: "o1", control: "option", name: "Economy" } });
  });

  it("answers noElement for a key the tab's last walk does not carry", async () => {
    const { link: l } = link([DETAIL]);
    expect((await l.activateItem("page:eng1:7", "f0/grid/absent~0", "g3")).outcome).toBe("noElement");
  });

  it("refuses a control that is not a list row before any verb is sent", async () => {
    const { link: l, sent } = link([DETAIL]);
    const r = await l.activateItem("page:eng1:7", KEY("b1"), "g4");
    expect(r.outcome).toBe("axError");
    expect(r.detail).toContain("'Next' is a button");
    expect(sent.some((m) => m.type === "pageCommand" && m.verb.kind === "pageActivateItem")).toBe(false);
  });

  it("answers noWindow for a window of another engine", async () => {
    const { link: l } = link([DETAIL]);
    expect((await l.activateItem("page:other:7", KEY("r1"), "g5")).outcome).toBe("noWindow");
  });
});
