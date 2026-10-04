import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { ReaderMessage } from "../src/protocol.ts";
import { Store } from "../src/store.ts";
import { field, FIXTURE_APP, MAIL_APP, snap, text, value } from "./builders.ts";

const SESSION = fileURLToPath(new URL("../fixtures/recorded/transfer-session.ndjson", import.meta.url));

function replay(helper: Helper, path: string): void {
  let last = 0;
  for (const line of readFileSync(path, "utf8").trim().split("\n")) {
    const m = ReaderMessage.parse(JSON.parse(line));
    const at = "at" in m ? m.at : last;
    // Advance the clock in small steps so settle timers fire as they would live.
    for (let t = last; t < at; t += 250) helper.tick(t);
    last = at;
    void helper.handleReader(m);
  }
  helper.tick(last + 5000);
  helper.shutdown();
}

describe("transfer detection on the recorded synthetic session", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-helper-test-"));
    store = new Store(dir);
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => {} });
    replay(helper, SESSION);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the typed email, the reformatted phone and the order number, and nothing else", () => {
    const got = helper.recentTransfers.map((t) => [t.value, t.kind, t.match, t.src.windowId, t.dst.key.split("/").pop()]);
    expect(got).toEqual([
      ["dana.whitfield@example.com", "email", "exact", "6160-1", "textfield:email~0"],
      ["512-555-0142", "phone", "normalized", "6160-1", "textfield:phone~0"],
      ["ORD-2026-48213", "id", "exact", "6160-1", "textfield:order number~0"],
    ]);
  });

  it("judges a value typed one character at a time once, as a whole", () => {
    expect(helper.recentTransfers.filter((t) => t.dst.key.endsWith("email~0"))).toHaveLength(1);
  });

  it("ignores a value whose only source appeared after it was entered", () => {
    expect(helper.recentTransfers.some((t) => t.value.includes("caret-fixture"))).toBe(false);
  });

  it("attributes edits in the focused window to the user and measures the source's age", () => {
    for (const t of helper.recentTransfers) {
      expect(t.attribution).toBe("user");
      expect(t.ageMs).toBeGreaterThan(0);
    }
  });

  it("persists hashes and metadata only, never the plain value", () => {
    const rows = store.transfers();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.valueHash).toBe(store.hash("dana.whitfield@example.com"));
    expect(rows.map((r) => r.length)).toEqual([26, 12, 14]);
    store.close();
    // Every file under the directory, the markdown memory folder included (M1).
    for (const f of readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1))) {
      const bytes = readFileSync(join(dir, f)).toString("latin1");
      for (const secret of ["dana.whitfield", "555-0142", "ORD-2026", "Order confirmation", "Call me after lunch"]) {
        expect(bytes.includes(secret), `${f} contains ${secret}`).toBe(false);
      }
    }
    store = new Store(dir);
  });
});

describe("a message sent within the settle time of its last keystroke", () => {
  // All names and numbers are invented.
  const SRC = "6160-1";
  const CHAT = "5150-1";
  const COMPOSER = "dev.caret.fixture/standard/textarea:message~0";
  let dir: string;
  let store: Store;
  let helper: Helper;

  const source = (at: number) =>
    snap([text("m/statictext:a~0", "Ticket QX-77120 for the venue deposit", [0, 0, 300, 10])], {
      at,
      windowId: SRC,
      app: MAIL_APP,
      values: [value("id", "QX-77120", "m/statictext:a~0")],
    });
  const chat = (at: number, message: string, values: ReturnType<typeof value>[] = []) =>
    snap([field(COMPOSER, message, { role: "AXTextArea", label: "Message" })], { at, windowId: CHAT, app: FIXTURE_APP, focused: true, values });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-helper-test-"));
    store = new Store(dir);
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => {} });
  });
  afterEach(() => {
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const type = (from: number, message: string, values: ReturnType<typeof value>[] = []): number => {
    let at = from;
    for (let i = 1; i <= message.length; i++) {
      at = from + i * 80;
      void helper.handleReader(chat(at, message.slice(0, i), i === message.length ? values : []));
    }
    return at;
  };

  it("is judged on the text just before the composer emptied, timed at the last keystroke", () => {
    void helper.handleReader(source(1000));
    void helper.handleReader(chat(2000, ""));
    const last = type(2000, "QX-77120");
    // Sent 300 ms after the last keystroke: the composer empties before the 1.5 s settle time.
    void helper.handleReader(chat(last + 300, ""));
    for (let t = last; t <= last + 5000; t += 250) helper.tick(t);
    expect(helper.recentTransfers.map((t) => [t.value, t.match, t.src.windowId, t.at, t.attribution])).toEqual([["QX-77120", "exact", SRC, last, "user"]]);
    expect(store.transfers()).toHaveLength(1);
  });

  it("finds a typed value inside the sent message although the clear removed it from the model", () => {
    void helper.handleReader(source(1000));
    void helper.handleReader(chat(2000, ""));
    const message = "please file QX-77120 today";
    const last = type(2000, message, [value("id", "QX-77120", COMPOSER)]);
    void helper.handleReader(chat(last + 200, ""));
    helper.tick(last + 5000);
    expect(helper.recentTransfers.map((t) => [t.value, t.kind])).toEqual([["QX-77120", "id"]]);
  });

  it("judges an edit once: a clear after the edit settled adds nothing", () => {
    void helper.handleReader(source(1000));
    void helper.handleReader(chat(2000, ""));
    const last = type(2000, "QX-77120");
    for (let t = last; t <= last + 2000; t += 250) helper.tick(t);
    void helper.handleReader(chat(last + 2500, ""));
    helper.tick(last + 6000);
    expect(helper.recentTransfers).toHaveLength(1);
  });

  it("starts a fresh edit after the clear, so the next message is judged on its own", () => {
    void helper.handleReader(source(1000));
    void helper.handleReader(chat(2000, ""));
    let last = type(2000, "QX-77120");
    void helper.handleReader(chat(last + 300, ""));
    last = type(last + 400, "QX-77120 again", [value("id", "QX-77120", COMPOSER)]);
    void helper.handleReader(chat(last + 300, ""));
    helper.tick(last + 5000);
    expect(helper.recentTransfers.map((t) => t.value)).toEqual(["QX-77120", "QX-77120"]);
  });
});
