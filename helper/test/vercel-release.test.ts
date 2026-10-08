import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jevSettings, loadJevKey, makeJevClient, JEV_GATEWAY_URL, JEV_GATEWAY_MODEL } from "../src/fill/jev.ts";
import { chat } from "../src/writer/chat.ts";
import { gatewayRoute } from "../src/writer/routes.ts";
import { seal } from "../src/privacy/send.ts";
import { minted } from "./minted.ts";
// INT1: on v2/next every request is minted and sealed (PV2), so the fixture request is too (test/minted.ts).
const req = minted({ state: "fixture", questions: { q: { type: "choice" as const, instructions: "Pick A", criteria: { a: "A" } } }, snippets: [], charged: {}, retry429: false });
afterEach(() => vi.unstubAllEnvs());
describe("release Vercel refusal", () => {
  it.each(["0", "1"])("refuses Jev gateway with dev opt-in %s under release marker", async (optIn) => {
    vi.stubEnv("CARET_RELEASE_HOST", "1"); vi.stubEnv("CARET_DEV_VERCEL_GEMINI", optIn);
    const send = vi.fn<typeof fetch>();
    const ask = makeJevClient(() => "fixture-key", 1000, undefined, { provider: "gateway", url: JEV_GATEWAY_URL, model: JEV_GATEWAY_MODEL }, send);
    await expect(ask(req)).rejects.toThrow(/release host/);
    expect(send).not.toHaveBeenCalled();
  });
  it("an env file cannot restore the Jev gateway under a release marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vercel-release-"));
    try {
      const file = join(dir, "developer.env");
      writeFileSync(file, "CARET_JEV_PROVIDER=gateway\nCARET_JEV_GATEWAY_KEY=fixture-key\nCARET_DEV_VERCEL_GEMINI=1\nCARET_RELEASE_HOST=0\n");
      vi.stubEnv("CARET_RELEASE_HOST", "1"); vi.stubEnv("CARET_DEV_VERCEL_GEMINI", "1"); vi.stubEnv("CARET_ENV_FILE", file);
      const send = vi.fn<typeof fetch>();
      const ask = makeJevClient(() => loadJevKey(), 1000, undefined, jevSettings(), send);
      await expect(ask(req)).rejects.toThrow(/release host/);
      expect(send).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("dev mode without the marker sends Jev through the mocked gateway", async () => {
    vi.stubEnv("CARET_RELEASE_HOST", "0"); vi.stubEnv("CARET_DEV_VERCEL_GEMINI", "1");
    const send = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: JEV_GATEWAY_MODEL, answers: { q: { choice: "a", confidence: 0.9 } }, usage: { input_tokens: 1 } })));
    await makeJevClient(() => "fixture-key", 1000, undefined, { provider: "gateway", url: JEV_GATEWAY_URL, model: JEV_GATEWAY_MODEL }, send)(req);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("refuses helper writer gateway under release marker", async () => {
    vi.stubEnv("CARET_RELEASE_HOST", "1"); vi.stubEnv("CARET_DEV_VERCEL_GEMINI", "1");
    const send = vi.fn<typeof fetch>();
    await expect(chat(gatewayRoute("openai/gpt-oss-120b"), "fixture-key", seal({ req, wire: { state: req.state, questions: req.questions } }), new AbortController().signal, send)).rejects.toThrow(/release host/);
    expect(send).not.toHaveBeenCalled();
  });
});
