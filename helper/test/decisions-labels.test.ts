import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CorpusAsk, CorpusForm } from "../scripts/realfill-corpus.ts";
import { labelQuestion } from "../scripts/decisions-labels.ts";
import { renderSweep, sweep, THRESHOLDS, type ScoredAnswer, type ScoredQuestion, type ScoredRecord } from "../scripts/decisions-sweep.ts";

const form: CorpusForm = {
  id: "form", file: "form.html", title: "Form", source: { kind: "note", file: "note.txt" },
  fields: [
    { label: "First Name", control: "text", expected: "Ada", accept: ["A."] },
    { label: "Email", control: "email", expected: "ada@example.test" },
    { label: "Guest's full name", control: "text", expected: "Grace" },
    { label: "Emergency phone", control: "tel", expected: "5551234567" },
    { label: "Optional", control: "text", expected: "none" },
  ],
};
const ask = (expected: CorpusAsk["expected"] = { "First Name": "Ada" }): CorpusAsk => ({ id: "ask", form: "form", instruction: "Fill first name", expected });
const valueQ = (label = "First Name", criteria: Record<string, string | null> = { c1: '"Ada" from the note', none: null }) => ({ instructions: `Label: '${label}'.`, criteria });
const ownerQ = (text: string, criteria: Record<string, string | null> = { user: null, other: null, person: null, unclear: null }) => ({ instructions: `Who owns "${text}"?`, criteria });
const scopeQ = (instructions: string) => ({ instructions, criteria: { asks: null, not: null } });

describe("labelQuestion", () => {
  it.each([
    'Field: "Email". Control: "email"',
    "the field 'Email' is a text field",
  ])("labels requested scope with wording %s", (instructions) => {
    expect(labelQuestion(ask({ "Email (required):": "ada@example.test" }), form, "s_email", scopeQ(instructions))).toEqual({ kind: "scope", right: ["asks"] });
  });
  it("reads the First Name scope wording", () => {
    expect(labelQuestion(ask(), form, "s_first", scopeQ("the field 'First Name' is a text field"))).toEqual({ kind: "scope", right: ["asks"] });
  });
  it.each([{}, { Email: "none" }, "refuse"] as CorpusAsk["expected"][])("labels omitted or refused scope not: %j", (expected) => {
    expect(labelQuestion(ask(expected), form, "s_email", scopeQ('Field: "Email". Control: "email"'))).toEqual({ kind: "scope", right: ["not"] });
  });
  it("leaves unreadable scope unlabeled", () => {
    expect(labelQuestion(ask(), form, "s_1", scopeQ("no field label"))).toEqual({ kind: "scope", right: null });
  });
  it("counts handoff as requested scope", () => {
    expect(labelQuestion(ask({ Email: "handoff" }), form, "s_1", scopeQ("field: 'Email'."))).toEqual({ kind: "scope", right: ["asks"] });
  });
  it("matches normalized field labels and every correct value option", () => {
    const q = valueQ("First Name *", { a: '"ada" from a source', b: 'Proposed value: "Ada". Source: note', c: '"A." from a source', d: null, none: null });
    expect(labelQuestion(ask({ "FIRST NAME:": "Ada" }), form, "f1", q)).toEqual({ kind: "value", right: ["a", "b", "c"] });
  });
  it("matches raw exact empty values", () => {
    expect(labelQuestion(ask({ "First Name": "" }), form, "f1", valueQ("First Name", { empty: '""', none: null }))).toEqual({ kind: "value", right: ["empty"] });
  });
  it("labels an expected value not offered as none", () => {
    expect(labelQuestion(ask(), form, "f1", valueQ("First Name", { c: '"Wrong"', none: null }))).toEqual({ kind: "value", right: ["none"] });
  });
  it.each([{}, { "First Name": "none" }, "refuse"] as CorpusAsk["expected"][])("labels unexpected or blank value none: %j", (expected) => {
    expect(labelQuestion(ask(expected), form, "f1", valueQ())).toEqual({ kind: "value", right: ["none"] });
  });
  it.each(["handoff", "unchecked", "checked"])("leaves special value %s unlabeled", (v) => {
    expect(labelQuestion(ask({ "First Name": v }), form, "f1", valueQ())).toEqual({ kind: "value", right: null });
  });
  it("leaves unreadable value unlabeled", () => {
    expect(labelQuestion(ask(), form, "f1", { ...valueQ(), instructions: "missing" })).toEqual({ kind: "value", right: null });
  });
  it("preserves apostrophes in field labels", () => {
    expect(labelQuestion(ask({ "Guest's full name": "Grace" }), form, "f2", valueQ("Guest's full name", { c: '"Grace"', none: null }))).toEqual({ kind: "value", right: ["c"] });
  });
  it.each(["Landlord name", "Reference name", "Emergency phone", "Guest name", "Referral name", "Relationship", "Recipient name"])("labels owner for %s as other and person", (label) => {
    expect(labelQuestion(ask({ [label]: "Grace" }), form, "c1_owner", ownerQ("Grace"))).toEqual({ kind: "owner", right: ["other", "person"] });
  });
  it("lets another person's matching entry take precedence", () => {
    expect(labelQuestion(ask({ "First Name": "Grace", "Guest name": "Grace" }), form, "c1_owner", ownerQ("Grace"))).toEqual({ kind: "owner", right: ["other", "person"] });
  });
  it("limits other-owner labels to options present", () => {
    expect(labelQuestion(ask({ "Guest name": "Grace" }), form, "c_owner", ownerQ("Grace", { person: null, unclear: null }))).toEqual({ kind: "owner", right: ["person"] });
  });
  it("labels B31's explicit recipient values and neutral shipping fields as other-owned", () => {
    const keys = JSON.parse(readFileSync(new URL("../../fixtures/realfill/asks-b31.json", import.meta.url), "utf8")) as { asks: CorpusAsk[] };
    const recipient = keys.asks.find((a) => a.id === "b31-18")!;
    expect(recipient.instruction).toBe("actually ship it straight to lena instead");
    expect(recipient.expected).toMatchObject({ "First name": "Lena", "Last name": "Marsh", Phone: "828-555-0104" });
    const shipping: CorpusForm = { ...form, fields: [{ label: "First name", control: "text", expected: "Grace" }, { label: "Phone", control: "tel", expected: "828-555-0104" }] };
    for (const text of ["Lena", "Marsh", "828-555-0104"]) {
      expect(labelQuestion(recipient, shipping, "c_owner", ownerQ(text))).toEqual({ kind: "owner", right: ["other", "person"] });
    }
    expect(labelQuestion(recipient, shipping, "f1_whose", { ...valueQ("First name"), criteria: { user: null, other: null } })).toEqual({ kind: "owner", right: ["other"] });
    // Grace is still the user; changing the recipient does not transfer ownership of an unrequested candidate.
    expect(labelQuestion(recipient, shipping, "c_owner", ownerQ("Grace"))).toEqual({ kind: "owner", right: ["user"] });
  });
  it("labels user owner through the ask", () => {
    expect(labelQuestion(ask({ Email: "new@example.test" }), form, "c_owner", ownerQ("new@example.test"))).toEqual({ kind: "owner", right: ["user"] });
  });
  it("labels user owner through whole-form expected values", () => {
    expect(labelQuestion(ask({}), form, "c_owner", ownerQ("ada@example.test"))).toEqual({ kind: "owner", right: ["user"] });
  });
  it.each(["Grace", "Unknown"])("does not infer owner from unrequested other fields: %s", (text) => {
    expect(labelQuestion(ask({}), form, "c_owner", ownerQ(text))).toEqual({ kind: "owner", right: null });
  });
  it("leaves unquoted owner text unlabeled", () => {
    expect(labelQuestion(ask(), form, "c_owner", { ...ownerQ("Ada"), instructions: "Ada" })).toEqual({ kind: "owner", right: null });
  });
  it.each(["user", "other"])("never substitutes unclear when %s is missing", (owner) => {
    expect(labelQuestion(ask(owner === "user" ? { "First Name": "Ada" } : { "Guest name": "Ada" }), form, "c_owner", ownerQ("Ada", { unclear: null }))).toEqual({ kind: "owner", right: null });
  });
  it.each([
    ["First Name", ["user"]],
    ["Guest's full name", ["other", "person"]],
    ["Optional", null],
    ["Missing", null],
  ])("labels field ownership for %s", (label, right) => {
    expect(labelQuestion(ask({}), form, "f1_whose", { ...valueQ(label as string), criteria: { user: null, other: null, person: null } })).toEqual({ kind: "owner", right });
  });
  it("leaves unreadable field ownership unlabeled", () => {
    expect(labelQuestion(ask(), form, "f1_whose", { instructions: "unknown", criteria: { user: null } })).toEqual({ kind: "owner", right: null });
  });
  it("leaves field ownership unlabeled when the right option is missing", () => {
    expect(labelQuestion(ask(), form, "f1_whose", { ...valueQ(), criteria: { other: null } })).toEqual({ kind: "owner", right: null });
  });
  it.each(["route", "f1_answer", "whose", "fX", "all"])("does not label other question %s", (qid) => {
    expect(labelQuestion(ask(), form, qid, valueQ())).toEqual({ kind: "other", right: null });
  });
  it("requires both scope options and the value none option", () => {
    expect(labelQuestion(ask(), form, "s_1", { ...scopeQ("field: 'Email'."), criteria: { asks: null } })).toEqual({ kind: "other", right: null });
    expect(labelQuestion(ask(), form, "f1", { ...valueQ(), criteria: { c1: '"Ada"' } })).toEqual({ kind: "other", right: null });
  });
});

const answer = (choice: string, probabilities: Record<string, number>, confidence = 0.99): ScoredAnswer => ({ choice, confidence, probabilities });
const question = (decisions: ScoredAnswer | null, jev: ScoredAnswer | null, overrides: Partial<ScoredQuestion> = {}): ScoredQuestion => ({ kind: "value", right: ["a"], options: ["a", "b", "none"], decisions, jev, ...overrides });
const record = (questions: ScoredRecord["questions"]): ScoredRecord => ({ set: "B24", ask: "ask-01", source: "frozen", servedBy: null, latencyMs: 100, costUsd: 0.001, questions });
const records = [record({
  hit: question(answer("a", { a: 0.8, b: 0.15, none: 0.05 }, 0.1), answer("a", { a: 0.6, b: 0.3, none: 0.1 }, 0.9)),
  wrongFill: question(answer("b", { a: 0.1, b: 0.7, none: 0.2 }, 0.95), null),
  wrongNone: question(answer("none", { a: 0.1, b: 0.05, none: 0.85 }, 0.3), answer("a", { a: 0.9, b: 0.05, none: 0.05 }, 0.7)),
  missingChosen: question(answer("a", { b: 0.6, none: 0.4 }), answer("b", { a: 0.1, b: 0.8, none: 0.1 })),
  unlabeled: question(answer("b", { b: 1 }), answer("b", { b: 1 }), { right: null }),
  other: question(answer("b", { b: 1 }), null, { kind: "other" }),
})];

describe("sweep", () => {
  it("uses selected probability, inclusive thresholds, and correct fill counts", () => {
    const r = sweep(records, "decisions", "value", [0.7, 0.8, 0.9], false);
    expect(r.n).toBe(3);
    expect(r.rows).toEqual([
      { threshold: 0.7, n: 3, accepted: 3, coverage: 1, acceptedWrong: 2, fills: 2, wrongFills: 1 },
      { threshold: 0.8, n: 3, accepted: 2, coverage: 2 / 3, acceptedWrong: 1, fills: 1, wrongFills: 0 },
      { threshold: 0.9, n: 3, accepted: 0, coverage: 0, acceptedWrong: 0, fills: 0, wrongFills: 0 },
    ]);
    expect(r.accuracy).toBeCloseTo(1 / 3);
    expect(r.meanSelectedProbability).toBeCloseTo(2.35 / 3);
    expect(r.meanApiConfidence).toBeCloseTo(1.35 / 3);
    expect(r.meanRunnerUpMargin).toBeCloseTo((0.65 + 0.5 + 0.75) / 3);
    expect(r.meanNoneProbability).toBeCloseTo(1.1 / 3);
  });
  it("filters both providers to the same paired set", () => {
    const d = sweep(records, "decisions", "value", [0.75], true);
    const j = sweep(records, "jev", "value", [0.75], true);
    expect(d.n).toBe(2);
    expect(j.n).toBe(2);
    expect(d.rows[0]).toMatchObject({ accepted: 2, coverage: 1, acceptedWrong: 1, wrongFills: 0 });
    expect(j.rows[0]).toMatchObject({ accepted: 1, coverage: 0.5, acceptedWrong: 0, wrongFills: 0 });
    expect(sweep(records, "jev", "value", [0.75], false).rows[0]).toMatchObject({ n: 3, accepted: 2, coverage: 2 / 3, acceptedWrong: 1, wrongFills: 1 });
  });
  it.each(["scope", "owner"] as const)("counts %s without fill metrics", (kind) => {
    const input = [record({ q: question(answer("b", { a: 0.2, b: 0.8 }), null, { kind }) })];
    expect(sweep(input, "decisions", kind, [0.75], false).rows[0]).toEqual({ threshold: 0.75, n: 1, accepted: 1, coverage: 1, acceptedWrong: 1, fills: null, wrongFills: null });
    expect(sweep(input, "decisions", kind, [0.75], false).meanNoneProbability).toBeNull();
  });
  it("accepts any labeled right option and excludes missing none from its mean", () => {
    const input = [record({ q: question(answer("b", { a: 0.1, b: 0.9 }), null, { right: ["a", "b"] }) })];
    expect(sweep(input, "decisions", "value", [0.9], false)).toMatchObject({ accuracy: 1, meanNoneProbability: null, rows: [{ acceptedWrong: 0, wrongFills: 0 }] });
  });
  it("allows negative margins when the selected option is not highest", () => {
    const input = [record({ q: question(answer("a", { a: 0.2, b: 0.8 }), null) })];
    expect(sweep(input, "decisions", "value", [], false).meanRunnerUpMargin).toBeCloseTo(-0.6);
  });
  it("does not invent a runner-up for a single probability", () => {
    const input = [record({ q: question(answer("a", { a: 1 }), null) })];
    expect(sweep(input, "decisions", "value", [], false).meanRunnerUpMargin).toBeNull();
  });
  it("reports empty denominators as unavailable", () => {
    expect(sweep([], "jev", "value", [0.75], true)).toMatchObject({ n: 0, accuracy: null, meanSelectedProbability: null, meanApiConfidence: null, meanRunnerUpMargin: null, meanNoneProbability: null, rows: [{ accepted: 0, coverage: null }] });
  });
  it.each([
    [null, "record must be an object"],
    [{ ...record({}), source: "invalid" }, "source must be live or frozen"],
    [{ ...record({}), latencyMs: -1 }, "latencyMs must be a finite nonnegative number"],
    [{ ...record({}), questions: [] }, "questions must be an object"],
    [record({ q: question(null, null, { right: ["missing"] }) }), "questions.q.right"],
    [record({ q: question(answer("a", { a: Number.NaN }), null) }), "questions.q.decisions.probabilities.a"],
    [record({ q: question(answer("a", { a: 0.8 }, 2), null) }), "questions.q.decisions.confidence"],
    [record({ q: question(answer("missing", { a: 1 }), null) }), "questions.q.decisions.choice"],
    [record({ q: { ...question(null, null), jev: undefined } as unknown as ScoredQuestion }), "questions.q.jev"],
  ])("rejects malformed records with a specific path: %j", (input, message) => {
    expect(() => sweep([input], "decisions", "value", [0.75], false)).toThrow(`Malformed scored record #1: ${message}`);
    expect(() => renderSweep([input])).toThrow("Malformed scored record");
  });
  it("rejects invalid thresholds", () => {
    expect(() => sweep([], "jev", "value", [1.01], false)).toThrow("Sweep thresholds");
  });
  it("renders side-by-side diagnostic tables for both sets and all kinds", () => {
    const markdown = renderSweep(records);
    expect(THRESHOLDS).toEqual([0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99]);
    expect(markdown).toContain("Diagnostic only. The shipped cutoff remains 0.75");
    expect(markdown).toContain("Paired set: both providers answered");
    expect(markdown).toContain("All answered: each provider's own set");
    expect(markdown.match(/\| 0\.75 shipped cutoff \|/gu)).toHaveLength(6);
    expect(markdown.match(/mean API confidence=/gu)).toHaveLength(12);
    expect(markdown).toContain("| Threshold | Decisions coverage | Decisions accepted wrong | Decisions wrong fills | Jev coverage | Jev accepted wrong | Jev wrong fills |");
    expect(markdown).toContain("| 0.75 shipped cutoff | 100.0% | 1 | 0 | 50.0% | 0 | 0 |");
    expect(renderSweep([])).toContain("n/a");
  });
});
