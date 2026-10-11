// W3: the merge review's open findings on the helper's side of the page engine. Undo never rebinds, the user's own
// input in a page pauses the task, a pick a revoke cut short still goes into undo, a native select is writable, and
// only the focused browser window's tab is the user's. The content script's halves run in a real browser in
// fixtures/web-form/accept.ts. Every name and address here is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type HelperToEngine, type PageControl, type PageSnapshot, type PageVerb, type VerbResult } from "../src/protocol.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PageEngineLink, toVerbOutcome } from "../src/engines/page-link.ts";
import { pageHost, type PageHost } from "../src/engines/host.ts";
import { PageFocus } from "../src/engines/page-focus.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { ScreenModel } from "../src/model.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import type { Plan, Step } from "../src/executor/schema.ts";

const X = "kcmlnoabcdefghijklmnopabcdefghij";
const chrome = { pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing" };
const TITLE = "Apply: Synthetic Role";
const WIN = "page:eng1:7";
const hello = { type: "pageHello" as const, v: 1 as const, extensionId: X, version: "0.1.0", profile: "p", instance: "w", startedAt: 1, capabilities: [] };
const okReader = { run: async (): Promise<VerbResult> => ({ type: "verbResult", v: 1, id: "r", at: 0, outcome: "ok", detail: null }) };

/**
 * A page engine for one tab: controls with values, walks that show them, and acts that set them, as the content
 * script would. `onAct` answers an act instead (it may change values first); null lets the default run.
 */
class FakePage {
  readonly sent: HelperToEngine[] = [];
  readonly session: EngineSession;
  onAct: ((v: Exclude<PageVerb, { kind: "pageWalk" }>, page: FakePage) => object | null) | null = null;
  inFocusedWindow = true;
  controls: PageControl[] = [
    { id: "e1", key: "form[apply]/textbox:first name~0", strongKey: null, kind: "text", role: "textbox", name: "First name", value: "", form: "form#apply", rect: [0, 0, 200, 20] },
    { id: "e2", key: "form[apply]/select:country~0", strongKey: null, kind: "select", role: "combobox", name: "Country", form: "form#apply", rect: [0, 30, 200, 20], options: [{ value: "", label: "Choose one", selected: true }, { value: "ca", label: "Canada", selected: false }, { value: "us", label: "United States", selected: false }] },
    { id: "e3", key: "form[apply]/combobox:department~0", strongKey: null, kind: "combobox", role: "combobox", name: "Department", value: "", form: "form#apply", rect: [0, 60, 200, 20] },
  ];

  constructor(engine = "eng1") {
    this.session = new EngineSession({ engine, browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
      this.sent.push(m);
      if (m.type === "pageCommand") queueMicrotask(() => this.answer(m.id, m.verb));
      return true;
    }, 500);
  }

  snapshot(id: string): PageSnapshot {
    return {
      type: "pageSnapshot", v: PROTOCOL_VERSION, id, at: Date.now(), tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: this.inFocusedWindow, title: TITLE,
      frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/form", navGen: 1, title: TITLE, headings: [], iframes: [], excluded: {}, truncated: false, controls: structuredClone(this.controls) }],
      missing: [],
      focused: null,
    };
  }

  set(id: string, value: string): void {
    const c = this.controls.find((x) => x.id === id);
    if (c === undefined) throw new Error(`no control ${id}`);
    if (c.kind === "select") c.options = c.options?.map((o) => ({ ...o, selected: o.value === value }));
    else c.value = value;
  }

  shown(id: string): string | undefined {
    const c = this.controls.find((x) => x.id === id);
    return c?.kind === "select" ? c.options?.find((o) => o.selected)?.label : c?.value;
  }

  get verbs(): PageVerb[] {
    return this.sent.flatMap((m) => (m.type === "pageCommand" ? [m.verb] : []));
  }

  private answer(id: string, verb: PageVerb): void {
    if (verb.kind === "pageWalk") {
      this.session.receive(this.snapshot(id));
      this.session.receive({ type: "pageResult", v: 1, id, at: Date.now(), outcome: "ok", detail: null });
      return;
    }
    const custom = this.onAct?.(verb, this) ?? null;
    if (custom !== null) return void this.session.receive({ type: "pageResult", v: 1, id, at: Date.now(), ...custom } as never);
    if (verb.kind === "pageWrite" || verb.kind === "pageSelect" || verb.kind === "pageChooseOption") {
      const before = this.shown(verb.id) ?? "";
      this.set(verb.id, verb.value);
      const after = this.shown(verb.id) ?? "";
      this.session.receive({ type: "pageResult", v: 1, id, at: Date.now(), outcome: "ok", detail: null, readings: { before, afterInput: after, afterBlur: after, invalid: false, error: null } });
      return;
    }
    this.session.receive({ type: "pageResult", v: 1, id, at: Date.now(), outcome: "unsupported", detail: verb.kind });
  }
}

const step = (key: string, value: string): Step => ({ says: `${key} holds ${value}`, end: { kind: "valueEquals", window: { titleStartsWith: TITLE }, target: { key, describe: key }, value } });
const plan = (steps: Step[]): Plan => ({ id: "p", title: "p", slots: {}, steps });
const KEY = { first: "f0/form[apply]/textbox:first name~0", country: "f0/form[apply]/select:country~0", dept: "f0/form[apply]/combobox:department~0" };

describe("W3 page findings, helper side", () => {
  let dir: string;
  let store: Store;
  let page: FakePage;
  let host: PageHost;
  let helper: Helper;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-w3-"));
    store = new Store(join(dir, "data"));
    page = new FakePage();
    host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: okReader, apply: (m) => void helper.handleReader(m), warn: () => {} });
    helper = new Helper({ store, askJev: () => Promise.reject(new Error("no Jev here")), shadow: false, allowBackgroundFocus: false, readerLink: host.link, calendar: null, publish: () => {}, warn: () => {} });
    wirePageEngines({ host, helper, publish: () => {}, warn: () => {} });
    host.registry.add(page.session);
    page.session.receive(hello);
    await new Promise((r) => setTimeout(r, 0));
    expect((await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN })).outcome).toBe("ok");
  });
  afterEach(() => {
    helper.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("1a: undo never rebinds", () => {
    it("an undo's page verb says rebind: false and names the forward write's mark; the forward write carries the mark", async () => {
      expect((await host.link.run({ kind: "write", pid: chrome.pid, windowId: WIN, key: KEY.first, role: "AXTextField", attribute: "value", expect: "", value: "Ada", taskId: "t1", mark: "m1" })).outcome).toBe("ok");
      await host.link.run({ kind: "write", pid: chrome.pid, windowId: WIN, key: KEY.first, role: "AXTextField", attribute: "value", expect: "Ada", value: "", taskId: "t1", sameAs: "m1" });
      const writes = page.verbs.filter((v) => v.kind === "pageWrite").map((v) => ({ rebind: v.rebind, mark: v.mark, sameAs: v.sameAs }));
      expect(writes).toEqual([{ rebind: undefined, mark: "m1", sameAs: undefined }, { rebind: false, mark: undefined, sameAs: "m1" }]);
    });

    it("leaves the element's identity to the page: an undo goes on when a rebind gave the field another registry id (W3 review #2)", async () => {
      expect((await host.link.run({ kind: "write", pid: chrome.pid, windowId: WIN, key: KEY.first, role: "AXTextField", attribute: "value", expect: "", value: "Ada", taskId: "t1", mark: "m1" })).outcome).toBe("ok");
      // The page re-rendered First name; the forward write rebound to the replacement, which the next walk names e9.
      page.controls[0] = { ...page.controls[0]!, id: "e9" };
      await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN });
      await host.link.run({ kind: "write", pid: chrome.pid, windowId: WIN, key: KEY.first, role: "AXTextField", attribute: "value", expect: "Ada", value: "", taskId: "t1", sameAs: "m1" });
      expect(page.verbs.filter((v) => v.kind === "pageWrite").at(-1)).toMatchObject({ id: "e9", sameAs: "m1", rebind: false });
    });

    it("the page's notSameElement reaches the executor as notSameElement, so the restore is settled as refused", () => {
      expect(toVerbOutcome({ type: "pageResult", v: 1, id: "x", at: 1, outcome: "notSameElement", detail: "replaced" }).outcome).toBe("notSameElement");
    });

    it("an undo after the page replaced the field is refused and writes nothing", async () => {
      const r = await helper.executor.run("t1", plan([step(KEY.first, "Ada")]), {}, undefined, { grant: true });
      expect(r.outcome).toBe("done");
      // The content script answers the restore as it does for a replaced element under rebind: false.
      page.onAct = (v) => (v.kind === "pageWrite" && v.rebind === false ? { outcome: "notSameElement", detail: "the element Caret wrote was replaced" } : null);
      const u = await helper.executor.undo("t1");
      expect(u).toMatchObject({ restored: 0, notRestored: [{ step: 0 }] });
      expect(u.notRestored[0]?.reason).toContain("no longer the element");
      expect(page.shown("e1")).toBe("Ada");
    });
  });

  describe("1b: a click or key in the page takes the task over", () => {
    it("pauses the task acting in that tab at once and revokes its grant", async () => {
      page.onAct = (v, p) => {
        if (v.kind !== "pageWrite") return null;
        // The user clicks in the page while the first write is on its way; it lands anyway.
        p.session.receive({ type: "pageInput", v: 1, at: Date.now(), tabId: 7, frameId: 0, kind: "mouse" });
        p.set(v.id, v.value);
        return { outcome: "ok", detail: null, readings: { before: "", afterInput: v.value, afterBlur: v.value, invalid: false, error: null } };
      };
      const r = await helper.executor.run("t1", plan([step(KEY.first, "Ada"), step(KEY.country, "Canada")]), {}, undefined, { grant: true });
      expect(r).toMatchObject({ outcome: "paused", step: 1 });
      expect(r.detail).toContain("a click in 'Apply: Synthetic Role'");
      expect(page.verbs.filter((v) => v.kind === "pageSelect")).toEqual([]);
      expect(page.sent.filter((m) => m.type === "actRevoke").length).toBeGreaterThanOrEqual(1);
      expect(helper.executor.ledger("t1")).toHaveLength(1);
    });

    it("ignores input in another tab, and input before the engine's hello", async () => {
      let paused = 0;
      const was = helper.executor.onPageInput.bind(helper.executor);
      helper.executor.onPageInput = (w, k) => (paused++, was(w, k));
      page.onAct = (v, p) => {
        if (v.kind === "pageWrite") p.session.receive({ type: "pageInput", v: 1, at: Date.now(), tabId: 8, frameId: 0, kind: "key" });
        return null;
      };
      const r = await helper.executor.run("t1", plan([step(KEY.first, "Ada")]), {}, undefined, { grant: true });
      expect(r.outcome).toBe("done");
      expect(paused).toBe(1);
      const fresh = new EngineSession({ engine: "eng2", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, () => true);
      expect(fresh.receive({ type: "pageInput", v: 1, at: 1, tabId: 7, frameId: 0, kind: "mouse" })).toContain("before the engine's hello");
    });
  });

  describe("1d: a pick a revoke cut short still goes into undo", () => {
    it("records the pick, unconfirmed, before any verify; the run ends paused; undo restores it", async () => {
      page.onAct = (v, p) => {
        if (v.kind !== "pageChooseOption" || v.rebind === false) return null;
        // The pick lands, then the user's click revokes the grant before blur: the content script stops with no readings.
        p.set(v.id, v.value);
        p.session.receive({ type: "pageInput", v: 1, at: Date.now(), tabId: 7, frameId: 0, kind: "mouse" });
        return { outcome: "failed", detail: "the pick went in, then the task's grant ended (before blur); Caret stopped without touching the control again", choice: { flavor: "aria", matches: [v.value], expanded: false, hiddenInput: "none" } };
      };
      const r = await helper.executor.run("t1", plan([step(KEY.dept, "Research")]), {}, undefined, { grant: true });
      expect(r.outcome).toBe("paused");
      expect(helper.executor.ledger("t1")).toEqual([expect.objectContaining({ kind: "write", key: KEY.dept, before: "", after: "Research", unconfirmed: true })]);
      const u = await helper.executor.undo("t1");
      expect(u).toMatchObject({ restored: 1, notRestored: [] });
      expect(page.shown("e3")).toBe("");
      expect(page.verbs.filter((v) => v.kind === "pageChooseOption").at(-1)).toMatchObject({ rebind: false, expect: "Research", value: "" });
    });
  });

  describe("1e: a native select reaches the value write", () => {
    it("shows the select as editable and writes it by option label, verified by the selected option", async () => {
      expect(helper.model.windows.get(WIN)?.nodes.get(KEY.country)).toMatchObject({ role: "AXPopUpButton", editable: true, value: "" });
      const r = await helper.executor.run("t1", plan([step(KEY.country, "Canada")]), {}, undefined, { grant: true });
      expect(r.outcome).toBe("done");
      expect(page.verbs.find((v) => v.kind === "pageSelect")).toMatchObject({ expect: "", value: "ca" });
      expect(helper.model.windows.get(WIN)?.nodes.get(KEY.country)?.value).toBe("Canada");
    });
  });

  describe("the deferred walk: an executor run over the page link", () => {
    it("walks the window once per step, not again after each verified write, and passes the executor's write checks", async () => {
      const from = page.verbs.length;
      const r = await helper.executor.run("t1", plan([step(KEY.first, "Ada"), step(KEY.country, "Canada")]), {}, undefined, { grant: true });
      expect(r.outcome).toBe("done");
      // Before the deferred walk each write was followed by a walk of its own: seven commands, not six. The text write is
      // patched; the select is still walked after (P2 review: the page reads back its value, not its label).
      expect(page.verbs.slice(from).map((v) => v.kind)).toEqual(["pageWalk", "pageWalk", "pageWrite", "pageWalk", "pageSelect", "pageWalk"]);
      expect(helper.executor.ledger("t1")).toEqual([expect.objectContaining({ key: KEY.first, after: "Ada" }), expect.objectContaining({ key: KEY.country, after: "Canada" })]);
      expect([helper.model.windows.get(WIN)?.nodes.get(KEY.first)?.value, helper.model.windows.get(WIN)?.nodes.get(KEY.country)?.value]).toEqual(["Ada", "Canada"]);
    });
  });

  describe("review #8: a native select is written by one exact option label", () => {
    const write = (value: string, expect: string) => host.link.run({ kind: "write", pid: chrome.pid, windowId: WIN, key: KEY.country, role: "AXPopUpButton", attribute: "value", expect, value, taskId: "t1" });
    const setOptions = async (options: { value: string; label: string; selected: boolean }[]): Promise<void> => {
      page.controls[1] = { ...page.controls[1]!, options };
      await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN });
    };

    it("picks the option labelled the value, never one whose value merely equals it", async () => {
      await setOptions([{ value: "", label: "Choose one", selected: true }, { value: "Canada", label: "United States", selected: false }, { value: "ca", label: "Canada", selected: false }]);
      expect((await write("Canada", "")).outcome).toBe("ok");
      expect(page.verbs.filter((v) => v.kind === "pageSelect")).toEqual([expect.objectContaining({ expect: "", value: "ca" })]);
    });

    it("refuses two options with the label, and a select that no longer shows the expected label, sending the page nothing", async () => {
      await setOptions([{ value: "", label: "Choose one", selected: true }, { value: "a", label: "Canada", selected: false }, { value: "b", label: "Canada", selected: false }]);
      expect((await write("Canada", "")).outcome).toBe("noElement");
      await setOptions([{ value: "", label: "Choose one", selected: false }, { value: "us", label: "United States", selected: true }, { value: "ca", label: "Canada", selected: false }]);
      expect((await write("Canada", "")).outcome).toBe("changed");
      // Two labels, one value: setting the value would pick the first of them.
      await setOptions([{ value: "", label: "Choose one", selected: true }, { value: "x", label: "Canada", selected: false }, { value: "x", label: "Mexico", selected: false }]);
      expect((await write("Mexico", "")).outcome).toBe("noElement");
      expect(page.verbs.filter((v) => v.kind === "pageSelect")).toEqual([]);
    });
  });

  describe("D2-06 re-check: a verb made for one kind of control", () => {
    it("is refused when the key now names another kind: nothing is sent to the page", async () => {
      const model = new ScreenModel();
      const p = new FakePage();
      const link = new PageEngineLink(p.session, (s) => model.apply(s));
      p.session.receive(hello);
      expect((await link.run({ kind: "walk", pid: chrome.pid, windowId: WIN })).outcome).toBe("ok");
      const now = Date.now();
      link.grant({ type: "actGrant", v: 1, taskId: "t-role", pid: chrome.pid, windowId: WIN, at: now, expires: now + 60_000 });
      const sent = p.verbs.length;
      // The Department combobox is written as if it were a native select (AXPopUpButton), and a text field as a combobox.
      const a = await link.run({ kind: "write", pid: chrome.pid, windowId: WIN, key: "f0/form[apply]/combobox:department~0", role: "AXPopUpButton", attribute: "value", expect: "", value: "Research", taskId: "t-role" });
      const b = await link.run({ kind: "write", pid: chrome.pid, windowId: WIN, key: "f0/form[apply]/textbox:first name~0", role: "AXComboBox", attribute: "value", expect: "", value: "Robin", taskId: "t-role" });
      expect([a.outcome, b.outcome]).toEqual(["changed", "changed"]);
      expect(a.detail).toMatch(/is now a AXComboBox, not the AXPopUpButton/);
      expect(p.verbs.length).toBe(sent);
      // The same writes with the roles the model shows go through.
      expect((await link.run({ kind: "write", pid: chrome.pid, windowId: WIN, key: "f0/form[apply]/textbox:first name~0", role: "AXTextField", attribute: "value", expect: "", value: "Robin", taskId: "t-role" })).outcome).toBe("ok");
    });
  });

  describe("1f: only the focused window's tab is the user's", () => {
    it("a background window's selected tab is not focused in the model and is never the user's window", async () => {
      // The user is in WIN (walked in its focused window above). Another profile's tab, selected in a background
      // window, is walked afterwards, as a page task in it would be.
      helper.handleReader({ type: "appSwitch", v: 1, at: Date.now(), from: null, to: chrome });
      const bg = new FakePage("eng2");
      bg.inFocusedWindow = false;
      host.registry.add(bg.session);
      bg.session.receive(hello);
      await new Promise((r) => setTimeout(r, 0));
      expect((await host.link.run({ kind: "walk", pid: chrome.pid, windowId: "page:eng2:7" })).outcome).toBe("ok");
      expect(helper.model.windows.get("page:eng2:7")?.focused).toBe(false);
      expect(helper.model.userWindow()?.window.windowId).toBe(WIN);
      // Once its window has focus, it is.
      bg.inFocusedWindow = true;
      await host.link.run({ kind: "walk", pid: chrome.pid, windowId: "page:eng2:7" });
      expect(helper.model.userWindow()?.window.windowId).toBe("page:eng2:7");
    });

    it("page focus walks the tab but asks no fill for a background window's tab", async () => {
      const model = new ScreenModel();
      const asked: string[] = [];
      const focus = new PageFocus({ model, focus: (m) => asked.push(m.windowId), allowBackground: true, warn: () => {} });
      const p = new FakePage();
      const link = new PageEngineLink(p.session, (s) => model.apply(s));
      p.session.receive(hello);
      void link;
      p.controls[0] = { ...p.controls[0]!, value: "" };
      const snap = p.snapshot.bind(p);
      p.snapshot = (id) => ({ ...snap(id), focused: { frameId: 0, id: "e1", selection: [0, 0] } });
      p.inFocusedWindow = false;
      await focus.moved({ type: "pageFocus", v: 1, at: 1, tabId: 7, frameId: 0 }, p.session);
      expect(p.verbs).toEqual([{ kind: "pageWalk", tabId: 7 }]);
      expect(asked).toEqual([]);
      p.inFocusedWindow = true;
      await focus.moved({ type: "pageFocus", v: 1, at: 2, tabId: 7, frameId: 0 }, p.session);
      expect(asked).toEqual([WIN]);
    });
  });
});
