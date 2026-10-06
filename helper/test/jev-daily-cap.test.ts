// Brief J1 part A4: every live Jev call checks the day's spend on this Mac against CARET_JEV_DAILY_CAP before it is
// sent, and a call the cap stops fails as its own kind, whose sentence names the cap and the day's spend.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailySpend, DEFAULT_DAILY_CAP_USD, JevCapError, capFromEnv } from "../src/engines/decide/daily-cap.ts";
import { jevFailureKind, makeJevClient, JEV_USD_PER_INPUT_TOKEN } from "../src/fill/jev.ts";
import { jevFailureSays, SAYS } from "../src/planner/says.ts";

const REQ = { state: "s", questions: { q: { type: "choice" as const, instructions: "i", criteria: { a: null, b: null } } }, snippets: [], charged: {} };
const answered = (tokens: number): Response =>
  new Response(JSON.stringify({ model: "jev-1.13.0", answers: { q: { choice: "a", confidence: 0.9 } }, usage: { input_tokens: tokens } }), { status: 200, headers: { "content-type": "application/json" } });

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "j1-cap-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("the daily Jev cap", () => {
  it("stops calls once the day's spend reaches the cap, before anything is sent", async () => {
    const fetch = vi.fn(async () => answered(30_000));
    vi.stubGlobal("fetch", fetch);
    // One answer costs 30,000 x $0.042/M = $0.00126, over a cap of $0.001: the first goes, the second is refused.
    const ask = makeJevClient(() => "k", 10_000, new DailySpend({ dir, capUsd: 0.001 }));
    await ask(REQ);
    const e = await ask(REQ).catch((x: unknown) => x);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(e).toBeInstanceOf(JevCapError);
    expect(jevFailureKind(e)).toBe("cap");
    expect((e as JevCapError).spentUsd).toBeCloseTo(30_000 * JEV_USD_PER_INPUT_TOKEN, 9);
    expect((e as Error).message).toContain("$0.0010");
    expect((e as Error).message).toContain("CARET_JEV_DAILY_CAP");
  });

  it("says the cap and the day's spend in the sentence the user reads", () => {
    const said = jevFailureSays(new JevCapError(0.5, 0.5012, "2026-10-06"), SAYS.unreachable);
    expect(said).toBe("Caret reached today's limit for its model: $0.50 spent of $0.50 a day. It starts again tomorrow, or raise CARET_JEV_DAILY_CAP in Caret's .env file.");
  });

  it("counts what another process spent today", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answered(30_000)));
    await makeJevClient(() => "k", 10_000, new DailySpend({ dir, capUsd: 0.001 }))(REQ);
    const other = makeJevClient(() => "k", 10_000, new DailySpend({ dir, capUsd: 0.001 }));
    await expect(other(REQ)).rejects.toBeInstanceOf(JevCapError);
  });

  it("holds requests in flight against the cap, so two sent together cannot both pass it", async () => {
    let free: () => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (free = () => r(answered(10))))));
    // The reservation for REQ's ~150-character body is about 50 tokens; a cap of 70 tokens' cost fits one, not two.
    const ask = makeJevClient(() => "k", 10_000, new DailySpend({ dir, capUsd: 70 * JEV_USD_PER_INPUT_TOKEN }));
    const first = ask(REQ);
    await expect(ask(REQ)).rejects.toBeInstanceOf(JevCapError);
    free();
    await first;
  });

  it("charges nothing for a request that failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 402 })));
    const spend = new DailySpend({ dir, capUsd: 0.001 });
    await makeJevClient(() => "k", 10_000, spend)(REQ).catch(() => undefined);
    expect(spend.spent()).toBe(0);
  });

  it("starts each local day at zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answered(30_000)));
    let now = new Date(2026, 9, 6, 23, 59);
    const ask = makeJevClient(() => "k", 10_000, new DailySpend({ dir, capUsd: 0.001, now: () => now }));
    await ask(REQ);
    await expect(ask(REQ)).rejects.toBeInstanceOf(JevCapError);
    now = new Date(2026, 9, 7, 0, 1);
    await expect(ask(REQ)).resolves.toBeDefined();
    expect(readFileSync(join(dir, "2026-10-06.ndjson"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(dir, "2026-10-07.ndjson"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("is $0.50 unless configured, and reads the cap from the environment or Caret's .env file", () => {
    expect(capFromEnv({})).toBe(DEFAULT_DAILY_CAP_USD);
    expect(DEFAULT_DAILY_CAP_USD).toBe(0.5);
    expect(capFromEnv({ CARET_JEV_DAILY_CAP: "1.25" })).toBe(1.25);
    const env = join(dir, ".env");
    writeFileSync(env, "TYPESAFE_API_KEY=x\nCARET_JEV_DAILY_CAP=\"$0.20\"\n");
    expect(capFromEnv({ CARET_ENV_FILE: env })).toBe(0.2);
  });

  it.each(["abc", "0", "-1", "Infinity"])("fails at start on a cap of '%s', naming the variable", (raw) => {
    expect(() => capFromEnv({ CARET_JEV_DAILY_CAP: raw })).toThrow(/CARET_JEV_DAILY_CAP is/);
  });

  it("fails loudly on a day file it cannot read as spend", async () => {
    const spend = new DailySpend({ dir, capUsd: 1, now: () => new Date(2026, 9, 6, 12) });
    writeFileSync(join(dir, "2026-10-06.ndjson"), '{"usd":"lots"}\n');
    expect(() => spend.spent()).toThrow(/without a dollar amount/);
  });
});
