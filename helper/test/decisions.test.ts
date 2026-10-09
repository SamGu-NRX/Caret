import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minted } from "./minted.ts";
import { decisionsBody, loadDecisionsKey, makeDecisionsClient, DECISIONS_MODEL, DECISIONS_URL, DecisionsAttemptError, DecisionsHttpError } from "../src/engines/decide/decisions.ts";
import { DecisionsSpend, DECISIONS_USD_PER_TOKEN, DecisionsBudgetError } from "../src/engines/decide/decisions-spend.ts";
import { wireBody, type JevRequest } from "../src/fill/jev.ts";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { cachedAsk } from "../src/engines/decide/cache.ts";
import { assertNoExcludedValue } from "../src/privacy.ts";
import { withholdValues } from "../src/privacy/exclude.ts";
import { engineName } from "../src/engines/decide/port.ts";
import { attributedJev, httpStatus } from "../scripts/attributed-jev.ts";

interface RecordedResponse {
  model: string;
  answers: { type: string; name: string; choice?: string | boolean; confidence?: number; probability?: number; probabilities?: { value: string; probability: number }[] }[];
  usage: { input_tokens: number };
}

const dirs: string[] = [];
const spends: DecisionsSpend[] = [];
const folder = (): string => { const dir = mkdtempSync(join(tmpdir(), "caret-decisions-")); dirs.push(dir); return dir; };
const spend = (dir = folder(), options: { totalCapUsd?: number; providerCapUsd?: number; probeCapUsd?: number } = {}): DecisionsSpend => {
  const s = new DecisionsSpend({ dir, ...options }); spends.push(s); return s;
};
const fixture = { windows: (id: string) => id === "fixture", memory: true, plan: true };
const key = "sk-proj-synthetic-only-not-a-real-key";
const request = (): JevRequest => minted({
  state: { note: "Synthetic square is blue." },
  questions: { f1: { type: "choice", instructions: "Which synthetic value fits?", criteria: { a: "Blue", none: null } } },
  nouls: { verify: { type: "noul", instructions: "Is the square blue?", criteria: { true: "It is blue.", false: "It is not blue." } } },
  snippets: [], charged: {},
});
const recorded = (file = "choice-predicate.json"): string => readFileSync(new URL(`../fixtures/recorded/decisions/${file}`, import.meta.url), "utf8");
const response = (body = recorded(), status = 200, headers: Record<string, string> = {}): typeof fetch => vi.fn(async () => new Response(body, { status, headers }));
const client = (fetchFn = response(), s = spend()) => makeDecisionsClient({ fixture, env: { OPENAI_API_KEY: key }, fetchFn, spend: s });

afterEach(() => {
  for (const s of spends.splice(0)) s.close();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Decisions adapter, recorded official-schema responses, no network", () => {
  it("maps choices and predicates faithfully, retaining raw confidence and all probabilities", async () => {
    const fetchFn = response();
    const req = request();
    const r = await client(fetchFn)(req);
    expect(r.answers).toEqual({ f1: { choice: "a", confidence: 0.81 } });
    expect(r.nouls).toEqual({ verify: 0.93 });
    expect(r.probabilities).toEqual({ f1: { a: 0.72, none: 0.28 } });
    expect(r.inputTokens).toBe(42);
    expect(r.costUsd).toBe(42 * DECISIONS_USD_PER_TOKEN);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
    expect(url).toBe(DECISIONS_URL);
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${key}` });
    const sent = JSON.parse(init?.body as string);
    expect(sent).toEqual({ model: DECISIONS_MODEL, input: JSON.stringify(req.state), questions: [
      { type: "choice", name: "f1", instructions: req.questions.f1!.instructions, choices: [{ value: "a", description: "Blue" }, { value: "none" }] },
      { type: "predicate", name: "verify", instructions: "Is the square blue?\nTrue: It is blue.\nFalse: It is not blue." },
    ] });
    expect(init?.body).not.toContain(key);
  });
  it("maps a predicate without true/false descriptions without adding semantics", () => {
    const wire = wireBody(minted({ state: "Synthetic", questions: {}, nouls: { p: { type: "noul", instructions: "True?" } }, snippets: [], charged: {} }));
    expect(decisionsBody(wire).questions).toEqual([{ type: "predicate", name: "p", instructions: "True?" }]);
  });
  it("accounts billed usage even when a recorded answer refuses", async () => {
    const dir = folder();
    await expect(client(response(recorded("refusal.json")), spend(dir))(request())).rejects.toThrow(/refused/);
    const rows = readFileSync(join(dir, "comparison.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => r.type)).toEqual(["reserve", "settle"]);
    expect(rows.every((r) => r.provider === "openai-decisions")).toBe(true);
    expect(rows[1].usd).toBe(42 * DECISIONS_USD_PER_TOKEN);
  });
  it.each([
    ["out-of-set choice", (j: RecordedResponse) => { j.answers[0]!.choice = "invented"; }, /out-of-set/],
    ["out-of-set probability", (j: RecordedResponse) => { j.answers[0]!.probabilities![0]!.value = "invented"; }, /out-of-set/],
    ["duplicate probability", (j: RecordedResponse) => { j.answers[0]!.probabilities![1]!.value = "a"; }, /duplicate/],
    ["missing probability", (j: RecordedResponse) => { j.answers[0]!.probabilities!.pop(); }, /omit/],
    ["wrong order", (j: RecordedResponse) => { j.answers.reverse(); }, /order/],
    ["missing answer", (j: RecordedResponse) => { j.answers.pop(); }, /count/],
    ["wrong type", (j: RecordedResponse) => { j.answers[0] = { type: "predicate", name: "f1", probability: 0.9 }; }, /type/],
    ["boolean choice", (j: RecordedResponse) => { j.answers[0]!.choice = true; }, /schema/],
    ["invalid confidence", (j: RecordedResponse) => { j.answers[0]!.confidence = 2; }, /schema/],
    ["invalid usage", (j: RecordedResponse) => { j.usage.input_tokens = -1; }, /schema/],
    ["wrong model", (j: RecordedResponse) => { j.model = "another-model"; }, /schema/],
  ])("fails closed on %s", async (_label, mutate, error) => {
    const json: RecordedResponse = JSON.parse(recorded()); mutate(json);
    await expect(client(response(JSON.stringify(json)))(request())).rejects.toThrow(error);
  });
  it("retains the worst-case hold after malformed JSON or a network error", async () => {
    const dir = folder(); const s = spend(dir);
    await expect(client(response("not json"), s)(request())).rejects.toThrow(/malformed JSON/);
    const transport = vi.fn(async () => { throw new Error(`echo ${key}`); }) as typeof fetch;
    await expect(client(transport, s)(request())).rejects.toThrow(/network request failed/);
    const rows = readFileSync(join(dir, "comparison.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === "reserve" && r.usd === 0.02)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(key);
  });
  it.each([429, 500, 401, 403])("fails closed on HTTP %s and never retries", async (status) => {
    const fetchFn = response(JSON.stringify({ error: { message: key } }), status, { "retry-after": "2" });
    const error = await client(fetchFn)(request()).catch((e) => e);
    expect(error).toBeInstanceOf(DecisionsAttemptError);
    expect(error.status).toBe(status);
    expect(error.retryAfterMs).toBe(2000);
    expect(String(error)).not.toContain(key);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("marks a Decisions 503 unavailable rather than scoring it as a model refusal", async () => {
    const error = new DecisionsAttemptError(new DecisionsHttpError(503, null), { latencyMs: 1, costUsd: null, inputTokens: null, refused: false }, key);
    expect(httpStatus(new Error("wrapper", { cause: error }))).toBe(503);
    const tracked = attributedJev(async () => { throw error; }, () => "fixture-ask", () => {});
    await expect(tracked.ask(request())).rejects.toThrow(/503/);
    expect(await tracked.notRun("fixture-ask")).toBe(true);
  });
  it("rejects too few or too many choices before sending", async () => {
    for (const n of [1, 256]) {
      const req = minted({ state: "Synthetic", questions: { f: { type: "choice", instructions: "Choose.", criteria: { a: null } } }, snippets: [], charged: {} });
      const criteria = Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, null]));
      expect(() => decisionsBody({ ...wireBody(req), questions: { f: { ...req.questions.f!, criteria } } })).toThrow(/between 2 and 255/);
      if (n === 1) {
        const fetchFn = response();
        await expect(client(fetchFn)(req)).rejects.toThrow(/between 2 and 255/);
        expect(fetchFn).not.toHaveBeenCalled();
      }
    }
  });
  it("rejects estimated input above the chosen ceiling before sending", async () => {
    const req = minted({ state: Array.from({ length: 65 }, () => "x".repeat(3500)), questions: { f1: { type: "choice", instructions: "Choose.", criteria: { a: null, none: null } } }, snippets: [], charged: {} });
    const fetchFn = response();
    await expect(client(fetchFn)(req)).rejects.toThrow(/200K/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it.each(["CARET_INTERNAL_BUILD", "CARET_LAUNCHD_AGENT", "CARET_OPENED_BY_LAUNCHSERVICES", "CARET_RELEASE_HOST"])("refuses %s even with cache disabled", (marker) => {
    expect(() => makeDecisionsClient({ fixture, env: { [marker]: "1", OPENAI_API_KEY: key }, fetchFn: response() })).toThrow(/app|shipped/);
  });
  it("refuses an internal build marker even when its value is empty", () => {
    expect(() => makeDecisionsClient({ fixture, env: { CARET_INTERNAL_BUILD: "", OPENAI_API_KEY: key }, fetchFn: response() })).toThrow(/internal app/);
  });
  it("checks the live process markers too, including cached answers", async () => {
    const dir = folder();
    const engine = harnessEngine({ name: "decisions", canned: null, fixture, env: { CARET_JEV_CACHE: dir, CARET_JEV_CACHE_MODE: "replay" } });
    vi.stubEnv("CARET_INTERNAL_BUILD", "1");
    await expect(engine.ask(request())).rejects.toThrow(/internal app/);
  });
  it("rejects a cached choice offered only by a different question", async () => {
    const dir = folder();
    const req = minted({ state: "Synthetic", questions: {
      f1: { type: "choice", instructions: "First?", criteria: { a: "Blue", none: null } },
      f2: { type: "choice", instructions: "Second?", criteria: { b: "Red", none: null } },
    }, snippets: [], charged: {} });
    const record = cachedAsk(async () => ({ model: DECISIONS_MODEL, answers: { f1: { choice: "b", confidence: 0.9 }, f2: { choice: "b", confidence: 0.9 } }, probabilities: { f1: { a: 0.1, none: 0.9 }, f2: { b: 0.9, none: 0.1 } }, inputTokens: 10, latencyMs: 1, costUsd: 0 }), { dir, mode: "record", engine: "decisions", model: DECISIONS_MODEL, fixture, env: {} });
    await record(req);
    const engine = harnessEngine({ name: "decisions", canned: null, fixture, env: { CARET_JEV_CACHE: dir, CARET_JEV_CACHE_MODE: "replay" } });
    await expect(engine.ask(req)).rejects.toThrow(/out-of-set/);
  });
  it("refuses fixture-external sources before reading a key or sending", async () => {
    const fetchFn = response();
    const ask = makeDecisionsClient({ fixture, env: {}, fetchFn });
    await expect(ask({ ...request(), charged: { privateWindow: 1 } })).rejects.toThrow(/did not load from a fixture/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("loads only OPENAI_API_KEY directly or from a referenced env file", () => {
    const file = join(folder(), "key.env");
    writeFileSync(file, `TYPESAFE_API_KEY=wrong\nexport OPENAI_API_KEY='${key}'\n`);
    expect(loadDecisionsKey({ CARET_ENV_FILE: file })).toBe(key);
    expect(loadDecisionsKey({ OPENAI_API_KEY: "direct", CARET_ENV_FILE: file })).toBe("direct");
    expect(() => loadDecisionsKey({ TYPESAFE_API_KEY: "wrong" })).toThrow(/key missing/);
  });
  it("the existing secret assertions exclude OpenAI project and legacy keys", () => {
    for (const secret of [key, `sk-${"a".repeat(32)}`]) {
      expect(() => assertNoExcludedValue({ state: secret })).toThrow();
      expect(withholdValues(`key ${secret}`)).not.toContain(secret);
    }
  });
  it("rejects even a configured key that does not resemble an API key", async () => {
    const ask = makeDecisionsClient({ fixture, env: { OPENAI_API_KEY: "Blue" }, fetchFn: response(), spend: spend() });
    await expect(ask(request())).rejects.toThrow(/contains the configured credential/);
  });
  it.each(["off", "replay"])("omits a credential-bearing body from the harness log with cache %s, even for an unrecognized key format", async (mode) => {
    const log = join(folder(), "requests.ndjson");
    const cache = folder();
    if (mode === "replay") {
      await cachedAsk(async () => ({ model: DECISIONS_MODEL, answers: { f1: { choice: "a", confidence: 0.81 } }, nouls: { verify: 0.93 }, probabilities: { f1: { a: 0.72, none: 0.28 } }, inputTokens: 42, latencyMs: 1, costUsd: 0 }), { dir: cache, mode: "record", engine: "decisions", model: DECISIONS_MODEL, fixture, env: {} })(request());
    }
    const fetchFn = response(); vi.stubGlobal("fetch", fetchFn);
    const engine = harnessEngine({ name: "decisions", canned: null, fixture, env: { OPENAI_API_KEY: "Blue", CARET_JEV_CACHE: mode === "off" ? "off" : cache, CARET_JEV_CACHE_MODE: "replay", CARET_DECISIONS_SPEND_DIR: folder() }, logRequests: log });
    try {
      await expect(engine.ask(request())).rejects.toThrow(/contains the configured credential/);
      const text = readFileSync(log, "utf8");
      expect(text).not.toContain("Blue");
      expect(JSON.parse(text).body).toBeUndefined();
      expect(fetchFn).not.toHaveBeenCalled();
    } finally { engine.engine.close?.(); }
  });
  it.each(["realfill-asks.ts", "realfill-eval.ts", "about-fill-eval.ts", "fill-eval.ts"])("%s accepts the Decisions engine flag without a key or network", (script) => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), "--engine", "decisions"], { encoding: "utf8", env: { PATH: process.env.PATH, TMPDIR: tmpdir() } });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("required");
    expect(child.stderr).not.toContain("Unknown option");
  });
  it("logs billed refusal telemetry without accepting or exposing an answer", async () => {
    const dir = folder(); const spendDir = folder(); const log = join(dir, "requests.ndjson");
    vi.stubGlobal("fetch", response(recorded("refusal.json")));
    const engine = harnessEngine({ name: "decisions", canned: null, fixture, env: { OPENAI_API_KEY: key, CARET_JEV_CACHE: "off", CARET_DECISIONS_SPEND_DIR: spendDir }, logRequests: log });
    try {
      await expect(engine.ask(request())).rejects.toThrow(/refused/);
      const row = JSON.parse(readFileSync(log, "utf8").trim());
      expect(row.refused).toBe(true);
      expect(row.costUsd).toBe(42 * DECISIONS_USD_PER_TOKEN);
      expect(row.latencyMs).toBeGreaterThanOrEqual(0);
      expect(row.answers).toBeUndefined();
      expect(readFileSync(log, "utf8")).not.toContain(key);
    } finally { engine.engine.close?.(); }
  });
  it("the one-call probe prints only status, latency and cost with a mocked transport", () => {
    const dir = folder();
    const reply = { model: DECISIONS_MODEL, answers: [{ type: "predicate", name: "blue", probability: 0.99 }], usage: { input_tokens: 8 } };
    const code = `let calls=0; globalThis.fetch=async()=>{calls++;return new Response(${JSON.stringify(JSON.stringify(reply))});}; await import(${JSON.stringify(new URL("../scripts/decisions-probe.ts", import.meta.url).href)}); console.error("calls="+calls);`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { PATH: process.env.PATH, TMPDIR: tmpdir(), OPENAI_API_KEY: key, CARET_DECISIONS_SPEND_DIR: dir } });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr.trim()).toBe("calls=1");
    const row = JSON.parse(child.stdout.trim());
    expect(Object.keys(row).sort()).toEqual(["costUsd", "latencyMs", "status"]);
    expect(row.status).toBe("ok");
    expect(row.costUsd).toBe(8 * DECISIONS_USD_PER_TOKEN);
    expect(child.stdout).not.toContain(key);
    expect(existsSync(join(dir, "run.lock"))).toBe(false);
  });
  it("accepts the engine flag and logs raw answers, cost and Jev replay agreement without calling Jev", async () => {
    expect(engineName("decisions")).toBe("decisions");
    const dir = folder(); const spendDir = folder(); const log = join(dir, "requests.ndjson");
    const req = request();
    const jevRecord = cachedAsk(async () => ({ model: "jev-latest", answers: { f1: { choice: "a", confidence: 0.9 } }, nouls: { verify: 0.93 }, inputTokens: 12, latencyMs: 1, costUsd: 0 }), {
      dir, mode: "record", engine: "jev", model: "jev-latest", variant: "provider:typesafe;body:per-question", fixture, env: {},
    });
    await jevRecord(req);
    vi.stubGlobal("fetch", response());
    const engine = harnessEngine({ name: "decisions", canned: null, fixture, env: { OPENAI_API_KEY: key, CARET_JEV_CACHE: dir, CARET_DECISIONS_SPEND_DIR: spendDir }, logRequests: log });
    await engine.ask(req);
    const row = JSON.parse(readFileSync(log, "utf8").trim());
    expect(row.answers.f1.confidence).toBe(0.81);
    expect(row.probabilities.f1).toEqual({ a: 0.72, none: 0.28 });
    expect(row.agreement).toEqual({ f1: true, verify: true });
    expect(row.costUsd).toBe(42 * DECISIONS_USD_PER_TOKEN);
    expect(readFileSync(log, "utf8")).not.toContain(key);
    expect(fetch).toHaveBeenCalledTimes(1);
    const lock = join(spendDir, "run.lock");
    expect(existsSync(lock)).toBe(true);
    engine.engine.close?.();
    expect(existsSync(lock)).toBe(false);
  });
});

describe("Decisions lifetime comparison budget", () => {
  it("persists reservations before a request and blocks this process once a cap is reached", () => {
    const dir = folder(); const s = spend(dir, { providerCapUsd: 0.03 });
    const first = s.reserve();
    expect(JSON.parse(readFileSync(join(dir, "comparison.ndjson"), "utf8")).type).toBe("reserve");
    expect(() => s.reserve()).toThrow(DecisionsBudgetError);
    first.settle(1);
    expect(() => s.reserve()).toThrow(/blocked for this process/);
  });
  it("does not reset across runs or calendar days", () => {
    const dir = folder(); const first = spend(dir, { totalCapUsd: 0.03 });
    first.reserve().settle(150_000); first.close();
    const second = spend(dir, { totalCapUsd: 0.03 });
    expect(() => second.reserve()).toThrow(/cap/);
  });
  it("enforces the probe subcap and allows a separate eval within the provider cap", () => {
    const dir = folder(); const first = spend(dir, { probeCapUsd: 0.03 });
    first.reserve(true).settle(150_000); first.close();
    const second = spend(dir, { probeCapUsd: 0.03 });
    expect(() => second.reserve(true)).toThrow(/cap/); second.close();
    const third = spend(dir, { probeCapUsd: 0.03 });
    expect(third.reserve(false).settle(42)).toBe(42 * DECISIONS_USD_PER_TOKEN);
  });
  it("refuses another live run, including one in a separate process", () => {
    const dir = folder(); const first = spend(dir); first.reserve();
    expect(() => spend(dir).reserve()).toThrow(/live run/);
    const code = `import { DecisionsSpend } from ${JSON.stringify(new URL("../src/engines/decide/decisions-spend.ts", import.meta.url).href)}; try { new DecisionsSpend({dir:${JSON.stringify(dir)}}).reserve(); process.exitCode=2; } catch (e) { console.log(e.message); }`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("live run");
  });
  it("reclaims a dead pid lock but retains its unresolved spend", () => {
    const dir = folder(); const first = spend(dir); first.reserve(); first.close();
    // A completed child gives a known dead PID, rather than guessing a currently unused number.
    const child = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    writeFileSync(join(dir, "run.lock"), JSON.stringify({ pid: Number(child.stdout.trim()), startedAt: "2026-10-07T00:00:00Z", id: "dead" }));
    const second = spend(dir, { providerCapUsd: 0.03 });
    expect(() => second.reserve()).toThrow(/cap/);
  });
  it("never raises the approved caps and fails closed on incomplete spend records", () => {
    expect(() => spend(folder(), { providerCapUsd: 1 })).toThrow(/authorized/);
    const dir = folder(); writeFileSync(join(dir, "comparison.ndjson"), '{"provider":');
    expect(() => spend(dir).reserve()).toThrow(/incomplete/);
  });
});
