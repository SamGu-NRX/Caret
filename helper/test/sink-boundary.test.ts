// The seal boundary (OUTPUT-LEDGER-SPEC section 6): each sink renders its complete final body first, then validates
// it, then measures and admits it; transports and stores only copy the sealed bytes.
// Every name and value is invented; providers are stubs.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { Disclosure, LedgerRefused, OutOfShape, UnmintedText } from "../src/privacy/disclosure.ts";
import { seal, sendable, storedLine, type Sink, type StoreRecord } from "../src/privacy/send.ts";
import { llamaEngine } from "../src/engines/decide/llama.ts";
import type { JevRequest } from "../src/fill/jev.ts";
import { chat, chatSink, type ChatRoute } from "../src/writer/chat.ts";
import { PLAN_SYSTEM, PLAN_WORDING, planUserMessage, PlanInputSchema } from "../src/writer/plan-prompt.ts";
import { snap, text } from "./builders.ts";
import { redactWindow as redactOf } from "../src/fill/redact.ts";

const ROUTE: ChatRoute = {
  provider: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  keyName: "GROQ_API_KEY",
  model: "test-model",
  maxTokensParam: "max_tokens",
  extraBody: {},
  pricing: { inputUsdPerMTok: 0, outputUsdPerMTok: 0, source: "test" },
};

/** A writer request over one note, and a fetch that records every body it is given. */
function desk() {
  const m = new ScreenModel();
  m.apply(snap([text("n0", "Dana Whitfield"), text("n1", "Lumen Labs")], { at: 1, windowId: "note-1", title: "Notes", app: { pid: 6161, bundleId: "dev.caret.notes", name: "Notes" } }));
  const d = new Disclosure(m);
  const goal = d.instruction("put Dana Whitfield in the name field");
  const req = d.seal({ kind: "plan", disclosureId: "t1", disclosed: [], input: { goal, snapshots: [{ snapshot: d.id("s1"), window: d.id("w1"), revision: d.id("r1"), title: d.own(""), targets: [], values: [], questions: [] }] }, maxOutputTokens: 100, signal: new AbortController().signal });
  const bodies: string[] = [];
  const fetchFn = (async (_u: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ model: "w", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  return { m, d, req, bodies, fetchFn };
}

describe("a chat sink's final body", () => {
  it("is refused when its render carries text that is neither minted nor the sink's own wording, and nothing is posted", async () => {
    const { req, bodies, fetchFn } = desk();
    const huge = "zq ".repeat(33_334);
    expect(() => seal({ writer: req }, chatSink(ROUTE, () => [{ role: "user", content: huge }], [], 100))).toThrow(UnmintedText);
    expect(bodies).toEqual([]);
    void fetchFn;
  });

  it("is refused when its envelope carries a value in a format Caret never carries", () => {
    const { req } = desk();
    const route = { ...ROUTE, extraBody: { secret: "4111 1111 1111 1111" } };
    expect(() => seal({ writer: req }, chatSink(route, () => [{ role: "user", content: "Plan:" }], ["Plan"], 100))).toThrow(UnmintedText);
  });

  it("posts exactly the sealed bytes, rendered once", async () => {
    const { req, bodies, fetchFn } = desk();
    const sealed = seal({ writer: req }, chatSink(ROUTE, (w) => [{ role: "user", content: `Plan: ${JSON.stringify(w)}` }], ["Plan"], 100));
    await chat(ROUTE, "k", sealed, new AbortController().signal, fetchFn);
    expect(bodies).toEqual([sealed.bytes]);
    expect(sendable(sealed)).toBe(sealed.bytes);
  });
});

describe("what a seal commits", () => {
  const MESSAGES = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
  it("commits nothing when the sink's render fails, so a later request has the conversation's whole limit", () => {
    const m = new ScreenModel();
    const lines = ["the deposit is due on the sixteenth of the month", "and the venue holds the date for us until then", "bring the signed contract to the front desk"];
    // Minted from a note; the chat that shows the same lines opens afterwards, so only the seal measures them against it.
    m.apply(snap(lines.map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-1", title: "Notes", app: { pid: 6161, bundleId: "dev.caret.notes", name: "Notes" } }));
    const d = new Disclosure(m);
    const said = lines.map((l) => d.heldText(l)!);
    m.apply(snap(lines.map((l, i) => text(`c${i}`, l)), { at: 2, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    const ask = (i: number) => ({ req: { purpose: "route.task", disclosure: d }, wire: { state: { offer: { found: said[i]! } }, questions: {} } });
    const broken = { name: "broken", render: (): never => { throw new Error("the renderer failed"); }, envelope: {}, wording: [] };
    // T = 4 + 48 + 46 + 43 = 141, limit 70: each of the first two lines fits alone, not both.
    expect(() => seal(ask(0), broken)).toThrow("the renderer failed");
    expect(seal(ask(1)).charged["chat-1"]).toBe(46);
    // Sealed for real, the first takes the rest of the operation's share.
    expect(() => seal(ask(0))).toThrow(/with the requests sent before it/u);
  });
});

describe("a store's record", () => {
  const RECORD: Omit<StoreRecord, "build"> = { name: "test log", envelope: { body: { kind: "wire" }, latencyMs: { kind: "scalar", types: ["number"] }, note: { kind: "rendered", max: 200 } }, wording: [] };
  const sealed = () => {
    const m = new ScreenModel();
    m.apply(snap([text("n0", "Dana Whitfield")], { at: 1, windowId: "note-1", title: "Notes", app: { pid: 6161, bundleId: "dev.caret.notes", name: "Notes" } }));
    const d = new Disclosure(m);
    return seal({ req: { purpose: "route.task", disclosure: d }, wire: { state: { task: d.own("Route the user's note.") }, questions: {} } });
  };

  it("is validated whole: the sealed body, and nothing beside it its envelope does not name", () => {
    const s = sealed();
    expect(storedLine(s, { ...RECORD, build: (w) => ({ body: w, latencyMs: 4 }) })).toContain("latencyMs");
    expect(() => storedLine(s, { ...RECORD, build: (w) => ({ body: w, latencyMs: 4, extra: "anything" }) })).toThrow(UnmintedText);
    expect(() => storedLine(s, { ...RECORD, build: (w) => ({ body: { ...(w as object), added: 1 }, latencyMs: 4 }) })).toThrow(UnmintedText);
  });

  it("holds request text only as the request's own: a rendered note of screen text that was never minted is refused", () => {
    const s = sealed();
    expect(storedLine(s, { ...RECORD, build: (w) => ({ body: w, note: "Route the user's note." }) })).toContain("note");
    expect(() => storedLine(s, { ...RECORD, build: (w) => ({ body: w, note: "Dana Whitfield" }) })).toThrow(UnmintedText);
  });
});

const NOTES_APP = { pid: 6161, bundleId: "dev.caret.notes", name: "Notes" };
const MESSAGES_APP = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };

describe("what the final bytes say", () => {
  /** A sink that sends the wire as one chat message, `Ask: <the wire as JSON>`. */
  const CHAT_LIKE: Sink = {
    name: "test chat",
    render: (w) => ({ messages: [{ role: "user", content: `Ask: ${JSON.stringify(w)}` }] }),
    envelope: { "messages[*].role": { kind: "config", max: 20 }, "messages[*].content": { kind: "rendered", max: 10_000 } },
    wording: ["Ask", "user"],
  };

  it("measures a declared JSON layer's text inside a rendered message: the chat's line is charged, over its limit", () => {
    // Quotes every few characters: escaped twice inside the message, they cut every run; decoded, the line is whole.
    const line = `say "abcdefghij" then "klmnopqrs" ok`;
    const m = new ScreenModel();
    m.apply(snap([text("n0", line)], { at: 1, windowId: "note-1", title: "Note", app: NOTES_APP }));
    const d = new Disclosure(m);
    const view = m.windows.get("note-1")!;
    const said = d.candidate(redactOf(view), line);
    const state = d.jsonText({ offer: { found: said! } });
    // The chat opens after the value was minted. T = 4 + 36 + 1 = 41, limit 20.
    m.apply(snap([text("c0", line), text("c1", "x")], { at: 2, windowId: "chat-1", title: "Kofi", app: MESSAGES_APP }));
    expect(() => seal({ req: { purpose: "route.task", disclosure: d }, wire: { state, questions: {} } }, CHAT_LIKE)).toThrow(/reveals 36 characters of window chat-1, over its limit of 20/u);
  });

  it("measures the decoded wire strings a rendered message embeds: a plan quoting a minted line is charged the chat's line, over its limit", () => {
    // planUserMessage writes the source values as JSON inside the message, so the line's quotes are escaped there and cut
    // every run; the wire string the message embeds is the line whole.
    const line = `say "abcdefghij" then "klmnopqrs" ok`;
    const m = new ScreenModel();
    m.apply(snap([text("n0", line)], { at: 1, windowId: "note-1", title: "Note", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" } }));
    const d = new Disclosure(m);
    const said = d.candidate(redactOf(m.windows.get("note-1")!), line)!;
    // The chat opens before the first seal. T = 4 + 36 + 1 = 41, limit 20. Charged 37: the line's 36, and the 1 the escaped
    // rendering alone was charged.
    m.apply(snap([text("c0", line), text("c1", "x")], { at: 2, windowId: "chat-1", title: "Kofi", app: MESSAGES_APP }));
    const goal = d.instruction("fill the form");
    const req = d.seal({ kind: "plan", disclosureId: "t1", disclosed: [], input: { goal, snapshots: [{ snapshot: d.id("s1"), window: d.id("w1"), revision: d.id("r1"), title: d.own(""), targets: [], values: [{ ref: d.id("v1"), display: said, origin: { kind: d.own("span"), snapshot: d.id("s1"), source: d.own("n0"), startUTF16: 0, endUTF16: 36, digest: d.id("g1") } }], questions: [] }] }, maxOutputTokens: 100, signal: new AbortController().signal });
    const messages = (wire: unknown) => [{ role: "system" as const, content: PLAN_SYSTEM }, { role: "user" as const, content: planUserMessage(PlanInputSchema.parse(wire)) }];
    expect(() => sendable(seal({ writer: req }, chatSink(ROUTE, messages, [PLAN_SYSTEM, ...PLAN_WORDING], 100)))).toThrow(/reveals 37 characters of window chat-1, over its limit of 20/u);
  });

  it("measures the embedded wire strings again as the bytes leave: a chat opened after the plan's seal refuses them", () => {
    const line = `say "abcdefghij" then "klmnopqrs" ok`;
    const m = new ScreenModel();
    m.apply(snap([text("n0", line)], { at: 1, windowId: "note-1", title: "Note", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" } }));
    const d = new Disclosure(m);
    const said = d.candidate(redactOf(m.windows.get("note-1")!), line)!;
    const goal = d.instruction("fill the form");
    const req = d.seal({ kind: "plan", disclosureId: "t1", disclosed: [], input: { goal, snapshots: [{ snapshot: d.id("s1"), window: d.id("w1"), revision: d.id("r1"), title: d.own(""), targets: [], values: [{ ref: d.id("v1"), display: said, origin: { kind: d.own("span"), snapshot: d.id("s1"), source: d.own("n0"), startUTF16: 0, endUTF16: 36, digest: d.id("g1") } }], questions: [] }] }, maxOutputTokens: 100, signal: new AbortController().signal });
    const messages = (wire: unknown) => [{ role: "system" as const, content: PLAN_SYSTEM }, { role: "user" as const, content: planUserMessage(PlanInputSchema.parse(wire)) }];
    const sealed = seal({ writer: req }, chatSink(ROUTE, messages, [PLAN_SYSTEM, ...PLAN_WORDING], 100));
    m.apply(snap([text("c0", line), text("c1", "x")], { at: 2, windowId: "chat-1", title: "Kofi", app: MESSAGES_APP }));
    expect(() => sendable(sealed)).toThrow(/reveals 37 characters of window chat-1, over its limit of 20/u);
  });

  it("sends the bytes it validated: a body whose toJSON adds a field is refused, and nothing is posted", async () => {
    const { req, bodies, fetchFn } = desk();
    // Its toJSON is on its class, so walking its own keys does not see it; serializing it does.
    class Sneaky {
      role = "user";
      content = "Plan:";
      toJSON(): unknown {
        return { role: "user", content: "Plan:", card: "4111 1111 1111 1111" };
      }
    }
    const sneaky = new Sneaky();
    expect(() => seal({ writer: req }, chatSink(ROUTE, () => [sneaky as never], ["Plan"], 100))).toThrow(OutOfShape);
    expect(bodies).toEqual([]);
    void fetchFn;
  });

  it("refuses a number that does not serialize as itself: NaN and Infinity", () => {
    const { d } = deskWith();
    const sink = (n: number): Sink => ({ name: "test", render: (w) => ({ body: w, n }), envelope: { body: { kind: "wire" }, n: { kind: "scalar", types: ["number"] } }, wording: [] });
    const out = { req: { purpose: "route.task", disclosure: d }, wire: { state: { task: d.own("Route the note.") }, questions: {} } };
    expect(() => seal(out, sink(Number.NaN))).toThrow(OutOfShape);
    expect(() => seal(out, sink(Number.POSITIVE_INFINITY))).toThrow(OutOfShape);
    expect(seal(out, sink(3)).bytes).toContain('"n":3');
  });

  it("writes the record it validated: a store answer whose toJSON adds a value is refused", () => {
    const { d } = deskWith();
    const s = seal({ req: { purpose: "route.task", disclosure: d }, wire: { state: { task: d.own("Route the note.") }, questions: {} } });
    const record: StoreRecord = {
      name: "test log",
      envelope: { body: { kind: "wire" }, answer: { kind: "answer", max: 200 } },
      wording: [],
      build: (w) => ({ body: w, answer: { toJSON: () => "4111 1111 1111 1111" } }),
    };
    expect(() => storedLine(s, record)).toThrow(OutOfShape);
  });
});

describe("a request's empty containers", () => {
  it("refuses an object or a list where its shape has a string, even an empty one", () => {
    const { d } = deskWith();
    expect(() => d.seal({ purpose: "route.task", state: { task: {} as never }, questions: {} })).toThrow(OutOfShape);
    expect(() => d.seal({ purpose: "route.task", state: { task: [] as never }, questions: {} })).toThrow(OutOfShape);
    expect(() => d.seal({ purpose: "route.task", state: {}, questions: {} })).not.toThrow();
  });
});

describe("a queued local-model request", () => {
  it("commits nothing until its sink's final admission: a refused template leaves the next request the chat's whole limit", async () => {
    const m = new ScreenModel();
    const lines = ["the deposit is due on the sixteenth of the month", "and the venue holds the date for us until then", "bring the signed contract to the front desk"];
    m.apply(snap(lines.map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-1", title: "Notes", app: NOTES_APP }));
    const d = new Disclosure(m);
    const said = lines.map((l) => d.heldText(l)!);
    // T = 4 + 48 + 46 + 43 = 141, limit 70: each of the first two lines fits alone, not both.
    m.apply(snap(lines.map((l, i) => text(`c${i}`, l)), { at: 2, windowId: "chat-1", title: "Kofi", app: MESSAGES_APP }));
    const ask = (i: number): JevRequest =>
      d.seal({ purpose: "route.task", state: { offer: { found: said[i]! } }, questions: { q: { type: "choice", instructions: d.own("Is it?"), criteria: { a: d.own("yes"), b: d.own("no") } } }, snippets: [], charged: {} }) as unknown as JevRequest;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: { content: string }[] };
      if (url.endsWith("/apply-template")) return new Response(JSON.stringify({ prompt: `<user>${body.messages?.[1]?.content}</user><assistant>` }));
      return new Response(JSON.stringify({ completion_probabilities: [{ top_logprobs: [{ token: "A", logprob: Math.log(0.9) }, { token: "B", logprob: Math.log(0.1) }] }], timings: { prompt_n: 6 } }));
    }) as unknown as typeof fetch;
    // The template's own arguments carry a value in a format Caret never carries: its sink refuses.
    const refusing = llamaEngine({ url: "http://x", model: "m", prompt: "chat", templateKwargs: { note: "4111 1111 1111 1111" }, fetchImpl });
    await expect(refusing.ask(ask(0))).rejects.toThrow(OutOfShape);
    const fine = llamaEngine({ url: "http://x", model: "m", prompt: "chat", fetchImpl });
    const r = await fine.ask(ask(1));
    expect(r.answers.q?.choice).toBe("a");
    void LedgerRefused;
  });
});

/** A note's Disclosure, for requests that carry Caret's own words. */
function deskWith(): { m: ScreenModel; d: Disclosure } {
  const m = new ScreenModel();
  m.apply(snap([text("n0", "Dana Whitfield")], { at: 1, windowId: "note-1", title: "Notes", app: NOTES_APP }));
  return { m, d: new Disclosure(m) };
}
