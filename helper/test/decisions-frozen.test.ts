import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canonicalRequest } from "../src/engines/decide/cache.ts";
import { wireBody } from "../src/fill/jev.ts";
import { minted } from "./minted.ts";
const fake = vi.hoisted(() => ({ cache: "", ask: vi.fn(), config: vi.fn(), close: vi.fn() }));
vi.mock("../src/engines/decide/cache.ts", async (original) => ({ ...await original<typeof import("../src/engines/decide/cache.ts")>(), cacheFromEnv: () => ({ dir: fake.cache }) }));
vi.mock("../src/engines/decide/harness.ts", () => ({ HARNESS_CACHE_DIR: "unused", harnessEngine: (o: unknown) => {
  fake.config(o); return { ask: fake.ask, engine: { close: fake.close } };
} }));
let dir: string;
let argv: string[];
let exitCode: typeof process.exitCode;
const req = () => minted({
  state: { instruction: "fill the rest of this from my note" },
  questions: {
    z: { type: "choice", instructions: "Z", criteria: { second: "Blue", first: "Blue", none: null } },
    a: { type: "choice", instructions: "A", criteria: { second: "Blue", first: "Blue", none: null } },
  }, snippets: [], charged: {},
});
beforeEach(() => {
  vi.resetModules(); fake.ask.mockReset(); fake.config.mockClear(); fake.close.mockClear();
  dir = mkdtempSync(join(tmpdir(), "caret-frozen-")); argv = process.argv; exitCode = process.exitCode;
  fake.cache = join(dir, "cache"); mkdirSync(join(fake.cache, "aa"), { recursive: true });
  const c = canonicalRequest(req(), "jev", "synthetic");
  writeFileSync(join(fake.cache, "aa", "entry.json"), JSON.stringify({ engine: "jev", model: "jev-latest", canonical: { exact: c.exact, state: req().state, questions: c.questions }, answers: { 0: { choice: "first", confidence: 0.9 }, 1: { choice: "first", confidence: 0.9 } }, probabilities: { 0: { first: 0.9, second: 0.1, none: 0 }, 1: { first: 0.9, second: 0.1, none: 0 } }, recordedAt: "2026-10-07T09:00:00Z" }));
  writeFileSync(join(dir, "jev.ndjson"), JSON.stringify({ body: wireBody(req(), "synthetic") }) + "\n");
  process.argv = [argv[0]!, "decisions-frozen.ts", "--set", "B24", "--out", dir, "--max-usd", "0.05"];
  fake.ask.mockImplementation(async (asked: ReturnType<typeof req>) => ({ model: "gpt-6-luna", answers: Object.fromEntries(Object.keys(asked.questions).map((id) => [id, { choice: "first", confidence: 0.9 }])), probabilities: Object.fromEntries(Object.keys(asked.questions).map((id) => [id, { first: 0.9, second: 0.1, none: 0 }])), costUsd: 0, latencyMs: 0, inputTokens: 0 }));
});
afterEach(() => { process.argv = argv; process.exitCode = exitCode; rmSync(dir, { recursive: true, force: true }); });
it("refuses to send a canonical cache entry without its original wire", async () => {
  await expect(import("../scripts/decisions-frozen.ts")).rejects.toThrow(/original.*wire|jev-requests/);
  expect(fake.ask).not.toHaveBeenCalled();
  expect(fake.config).not.toHaveBeenCalled();
});
it("preserves original question and option order from the request log", async () => {
  process.argv.push("--jev-requests", join(dir, "jev.ndjson"));
  await import("../scripts/decisions-frozen.ts");
  const sent = fake.ask.mock.calls[0]![0];
  expect(Object.keys(sent.questions)).toEqual(["z", "a"]);
  expect(Object.keys(sent.questions.z.criteria)).toEqual(["second", "first", "none"]);
});
it("excludes alternate Jev models from the frozen baseline", async () => {
  const path = join(fake.cache, "aa", "entry.json");
  const entry = JSON.parse(readFileSync(path, "utf8"));
  entry.model = "synthetic-alternate-jev";
  writeFileSync(path, JSON.stringify(entry));
  process.argv.push("--jev-requests", join(dir, "jev.ndjson"));
  await import("../scripts/decisions-frozen.ts");
  expect(fake.ask).not.toHaveBeenCalled();
  expect(readFileSync(join(dir, "scored.ndjson"), "utf8")).toBe("");
});
it("rejects a missing original request before opening the engine", async () => {
  writeFileSync(join(dir, "jev.ndjson"), "");
  process.argv.push("--jev-requests", join(dir, "jev.ndjson"));
  await expect(import("../scripts/decisions-frozen.ts")).rejects.toThrow("no original Jev wire");
  expect(fake.config).not.toHaveBeenCalled();
});
it("rejects ambiguous original orders rather than choosing one", async () => {
  const wire = wireBody(req(), "synthetic");
  const reversed = { ...wire, questions: Object.fromEntries(Object.entries(wire.questions).reverse()) };
  writeFileSync(join(dir, "jev.ndjson"), [wire, reversed].map((body) => JSON.stringify({ body })).join("\n"));
  process.argv.push("--jev-requests", join(dir, "jev.ndjson"));
  await expect(import("../scripts/decisions-frozen.ts")).rejects.toThrow("ambiguous original Jev wire order");
  expect(fake.config).not.toHaveBeenCalled();
});
it("rewrites scored output on rerun rather than duplicating request samples", async () => {
  process.argv.push("--jev-requests", join(dir, "jev.ndjson"));
  await import("../scripts/decisions-frozen.ts");
  vi.resetModules();
  await import("../scripts/decisions-frozen.ts");
  expect(readFileSync(join(dir, "scored.ndjson"), "utf8").trim().split("\n")).toHaveLength(1);
});
