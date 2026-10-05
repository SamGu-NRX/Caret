// B29: the Ask question protocol. fixtures/golden/ask-choices.ndjson is the contract the host (H5/H6) builds against:
// a hello that declares "askChoices", a planRequest answered with a question, the answer, a second question, the
// proposal, a person question, and an answer to a question already answered. Then the helper's side: who gets a
// question, who may answer it, and that an answer is taken once and only as listed. All text is synthetic.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnyMessage, ASK_CHOICES_CAPABILITY, AskQuestion, ConsumerMessage, HelperMessage, PlanProposal, PROTOCOL_VERSION, type AskAnswer } from "../src/protocol.ts";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { WRITER_ROUTE } from "../src/writer/config.ts";
import type { WriterRequest } from "../src/writer/port.ts";
import { SAYS } from "../src/planner/says.ts";
import { MAIL_APP, snap, text } from "./builders.ts";
import { executorWindow, FakeApp, K, wireButtons } from "./fake-app.ts";
import { LineClient } from "./socket-reader.ts";

const lines = readFileSync(new URL("../fixtures/golden/ask-choices.ndjson", import.meta.url), "utf8").trim().split("\n");
const CONSUMER = new Set(["hello", "planRequest", "askAnswer"]);
const at = (i: number): Record<string, unknown> => JSON.parse(lines[i] as string) as Record<string, unknown>;

describe("the ask-choices protocol lines", () => {
  it("parses every golden line and writes it back byte for byte", () => {
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(["hello", "planRequest", "askQuestion", "askAnswer", "askQuestion", "askAnswer", "planProposal", "askQuestion", "askAnswer", "planProposal"]);
    for (const l of lines) {
      const m = JSON.parse(l) as { type: string };
      expect(JSON.stringify((CONSUMER.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), m.type).toBe(l);
    }
  });

  it("refuses the shapes the contract rules out", () => {
    const bad = (m: unknown): boolean => !AnyMessage.safeParse(m).success;
    const fields = at(2) as { options: Record<string, unknown>[] };
    const source = at(4);
    expect(bad({ ...fields, pick: "one" })).toBe(true);
    expect(bad({ ...source, pick: "many" })).toBe(true);
    expect(bad({ ...source, options: fields.options })).toBe(true);
    expect(bad({ ...fields, options: [fields.options[0], fields.options[0]] })).toBe(true);
    expect(bad({ ...fields, options: Array.from({ length: 9 }, (_, i) => ({ kind: "field", id: `o${i + 1}`, label: `F${i}`, section: null })) })).toBe(true);
    expect(bad({ ...fields, options: [] })).toBe(true);
    expect(bad({ ...at(7), options: [{ kind: "field", id: "o1", label: "Name", section: null }] })).toBe(true);
    // An option names what the user sees, never a field key or window id.
    expect(AskQuestion.parse({ ...fields, options: [{ ...fields.options[0], key: "f0/x" }] }).options[0]).not.toHaveProperty("key");
    expect(bad({ ...at(3), picks: [] })).toBe(true);
    expect(bad({ ...at(3), questionId: "" })).toBe(true);
  });
});

// The fake app's form (Name, Email, a Billing and a Shipping City) beside a mail that shows an order's city.
const REF = "5150-3";
function mailWindow(): ReturnType<typeof snap> {
  const M = (s: string): string => `dev.caret.mail/standard/${s}`;
  return snap([text(M("statictext:ship to: austin~0"), "Ship to: Austin"), text(M("statictext:city: austin~0"), "City: Austin")], { at: 500, windowId: REF, title: "Order 48213", app: MAIL_APP });
}

/** An intent writer that leaves the fields open, and a Jev that picks Austin for a City field and calls it the user's. */
const openFields = {
  route: WRITER_ROUTE,
  write: async (_: WriterRequest) => {
    const json = { route: "ask", why: "whichFields", scope: "none", section: "none", fields: [], sources: ["any"], whose: "user", literals: [] };
    return { model: "fake", provider: "groq", output: { program: null, reply: JSON.stringify(json), json }, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, latencyMs: 1, costUsd: 0 };
  },
};
const cityJev: AskJev = async (req) => {
  const answers = Object.fromEntries(
    Object.entries(req.questions).map(([id, q]) => {
      if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user", confidence: 0.9 }];
      const hit = String(q.instructions).includes("'City'") ? Object.entries(q.criteria).find(([, d]) => d?.startsWith('"Austin"'))?.[0] : undefined;
      return [id, { choice: hit ?? "none", confidence: 0.9 }];
    }),
  );
  return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
};

describe("Ask questions in the helper (B29)", () => {
  let dir: string;
  let store: Store;
  let memory: MemoryStore;
  let app: FakeApp;
  let helper: Helper;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-ask-choices-"));
    store = new Store(join(dir, "data"));
    memory = new MemoryStore(join(dir, "data"));
    app = new FakeApp(executorWindow());
    wireButtons(app);
    app.enforceGrants = true;
    clock = 10_000;
    helper = new Helper({ store, memory, askJev: cityJev, shadow: false, allowBackgroundFocus: false, publish: () => {}, readerLink: app, now: () => clock, ask: { maker: "writer", writer: openFields } });
    app.helper = helper;
    app.show();
    void helper.handleReader(mailWindow());
  });
  afterEach(() => {
    helper.shutdown();
    memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const request = { type: "planRequest", v: PROTOCOL_VERSION, requestId: "r1", at: 1, instruction: "fill in the city", windowId: "5150-7" } as const;
  const answer = (questionId: string, picks: string[], requestId = "r2"): AskAnswer => ({ type: "askAnswer", v: PROTOCOL_VERSION, requestId, at: 2, questionId, picks });

  it("asks a consumer that can answer, and refuses with the same sentence as before to one that cannot", async () => {
    const old = await helper.handlePlanRequest(request);
    expect(PlanProposal.parse(old)).toMatchObject({ outcome: "error", error: { code: "unsure", detail: SAYS.whichFields } });
    const q = AskQuestion.parse(await helper.handlePlanRequest({ ...request, requestId: "r3" }, "s1", true));
    expect(q).toMatchObject({ requestId: "r3", part: "fields", pick: "many", text: "Which fields should Caret fill?", window: { windowId: "5150-7" }, expires: clock + 10 * 60 * 1000 });
    expect(q.options).toEqual([
      { kind: "field", id: "o1", label: "City", section: "Billing" },
      { kind: "field", id: "o2", label: "City", section: "Shipping" },
    ]);
  });

  it("continues with the picked field only, proposes it without acting, and writes it only when accepted", async () => {
    const q = AskQuestion.parse(await helper.handlePlanRequest(request, "s1", true));
    const r = PlanProposal.parse(await helper.handleAskAnswer(answer(q.questionId, ["o2"]), "s1"));
    expect(r).toMatchObject({ requestId: "r2", outcome: "proposed", error: null });
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(0);
    expect(await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: r.offerKey ?? "", actionId: "run", overrides: {}, at: clock })).toMatchObject({ outcome: "done", acted: 1 });
    expect(app.node(K("group:shipping/textfield:city~0"))?.value).toBe("Austin");
    expect(app.node(K("group:billing/textfield:city~0"))?.value).toBeUndefined();
  });

  it("takes an answer once, from the connection asked, before it lapses, and only as listed", async () => {
    const q = AskQuestion.parse(await helper.handlePlanRequest(request, "s1", true));
    const gone = (r: unknown) => expect(PlanProposal.parse(r)).toMatchObject({ outcome: "error", error: { code: "questionGone" } });
    gone(await helper.handleAskAnswer(answer(q.questionId, ["o1"]), "s2"));
    gone(await helper.handleAskAnswer(answer("ask-99-r1", ["o1"]), "s1"));
    // A pick it did not list is refused, and the question is spent.
    expect(PlanProposal.parse(await helper.handleAskAnswer(answer(q.questionId, ["o1", "o9"]), "s1"))).toMatchObject({ outcome: "error", error: { code: "schema" } });
    gone(await helper.handleAskAnswer(answer(q.questionId, ["o1"]), "s1"));
    const late = AskQuestion.parse(await helper.handlePlanRequest({ ...request, requestId: "r4" }, "s1", true));
    clock += 10 * 60 * 1000;
    gone(await helper.handleAskAnswer(answer(late.questionId, ["o1"]), "s1"));
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(0);
  });

  it("drops every open question when the reader restarts", async () => {
    const q = AskQuestion.parse(await helper.handlePlanRequest(request, "s1", true));
    void helper.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "t" });
    expect(PlanProposal.parse(await helper.handleAskAnswer(answer(q.questionId, ["o1"]), "s1"))).toMatchObject({ outcome: "error", error: { code: "questionGone" } });
  });
});

describe("askAnswer on the socket", () => {
  it("is refused by name from a consumer that did not declare the capability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-ask-sock-"));
    const store = new Store(join(dir, "data"));
    const server: HelperServer = new HelperServer(join(dir, "screen.sock"), () => helper, () => {});
    const helper: Helper = new Helper({ store, askJev: () => Promise.reject(new Error("no Jev here")), shadow: false, allowBackgroundFocus: false, publish: (m) => server.publish(m) });
    await server.listen();
    try {
      const c = await LineClient.connect(join(dir, "screen.sock"));
      c.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "old-host", host: true });
      c.send(at(3));
      const e = await c.waitFor((m) => m.type === "error" && String(m.message).includes("askAnswer"));
      expect(e.message).toBe(`askAnswer needs "${ASK_CHOICES_CAPABILITY}" in the consumer's hello capabilities`);
      c.close();
      // One that declared it reaches the helper: an unknown question is gone.
      const d = await LineClient.connect(join(dir, "screen.sock"));
      d.send(at(0));
      d.send(at(3));
      const r = await d.waitFor((m) => m.type === "planProposal");
      expect(r).toMatchObject({ requestId: "ask-8", outcome: "error", error: { code: "questionGone" } });
      d.close();
    } finally {
      await server.close();
      helper.shutdown();
      helper.memory.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
