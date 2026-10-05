// L1: the models Sam chose. No default path calls Groq or any chat provider: the helper starts with no program writer
// and Jev makes Ask's intents. A route runs only when a developer names it, and the helper says so on start. A goal
// that needs a program writer says plainly that it is not available, and no model is called.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as config from "../src/writer/config.ts";
import { writersOnStart } from "../src/writer/startup.ts";
import { SAYS } from "../src/planner/says.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { goalScene, mailWindow, replyWindow, standInJev } from "./goal-desk.ts";

const src = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

afterEach(() => vi.unstubAllGlobals());

describe("no Groq call on any default path", () => {
  it("starts with no program writer and Jev for Ask, reading no key", () => {
    const said: string[] = [];
    // An environment with every key set: the default start must not use any of them.
    const env = { GROQ_API_KEY: "gsk-not-real", AI_GATEWAY_API_KEY: "vck-not-real", TYPESAFE_API_KEY: "ts-not-real" };
    const w = writersOnStart(undefined, (l) => void said.push(l), env);
    expect(w.plan).toBeNull();
    expect(w.ask).toEqual({ maker: "jev" });
    expect(said.join("\n")).not.toMatch(/groq/i);
  });

  it("configures Jev as Ask's maker and keeps no default chat route", () => {
    expect(config.ASK_MAKER).toBe("jev");
    expect(config).not.toHaveProperty("WRITER_ROUTE");
    expect(config).not.toHaveProperty("INTENT_ROUTE");
  });

  it("the helper's start takes its writers from writersOnStart only", () => {
    const main = src("main.ts");
    expect(main).toContain("writersOnStart(");
    expect(main).not.toMatch(/GROQ_|CANDIDATES|devWriterRoute|makeWriterPort/);
    // Outside writer/, no source file names a Groq route or the helper's old defaults.
    for (const f of ["helper.ts", "planner/ask.ts", "planner/intent-makers.ts", "goals/propose.ts", "codemode/sandbox.ts"]) expect(src(f), f).not.toMatch(/GROQ_|api\.groq\.com|WRITER_ROUTE|INTENT_ROUTE/);
  });

  it("uses a Groq route only when a developer names it, and says so", () => {
    const said: string[] = [];
    const w = writersOnStart("groq:qwen/qwen3.8-27b", (l) => void said.push(l), { GROQ_API_KEY: "gsk-not-real" });
    expect(w.plan?.route).toMatchObject({ provider: "groq", model: "qwen/qwen3.8-27b" });
    expect(w.ask).toEqual({ maker: "jev" });
    expect(said).toEqual(["DEVELOPER FLAG --dev-writer: plan and goal programs go to groq qwen/qwen3.8-27b. This is not a default path."]);
  });

  it("a named route without its key stops the start, naming the key and never its value", () => {
    expect(() => writersOnStart("groq:openai/gpt-oss-120b", () => {}, { AI_GATEWAY_API_KEY: "vck-not-real" })).toThrow("--dev-writer groq:openai/gpt-oss-120b cannot start: GROQ_API_KEY missing");
  });

  it("a route nobody listed is an error that lists the routes", () => {
    expect(() => writersOnStart("groq:llama-3.3-70b", () => {}, {})).toThrow(/is not a route: name one of groq:openai\/gpt-oss-120b, .*gateway:inclusionai\/ling-3.1-flash-free/);
    expect(() => writersOnStart("qwen/qwen3.8-27b", () => {}, {})).toThrow("is not a route");
    expect(() => writersOnStart("gateway:some/paid-model", () => {}, {})).toThrow("Vercel AI Gateway model 'some/paid-model' has no route here");
  });
});

describe("a goal with no program writer", () => {
  it("says plainly that it is not available, and calls no model", async () => {
    const fetches: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      fetches.push(String(url));
      throw new Error("no network in this test");
    });
    const jev = standInJev();
    const sc = goalScene({ scripts: [], windows: [mailWindow(), replyWindow()], userWindow: "6161-2", writer: null, askJev: jev });
    const r = await sc.request('draft a reply to Priya saying "I\'m in"');
    expect(r).toMatchObject({ type: "goalProgress", v: PROTOCOL_VERSION, event: "stopped", reason: "refused", says: SAYS.noPlanWriter });
    expect(sc.writer.requests).toHaveLength(0);
    expect(jev.calls).toBe(0);
    expect(fetches).toEqual([]);
    await sc.close();
  });
});
