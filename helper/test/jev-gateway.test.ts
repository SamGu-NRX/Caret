import { beforeEach as vercelBeforeEach, afterEach as vercelAfterEach, vi as vercelVi } from "vitest";
import { minted } from "./minted.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailySpend, JevCapError, localDay } from "../src/engines/decide/daily-cap.ts";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { engineName } from "../src/engines/decide/port.ts";
import { jevSettings, loadJevKey, makeJevClient, jevFailureKind, JEV_URL, JEV_MODEL, JEV_USD_PER_INPUT_TOKEN } from "../src/fill/jev.ts";
import { GATEWAY_GPT_OSS_120B } from "../src/writer/config.ts";
import { gatewayRoute, GATEWAY_MODEL_IDS } from "../src/writer/routes.ts";
import { writersOnStart } from "../src/writer/startup.ts";
import { jevFailureSays, SAYS } from "../src/planner/says.ts";

const URL = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";
const MODEL = "typesafe-ai/jev";
const req = minted({ state: "fixture", questions: { q: { type: "choice" as const, instructions: "Pick A", criteria: { a: "A", b: "B" } } }, snippets: [], charged: {}, retry429: false });
const success = (cost?: unknown) => new Response(JSON.stringify({ model: MODEL, answers: { q: { choice: "a", confidence: 0.9 } }, usage: { input_tokens: 10 }, ...(cost === undefined ? {} : { provider_metadata: { gateway: { cost } } }) }));
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gw1-")); });
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });
const evaluation = { fixture: { windows: () => true, memory: true, plan: true }, env: {} };
const gateway = () => jevSettings({ CARET_JEV_PROVIDER: "gateway" });

describe("Jev provider selection", () => {
  it("keeps TypeSafe's URL, key and model as the default", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => success());
    vi.stubGlobal("fetch", fetch);
    await makeJevClient(() => loadJevKey({ TYPESAFE_API_KEY: "direct", CARET_JEV_GATEWAY_KEY: "gateway" }), 1000, new DailySpend({ dir, capUsd: 1 }), jevSettings({}))(req);
    expect(fetch.mock.calls[0]?.[0]).toBe(JEV_URL);
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).model).toBe(JEV_MODEL);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer direct" });
  });
  it("routes the same body through the gateway with its key and mapped model", async () => {
    const env = { CARET_JEV_PROVIDER: "gateway", TYPESAFE_API_KEY: "direct", CARET_JEV_GATEWAY_KEY: "gateway" };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => success());
    vi.stubGlobal("fetch", fetch);
    await makeJevClient(() => loadJevKey(env), 1000, new DailySpend({ dir, capUsd: 1 }), jevSettings(env))(req);
    expect(fetch.mock.calls[0]?.[0]).toBe(URL);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ Authorization: "Bearer gateway" });
    expect(JSON.parse(init?.body as string)).toEqual({ model: MODEL, state: req.state, questions: req.questions, providerOptions: { gateway: { only: ["typesafe-ai"] } } });
  });
  it("takes the provider, model and correct key from CARET_ENV_FILE, with environment precedence", () => {
    const file = join(dir, ".env");
    writeFileSync(file, "CARET_JEV_PROVIDER=gateway\nCARET_JEV_MODEL=\"convaiinnovations/laya-free\"\nexport CARET_JEV_GATEWAY_KEY='file-key'\nTYPESAFE_API_KEY=direct\n");
    expect(jevSettings({ CARET_ENV_FILE: file })).toMatchObject({ provider: "gateway", model: "convaiinnovations/laya-free", url: URL });
    expect(loadJevKey({ CARET_ENV_FILE: file })).toBe("file-key");
    expect(loadJevKey({ CARET_ENV_FILE: file, CARET_JEV_GATEWAY_KEY: "env-key" })).toBe("env-key");
    expect(jevSettings({ CARET_ENV_FILE: file, CARET_JEV_PROVIDER: "typesafe", CARET_JEV_MODEL: "jev-test" })).toMatchObject({ provider: "typesafe", model: "jev-test", url: JEV_URL });
  });
  it("does not substitute a direct key when the gateway key is missing", () => {
    expect(() => loadJevKey({ CARET_JEV_PROVIDER: "gateway", TYPESAFE_API_KEY: "secret" })).toThrow(/CARET_JEV_GATEWAY_KEY/);
  });
  it("rejects an unknown provider before making any request", () => {
    expect(() => jevSettings({ CARET_JEV_PROVIDER: "typo" })).toThrow(/CARET_JEV_PROVIDER/);
  });
});

describe("gateway failure kinds", () => {
  it("classifies verification-required 403 as card and gives the specified sentence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "customer_verification_required", message: "echo secret" } }), { status: 403 })));
    const e = await makeJevClient(() => "secret", 1000, new DailySpend({ dir, capUsd: 1 }), gateway())(req).catch((e: unknown) => e);
    expect(jevFailureKind(e)).toBe("card");
    expect(jevFailureSays(e, SAYS.unreachable)).toBe("Caret's model account needs a card on file at Vercel. Add one, then try again.");
    expect((e as Error).message).not.toContain("secret");
  });
  it.each([401, 403, 429])("keeps status %i as auth or rate unless the structured verification code is present", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"customer_verification_required"}}', { status })));
    const e = await makeJevClient(() => "key", 1000, new DailySpend({ dir, capUsd: 1 }), gateway())(req).catch((e: unknown) => e);
    expect(jevFailureKind(e)).toBe(status === 429 ? "rate" : "auth");
  });
});

describe("gateway reported cost", () => {
  it.each(["0.002", 0.002])("settles exact gateway cost %s into the daily ledger and blocks the next call", async (cost) => {
    const fetch = vi.fn(async () => success(cost));
    vi.stubGlobal("fetch", fetch);
    const spend = new DailySpend({ dir, capUsd: 0.001 });
    const ask = makeJevClient(() => "k", 1000, spend, gateway());
    expect((await ask(req)).costUsd).toBe(0.002);
    expect(spend.spent()).toBe(0.002);
    expect(JSON.parse(readFileSync(join(dir, `${localDay(new Date())}.ndjson`), "utf8")).usd).toBe(0.002);
    await expect(ask(req)).rejects.toBeInstanceOf(JevCapError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps an explicit zero cost for a free model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => success("0")));
    expect((await makeJevClient(() => "k", 1000, new DailySpend({ dir, capUsd: 1 }), gateway())(req)).costUsd).toBe(0);
  });
  it("estimates tokens only when gateway cost is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => success()));
    expect((await makeJevClient(() => "k", 1000, new DailySpend({ dir, capUsd: 1 }), gateway())(req)).costUsd).toBe(10 * JEV_USD_PER_INPUT_TOKEN);
  });
  it.each(["bad", "", "-1", "Infinity", null])("rejects invalid reported cost %s rather than silently estimating", async (cost) => {
    vi.stubGlobal("fetch", vi.fn(async () => success(cost)));
    await expect(makeJevClient(() => "k", 1000, new DailySpend({ dir, capUsd: 1 }), gateway())(req)).rejects.toThrow();
  });
});

it("adds gateway:<model> to the bake-off without making Laya a default", async () => {
  const name = engineName("gateway:convaiinnovations/laya-free");
  const e = harnessEngine({ name, canned: null, fixture: { windows: () => true, memory: true, plan: true }, env: { CARET_JEV_CACHE: "off", CARET_JEV_SPEND_DIR: dir, CARET_JEV_GATEWAY_KEY: "gateway" } });
  expect(e.engine.model).toBe("convaiinnovations/laya-free");
  const fetch = vi.fn<typeof globalThis.fetch>(async () => success("0"));
  vi.stubGlobal("fetch", fetch);
  await e.ask(req);
  expect(fetch.mock.calls[0]?.[0]).toBe(URL);
  expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).model).toBe("convaiinnovations/laya-free");
  expect(jevSettings({}).model).toBe(JEV_MODEL);
  expect(() => engineName("gateway:")).toThrow();
});

describe("gateway spend restrictions", () => {
  it("never falls back to the old gateway key", () => {
    expect(() => loadJevKey({ CARET_JEV_PROVIDER: "gateway", AI_GATEWAY_API_KEY: "old-secret" })).toThrow(/CARET_JEV_GATEWAY_KEY/);
  });
  it("maps the structured no-providers code to paidCredits, not a generic auth failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error_type":"no_providers_available","message":"paid credits required"}', { status: 403 })));
    const e = await makeJevClient(() => "key", 1000, new DailySpend({ dir, capUsd: 1 }), gateway())(req).catch((e: unknown) => e);
    expect(jevFailureKind(e)).toBe("paidCredits");
    expect(jevFailureSays(e, SAYS.unreachable)).toBe("Caret's model account needs paid credits at Vercel. Add credits, then try again.");
  });
  it("refuses other models before fetching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => success());
    vi.stubGlobal("fetch", fetch);
    const ask = makeJevClient(() => "key", 1000, new DailySpend({ dir, capUsd: 1 }), { ...gateway(), model: "openai/gpt-oss-120b" });
    await expect(ask(req)).rejects.toThrow(/not allowed/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["convaiinnovations/laya-free", "openai/gpt-oss-120b"])("records a charged refusal from %s, carries usage, and blocks all clients in this process", async (model) => {
    vi.resetModules();
    const client = await import("../src/fill/jev.ts");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ model, usage: { input_tokens: 7 }, provider_metadata: { gateway: { cost: "0.003" } } })));
    vi.stubGlobal("fetch", fetch);
    const spend = new DailySpend({ dir, capUsd: 1 });
    const ask = client.makeJevClient(() => "key", 1000, spend, client.jevSettings({ CARET_JEV_PROVIDER: "gateway" }));
    const e = await ask(req).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(client.JevGatewayPolicyError);
    if (!(e instanceof client.JevGatewayPolicyError)) throw new Error("expected policy error");
    expect(e.usage).toEqual({ inputTokens: 7, costUsd: 0.003 });
    expect(spend.spent()).toBe(0.003);
    // A new client must not get around the process-wide block, even if the service now returns a valid answer.
    await expect(client.makeJevClient(() => "key", 1000, spend, client.jevSettings({ CARET_JEV_PROVIDER: "gateway" }))(req)).rejects.toThrow(/blocked/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("records reported cost even if the successful HTTP answer is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"model":"typesafe-ai/jev","usage":{"input_tokens":7},"provider_metadata":{"gateway":{"cost":"0.004"}}}')));
    const spend = new DailySpend({ dir, capUsd: 1 });
    await expect(makeJevClient(() => "key", 1000, spend, gateway())(req)).rejects.toThrow();
    expect(spend.spent()).toBe(0.004);
  });
  it("requires an explicit zero cost for Laya instead of accepting an estimated cost", async () => {
    vi.resetModules();
    const client = await import("../src/fill/jev.ts");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "convaiinnovations/laya-free", answers: { q: { choice: "a", confidence: 1 } }, usage: { input_tokens: 10 } }))));
    await expect(client.makeJevClient(() => "key", 1000, new DailySpend({ dir, capUsd: 1 }), client.jevSettings({ CARET_JEV_PROVIDER: "gateway", CARET_JEV_MODEL: "convaiinnovations/laya-free" }), undefined, undefined, evaluation)(req)).rejects.toThrow(/explicit zero/);
  });
});


it("the writer's gateway routes cannot read the dedicated Jev key from env or a file", () => {
  const file = join(dir, ".env");
  writeFileSync(file, "CARET_JEV_GATEWAY_KEY=dedicated\n");
  expect(GATEWAY_GPT_OSS_120B.keyName).toBe("AI_GATEWAY_API_KEY");
  for (const model of GATEWAY_MODEL_IDS) {
    expect(gatewayRoute(model).keyName).toBe("AI_GATEWAY_API_KEY");
    expect(() => writersOnStart(`gateway:${model}`, () => {}, { CARET_JEV_GATEWAY_KEY: "dedicated" })).toThrow(/AI_GATEWAY_API_KEY/);
    expect(() => writersOnStart(`gateway:${model}`, () => {}, { CARET_ENV_FILE: file })).toThrow(/AI_GATEWAY_API_KEY/);
  }
});

it("paces Laya across clients and honors Retry-After even when the caller disallows a retry", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  try {
    const client = await import("../src/fill/jev.ts");
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{"error_type":"rate_limit"}', { status: 429, headers: { "retry-after": "10" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "convaiinnovations/laya-free", answers: { q: { choice: "a", confidence: 1 } }, usage: { input_tokens: 10 }, provider_metadata: { gateway: { cost: "0" } } })));
    vi.stubGlobal("fetch", fetch);
    const settings = client.jevSettings({ CARET_JEV_PROVIDER: "gateway", CARET_JEV_MODEL: "convaiinnovations/laya-free" });
    const spend = new DailySpend({ dir, capUsd: 1 });
    await expect(client.makeJevClient(() => "key", 1000, spend, settings, undefined, undefined, evaluation)(req)).rejects.toMatchObject({ kind: "rate" });
    const second = client.makeJevClient(() => "key", 1000, spend, settings, undefined, undefined, evaluation)(req);
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toMatchObject({ costUsd: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string).providerOptions).toEqual({ gateway: { only: ["boundless"] } });
  } finally { vi.useRealTimers(); }
});

describe("auditor regressions", () => {
  it("keeps the captured gateway provider while reading a rotated key at call time", async () => {
    const file = join(dir, ".env");
    writeFileSync(file, "CARET_JEV_PROVIDER=gateway\nCARET_JEV_GATEWAY_KEY=first\nTYPESAFE_API_KEY=direct\n");
    vi.stubEnv("CARET_ENV_FILE", file);
    vi.stubEnv("CARET_JEV_PROVIDER", "");
    vi.stubEnv("CARET_JEV_MODEL", "");
    vi.stubEnv("CARET_JEV_GATEWAY_KEY", "");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => success("0"));
    vi.stubGlobal("fetch", fetch);
    try {
      const ask = makeJevClient(loadJevKey, 1000, new DailySpend({ dir, capUsd: 1 }));
      writeFileSync(file, "CARET_JEV_PROVIDER=typesafe\nCARET_JEV_GATEWAY_KEY=rotated\nTYPESAFE_API_KEY=direct\n");
      await ask(req);
      expect(fetch.mock.calls[0]?.[0]).toBe(URL);
      expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer rotated" });
    } finally { vi.unstubAllEnvs(); }
  });
  it.each([null, "bad"])("blocks all clients after invalid Laya cost %s", async (cost) => {
    vi.resetModules();
    const client = await import("../src/fill/jev.ts");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ model: "convaiinnovations/laya-free", usage: { input_tokens: 10 }, provider_metadata: { gateway: { cost } } })));
    vi.stubGlobal("fetch", fetch);
    const settings = client.jevSettings({ CARET_JEV_PROVIDER: "gateway", CARET_JEV_MODEL: "convaiinnovations/laya-free" });
    const spend = new DailySpend({ dir, capUsd: 1 });
    await expect(client.makeJevClient(() => "key", 1000, spend, settings, undefined, undefined, evaluation)(req)).rejects.toBeInstanceOf(client.JevGatewayPolicyError);
    await expect(client.makeJevClient(() => "key", 1000, spend, settings, undefined, undefined, evaluation)(req)).rejects.toThrow(/blocked/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([MODEL, "not-allowed/model"])("settles token-cost fallback before refusing a malformed %s answer", async (model) => {
    vi.resetModules();
    const client = await import("../src/fill/jev.ts");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model, usage: { input_tokens: 7 } }))));
    const spend = new DailySpend({ dir, capUsd: 1 });
    const e = await client.makeJevClient(() => "key", 1000, spend, client.jevSettings({ CARET_JEV_PROVIDER: "gateway" }))(req).catch((e: unknown) => e);
    expect(spend.spent()).toBe(7 * JEV_USD_PER_INPUT_TOKEN);
    if (model !== MODEL) {
      expect(e).toBeInstanceOf(client.JevGatewayPolicyError);
      if (!(e instanceof client.JevGatewayPolicyError)) throw new Error("expected policy error");
      expect(e.usage.costUsd).toBe(7 * JEV_USD_PER_INPUT_TOKEN);
    }
  });
  it("a queued Laya request observes Retry-After received while it was sleeping", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    try {
      const client = await import("../src/fill/jev.ts");
      let release: (response: Response) => void = () => {};
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ model: "convaiinnovations/laya-free", answers: { q: { choice: "a", confidence: 1 } }, usage: { input_tokens: 1 }, provider_metadata: { gateway: { cost: "0" } } })));
      vi.stubGlobal("fetch", fetch);
      const settings = client.jevSettings({ CARET_JEV_PROVIDER: "gateway", CARET_JEV_MODEL: "convaiinnovations/laya-free" });
      const spend = new DailySpend({ dir, capUsd: 1 });
      const first = client.makeJevClient(() => "key", 20_000, spend, settings, undefined, undefined, evaluation)(req).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      const second = client.makeJevClient(() => "key", 20_000, spend, settings, undefined, undefined, evaluation)(req);
      await vi.advanceTimersByTimeAsync(1000);
      release(new Response('{"error_type":"rate_limit"}', { status: 429, headers: { "retry-after": "10" } }));
      await first;
      await vi.advanceTimersByTimeAsync(9999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toMatchObject({ costUsd: 0 });
    } finally { vi.useRealTimers(); }
  });
});

// These provider-shaping tests use fake transports; gateway execution requires an explicit dev opt-in.
vercelBeforeEach(() => { vercelVi.stubEnv("CARET_DEV_VERCEL_GEMINI", "1"); vercelVi.stubEnv("CARET_RELEASE_HOST", "0"); });
vercelAfterEach(() => vercelVi.unstubAllEnvs());
