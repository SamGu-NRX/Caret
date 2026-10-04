// WriterPort, prompt and transport, with a fake fetch. The live measurement is scripts/writer-eval.ts.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { runCodePlan } from "../../src/codemode/sandbox.ts";
import { PlanningSnapshotSchema } from "../../src/codemode/types.ts";
import { listModels } from "../../src/writer/chat.ts";
import { CANDIDATES, GATEWAY_GPT_OSS_120B, GROQ_GPT_OSS_120B, GROQ_QWEN_3_8_27B, WRITER_ROUTE } from "../../src/writer/config.ts";
import { extractProgram, PLAN_API, planUserMessage } from "../../src/writer/plan-prompt.ts";
import { makeWriterPort } from "../../src/writer/port.ts";
import { CANNED_PROGRAM, FORM, MAIL } from "./fixtures.ts";
import { WRITER_CORPUS } from "./writer-corpus.ts";

const KEY = "sk-test-not-a-real-key";

function fakeFetch(status: number, body: unknown, seen: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const completion = (content: string, model = "openai/gpt-oss-120b") => ({
  model,
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 2000, completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 120 } },
});

const request = (input: unknown = { goal: "Sign me up", snapshots: [FORM, MAIL] }) => ({ kind: "plan" as const, disclosureId: "disc-1", input, maxOutputTokens: 1500, signal: new AbortController().signal });

describe("plan prompt", () => {
  test("the API the writer reads names exactly the functions the sandbox exposes", () => {
    const worker = readFileSync(new URL("../../src/codemode/worker.ts", import.meta.url), "utf8");
    const exposed = [...worker.matchAll(/api\("(\w+)"/g)].map((m) => m[1]).sort();
    const documented = [...PLAN_API.matchAll(/^\s+(\w+)\(/gm)].map((m) => m[1]).sort();
    expect(documented).toEqual(exposed);
  });

  test("the inventory carries labels and refs, not value origins", () => {
    const msg = planUserMessage({ goal: "Sign me up", snapshots: [FORM, MAIL] });
    expect(msg).toContain('"ref": "t:name"');
    expect(msg).toContain("Alex Rivera");
    expect(msg).not.toContain("startUTF16");
    expect(msg).not.toContain("digest");
  });

  test("a window over the per-window budget is refused, not truncated", () => {
    const big = { ...MAIL, values: Array.from({ length: 4 }, (_, i) => ({ ref: `v:big${i}`, display: "z".repeat(390), origin: MAIL.values[0]!.origin })) };
    expect(() => planUserMessage({ goal: "x", snapshots: [FORM, big] })).toThrow(/per-window budget is 1200/);
  });

  test("extractProgram takes the fenced function and refuses anything else", () => {
    expect(extractProgram("Here:\n```ts\nasync function main(caret) { return 1; }\n```\nDone")).toBe("async function main(caret) { return 1; }");
    expect(extractProgram("async function main(caret) {}")).toBe("async function main(caret) {}");
    expect(extractProgram("```ts\nconst x = 1;\n```")).toBeNull();
    expect(extractProgram("I can't help with that.")).toBeNull();
  });

  test("every corpus case has valid snapshots within the writer budget", () => {
    expect(WRITER_CORPUS).toHaveLength(10);
    for (const c of WRITER_CORPUS) {
      for (const s of c.snapshots) PlanningSnapshotSchema.parse(s);
      expect(() => planUserMessage({ goal: c.goal, snapshots: c.snapshots })).not.toThrow();
    }
  });
});

describe("WriterPort", () => {
  test("a canned writer reply becomes a valid plan through the sandbox", async () => {
    const port = makeWriterPort(GROQ_GPT_OSS_120B, { key: () => KEY, fetchFn: fakeFetch(200, completion("```ts\n" + CANNED_PROGRAM + "```")) });
    const w = await port.write(request());
    expect(w.output.program).not.toBeNull();
    const o = await runCodePlan(w.output.program!, [FORM, MAIL], async () => "o:tue");
    if (!o.ok) throw new Error(`${o.kind}: ${o.detail}`);
    expect(o.plan.steps.map((s) => s.kind)).toEqual(["fill", "fill", "fill", "press", "waitFor"]);
  });

  test("sends the route's model, output cap and reasoning fields, and prices the reply", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const port = makeWriterPort(GROQ_GPT_OSS_120B, { key: () => KEY, fetchFn: fakeFetch(200, completion("```ts\nasync function main(caret) {}\n```"), seen) });
    const w = await port.write(request());
    expect(seen[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const body = JSON.parse(String(seen[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "openai/gpt-oss-120b", max_completion_tokens: 1500, reasoning_effort: "low", include_reasoning: false, temperature: 0 });
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(w).toMatchObject({ model: "openai/gpt-oss-120b", provider: "groq", inputTokens: 2000, outputTokens: 500, reasoningTokens: 120 });
    expect(w.costUsd).toBeCloseTo((2000 * 0.15 + 500 * 0.6) / 1e6, 12);
  });

  test("a provider error names its status and type and never echoes the key", async () => {
    const body = { error: { message: `AI Gateway requires a valid credit card on file. key=${KEY}`, type: "customer_verification_required" } };
    const port = makeWriterPort(GATEWAY_GPT_OSS_120B, { key: () => KEY, fetchFn: fakeFetch(403, body) });
    const err = await port.write(request()).catch((e: Error) => e);
    expect(String(err)).toContain("gateway HTTP 403 customer_verification_required");
    expect(String(err)).not.toContain(KEY);
  });

  test("other kinds, a missing disclosure and malformed input are refused before any request", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const port = makeWriterPort(GROQ_GPT_OSS_120B, { key: () => KEY, fetchFn: fakeFetch(200, completion(""), seen) });
    await expect(port.write({ ...request(), kind: "polish" })).rejects.toThrow("not implemented");
    await expect(port.write({ ...request(), disclosureId: "" })).rejects.toThrow("disclosureId");
    await expect(port.write(request({ goal: "x", snapshots: [] }))).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  test("listModels reads the provider's model ids", async () => {
    const ids = await listModels(GROQ_QWEN_3_8_27B, KEY, fakeFetch(200, { data: [{ id: "openai/gpt-oss-120b" }, { id: "qwen/qwen3.8-27b" }] }));
    expect(ids).toEqual(["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
  });

  test("the configured writer is one of the measured candidates", () => {
    expect(CANDIDATES).toContain(WRITER_ROUTE);
  });
});
