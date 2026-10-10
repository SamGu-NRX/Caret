// T8: the stores outside the screen model that kept screen text past its ten minutes, each now bounded by the model's
// expiry or by the life of the task that needs it. Executor stores are in executor.test.ts (T8). Every value is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineRegistry } from "../src/engines/registry.ts";
import { EngineSession } from "../src/engines/session.ts";
import { Helper } from "../src/helper.ts";
import { PROTOCOL_VERSION, type PageControl, type PageSnapshot } from "../src/protocol.ts";
import { Store } from "../src/store.ts";
import { field, FIXTURE_APP, focus, MAIL_APP, snap, text, value } from "./builders.ts";

const MIN = 60 * 1000;
const X = "kcmlnoabcdefghijklmnopabcdefghij";
const CHROME = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const control = (id: string, name: string, v: string): PageControl => ({ id, key: `form[a]/text:${name.toLowerCase()}~0`, strongKey: null, kind: "text", role: "text", name, form: "form#a", rect: [0, 0, 100, 20], value: v });
const page = (at: number, tabId: number, controls: PageControl[]): PageSnapshot => ({
  type: "pageSnapshot", v: PROTOCOL_VERSION, id: `w${tabId}`, at, tabId, browserWindowId: 1, active: false, inFocusedWindow: false, title: "Lumen order",
  frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "https://shop.example", path: "/", navGen: 1, title: "Lumen order", headings: [], iframes: [], excluded: {}, truncated: false, controls }],
  missing: [],
  focused: null,
});

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

  it("the page engine keeps a tab's last walk only while the model keeps its window", async () => {
    const reg = new EngineRegistry({ apply: (x) => void h.handleReader(x), purge: (x) => h.purgeWindow(x) });
    // As engines/wire.ts wires it.
    h.onWindowExpired((id) => reg.forgetWindow(id));
    const s = new EngineSession({ engine: "eng1", browser: CHROME, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, () => true);
    reg.add(s);
    s.receive({ type: "pageHello", v: 1, extensionId: X, version: "0.1.0", profile: "p", instance: "w", startedAt: 1, capabilities: [] });
    await new Promise((r) => setTimeout(r, 0));
    const walk = page(1000, 7, [control("e1", "Address", "4471 Larkspur Lane")]);
    s.tabs.set(7, walk);
    s.onSnapshot?.(walk, s);
    expect(h.model.windows.has("page:eng1:7")).toBe(true);
    h.tick(1000 + 10 * MIN);
    expect(s.tabs.has(7)).toBe(true);
    h.tick(1000 + 10 * MIN + 10_000);
    expect(h.model.windows.has("page:eng1:7")).toBe(false);
    expect(s.tabs.has(7)).toBe(false);
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
