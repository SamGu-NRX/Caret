import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minted } from "./minted.ts";
import { decisionsBody, loadDecisionsKey, makeDecisionsClient, DECISIONS_MODEL, DECISIONS_POLICY_VERSION, DECISIONS_URL, DecisionsAttemptError, DecisionsHttpError, MAX_ATTEMPTS, type DecisionsResult } from "../src/engines/decide/decisions.ts";
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
const spend = (dir = folder(), options: { totalCapUsd?: number; runCapUsd?: number; probeCapUsd?: number } = {}): DecisionsSpend => {
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
      { type: "choice", name: "f1", instructions: req.questions.f1!.instructions, choices: [{ value: "a", description: "Blue" }, { value: "leave_blank" }] },
      { type: "predicate", name: "verify", instructions: "Is the square blue?\nTrue: It is blue.\nFalse: It is not blue." },
    ] });
    expect(init?.body).not.toContain(key);
  });
  it("retains known billed cost when settlement blocks an underestimated reservation", async () => {
    const s = spend();
    const json = JSON.parse(recorded());
    json.usage.input_tokens = 200_001;
    const fetchFn = response(JSON.stringify(json));
    const ask = client(fetchFn, s);
    const error = await ask(request()).catch((e) => e);
    expect(error).toBeInstanceOf(DecisionsAttemptError);
    expect(error.kind).toBe("cap");
    expect(error.attempt.costUsd).toBe(200_001 * DECISIONS_USD_PER_TOKEN);
    expect(error.attempts[0].costUsd).toBe(error.attempt.costUsd);
    expect(s.run().billedUsd).toBe(error.attempt.costUsd);
    expect(s.run().unsettledUsd).toBe(0);
    await expect(ask(request())).rejects.toThrow(/blocked/);
    expect(fetchFn).toHaveBeenCalledOnce();
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
    // Unknown billing keeps each attempt's whole hold: the body's bytes plus the per-question framing allowance.
    expect(rows.every((r) => r.type === "reserve" && r.usd === rows[0].usd && r.usd > 0 && r.usd < 0.02)).toBe(true);
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
    const error = new DecisionsAttemptError(new DecisionsHttpError(503, null), { latencyMs: 1, costUsd: null, inputTokens: null, refused: false }, [key]);
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
    const record = cachedAsk(async () => ({ model: DECISIONS_MODEL, answers: { f1: { choice: "b", confidence: 0.9 }, f2: { choice: "b", confidence: 0.9 } }, probabilities: { f1: { a: 0.1, none: 0.9 }, f2: { b: 0.9, none: 0.1 } }, inputTokens: 10, latencyMs: 1, costUsd: 0 }), { dir, mode: "record", engine: "decisions", model: DECISIONS_MODEL, variant: DECISIONS_POLICY_VERSION, fixture, env: {} });
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
    const dir = folder(); const s = spend(dir, { runCapUsd: 0.03 });
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
  it("enforces the probe subcap and allows a separate eval within the lifetime cap", () => {
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
    const second = spend(dir, { totalCapUsd: 0.03 });
    expect(() => second.reserve()).toThrow(/cap/);
  });
  it("never raises the approved caps and fails closed on incomplete spend records", () => {
    expect(() => spend(folder(), { runCapUsd: 1 })).toThrow(/authorized/);
    const dir = folder(); writeFileSync(join(dir, "comparison.ndjson"), '{"provider":');
    expect(() => spend(dir).reserve()).toThrow(/incomplete/);
  });
});

describe("Decisions errors, retries, key fallback and the result cache (recorded replies only)", () => {
  const errors = JSON.parse(readFileSync(new URL("../fixtures/recorded/decisions/errors.json", import.meta.url), "utf8")) as Record<string, { status: number; headers: Record<string, string>; body: unknown }>;
  const reply = (name: string) => (): Response => { const e = errors[name]!; return new Response(JSON.stringify(e.body), { status: e.status, headers: e.headers }); };
  const ok = () => (): Response => new Response(recorded(), { status: 200 });
  const personal = "sk-proj-synthetic-personal-not-a-real-key";
  const both = { OPENAI_API_KEY: key, OPENAI_API_KEY_PERSONAL: personal };
  /** Answers each call from `replies` in order and records which key carried it. */
  const scripted = (...replies: (() => Response)[]) => {
    const keys: string[] = [];
    const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      keys.push(auth === `Bearer ${key}` ? "org" : auth === `Bearer ${personal}` ? "personal" : "other");
      const next = replies[keys.length - 1];
      if (next === undefined) throw new Error("unexpected extra call");
      return next();
    }) as unknown as typeof fetch;
    return { fn, keys };
  };
  const waits: number[] = [];
  const make = (env: Record<string, string>, fetchFn: typeof fetch, s = spend()) =>
    makeDecisionsClient({ fixture, env, fetchFn, spend: s, sleep: async (ms) => { waits.push(ms); }, random: () => 0.5 });
  const ledger = (dir: string) => readFileSync(join(dir, "comparison.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  afterEach(() => { waits.length = 0; });

  it.each(["credit_balance_exhausted", "insufficient_quota", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"])("%s with no personal key ends the run; later requests send nothing", async (name) => {
    const dir = folder(); const t = scripted(reply(name));
    const ask = make({ OPENAI_API_KEY: key }, t.fn, spend(dir));
    const error = await ask(request()).catch((e) => e);
    expect(error).toBeInstanceOf(DecisionsAttemptError);
    expect(error.kind).toBe("stop");
    expect(error.code).toBe(name);
    await expect(ask(request())).rejects.toThrow(/stopped earlier/);
    expect(t.fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    // A documented error reply without usage settles its hold at $0.
    expect(ledger(dir).map((r) => [r.type, r.key ?? null, r.usd === 0 ? 0 : "held", r.status ?? null])).toEqual([["reserve", "org", "held", null], ["settle", null, 0, 429]]);
  });
  it.each([
    ["rate_limit_exceeded", 1500],
    ["slow_down", 750],
    ["server_is_overloaded", 2000],
  ])("retries %s once the server delay or backoff passes", async (name, wait) => {
    const t = scripted(reply(name), ok());
    const r = await make({ OPENAI_API_KEY: key }, t.fn)(request()) as DecisionsResult;
    expect(r.answers).toEqual({ f1: { choice: "a", confidence: 0.81 } });
    expect(waits).toEqual([wait]);
    expect(r.servedBy).toBe("org");
    expect(r.attempts.map((x) => [x.key, x.status, x.code, x.waitMs])).toEqual([["org", errors[name]!.status, name, wait], ["org", 200, null, 0]]);
  });
  it("keeps aggregate billing unknown after a billed retry followed by a transport failure", async () => {
    const failed = errors.server_is_overloaded!;
    const t = scripted(() => new Response(JSON.stringify({ ...(failed.body as object), usage: { input_tokens: 17 } }), { status: failed.status, headers: failed.headers }), () => { throw new Error("synthetic timeout"); });
    const dir = folder(); const s = spend(dir);
    const error = await make({ OPENAI_API_KEY: key }, t.fn, s)(request()).catch((e) => e);
    expect(error.attempts.map((a: { costUsd: number | null }) => a.costUsd)).toEqual([17 * DECISIONS_USD_PER_TOKEN, null]);
    expect(error.attempt.costUsd).toBeNull();
    expect(error.attempt.inputTokens).toBeNull();
    expect(s.run().unsettledUsd).toBeGreaterThan(0);
  });
  it("includes billed failed attempts in a successful retry's reported cost", async () => {
    const failed = errors.server_is_overloaded!;
    const t = scripted(() => new Response(JSON.stringify({ ...(failed.body as object), usage: { input_tokens: 17 } }), { status: failed.status, headers: failed.headers }), ok());
    const r = await make({ OPENAI_API_KEY: key }, t.fn)(request()) as DecisionsResult;
    expect(r.attempts.map((a) => a.costUsd)).toEqual([17 * DECISIONS_USD_PER_TOKEN, 42 * DECISIONS_USD_PER_TOKEN]);
    expect(r.costUsd).toBe(r.attempts.reduce((sum, a) => sum + (a.costUsd ?? 0), 0));
  });
  it("stops after MAX_ATTEMPTS attempts with doubling jittered waits", async () => {
    const t = scripted(...Array.from({ length: MAX_ATTEMPTS }, () => reply("slow_down")));
    const error = await make({ OPENAI_API_KEY: key }, t.fn)(request()).catch((e) => e);
    expect(error.kind).toBe("rate");
    expect(t.fn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(waits).toEqual([750, 1500, 3000]);
    expect(error.attempts).toHaveLength(MAX_ATTEMPTS);
  });
  it.each(["rate_limit_exceeded", "server_is_overloaded", "credit_balance_exhausted"])("a probe makes one attempt without retry or personal fallback on %s", async (name) => {
    const t = scripted(reply(name), ok()); const dir = folder();
    const ask = makeDecisionsClient({ fixture, env: both, fetchFn: t.fn, spend: spend(dir), probe: true, sleep: async (ms) => { waits.push(ms); } });
    await expect(ask(request())).rejects.toBeInstanceOf(DecisionsAttemptError);
    expect(t.keys).toEqual(["org"]);
    expect(waits).toEqual([]);
    expect(ledger(dir).filter((r) => r.type === "reserve")).toHaveLength(1);
  });
  it("never waits past the 60 s request budget", async () => {
    const t = scripted(() => new Response(JSON.stringify(errors.rate_limit_exceeded!.body), { status: 429, headers: { "retry-after": "70" } }));
    await expect(make({ OPENAI_API_KEY: key }, t.fn)(request())).rejects.toThrow(/429/);
    expect(t.fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });
  it("sends a retry when its remaining timeout has fractional milliseconds", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const t = scripted(() => new Response(JSON.stringify(errors.rate_limit_exceeded!.body), { status: 429, headers: { "retry-after-ms": "55500.25" } }), ok());
    const s = spend();
    try {
      const ask = makeDecisionsClient({ fixture, env: { OPENAI_API_KEY: key }, fetchFn: t.fn, spend: s, sleep: async (ms) => { now += ms; } });
      await expect(ask(request())).resolves.toMatchObject({ servedBy: "org" });
      expect(t.fn).toHaveBeenCalledTimes(2);
      expect(s.run().unsettledUsd).toBe(0);
    } finally { clock.mockRestore(); }
  });
  it("keeps a deferred personal fallback nonterminal for the next request", async () => {
    const t = scripted(reply("slow_down"), reply("slow_down"), reply("slow_down"), reply("credit_balance_exhausted"), ok());
    const ask = make(both, t.fn);
    const error = await ask(request()).catch((e) => e);
    expect(error.kind).toBe("service");
    expect(error.code).toBe("credit_balance_exhausted");
    expect(error.status).toBe(429);
    expect(error.attempts).toHaveLength(MAX_ATTEMPTS);
    await expect(ask(request())).resolves.toMatchObject({ servedBy: "personal" });
    expect(t.keys).toEqual(["org", "org", "org", "org", "personal"]);
  });
  it("does not retry an error outside the retry rule", async () => {
    const t = scripted(reply("invalid_request"));
    const error = await make({ OPENAI_API_KEY: key }, t.fn)(request()).catch((e) => e);
    expect(error.status).toBe(400);
    expect(t.fn).toHaveBeenCalledTimes(1);
  });
  it("switches from the org key to the personal key exactly once, and stays there", async () => {
    const dir = folder(); const s = spend(dir);
    const t = scripted(reply("credit_balance_exhausted"), ok(), ok());
    const ask = make(both, t.fn, s);
    const first = await ask(request()) as DecisionsResult;
    expect(first.servedBy).toBe("personal");
    expect(first.attempts.map((x) => x.key)).toEqual(["org", "personal"]);
    const second = await ask(request()) as DecisionsResult;
    expect(second.servedBy).toBe("personal");
    expect(t.keys).toEqual(["org", "personal", "personal"]);
    expect(waits).toEqual([]);
    // Every attempt reserved under its key; the rejected one settled at $0, the answered ones at their usage.
    expect(ledger(dir).map((r) => [r.type, r.key ?? r.usd])).toEqual([["reserve", "org"], ["settle", 0], ["reserve", "personal"], ["settle", 42 * DECISIONS_USD_PER_TOKEN], ["reserve", "personal"], ["settle", 42 * DECISIONS_USD_PER_TOKEN]]);
    expect(s.run()).toEqual({ usd: 84 * DECISIONS_USD_PER_TOKEN, billedUsd: 84 * DECISIONS_USD_PER_TOKEN, unsettledUsd: 0, holds: 3 });
  });
  it("a stop on the personal key ends the run with no second switch", async () => {
    const t = scripted(reply("credit_balance_exhausted"), reply("insufficient_quota"));
    const ask = make(both, t.fn);
    const error = await ask(request()).catch((e) => e);
    expect(error.kind).toBe("stop");
    expect(error.attempts.map((x: { key: string }) => x.key)).toEqual(["org", "personal"]);
    await expect(ask(request())).rejects.toThrow(/stopped earlier \(insufficient_quota on the personal key\)/);
    expect(t.keys).toEqual(["org", "personal"]);
  });
  it("requests already sent on the org key follow the one switch instead of ending the run", async () => {
    const t = scripted(reply("credit_balance_exhausted"), reply("credit_balance_exhausted"), ok(), ok());
    const ask = make(both, t.fn);
    const rs = await Promise.all([ask(request()), ask(request())]) as DecisionsResult[];
    expect(rs.map((r) => r.servedBy)).toEqual(["personal", "personal"]);
    expect(t.keys).toEqual(["org", "org", "personal", "personal"]);
  });
  it("counts an unsettled hold against --max-usd and refuses the attempt that would pass it", async () => {
    const dir = folder();
    // One attempt's hold for this request, read from a separate ledger.
    const d = folder();
    await make({ OPENAI_API_KEY: key }, scripted(ok()).fn, spend(d))(request());
    const hold = ledger(d)[0].usd as number;
    const s = spend(dir, { runCapUsd: hold * 1.5 });
    const t = scripted(() => { throw new Error("timeout"); }, ok());
    const ask = make({ OPENAI_API_KEY: key }, t.fn, s);
    await expect(ask(request())).rejects.toThrow(/network request failed/);
    expect(s.run().unsettledUsd).toBe(hold);
    const error = await ask(request()).catch((e) => e);
    expect(error.kind).toBe("cap");
    expect(t.fn).toHaveBeenCalledTimes(1);
  });
  it("a retry's reservation counts against --max-usd before it is sent", async () => {
    const hold = await (async () => { const d = folder(); await make({ OPENAI_API_KEY: key }, scripted(ok()).fn, spend(d))(request()); return ledger(d)[0].usd as number; })();
    // Room for one hold at a time: the rejected reply settles at $0, so its retry is admitted; a billed answer is not refunded.
    const s = spend(folder(), { runCapUsd: hold + 42 * DECISIONS_USD_PER_TOKEN / 2 });
    const t = scripted(reply("slow_down"), ok(), ok());
    const ask = make({ OPENAI_API_KEY: key }, t.fn, s);
    await ask(request());
    await expect(ask(request())).rejects.toThrow(/per-run cap/);
    expect(t.fn).toHaveBeenCalledTimes(2);
  });
  it("keeps both keys out of errors, the ledger and the harness log", async () => {
    const dir = folder(); const spendDir = folder(); const log = join(dir, "requests.ndjson");
    const echo = new Response(JSON.stringify({ error: { message: `${key} ${personal}`, type: key, code: personal } }), { status: 401 });
    vi.stubGlobal("fetch", vi.fn(async () => echo));
    const engine = harnessEngine({ name: "decisions", canned: null, fixture, env: { ...both, CARET_JEV_CACHE: "off", CARET_DECISIONS_SPEND_DIR: spendDir }, logRequests: log, decisionsMaxUsd: 0.01 });
    try {
      const error = await engine.ask(request()).catch((e) => e);
      expect(error.status).toBe(401);
      expect(error.code).toBeNull();
      for (const text of [String(error), error.message, JSON.stringify(error), readFileSync(log, "utf8"), readFileSync(join(spendDir, "comparison.ndjson"), "utf8")]) {
        expect(text).not.toContain(key);
        expect(text).not.toContain(personal);
      }
      const thrown = await make(both, vi.fn(async () => { throw new Error(`${key} ${personal}`); }) as unknown as typeof fetch)(request()).catch((e) => e);
      expect(String(thrown)).not.toMatch(/sk-proj/);
    } finally { engine.engine.close?.(); }
  });
  it("a cache hit costs $0 and sends nothing; --no-cache sends again", async () => {
    const cache = folder(); const spendDir = folder(); const log = join(folder(), "requests.ndjson");
    const fetchFn = response(); vi.stubGlobal("fetch", fetchFn);
    const env = { OPENAI_API_KEY: key, CARET_JEV_CACHE: cache, CARET_DECISIONS_SPEND_DIR: spendDir };
    const engine = harnessEngine({ name: "decisions", canned: null, fixture, env, logRequests: log, decisionsMaxUsd: 0.01 });
    try {
      const live = await engine.ask(request());
      const again = await engine.ask(request());
      expect(live.costUsd).toBe(42 * DECISIONS_USD_PER_TOKEN);
      expect(again.costUsd).toBe(0);
      expect(again.answers).toEqual(live.answers);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(ledger(spendDir)).toHaveLength(2);
      expect(readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).servedBy)).toEqual(["org", "cache"]);
    } finally { engine.engine.close?.(); }
    const fresh = harnessEngine({ name: "decisions", canned: null, fixture, env, noCache: true, decisionsMaxUsd: 0.01 });
    try {
      await fresh.ask(request());
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally { fresh.engine.close?.(); }
  });
  it("never replays an answer cached under another body policy", async () => {
    const dir = folder();
    await cachedAsk(async () => ({ model: DECISIONS_MODEL, answers: { f1: { choice: "a", confidence: 0.81 } }, nouls: { verify: 0.93 }, probabilities: { f1: { a: 0.72, none: 0.28 } }, inputTokens: 42, latencyMs: 1, costUsd: 0 }), { dir, mode: "record", engine: "decisions", model: DECISIONS_MODEL, variant: "", fixture, env: {} })(request());
    const engine = harnessEngine({ name: "decisions", canned: null, fixture, env: { CARET_JEV_CACHE: dir, CARET_JEV_CACHE_MODE: "replay" }, decisionsMaxUsd: 0.01 });
    await expect(engine.ask(request())).rejects.toThrow(/nothing recorded/);
  });
  it("sends leave_blank only for Jev's none option and maps it back", async () => {
    const t = scripted(ok());
    const r = await make({ OPENAI_API_KEY: key }, t.fn)(request());
    const sent = JSON.parse(vi.mocked(t.fn).mock.calls[0]![1]!.body as string);
    expect(sent.questions[0].choices.map((c: { value: string }) => c.value)).toEqual(["a", "leave_blank"]);
    expect(r.probabilities?.f1).toEqual({ a: 0.72, none: 0.28 });
    const noNone = minted({ state: "Synthetic", questions: { f: { type: "choice", instructions: "Which?", criteria: { asks: "Asked.", not: "Not asked." } } }, snippets: [], charged: {} });
    expect(decisionsBody(wireBody(noNone)).questions[0]).toEqual({ type: "choice", name: "f", instructions: "Which?", choices: [{ value: "asks", description: "Asked." }, { value: "not", description: "Not asked." }] });
    for (const id of ["leave_blank", `c${"0".repeat(40)}`]) {
      const clash = minted({ state: "Synthetic", questions: { f: { type: "choice", instructions: "Which?", criteria: { [id]: null, none: null } } }, snippets: [], charged: {} });
      expect(() => decisionsBody(wireBody(clash))).toThrow(/short handles/);
    }
  });
});
