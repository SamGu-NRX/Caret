// T8: the stores outside the screen model that kept screen text past its ten minutes, each now bounded by the model's
// expiry or by the life of the task that needs it. Executor stores are in executor.test.ts (T8). Every value is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pageHost, type PageHost } from "../src/engines/host.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { Helper } from "../src/helper.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { Store } from "../src/store.ts";
import { field, FIXTURE_APP, focus, MAIL_APP, snap, text, value } from "./builders.ts";
import { c, chrome, FakePage, hello, okReader, TEXTEDIT, WIN } from "./fake-page.ts";

const MIN = 60 * 1000;

describe("T8 stores", () => {
  let dir: string;
  let store: Store;
  let h: Helper;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-t8-"));
    store = new Store(join(dir, "data"));
    h = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => {} });
  });
  afterEach(() => {
    h.shutdown();
    h.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a judged transfer keeps no text of its source, only the value entered and its hashes", () => {
    void h.handleReader(snap([text("m/p~0", "Call Kofi on +1 (512) 555-0142 after six")], { at: 1, windowId: "6160-1", app: MAIL_APP, values: [value("phone", "+1 (512) 555-0142", "m/p~0")] }));
    void h.handleReader(snap([field("f/phone~0", "", { label: "Phone" })], { at: 2, windowId: "5150-1", app: FIXTURE_APP, focused: true }));
    void h.handleReader(focus("5150-1", "f/phone~0", 3));
    void h.handleReader(snap([field("f/phone~0", "+1 (512) 555-0142", { label: "Phone" })], { at: 4, windowId: "5150-1", focused: true, values: [value("phone", "+1 (512) 555-0142", "f/phone~0")] }));
    h.tick(10_000);
    const [t] = h.recentTransfers;
    expect(t?.value).toBe("+1 (512) 555-0142");
    expect(t?.src.windowId).toBe("6160-1");
    expect(t?.src.text).toBe("");
  });
});

// The page engine's last walk of a tab, wired as main.ts wires it (engines/wire.ts). The fake page keeps its text field's
// text to itself and sends hasValue and rev (#52), so what a walk keeps here is the tab's names, title and choices.
describe("T8 page walks", () => {
  let dir: string;
  let store: Store;
  let page: FakePage;
  let host: PageHost;
  let h: Helper;
  const tabs = () => page.session.tabs;
  const walk = async () => expect((await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN })).outcome).toBe("ok");
  const readerHello = () => void h.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 1, version: "t" });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-t8-page-"));
    store = new Store(join(dir, "data"));
    page = new FakePage(() => [c("e1", "text", "Delivery address", { value: "4471 Larkspur Lane" }), c("e2", "select", "Lumen plan", { options: [{ value: "p", label: "Lumen Pro", selected: true }] })], "Lumen order");
    host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: okReader, apply: (m) => void h.handleReader(m), purge: (s) => h.purgeWindow(s), warn: () => {} });
    h = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, readerLink: host.link, pageCovers: (pid) => host.registry.forBrowser(pid) !== undefined, publish: () => {}, warn: () => {} });
    wirePageEngines({ host, helper: h, publish: () => {}, warn: () => {} });
    host.registry.add(page.session);
    page.session.receive(hello);
    await new Promise((r) => setTimeout(r, 0));
    await walk();
    // The user goes on to a note in another app, so the tab is no longer the window they are in, which counts as on screen.
    await h.handleReader(snap([field("te/note~0", "Lumen order notes")], { at: Date.now(), windowId: "note", app: TEXTEDIT, focused: true }));
    expect(h.model.userWindow()?.window.windowId).toBe("note");
    expect(h.model.windows.has(WIN)).toBe(true);
    expect(tabs().has(7)).toBe(true);
  });
  afterEach(() => {
    page.session.close();
    h.shutdown();
    h.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a tab's last walk only while the model keeps its window", () => {
    const at = Date.now();
    h.tick(at + 10 * MIN - 10_000);
    expect(tabs().has(7)).toBe(true);
    h.tick(at + 10 * MIN + 10_000);
    expect(h.model.windows.has(WIN)).toBe(false);
    expect(tabs().has(7)).toBe(false);
  });

  it("drops a tab's last walk when the native reader reconnects, since the reset window never expires later (F7)", async () => {
    readerHello();
    expect(h.model.windows.has(WIN)).toBe(false);
    expect(tabs().has(7)).toBe(false);
    // No further walk: nothing is left for a later tick to find, and the registry answers as for a tab never walked.
    h.tick(Date.now() + 11 * MIN);
    expect(tabs().has(7)).toBe(false);
    expect(host.registry.contextOf(WIN)).toBeNull();
    // The next walk brings the tab back, into the model and the registry both.
    await walk();
    expect(h.model.windows.has(WIN)).toBe(true);
    expect(tabs().has(7)).toBe(true);
  });
});
