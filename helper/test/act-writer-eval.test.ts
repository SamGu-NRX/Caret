// Run the real CLI with a transport installed before its imports. An unexpected URL fails, never reaches the network.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run(models: string, budget: string) {
  const dir = mkdtempSync(join(tmpdir(), "caret-act-writer-eval-"));
  dirs.push(dir);
  const hook = join(dir, "fake-fetch.mjs");
  const calls = join(dir, "calls.ndjson");
  writeFileSync(hook, `import { appendFileSync } from "node:fs";
    globalThis.fetch = async (url, init) => {
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ url: String(url), body: init?.body }) + "\\n");
      if (String(url) === "https://api.openai.com/v1/models") return new Response(JSON.stringify({ data: [{ id: "gpt-6-luna" }] }));
      if (String(url) !== "https://api.openai.com/v1/responses") throw new Error("unexpected URL: " + url);
      return new Response(JSON.stringify({ model: "gpt-6-luna", output: [{ type: "message", content: [{ type: "output_text", text: "async function main(caret) {}" }] }], usage: { input_tokens: 1000, output_tokens: 1000, output_tokens_details: { reasoning_tokens: 200 } } }));
    };`);
  const out = join(dir, "out");
  const result = spawnSync(process.execPath, ["--import", hook, "scripts/writer-eval.ts", "--out", out, "--models", models, "--budget", budget, "--gap", "0"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { TMPDIR: tmpdir(), PATH: process.env.PATH, OPENAI_API_KEY_PERSONAL: "sk-eval-fixture", CARET_WRITER_SPEND_DIR: join(dir, "spend") },
    encoding: "utf8", timeout: 30_000,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const fetched = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { url: string; body?: string });
  const report = JSON.parse(readFileSync(join(out, "writer-eval.json"), "utf8")) as { spent: number; rows: { model: string; n: number; valid: number; correct: number; p50Ms: number; p95Ms: number; meanIn: number; meanOut: number; meanCostUsd: number }[] };
  return { fetched, report, table: readFileSync(join(out, "writer-eval.md"), "utf8") };
}

describe("writer eval's fixture-only OpenAI routes", () => {
  it("runs both efforts without a gateway probe and keeps distinct report rows", () => {
    const { fetched, report, table } = run("openai:gpt-6-luna,openai:gpt-6-luna@none", "0.02");
    expect(fetched.some((call) => call.url.includes("vercel"))).toBe(false);
    const writes = fetched.filter((call) => call.url.endsWith("/responses"));
    expect(writes).toHaveLength(20);
    expect(JSON.parse(writes[0]!.body!).reasoning).toEqual({ effort: "low" });
    expect(JSON.parse(writes[10]!.body!).reasoning).toEqual({ effort: "none" });
    expect(report.rows.map((row) => [row.model, row.n])).toEqual([["gpt-6-luna@low", 10], ["gpt-6-luna@none", 10]]);
    expect(table).toContain("valid | correct | p50 ms | p95 ms | mean in tok | mean out tok (reasoning) | mean $/plan");
    expect(report.spent).toBeCloseTo(0.012, 12);
  });

  it("stops before sending when the request estimate exceeds the shared run budget", () => {
    const { fetched, report } = run("openai:gpt-6-luna,openai:gpt-6-luna@none", "0.0001");
    expect(fetched.filter((call) => call.url.endsWith("/responses"))).toEqual([]);
    expect(report.spent).toBe(0);
    expect(report.rows.map((row) => row.n)).toEqual([0, 0]);
  });
});
