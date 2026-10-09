import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import type { Node, ValueKind } from "../src/protocol.ts";
import { askScope, fieldFingerprint } from "../src/fill/ask-scope.ts";
import { collectCandidates } from "../src/fill/candidates.ts";
import { ContractError, guardFor, mintExempt, setTestVerifier, type CheckedValue } from "../src/fill/contract.ts";
import { optionKinds } from "../src/fill/controls.ts";
import { mintOf, PAGE_WINDOW_KIND, proposeFill, VALUE_TASK, valueSettlementOf, type FillScope } from "../src/fill/fill.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";
import { writtenFields } from "../src/offers/fill-popup.ts";
import { node, snap, text, value } from "./builders.ts";
import { STAND_IN } from "./setup/verifier.ts";

beforeEach(() => setTestVerifier(null));
afterEach(() => setTestVerifier(STAND_IN));

const OPTIONS = ["Braised short rib", "Herb-roasted salmon", "Wild mushroom risotto (vegetarian)"];
const WANT = OPTIONS[2]!;
const NOTE = "My guest wants the vegetarian one for dinner.";
const NOTES = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const CHAT = { pid: 7002, bundleId: "com.apple.MobileSMS", name: "Messages" };

function form(options: readonly string[] | null): Node[] {
  return [node("web", "AXWebArea"), node("meal", "AXPopUpButton", { parent: "web", label: "Guest meal", frame: [0, 0, 200, 24] }),
    ...(options ?? []).map((label, i) => node(`meal/${i}`, "AXMenuItem", { parent: "meal", label }))];
}
function desk(options: readonly string[] | null = OPTIONS, kind = PAGE_WINDOW_KIND): ScreenModel {
  const model = new ScreenModel();
  model.apply(snap([node("note", "AXTextArea", { value: NOTE })], { at: 1000, windowId: "note", title: "Dinner", app: NOTES, focused: true }));
  model.apply(snap(form(options), { at: 2000, windowId: "form", kind, title: "RSVP", focused: true }));
  return model;
}
function cutChat(model: ScreenModel, kind: "phone" | "date" | "address"): void {
  const labels = Array.from({ length: 60 }, (_, i) => kind === "phone" ? `(303) 555-${String(1000 + i)}` : kind === "date" ? `October ${i % 28 + 1}, ${2026 + Math.floor(i / 28)}` : `${100 + i} Larch Lane, Austin, TX 78701`);
  model.apply(snap(labels.map((label, i) => text(`chat/${i}`, `Delivery update: ${label}`)), {
    at: 1500, windowId: "chat", title: "Delivery", app: CHAT, values: labels.map((label, i) => value(kind, label, `chat/${i}`)),
  }));
  const collected = collectCandidates(model, "form", { now: 3000, ledger: new Disclosure(model) });
  expect(collected.cutKinds.has(kind), "the fixture really cuts the requested kind").toBe(true);
  expect(collected.cutAll, "the fixture's cuts have known kinds").toBe(false);
}

interface JudgeOptions { want?: string; confidence?: number; disagree?: boolean; after?: () => void }
function judge(requests: JevRequest[], o: JudgeOptions = {}): AskJev {
  let settlementCalls = 0;
  return async (request) => {
    requests.push(request);
    const settlement = (request.state as { task?: string }).task === VALUE_TASK;
    if (settlement) settlementCalls++;
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
      if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user", confidence: 0.99 }];
      if (request.purpose === "fill.verify") return [id, { choice: "exact", confidence: 0.99 }];
      const want = settlement ? o.want ?? WANT : undefined;
      const found = Object.entries(q.criteria).find(([, criterion]) => typeof criterion === "string" && (settlement
        ? criterion.startsWith(`Proposed value: "${want}". Source: `) && criterion.includes("Supporting text: the whole text")
        : criterion.startsWith(`"${want}"`)));
      return [id, { choice: settlement && o.disagree && settlementCalls === 2 ? "none" : found?.[0] ?? "none", confidence: o.confidence ?? 0.99 }];
    }));
    if (settlement && settlementCalls === 2) o.after?.();
    return { model: "act-select-offline", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
}
async function run(model = desk(), options: JudgeOptions = {}) {
  const window = model.windows.get("form")!;
  const scope: FillScope = { fields: ["meal"], windows: null, memory: false, instruction: "Fill the guest meal from the dinner note", person: null, literals: new Map() };
  const authority = { kind: "ask" as const, scope: askScope("form", null, ["meal"], { meal: fieldFingerprint(window, "meal") }, null, "act-select") };
  const requests: JevRequest[] = [];
  const proposal = await proposeFill(model, judge(requests, options), "form", "meal", 3000, { scope, authority, rand: () => 0 });
  return { model, proposal, requests, field: proposal.fields[0]!, mint: mintOf(proposal.fields[0]!) };
}

function assertPageWrite(result: Awaited<ReturnType<typeof run>>, want = WANT): CheckedValue {
  expect(result.field).toMatchObject({ withheld: null, handoff: { value: want, writes: true } });
  expect(result.mint?.verdict).toEqual({ by: "exempt", rule: "optionLabel" });
  expect(result.mint?.provenance).toMatchObject({ kind: "derived", how: "jevOption" });
  expect(result.requests.filter((r) => r.purpose === "fill.verify")).toHaveLength(0);
  expect(writtenFields(result.proposal).fields.map((f) => f.key)).toEqual(["meal"]);
  return result.mint!;
}

describe("bounded page-select Choice", () => {
  it("fills a source-supported option through optionLabel, with both wordings listing exactly its own labels plus none", async () => {
    const result = await run();
    assertPageWrite(result);
    const pairs = result.requests.filter((r) => (r.state as { task?: string }).task === VALUE_TASK);
    expect(pairs).toHaveLength(2);
    for (const request of pairs) {
      const criteria = Object.values(request.questions)[0]!.criteria;
      const outputs = Object.entries(criteria).filter(([id]) => id !== "none").map(([, criterion]) => /^Proposed value: "([\s\S]*?)"\. Source: /u.exec(String(criterion))?.[1]);
      expect([...new Set(outputs)].sort()).toEqual([...OPTIONS].sort());
      expect(Object.keys(criteria)).toContain("none");
      expect((request.state as { source_notes?: unknown }).source_notes).toEqual(expect.objectContaining({ note_1: expect.stringContaining(NOTE) }));
    }
  });

  it("an unrelated phone cut no longer withholds the meal", async () => {
    const model = desk();
    cutChat(model, "phone");
    assertPageWrite(await run(model));
  });

  it.each([
    ["date", ["January", "October"], "October"],
    ["address", ["California", "Texas"], "Texas"],
  ] as const)("a related %s cut still withholds the select", async (kind, options, want) => {
    const model = desk(options);
    cutChat(model, kind);
    const result = await run(model, { want });
    expect(result.field).toMatchObject({ withheld: "sourceCut", value: null, handoff: null, asks: [] });
    expect(result.mint).toBeUndefined();
    expect(result.requests).toHaveLength(0);
  });

  // Review: a country menu's options name no value kind, so its field's own semantics put it with addresses.
  it("an address cut withholds a country menu, whose option names are no kind of their own", async () => {
    const model = desk(["Canada", "France"]);
    model.apply(snap(form(["Canada", "France"]).map((n) => n.key === "meal" ? { ...n, label: "Country" } : n), { at: 2500, windowId: "form", kind: PAGE_WINDOW_KIND, title: "RSVP", focused: true }));
    cutChat(model, "address");
    const result = await run(model, { want: "France" });
    expect(result.field).toMatchObject({ withheld: "sourceCut", value: null, handoff: null });
    expect(result.mint).toBeUndefined();
  });

  // Review: a cut that left out text under one of the select's own label words still withholds it (cutTerms), as for any field.
  it("a cut of text under the select's own label words still withholds it", async () => {
    const model = desk();
    const labels = Array.from({ length: 60 }, (_, i) => `Guest meal ${i}: ${OPTIONS[i % 3]}`);
    model.apply(snap(labels.map((label, i) => text(`chat/${i}`, label)), { at: 1500, windowId: "chat", title: "Guest meals", app: CHAT }));
    const collected = collectCandidates(model, "form", { now: 3000, ledger: new Disclosure(model) });
    expect([...collected.cutTerms], "the fixture cuts text under the select's label words").toEqual(expect.arrayContaining(["guest", "meal"]));
    const result = await run(model);
    // Cut, the select is not proposed at all: no value, no mint, nothing a Fill all would write.
    expect(result.proposal.fields.filter((f) => f.key === "meal" && (f.handoff !== null || f.value !== null))).toEqual([]);
    expect(writtenFields(result.proposal).fields).toEqual([]);
  });

  it.each(["day", "month"] as const)("a related date cut withholds numeric %s options", async (part) => {
    const model = desk(["1", "2", "3"]);
    model.apply(snap(form(["1", "2", "3"]).map((n) => n.key === "meal" ? { ...n, label: `Birth ${part}` } : n), { at: 2500, windowId: "form", kind: PAGE_WINDOW_KIND, title: "RSVP", focused: true }));
    cutChat(model, "date");
    const result = await run(model, { want: "2" });
    expect(result.field).toMatchObject({ withheld: "sourceCut", value: null, handoff: null, asks: [] });
    expect(result.mint).toBeUndefined();
    expect(result.requests).toHaveLength(0);
  });

  it.each([{ confidence: 0.1 }, { disagree: true }])("agreement and the existing cutoff remain required: %j", async (options) => {
    const result = await run(desk(), options);
    expect(result.field.handoff).toBeNull();
    expect(result.mint).toBeUndefined();
  });

  it("refuses an output that is not an exact label, even if case or spacing would match", async () => {
    const result = await run();
    const mint = assertPageWrite(result);
    for (const wrong of ["vegetarian", WANT.toLowerCase(), ` ${WANT} `]) {
      expect(() => mintExempt({ ...mint, text: wrong }, "optionLabel", 3000, "", mint.authority, null, result.model.windows.get("form")!)).toThrow(/not exactly one/u);
    }
    expect(() => mintExempt(mint, "optionLabel", 3000, "", mint.authority)).toThrow(/current options are unavailable/u);
  });

  it("revalidates options after both questions, before minting", async () => {
    const model = desk();
    const result = await run(model, { after: () => model.apply(snap(form([OPTIONS[0]!, OPTIONS[1]!]), { at: 4000, windowId: "form", kind: PAGE_WINDOW_KIND, title: "RSVP", focused: true })) });
    expect(result.field.handoff).toBeNull();
    expect(result.mint).toBeUndefined();
  });

  it("revalidates exact labels again immediately before dispatch", async () => {
    const result = await run();
    const mint = assertPageWrite(result);
    const guard = guardFor(() => result.model, new Map([[0, mint]]), mint.authority, null, null);
    expect(guard(0, WANT)).toBeNull();
    result.model.apply(snap(form([OPTIONS[0]!, OPTIONS[1]!]), { at: 4000, windowId: "form", kind: PAGE_WINDOW_KIND, title: "RSVP", focused: true }));
    expect(guard(0, WANT)).toMatch(/not exactly one/u);
  });

  it("does not exempt a code-inferred mapping with stated chosen provenance", async () => {
    const result = await run();
    const mint = assertPageWrite(result);
    const provenance = { ...mint.provenance, kind: "derived" as const, how: "sourceSupported" as const, base: { kind: "instruction" as const, span: NOTE }, also: null, says: "code inferred an option mapping" };
    expect(() => mintExempt({ ...mint, provenance }, "optionLabel", 3000, "", mint.authority, null, result.model.windows.get("form")!)).toThrow(ContractError);
    expect(() => mintExempt({ ...mint, provenance }, "optionLabel", 3000, "", mint.authority, null, result.model.windows.get("form")!)).toThrow(/derived by a choice code made/u);
  });

  it("a native AXPopUpButton keeps its handoff and verifier", async () => {
    const result = await run(desk(OPTIONS, "standard"));
    expect(result.field).toMatchObject({ withheld: null, handoff: { value: WANT } });
    expect(result.field.handoff?.writes).toBeUndefined();
    expect(result.mint?.verdict.by).toBe("verifier");
    expect(result.requests.filter((r) => r.purpose === "fill.verify")).toHaveLength(2);
    expect(writtenFields(result.proposal).fields).toEqual([]);
  });

  it("a user pick gets a fresh bounded pair and then the same exact-label exemption", async () => {
    const result = await run(desk(), { disagree: true });
    const settlement = valueSettlementOf(result.proposal)!;
    const unresolved = settlement.unresolved.find((f) => f.key === "meal")!;
    const option = unresolved.options.find((o) => o.value === WANT && o.source.endsWith(": the whole text"))!;
    const requests: JevRequest[] = [];
    const settled = await settlement.settle("meal", option.id, { model: result.model, askJev: judge(requests) });
    expect(settled).toMatchObject({ handoff: { value: WANT, writes: true }, withheld: null });
    expect(mintOf(settled!)?.verdict).toEqual({ by: "exempt", rule: "optionLabel" });
    expect(requests).toHaveLength(2);
  });

  it.each([PAGE_WINDOW_KIND, "standard"])("a %s popup with unseen options stays unasked and unwritten", async (kind) => {
    const model = desk(null, kind);
    model.apply(snap([text("extra", "Meal: Vegetarian")], { at: 1000, windowId: "note", title: "Dinner", app: NOTES, focused: true }));
    const result = await run(model);
    expect(result.field).toMatchObject({ handoff: null, value: null, asks: [] });
    expect(result.requests).toHaveLength(0);
    expect(result.mint).toBeUndefined();
  });
});

describe("select option cut kinds", () => {
  it("does not read bare party counts as dates", () => {
    expect([...optionKinds(["1", "2", "3"])]).toEqual([]);
    expect([...optionKinds(["1", "2", "3"], "day")]).toEqual(["date"]);
    expect([...optionKinds(["1", "2", "3"], "month")]).toEqual(["date"]);
  });
  it.each([
    [OPTIONS, []],
    [["January", "Feb", "Monday", "2027"], ["date"]],
    [["California", "TX"], ["address"]],
    [["3:00 PM", "9:30 AM"], ["time"]],
    [["a@example.test", "b@example.test"], ["email"]],
  ] as const)("reads %j as %j", (options, kinds) => {
    expect([...optionKinds(options)].sort()).toEqual([...kinds].sort() as ValueKind[]);
  });
});
