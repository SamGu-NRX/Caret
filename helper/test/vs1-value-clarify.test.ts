// Value clarification in the existing Ask panel: a field in settled scope whose value questions did not settle (or whose
// verifier said exact twice under its cutoff) is asked about by its eligible proposed values and Leave blank, one field
// at a time in form order, at most eight fields and seven values a field. A pick is new evidence for one fresh pair of
// value questions on that field, under the unchanged cutoff, verifier and vetoes; it prepares the next preview and no
// more. Leave blank, cancel and expiry write nothing; a changed source or form invalidates the pick. Synthetic desks.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnyMessage, AskAnswer, AskQuestion, ConsumerMessage, HelperMessage, MAX_ASK_OPTIONS, PlanProposal, PROTOCOL_VERSION } from "../src/protocol.ts";
import { ScreenModel } from "../src/model.ts";
import { aboutValues } from "../src/fill/about.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { MEMORY_CUTOFF, type UnresolvedValue } from "../src/fill/fill.ts";
import { valueChoices, valueQueue } from "../src/planner/choices.ts";
import { AskAsks, AskRefused, answerQuestion, planAsk, type AskDraft } from "../src/planner/ask.ts";
import type { IntentMaker } from "../src/planner/intent-makers.ts";
import { SaidError } from "../src/planner/says.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import type { WriterRequest } from "../src/writer/port.ts";
import { answeringScope, field, MAIL_APP, scopeLabel, snap, text } from "./builders.ts";
import { executorWindow, FakeApp, K, wireButtons } from "./fake-app.ts";
import { optionOutput, proposedOf } from "./vs1-kit.ts";

const unresolved = (n: number, values = 1): UnresolvedValue => ({
  key: `form/${n}`, name: `Field ${n}`, kind: "value", why: "selection",
  options: Array.from({ length: values }, (_, i) => ({ id: `c${n}-${i}`, value: `v${n}-${i}`, display: `v${n}-${i}`, source: "Notes.txt" })),
});

describe("the bounds (pure)", () => {
  it("offers eight eligible fields, and none of nine", () => {
    expect(valueQueue(Array.from({ length: 8 }, (_, i) => unresolved(i))).map((u) => u.key)).toHaveLength(8);
    expect(valueQueue(Array.from({ length: 9 }, (_, i) => unresolved(i)))).toEqual([]);
  });

  it("offers a field's seven values with Leave blank, and leaves a field of eight unresolved, counted before it is dropped", () => {
    expect(valueQueue([unresolved(0, 7)]).map((u) => u.key)).toEqual(["form/0"]);
    expect(valueChoices(unresolved(0, 7)).options).toHaveLength(MAX_ASK_OPTIONS);
    expect(valueQueue([unresolved(0, 8), unresolved(1)]).map((u) => u.key)).toEqual(["form/1"]);
    expect(valueQueue([unresolved(0, 8), ...Array.from({ length: 8 }, (_, i) => unresolved(i + 1))])).toEqual([]);
  });

  it("lists literal values with their sources, then Leave blank; nothing is ranked or preselected", () => {
    const c = valueChoices({ ...unresolved(0, 2), name: "Work email", kind: "email" });
    expect(c).toMatchObject({ part: "value", pick: "one", text: "Which email should go in Work email?" });
    expect(c.options.map((o) => o.option)).toEqual([
      { kind: "value", id: "o1", value: "v0-0", source: "Notes.txt" },
      { kind: "value", id: "o2", value: "v0-1", source: "Notes.txt" },
      { kind: "blank", id: "o3" },
    ]);
    expect(c.options.map((o) => o.fixes)).toEqual([{ values: [{ key: "form/0", option: "c0-0" }] }, { values: [{ key: "form/0", option: "c0-1" }] }, { values: [{ key: "form/0", option: null }] }]);
  });
});

// The Ask desk: a demo request's First name, Work email and Phone; a mail from someone else; a note of the user's own
// phone; the user's saved name and email. Each wording's value answer comes from `values`.
const T0 = 3_000_000;
const MAIL = ["From: Dana Whitfield <dana.whitfield@lumen.example>", "Hi Grace, see you Thursday."].join("\n");
const NOTE = "Phone: 555-0188";
const ABOUT = aboutValues([
  { id: "about-name", fields: { label: "Name", value: "Grace Oduya", source: "typed" } },
  { id: "about-email", fields: { label: "Email", value: "grace.oduya@example.com", source: "typed" } },
]);
const MEMORY = { values: () => ABOUT.map((a) => ({ id: a.id, label: a.label, text: a.value, whose: "user" as const })) };
function desk(note = NOTE): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("mail/body", MAIL, { role: "AXTextArea" })], { at: T0 - 40_000, windowId: "mail", title: "Thursday", app: MAIL_APP, focused: true }));
  m.apply(snap([field("note/body", note, { role: "AXTextArea" })], { at: T0 - 20_000, windowId: "note", title: "Phone.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
  m.apply(snap(["First name", "Work email", "Phone"].map((l, i) => field(`form/${i}`, "", { label: l, frame: [100, 40 + 40 * i, 200, 24] })), { at: T0, windowId: "form", title: "Request a demo", focused: true, focusedKey: "form/0" }));
  return m;
}
const maker: IntentMaker = {
  name: "writer",
  async make(snap) {
    return { intent: { route: "fill", why: "none", scope: "list", section: "none", fields: snap.fields.map((f) => f.ref), sources: ["any"], whose: "user", literals: [] }, use: { maker: "writer", model: "writer-test", calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 } };
  },
};
type A = { choice: string; confidence: number };
/** Each field's two value answers by label: an output and a confidence per wording; the fresh pair after a pick by `fresh`. */
function jev(values: Record<string, [[string | null, number], [string | null, number]]>, fresh: (label: string, wording: 0 | 1) => [string | null, number] = () => [null, 0.9]): AskJev & { reqs: JevRequest[] } {
  const reqs: JevRequest[] = [];
  const f: AskJev = async (req) => {
    reqs.push(req);
    const answers: Record<string, A> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const ins = String(q.instructions);
      if (req.purpose === "ask.confirm") answers[id] = { choice: "yes", confidence: 0.99 };
      else if (id.endsWith("_whose")) answers[id] = { choice: "user", confidence: 0.9 };
      else if (id.endsWith("_owner")) answers[id] = { choice: ins.includes("dana.whitfield") ? "other" : "user", confidence: 0.9 };
      else {
        const label = ["First name", "Work email", "Phone"].find((l) => ins.includes(`'${l}'`)) ?? "";
        const wording = Object.keys(q.criteria).some((k) => /^[vne]\d+$/u.test(k)) ? 1 : 0;
        const picked = /Explicit user selections: (?!none)/u.test(ins);
        const [want, confidence] = picked ? fresh(label, wording) : (values[label]?.[wording] ?? [null, 0.99]);
        answers[id] = { choice: Object.entries(q.criteria).find(([, d]) => want !== null && optionOutput(d) === want)?.[0] ?? "none", confidence };
      }
    }
    return { model: "jev-vs1", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
  return Object.assign(answeringScope(f), { reqs });
}
const GRACE: [[string, number], [string, number]] = [["Grace", 0.99], ["Grace", 0.99]];
const plan = (m: ScreenModel, j: AskJev, resume?: Parameters<typeof planAsk>[4]["resume"]) =>
  planAsk("put my name, work email and phone in", m, MEMORY, ABOUT, { askJev: j, maker, writer: null, offerKey: "vs1", windowId: "form", now: T0, rand: () => 0, values: true, ...(resume === undefined ? {} : { resume }) });
const outcome = (p: Promise<AskDraft>): Promise<AskDraft | AskRefused> => p.catch((e: unknown) => {
  if (e instanceof AskRefused) return e;
  throw e;
});
/** What an outcome proposes, by field label (vs1-kit proposedOf), text fields only: the desk's form has no controls. */
const writes = (d: AskDraft | AskRefused | null): Record<string, string> => proposedOf({ labelOf: new Map([["form/0", "First name"], ["form/1", "Work email"], ["form/2", "Phone"]]) }, d);
const ask = (o: AskDraft | AskRefused): AskAsks => {
  if (!(o instanceof AskAsks)) throw new Error(`expected a question, got ${o instanceof AskRefused ? o.message : "a draft"}`);
  return o;
};
const pickValue = (q: AskAsks, value: string | null) => {
  const c = q.question.options.find((o) => (value === null ? o.option.kind === "blank" : o.option.kind === "value" && o.option.value === value));
  const r = answerQuestion(q.question, [c?.option.id ?? "missing"]);
  if (typeof r === "string") throw new Error(r);
  return r;
};

describe("a value question in the Ask", () => {
  const split = { "First name": GRACE, "Work email": [["grace.oduya@example.com", 0.47], [null, 0.51]] as [[string | null, number], [string | null, number]] };

  it("asks about the unresolved email by its eligible values, beside the name already checked, and never lists the sender's", async () => {
    const q = ask(await outcome(plan(desk(), jev(split))));
    expect(q.question).toMatchObject({ part: "value", pick: "one", text: "Which email should go in Work email?", filling: ["First name: Grace"] });
    expect(q.question.options.map((o) => o.option)).toEqual([{ kind: "value", id: "o1", value: "grace.oduya@example.com", source: "Your saved Email" }, { kind: "blank", id: "o2" }]);
    expect(writes(q)).toEqual({ "First name": "Grace" });
  });

  it("a pick asks both value wordings once more, with the selection, and adds the value only when both agree at the cutoff", async () => {
    const m = desk();
    const j = jev(split, () => ["grace.oduya@example.com", 0.9]);
    const q = ask(await outcome(plan(m, j)));
    const before = j.reqs.length;
    const d = await outcome(plan(m, j, pickValue(q, "grace.oduya@example.com")));
    const fresh = j.reqs.slice(before).filter((r) => r.purpose === "fill.values");
    expect(fresh).toHaveLength(2);
    for (const r of fresh) expect(Object.keys(r.questions)).toEqual(["f2"]);
    expect(String(fresh[0]?.questions.f2?.instructions)).toContain('Explicit user selections: the value "grace.oduya@example.com" for \'Work email\'.');
    expect(writes(d)).toEqual({ "First name": "Grace", "Work email": "grace.oduya@example.com" });
  });

  // Sol review P1: a pick is admitted only when both fresh wordings choose exactly it at the unchanged cutoff.
  describe("the fresh pair's truth table", () => {
    const TWO = "Email: g.oduya@lumen.example\nPhone: 555-0188";
    const cases: [string, (wording: 0 | 1) => [string | null, number]][] = [
      ["none / none", () => [null, 0.99]],
      ["the pick / none", (w) => (w === 0 ? ["grace.oduya@example.com", 0.99] : [null, 0.99])],
      ["both on another value", () => ["g.oduya@lumen.example", 0.99]],
      // The pick is the user's saved email, so its cutoff is MEMORY_CUTOFF.
      ["both on the pick, under the cutoff", () => ["grace.oduya@example.com", MEMORY_CUTOFF - 0.01]],
    ];
    it.each(cases)("%s writes nothing in Work email", async (_, fresh) => {
      const m = desk(TWO);
      const j = jev(split, (label, w) => (label === "Work email" ? fresh(w) : [null, 0.9]));
      const q = ask(await outcome(plan(m, j)));
      expect(q.question.options.map((o) => o.option.kind === "value" && o.option.value)).toContain("grace.oduya@example.com");
      const d = await outcome(plan(m, j, pickValue(q, "grace.oduya@example.com")));
      expect(writes(d)["Work email"]).toBeUndefined();
    });
    it("both on the pick at the cutoff writes it", async () => {
      const m = desk(TWO);
      const j = jev(split, (label) => (label === "Work email" ? ["grace.oduya@example.com", MEMORY_CUTOFF] : [null, 0.9]));
      const d = await outcome(plan(m, j, pickValue(ask(await outcome(plan(m, j))), "grace.oduya@example.com")));
      expect(writes(d)["Work email"]).toBe("grace.oduya@example.com");
    });
  });

  it("a fresh pair that does not agree leaves the field blank and asks nothing more", async () => {
    const m = desk();
    const j = jev(split, (_, w) => (w === 0 ? ["grace.oduya@example.com", 0.9] : [null, 0.9]));
    const d = await outcome(plan(m, j, pickValue(ask(await outcome(plan(m, j))), "grace.oduya@example.com")));
    expect(d).not.toBeInstanceOf(AskAsks);
    expect(writes(d)).toEqual({ "First name": "Grace" });
  });

  it("Leave blank asks Jev nothing, and keeps the values already checked", async () => {
    const m = desk();
    const j = jev(split);
    const q = ask(await outcome(plan(m, j)));
    const before = j.reqs.length;
    const d = await outcome(plan(m, j, pickValue(q, null)));
    expect(j.reqs.length).toBe(before);
    expect(writes(d)).toEqual({ "First name": "Grace" });
  });

  it("asks one field at a time in form order, and skipping every one keeps only the settled values", async () => {
    const m = desk();
    const j = jev({ ...split, Phone: [["555-0188", 0.4], ["555-0188", 0.4]] });
    const q1 = ask(await outcome(plan(m, j)));
    expect(q1.question.text).toBe("Which email should go in Work email?");
    const q2 = ask(await outcome(plan(m, j, pickValue(q1, null))));
    expect(q2.question.text).toBe("Which phone number should go in Phone?");
    expect(q2.question.options.map((o) => o.option)).toEqual([{ kind: "value", id: "o1", value: "555-0188", source: "Phone.txt: Phone: 555-0188" }, { kind: "blank", id: "o2" }]);
    expect(writes(await outcome(plan(m, j, pickValue(q2, null))))).toEqual({ "First name": "Grace" });
  });

  it("a changed source invalidates the pick", async () => {
    const m = desk();
    const j = jev({ "First name": GRACE, Phone: [["555-0188", 0.4], ["555-0188", 0.4]] }, () => ["555-0188", 0.9]);
    const q = ask(await outcome(plan(m, j)));
    const resume = pickValue(q, "555-0188");
    m.apply(snap([field("note/body", "Phone: 555-0188 (old, do not use)", { role: "AXTextArea" })], { at: T0 + 1000, windowId: "note", title: "Phone.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" } }));
    const d = await outcome(plan(m, j, resume));
    expect(d).toBeInstanceOf(AskRefused);
    expect((d as SaidError).code).toBe("unknownWindow");
  });

  it("a changed field invalidates the pick", async () => {
    const m = desk();
    const j = jev(split, () => ["grace.oduya@example.com", 0.9]);
    const q = ask(await outcome(plan(m, j)));
    m.apply(snap(["First name", "Recovery email", "Phone"].map((l, i) => field(`form/${i}`, "", { label: l, frame: [100, 40 + 40 * i, 200, 24] })), { at: T0 + 1000, windowId: "form", title: "Request a demo", focused: true }));
    const d = await outcome(plan(m, j, pickValue(q, "grace.oduya@example.com")));
    expect(d).toBeInstanceOf(AskRefused);
    expect((d as SaidError).code).toBe("unknownWindow");
  });

  it("a caller that cannot ask gets the draft, with the unresolved field left out", async () => {
    const m = desk();
    const d = await outcome(planAsk("put my name, work email and phone in", m, MEMORY, ABOUT, { askJev: jev(split), maker, writer: null, offerKey: "vs1", windowId: "form", now: T0, rand: () => 0 }));
    expect(d).not.toBeInstanceOf(AskRefused);
    expect(writes(d)).toEqual({ "First name": "Grace" });
  });
});

// The wire: the fake app's form (Name, Email, two Cities) beside a mail that shows a name and an email.
const REF = "5150-3";
const M = (s: string): string => `dev.caret.mail/standard/${s}`;
const mailWindow = () => snap([text(M("statictext:name: dana ortiz~0"), "Name: Dana Ortiz"), text(M("statictext:email: dana.ortiz@example.com~0"), "Email: dana.ortiz@example.com")], { at: 500, windowId: REF, title: "Order 48213", app: MAIL_APP });
/** An intent writer that fills the whole form; the scope question then settles its fields (planner/ask.ts settleFields). */
const openFields = {
  route: FAKE_WRITER_ROUTE,
  write: async (_: WriterRequest) => {
    const json = { route: "fill", why: "none", scope: "all", section: "none", fields: [], sources: ["any"], whose: "user", literals: [] };
    return { model: "fake", provider: "groq", output: { program: null, reply: JSON.stringify(json), json }, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, latencyMs: 1, costUsd: 0 };
  },
};
/** Name and Email in scope; Name settles; Email's wordings disagree until the user picks it, then both choose it. */
const wireJev: AskJev = async (req) => {
  const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => {
    const ins = String(q.instructions);
    if (id === "section") return [id, { choice: "fields", confidence: 0.99 }];
    if (req.purpose === "ask.scope") return [id, { choice: ["Name", "Email"].includes(scopeLabel(ins)) ? "asks" : "not", confidence: 0.99 }];
    if (req.purpose === "fill.verify") return [id, { choice: "exact", confidence: 0.99 }];
    if (req.purpose === "ask.confirm") return [id, { choice: "yes", confidence: 0.99 }];
    if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user", confidence: 0.9 }];
    const wording = Object.keys(q.criteria).some((k) => /^[vne]\d+$/u.test(k)) ? 1 : 0;
    const want = ins.includes("'Name'") ? "Dana Ortiz" : ins.includes("'Email'") && (wording === 0 || /Explicit user selections: (?!none)/u.test(ins)) ? "dana.ortiz@example.com" : null;
    return [id, { choice: Object.entries(q.criteria).find(([, d]) => want !== null && optionOutput(d) === want)?.[0] ?? "none", confidence: 0.9 }];
  }));
  return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
};

describe("the value question on the wire", () => {
  let dir: string;
  let store: Store;
  let memory: MemoryStore;
  let app: FakeApp;
  let helper: Helper;
  let clock: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-vs1-values-"));
    store = new Store(join(dir, "data"));
    memory = new MemoryStore(join(dir, "data"));
    // The form's Email starts empty here, so the whole-form request takes it.
    app = new FakeApp(executorWindow().map((n) => (n.key === K("textfield:email~0") ? { ...n, value: undefined } : n)));
    wireButtons(app);
    app.enforceGrants = true;
    clock = 10_000;
    helper = new Helper({ store, memory, askJev: wireJev, shadow: false, allowBackgroundFocus: false, publish: () => {}, readerLink: app, now: () => clock, ask: { maker: "writer", writer: openFields } });
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
  const request = { type: "planRequest", v: PROTOCOL_VERSION, requestId: "r1", at: 1, instruction: "fill in my name and email", windowId: "5150-7" } as const;
  const answer = (questionId: string, picks: string[], requestId = "r2"): AskAnswer => ({ type: "askAnswer", v: PROTOCOL_VERSION, requestId, at: 2, questionId, picks });
  const accept = (r: PlanProposal) => helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: r.offerKey ?? "", actionId: "run", overrides: {}, at: clock });

  it("asks a consumer that declared askValues, and its pick reaches the preview, written only at acceptance", async () => {
    const q = AskQuestion.parse(await helper.handlePlanRequest(request, "s1", true, false, true));
    expect(q).toMatchObject({ part: "value", pick: "one", text: "Which email should go in Email?", filling: ["Name: Dana Ortiz"] });
    expect(q.options).toEqual([{ kind: "value", id: "o1", value: "dana.ortiz@example.com", source: "Order 48213: Email: dana.ortiz@example.com" }, { kind: "blank", id: "o2" }]);
    const r = PlanProposal.parse(await helper.handleAskAnswer(answer(q.questionId, ["o1"]), "s1", false, true));
    expect(r).toMatchObject({ outcome: "proposed" });
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(0);
    expect(await accept(r)).toMatchObject({ outcome: "done", acted: 2 });
    expect(app.node(K("textfield:email~0"))?.value).toBe("dana.ortiz@example.com");
  });

  it("takes an answer once, from the connection asked, before it lapses", async () => {
    const q = AskQuestion.parse(await helper.handlePlanRequest(request, "s1", true, false, true));
    expect(PlanProposal.parse(await helper.handleAskAnswer(answer(q.questionId, ["o1"]), "s2", false, true))).toMatchObject({ outcome: "error", error: { code: "questionGone" } });
    const q2 = AskQuestion.parse(await helper.handlePlanRequest({ ...request, requestId: "r3" }, "s1", true, false, true));
    await helper.handleAskAnswer(answer(q2.questionId, ["o2"]), "s1", false, true);
    expect(PlanProposal.parse(await helper.handleAskAnswer(answer(q2.questionId, ["o1"], "r4"), "s1", false, true))).toMatchObject({ outcome: "error", error: { code: "questionGone" } });
    const q3 = AskQuestion.parse(await helper.handlePlanRequest({ ...request, requestId: "r5" }, "s1", true, false, true));
    clock += 10 * 60 * 1000;
    expect(PlanProposal.parse(await helper.handleAskAnswer(answer(q3.questionId, ["o1"], "r6"), "s1", false, true))).toMatchObject({ outcome: "error", error: { code: "questionGone" } });
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(0);
  });

  it("refuses a pick the question did not list, and an empty answer", async () => {
    const q = AskQuestion.parse(await helper.handlePlanRequest(request, "s1", true, false, true));
    expect(PlanProposal.parse(await helper.handleAskAnswer(answer(q.questionId, ["o9"]), "s1", false, true))).toMatchObject({ outcome: "error", error: { code: "schema" } });
    const q2 = AskQuestion.parse(await helper.handlePlanRequest({ ...request, requestId: "r3" }, "s1", true, false, true));
    expect(PlanProposal.parse(await helper.handleAskAnswer(answer(q2.questionId, []), "s1", false, true))).toMatchObject({ outcome: "error", error: { code: "schema" } });
  });

  it("a consumer without askValues gets the preview with the unresolved value left out", async () => {
    const r = PlanProposal.parse(await helper.handlePlanRequest(request, "s1", true, false, false));
    expect(r).toMatchObject({ outcome: "proposed" });
    expect(await accept(r)).toMatchObject({ outcome: "done", acted: 1 });
    expect(app.node(K("textfield:email~0"))?.value).toBeUndefined();
  });
});

describe("the ask-values protocol lines", () => {
  const lines = readFileSync(new URL("../fixtures/golden/ask-values.ndjson", import.meta.url), "utf8").trim().split("\n");
  const CONSUMER = new Set(["hello", "planRequest", "askAnswer"]);
  const at = (i: number): Record<string, unknown> => JSON.parse(lines[i] as string) as Record<string, unknown>;

  it("parses every golden line and writes it back byte for byte", () => {
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(["hello", "planRequest", "askQuestion", "askAnswer", "askQuestion", "askAnswer"]);
    for (const l of lines) {
      const m = JSON.parse(l) as { type: string };
      expect(JSON.stringify((CONSUMER.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), m.type).toBe(l);
    }
  });

  it("refuses the shapes the contract rules out", () => {
    const bad = (m: unknown): boolean => !AnyMessage.safeParse(m).success;
    const q = at(2) as { options: Record<string, unknown>[] };
    const blank = q.options.at(-1);
    const values = q.options.slice(0, -1);
    expect(bad({ ...q, pick: "many" })).toBe(true);
    expect(bad({ ...q, options: values })).toBe(true);
    expect(bad({ ...q, options: [...values, blank, { kind: "blank", id: "o9" }] })).toBe(true);
    expect(bad({ ...q, options: [{ kind: "field", id: "o1", label: "Email", section: null }, blank] })).toBe(true);
    expect(bad({ ...q, options: [...Array.from({ length: MAX_ASK_OPTIONS }, (_, i) => ({ kind: "value", id: `v${i}`, value: `x${i}`, source: "Notes" })), blank] })).toBe(true);
    expect(bad({ ...q, options: [{ ...values[0], value: "" }, blank] })).toBe(true);
    expect(bad({ ...q, filling: [] })).toBe(true);
    expect(bad({ ...(at(4) as object), part: "fields" })).toBe(true);
  });
});
