import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { SAYS } from "../src/planner/says.ts";
import { PROTOCOL_VERSION, type HelperMessage } from "../src/protocol.ts";
import { field, focus, jevPickingText, MAIL_APP, snap, text } from "./builders.ts";

const FORM = "5150-1";
const EMAIL = "dev.caret.fixture/standard/textfield:email~0";
const VALUE = "dana.whitfield@example.com";

// Both fill rounds pause on one latch, so a request meets real work, not a timer approximation of it.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("explicit fills meeting work in flight", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let sent: HelperMessage[];
  let latch: ReturnType<typeof deferred>;
  let calls: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-fill-inflight-"));
    store = new Store(dir);
    sent = [];
    latch = deferred();
    calls = 0;
    const pick = jevPickingText(() => VALUE);
    helper = new Helper({ store, shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), askJev: async (req) => {
      calls++;
      await latch.promise;
      return pick(req);
    } });
    await helper.handleReader(snap([text("mail/sig", VALUE)], { at: Date.now() - 1000, windowId: "6160-1", app: MAIL_APP }));
    await helper.handleReader(snap([field(EMAIL, "", { label: "Email" })], { at: Date.now(), windowId: FORM, focused: true }));
  });

  afterEach(() => {
    latch.resolve();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const request = (key = EMAIL) => helper.handleConsumer({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: FORM, fieldKey: key });
  const ambient = (key = EMAIL) => helper.handleReader(focus(FORM, key, Date.now()));

  it("joins the same scope, returns the result, and keeps it for Fill all", async () => {
    const loading = ambient();
    await setImmediate();
    expect(calls).toBe(2);
    const explicit = request();
    latch.resolve();
    const [loaded, joined] = await Promise.all([loading, explicit]);
    expect(joined).not.toBeNull();
    expect(joined).toEqual(loaded);
    expect(joined?.fields[0]?.value).toBe(VALUE);
    // Two value rounds plus two owner rounds, once for the shared fill.
    expect(calls).toBe(4);
    expect(sent.filter((m) => m.type === "fillProposal")).toEqual([joined]);
    if (joined !== null) {
      await helper.handleFillAll({ type: "fillAll", v: PROTOCOL_VERSION, proposalId: joined.id, at: Date.now() });
      expect(sent.some((m) => m.type === "error" && m.message.includes("no such fill proposal"))).toBe(false);
    }
  });

  it("waits for a different scope in the same window, then runs that scope", async () => {
    const keys = Array.from({ length: 21 }, (_, i) => `dev.caret.fixture/standard/textfield:email~${i}`);
    await helper.handleReader(snap(keys.map((key, i) => field(key, "", { label: "Email", frame: [0, i * 40, 200, 24] })), { at: Date.now(), windowId: FORM, focused: true }));
    const loading = ambient(keys[0]);
    await setImmediate();
    let settled = false;
    const explicit = request(keys[20]).then((p) => { settled = true; return p; });
    await setImmediate();
    const beforeRelease = { settled, calls };
    latch.resolve();
    const [loaded, waited] = await Promise.all([loading, explicit]);
    expect(beforeRelease).toEqual({ settled: false, calls: 2 });
    expect(loaded?.fields.map((f) => f.key)).not.toContain(keys[20]);
    expect(waited?.fields.map((f) => f.key)).toContain(keys[20]);
    expect(waited?.fields.map((f) => f.key)).not.toContain(keys[0]);
    expect(calls).toBe(8);
  });

  it("says the form changed instead of silently returning null to a joined request", async () => {
    const loading = ambient();
    await setImmediate();
    const explicit = request();
    await helper.handleReader(snap([field(EMAIL, "already typed", { label: "Email" })], { at: Date.now(), windowId: FORM, focused: true }));
    latch.resolve();
    await loading;
    expect(await explicit).toBeNull();
    expect(sent.filter((m) => m.type === "error")).toEqual([
      { type: "error", v: PROTOCOL_VERSION, at: expect.any(Number), message: SAYS.windowChanged },
    ]);
  });

  it.each(["disabled", "shadow"])("returns a typed failure sentence when fill is %s", async (why) => {
    if (why === "disabled") {
      helper.memory.close();
      helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m) });
    } else helper.mode = "shadow";
    expect(await request()).toBeNull();
    expect(sent.filter((m) => m.type === "error").map((m) => m.message)).toEqual([SAYS.fillFailed]);
  });
});
