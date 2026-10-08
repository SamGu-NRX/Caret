import { beforeEach as vercelBeforeEach, afterEach as vercelAfterEach, vi as vercelVi } from "vitest";
// L1: the models Sam chose. No default path calls Groq or any chat provider: the helper starts with no program writer
// and Jev makes Ask's intents. A route runs only when a developer names it, and the helper says so on start. A goal
// that needs a program writer says plainly that it is not available, and no model is called.
import { minted } from "./minted.ts";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as config from "../src/writer/config.ts";
import { writersOnStart } from "../src/writer/startup.ts";
import { devWriterRoute, gatewayRoute } from "../src/writer/routes.ts";
import { SAYS } from "../src/planner/says.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { GatewayNeedsCard } from "../src/writer/chat.ts";
import { makeWriterPort } from "../src/writer/port.ts";
import { goalRefusals, goalScene, mailWindow, replyWindow, standInJev } from "./goal-desk.ts";
import { DRAFT_GRAMMAR } from "../src/writer/local-draft.ts";
import { LocalModelUnavailable, type LocalModelPort, type LocalTextAsk } from "../src/writer/local-port.ts";
import { FORM } from "./codemode/fixtures.ts";

const src = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

afterEach(() => vi.unstubAllGlobals());

describe("no Groq call on any default path", () => {
  it("starts with no program writer and Jev for Ask, and never reads GROQ_API_KEY", () => {
    const said: string[] = [];
    // An environment with every key set that records each read: the default start reads none of them.
    const read: string[] = [];
    const keys: Record<string, string> = { GROQ_API_KEY: "gsk-not-real", AI_GATEWAY_API_KEY: "vck-not-real", TYPESAFE_API_KEY: "ts-not-real", CARET_ENV_FILE: "/nonexistent/.env" };
    const env = new Proxy(keys, { get: (t, k) => (typeof k === "string" && read.push(k), t[k as string]) });
    const w = writersOnStart(undefined, (l) => void said.push(l), env);
    expect(w.plan).toBeNull();
    // P1: Jev in one request (planner/intent-heads.ts) is the default maker since it beat the staged one.
    expect(w.ask).toEqual({ maker: "heads" });
    expect(read).toEqual([]);
    expect(said.join("\n")).not.toMatch(/groq/i);
  });

  it("configures Jev as Ask's maker and keeps no default chat route", () => {
    expect(config.ASK_MAKER).toBe("heads");
    expect(config.WRITER_ROUTE).toBeNull();
    expect(config.INTENT_ROUTE).toBeNull();
  });

  it("the helper's start takes its writers from writersOnStart only", () => {
    const main = src("main.ts");
    expect(main).toContain("writersOnStart(");
    expect(main).not.toMatch(/GROQ_|CANDIDATES|devWriterRoute|makeWriterPort|WRITER_ROUTE|INTENT_ROUTE/);
    // Outside writer/, no source file names a Groq route or the helper's old defaults.
    for (const f of ["helper.ts", "planner/ask.ts", "planner/intent-makers.ts", "goals/propose.ts", "codemode/sandbox.ts"]) expect(src(f), f).not.toMatch(/GROQ_|api\.groq\.com|WRITER_ROUTE|INTENT_ROUTE/);
    // The routes a developer may name live apart from writer/config.ts, and none of them is configured.
    expect(src("writer/routes.ts")).not.toMatch(/export const \w+: ChatRoute =/);
  });

  it("uses a Groq route only when a developer names it, and says so", () => {
    const said: string[] = [];
    const w = writersOnStart("groq:qwen/qwen3.8-27b", (l) => void said.push(l), { GROQ_API_KEY: "gsk-not-real" });
    expect(w.plan?.route).toMatchObject({ provider: "groq", model: "qwen/qwen3.8-27b" });
    expect(w.ask).toEqual({ maker: "heads" });
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

describe("Vercel AI Gateway route", () => {
  const KEY = "vck-test-not-a-real-key";
  const fake = (status: number, body: unknown, seen: { url: string; body: Record<string, unknown>; auth: string }[] = []): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth: (init?.headers as Record<string, string>).Authorization ?? "" });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  const plan = minted({ kind: "plan" as const, disclosureId: "l1", input: { goal: "Sign me up", snapshots: [FORM] }, maxOutputTokens: 16, signal: new AbortController().signal });
  // The body the gateway sent on 2026-10-05 for a free model, with the key added to show it is never echoed.
  const card = { error: { message: `AI Gateway requires a valid credit card on file to service requests. key=${KEY}`, type: "customer_verification_required" } };

  it("is chosen by model id, goes to the OpenAI-compatible endpoint and reads AI_GATEWAY_API_KEY", async () => {
    const seen: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    const route = devWriterRoute("gateway:inclusionai/ling-3.1-flash-free");
    expect(route).toMatchObject({ provider: "gateway", keyName: "AI_GATEWAY_API_KEY", model: "inclusionai/ling-3.1-flash-free" });
    const ok = { model: "inclusionai/ling-3.1-flash-free", choices: [{ message: { content: "```ts\nasync function main(caret) {}\n```" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    const w = await makeWriterPort(route, { key: () => KEY, fetchFn: fake(200, ok, seen) }).write(plan);
    expect(seen[0]).toMatchObject({ url: "https://ai-gateway.vercel.sh/v1/chat/completions", auth: `Bearer ${KEY}` });
    expect(seen[0]!.body).toMatchObject({ model: "inclusionai/ling-3.1-flash-free", max_tokens: 16 });
    expect(w).toMatchObject({ provider: "gateway", model: "inclusionai/ling-3.1-flash-free", costUsd: 0 });
  });

  it("surfaces a 403 'credit card on file' as its own error, even for a free model", async () => {
    const err = await makeWriterPort(gatewayRoute("poolside/laguna-s-2.1-free"), { key: () => KEY, fetchFn: fake(403, card) }).write(plan).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayNeedsCard);
    expect((err as Error).message).toBe("Vercel AI Gateway needs a card on file, even for free models");
    expect(err).toMatchObject({ provider: "gateway", status: 403 });
    expect(String(err)).not.toContain(KEY);
  });

  it("leaves any other 403, and the same words from another provider, as the provider's own error", async () => {
    const other = await makeWriterPort(gatewayRoute("poolside/laguna-s-2.1-free"), { key: () => KEY, fetchFn: fake(403, { error: { message: "model not allowed", type: "forbidden" } }) }).write(plan).catch((e: unknown) => e);
    expect(other).not.toBeInstanceOf(GatewayNeedsCard);
    expect(String(other)).toContain("gateway HTTP 403 forbidden: model not allowed");
    const groq = await makeWriterPort(config.GROQ_QWEN_3_8_27B, { key: () => KEY, fetchFn: fake(403, card) }).write(plan).catch((e: unknown) => e);
    expect(groq).not.toBeInstanceOf(GatewayNeedsCard);
  });
});

describe("drafts from the local model (lead decision 6; measured, on no default path)", () => {
  const MAIL_TITLE = "Order ORD-2026-48213 arrived damaged";
  /** A program that drafts the reply's Message from the mail; its own text is a placeholder the local model replaces. */
  const drafting = [[{ draft: { window: "Re: Order", target: "Message", text: "(the program's own words)", from: [MAIL_TITLE] } }]];
  /** A LocalModelPort that answers `text` and keeps every request. */
  const port = (text: string | Error): LocalModelPort & { asks: LocalTextAsk[] } => {
    const asks: LocalTextAsk[] = [];
    return {
      via: "tool",
      asks,
      async complete(ask) {
        asks.push(ask);
        if (text instanceof Error) throw text;
        return { model: "gemma-test.gguf", text, latencyMs: 120, promptTokens: 400, outputTokens: 12, stop: "eog" };
      },
    };
  };
  const scene = (drafter: LocalModelPort) => goalScene({ scripts: structuredClone(drafting), windows: [mailWindow(), replyWindow()], userWindow: "6161-2", askJev: standInJev(), drafter });

  it("asks for a draft under the sentence grammar, from the mail it names, and offers the local text", async () => {
    const local = port("Hi Priya, I'm in.");
    const sc = scene(local);
    const r = await sc.request('draft a reply to Priya saying "I\'m in"');
    expect(r).toMatchObject({ event: "segment" });
    expect(local.asks).toHaveLength(1);
    expect(local.asks[0]).toMatchObject({ kind: "draft", grammar: DRAFT_GRAMMAR, prompt: { field: { name: "Message" } } });
    expect(local.asks[0]!.prompt.basis[0]).toMatch(new RegExp(`^${MAIL_TITLE}\\n`));
    const steps = (r as Extract<typeof r, { event: "segment" }>).steps;
    expect(steps.find((s) => s.drafted !== undefined)?.drafted).toBe("Hi Priya, I'm in.");
    expect(JSON.stringify(r)).not.toContain("the program's own words");
    await sc.close();
  });

  it("still refuses a local draft that adds a fact, and writes nothing", async () => {
    const sc = scene(port("Hi Priya, I'm in and I'll bring the spare lamp on Friday at 5 PM."));
    const r = await sc.request('draft a reply to Priya saying "I\'m in"');
    expect(r).toMatchObject({ event: "stopped", reason: "refused" });
    expect(goalRefusals(sc, "draft")).toBe(1);
    expect(sc.desk.writes).toEqual([]);
    await sc.close();
  });

  it("says the local model failed, and never offers the program's own text instead", async () => {
    const sc = scene(port(new LocalModelUnavailable("busy", "the host's local model answered busy")));
    const r = await sc.request('draft a reply to Priya saying "I\'m in"');
    expect(r).toMatchObject({ event: "stopped", reason: "refused", says: "Caret's local model couldn't write the draft just now" });
    expect(JSON.stringify(sc.goals)).not.toContain("the program's own words");
    await sc.close();
  });

  it("refuses a draft the model cut off at its cap", async () => {
    const cut: LocalModelPort = { via: "tool", complete: async () => ({ model: "m", text: "Hi Priya, I'm in.", latencyMs: 1, promptTokens: 1, outputTokens: 96, stop: "maxTokens" }) };
    const r = await scene(cut).request('draft a reply to Priya saying "I\'m in"');
    expect(r).toMatchObject({ event: "stopped", reason: "refused", says: "The draft ran past its length, so Caret left it out" });
  });
});

// These provider-shaping tests use fake transports; gateway execution requires an explicit dev opt-in.
vercelBeforeEach(() => { vercelVi.stubEnv("CARET_DEV_VERCEL_GEMINI", "1"); vercelVi.stubEnv("CARET_RELEASE_HOST", "0"); });
vercelAfterEach(() => vercelVi.unstubAllEnvs());
