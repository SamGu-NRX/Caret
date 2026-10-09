import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV } from "../src/host-env.ts";
import { DailySpend } from "../src/engines/decide/daily-cap.ts";
import { Disclosure, UnmintedText, registryOf } from "../src/privacy/disclosure.ts";
import { chatSink } from "../src/writer/chat.ts";
import { seal, sendable } from "../src/privacy/send.ts";
import { makeWriterPort, WriterProviderRefused, WriterUnavailable, writerEstimateUsd } from "../src/writer/port.ts";
import { devWriterRoute } from "../src/writer/routes.ts";
import { WRITER_DAILY_CAP_USD, WRITER_ROUTE } from "../src/writer/config.ts";
import { PLAN_SYSTEM, PLAN_WORDING, PlanInputSchema, planUserMessage } from "../src/writer/plan-prompt.ts";
import { GOAL_SYSTEM } from "../src/writer/goal-prompt.ts";
import { planWithCode } from "../src/planner/codeplan.ts";
import { SaidError, SAYS } from "../src/planner/says.ts";
import { planGoal } from "../src/goals/propose.ts";
import { GoalError } from "../src/goals/lower.ts";
import { macClock } from "../src/offers/event-time.ts";
import { ScreenModel } from "../src/model.ts";
import { field, snap } from "./builders.ts";
import { FORM } from "./codemode/fixtures.ts";
import { minted } from "./minted.ts";

const dirs: string[] = [];
const spend = (capUsd = WRITER_DAILY_CAP_USD, now?: () => Date) => {
  const dir = mkdtempSync(join(tmpdir(), "caret-act-writer-"));
  dirs.push(dir);
  return new DailySpend({ dir, capUsd, now });
};
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const route = devWriterRoute("openai:gpt-6-luna");
const KEY = "sk-fixture-personal-not-real";
const request = (kind: "plan" | "goal" = "plan") => {
  const req = minted({ kind: "plan" as const, disclosureId: "act-writer", input: { goal: "Sign me up", snapshots: [kind === "goal" ? { ...FORM, questions: [] } : FORM] }, maxOutputTokens: 1000, signal: new AbortController().signal });
  req.disclosure.instruction("Sign me up");
  return req.disclosure.seal({ ...req, kind });
};
const response = {
  model: "gpt-6-luna-served",
  output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "Not a program" }] },
    { type: "message", content: [{ type: "output_text", text: "async function " }, { type: "refusal", refusal: "Not text" }] },
    { type: "message", content: [{ type: "output_text", text: "main(caret) {}" }] },
  ],
  usage: { input_tokens: 2000, output_tokens: 500, output_tokens_details: { reasoning_tokens: 120 } },
};
const fake = (seen: { url: string; init: RequestInit }[], body: unknown = response, status = 200): typeof fetch => async (url, init) => {
  seen.push({ url: String(url), init: init ?? {} });
  return new Response(JSON.stringify(body), { status });
};

describe("OpenAI Responses writer", () => {
  it("names exactly the two routes, leaves the default off, and records the supplied price", () => {
    expect(WRITER_ROUTE).toBeNull();
    expect(WRITER_DAILY_CAP_USD).toBe(0.25);
    expect(route).toMatchObject({ provider: "openai", model: "gpt-6-luna", keyName: ENV.openai_api_key_personal, extraBody: { reasoning: { effort: "low" } }, pricing: { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 } });
    expect(devWriterRoute("openai:gpt-6-luna@none")).toMatchObject({ model: "gpt-6-luna", extraBody: { reasoning: { effort: "none" } } });
    for (const spec of ["openai:gpt-6-luna@high", "openai:unknown", "other:gpt-6-luna"]) expect(() => devWriterRoute(spec)).toThrow("is not a route");
  });

  it("posts only the sealed Responses body, reads the key at call time, parses message text, and bills reasoning once", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ledger = spend();
    const port = makeWriterPort(route, { evaluation: true, fetchFn: fake(seen), spend: ledger });
    vi.stubEnv(ENV.openai_api_key_personal, KEY);
    const req = request();
    const sealed = seal({ writer: req }, chatSink(route, (wire) => [{ role: "system", content: PLAN_SYSTEM }, { role: "user", content: planUserMessage(PlanInputSchema.parse(wire)) }], [PLAN_SYSTEM, ...PLAN_WORDING], 1000));
    const result = await port.write(req);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(seen[0]!.init.body).toBe(sendable(sealed));
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ model: "gpt-6-luna", instructions: PLAN_SYSTEM, input: planUserMessage(PlanInputSchema.parse(req.input)), max_output_tokens: 1000, reasoning: { effort: "low" } });
    expect(String(seen[0]!.init.body)).not.toContain(KEY);
    expect(seen[0]!.init.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    expect(result).toMatchObject({ model: "gpt-6-luna-served", provider: "openai", output: { program: "async function main(caret) {}" }, inputTokens: 2000, outputTokens: 500, reasoningTokens: 120 });
    expect(result.costUsd).toBeCloseTo(0.00045, 12);
    expect(ledger.spent()).toBeCloseTo(result.costUsd, 12);
    Object.defineProperty(process.env, ENV.openai_api_key_personal, { value: "sk-changed-fixture", writable: true, enumerable: true, configurable: true });
    await port.write(request("goal"));
    expect(seen[1]!.init.headers).toMatchObject({ Authorization: "Bearer sk-changed-fixture" });
    expect(JSON.parse(String(seen[1]!.init.body)).instructions).toBe(GOAL_SYSTEM);
  });

  it("refuses retained-provider non-fixtures and unminted input before key access or fetch", async () => {
    const key = vi.fn(() => KEY);
    const fetchFn = vi.fn(fake([]));
    await expect(makeWriterPort(route, { key, fetchFn, spend: spend() }).write(request())).rejects.toBeInstanceOf(WriterProviderRefused);
    await expect(makeWriterPort(route, { evaluation: true, key, fetchFn, spend: spend() }).write({ ...request(), input: { goal: "raw" as never, snapshots: [] }, disclosure: new Disclosure(registryOf([])) })).rejects.toBeInstanceOf(UnmintedText);
    expect(key).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("redacts an echoed key from error text and never retries", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const port = makeWriterPort(route, { evaluation: true, key: () => KEY, fetchFn: fake(seen, { error: { type: `rate_${KEY}`, message: `secret=${KEY}` } }, 429), spend: spend() });
    const error = await port.write(request()).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 429 });
    expect(String(error)).not.toContain(KEY);
    expect(seen).toHaveLength(1);
  });
});

describe("writer's local-day cap", () => {
  it.each([0.25, 0.26])("refuses with budget before fetch when $%s has landed, even on a free route", async (landed) => {
    const ledger = spend();
    ledger.reserve(0).settle(landed, 1);
    const fetchFn = vi.fn(fake([]));
    const freeRoute = { ...route, pricing: { ...route.pricing, inputUsdPerMTok: 0, outputUsdPerMTok: 0 } };
    const port = makeWriterPort(freeRoute, { evaluation: true, key: () => KEY, fetchFn, spend: ledger });
    await expect(port.write(request())).rejects.toMatchObject({ name: "WriterUnavailable", reason: "budget" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reserves the byte-count input estimate and full output cap before sending; a call that may have been billed keeps it", async () => {
    const ledger = spend(0.0001);
    const fetchFn = vi.fn(fake([]));
    await expect(makeWriterPort(route, { evaluation: true, key: () => KEY, fetchFn, spend: ledger }).write(request())).rejects.toBeInstanceOf(WriterUnavailable);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(writerEstimateUsd(route, "é", 1000)).toBeCloseTo((2 * 0.1 + 1000 * 0.5) / 1e6, 12);
    const bigger = spend();
    const failed = makeWriterPort(route, { evaluation: true, key: () => KEY, fetchFn: async () => { throw new Error("offline"); }, spend: bigger });
    await expect(failed.write(request())).rejects.toThrow("offline");
    // A network failure may have reached the provider: it counts at its reservation.
    expect(bigger.spent()).toBeGreaterThan(0);
    // A provider's 4xx refusal is known unbilled: its reservation is released.
    const refusedLedger = spend();
    const refused = makeWriterPort(route, { evaluation: true, key: () => KEY, fetchFn: async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "bad" } }), { status: 400 }), spend: refusedLedger });
    await expect(refused.write(request())).rejects.toThrow(/HTTP 400/);
    expect(refusedLedger.spent()).toBe(0);
  });

  it("shares landed spend across ports and resets on the next local day", async () => {
    let now = new Date(2026, 9, 9, 12);
    const ledger = spend(0.25, () => now);
    ledger.reserve(0).settle(0.25, 1);
    const seen: { url: string; init: RequestInit }[] = [];
    const other = new DailySpend({ dir: ledger.dir, capUsd: 0.25, now: () => now });
    const port = makeWriterPort(route, { evaluation: true, key: () => KEY, fetchFn: fake(seen), spend: other });
    await expect(port.write(request())).rejects.toBeInstanceOf(WriterUnavailable);
    now = new Date(2026, 9, 10, 12);
    await port.write(request());
    expect(seen).toHaveLength(1);
  });

  it("carries the exact budget sentence through codeplan and the goal error", async () => {
    const model = new ScreenModel();
    model.apply(snap([field("name", "", { label: "Name" })], { at: 1000, windowId: "form", title: "Apply" }));
    model.apply(snap([field("note", "Name: Robin Vale", { role: "AXTextArea" })], { at: 900, windowId: "note", title: "My details", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" } }));
    const writer = { route, write: async () => { throw new WriterUnavailable("budget"); } };
    const error = await planWithCode("fill my name", model, { values: () => [] }, { writer, askJev: async () => ({ model: "fixture", answers: {}, inputTokens: 0, latencyMs: 0, costUsd: 0 }), offerKey: "budget", windowId: "form", now: 2000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SaidError);
    expect(error).toMatchObject({ code: "unavailable", message: "Caret's planner is out of budget for today." });
    const goalError = await planGoal(model, { goalId: "budget-goal", instruction: "fill my name", writer, askJev: null, windows: ["form"], memory: [], calendar: null, clock: macClock(new Date(2000)), now: 2000, readerSession: 0 }).catch((e: unknown) => e);
    expect(goalError).toBeInstanceOf(GoalError);
    expect(goalError).toMatchObject({ says: SAYS.writerBudget });
  });
});
