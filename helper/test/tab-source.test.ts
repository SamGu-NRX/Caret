// P4: the tab the user just left, as a fill source. TabSource's rules on the helper's side (which tab, how recent,
// excluded sites, how long the text is held and where it may be seen), and one fill through two page tabs: a webmail
// tab holding the message and a form tab, with the worker's own rules played by the fake engine. The worker's half
// is tested in extension/test/tab-text.test.ts and in a real browser in fixtures/web-form/tests/tab-text.test.ts.
// Every name and value is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineSession } from "../src/engines/session.ts";
import { pageHost, type PageHost } from "../src/engines/host.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { TabSource, pageTabReader, type TabReader } from "../src/engines/tab-source.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { Helper } from "../src/helper.ts";
import { ScreenModel } from "../src/model.ts";
import { Store } from "../src/store.ts";
import { LEFT_TAB_MS, PAGE_SUBROLE, PROTOCOL_VERSION, type HelperMessage, type HelperToEngine, type OfferPopup, type PageControl, type PageResult, type PageSnapshot, type PageTabText, type PageVerb } from "../src/protocol.ts";
import { field, jevPickingText, snap } from "./builders.ts";
import { X, chrome, hello } from "./fake-page.ts";

const MAIL = "page:eng1:3";
const FORM = "page:eng1:7";
const NOTES = "notes";

/** The message the webmail tab shows: what the worker's read of it returns. */
const MESSAGE: PageTabText = {
  tabId: 3,
  leftAt: 0,
  title: "Inbox: Field Robotics Technician",
  frames: [{ frameId: 0, origin: "https://mail.example.test" }],
  selection: [],
  blocks: ["From: Gareth Lowe <gareth.lowe@example.net>", "Hi Ines,", "Your details as we have them:\nFirst name: Ines\nLast name: Vandermeer\nEmail: ines.vandermeer@example.org"],
  cut: false,
  docsText: null,
};

const ctl = (id: string, kind: PageControl["kind"], name: string, extra: Partial<PageControl> = {}): PageControl => ({
  id, key: `form[apply]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: kind, name, form: "form#apply", rect: [0, 0, 200, 20], value: "", ...extra,
});

function tabSnap(tabId: number, title: string, origin: string, controls: PageControl[], focused: PageSnapshot["focused"], active: boolean): PageSnapshot {
  return {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w", at: Date.now(), tabId, browserWindowId: 1, active, inFocusedWindow: active, title,
    frames: [{ frameId: 0, parentFrameId: -1, documentId: `D${tabId}`, origin, path: "/", navGen: 1, title, headings: [], iframes: [], excluded: {}, truncated: false, controls }],
    missing: [],
    focused,
  };
}

/** The note's app: another process than the browser, whose own windows fill passes over for a page (H10, model.ts windowBefore). */
const NOTES_APP = { pid: 7001, bundleId: "com.apple.Notes", name: "Notes" };

/** A model whose focus history is `trail` (window id, focused at), oldest first; each window a page or a note. */
function modelWith(trail: [string, number][]): ScreenModel {
  const m = new ScreenModel();
  for (const [id, at] of trail) m.apply(snap([field(`${id}/x`, "", { role: "AXTextField" })], { at, windowId: id, focused: true, ...(id.startsWith("page:") ? { kind: "page" } : { app: NOTES_APP }) }));
  return m;
}

/** A reader that records each read and answers with `answer`; `off` and `docs` are the live "Not on this site" list and each window's document. */
function fakeReader(answer: (windowId: string) => PageResult | null, off: string[] = [], docs = new Map<string, string>()): TabReader & { reads: string[]; off: string[]; docs: Map<string, string> } {
  const reads: string[] = [];
  return {
    reads,
    off,
    docs,
    readText: async (w) => {
      reads.push(w);
      return answer(w);
    },
    sitesOff: () => off,
    documentOf: (w) => docs.get(w) ?? "D1",
  };
}

const ok = (t: Partial<PageTabText> = {}): PageResult => ({ type: "pageResult", v: PROTOCOL_VERSION, id: "r", at: 0, outcome: "ok", detail: null, text: { ...MESSAGE, ...t } });

describe("TabSource: which tab is read (rules 1 and 2)", () => {
  let now = 10_000;
  const source = (m: ScreenModel, r: TabReader, dropped: string[] = []): TabSource => new TabSource({ model: m, reader: r, now: () => now, count: () => {}, dropped: (id) => void dropped.push(id) });
  beforeEach(() => {
    now = 10_000;
  });

  it("reads the page the user left for the form, and only it", async () => {
    const m = modelWith([[FORM, 1000], [MAIL, 2000], [FORM, 9000]]);
    const r = fakeReader(() => ok({ leftAt: 9000 }));
    expect(await source(m, r).readFor(FORM, "f1")).toEqual({ windowId: MAIL });
    expect(r.reads).toEqual([MAIL]);
  });

  it("reads no tab when the window just left is not a page, however recently another page was left", async () => {
    const m = modelWith([[MAIL, 1000], [NOTES, 2000], [FORM, 9000]]);
    const r = fakeReader(() => ok());
    expect(await source(m, r).readFor(FORM, "f1")).toEqual({ refused: "notAPage" });
    expect(r.reads).toEqual([]);
  });

  it("reads no tab other than the one just left: an earlier tab, the form's own, or one never left", async () => {
    const r = fakeReader(() => ok());
    const m = modelWith([[MAIL, 1000], [FORM, 2000]]);
    // The form's own tab is never the window just left for it.
    expect(await source(m, r).readFor(FORM, "f1")).toEqual({ windowId: MAIL });
    expect(r.reads).toEqual([MAIL]);
    // "page:eng1:4" was left before the mail tab; the mail tab is the one just left.
    const m2 = modelWith([["page:eng1:4", 500], [MAIL, 1000], [FORM, 2000]]);
    const r2 = fakeReader(() => ok());
    await source(m2, r2).readFor(FORM, "f1");
    expect(r2.reads).toEqual([MAIL]);
    // A page the user is still in is never read: here a fill for a form that never had focus, while they read the mail.
    const m3 = modelWith([[MAIL, 1000]]);
    const r3 = fakeReader(() => ok());
    expect(await source(m3, r3).readFor(FORM, "f1")).toEqual({ refused: "notLeft" });
    expect(r3.reads).toEqual([]);
  });

  it("reads nothing once LEFT_TAB_MS has passed since the user left the tab", async () => {
    const m = modelWith([[MAIL, 1000], [FORM, 2000]]);
    const r = fakeReader(() => ok({ leftAt: 2000 }));
    now = 2000 + LEFT_TAB_MS + 1;
    expect(await source(m, r).readFor(FORM, "f1")).toEqual({ refused: "tooLong" });
    expect(r.reads).toEqual([]);
  });

  it("keeps nothing the worker refused: a navigation, a reload or a closed tab since the user left it", async () => {
    const m = modelWith([[MAIL, 1000], [FORM, 2000]]);
    const s = source(m, fakeReader(() => ({ type: "pageResult", v: 1, id: "r", at: 0, outcome: "notAllowed", detail: "the tab navigated or reloaded since you left it" })));
    expect(await s.readFor(FORM, "f1")).toEqual({ refused: "refused" });
    expect(s.viewFor("f1")).toBe(m);
    const gone = source(m, fakeReader(() => null));
    expect(await gone.readFor(FORM, "f1")).toEqual({ refused: "noEngine" });
  });

  it("holds the text no longer than LEFT_TAB_MS after the user left, by the earlier of the helper's and the worker's clocks", async () => {
    const m = modelWith([[MAIL, 1000], [FORM, 5000]]);
    const dropped: string[] = [];
    const s = source(m, fakeReader(() => ok({ leftAt: 4000 })), dropped);
    await s.readFor(FORM, "f1");
    now = 4000 + LEFT_TAB_MS - 1;
    expect(s.holding()).toBe(MAIL);
    now = 4000 + LEFT_TAB_MS;
    expect(s.holding()).toBeNull();
    expect(s.viewFor("f1")).toBe(m);
    await Promise.resolve();
    expect(dropped).toEqual([MAIL]);
  });

  it("drops the text when the user moved on while it was read", async () => {
    const m = modelWith([[MAIL, 1000], [FORM, 2000]]);
    const s = source(m, {
      readText: async () => {
        m.apply(snap([], { at: 3000, windowId: NOTES, focused: true, app: NOTES_APP }));
        m.apply(snap([field(`${FORM}/x`, "")], { at: 3500, windowId: FORM, focused: true, kind: "page" }));
        return ok();
      },
      sitesOff: () => [],
      documentOf: () => "D1",
    });
    expect(await s.readFor(FORM, "f1")).toEqual({ refused: "moved" });
    expect(s.holding()).toBeNull();
  });
});

describe("TabSource: never from an excluded site (rule 5)", () => {
  it("keeps nothing when a frame read is on a site the user turned Caret off for, or the worker says the site is off", async () => {
    const m = modelWith([[MAIL, 1000], [FORM, 2000]]);
    const off = new TabSource({ model: m, reader: fakeReader(() => ok(), ["https://mail.example.test"]), now: () => 3000, count: () => {}, dropped: () => {} });
    expect(await off.readFor(FORM, "f1")).toEqual({ refused: "siteOff" });
    expect(off.holding()).toBeNull();
    const child = new TabSource({ model: m, reader: fakeReader(() => ok({ frames: [{ frameId: 0, origin: "https://mail.example.test" }, { frameId: 4, origin: "https://ads.example.test" }] }), ["https://ads.example.test"]), now: () => 3000, count: () => {}, dropped: () => {} });
    expect(await child.readFor(FORM, "f1")).toEqual({ refused: "siteOff" });
    const said = new TabSource({ model: m, reader: fakeReader(() => ({ type: "pageResult", v: 1, id: "r", at: 0, outcome: "siteOff", detail: "Caret never reads this site" })), now: () => 3000, count: () => {}, dropped: () => {} });
    expect(await said.readFor(FORM, "f1")).toEqual({ refused: "siteOff" });
  });
});

describe("TabSource: the text expires and never enters the model (rule 6)", () => {
  it("is static text of the tab's window in fill's view only, selection first, and gone from the view once released", async () => {
    const m = modelWith([[MAIL, 1000], [FORM, 2000]]);
    const s = new TabSource({ model: m, reader: fakeReader(() => ok({ selection: ["Email: ines.vandermeer@example.org"] })), now: () => 3000, count: () => {}, dropped: () => {} });
    await s.readFor(FORM, "f1");
    const v = s.viewFor("f1");
    const read = [...(v.windows.get(MAIL)?.nodes.values() ?? [])].filter((n) => n.subrole === PAGE_SUBROLE.readOnDemand);
    expect(read.map((n) => n.value)).toEqual(["Email: ines.vandermeer@example.org", ...MESSAGE.blocks]);
    expect(read.every((n) => n.role === "AXStaticText")).toBe(true);
    expect(v.windows.get(MAIL)?.window.title).toBe(MESSAGE.title);
    // The model itself never holds it, and its change log never saw it.
    expect([...(m.windows.get(MAIL)?.nodes.values() ?? [])].some((n) => n.subrole === PAGE_SUBROLE.readOnDemand)).toBe(false);
    expect(m.changeLog().some((c) => (c.after ?? "").includes("Vandermeer"))).toBe(false);
    s.pass("f1", "offer-1");
    s.release("f1");
    expect(s.holding()).toBe(MAIL);
    s.release("offer-1");
    expect(s.holding()).toBeNull();
    expect([...(s.viewFor("offer-1").windows.get(MAIL)?.nodes.values() ?? [])].some((n) => n.subrole === PAGE_SUBROLE.readOnDemand)).toBe(false);
  });

  it("is seen only by the fill that read it and the offers it made, never by another fill (P4 review)", async () => {
    const m = modelWith([[MAIL, 1000], [FORM, 2000]]);
    const s = new TabSource({ model: m, reader: fakeReader(() => ok()), now: () => 3000, count: () => {}, dropped: () => {} });
    await s.readFor(FORM, "f1");
    s.pass("f1", "offer-1");
    expect(s.viewFor("f1")).not.toBe(m);
    expect(s.viewFor("offer-1")).not.toBe(m);
    // A second fill, refused its own read (its window just left was a note), reads the model alone.
    expect(s.viewFor("f2")).toBe(m);
    expect(s.holds("f2")).toBe(false);
  });

  it("reads afresh for every fill, and drops what it holds when its site is turned off or its tab shows another document (P4 review)", async () => {
    const m = modelWith([[MAIL, 1000], [FORM, 2000]]);
    const r = fakeReader(() => ok());
    const s = new TabSource({ model: m, reader: r, now: () => 3000, count: () => {}, dropped: () => {} });
    await s.readFor(FORM, "f1");
    await s.readFor(FORM, "f2");
    expect(r.reads).toEqual([MAIL, MAIL]);
    r.off.push("https://mail.example.test");
    expect(s.holding()).toBeNull();
    expect(s.viewFor("f2")).toBe(m);
    r.off.length = 0;
    await s.readFor(FORM, "f3");
    expect(s.holding()).toBe(MAIL);
    r.docs.set(MAIL, "D2");
    expect(s.holds("f3")).toBe(false);
  });

  it("lets no ambient read take the text a pinned owner holds; an explicit one still may (I6 review)", async () => {
    const m = modelWith([[MAIL, 1000], [FORM, 2000]]);
    const r = fakeReader(() => ok());
    const s = new TabSource({ model: m, reader: r, now: () => 3000, count: () => {}, dropped: () => {}, pinned: (o) => o === "goal-1" });
    await s.readFor(FORM, "goal-1");
    expect(await s.readFor(FORM, "fill:2", { ambient: true })).toEqual({ refused: "pinned" });
    expect(s.holds("goal-1")).toBe(true);
    expect(s.holds("fill:2")).toBe(false);
    expect(await s.readFor(FORM, "fill:3")).toEqual({ windowId: MAIL });
    expect(s.holds("goal-1")).toBe(false);
  });

  it("holds one tab at a time: a read of another tab drops the first", async () => {
    const m = modelWith([[MAIL, 1000], [FORM, 2000], ["page:eng1:4", 2500], ["page:eng1:5", 2600]]);
    const s = new TabSource({ model: m, reader: fakeReader((w) => ok({ tabId: Number(w.split(":")[2]) })), now: () => 3000, count: () => {}, dropped: () => {} });
    await s.readFor(FORM, "f1");
    expect(s.holding()).toBe(MAIL);
    await s.readFor("page:eng1:5", "f2");
    expect(s.holding()).toBe("page:eng1:4");
  });
});

describe("one fill from the tab the user just left (rules 1 to 7, through the helper)", () => {
  /** Two tabs of one engine, played as the worker plays them: the mail tab is the one the user left; acts write values. */
  class TwoTabs {
    readonly sent: HelperToEngine[] = [];
    readonly session: EngineSession;
    form = [ctl("e1", "text", "First name"), ctl("e2", "text", "Last name"), ctl("e3", "email", "Email")];
    /** The tab the worker saw the user leave, and whether it still holds the document they left. */
    left: number | null = null;
    unchanged = true;
    constructor() {
      this.session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
        this.sent.push(m);
        queueMicrotask(() => this.answer(m));
        return true;
      }, 500);
    }
    private reply(id: string, r: object): void {
      this.session.receive({ type: "pageResult", v: 1, id, at: Date.now(), ...r } as never);
    }
    walk(tabId: number): PageSnapshot {
      return tabId === 3
        ? tabSnap(3, MESSAGE.title, "https://mail.example.test", [ctl("m1", "search", "Search mail")], null, this.left !== 3)
        : tabSnap(7, "Apply: Field Robotics Technician", "http://127.0.0.1:4310", structuredClone(this.form), { frameId: 0, id: "e1", selection: [0, 0], text: { before: "", after: "", selection: "" } }, true);
    }
    private answer(m: HelperToEngine): void {
      if (m.type === "pageReadText") {
        if (this.left !== m.tabId) return this.reply(m.id, { outcome: "notAllowed", detail: "it is not the tab you just left" });
        if (!this.unchanged) return this.reply(m.id, { outcome: "notAllowed", detail: "the tab navigated or reloaded since you left it" });
        return this.reply(m.id, { outcome: "ok", detail: null, text: { ...MESSAGE, leftAt: Date.now() - 1000 } });
      }
      if (m.type !== "pageCommand") return;
      const v: PageVerb = m.verb;
      if (v.kind === "pageWalk") {
        this.session.receive({ ...this.walk(v.tabId ?? 7), id: m.id });
        return this.reply(m.id, { outcome: "ok", detail: null });
      }
      if (v.kind !== "pageWrite") return this.reply(m.id, { outcome: "handoff", detail: "yours", risk: "pageScript" });
      const x = this.form.find((c) => c.id === v.id);
      if (x === undefined || (x.value ?? "") !== v.expect) return this.reply(m.id, { outcome: "stale", detail: "changed" });
      x.value = v.value;
      return this.reply(m.id, { outcome: "ok", detail: null, readings: { before: v.expect, afterInput: v.value, afterBlur: v.value, invalid: false, error: null } });
    }
    get reads(): number[] {
      return this.sent.flatMap((m) => (m.type === "pageReadText" ? [m.tabId] : []));
    }
  }

  const PICK: Record<string, string> = { "First name": "Ines", "Last name": "Vandermeer", Email: "ines.vandermeer@example.org" };
  let dir: string;
  let store: Store;
  let tabs: TwoTabs;
  let host: PageHost;
  let helper: Helper;
  let published: HelperMessage[];
  let warnings: string[];
  /** The helper's clock runs this far ahead of the real one; a test moves it to let held text expire. */
  let ahead = 0;

  beforeEach(async () => {
    ahead = 0;
    dir = mkdtempSync(join(tmpdir(), "caret-p4-"));
    store = new Store(join(dir, "data"));
    tabs = new TwoTabs();
    published = [];
    warnings = [];
    host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: { run: async () => ({ type: "verbResult", v: 1, id: "r", at: 0, outcome: "ok", detail: null }) }, apply: (m) => void helper.handleReader(m), warn: (l) => void warnings.push(l) });
    helper = new Helper({
      store, askJev: jevPickingText((_, ins) => PICK[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null, 0.95), shadow: false, allowBackgroundFocus: true, readerLink: host.link, calendar: null, now: () => Date.now() + ahead,
      tabReader: pageTabReader(host.registry), publish: (m) => void published.push(m), warn: (l) => void warnings.push(l),
    });
    wirePageEngines({ host, helper, publish: () => {}, warn: (l) => void warnings.push(l), allowBackground: true });
    host.registry.add(tabs.session);
    tabs.session.receive(hello);
    await new Promise((r) => setTimeout(r, 0));
  });
  afterEach(() => {
    helper.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The user reads the mail tab, switches to the form tab, and focus lands in First name (the worker's two pageFocus reports). */
  const switchToForm = async (): Promise<void> => {
    tabs.session.onFocus?.({ type: "pageFocus", v: 1, at: Date.now(), tabId: 3, frameId: 0 }, tabs.session);
    await vi.waitFor(() => expect(helper.model.windows.get(MAIL)?.focused).toBe(true));
    tabs.left = 3;
    tabs.session.onFocus?.({ type: "pageFocus", v: 1, at: Date.now(), tabId: 7, frameId: 0 }, tabs.session);
  };
  const popup = async (): Promise<OfferPopup> => {
    await vi.waitFor(() => expect(published.some((m) => m.type === "popup")).toBe(true), { timeout: 2000 });
    return published.find((m): m is OfferPopup => m.type === "popup") as OfferPopup;
  };

  it("fills the form from the message in the tab just left, reading that tab once, and drops its text when the offer is taken", async () => {
    await switchToForm();
    const p = await popup();
    expect(tabs.reads).toEqual([3]);
    const r = await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: p.offerKey, actionId: "fillAll", overrides: {}, at: Date.now() });
    expect(r).toMatchObject({ outcome: "done" });
    expect(tabs.form.map((c) => c.value)).toEqual(["Ines", "Vandermeer", "ines.vandermeer@example.org"]);
    // The tab's text left the view with the offer; the model never held it; no warning carries it.
    expect([...(helper.model.windows.get(MAIL)?.nodes.values() ?? [])].some((n) => n.subrole === PAGE_SUBROLE.readOnDemand)).toBe(false);
    expect(warnings.join("\n")).not.toMatch(/Vandermeer|Gareth/);
    store.flush();
    expect(store.counts()["tabtext.read"]).toBe(1);
  });

  it("reads nothing, and offers nothing from the message, when the worker says the tab changed since the user left it", async () => {
    tabs.unchanged = false;
    await switchToForm();
    await vi.waitFor(() => expect(tabs.reads).toEqual([3]));
    await new Promise((r) => setTimeout(r, 50));
    expect(published.some((m) => m.type === "popup")).toBe(false);
    store.flush();
    expect(store.counts()["tabtext.refused_refused"]).toBe(1);
  });

  it("withdraws the offer when the text it was read from expires, and refuses a late Tab", async () => {
    await switchToForm();
    const p = await popup();
    ahead = LEFT_TAB_MS + 10;
    // The view checks the clock; the recheck at Tab finds every source gone, and nothing is written.
    const r = await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: p.offerKey, actionId: "fillAll", overrides: {}, at: Date.now() });
    expect(r).toBeNull();
    expect(tabs.form.map((c) => c.value)).toEqual(["", "", ""]);
    expect(published.some((m) => m.type === "offerWithdrawn" && m.id === p.offerKey)).toBe(true);
  });
});

describe("a fill whose tab text expires while Jev answers (rule 6, P4 review)", () => {
  it("offers nothing from it, and asks Jev nothing more", async () => {
    // Shares the two-tab setup by running the same steps in a fresh helper.
    const dir = mkdtempSync(join(tmpdir(), "caret-p4-exp-"));
    const store = new Store(join(dir, "data"));
    let ahead = 0;
    let calls = 0;
    const published: HelperMessage[] = [];
    let helper: Helper;
    const sent: HelperToEngine[] = [];
    /** The user has switched to the form tab: the mail tab is no longer the active one. */
    let inForm = false;
    const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
      sent.push(m);
      queueMicrotask(() => {
        const reply = (id: string, r: object): void => void session.receive({ type: "pageResult", v: 1, id, at: Date.now(), ...r } as never);
        if (m.type === "pageReadText") return reply(m.id, { outcome: "ok", detail: null, text: { ...MESSAGE, leftAt: Date.now() - 1000 } });
        if (m.type === "pageCommand" && m.verb.kind === "pageWalk") {
          const tab = m.verb.tabId === 3 ? tabSnap(3, MESSAGE.title, "https://mail.example.test", [ctl("m1", "search", "Search mail")], null, false) : tabSnap(7, "Apply", "http://127.0.0.1:4310", [ctl("e1", "text", "First name"), ctl("e2", "text", "Last name"), ctl("e3", "email", "Email")], { frameId: 0, id: "e1", selection: [0, 0] }, true);
          session.receive({ ...tab, id: m.id, active: m.verb.tabId === 3 ? !inForm : true, inFocusedWindow: true });
          return reply(m.id, { outcome: "ok", detail: null });
        }
      });
      return true;
    }, 500);
    const host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: { run: async () => ({ type: "verbResult", v: 1, id: "r", at: 0, outcome: "ok", detail: null }) }, apply: (m) => void helper.handleReader(m), warn: () => {} });
    const PICK: Record<string, string> = { "First name": "Ines", "Last name": "Vandermeer", Email: "ines.vandermeer@example.org" };
    const picking = jevPickingText((_, ins) => PICK[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null, 0.95);
    helper = new Helper({
      store, shadow: false, allowBackgroundFocus: true, readerLink: host.link, calendar: null, now: () => Date.now() + ahead, tabReader: pageTabReader(host.registry), publish: (m) => void published.push(m), warn: () => {},
      // The text's time runs out while Jev answers the first question.
      askJev: async (req) => {
        calls++;
        ahead = LEFT_TAB_MS + 10;
        return picking(req);
      },
    });
    wirePageEngines({ host, helper, publish: () => {}, warn: () => {}, allowBackground: true });
    host.registry.add(session);
    session.receive(hello);
    await new Promise((r) => setTimeout(r, 0));
    try {
      session.onFocus?.({ type: "pageFocus", v: 1, at: Date.now(), tabId: 3, frameId: 0 }, session);
      await vi.waitFor(() => expect(helper.model.windows.get(MAIL)?.focused).toBe(true));
      inForm = true;
      session.onFocus?.({ type: "pageFocus", v: 1, at: Date.now(), tabId: 7, frameId: 0 }, session);
      await vi.waitFor(() => expect(sent.some((m) => m.type === "pageReadText")).toBe(true));
      await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 100));
      expect(published.some((m) => m.type === "popup" || m.type === "fillProposal")).toBe(false);
      // At most the one question already on its way when the text expired.
      expect(calls).toBe(1);
    } finally {
      helper.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the text around the caret is not kept (item 7, P4 review)", () => {
  it("reaches the one waiting for the walk, and the tab's kept snapshot holds none of it", async () => {
    let session: EngineSession;
    session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
      if (m.type === "pageCommand") queueMicrotask(() => {
        session.receive({ ...tabSnap(7, "Apply", "http://127.0.0.1:4310", [ctl("e1", "textarea", "Cover letter")], { frameId: 0, id: "e1", selection: [5, 5], text: { before: "Dear ", after: "", selection: "" } }, true), id: m.id, docs: { kind: "document", text: "on", field: { before: "Owner: ", after: "Ines", selection: "" } } });
        session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, outcome: "ok", detail: null });
      });
      return true;
    }, 200);
    session.receive(hello);
    const a = await session.command({ kind: "pageWalk", tabId: 7 });
    expect(a.snapshot?.focused?.text?.before).toBe("Dear ");
    expect(session.tabs.get(7)?.focused).toEqual({ frameId: 0, id: "e1", selection: [5, 5] });
    expect(session.tabs.get(7)?.docs).toEqual({ kind: "document", text: "on", field: null });
  });
});

describe("pageTabReader", () => {
  it("asks only a live engine that said hello, for the tab the page window names", async () => {
    const sent: HelperToEngine[] = [];
    const s = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => (sent.push(m), true), 50);
    const r = pageTabReader({ session: (e) => (e === "eng1" ? s : undefined), sitesOff: () => [], documentOf: () => null });
    expect(await r.readText("page:eng1:3")).toBeNull();
    s.receive(hello);
    void r.readText("page:eng1:3");
    expect(await r.readText("page:other:3")).toBeNull();
    expect(await r.readText("notes")).toBeNull();
    expect(sent.map((m) => (m.type === "pageReadText" ? m.tabId : null))).toEqual([3]);
    // toWindowSnapshot is untouched by a read: a page window's nodes are its controls only.
    expect(toWindowSnapshot(tabSnap(3, "t", "https://x.test", [], null, true), s, 1).nodes.every((n) => n.subrole !== PAGE_SUBROLE.readOnDemand)).toBe(true);
  });
});
