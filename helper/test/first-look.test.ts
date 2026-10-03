// The first look, against the host's contract and over the real socket. The fixture is the host's
// own (fixtures/golden/first-look.ndjson, copied verbatim from v2/host); the helper must read every line
// and refuse every reply the host refuses. The socket tests play the host and the reader: a seeded desk
// yields an offer that offerAccept then runs, an empty desk yields nothing, and a reader that answers no
// walk yields an error, each inside the request's deadline. Jev is a fake that answers by rule.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { ConsumerMessage, FirstLookReply, HelperMessage, PROTOCOL_VERSION, type FirstLook } from "../src/protocol.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { jevPickingText } from "./builders.ts";
import { LineClient, SocketReader, loadRecording, until } from "./socket-reader.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/golden/first-look.ndjson", import.meta.url));
const lines = readFileSync(FIXTURE, "utf8").trim().split("\n");

describe("the host's first-look contract", () => {
  it("reads the request and every reply shape in the host's fixture", () => {
    expect(ConsumerMessage.parse(JSON.parse(lines[0] ?? ""))).toMatchObject({ type: "firstLook", families: ["fill", "pending", "loop", "routine"], level: "balanced", deadlineMs: 8000 });
    const replies = lines.slice(1).map((l) => HelperMessage.parse(JSON.parse(l)) as FirstLookReply);
    expect(replies.map((r) => r.outcome)).toEqual(["found", "found", "nothing", "error"]);
    // Every key is present on every line, null where it does not apply, as the helper sends them.
    for (const l of lines.slice(1)) expect(Object.keys(JSON.parse(l) as object).sort()).toEqual(["at", "error", "found", "outcome", "requestId", "scanned", "type", "v"]);
  });

  it("refuses every reply the host refuses", () => {
    const [found, , nothing, error] = lines.slice(1);
    const f = found ?? "";
    const n = nothing ?? "";
    const e = error ?? "";
    // The host's ten cases (FirstLookTests.testAReplyWhoseFieldsContradictItsOutcomeIsRefused), edit for edit.
    const bad: [string, string][] = [
      ["found with no offer", n.replace('"outcome":"nothing"', '"outcome":"found"')],
      ["nothing with an offer", f.replace('"outcome":"found"', '"outcome":"nothing"')],
      ["error with no reason", e.replace('"error":"reader not connected"', '"error":null')],
      ["error with an empty reason", e.replace('"error":"reader not connected"', '"error":""')],
      ["found and an error", f.replace('"error":null', '"error":"x"')],
      ["a missing nullable key", n.replace(',"error":null', "")],
      ["an unknown outcome", n.replace('"outcome":"nothing"', '"outcome":"maybe"')],
      ["another protocol version", n.replace('"v":1', '"v":2')],
      ["a spec without a header", f.replace('{"type":"header","title":{"text":"Fill 4 fields","ref":{"rule":"count","derived":[{"node":"5151-2/form"}]}}},', "")],
      ["a value with no ref", f.replace('"text":"Dana Reyes","ref":{"node":"6060-1/message/body","quote":"Dana Reyes"}', '"text":"Dana Reyes"')],
    ];
    for (const [name, line] of bad) {
      expect(line, `${name}: the edit must apply`).not.toBe(name.startsWith("found") || name.startsWith("a spec") || name.startsWith("a value") || name.startsWith("nothing with") ? f : name.startsWith("error") ? e : n);
      expect(HelperMessage.safeParse(JSON.parse(line)).success, name).toBe(false);
    }
    // And the ones the host's decoder checks but its fixture test does not exercise.
    const parsed = JSON.parse(f) as { found: Record<string, unknown> };
    expect(parsed.found.sourceApps).toEqual(["Mail"]);
    expect(HelperMessage.safeParse({ ...parsed, found: { ...parsed.found, family: "" } }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...parsed, found: { ...parsed.found, offerKey: "" } }).success).toBe(false);
    for (const apps of [[], ["Mail", "Mail"], [""]]) expect(HelperMessage.safeParse({ ...parsed, found: { ...parsed.found, sourceApps: apps } }).success, JSON.stringify(apps)).toBe(false);
    const { sourceApps: _, ...noApps } = parsed.found;
    expect(HelperMessage.safeParse({ ...parsed, found: noApps }).success).toBe(true);
  });
});

describe("the first look over the socket", () => {
  const F = (s: string): string => `dev.caret.fixture/standard/${s}`;
  const FORM = "5150-2";
  const ORDER = "6160-1";
  const JOB = "5150-3";
  const VALUES: Record<string, string> = { Name: "Dana Whitfield", Email: "dana.whitfield@example.com", Phone: "+1 (512) 555-0142" };
  const fill = jevPickingText((_, instructions) => VALUES[/Label: '([^']+)'/.exec(instructions)?.[1] ?? ""] ?? null);
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let host: LineClient;
  let reader: SocketReader | null;
  let ask: AskJev;
  let asked: number;

  const hooks = {
    applied: (windowId: string, at: number): boolean => helper.model.windows.get(windowId)?.updatedAt === at,
    tick: (at: number): void => helper.tick(at),
  };
  /** The windows of a recording, without its focus events: the windows already open when onboarding ends. */
  const seed = async (name: string): Promise<void> => {
    await (reader as SocketReader).replay(loadRecording(name).filter((m) => m.type === "snapshot"), hooks);
  };
  let n = 0;
  /** Sends a first look and waits for its reply; returns the reply and the real time it took. */
  const look = async (o: Partial<FirstLook> = {}): Promise<{ reply: FirstLookReply; ms: number }> => {
    const requestId = `first-look-${++n}`;
    const t0 = performance.now();
    host.send({ type: "firstLook", v: PROTOCOL_VERSION, requestId, at: 1, families: ["fill", "pending", "loop", "routine"], level: "balanced", deadlineMs: 8000, ...o });
    const raw = await host.waitFor((m) => m.type === "firstLookReply" && m.requestId === requestId, (o.deadlineMs ?? 8000) + 2000);
    return { reply: FirstLookReply.parse(raw), ms: performance.now() - t0 };
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-first-look-"));
    store = new Store(join(dir, "data"));
    asked = 0;
    ask = fill;
    helper = new Helper({
      store,
      askJev: (req) => (asked++, ask(req)),
      shadow: false,
      allowBackgroundFocus: false,
      publish: (m) => server.publish(m),
      sendToReader: (cmd) => server.sendToReader(cmd),
    });
    server = new HelperServer(join(dir, "screen.sock"), () => helper, () => {});
    await server.listen();
    host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "host-test" });
    reader = await SocketReader.connect(join(dir, "screen.sock"));
    await until(() => helper.hasReader);
  });

  afterEach(async () => {
    host.close();
    reader?.close();
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the grounded fill on a seeded desk, and offerAccept with its key fills the form", async () => {
    await seed("offers-fill.ndjson");
    const { reply, ms } = await look();
    expect(ms).toBeLessThan(8000);
    expect(reply).toMatchObject({
      outcome: "found",
      error: null,
      scanned: { windows: 2, apps: 2 },
      found: { kind: "fill", family: "fill", offerKey: "first-look-1.0", window: { pid: 5150, windowId: FORM, appName: "Caret Fixture", title: "Checkout" } },
    });
    expect(reply.found?.sourceApps).toEqual(["Mail Fixture"]);
    const spec = reply.found?.spec;
    expect(spec?.id).toBe("first-look-1.0");
    expect(spec?.blocks.map((b) => b.type)).toEqual(["header", "source", "fields", "actions"]);
    expect(spec?.blocks[0]).toMatchObject({ title: { text: "Fill 3 fields" } });
    // Every window was walked once before the generators ran; nothing was published to the host meanwhile.
    expect(reader?.verbs.filter((v) => v.kind === "walk").map((v) => ("windowId" in v ? v.windowId : "")).sort()).toEqual([FORM, ORDER].sort());
    expect(host.received.filter((m) => (m as { type: string }).type === "popup")).toEqual([]);

    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: "first-look-1.0", actionId: "fillAll", overrides: {}, at: 2 });
    await host.waitFor((m) => m.type === "taskProgress" && m.taskId === "first-look-1.0" && m.phase === "done");
    expect([F("textfield:name~0"), F("textfield:email~0"), F("textfield:phone~0")].map((k) => reader?.value(FORM, k))).toEqual(["Dana Whitfield", "dana.whitfield@example.com", "+1 (512) 555-0142"]);
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === "first-look-1.0")).toMatchObject({ reason: "taken" });
  });

  it("reports a watched job that finished, with Open, when only pending is asked for", async () => {
    ask = async (req) =>
      req.questions.finished !== undefined
        ? { model: "jev-test", answers: { finished: { choice: /passed/i.test(String((req.state as Record<string, unknown>).lines_that_changed)) ? "yes" : "no", confidence: 0.9 }, waiting: { choice: "no", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 }
        : fill(req);
    await (reader as SocketReader).replay(loadRecording("offers-pending.ndjson"), hooks);
    await helper.pending.whenIdle();
    const { reply } = await look({ families: ["pending"] });
    expect(reply).toMatchObject({ outcome: "found", found: { kind: "report", family: "pending", window: { windowId: JOB, title: "Test run" } } });
    expect(reply.found?.spec.blocks[0]).toMatchObject({ type: "header", title: { text: "'Test run' finished" } });
    expect(reply.found?.spec.blocks.at(-1)).toEqual({ type: "actions", items: [{ id: "open", label: "Open Caret Fixture", key: "tab" }] });
  });

  it("asks once about a window that shows running work, and reports it when it waits on the user", async () => {
    ask = async (req) => {
      const state = req.state as Record<string, unknown>;
      expect(Object.keys(state).sort()).toEqual(["last_lines", "signs_of_running_work", "situation", "window"]);
      return { model: "jev-test", answers: { finished: { choice: "no", confidence: 0.9 }, waiting: { choice: "yes", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    await (reader as SocketReader).replay(loadRecording("offers-pending.ndjson").slice(0, 1), hooks);
    const { reply } = await look({ families: ["pending"] });
    expect(asked).toBe(1);
    expect(reply).toMatchObject({ outcome: "found", found: { kind: "report", family: "pending", window: { windowId: JOB } } });
    expect(reply.found?.spec.blocks.slice(0, 2)).toEqual([
      { type: "header", title: { text: "'Test run' needs you", ref: { rule: "pendingWaiting", derived: [{ node: `${JOB}/${F("statictext:running tests… # of #~0")}`, quote: "Running tests… 12 of 48" }] } } },
      { type: "facts", rows: [{ value: { text: "Running tests… 12 of 48", ref: { node: `${JOB}/${F("statictext:running tests… # of #~0")}`, quote: "Running tests… 12 of 48" } } }] },
    ]);
  });

  it("reports an open loop offer, and offerAccept with the first look's key runs it under that key", async () => {
    await (reader as SocketReader).replay(loadRecording("offers-loop.ndjson"), hooks);
    await host.waitFor((m) => m.type === "alternatives");
    const { reply } = await look({ families: ["loop"] });
    expect(reply).toMatchObject({ outcome: "found", found: { kind: "fill", family: "loop" } });
    const actions = reply.found?.spec.blocks.find((b) => b.type === "actions");
    expect(actions).toEqual({ type: "actions", items: [{ id: "fill", label: "Fill", key: "tab" }] });
    const key = reply.found?.offerKey ?? "";
    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: key, actionId: "fill", overrides: {}, at: 2 });
    await host.waitFor((m) => m.type === "taskProgress" && m.taskId === key && m.phase === "done");
  });

  it("ends a loop's first-look key when the loop offer it reports expires", async () => {
    await (reader as SocketReader).replay(loadRecording("offers-loop.ndjson"), hooks);
    await host.waitFor((m) => m.type === "alternatives");
    const key = (await look({ families: ["loop"] })).reply.found?.offerKey ?? "";
    helper.tick((reader as SocketReader).clock + 3 * 60 * 1000);
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === key)).toMatchObject({ reason: "expired" });
  });

  it("withdraws a found offer when Caret is paused, answers no look while paused, and lets an offer nobody took expire after five minutes", async () => {
    await seed("offers-fill.ndjson");
    const first = (await look()).reply.found?.offerKey ?? "";
    host.send({ type: "settings", v: PROTOCOL_VERSION, at: 3, roles: ["fill", "repeat", "watch", "words"], level: "balanced", paused: true });
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === first)).toMatchObject({ reason: "settings" });
    expect((await look()).reply).toMatchObject({ outcome: "error", error: "Caret is paused" });
    host.send({ type: "settings", v: PROTOCOL_VERSION, at: 4, roles: ["fill", "repeat", "watch", "words"], level: "balanced", paused: false });
    const second = (await look()).reply.found?.offerKey ?? "";
    helper.tick(Date.now() + 5 * 60 * 1000 + 1);
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === second)).toMatchObject({ reason: "expired" });
    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: second, actionId: "fillAll", overrides: {}, at: 4 });
    await host.waitFor((m) => m.type === "error" && String(m.message).includes(second));
  });

  it("records nothing when Caret is paused while Jev answers", async () => {
    await seed("offers-fill.ndjson");
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    ask = async (req) => {
      await gate;
      return fill(req);
    };
    const pending = look();
    await until(() => asked === 2);
    host.send({ type: "settings", v: PROTOCOL_VERSION, at: 3, roles: ["fill", "repeat", "watch", "words"], level: "balanced", paused: true });
    await until(() => helper.gate.settings.paused);
    release();
    const { reply } = await pending;
    expect(reply).toMatchObject({ outcome: "error", error: "Caret is paused", found: null });
    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: reply.requestId + ".0", actionId: "fillAll", overrides: {}, at: 4 });
    await host.waitFor((m) => m.type === "error" && String(m.message).includes(`${reply.requestId}.0`));
  });

  it("leaves out windows the reader could not walk: no fill from a form it no longer has", async () => {
    await seed("offers-fill.ndjson");
    (reader as SocketReader).windows.clear();
    const { reply } = await look();
    expect(reply).toMatchObject({ outcome: "nothing", error: null });
    expect(asked).toBe(0);
  });

  it("drops a pending answer about a window that closed while Jev answered", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    ask = async () => {
      await gate;
      return { model: "jev-test", answers: { finished: { choice: "yes", confidence: 0.9 }, waiting: { choice: "no", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    await (reader as SocketReader).replay(loadRecording("offers-pending.ndjson").slice(0, 1), hooks);
    const pending = look({ families: ["pending"] });
    await until(() => asked === 1);
    (reader as SocketReader).send({ type: "windowClosed", v: PROTOCOL_VERSION, at: 5000, windowId: JOB });
    await until(() => !helper.model.windows.has(JOB));
    release();
    expect((await pending).reply).toMatchObject({ outcome: "nothing", found: null });
  });

  it("answers an error, and records nothing, when work that holds the event loop runs past the deadline", async () => {
    await seed("offers-fill.ndjson");
    // Jev answers only after blocking the event loop for 60 ms, so no timer can fire first: the result is
    // ready, but the deadline has passed.
    ask = async (req) => {
      const end = performance.now() + 60;
      while (performance.now() < end) {
        // busy: holds the loop as a long synchronous generator would
      }
      return fill(req);
    };
    const { reply, ms } = await look({ deadlineMs: 40 });
    expect(ms).toBeGreaterThan(40);
    expect(reply).toMatchObject({ outcome: "error", error: "the look did not finish before the deadline", found: null });
    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: `${reply.requestId}.0`, actionId: "fillAll", overrides: {}, at: 4 });
    await host.waitFor((m) => m.type === "error" && String(m.message).includes(`${reply.requestId}.0`));
  });

  it("answers nothing for an empty desk, and asks Jev nothing", async () => {
    const { reply, ms } = await look();
    expect(ms).toBeLessThan(8000);
    expect(reply).toMatchObject({ outcome: "nothing", found: null, error: null, scanned: { windows: 0, apps: 0 } });
    expect(asked).toBe(0);
  });

  it("answers an error naming the windows when the reader answers no walk, inside the deadline", async () => {
    await seed("offers-fill.ndjson");
    (reader as SocketReader).delayMs.walk = 60_000;
    const { reply, ms } = await look({ deadlineMs: 2000 });
    expect(ms).toBeLessThan(2000);
    expect(reply.outcome).toBe("error");
    expect(reply.error).toBe(`reader walks failed: ${ORDER} timeout, ${FORM} timeout`);
    expect(asked).toBe(0);
  });

  it("answers an error when no reader is connected", async () => {
    reader?.close();
    reader = null;
    await until(() => !helper.hasReader);
    const { reply } = await look();
    expect(reply).toMatchObject({ outcome: "error", error: "reader not connected", scanned: null, found: null });
  });

  it("answers inside the deadline when Jev does not, naming the family and no screen text", async () => {
    await seed("offers-fill.ndjson");
    ask = () => new Promise(() => {});
    const { reply, ms } = await look({ deadlineMs: 1500 });
    expect(ms).toBeLessThan(1500);
    expect(reply).toMatchObject({ outcome: "error", error: "fill: did not finish before the deadline" });
  });

  it("refuses an unknown family by name, and runs no generator a Quiet level holds", async () => {
    expect((await look({ families: ["fill", "ghost"] })).reply).toMatchObject({ outcome: "error", error: "unknown families: ghost", scanned: null });
    await seed("offers-fill.ndjson");
    // Quiet holds loops and routines; fill still runs.
    expect((await look({ families: ["loop", "routine"], level: "quiet" })).reply.outcome).toBe("nothing");
    expect(asked).toBe(0);
  });
});
