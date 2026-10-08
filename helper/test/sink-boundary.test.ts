// The seal boundary (OUTPUT-LEDGER-SPEC section 6): each sink renders its complete final body first, then validates
// it, then measures and admits it; transports and stores only copy the sealed bytes. Sol review of 9d110306, P1 and P2.
// Every name and value is invented; providers are stubs.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { Disclosure, UnmintedText } from "../src/privacy/disclosure.ts";
import { seal, sendable, storedLine, type StoreRecord } from "../src/privacy/send.ts";
import { chat, chatSink, type ChatRoute } from "../src/writer/chat.ts";
import { snap, text } from "./builders.ts";

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
