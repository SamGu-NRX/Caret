// The clarification step on the wire: a fields question beside fields the Ask settled names them (`filling`), and an
// answer that picks nothing fills only those. Dismissing the question, or letting it lapse, writes nothing. The fake
// app's form (Name, Email, a Billing and a Shipping City) beside a mail that shows a name and a city; all text synthetic.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AskAnswer, AskQuestion, PlanProposal, PROTOCOL_VERSION } from "../src/protocol.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import type { WriterRequest } from "../src/writer/port.ts";
import { MAIL_APP, optionIs, scopeLabel, snap, text } from "./builders.ts";
import { executorWindow, FakeApp, K, wireButtons } from "./fake-app.ts";

const REF = "5150-3";
const M = (s: string): string => `dev.caret.mail/standard/${s}`;
const mailWindow = () => snap([text(M("statictext:name: dana ortiz~0"), "Name: Dana Ortiz"), text(M("statictext:city: austin~0"), "City: Austin")], { at: 500, windowId: REF, title: "Order 48213", app: MAIL_APP });

/** An intent writer that leaves the fields open; the scope question then settles them (planner/ask.ts settleFields). */
const openFields = {
  route: FAKE_WRITER_ROUTE,
  write: async (_: WriterRequest) => {
    const json = { route: "ask", why: "whichFields", scope: "none", section: "none", fields: [], sources: ["any"], whose: "user", literals: [] };
    return { model: "fake", provider: "groq", output: { program: null, reply: JSON.stringify(json), json }, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, latencyMs: 1, costUsd: 0 };
  },
};

/** Scope by label (`name` for Name, 0.4 "asks" for each City, "not" for Email); values from the mail; owners the user's. */
const jevWith = (name: { choice: string; confidence: number }): AskJev => async (req) => {
  const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => {
    const ins = String(q.instructions);
    if (id === "section") return [id, { choice: "fields", confidence: 0.99 }];
    if (req.purpose === "ask.scope") {
      const label = scopeLabel(ins);
      return [id, label === "Name" ? name : label === "City" ? { choice: "asks", confidence: 0.4 } : { choice: "not", confidence: 0.99 }];
    }
    if (req.purpose === "fill.verify") return [id, { choice: "exact" in q.criteria ? "exact" : "none", confidence: 1 }];
    if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user", confidence: 0.9 }];
    const want = ins.includes("'Name'") ? "Dana Ortiz" : ins.includes("'City'") ? "Austin" : null;
    const hit = want === null ? undefined : Object.entries(q.criteria).find(([, d]) => optionIs(d, want))?.[0];
    return [id, { choice: hit ?? "none", confidence: 0.9 }];
  }));
  return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
};
const SURE = { choice: "asks", confidence: 0.99 };

describe("the clarification step on the wire", () => {
  let dir: string;
  let store: Store;
  let memory: MemoryStore;
  let app: FakeApp;
  let helper: Helper;
  let clock: number;
  const start = (name: { choice: string; confidence: number }) => {
    helper = new Helper({ store, memory, askJev: jevWith(name), shadow: false, allowBackgroundFocus: false, publish: () => {}, readerLink: app, now: () => clock, ask: { maker: "writer", writer: openFields } });
    app.helper = helper;
    app.show();
    void helper.handleReader(mailWindow());
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-g35-clarify-"));
    store = new Store(join(dir, "data"));
    memory = new MemoryStore(join(dir, "data"));
    app = new FakeApp(executorWindow());
    wireButtons(app);
    app.enforceGrants = true;
    clock = 10_000;
  });
  afterEach(() => {
    helper.shutdown();
    memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const request = { type: "planRequest", v: PROTOCOL_VERSION, requestId: "r1", at: 1, instruction: "fill in my name and the city", windowId: "5150-7" } as const;
  const answer = (questionId: string, picks: string[], requestId = "r2"): AskAnswer => ({ type: "askAnswer", v: PROTOCOL_VERSION, requestId, at: 2, questionId, picks });
  const accept = (r: PlanProposal) => helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: r.offerKey ?? "", actionId: "run", overrides: {}, at: clock });
  const writes = () => app.verbs.filter((v) => v.kind === "write");

  it("asks about the unresolved cities beside Name, and names Name as filled whatever the pick", async () => {
    start(SURE);
    const q = AskQuestion.parse(await helper.handlePlanRequest(request, "s1", true));
    expect(q).toMatchObject({ part: "fields", pick: "many", text: "Caret will fill Name. Which of these should it fill too?", filling: ["Name"] });
    expect(q.options).toEqual([
      { kind: "field", id: "o1", label: "City", section: "Billing" },
      { kind: "field", id: "o2", label: "City", section: "Shipping" },
    ]);
  });

  it("an answer that picks nothing fills only Name", async () => {
    start(SURE);
    const q = AskQuestion.parse(await helper.handlePlanRequest(request, "s1", true));
    const r = PlanProposal.parse(await helper.handleAskAnswer(answer(q.questionId, []), "s1"));
    expect(r).toMatchObject({ outcome: "proposed" });
    expect(writes()).toHaveLength(0);
    expect(await accept(r)).toMatchObject({ outcome: "done", acted: 1 });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana Ortiz");
    expect(app.node(K("group:billing/textfield:city~0"))?.value).toBeUndefined();
    expect(app.node(K("group:shipping/textfield:city~0"))?.value).toBeUndefined();
  });

  it("a pick adds only the city picked", async () => {
    start(SURE);
    const q = AskQuestion.parse(await helper.handlePlanRequest(request, "s1", true));
    const r = PlanProposal.parse(await helper.handleAskAnswer(answer(q.questionId, ["o2"]), "s1"));
    expect(await accept(r)).toMatchObject({ outcome: "done", acted: 2 });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana Ortiz");
    expect(app.node(K("group:shipping/textfield:city~0"))?.value).toBe("Austin");
    expect(app.node(K("group:billing/textfield:city~0"))?.value).toBeUndefined();
  });

  it("an empty answer to a question with nothing settled beside it is refused, and writes nothing", async () => {
    start({ choice: "asks", confidence: 0.4 });
    const q = AskQuestion.parse(await helper.handlePlanRequest(request, "s1", true));
    expect(q).not.toHaveProperty("filling");
    expect(PlanProposal.parse(await helper.handleAskAnswer(answer(q.questionId, []), "s1"))).toMatchObject({ outcome: "error", error: { code: "schema" } });
    expect(writes()).toHaveLength(0);
  });

  it("a question dismissed or left to lapse writes nothing, and a late answer is gone", async () => {
    start(SURE);
    const q = AskQuestion.parse(await helper.handlePlanRequest(request, "s1", true));
    expect(writes()).toHaveLength(0);
    clock += 10 * 60 * 1000;
    expect(PlanProposal.parse(await helper.handleAskAnswer(answer(q.questionId, []), "s1"))).toMatchObject({ outcome: "error", error: { code: "questionGone" } });
    expect(writes()).toHaveLength(0);
  });
});
