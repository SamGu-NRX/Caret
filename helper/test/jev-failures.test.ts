// Lead addendum (2026-10-06): when Jev fails, the user reads how, and what to do. Before it, every failure read
// "Caret couldn't reach its model just now. Try again.", which for a 402 (no credits) was wrong twice: Caret reached
// Jev, and trying again does not add credits. The client throws a typed failure; Ask, fill and a page goal say it.
import { answeringScope } from "./builders.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JevHttpError, JevNetworkError, jevFailureKind, makeJevClient, type AskJev, type JevFailureKind } from "../src/fill/jev.ts";
import { Helper } from "../src/helper.ts";
import { ScreenModel } from "../src/model.ts";
import { AskRefused, planAsk } from "../src/planner/ask.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import { jevFailedError, jevFailureSays, SAYS } from "../src/planner/says.ts";
import { PROTOCOL_VERSION, type HelperMessage } from "../src/protocol.ts";
import { Store } from "../src/store.ts";
import { field, snap } from "./builders.ts";
import { closeRigs, rig } from "./page-rig.ts";

const REQ = { state: "s", questions: { q: { type: "choice" as const, instructions: "i", criteria: { a: null, b: null } } }, snippets: [], charged: {} };

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "retry-after": "0" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Jev client's typed failures", () => {
  it.each<[number, JevFailureKind]>([
    [402, "billing"],
    [401, "auth"],
    [403, "auth"],
    [500, "service"],
    [503, "service"],
  ])("HTTP %i is a %s failure, and the key never appears in it", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(status, { error_type: "billing_error", message: "echo sk-test-secret" })));
    const e = await makeJevClient(() => "sk-test-secret")(REQ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(JevHttpError);
    expect((e as JevHttpError).status).toBe(status);
    expect(jevFailureKind(e)).toBe(kind);
    expect((e as Error).message).toContain(`Jev HTTP ${status}`);
    expect((e as Error).message).not.toContain("sk-test-secret");
  });

  it("is a rate failure only after the one retry", async () => {
    const fetch = vi.fn(async () => respond(429, { error_type: "rate_limit" }));
    vi.stubGlobal("fetch", fetch);
    const e = await makeJevClient(() => "k")(REQ).catch((x: unknown) => x);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(jevFailureKind(e)).toBe("rate");
  });

  it("is a rate failure at the first 429 for a caller that allows no retry", async () => {
    const fetch = vi.fn(async () => respond(429, {}));
    vi.stubGlobal("fetch", fetch);
    const e = await makeJevClient(() => "k")({ ...REQ, retry429: false }).catch((x: unknown) => x);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jevFailureKind(e)).toBe("rate");
  });

  it("is a network failure when no HTTP answer came, or none in time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const down = await makeJevClient(() => "k")(REQ).catch((x: unknown) => x);
    expect(down).toBeInstanceOf(JevNetworkError);
    expect(jevFailureKind(down)).toBe("network");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }));
    const slow = await makeJevClient(() => "k", 50)(REQ).catch((x: unknown) => x);
    expect(jevFailureKind(slow)).toBe("network");
    expect((slow as Error).message).toContain("within 50 ms");
  });

  it("keeps the status when the error body cannot be read, and says a broken answer is a network failure (P3 review)", async () => {
    const broken = (status: number): Response => new Response(new ReadableStream({ start: (c) => c.error(new TypeError("terminated")) }), { status });
    vi.stubGlobal("fetch", vi.fn(async () => broken(402)));
    const billing = await makeJevClient(() => "k")(REQ).catch((x: unknown) => x);
    expect(jevFailureKind(billing)).toBe("billing");
    vi.stubGlobal("fetch", vi.fn(async () => broken(200)));
    const cut = await makeJevClient(() => "k")(REQ).catch((x: unknown) => x);
    expect(jevFailureKind(cut)).toBe("network");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 200 })));
    const html = await makeJevClient(() => "k")(REQ).catch((x: unknown) => x);
    expect(jevFailureKind(html)).toBe("service");
  });

  it("finds the kind through a wrapper's cause, and none in an error that is not the client's", () => {
    expect(jevFailureKind(new Error("wrapped", { cause: new JevHttpError(402, "x") }))).toBe("billing");
    expect(jevFailureKind(new Error("Jev HTTP 402: looks like one but is not"))).toBeNull();
    expect(jevFailureKind("402")).toBeNull();
  });
});

describe("what each Jev failure says", () => {
  it.each<[unknown, string]>([
    [new JevHttpError(402, "no credits"), SAYS.jevBilling],
    [new JevHttpError(401, "bad key"), SAYS.jevAuth],
    [new JevHttpError(403, "revoked"), SAYS.jevAuth],
    [new JevHttpError(429, "slow down"), SAYS.jevRate],
    [new JevNetworkError("down", null), SAYS.jevNetwork],
    [new JevHttpError(500, "oops"), SAYS.jevService],
    [new Error("something else"), SAYS.unreachable],
  ])("%s", (e, says) => {
    expect(jevFailureSays(e, SAYS.unreachable)).toBe(says);
    expect(says).toMatch(/^[A-Z].*\.$/u);
    const err = jevFailedError(e);
    expect(err.code).toBe("jevFailed");
    expect(err.message).toBe(says);
    expect(err.detail).toContain("the Jev request failed");
  });

  it("never tells the user to just try again when the account has no credits", () => {
    expect(SAYS.jevBilling).toContain("out of credits");
    expect(SAYS.jevBilling).not.toMatch(/couldn't reach/u);
  });
});

const FORM = "5150-77";
const NAME = "dev.caret.fixture/standard/textfield:full name~0";
const EMAIL = "dev.caret.fixture/standard/textfield:email~0";
const NOTE_APP = { pid: 6262, bundleId: "com.apple.TextEdit", name: "TextEdit" };

function failing(e: unknown): AskJev {
  return async () => {
    throw e;
  };
}

describe("an Ask whose Jev request fails says how (lead addendum)", () => {
  it.each<[unknown, string]>([
    [new JevHttpError(402, '{"error_type":"billing_error"}'), SAYS.jevBilling],
    [new JevHttpError(401, "unauthorized"), SAYS.jevAuth],
    [new JevHttpError(429, "rate"), SAYS.jevRate],
    [new JevNetworkError("Jev could not be reached: fetch failed", new TypeError("fetch failed")), SAYS.jevNetwork],
  ])("from the intent maker: %s", async (err, says) => {
    const m = new ScreenModel();
    m.apply(snap([field(NAME, "", { label: "Full name" }), field(EMAIL, "", { label: "Email" })], { at: 1000, windowId: FORM, title: "Apply", focused: true, focusedKey: NAME }));
    const ask = failing(err);
    const e = await planAsk("fill this out", m, { values: () => [] }, [], { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "j1", windowId: FORM, now: 2000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskRefused);
    expect((e as AskRefused).code).toBe("jevFailed");
    expect((e as AskRefused).message).toBe(says);
    expect((e as AskRefused).detail).toContain("Jev");
  });
});

describe("a fill whose Jev request fails says how (lead addendum)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it.each<[unknown, string, JevFailureKind]>([
    [new JevHttpError(402, '{"error_type":"billing_error"}'), SAYS.jevBilling, "billing"],
    [new JevHttpError(403, "forbidden"), SAYS.jevAuth, "auth"],
    [new JevHttpError(429, "rate"), SAYS.jevRate, "rate"],
    [new JevNetworkError("down", null), SAYS.jevNetwork, "network"],
  ])("%s", async (err, says, kind) => {
    dir = mkdtempSync(join(tmpdir(), "caret-jev-fail-"));
    const store = new Store(dir);
    const sent: HelperMessage[] = [];
    const helper = new Helper({ store, askJev: failing(err), shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), warn: () => {} });
    const now = Date.now();
    await helper.handleReader(snap([field("te/note", "Robin Vale\nrobin@example.test", { role: "AXTextArea" })], { at: now - 5000, windowId: "note", title: "Robin's details.txt", app: NOTE_APP, focused: true }));
    await helper.handleReader(snap([field(NAME, "", { label: "Full name", frame: [100, 40, 200, 24] }), field(EMAIL, "", { label: "Email", frame: [100, 80, 200, 24] })], { at: now, windowId: FORM, title: "Claim form", focused: true, focusedKey: NAME }));
    await helper.handleConsumer({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: FORM, fieldKey: NAME });
    const errors = sent.flatMap((m) => (m.type === "error" ? [m.message] : []));
    expect(errors).toEqual([says]);
    store.flush();
    // One count per failed request: fill asks twice at once.
    expect(store.counts()[`jev.failed_${kind}`]).toBeGreaterThanOrEqual(1);
    helper.memory.close();
    store.close();
  });
});

describe("a page goal whose fill round fails says how (lead addendum)", () => {
  afterEach(closeRigs);

  it.each<[unknown, string]>([
    [new JevHttpError(402, '{"error_type":"billing_error"}'), SAYS.jevBilling],
    [new JevNetworkError("down", null), SAYS.jevNetwork],
  ])("%s", async (err, says) => {
    // I2: the Ask's per-field scope question (asked first on every route) answers; the fill round's requests fail.
    const r = await rig({ jev: () => answeringScope(failing(err)) });
    const m = await r.ask("fill out this form from my note");
    expect(m).toMatchObject({ event: "stopped", reason: "refused", says });
  });
});
