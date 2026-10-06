import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailySpend, JevCapError } from "../src/engines/decide/daily-cap.ts";
import { fixtureFillRequest, probeCount, runProbe, SMALL_REQUEST, summarize } from "../scripts/jev-latency.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gw1-probe-")); });
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });
const record = (value = "Jordan Reyes", instruction = "Customer name") => JSON.stringify({ page: "httpbin-pizza", questions: { f1: { ins: `Field. Label: '${instruction}'.`, criteria: { c1: `"${value}" (this suffix is untrusted and must not be sent)`, none: "untrusted" } } } });

describe("the bounded latency probe", () => {
  it("refuses before network or key access when the daily cap is spent", async () => {
    const spend = new DailySpend({ dir, capUsd: 0.001 });
    spend.reserve(0).settle(0.002, 1);
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(runProbe({ count: 1, providers: ["typesafe", "gateway"], requests: { small: SMALL_REQUEST }, spend, env: {}, fetchFn: fetch })).rejects.toBeInstanceOf(JevCapError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("measures the first body byte and full body, even for an HTTP rejection", async () => {
    let now = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      now = 10; // Headers alone are not time to first byte.
      let sent = false;
      return new Response(new ReadableStream({ pull(c) { now = sent ? 35 : 25; if (sent) c.close(); else { sent = true; c.enqueue(new TextEncoder().encode('{"error_type":"billing_error"}')); } } }, { highWaterMark: 0 }), { status: 402 });
    });
    const rows = await runProbe({ count: 1, providers: ["typesafe"], requests: { small: SMALL_REQUEST }, spend: new DailySpend({ dir, capUsd: 1 }), env: { TYPESAFE_API_KEY: "not-printed" }, fetchFn: fetch, now: () => now });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 402, failure: "billing", ttfbMs: 25, totalMs: 35 });
    expect(JSON.stringify(rows)).not.toContain("not-printed");
  });
  it("allows Laya's synthetic small probe with explicit zero cost", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"model":"convaiinnovations/laya-free","answers":{"q":{"choice":"email","confidence":1}},"usage":{"input_tokens":1},"provider_metadata":{"gateway":{"cost":"0"}}}'));
    const rows = await runProbe({ count: 1, providers: ["gateway"], gatewayModel: "convaiinnovations/laya-free", requests: { small: SMALL_REQUEST }, spend: new DailySpend({ dir, capUsd: 1 }), env: { CARET_JEV_GATEWAY_KEY: "synthetic" }, fetchFn: fetch });
    expect(rows[0]).toMatchObject({ status: 200, costUsd: 0, failure: null });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("refuses arbitrary or mutated probe text for Laya before network access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(runProbe({ count: 1, providers: ["gateway"], gatewayModel: "convaiinnovations/laya-free", requests: { small: { ...SMALL_REQUEST, state: "private screen text" } }, spend: new DailySpend({ dir, capUsd: 1 }), env: { CARET_JEV_GATEWAY_KEY: "synthetic" }, fetchFn: fetch })).rejects.toThrow(/synthetic fixtures/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps the approved fixture snapshot when the caller mutates text between samples", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    try {
      const probe = await import("../scripts/jev-latency.ts");
      const req = structuredClone(probe.SMALL_REQUEST);
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        req.state = "private replacement text";
        return new Response('{"model":"convaiinnovations/laya-free","answers":{"q":{"choice":"email","confidence":1}},"usage":{"input_tokens":1},"provider_metadata":{"gateway":{"cost":"0"}}}');
      });
      const pending = probe.runProbe({ count: 2, providers: ["gateway"], gatewayModel: "convaiinnovations/laya-free", requests: { small: req }, spend: new DailySpend({ dir, capUsd: 1 }), env: { CARET_JEV_GATEWAY_KEY: "synthetic" }, fetchFn: fetch });
      await vi.runAllTimersAsync();
      await pending;
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const [, init] of fetch.mock.calls) expect(JSON.parse(String(init?.body)).state).toBe(probe.SMALL_REQUEST.state);
    } finally { vi.useRealTimers(); }
  });
  it("fails the probe on shipped-app refusal rather than returning failed samples", async () => {
    vi.stubEnv("CARET_LAUNCHD_AGENT", "1");
    try {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(runProbe({ count: 1, providers: ["gateway"], gatewayModel: "convaiinnovations/laya-free", requests: { small: SMALL_REQUEST }, spend: new DailySpend({ dir, capUsd: 1 }), env: {}, fetchFn: fetch })).rejects.toThrow(/shipped app/);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
  it("reports nearest-rank p50, p95 and max without sorting the caller's samples", () => {
    const times = [100, 1, 3, 2];
    expect(summarize(times)).toEqual({ p50: 2, p95: 100, max: 100 });
    expect(times).toEqual([100, 1, 3, 2]);
    expect(summarize([])).toBeNull();
  });
  it.each(["0", "31", "-1", "1.5", "NaN"])("refuses count %s so a provider cannot exceed 2 x 30 requests", (n) => {
    expect(() => probeCount(n)).toThrow(/1 to 30/);
  });
  it("rebuilds recorded question structure using only fixture text", () => {
    const req = fixtureFillRequest(record());
    expect(req.questions.f1?.criteria.c1).toContain("Jordan Reyes");
    expect(req.questions.f1?.instructions).toContain("Customer name");
    expect(JSON.stringify(req)).not.toContain("untrusted");
  });
  it("refuses a candidate or field not found in the synthetic fixture", () => {
    expect(() => fixtureFillRequest(record("real-person-secret"))).toThrow(/fixture/);
    expect(() => fixtureFillRequest(record("Jordan Reyes", "private field"))).toThrow(/fixture/);
  });
});

it.each([200, 403])("reports exact recorded spend when an HTTP %i sample fails", async (status) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"model":"typesafe-ai/jev","usage":{"input_tokens":7},"provider_metadata":{"gateway":{"cost":"0.004"}}}', { status }));
  const spend = new DailySpend({ dir, capUsd: 1 });
  const rows = await runProbe({ count: 1, providers: ["gateway"], requests: { small: SMALL_REQUEST }, spend, env: { CARET_JEV_GATEWAY_KEY: "fixture" }, fetchFn: fetch });
  expect(spend.spent()).toBe(0.004);
  expect(rows[0]?.costUsd).toBe(0.004);
});
