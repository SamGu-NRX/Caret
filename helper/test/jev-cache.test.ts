// Brief J1 part A3: a record-and-replay cache for decision requests, for test harnesses only. It stores request text on
// disk, so it refuses to run as the shipped app and refuses any request carrying text that is not a fixture's.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheFromEnv, CacheRefused, cachedAsk, canonicalRequest, refuseCacheInHelper, type CacheOptions } from "../src/engines/decide/cache.ts";
import type { AskJev, JevRequest, JevResult } from "../src/fill/jev.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "j1-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FIXTURE = { windows: (id: string) => id === "fx-1", memory: true };
const opts = (mode: CacheOptions["mode"], env: NodeJS.ProcessEnv = {}): CacheOptions => ({ dir, mode, engine: "jev", model: "jev-latest", fixture: FIXTURE, env });

/** A fill-shaped request: two fields, three candidates, the second ask's ids and order as given. */
function fillReq(ids: [string, string, string], order: [number, number, number] = [0, 1, 2], window = "fx-1"): JevRequest {
  const texts = ['"Ada Lovelace" (in Notes)', '"ada@example.com" (email; in Notes)', '"(512) 555-0193" (phone; in Notes)'];
  const criteria: Record<string, string> = {};
  for (const i of order) criteria[ids[i] as string] = texts[i] as string;
  criteria.none = "No candidate is the value this field asks for.";
  return {
    state: { destination_window: "Chrome window 'Form'", form_fields: "Name; Email" },
    questions: {
      f1: { type: "choice", instructions: "Label: 'Name'. Which candidate?", criteria: { ...criteria } },
      f2: { type: "choice", instructions: "Label: 'Email'. Which candidate?", criteria: { ...criteria } },
      [`${ids[1]}_owner`]: { type: "choice", instructions: 'Whose is this value? "ada@example.com" (email; in Notes)', criteria: { user: "The user's", other: "Someone else's" } },
    },
    nouls: { n_1: { type: "noul", instructions: "Does the form ask for an email?" } },
    snippets: [{ windowId: window, kind: "candidate", text: "Ada Lovelace" }],
    charged: { [window]: 12 },
  };
}

function engine(): { ask: AskJev; calls: JevRequest[] } {
  const calls: JevRequest[] = [];
  return {
    calls,
    ask: async (req) => {
      calls.push(req);
      const ids = Object.keys(req.questions.f1?.criteria ?? {});
      const email = ids.find((k) => req.questions.f1?.criteria[k]?.includes("ada@example.com")) as string;
      const name = ids.find((k) => req.questions.f1?.criteria[k]?.includes("Ada Lovelace")) as string;
      const owner = Object.keys(req.questions).find((k) => k.endsWith("_owner")) as string;
      const r: JevResult = {
        model: "jev-1.13.0",
        answers: { f1: { choice: name, confidence: 0.91 }, f2: { choice: email, confidence: 0.88 }, [owner]: { choice: "user", confidence: 0.7 } },
        nouls: { n_1: 0.97 },
        probabilities: { f1: { [name]: 0.95, [email]: 0.05 } },
        inputTokens: 1000,
        latencyMs: 210,
        costUsd: 0.000042,
      };
      return r;
    },
  };
}

describe("the record-and-replay cache", () => {
  it("refuses to start as the shipped app (the launchd agent's marker, or a copy LaunchServices opened)", () => {
    const e = engine();
    expect(() => cachedAsk(e.ask, opts("replay-or-record", { CARET_LAUNCHD_AGENT: "1" }))).toThrow(CacheRefused);
    expect(() => cachedAsk(e.ask, opts("replay-or-record", { CARET_OPENED_BY_LAUNCHSERVICES: "1" }))).toThrow(CacheRefused);
  });

  it("refuses a request whose text comes from a window that is not a fixture, before reading or writing anything", async () => {
    const e = engine();
    const ask = cachedAsk(e.ask, opts("replay-or-record"));
    await expect(ask(fillReq(["c1", "c2", "c3"], [0, 1, 2], "92930-real"))).rejects.toThrow(CacheRefused);
    expect(e.calls).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses the user's memory unless the harness says its memory is a fixture", async () => {
    const req = { ...fillReq(["c1", "c2", "c3"]), snippets: [{ windowId: "memory", kind: "candidate" as const, text: "Ada" }] };
    await expect(cachedAsk(engine().ask, { ...opts("replay-or-record"), fixture: { windows: FIXTURE.windows, memory: false } })(req)).rejects.toThrow(CacheRefused);
    await expect(cachedAsk(engine().ask, opts("replay-or-record"))(req)).resolves.toBeDefined();
  });

  it("the helper refuses CARET_JEV_CACHE outright: it reads real screens", () => {
    expect(() => refuseCacheInHelper({ CARET_JEV_CACHE: dir })).toThrow(CacheRefused);
    expect(() => refuseCacheInHelper({})).not.toThrow();
  });

  it("replays a recorded answer for the same request without calling the engine, at no cost", async () => {
    const e = engine();
    const first = await cachedAsk(e.ask, opts("record"))(fillReq(["c1", "c2", "c3"]));
    const again = await cachedAsk(e.ask, opts("replay"))(fillReq(["c1", "c2", "c3"]));
    expect(e.calls).toHaveLength(1);
    expect(again.answers).toEqual(first.answers);
    expect(again.nouls).toEqual(first.nouls);
    expect(again.probabilities).toEqual(first.probabilities);
    expect(again.costUsd).toBe(0);
    expect(again.inputTokens).toBe(first.inputTokens);
  });

  it("replays a dual ask's second request across runs, though its candidates come shuffled under other ids", async () => {
    const e = engine();
    await cachedAsk(e.ask, opts("record"))(fillReq(["v1", "v2", "v3"], [0, 1, 2]));
    const shuffled = await cachedAsk(e.ask, opts("replay"))(fillReq(["v3", "v1", "v2"], [2, 0, 1]));
    expect(e.calls).toHaveLength(1);
    // The same candidates were chosen, under this run's ids: Ada is v3 now, her email v1, and the owner question is v1_owner.
    expect(shuffled.answers.f1?.choice).toBe("v3");
    expect(shuffled.answers.f2?.choice).toBe("v1");
    expect(shuffled.answers.v1_owner?.choice).toBe("user");
    expect(shuffled.probabilities?.f1).toEqual({ v3: 0.95, v1: 0.05 });
  });

  it("gives requests that differ in any text different keys", () => {
    const a = canonicalRequest(fillReq(["c1", "c2", "c3"]), "jev", "jev-latest");
    const other = fillReq(["c1", "c2", "c3"]);
    (other.questions.f2 as { instructions: string }).instructions = "Label: 'Work email'. Which candidate?";
    expect(canonicalRequest(other, "jev", "jev-latest").key).not.toBe(a.key);
    expect(canonicalRequest(fillReq(["c1", "c2", "c3"]), "llama", "qwen").key).not.toBe(a.key);
    expect(canonicalRequest(fillReq(["c9", "c7", "c8"], [1, 2, 0]), "jev", "jev-latest").key).toBe(a.key);
  });

  it("keys on the exact ids when two options share a description, since a renaming could not tell them apart", () => {
    const twin = fillReq(["c1", "c2", "c3"]);
    for (const q of [twin.questions.f1, twin.questions.f2]) if (q !== undefined) q.criteria.c3 = q.criteria.c1 ?? null;
    // The same request with the twins under other ids: by description it is the same, so only exact ids tell them apart.
    const swapped = fillReq(["c4", "c2", "c5"]);
    for (const q of [swapped.questions.f1, swapped.questions.f2]) if (q !== undefined) q.criteria.c5 = q.criteria.c4 ?? null;
    expect(canonicalRequest(twin, "jev", "m").exact).toBe(true);
    expect(canonicalRequest(twin, "jev", "m").key).not.toBe(canonicalRequest(swapped, "jev", "m").key);
  });

  it("fails loudly in replay mode when nothing was recorded", async () => {
    await expect(cachedAsk(engine().ask, opts("replay"))(fillReq(["c1", "c2", "c3"]))).rejects.toThrow(/nothing recorded/);
  });

  it("records once and then replays in replay-or-record mode, in files only the user can read", async () => {
    const e = engine();
    const ask = cachedAsk(e.ask, opts("replay-or-record"));
    await ask(fillReq(["c1", "c2", "c3"]));
    await ask(fillReq(["c1", "c2", "c3"]));
    expect(e.calls).toHaveLength(1);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const sub = readdirSync(dir).map((d) => join(dir, d));
    const files = sub.flatMap((d) => readdirSync(d).map((f) => join(d, f)));
    expect(files).toHaveLength(1);
    expect(statSync(files[0] as string).mode & 0o777).toBe(0o600);
  });

  it("reads its directory and mode from the environment, and is off when asked", () => {
    expect(cacheFromEnv({}, "/default")).toEqual({ dir: "/default", mode: "replay-or-record" });
    expect(cacheFromEnv({ CARET_JEV_CACHE: "/x", CARET_JEV_CACHE_MODE: "replay" }, "/default")).toEqual({ dir: "/x", mode: "replay" });
    expect(cacheFromEnv({ CARET_JEV_CACHE: "off" }, "/default")).toBeNull();
    expect(() => cacheFromEnv({ CARET_JEV_CACHE_MODE: "sometimes" }, "/default")).toThrow(/CARET_JEV_CACHE_MODE/);
  });
});

vi.restoreAllMocks();
