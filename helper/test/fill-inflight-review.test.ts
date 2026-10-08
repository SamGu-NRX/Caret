import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { SAYS } from "../src/planner/says.ts";
import { formFields, formInputs, selectedFormInputs } from "../src/fill/fill.ts";
import { PROTOCOL_VERSION, type HelperMessage } from "../src/protocol.ts";
import { field, focus, jevPickingText, MAIL_APP, node, snap, text } from "./builders.ts";
import { SocketReader } from "./socket-reader.ts";

const FORM = "5150-1";
const EMAIL = "dev.caret.fixture/standard/textfield:email~0";
const OTHER = "dev.caret.fixture/standard/textfield:email~1";
const VALUE = "dana.whitfield@example.com";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const emails = (count: number) => Array.from({ length: count }, (_, i) => field(`dev.caret.fixture/standard/textfield:email~${i}`, "", { label: "Email", frame: [0, i * 40, 200, 24] }));

describe("in-flight fill review regressions", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let sent: HelperMessage[];
  let latch: ReturnType<typeof deferred>;
  let calls: number;
  let document: string;
  const request = (key = EMAIL) => helper.handleConsumer({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: FORM, fieldKey: key });
  const ambient = (key = EMAIL) => helper.handleReader(focus(FORM, key, Date.now()));
  const show = (nodes = emails(2)) => helper.handleReader(snap(nodes, { at: Date.now(), windowId: FORM, focused: true }));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-fill-review-"));
    store = new Store(dir);
    sent = [];
    latch = deferred();
    calls = 0;
    document = "frame0:D1:1";
    const pick = jevPickingText(() => VALUE);
    helper = new Helper({ store, shadow: false, allowBackgroundFocus: false, pageDocument: () => document, publish: (m) => sent.push(m), askJev: async (req) => {
      calls++;
      await latch.promise;
      return pick(req);
    } });
    await helper.handleReader(snap([text("mail/sig", VALUE)], { at: Date.now() - 1000, windowId: "6160-1", app: MAIL_APP }));
    await show();
  });
  afterEach(() => {
    latch.resolve();
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("P1: does not join a previous document that reused the field keys", async () => {
    const loading = ambient();
    await setImmediate();
    document = "frame0:D2:2";
    await show();
    const explicit = request();
    latch.resolve();
    const [old, current] = await Promise.all([loading, explicit]);
    expect(old).toBeNull();
    expect(current?.fields.map((f) => f.value)).toEqual([VALUE, VALUE]);
    expect(calls).toBe(8);
    expect(sent.filter((m) => m.type === "fillProposal")).toEqual([current]);
  });

  it.each(["navigation", "reader restart", "trigger descriptor"])("P1: a different-scope waiter refuses %s instead of retargeting", async (change) => {
    const fields = emails(21);
    await show(fields);
    const loading = ambient();
    await setImmediate();
    const explicit = request(fields[20]!.key);
    if (change === "navigation") document = "frame0:D2:2";
    if (change === "reader restart") {
      await helper.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 1, version: "fill-review", session: "reader-2" });
      await helper.handleReader(snap([text("mail/sig", VALUE)], { at: Date.now() - 1000, windowId: "6160-1", app: MAIL_APP }));
    }
    if (change === "trigger descriptor") fields[20] = { ...fields[20]!, label: "Alternate email" };
    await show(fields);
    latch.resolve();
    await loading;
    expect(await explicit).toBeNull();
    expect(calls).toBe(4);
    expect(sent.filter((m) => m.type === "error").map((m) => m.message)).toContain(SAYS.windowChanged);
    expect(sent.filter((m) => m.type === "fillProposal")).toEqual([]);
  });

  it("P2 fix-check: a different-trigger request keeps its descriptor identity while waiting", async () => {
    const fields = emails(3);
    await show(fields);
    const loading = ambient();
    await setImmediate();
    expect(calls).toBe(2);
    const explicit = request(OTHER);
    // Let the request reach the in-flight join or wait before changing only its trigger.
    await setImmediate();
    // SAFETY: emails(3) includes index 1, but Node[] does not carry that length.
    fields[1] = { ...fields[1]!, label: "Alternate email" };
    await show(fields);
    latch.resolve();
    const [first, result] = await Promise.all([loading, explicit]);
    // SAFETY: emails(3) also includes the unchanged input at index 2.
    expect(first?.fields.map((f) => f.key)).toEqual([EMAIL, fields[2]!.key]);
    expect(result).toBeNull();
    expect(calls).toBe(4);
    expect(sent.filter((m) => m.type === "error")).toEqual([
      { type: "error", v: PROTOCOL_VERSION, at: expect.any(Number), message: SAYS.windowChanged },
    ]);
    expect(sent.filter((m) => m.type === "fillProposal")).toEqual([]);
  });

  it("P2 fix-check: a same-trigger request queues when input order changes privacy admission", async () => {
    // Distinct letters: repeated text counts once (OUTPUT-LEDGER-SPEC section 5), so 51 x's would be 12 characters.
    let x = 3;
    const letters = (n: number): string => Array.from({ length: n }, () => String.fromCharCode(97 + ((x = (x * 1103515245 + 12345) % 2147483648) % 26))).join("");
    const fields = emails(20).map((n, i) => ({ ...n, label: `Email ${String(i).padStart(2, "0")} ${letters(51)}` }));
    const keys = fields.map((n) => n.key);
    expect(fields.every((n) => n.label.length === 60)).toBe(true);
    await show(fields);
    expect(selectedFormInputs(helper.model, FORM, EMAIL).map((x) => x.node.key)).toEqual(keys);
    const loading = ambient();
    await setImmediate();
    expect(calls).toBe(2);
    // The trigger and all descriptors stay the same. Moving the last field changes only input priority,
    // so a same-trigger guard cannot mask a scope comparison that still sorts its tuples.
    // SAFETY: emails(20) constructs the twentieth input at index 19.
    fields[19] = { ...fields[19]!, frame: [0, 20, 200, 24] };
    await show(fields);
    const reordered = [keys[0], keys[19], ...keys.slice(1, 19)];
    expect(selectedFormInputs(helper.model, FORM, EMAIL).map((x) => x.node.key)).toEqual(reordered);
    let settled = false;
    const explicit = request().then((p) => { settled = true; return p; });
    await setImmediate();
    const beforeRelease = { settled, calls };
    latch.resolve();
    const [first, result] = await Promise.all([loading, explicit]);
    expect(beforeRelease).toEqual({ settled: false, calls: 2 });
    // The title takes six of 1,200 characters; only 19 distinct 60-character labels are admitted.
    expect(first?.fields.map((f) => f.key)).toEqual(keys.slice(0, 19));
    expect(result?.fields.map((f) => f.key)).toEqual(reordered.slice(0, 19));
    expect(result?.fields.map((f) => f.key)).toContain(keys[19]);
    expect(result?.fields.map((f) => f.key)).not.toContain(keys[18]);
    expect(calls).toBe(8);
    expect(sent.filter((m) => m.type === "error")).toEqual([]);
    expect(sent.filter((m) => m.type === "fillProposal")).toEqual([result]);
  });

  it("P2: queues unequal ranked control scopes even when the capped text keys match", async () => {
    const dates = Array.from({ length: 19 }, (_, i) => node(`date-${i}`, "AXDateField", { label: "Start date", editable: true, frame: [0, i * 30, 200, 24] }));
    await helper.handleReader(snap([text("mail/sig", `${VALUE}\nStart date: October 20, 2026`)], { at: Date.now() - 1000, windowId: "6160-1", app: MAIL_APP }));
    await show([...emails(2), ...dates]);
    const w = helper.model.windows.get(FORM)!;
    expect(formFields(w, EMAIL).map((n) => n.key).sort()).toEqual(formFields(w, OTHER).map((n) => n.key).sort());
    expect(formInputs(w, EMAIL, 20, true, () => new Set(["start", "date"])).map((x) => x.node.key)).not.toContain(OTHER);
    const loading = ambient();
    await setImmediate();
    const explicit = request(OTHER);
    latch.resolve();
    const [first, second] = await Promise.all([loading, explicit]);
    expect(first?.fields.map((f) => f.key)).not.toContain(OTHER);
    expect(second?.fields.map((f) => f.key)).toContain(OTHER);
    expect(second?.fields.map((f) => f.key)).not.toContain(EMAIL);
    expect(calls).toBe(8);
  });

  it("P2: a queued explicit proposal withdraws the overlapping ambient pop-up", async () => {
    const fields = emails(21);
    await show(fields);
    const loading = ambient();
    await setImmediate();
    const explicit = request(fields[20]!.key);
    latch.resolve();
    const [first, second] = await Promise.all([loading, explicit]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(sent.some((m) => m.type === "popup" && m.offerKey === first?.id)).toBe(true);
    expect(sent.some((m) => m.type === "offerWithdrawn" && m.id === first?.id)).toBe(true);
    expect(helper.offers.keys()).not.toContain(first?.id);
    expect(sent.findIndex((m) => m.type === "offerWithdrawn" && m.id === first?.id)).toBeLessThan(sent.findIndex((m) => m.type === "fillProposal" && m.id === second?.id));
  });

  it("P2: records same-callback focus changes before the fill microtask", async () => {
    const OUT = "outside-field";
    await helper.handleReader(snap([field(OUT, "", { label: "Search" })], { at: Date.now(), windowId: "5150-2" }));
    // The socket dispatches both focus messages without awaiting either returned promise.
    const loading = ambient();
    const moved = helper.handleReader(focus("5150-2", OUT, Date.now()));
    await setImmediate();
    latch.resolve();
    const [first] = await Promise.all([loading, moved]);
    expect(first).not.toBeNull();
    expect(sent.some((m) => m.type === "popup" && m.offerKey === first?.id)).toBe(false);
    expect(helper.offers.keys()).not.toContain(first?.id);
  });
});

describe("a joined ambient pop-up through the fake reader", () => {
  it("P3: joins two grounded fields, keeps one proposal with no pop-up, and Fill all writes both", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-fill-join-reader-"));
    const store = new Store(dir);
    const latch = deferred();
    const sent: HelperMessage[] = [];
    let helper!: Helper;
    const server = new HelperServer(join(dir, "screen.sock"), () => helper, () => {});
    const pick = jevPickingText(() => VALUE);
    helper = new Helper({ store, shadow: false, allowBackgroundFocus: false, publish: (m) => { sent.push(m); server.publish(m); }, sendToReader: (m) => server.sendToReader(m), askJev: async (req) => { await latch.promise; return pick(req); } });
    let reader: SocketReader | null = null;
    try {
      await server.listen();
      reader = await SocketReader.connect(join(dir, "screen.sock"));
      reader.enforceGrants = true;
      await reader.replay([
        snap([text("mail/sig", VALUE)], { at: Date.now() - 1000, windowId: "6160-1", app: MAIL_APP }),
        snap(emails(2), { at: Date.now(), windowId: FORM, focused: true }),
      ], { applied: (id, at) => helper.model.windows.get(id)?.updatedAt === at, tick: (at) => helper.tick(at) });
      const loading = helper.handleReader(focus(FORM, EMAIL, Date.now()));
      await setImmediate();
      const explicit = helper.handleConsumer({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: FORM, fieldKey: EMAIL });
      latch.resolve();
      const [ambient, joined] = await Promise.all([loading, explicit]);
      expect(joined).not.toBeNull();
      expect(joined).toEqual(ambient);
      expect(joined?.fields.map((f) => f.value)).toEqual([VALUE, VALUE]);
      expect(sent.filter((m) => m.type === "fillProposal")).toEqual([joined]);
      expect(sent.filter((m) => m.type === "popup")).toEqual([]);
      expect(helper.offers.size).toBe(0);
      if (joined === null) throw new Error("the explicit request was dropped");
      const result = await helper.handleFillAll({ type: "fillAll", v: PROTOCOL_VERSION, proposalId: joined.id, at: Date.now() });
      expect(result?.outcome).toBe("done");
      expect(reader.verbs.filter((v) => v.kind === "write").map((v) => ({ key: v.key, value: v.value }))).toEqual([
        { key: EMAIL, value: VALUE }, { key: OTHER, value: VALUE },
      ]);
      expect([reader.value(FORM, EMAIL), reader.value(FORM, OTHER)]).toEqual([VALUE, VALUE]);
    } finally {
      latch.resolve();
      reader?.close();
      helper.shutdown();
      await server.close();
      helper.memory.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
