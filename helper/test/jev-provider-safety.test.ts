import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailySpend } from "../src/engines/decide/daily-cap.ts";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { jevSettings, loadJevKey, makeJevClient, type AskJev } from "../src/fill/jev.ts";

const req = { state: "synthetic", questions: {}, snippets: [], charged: {}, retry429: false };
const fixture = { windows: (id: string) => id === "fixture", memory: false, plan: false };
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "jev-safety-")); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

// Evaluate only the key callback from main, not its socket, stores, or startup code.
function mainKeyCallback(): Parameters<typeof makeJevClient>[0] {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const callback = /askJev:.*makeJevClient\((loadJevKey|\(\) => loadJevKey\(\))\)/.exec(source)?.[1];
  if (callback === undefined) throw new Error("main's Jev key callback was not found");
  // SAFETY: the regex accepts only loadJevKey or its zero-argument wrapper, both matching this callback type.
  return new Function("loadJevKey", `return ${callback}`)(loadJevKey) as Parameters<typeof makeJevClient>[0];
}

describe("provider credential binding at production callers", () => {
  it.each(["gateway", "typesafe"] as const)("keeps main's %s key after env-file provider rotation", async (provider) => {
    const file = join(dir, ".env");
    for (const name of ["CARET_JEV_PROVIDER", "CARET_JEV_MODEL", "CARET_JEV_GATEWAY_KEY", "TYPESAFE_API_KEY"]) vi.stubEnv(name, "");
    vi.stubEnv("CARET_ENV_FILE", file);
    writeFileSync(file, `CARET_JEV_PROVIDER=${provider}\nCARET_JEV_GATEWAY_KEY=gateway-before\nTYPESAFE_API_KEY=direct-before\n`);
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: provider === "gateway" ? "typesafe-ai/jev" : "jev-latest", answers: {}, usage: { input_tokens: 0 }, provider_metadata: { gateway: { cost: "0" } } })));
    const ask = makeJevClient(mainKeyCallback(), 1000, new DailySpend({ dir, capUsd: 1 }), jevSettings(), transport);
    writeFileSync(file, `CARET_JEV_PROVIDER=${provider === "gateway" ? "typesafe" : "gateway"}\nCARET_JEV_GATEWAY_KEY=gateway-rotated\nTYPESAFE_API_KEY=direct-rotated\n`);
    await ask(req);
    expect(transport.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${provider === "gateway" ? "gateway" : "direct"}-rotated` });
    expect(String(transport.mock.calls[0]?.[0])).toContain(provider === "gateway" ? "ai-gateway.vercel.sh" : "api.typesafe.ai");
  });
  it("legacy evals forward the captured provider instead of reselecting it", () => {
    const files = ["answers-eval", "realfill-eval", "planner-eval", "event-eval", "goal-scenes-eval", "pending-fixture-eval", "routing/corpus-eval", "routing/sentence-latency", "pending-agent-eval", "routing/focus-entry", "page-replay-eval", "about-fill-eval", "routing/a5-offers", "goal-drafts-eval", "real-target-eval", "skills-eval", "executor-eval"];
    for (const file of files) {
      const source = readFileSync(new URL(`../scripts/${file}.ts`, import.meta.url), "utf8");
      expect(source, file).not.toContain("makeJevClient(() => loadJevKey())");
    }
    const replay = readFileSync(new URL("../scripts/live-replay.ts", import.meta.url), "utf8");
    expect(replay).not.toContain("makeJevClient(() => key)");
  });
});

describe("Laya fixture-only boundary", () => {
  function client(sources?: typeof fixture, env: NodeJS.ProcessEnv = {}): { ask: AskJev; key: ReturnType<typeof vi.fn>; transport: ReturnType<typeof vi.fn> } {
    const key = vi.fn(() => "synthetic-key");
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: "convaiinnovations/laya-free", answers: {}, usage: { input_tokens: 0 }, provider_metadata: { gateway: { cost: "0" } } })));
    const ask = makeJevClient(key, 1000, new DailySpend({ dir, capUsd: 1 }), jevSettings({ CARET_JEV_PROVIDER: "gateway", CARET_JEV_MODEL: "convaiinnovations/laya-free" }), transport, undefined, sources === undefined ? undefined : { fixture: sources, env });
    return { ask, key, transport };
  }
  it("refuses explicit Laya configuration without fixture provenance before key or network access", async () => {
    const c = client();
    await expect(c.ask(req)).rejects.toThrow(/fixture/);
    expect(c.key).not.toHaveBeenCalled();
    expect(c.transport).not.toHaveBeenCalled();
  });
  it.each(["CARET_LAUNCHD_AGENT", "CARET_OPENED_BY_LAUNCHSERVICES"])("refuses fixtures when %s marks the shipped app", async (marker) => {
    const c = client(fixture, { [marker]: "1" });
    await expect(c.ask(req)).rejects.toThrow(/shipped app/);
    expect(c.transport).not.toHaveBeenCalled();
  });
  it("also checks the real process markers when a custom environment omits them", async () => {
    vi.stubEnv("CARET_LAUNCHD_AGENT", "1");
    const c = client(fixture);
    await expect(c.ask(req)).rejects.toThrow(/shipped app/);
    expect(c.transport).not.toHaveBeenCalled();
  });
  it.each(["real-screen", "memory", "plan"])("refuses non-fixture %s sources with cache off", async (id) => {
    const c = client(fixture);
    await expect(c.ask({ ...req, charged: { [id]: 1 } })).rejects.toThrow(/fixture/);
    expect(c.transport).not.toHaveBeenCalled();
  });
  it("accepts declared synthetic fixture sources", async () => {
    const c = client(fixture);
    await expect(c.ask({ ...req, charged: { fixture: 1 } })).resolves.toMatchObject({ costUsd: 0 });
    expect(c.transport).toHaveBeenCalledOnce();
  });
  it.each(["off", "replay"])("refuses a process shipped marker before harness cache mode %s can answer", (mode) => {
    vi.stubEnv("CARET_LAUNCHD_AGENT", "1");
    expect(() => harnessEngine({ name: "gateway:convaiinnovations/laya-free", canned: null, fixture, env: { CARET_JEV_CACHE: mode === "off" ? "off" : join(dir, "cache"), CARET_JEV_CACHE_MODE: "replay", CARET_JEV_SPEND_DIR: dir } })).toThrow(/shipped app/);
  });
  it("keeps gateway Jev's normal source handling with cache off", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response('{"model":"typesafe-ai/jev","answers":{},"usage":{"input_tokens":0},"provider_metadata":{"gateway":{"cost":"0"}}}'));
    vi.stubGlobal("fetch", transport);
    const h = harnessEngine({ name: "gateway:typesafe-ai/jev", canned: null, fixture, env: { CARET_JEV_CACHE: "off", CARET_JEV_SPEND_DIR: dir, CARET_JEV_GATEWAY_KEY: "synthetic" } });
    await expect(h.ask({ ...req, charged: { "real-screen": 1 } })).resolves.toMatchObject({ costUsd: 0 });
    expect(transport).toHaveBeenCalledOnce();
  });
  it("checks harness sources even when the replay cache is off", async () => {
    const transport = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", transport);
    const h = harnessEngine({ name: "gateway:convaiinnovations/laya-free", canned: null, fixture, env: { CARET_JEV_CACHE: "off", CARET_JEV_SPEND_DIR: dir, CARET_JEV_GATEWAY_KEY: "synthetic" } });
    await expect(h.ask({ ...req, charged: { "real-screen": 1 } })).rejects.toThrow(/fixture/);
    expect(transport).not.toHaveBeenCalled();
  });
});
