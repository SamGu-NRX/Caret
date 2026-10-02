import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { ReaderMessage } from "../src/protocol.ts";
import { Store } from "../src/store.ts";

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
    for (const f of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, f)).toString("latin1");
      for (const secret of ["dana.whitfield", "555-0142", "ORD-2026", "Order confirmation", "Call me after lunch"]) {
        expect(bytes.includes(secret), `${f} contains ${secret}`).toBe(false);
      }
    }
    store = new Store(dir);
  });
});
