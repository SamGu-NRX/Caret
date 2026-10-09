import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), homedir: () => fake.home }));
let dir: string;
beforeEach(() => { vi.resetModules(); dir = mkdtempSync(join(tmpdir(), "caret-decisions-log-")); fake.home = dir; });
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });
it.each(["success", "refusal", "invalid"])("creates the default log with cache off and preserves %s telemetry", async (kind) => {
  const { harnessEngine } = await import("../src/engines/decide/harness.ts");
  const { DecisionsAttemptError, DECISIONS_MODEL } = await import("../src/engines/decide/decisions.ts");
  const { DECISIONS_USD_PER_TOKEN } = await import("../src/engines/decide/decisions-spend.ts");
  const { minted } = await import("./minted.ts");
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ model: DECISIONS_MODEL, answers: [kind === "refusal" ? { type: "refusal", name: "q" } : { type: "choice", name: "q", choice: kind === "success" ? "a" : "invalid", confidence: 0.9, probabilities: [{ value: "a", probability: 0.9 }, { value: "leave_blank", probability: 0.1 }] }], usage: { input_tokens: 42 } })));
  vi.stubGlobal("fetch", fetchFn);
  const engine = harnessEngine({ name: "decisions", canned: null, fixture: { windows: () => true, memory: false, plan: false }, env: { OPENAI_API_KEY: "synthetic-key", CARET_JEV_CACHE: "off", CARET_DECISIONS_SPEND_DIR: join(dir, "spend") } });
  const log = join(dir, ".caret-run", "jev-cache", "decisions-requests.ndjson");
  try {
    expect(existsSync(join(dir, ".caret-run", "jev-cache"))).toBe(true);
    const req = minted({ state: { synthetic: "blue" }, questions: { q: { type: "choice", instructions: "Pick", criteria: { a: "Blue", none: null } } }, snippets: [], charged: {} });
    if (kind === "success") expect((await engine.ask(req)).costUsd).toBe(42 * DECISIONS_USD_PER_TOKEN);
    else {
      const error = await engine.ask(req).catch((e) => e);
      expect(error).toBeInstanceOf(DecisionsAttemptError);
      expect(error.attempt.costUsd).toBe(42 * DECISIONS_USD_PER_TOKEN);
    }
    const row = JSON.parse(readFileSync(log, "utf8").trim());
    expect(row.costUsd).toBe(42 * DECISIONS_USD_PER_TOKEN);
    expect(fetchFn).toHaveBeenCalledOnce();
  } finally { engine.engine.close?.(); }
});
it("creates a fresh recording cache's default log before the first failed request", async () => {
  const { harnessEngine } = await import("../src/engines/decide/harness.ts");
  const { DecisionsAttemptError } = await import("../src/engines/decide/decisions.ts");
  const { minted } = await import("./minted.ts");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("synthetic transport failure"); }));
  const cache = join(dir, "fresh-cache");
  const engine = harnessEngine({ name: "decisions", canned: null, fixture: { windows: () => true, memory: false, plan: false }, env: { OPENAI_API_KEY: "synthetic-key", CARET_JEV_CACHE: cache, CARET_DECISIONS_SPEND_DIR: join(dir, "spend") } });
  try {
    const req = minted({ state: "Synthetic", questions: { q: { type: "choice", instructions: "Pick", criteria: { a: "Blue", none: null } } }, snippets: [], charged: {} });
    await expect(engine.ask(req)).rejects.toBeInstanceOf(DecisionsAttemptError);
    expect(JSON.parse(readFileSync(join(cache, "decisions-requests.ndjson"), "utf8")).error).toContain("Decisions");
  } finally { engine.engine.close?.(); }
});
it("rejects an invalid default log parent before dispatch and releases the spend lock", async () => {
  const { harnessEngine } = await import("../src/engines/decide/harness.ts");
  const cache = join(dir, "not-a-directory"); writeFileSync(cache, "synthetic");
  const fetchFn = vi.fn(); vi.stubGlobal("fetch", fetchFn);
  expect(() => harnessEngine({ name: "decisions", canned: null, fixture: { windows: () => true, memory: false, plan: false }, env: { OPENAI_API_KEY: "synthetic-key", CARET_JEV_CACHE: cache, CARET_DECISIONS_SPEND_DIR: join(dir, "spend") } })).toThrow();
  expect(fetchFn).not.toHaveBeenCalled();
  expect(existsSync(join(dir, "spend", "run.lock"))).toBe(false);
});
