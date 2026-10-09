// Regression tests for faults found in review: each case failed before its fix.
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { ScreenModel } from "../src/model.ts";
import { formFields } from "../src/fill/fill.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type HelperMessage } from "../src/protocol.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { field, focus, FIXTURE_APP, MAIL_APP, node, snap, text, value } from "./builders.ts";

const FORM = "5150-1";
const SRC = "6160-1";
const K = (s: string) => `dev.caret.fixture/standard/${s}`;

describe("review fixes", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-review-"));
    store = new Store(join(dir, "data"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a partial snapshot elsewhere in the window keeps the focused key", () => {
    const m = new ScreenModel();
    m.apply(snap([field(K("textfield:email~0"), "", { label: "Email" }), text(K("statictext:clock~0"), "10:00")], { at: 1, windowId: FORM, focused: true, focusedKey: K("textfield:email~0") }));
    m.apply(snap([text(K("statictext:clock~0"), "10:01")], { at: 2, windowId: FORM, focused: true, root: K("statictext:clock~0"), focusedKey: null }));
    expect(m.windows.get(FORM)?.focusedKey).toBe(K("textfield:email~0"));
  });

  it("a new reader session forgets the previous session's windows", () => {
    const h = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => {} });
    void h.handleReader(snap([text("m/a~0", "old source")], { at: 1, windowId: SRC, app: MAIL_APP }));
    void h.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 9, version: "t" });
    expect(h.model.windows.size).toBe(0);
    expect(h.text.size).toBe(0);
  });

  it("drops a proposal whose trigger field was filled while Jev was answering", async () => {
    let h: Helper | null = null;
    const slowJev: AskJev = async (req) => {
      // The user types into the field before the answer arrives.
      void h?.handleReader(snap([field(K("textfield:email~0"), "typed@example.com", { label: "Email" })], { at: 3, windowId: FORM, focused: true }));
      return { model: "t", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: Object.keys(req.questions[id]?.criteria ?? {})[0] ?? "none", confidence: 0.9 }])), inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    const published: HelperMessage[] = [];
    h = new Helper({ store, askJev: slowJev, shadow: false, allowBackgroundFocus: false, publish: (m) => published.push(m) });
    void h.handleReader(snap([text("m/a~0", "dana@example.com")], { at: 1, windowId: SRC, app: MAIL_APP, values: [value("email", "dana@example.com", "m/a~0")] }));
    void h.handleReader(snap([field(K("textfield:email~0"), "", { label: "Email" })], { at: 2, windowId: FORM, focused: true }));
    const p = await h.handleReader(focus(FORM, K("textfield:email~0"), 2));
    expect(p).toBeNull();
    expect(published).toHaveLength(0);
  });

  it("a whole entry of four or five characters that is a typed value still counts as a transfer", () => {
    const h = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => {} });
    void h.handleReader(snap([text("m/t~0", "Starts 3:00 sharp")], { at: 1, windowId: SRC, app: MAIL_APP, values: [value("time", "3:00", "m/t~0")] }));
    void h.handleReader(snap([field(K("textfield:time~0"), "", { label: "Time" })], { at: 2, windowId: FORM, focused: true }));
    void h.handleReader(snap([field(K("textfield:time~0"), "3:00", { label: "Time" })], { at: 3, windowId: FORM, focused: true, values: [value("time", "3:00", K("textfield:time~0"))] }));
    h.tick(10_000);
    expect(h.recentTransfers.map((t) => [t.value, t.kind])).toEqual([["3:00", "time"]]);
  });

  it("closing the destination window still matches a reformatted phone by its kind", () => {
    const h = new Helper({ store, askJev: null, shadow: true, allowBackgroundFocus: false, publish: () => {} });
    void h.handleReader(snap([text("m/p~0", "Call +1 (512) 555-0142")], { at: 1, windowId: SRC, app: MAIL_APP, values: [value("phone", "+1 (512) 555-0142", "m/p~0")] }));
    void h.handleReader(snap([field(K("textfield:phone~0"), "", { label: "Phone" })], { at: 2, windowId: FORM, app: FIXTURE_APP, focused: true }));
    void h.handleReader(focus(FORM, K("textfield:phone~0"), 3));
    void h.handleReader(snap([field(K("textfield:phone~0"), "512-555-0142", { label: "Phone" })], { at: 4, windowId: FORM, focused: true, values: [value("phone", "512-555-0142", K("textfield:phone~0"))] }));
    void h.handleReader({ type: "windowClosed", v: PROTOCOL_VERSION, at: 5, windowId: FORM });
    expect(store.shadowEpisodes()[0]).toMatchObject({ existed: "normalized", kind: "phone" });
  });

  it("text in the window the user is in does not age out of the text window while a reader is connected", () => {
    const h = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => {} });
    // The reader sends nothing for a walk that finds the window unchanged; the window the user is in still counts as on
    // screen. Any other window ages out ten minutes after its last snapshot (model-retention.test.ts).
    void h.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 1, version: "t" });
    void h.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: 1, from: null, to: MAIL_APP });
    void h.handleReader(snap([text("m/a~0", "still visible text")], { at: 1, windowId: SRC, app: MAIL_APP, focused: true }));
    for (let t = 0; t <= 20 * 60 * 1000; t += 10_000) h.tick(t);
    expect(h.text.find("still visible text", null, { excludeWindowId: FORM, seenBy: 20 * 60 * 1000 })).not.toBeNull();
  });

  it("the server creates its socket directory and shuts down with a reader still connected", async () => {
    const path = join(dir, "nested", "sockets", "screen.sock");
    const h = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => {} });
    const server = new HelperServer(path, () => h, () => {});
    await server.listen();
    const c = createConnection(path);
    await new Promise<void>((r) => c.once("connect", () => r()));
    c.write(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 1, version: "t" }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    const closed = new Promise<boolean>((r) => c.once("close", () => r(true)));
    // Before the fix, close() waited for the reader to hang up, so this await never returned.
    await server.close();
    expect(await closed).toBe(true);
  });

  it("a filled editable field never counts as empty for fill, even when its value repeats its label", () => {
    const m = new ScreenModel();
    m.apply(
      snap(
        [
          node(K("textfield:street~0"), "AXTextField", { editable: true, label: "Street" }),
          node(K("textfield:city~0"), "AXTextField", { editable: true, label: "City", value: "City" }),
        ],
        { at: 1, windowId: FORM },
      ),
    );
    const w = m.windows.get(FORM)!;
    expect(formFields(w, K("textfield:street~0")).map((n) => n.key)).toEqual([K("textfield:street~0")]);
  });
});
