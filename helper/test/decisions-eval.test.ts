import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionsAsk, decisionsBody, RequestBudget } from "../scripts/decisions-eval.ts";
import { minted } from "./minted.ts";
import type { JevRequest } from "../src/fill/jev.ts";

const request = (): JevRequest => minted({
  purpose: "probe.latency",
  state: { task: "Synthetic task" },
  questions: {
    whose: { type: "choice", instructions: "Whose value?", criteria: { user: "The user", other: "Another person" } },
    section: { type: "choice", instructions: "Which section?", criteria: { all: null, none: "No section" } },
  },
  nouls: { scope: { type: "noul", instructions: "Does the instruction ask for this field?" } },
  snippets: [], charged: {},
});
const answer = () => ({ model: "gpt-6-luna", answers: [
  { type: "choice", name: "whose", choice: "user", confidence: 0.9, probabilities: { user: 0.95, other: 0.05 } },
  { type: "choice", name: "section", choice: "all", confidence: 0.8, probabilities: { all: 0.9, none: 0.1 } },
  { type: "predicate", name: "scope", probability: 0.99 },
], usage: { input_tokens: 100 } });
const fixture = { windows: () => true, memory: true, plan: true };
const mockFetch = () => vi.fn<typeof fetch>(async () => Response.json(answer()));
const client = (fetchImpl: typeof fetch, spendLimit = 0.20) => decisionsAsk({ fetchImpl, fixture, env: { OPENAI_API_KEY: "test-only" }, budget: new RequestBudget(spendLimit) });

describe("eval-only Decisions adapter", () => {
  it("preserves every choice and maps yes/no to a predicate in question order", () => {
    expect(decisionsBody(request())).toEqual({ model: "gpt-6-luna", input: '{"task":"Synthetic task"}', questions: [
      { type: "choice", name: "whose", instructions: "Whose value?", choices: [{ value: "user", description: "The user" }, { value: "other", description: "Another person" }] },
      { type: "choice", name: "section", instructions: "Which section?", choices: [{ value: "all" }, { value: "none", description: "No section" }] },
      { type: "predicate", name: "scope", instructions: "Does the instruction ask for this field?" },
    ] });
  });
  it.each(["ask.scope", "ask.heads", "fill.whose", "fill.values"] as const)("maps %s without renaming or adding options", (purpose) => {
    const req = { ...request(), purpose };
    const body = decisionsBody(req);
    for (const q of body.questions) {
      if (q.type === "choice") expect(q.choices.map((c) => c.value)).toEqual(Object.keys(req.questions[q.name]!.criteria));
      else expect(q.instructions).toBe(req.nouls![q.name]!.instructions);
    }
  });
  it("logs the sent sealed body, raw answers, cost and latency without the key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-decisions-test-"));
    try {
      const logRequests = join(dir, "requests.ndjson");
      const fetchImpl = mockFetch();
      await decisionsAsk({ fetchImpl, fixture, env: { OPENAI_API_KEY: "test-only" }, budget: new RequestBudget(1), logRequests })(request());
      const text = readFileSync(logRequests, "utf8");
      const log = JSON.parse(text);
      expect(log.body).toEqual(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)));
      expect(log.response).toEqual(answer());
      expect(log.latencyMs).toBeGreaterThanOrEqual(0);
      expect(log.costUsd).toBe(0.00001);
      expect(text).not.toContain("test-only");
    } finally { rmSync(dir, { recursive: true }); }
  });
  it("returns Jev-shaped categorical answers and probabilities", async () => {
    const result = await client(mockFetch())(request());
    expect(result.answers.whose).toEqual({ choice: "user", confidence: 0.9 });
    expect(result.nouls).toEqual({ scope: 0.99 });
    expect(result.costUsd).toBe(0.00001);
  });
  it.each(["refusal", "unoffered", "probabilities", "order", "missing", "predicate"])("fails closed on %s", async (kind) => {
    const body = answer();
    if (kind === "unoffered") body.answers[0]!.choice = "stranger";
    if (kind === "probabilities") Object.assign(body.answers[0]!, { probabilities: { stranger: 1 } });
    if (kind === "order") body.answers.reverse();
    if (kind === "missing") body.answers.pop();
    if (kind === "predicate") body.answers[2]!.probability = 2;
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(kind === "refusal" ? { ...body, answers: [{ type: "refusal", name: "whose" }, ...body.answers.slice(1)] } : body));
    await expect(client(fetchImpl)(request())).rejects.toThrow(/Decisions answer|Decisions response/);
  });
  it("reserves before fetch and keeps the reservation after a failed request", async () => {
    const body = JSON.stringify(decisionsBody(request()));
    const budget = new RequestBudget(1);
    const cost = budget.estimate(body, 0.10 / 1_000_000);
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("offline"); });
    const ask = decisionsAsk({ fetchImpl, fixture, env: { OPENAI_API_KEY: "test-only" }, budget: new RequestBudget(cost) });
    await expect(ask(request())).rejects.toThrow("offline");
    await expect(ask(request())).rejects.toThrow(/spend limit/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const blocked = mockFetch();
    await expect(client(blocked, 0)(request())).rejects.toThrow(/spend limit/);
    expect(blocked).not.toHaveBeenCalled();
  });
  it("rejects invalid limits and accounts for UTF-8 and the long-input rate", () => {
    for (const limit of [-1, NaN, Infinity]) expect(() => new RequestBudget(limit)).toThrow();
    const budget = new RequestBudget(1);
    expect(budget.estimate("é", 1)).toBeGreaterThan(budget.estimate("e", 1));
    expect(budget.estimate("x".repeat(272_001), 1)).toBeGreaterThan(544_002);
  });
  it("sends the frozen sealed body, not later mutations", async () => {
    const req = request();
    const expected = JSON.stringify(decisionsBody(req));
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      req.state = req.disclosure.own("changed");
      expect(init?.body).toBe(expected);
      return Response.json(answer());
    });
    await client(fetchImpl)(req);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/decisions");
  });
  it("rejects unsealed text and shipped-app use before fetch", async () => {
    const fetchImpl = mockFetch();
    const req = request();
    Object.assign(req, { state: { task: "unminted text" } });
    await expect(client(fetchImpl)(req)).rejects.toThrow(/minted/);
    const ask = decisionsAsk({ fetchImpl, fixture, budget: new RequestBudget(1), env: { CARET_LAUNCHD_AGENT: "1", OPENAI_API_KEY: "test-only" } });
    await expect(ask(request())).rejects.toThrow(/shipped app/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
