// J1: an eval's --engine flag (engines/decide/harness.ts): canned answers directly, every other engine behind the cache,
// and nothing that stores request text takes text from a window the harness did not load from a fixture.
import { minted } from "./minted.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { calibrationFromEnv, harnessEngine } from "../src/engines/decide/harness.ts";
import { CacheRefused } from "../src/engines/decide/cache.ts";
import { engineName } from "../src/engines/decide/port.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "j1-harness-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const req = (windowId: string): JevRequest => (minted({ state: { s: 1 }, questions: { q: { type: "choice", instructions: "i", criteria: { a: "A", b: "B" } } }, snippets: [{ windowId, kind: "candidate", text: "A" }], charged: {} }));
const canned: AskJev = async () => ({ model: "canned", answers: { q: { choice: "a", confidence: 0.9 } }, inputTokens: 0, latencyMs: 0, costUsd: 0 });
const fixture = { windows: (id: string) => id === "fx", memory: true, plan: true };

describe("an eval's decision engine", () => {
  it("is one of jev, canned, llama and gemini", () => {
    expect(engineName("llama")).toBe("llama");
    expect(() => engineName("groq")).toThrow(/--engine is jev, canned, llama, gemini/);
  });

  it("says plainly that gemini needs a key, since none is configured", () => {
    expect(() => harnessEngine({ name: "gemini", canned: null, fixture, env: {} })).toThrow(/GEMINI_API_KEY/);
  });

  it("needs the model's name for llama, for its reports and cache keys", () => {
    expect(() => harnessEngine({ name: "llama", canned: null, fixture, env: {} })).toThrow(/CARET_LLAMA_MODEL/);
  });

  it("answers canned without the cache, and logs only fixture text", async () => {
    const log = join(tmp(), "requests.ndjson");
    const e = harnessEngine({ name: "canned", canned, fixture, env: { CARET_JEV_CACHE: tmp() }, logRequests: log });
    expect(e.says).toBe("engine canned (canned)");
    await e.ask(req("fx"));
    expect(JSON.parse(readFileSync(log, "utf8").trim()).body.questions.q.criteria).toEqual({ a: "A", b: "B" });
    await expect(e.ask(req("real-window"))).rejects.toBeInstanceOf(CacheRefused);
  });

  it("puts llama behind the cache and reads its calibration from the environment", () => {
    const dir = tmp();
    const e = harnessEngine({ name: "llama", canned: null, fixture, env: { CARET_LLAMA_MODEL: "qwen", CARET_JEV_CACHE: dir, CARET_ENGINE_CALIBRATION: "1.5,2" } });
    expect(e.says).toBe(`engine llama (qwen), cache replay-or-record in ${dir}, calibration choice T 1.5, yes/no T 2`);
    expect(() => calibrationFromEnv({ CARET_ENGINE_CALIBRATION: "hot" })).toThrow(/CARET_ENGINE_CALIBRATION/);
  });

  it("refuses llama with no calibration, since a small model's raw probabilities pass floors Jev's would not", () => {
    expect(() => harnessEngine({ name: "llama", canned: null, fixture, env: { CARET_LLAMA_MODEL: "unfitted", CARET_JEV_CACHE: "off" } })).toThrow(/no calibration for unfitted/);
    expect(harnessEngine({ name: "llama", canned: null, fixture, env: { CARET_LLAMA_MODEL: "unfitted", CARET_JEV_CACHE: "off", CARET_ENGINE_CALIBRATION: "1,1" } }).says).toContain("choice T 1");
  });
});

describe("the request log", () => {
  it("refuses the shipped app even with the cache off", () => {
    expect(() => harnessEngine({ name: "canned", canned, fixture, env: { CARET_JEV_CACHE: "off", CARET_LAUNCHD_AGENT: "1" }, logRequests: join(tmp(), "r.ndjson") })).toThrow(CacheRefused);
  });
});
