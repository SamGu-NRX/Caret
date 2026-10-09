// Question memory (memory/questions.ts): a fields question put away twice within a week is not asked a third time. The
// unit: what counts, for how long, per what key, and that the table holds no screen text. The helper: a new request
// or a lapse puts an open question away, an answer lifts it, and a quiet question proceeds as an empty answer, filling
// only what Caret settled and saying it left the rest to the user, as before. All text synthetic.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUESTION_QUIET_DAYS, QuestionMemory, type AskedKey } from "../src/memory/questions.ts";
import { AskQuestion, PlanProposal, PROTOCOL_VERSION } from "../src/protocol.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { MAIL_APP, optionIs, scopeLabel, snap, text } from "./builders.ts";
import { executorWindow, FakeApp, K, wireButtons } from "./fake-app.ts";

const DAY = 24 * 60 * 60 * 1000;
const KEY = Buffer.alloc(32, 7);
const k: AskedKey = { form: "f".repeat(64), part: "fields", fields: ["a".repeat(64), "b".repeat(64)] };

describe("QuestionMemory", () => {
  let db: DatabaseSync;
  let m: QuestionMemory;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    m = new QuestionMemory(db, KEY);
  });
  afterEach(() => db.close());

  it("goes quiet on the second dismissal within the window, not the first", () => {
    m.dismissed(k, 1_000);
    expect(m.quiet(k, 1_001)).toBe(false);
    m.dismissed(k, 2_000);
    expect(m.quiet(k, 2_001)).toBe(true);
  });

  it("counts only dismissals within QUESTION_QUIET_DAYS", () => {
    m.dismissed(k, 0);
    m.dismissed(k, QUESTION_QUIET_DAYS * DAY + 1);
    expect(m.quiet(k, QUESTION_QUIET_DAYS * DAY + 2)).toBe(false);
    m.dismissed(k, QUESTION_QUIET_DAYS * DAY + 3);
    expect(m.quiet(k, QUESTION_QUIET_DAYS * DAY + 4)).toBe(true);
    expect(m.quiet(k, 2 * QUESTION_QUIET_DAYS * DAY + 2)).toBe(false);
  });

  it("is lifted by an answer, and needs two new dismissals after it", () => {
    m.dismissed(k, 1);
    m.dismissed(k, 2);
    m.answered(k, 3);
    expect(m.quiet(k, 4)).toBe(false);
    m.dismissed(k, 5);
    expect(m.quiet(k, 6)).toBe(false);
    m.dismissed(k, 7);
    expect(m.quiet(k, 8)).toBe(true);
  });

  it("keys by form, part and the set of offered fields, in any order", () => {
    m.dismissed(k, 1);
    m.dismissed({ ...k, fields: [...k.fields].reverse() }, 2);
    expect(m.quiet(k, 3)).toBe(true);
    expect(m.quiet({ ...k, part: "source" }, 3)).toBe(false);
    expect(m.quiet({ ...k, form: "e".repeat(64) }, 3)).toBe(false);
    expect(m.quiet({ ...k, fields: [k.fields[0] as string] }, 3)).toBe(false);
  });

  it("stores a keyed hash only, and keeps what it stored across instances", () => {
    m.dismissed(k, 1);
    m.dismissed(k, 2);
    const rows = db.prepare("SELECT question FROM question_memory").all() as { question: string }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) for (const part of [k.form, k.part, ...k.fields]) expect(r.question).not.toContain(part);
    expect(new QuestionMemory(db, KEY).quiet(k, 3)).toBe(true);
    expect(new QuestionMemory(db, Buffer.alloc(32, 8)).quiet(k, 3), "another key reads none of it").toBe(false);
  });
});

// The fake app's form (Name, Email, a Billing and a Shipping City) beside a mail with a name and a city. The heads route
// is "some"; the scope ask settles Name and leaves both Cities unresolved, so each Ask asks about the Cities beside Name.
const REF = "5150-3";
const M = (s: string): string => `dev.caret.mail/standard/${s}`;
const mailWindow = () => snap([text(M("statictext:name: dana ortiz~0"), "Name: Dana Ortiz"), text(M("statictext:city: austin~0"), "City: Austin")], { at: 500, windowId: REF, title: "Order 48213", app: MAIL_APP });
const jev: AskJev = async (req) => {
  const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => {
    const ins = String(q.instructions);
    if (req.purpose === "ask.heads") return [id, { choice: { route: "some", why: "nothingToFill", source: "any", whose: "user" }[id] ?? "none", confidence: 0.95 }];
    if (id === "section") return [id, { choice: "fields", confidence: 0.99 }];
    if (req.purpose === "ask.scope") {
      const label = scopeLabel(ins);
      return [id, label === "Name" ? { choice: "asks", confidence: 0.99 } : label === "City" ? { choice: "asks", confidence: 0.4 } : { choice: "not", confidence: 0.99 }];
    }
    if (req.purpose === "fill.verify") return [id, { choice: "exact" in q.criteria ? "exact" : "none", confidence: 1 }];
    if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user", confidence: 0.9 }];
    const want = ins.includes("'Name'") ? "Dana Ortiz" : ins.includes("'City'") ? "Austin" : null;
    const hit = want === null ? undefined : Object.entries(q.criteria).find(([, d]) => optionIs(d, want))?.[0];
    return [id, { choice: hit ?? "none", confidence: 0.9 }];
  }));
  return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
};

describe("question memory in the helper", () => {
  let dir: string;
  let store: Store;
  let memory: MemoryStore;
  let app: FakeApp;
  let helper: Helper;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-act-quiet-"));
    store = new Store(join(dir, "data"));
    memory = new MemoryStore(join(dir, "data"));
    app = new FakeApp(executorWindow());
    wireButtons(app);
    app.enforceGrants = true;
    clock = 10_000;
    helper = new Helper({ store, memory, askJev: jev, shadow: false, allowBackgroundFocus: false, publish: () => {}, readerLink: app, now: () => clock, ask: { maker: "heads" } });
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

  const request = (n: number) => ({ type: "planRequest", v: PROTOCOL_VERSION, requestId: `r${n}`, at: n, instruction: "fill in my name and the city", windowId: "5150-7" }) as const;

  it("asks twice; a third Ask after two put away fills only Name and says it left the Cities, as before", async () => {
    expect(AskQuestion.parse(await helper.handlePlanRequest(request(1), "s1", true))).toMatchObject({ part: "fields", filling: ["Name"] });
    // A new request puts the first question away.
    expect(AskQuestion.parse(await helper.handlePlanRequest(request(2), "s1", true))).toMatchObject({ part: "fields" });
    // The second lapses unanswered.
    clock += 11 * 60 * 1000;
    helper.tick(clock);
    const r = PlanProposal.parse(await helper.handlePlanRequest(request(3), "s1", true));
    expect(r).toMatchObject({ outcome: "proposed" });
    expect(JSON.stringify(r.spec)).toContain("Left City (Billing) and City (Shipping) to you, as before.");
    expect(await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: r.offerKey ?? "", actionId: "run", overrides: {}, at: clock })).toMatchObject({ outcome: "done", acted: 1 });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana Ortiz");
    expect(app.node(K("group:billing/textfield:city~0"))?.value).toBeUndefined();
  });

  it("asks again after the user answered it", async () => {
    const q1 = AskQuestion.parse(await helper.handlePlanRequest(request(1), "s1", true));
    await helper.handleAskAnswer({ type: "askAnswer", v: PROTOCOL_VERSION, requestId: "a1", at: 2, questionId: q1.questionId, picks: [] }, "s1");
    expect(AskQuestion.parse(await helper.handlePlanRequest(request(2), "s1", true))).toMatchObject({ part: "fields" });
    expect(AskQuestion.parse(await helper.handlePlanRequest(request(3), "s1", true))).toMatchObject({ part: "fields" });
  });
});
