// The routing messages on the wire (D2-02): routingContext from the host, routeDecision from the helper. The golden
// lines are the contract the host copies; the helper must produce messages of exactly that shape, and the server gives
// them only to a host whose hello says it takes route decisions. Everything is invented.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import { AnyMessage, ConsumerMessage, HelperMessage, PROTOCOL_VERSION, ROUTING_CAPABILITY, type AppRef, type HelperMessage as HM, type Node, type RouteDecision } from "../src/protocol.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { snap } from "./builders.ts";
import { LineClient } from "./socket-reader.ts";

const lines = readFileSync(new URL("../fixtures/golden/routing.ndjson", import.meta.url), "utf8").trim().split("\n");

describe("the routing protocol lines", () => {
  it("parses every golden line and writes it back byte for byte", () => {
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual([
      "hello", "routingContext", "routeDecision", "routingContext", "routeDecision", "routeDecision", "routingContext", "routeDecision", "routingContext", "routeDecision", "routeDecision",
      // R2: a failed decision, a write session that a sentence end keeps (decided at once), and a stale context.
      "routingContext", "routeDecision", "routingContext", "routeDecision", "routingContext", "routeDecision", "routingContext", "routeDecision", "routeDecision",
    ]);
    for (const l of lines) {
      const m = JSON.parse(l) as { type: string };
      const schema = m.type === "hello" || m.type === "routingContext" ? ConsumerMessage : HelperMessage;
      expect(JSON.stringify(schema.parse(m)), m.type).toBe(l);
    }
  });

  it("refuses the shapes the contract rules out", () => {
    const at = (t: string, n = 0): Record<string, unknown> => JSON.parse(lines.filter((l) => (JSON.parse(l) as { type: string }).type === t)[n] as string) as Record<string, unknown>;
    const bad = (m: unknown): boolean => !AnyMessage.safeParse(m).success;
    const write = at("routeDecision");
    expect(bad({ ...write, route: "fillAll" })).toBe(true);
    expect(bad({ ...write, key: null })).toBe(true);
    expect(bad({ ...write, outcome: "act", route: "" })).toBe(true);
    expect(bad({ ...write, outcome: "launch" })).toBe(true);
    expect(bad({ ...write, context: 0 })).toBe(true);
    expect(bad({ ...at("routeDecision", 1), route: "fillAll" })).toBe(true);
    expect(bad({ ...at("routingContext"), selection: "unknown" })).toBe(true);
    expect(bad({ ...at("routingContext"), breakpoint: "word" })).toBe(true);
    expect(bad({ ...at("routingContext"), textRevision: "" })).toBe(true);
    expect(bad({ ...at("routingContext"), key: undefined })).toBe(true);
    // R2 decision 1: a failed decision says why, and only a failed decision does.
    const failed = at("routeDecision", 6);
    expect(failed).toMatchObject({ outcome: "error", failure: "timeout" });
    expect(bad({ ...failed, failure: undefined })).toBe(true);
    expect(bad({ ...failed, failure: "lowConfidence" })).toBe(true);
    expect(bad({ ...failed, route: "fillAll" })).toBe(true);
    expect(bad({ ...write, failure: "failed" })).toBe(true);
    expect(bad({ ...at("routeDecision", 1), failure: "stale" })).toBe(true);
  });
});

const NOTES: AppRef = { pid: 4242, bundleId: "dev.caret.notes", name: "Notes Fixture" };
const DOC = "4242-1";
const BODY = "dev.caret.notes/standard/textarea:body~0";

/** Answers Router 1 by the outcomes it lists: write when legal, else act, else abstain. */
const router: AskJev = async (req) => {
  const crit = (req.questions.outcome as { criteria: Record<string, string> } | undefined)?.criteria ?? {};
  const choice = "write" in crit ? "write" : "act" in crit ? "act" : "abstain";
  return { model: "jev-test", answers: { outcome: { choice, confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
};

describe("route decisions through the helper and the server", () => {
  let dir: string;
  let store: Store;
  let memory: MemoryStore;
  let server: HelperServer;
  let helper: Helper;
  let clock: number;
  const due: { at: number; fn: () => void }[] = [];
  const advance = (ms: number): void => {
    clock += ms;
    for (const t of due.splice(0)) if (t.at <= clock) t.fn();
      else due.push(t);
  };
  const doc = (value: string): void => {
    const nodes: Node[] = [{ key: BODY, parent: null, role: "AXTextArea", label: "Body", editable: true, ...(value === "" ? {} : { value }) }];
    void helper.handleReader(snap(nodes, { at: clock, windowId: DOC, app: NOTES, title: "Plans", focused: true, focusedKey: BODY }));
  };
  const settle = async (): Promise<void> => {
    await new Promise((r) => setImmediate(r));
    await helper.routing?.idle();
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-routing-wire-"));
    store = new Store(join(dir, "data"));
    memory = new MemoryStore(join(dir, "data"));
    clock = Date.parse("2026-10-05T10:00:00-05:00");
    due.length = 0;
    const own: HelperServer = new HelperServer(join(dir, "screen.sock"), () => mine, () => {});
    const mine: Helper = new Helper({
      store,
      memory,
      askJev: router,
      shadow: false,
      allowBackgroundFocus: false,
      now: () => clock,
      publish: (m) => own.publish(m),
      routing: { setTimer: (fn, ms) => (due.push({ at: clock + ms, fn }), () => undefined) },
    });
    helper = mine;
    server = own;
    await server.listen();
  });
  afterEach(async () => {
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("makes write legal only while a routing host is connected, sends it decisions, and ends a write at a host breakpoint", async () => {
    const decisions = (c: LineClient): RouteDecision[] => c.received.filter((m): m is RouteDecision => (m as HM).type === "routeDecision");
    const oldHost = await LineClient.connect(join(dir, "screen.sock"));
    oldHost.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 2, version: "host-before-routing", host: true });
    await oldHost.waitFor((m) => m.type === "pageEngineState", 300).catch(() => undefined);
    void helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock, from: null, to: NOTES });
    doc("Plans for the week");
    await settle();
    // No host takes write decisions: nothing is legal in a plain document, so no call and the decision is abstain.
    expect(helper.routing?.decisions.at(-1)).toMatchObject({ outcome: "abstain", local: "noCapability" });

    const host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "host-test", host: true, capabilities: [ROUTING_CAPABILITY] });
    const write = await host.waitFor<RouteDecision>((m) => m.type === "routeDecision" && m.outcome === "write");
    expect(write).toMatchObject({ windowId: DOC, key: BODY, route: null });
    expect(write.expires).toBeGreaterThan(write.at);

    // The host's own revision and a sentence end it saw before the reader's walk: the write ends, then a new decision.
    advance(2000);
    host.send({ type: "routingContext", v: PROTOCOL_VERSION, at: clock, windowId: DOC, key: BODY, selection: "caret", composing: false, textRevision: "r31", breakpoint: "sentence" });
    const deciding = await host.waitFor<RouteDecision>((m) => m.type === "routeDecision" && m.outcome === null);
    expect(deciding).toMatchObject({ key: BODY, textRevision: write.textRevision });
    expect(deciding.context).toBeGreaterThan(write.context);
    advance(2000);
    await settle();
    const next = await host.waitFor<RouteDecision>((m) => m.type === "routeDecision" && m.context === deciding.context && m.outcome !== null);
    expect(next).toMatchObject({ outcome: "write", textRevision: "r31" });
    // Composing in an input method abstains at once, with no call.
    advance(2000);
    host.send({ type: "routingContext", v: PROTOCOL_VERSION, at: clock, windowId: DOC, key: BODY, selection: "caret", composing: true, textRevision: "r33", breakpoint: null });
    await host.waitFor<RouteDecision>((m) => m.type === "routeDecision" && m.outcome === "abstain" && m.textRevision === "r33");
    // Every decision the host received is a valid line; the old host got none and is refused by name.
    for (const d of decisions(host)) expect(HelperMessage.safeParse(d).success).toBe(true);
    expect(decisions(oldHost)).toEqual([]);
    oldHost.send({ type: "routingContext", v: PROTOCOL_VERSION, at: clock, windowId: DOC, key: BODY, selection: "caret", composing: false, textRevision: "x", breakpoint: null });
    expect(await oldHost.waitFor((m) => m.type === "error")).toMatchObject({ message: 'routingContext needs a host hello with "routing" in its capabilities' });

    // The routing host leaves: write is no longer legal.
    host.close();
    await new Promise((r) => setTimeout(r, 50));
    advance(2000);
    doc("Plans for the week. Then lunch");
    await settle();
    expect(helper.routing?.decisions.at(-1)).toMatchObject({ outcome: "abstain", local: "noCapability" });
    oldHost.close();
  });
});
