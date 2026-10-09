// H10: a page's fields where the host can see them. Page controls get screen frames from the walk's view of the window
// (measured in the rig VM: evidence/host/h10/probe), the host hears which page field the user is in (pageField), and Ask
// plans in the page of the tab the user is in, never in Accessibility's view of the browser. Every name here is invented.
import { answeringScope } from "./builders.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsumerMessage, FillAll, HelperMessage, PROTOCOL_VERSION, fillFieldTask, type HelperToEngine, type PageField, type PageSnapshot } from "../src/protocol.ts";
import { EngineSession } from "../src/engines/session.ts";
import { screenRect, toWindowSnapshot } from "../src/engines/page-link.ts";
import { pageHost } from "../src/engines/host.ts";
import { pageFront } from "../src/engines/front.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { SAYS } from "../src/planner/says.ts";
import { ScreenModel } from "../src/model.ts";

const X = "kcmlnoabcdefghijklmnopabcdefghij";
const chrome = { pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing" };
const W = "page:eng1:7";
/** The probe's window: [120, 30, 760, 512], 369 points of viewport at the bottom (143 of browser above it). */
const VIEW = { window: [120, 30, 760, 512] as [number, number, number, number], viewport: [760, 369] as [number, number], zoom: 1 };
type Control = PageSnapshot["frames"][number]["controls"][number];
const email: Control = { id: "e1", key: "form[apply]/textbox:email~0", strongKey: null, kind: "email", role: "textbox", name: "Email", value: "", form: "form#apply", rect: [16, 40, 300, 24] };
const resume: Control = { id: "e2", key: "form[apply]/button:resume~0", strongKey: null, kind: "file", role: "button", name: "Resume", form: "form#apply", rect: [16, 80, 300, 24] };
const yes: Control = { id: "e3", key: "form[apply]/radio:yes~0", strongKey: null, kind: "radio", role: "radio", name: "Yes", checked: false, form: "form#apply", rect: [16, 120, 20, 20], group: { id: "g1", name: "Authorized to work?" } };
const no: Control = { ...yes, id: "e4", key: "form[apply]/radio:no~0", name: "No", rect: [60, 120, 20, 20] };
const KEY = (c: Control): string => `f0/${c.key}`;

function snapshot(id: string, o: { view?: PageSnapshot["view"]; focused?: string | null; scroll?: number; child?: boolean } = {}): PageSnapshot {
  const dy = o.scroll ?? 0;
  const moved = (c: Control): Control => ({ ...c, rect: [c.rect[0], c.rect[1] - dy, c.rect[2], c.rect[3]] });
  const top = { frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/apply", navGen: 1, title: "Apply: Synthetic Role", headings: [], iframes: [], excluded: {}, truncated: false, controls: [email, resume, yes, no].map(moved) };
  const child = { ...top, frameId: 3, parentFrameId: 0, documentId: "D3", path: "/embedded", controls: [{ ...email, id: "c1", key: "form[embedded]/textbox:email~0" }] };
  return {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id, at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply: Synthetic Role",
    frames: o.child === true ? [top, child] : [top],
    missing: [],
    focused: o.focused === null ? null : { frameId: 0, id: o.focused ?? "e1", selection: [0, 0], look: { inset: 13, fontSize: 16, placeholder: true, dark: false } },
    ...(o.view === undefined ? { view: VIEW } : { view: o.view }),
  };
}

/** A session whose engine answers each walk with `snap()` as it is at that moment, or refuses it with `refuse()`'s outcome. */
function rig(snap: (id: string) => PageSnapshot, refuse: () => string | null = () => null) {
  const sent: HelperToEngine[] = [];
  const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
    sent.push(m);
    queueMicrotask(() => {
      if (m.type !== "pageCommand") return;
      const no = m.verb.kind === "pageWalk" ? refuse() : null;
      if (m.verb.kind === "pageWalk" && no === null) session.receive(snap(m.id));
      session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, outcome: no ?? "ok", detail: no === null ? null : "refused" } as never);
    });
    return true;
  }, 500);
  return { session, sent };
}
const hello = { type: "pageHello" as const, v: 1 as const, extensionId: X, version: "0.1.0", profile: "p", instance: "w", startedAt: 1, capabilities: [] };
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
};

describe("page controls in screen points", () => {
  it("puts the viewport at the bottom of the window and scales by the page zoom", () => {
    expect(screenRect(VIEW, [16, 40, 300, 24])).toEqual([136, 213, 300, 24]);
    // 125%: the probe's page read innerHeight 295 CSS pixels for the same 369 points of viewport.
    expect(screenRect({ window: VIEW.window, viewport: [608, 295.2], zoom: 1.25 }, [16, 40, 300, 24])).toEqual([140, 223, 375, 30]);
  });

  it("gives the top frame's controls, radio groups and web area frames, and a child frame's none", () => {
    const { session } = rig((id) => snapshot(id));
    const s = toWindowSnapshot(snapshot("w", { child: true }), session, 1);
    const by = new Map(s.nodes.map((n) => [n.key, n]));
    expect(by.get(KEY(email))?.frame).toEqual([136, 213, 300, 24]);
    expect(by.get("f0")?.frame).toEqual([120, 173, 760, 369]);
    expect(by.get("f0/radiogroup:g1")?.frame).toEqual([136, 293, 64, 20]);
    expect(by.get("f3/form[embedded]/textbox:email~0")?.frame).toBeUndefined();
    expect(s.window.frame).toEqual([120, 30, 760, 512]);
  });

  it("gives no frame when the walk did not say where the viewport is (a worker before H10)", () => {
    const { session } = rig((id) => snapshot(id));
    const s = toWindowSnapshot(snapshot("w", { view: null }), session, 1);
    expect(s.nodes.some((n) => n.frame !== undefined)).toBe(false);
    expect(s.window.frame).toBeNull();
  });
});

describe("the page field the user is in, for the host", () => {
  let dir: string;
  let store: Store;
  const sessions: EngineSession[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-h10-"));
    store = new Store(join(dir, "data"));
  });
  afterEach(() => {
    for (const session of sessions.splice(0)) session.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function build(page: { focused: string | null; scroll: number; off?: boolean }) {
    const published: HelperMessage[] = [];
    const focus: unknown[] = [];
    let helper: Helper;
    const host = pageHost({ path: join(dir, "page.sock"), secret: randomBytes(32), reader: { run: async () => ({ type: "verbResult", v: 1, id: "r", at: 0, outcome: "ok", detail: null }) } as never, apply: (m) => void helper.handleReader(m), purge: (s) => helper.purgeWindow(s), warn: () => {} });
    helper = new Helper({ store, askJev: answeringScope(() => Promise.reject(new Error("no Jev here"))), shadow: false, allowBackgroundFocus: false, readerLink: host.link, pageCovers: (pid) => host.registry.forBrowser(pid) !== undefined, calendar: null, publish: (m) => published.push(m), warn: () => {} });
    const handle = helper.handleReader.bind(helper);
    helper.handleReader = (m) => {
      if (m.type === "focus") focus.push(m);
      return handle(m);
    };
    wirePageEngines({ host, helper, publish: (m) => published.push(m), warn: () => {} });
    const { session, sent } = rig((id) => snapshot(id, { focused: page.focused, scroll: page.scroll }), () => (page.off === true ? "siteOff" : null));
    host.registry.add(session);
    sessions.push(session);
    session.receive(hello);
    return { helper, published, session, sent, focus };
  }
  const allFields = (published: HelperMessage[]): PageField[] => published.filter((m): m is PageField => m.type === "pageField");
  // What H10 says about focus and position; the frames near the field (v2/inline PageField.nearby) have their own check.
  const fields = (published: HelperMessage[]): PageField[] => allFields(published).map(({ nearby: _nearby, ...rest }) => rest);

  it("says which field has focus and where, follows a scroll without a new focus, and says none once focus leaves", async () => {
    const page = { focused: "e1" as string | null, scroll: 0 };
    const { helper, published, session, focus } = build(page);
    await settle();
    helper.handleReader({ type: "appSwitch", v: 1, at: 2, from: null, to: chrome });
    session.receive({ type: "pageFocus", v: 1, at: 3, tabId: 7, frameId: 0 });
    await settle();
    expect(fields(published)).toEqual([{ type: "pageField", v: 1, at: 1000, app: chrome, windowId: W, title: "Apply: Synthetic Role", key: KEY(email), role: "AXTextField", editable: true, empty: true, frame: [136, 213, 300, 24], look: { inset: 13, fontSize: 16, placeholder: true, dark: false } }]);
    // v2/inline: the next field down is near enough to be named, as a screen frame (the slip keeps off it).
    expect(allFields(published)[0]?.nearby).toContainEqual([136, 253, 300, 24]);
    expect(fields(published).every((m) => HelperMessage.safeParse(m).success)).toBe(true);
    expect(focus).toHaveLength(1);
    // A scroll: the same field, 30 points higher, and no second focus for the helper.
    page.scroll = 30;
    session.receive({ type: "pageFocus", v: 1, at: 4, tabId: 7, frameId: 0 });
    await settle();
    expect(fields(published).at(-1)).toMatchObject({ key: KEY(email), frame: [136, 183, 300, 24] });
    expect(focus).toHaveLength(1);
    // Focus left for the page's background.
    page.focused = null;
    session.receive({ type: "pageFocus", v: 1, at: 5, tabId: 7, frameId: 0 });
    await settle();
    expect(fields(published).at(-1)).toMatchObject({ key: null, frame: null, windowId: W });
  });

  it("says no field once the tab the user is in is one Caret cannot read (a site it is off for)", async () => {
    const page = { focused: "e1" as string | null, scroll: 0, off: false };
    const { helper, published, session } = build(page);
    await settle();
    helper.handleReader({ type: "appSwitch", v: 1, at: 2, from: null, to: chrome });
    session.receive({ type: "pageFocus", v: 1, at: 3, tabId: 7, frameId: 0 });
    await settle();
    expect(fields(published).at(-1)?.key).toBe(KEY(email));
    // The worker reports the switch to the off site's tab (H10 review 3); the walk is refused there.
    page.off = true;
    session.receive({ type: "pageFocus", v: 1, at: 4, tabId: 7, frameId: 0 });
    await settle();
    expect(fields(published).at(-1)).toMatchObject({ key: null, frame: null });
  });
});

describe("Ask in a browser a page engine covers (H10)", () => {
  let dir: string;
  let store: Store;
  const sessions: EngineSession[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-h10-ask-"));
    store = new Store(join(dir, "data"));
  });
  afterEach(() => {
    for (const session of sessions.splice(0)) session.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The browser in front, its page walked once, then Accessibility's view of the same browser focused more recently. */
  async function build(o: { front?: (pid: number) => Promise<string | null> } = {}) {
    const published: HelperMessage[] = [];
    let helper: Helper;
    const host = pageHost({ path: join(dir, "page.sock"), secret: randomBytes(32), reader: { run: async () => ({ type: "verbResult", v: 1, id: "r", at: 0, outcome: "ok", detail: null }) } as never, apply: (m) => void helper.handleReader(m), purge: (s) => helper.purgeWindow(s), warn: () => {} });
    helper = new Helper({
      store, askJev: answeringScope(() => Promise.reject(new Error("no Jev here"))), shadow: false, allowBackgroundFocus: false, readerLink: host.link, calendar: null, publish: (m) => published.push(m), warn: () => {},
      pageCovers: (pid) => host.registry.forBrowser(pid) !== undefined,
      pageFront: o.front ?? ((pid, frame) => pageFront(host.registry, pid, frame)),
    });
    wirePageEngines({ host, helper, publish: () => {}, warn: () => {} });
    const { session, sent } = rig((id) => snapshot(id));
    host.registry.add(session);
    sessions.push(session);
    session.receive(hello);
    await settle();
    helper.handleReader({ type: "appSwitch", v: 1, at: 2, from: null, to: chrome });
    expect((await host.link.run({ kind: "walk", pid: chrome.pid, windowId: W })).outcome).toBe("ok");
    // The reader's window of the browser: its toolbar only, focused after the page's walk (Q2: the reader walks it on
    // every Accessibility change in Chrome).
    helper.handleReader({ type: "snapshot", v: 1, seq: 1, at: Date.now() + 1000, reason: "focus", app: chrome, window: { windowId: "4100-1", kind: "standard", title: "Apply: Synthetic Role", frame: [120, 30, 760, 512], number: 35 }, focused: true, root: null, nodes: [{ key: "tb/address", parent: null, role: "AXTextField", label: "Address and search bar", value: "127.0.0.1:4310/apply" }], values: [], focusedKey: null, stats: { walkMs: 0, visited: 1, truncated: false } });
    expect(helper.model.userWindow()?.window.windowId).toBe("4100-1");
    return { helper, published, sent };
  }

  it("plans in the page of the tab the user is in, walked at the Ask, not in the reader's window of the browser", async () => {
    const { helper, sent } = await build();
    const walks = sent.filter((m) => m.type === "pageCommand" && m.verb.kind === "pageWalk").length;
    // "attach my resume" is planned by code (planner/attach.ts) wherever the window holds a file input: only the page does.
    const p = await helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "ask-1", at: 1, instruction: "attach my resume" });
    expect(p.error).toBeNull();
    expect(p).toMatchObject({ outcome: "proposed", attach: { field: "Resume" } });
    expect(sent.filter((m) => m.type === "pageCommand" && m.verb.kind === "pageWalk").length).toBe(walks + 1);
  });

  it("walks the tab even when the model's latest focus is another page, and binds the walked page alone among same-titled tabs (review 1, 4)", async () => {
    const { helper } = await build();
    // Tab 6, which the user left: the same title, the same form, focused later in the model than tab 7's walk.
    const { session: other } = rig((id) => snapshot(id));
    helper.handleReader({ ...toWindowSnapshot({ ...snapshot("s6"), tabId: 6 }, other, 2), at: Date.now() + 5000 });
    expect(helper.model.userWindow()?.window.windowId).toBe("page:eng1:6");
    const p = await helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "ask-3", at: 1, instruction: "attach my resume" });
    expect(p.error).toBeNull();
    expect(p.window?.windowId).toBe(W);
  });

  it("plans in the page shown in a browser window the request names, matched by its frame, and refuses another frame (review 2)", async () => {
    const { helper } = await build();
    const p = await helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "ask-4", at: 1, instruction: "attach my resume", windowId: "4100-1" });
    expect(p.error).toBeNull();
    expect(p.window?.windowId).toBe(W);
    helper.handleReader({ type: "snapshot", v: 1, seq: 2, at: Date.now() + 2000, reason: "focus", app: chrome, window: { windowId: "4100-2", kind: "standard", title: "Other window", frame: [600, 30, 760, 512], number: 36 }, focused: false, root: null, nodes: [], values: [], focusedKey: null, stats: { walkMs: 0, visited: 0, truncated: false } });
    const q = await helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "ask-5", at: 1, instruction: "attach my resume", windowId: "4100-2" });
    expect(q).toMatchObject({ outcome: "error", error: { code: "noWindow", says: SAYS.pageUnread } });
  });

  it("refuses with the page sentence when the engine cannot read that tab, rather than planning in the toolbar", async () => {
    const { helper } = await build({ front: async () => null });
    const p = await helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "ask-2", at: 1, instruction: "attach my resume" });
    expect(p).toMatchObject({ outcome: "error", error: { code: "noWindow", says: SAYS.pageUnread } });
  });

  it("finds no page in a tab that is not the active tab of a focused window", async () => {
    const model = new ScreenModel();
    const host = pageHost({ path: join(dir, "p2.sock"), secret: randomBytes(32), reader: { run: async () => ({ type: "verbResult", v: 1, id: "r", at: 0, outcome: "ok", detail: null }) } as never, apply: (m) => void (m.type === "snapshot" ? model.apply(m) : undefined), purge: (s) => void model.apply(s), warn: () => {} });
    const { session } = rig((id) => ({ ...snapshot(id), inFocusedWindow: false }));
    host.registry.add(session);
    session.receive(hello);
    await settle();
    expect(await pageFront(host.registry, chrome.pid)).toBeNull();
    expect(await pageFront(host.registry, 9999)).toBeNull();
  });
});

describe("the H10 golden lines (fixtures/golden/page-field.ndjson), which the host decodes", () => {
  const lines = readFileSync(new URL("../fixtures/golden/page-field.ndjson", import.meta.url), "utf8").trim().split("\n");
  it("parses every line and writes it back byte for byte", () => {
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(["fillProposal", "pageField", "fillAll", "taskProgress", "taskProgress", "taskControl", "taskProgress", "pageField"]);
    for (const l of lines) {
      const m = JSON.parse(l) as { type: string };
      expect(JSON.stringify((m.type === "fillAll" || m.type === "taskControl" ? ConsumerMessage : HelperMessage).parse(m)), m.type).toBe(l);
    }
  });

  it("runs one field as the task the host names by the same rule", () => {
    const req = FillAll.parse(JSON.parse(lines[2] as string));
    expect((JSON.parse(lines[3] as string) as { taskId: string }).taskId).toBe(fillFieldTask(req.proposalId, req.fieldKey as string));
    expect(FillAll.safeParse({ ...req, fieldKey: "" }).success).toBe(false);
  });
});

describe("the window the user just left, for a page (H10)", () => {
  const snap = (windowId: string, at: number, o: { kind?: string; app?: typeof chrome } = {}) => ({
    type: "snapshot" as const, v: 1 as const, seq: at, at, reason: "focus" as const, app: o.app ?? chrome,
    window: { windowId, kind: o.kind ?? "standard", title: windowId, frame: null }, focused: true, root: null, nodes: [], values: [], focusedKey: null,
    stats: { walkMs: 0, visited: 0, truncated: false },
  });
  const note = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };

  it("is the window before the browser came to the front, not the browser's own toolbar window", () => {
    const m = new ScreenModel();
    m.apply(snap("7001-1", 1, { app: note }));
    m.apply(snap("4100-1", 2));
    m.apply(snap(W, 3, { kind: "page" }));
    expect(m.windowBefore(W)).toBe("7001-1");
    // The browser's own window still has its own history: a native target is not changed.
    expect(m.windowBefore("4100-1")).toBe("7001-1");
  });

  it("is another tab of the same browser when the user came from it", () => {
    const m = new ScreenModel();
    m.apply(snap("7001-1", 1, { app: note }));
    m.apply(snap("page:eng1:6", 2, { kind: "page" }));
    m.apply(snap("4100-1", 3));
    m.apply(snap(W, 4, { kind: "page" }));
    expect(m.windowBefore(W)).toBe("page:eng1:6");
  });
});
