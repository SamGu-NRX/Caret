// The spend ledger (H8 decision 4): every Jev and writer call counted from the provider's usage report, and the totals
// sent only to consumers whose hello names "spend". The golden lines are the contract the host copies. Everything is
// invented.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelperServer } from "../src/server.ts";
import { ConsumerMessage, HelperMessage, PROTOCOL_VERSION, Spend, SPEND_CAPABILITY } from "../src/protocol.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import type { WriterPort, WriterRequest } from "../src/writer/port.ts";
import { devWriterRoute } from "../src/writer/routes.ts";
import { ledgeredJev, ledgeredWriter, SpendLedger, throttledTotals } from "../src/spend.ts";
import type { Helper } from "../src/helper.ts";
import { LineClient } from "./socket-reader.ts";

const lines = readFileSync(new URL("../fixtures/golden/spend.ndjson", import.meta.url), "utf8").trim().split("\n");
const req = {} as JevRequest;

// Since L1 no writer route is configured by default, so the ledger is tested on a route a developer may name.
const WRITER_ROUTE = devWriterRoute("gateway:inclusionai/ling-3.1-flash-free");

describe("the spend lines", () => {
  it("parses every golden line and writes it back byte for byte", () => {
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(["hello", "spend", "spend"]);
    expect(JSON.stringify(ConsumerMessage.parse(JSON.parse(lines[0] as string)))).toBe(lines[0]);
    for (const l of lines.slice(1)) expect(JSON.stringify(HelperMessage.parse(JSON.parse(l)))).toBe(l);
  });

  it("refuses counts that are not whole and costs below zero", () => {
    const m = JSON.parse(lines[2] as string) as Spend;
    expect(Spend.safeParse({ ...m, jev: { ...m.jev, calls: 1.5 } }).success).toBe(false);
    expect(Spend.safeParse({ ...m, writer: { ...m.writer, costUsd: -1 } }).success).toBe(false);
    expect(Spend.safeParse({ ...m, writer: undefined }).success).toBe(false);
  });
});

describe("SpendLedger", () => {
  it("counts each answered Jev call's input tokens and cost, and a failed call as failed with no usage", async () => {
    const ledger = new SpendLedger(1000);
    let fail = false;
    const ask: AskJev = async () => {
      if (fail) throw new Error("Jev HTTP 500");
      return { model: "jev-test", answers: {}, inputTokens: 1400, latencyMs: 5, costUsd: 0.0000588 };
    };
    const jev = ledgeredJev(ask, ledger);
    await jev(req);
    await jev(req);
    fail = true;
    await expect(jev(req)).rejects.toThrow("Jev HTTP 500");
    const m = ledger.message(2000);
    expect(Spend.parse(m)).toEqual(m);
    expect(m).toMatchObject({ since: 1000, at: 2000, jev: { calls: 2, failed: 1, inputTokens: 2800, outputTokens: 0 } });
    expect(m.jev.costUsd).toBeCloseTo(0.0001176, 12);
    expect(m.writer).toEqual({ calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it("counts each writer call's input and output tokens and cost, whatever its kind", async () => {
    const ledger = new SpendLedger();
    const port: WriterPort = {
      route: WRITER_ROUTE,
      write: async (r: WriterRequest) => {
        if (r.kind === "goal") throw new Error("Groq HTTP 429");
        return { model: "m", provider: "groq", output: { program: null, reply: "" }, inputTokens: 900, outputTokens: 210, reasoningTokens: 40, latencyMs: 9, costUsd: 0.0006 };
      },
    };
    const writer = ledgeredWriter(port, ledger);
    expect(writer.route).toBe(WRITER_ROUTE);
    const signal = new AbortController().signal;
    await writer.write({ kind: "plan", disclosureId: "d", input: {}, maxOutputTokens: 10, signal });
    await writer.write({ kind: "intent", disclosureId: "d", input: {}, maxOutputTokens: 10, signal });
    await expect(writer.write({ kind: "goal", disclosureId: "d", input: {}, maxOutputTokens: 10, signal })).rejects.toThrow("429");
    expect(ledger.message().writer).toMatchObject({ calls: 2, failed: 1, inputTokens: 1800, outputTokens: 420 });
    expect(ledger.message().writer.costUsd).toBeCloseTo(0.0012, 12);
  });

  it("sends a burst of calls as one message within the interval, and the final totals after it", async () => {
    vi.useFakeTimers();
    try {
      const ledger = new SpendLedger();
      const sent: Spend[] = [];
      throttledTotals(ledger, (m) => sent.push(m), 1000);
      for (let i = 0; i < 5; i++) ledger.answered("jev", { inputTokens: 10, outputTokens: 0, costUsd: 1 });
      expect(sent).toHaveLength(0);
      vi.advanceTimersByTime(1000);
      expect(sent.map((m) => m.jev.calls)).toEqual([5]);
      ledger.failed("writer");
      vi.advanceTimersByTime(1000);
      expect(sent.map((m) => [m.jev.calls, m.writer.failed])).toEqual([[5, 0], [5, 1]]);
      vi.advanceTimersByTime(5000);
      expect(sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("spend on the socket", () => {
  let dir: string;
  let server: HelperServer;
  const helperStub = { hostConnected: () => undefined, consumerConnected: () => undefined, hostDisconnected: () => undefined } as unknown as Helper;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-spend-"));
    server = new HelperServer(join(dir, "screen.sock"), () => helperStub, () => {});
    await server.listen();
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends the totals to a consumer that asks, at once and after calls, and never to one that does not", async () => {
    const ledger = new SpendLedger(1000);
    server.spendNow = () => ledger.message();
    const asks = await LineClient.connect(join(dir, "screen.sock"));
    asks.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "host-test", host: true, capabilities: [SPEND_CAPABILITY] });
    const first = await asks.waitFor<Spend>((m) => m.type === "spend");
    expect(first.jev.calls).toBe(0);
    const plain = await LineClient.connect(join(dir, "screen.sock"));
    plain.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 2, version: "host-test", host: true });
    ledger.answered("writer", { inputTokens: 5, outputTokens: 7, costUsd: 0.5 });
    server.publish(ledger.message());
    const after = await asks.waitFor<Spend>((m) => m.type === "spend" && (m as unknown as Spend).writer.calls === 1);
    expect(after.writer).toMatchObject({ inputTokens: 5, outputTokens: 7, costUsd: 0.5 });
    await new Promise((r) => setTimeout(r, 50));
    expect(plain.received.filter((m) => (m as { type: string }).type === "spend")).toHaveLength(0);
    asks.s.destroy();
    plain.s.destroy();
  });
});
