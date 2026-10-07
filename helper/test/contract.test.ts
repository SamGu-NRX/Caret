// W2: the write contract (src/fill/contract.ts), each part with one correct answer tested alone: the deterministic
// shape checks, the mint's identity, the compilers' refusals of a missing or mismatched mint. All text is synthetic.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { checkValues, ContractError, fieldContract, isChecked, makeFieldContract, mintExempt, requireChecked, shapeRefusal, sourceLabel, type FieldContract, type Proposed, type Provenance } from "../src/fill/contract.ts";
import { fieldKinds } from "../src/fill/kinds.ts";
import { fieldPart } from "../src/fill/derive.ts";
import { PlannerError, validatePlan } from "../src/planner/validate.ts";
import type { Node } from "../src/protocol.ts";
import { field, snap, text } from "./builders.ts";

const WIN = "form";
const desk = (nodes: Node[]): ScreenModel => {
  const m = new ScreenModel();
  m.apply(snap(nodes, { at: 1000, windowId: WIN, title: "Application", focused: true }));
  return m;
};
/** A field contract read from a label alone, with an input kind and a maxlength when given. */
const fc = (label: string, o: { inputKind?: Node["inputKind"]; maxLength?: number; key?: string } = {}): FieldContract =>
  makeFieldContract({ windowId: WIN, node: { key: o.key ?? `k:${label}`, parent: null, role: "AXTextField", label, ...(o.inputKind === undefined ? {} : { inputKind: o.inputKind }), ...(o.maxLength === undefined ? {} : { maxLength: o.maxLength }) }, descriptor: label, name: label, labelWords: [label], control: "text", kinds: fieldKinds([label]), part: fieldPart(label) });
const win = (span: string, label: string | null = null, partOf: string | null = null): Provenance => ({ kind: "window", windowId: "note", nodeKey: "n", app: "TextEdit", title: "notes.txt", span, label, line: null, partOf });
const prop = (field: FieldContract, text: string, provenance: Provenance = win(text)): Proposed => ({ field, text, display: text, provenance, owner: null });
const opts = { askJev: null, ledger: null, now: 1 };

describe("shapeRefusal: the input's own kind", () => {
  it.each([
    ["email", "dana@lumen.example", true],
    ["email", "Dana Whitfield", false],
    ["email", "dana@lumen.example, bo@lumen.example", false],
    ["number", "1450", true],
    ["number", "1,450", false],
    ["number", "-3.5", true],
    ["tel", "(720) 555-0146", true],
    ["tel", "+1 720 555 0146 ext 12", true],
    ["tel", "call me", false],
    ["url", "https://github.com/harperq-data", true],
    ["url", "my site is github.com/harperq", false],
    ["date", "2026-10-08", false],
    ["text", "anything at all", true],
  ] as const)("%s input takes '%s': %s", (kind, value, ok) => {
    expect(shapeRefusal(prop(fc("Answer", { inputKind: kind }), value)) === null).toBe(ok);
  });

  it("refuses text over the field's maxlength, and a value Caret never types by its shape", () => {
    expect(shapeRefusal(prop(fc("Code", { maxLength: 4 }), "ABCDE"))).toMatch(/longer than the 4/u);
    expect(shapeRefusal(prop(fc("Code", { maxLength: 4 }), "ABCD"))).toBeNull();
    expect(shapeRefusal(prop(fc("Notes"), "4242 4242 4242 4242"))).toMatch(/never types/u);
  });

  it("keeps the label's kinds and parts: no email in Phone, no sentence in First name", () => {
    expect(shapeRefusal(prop(fc("Phone"), "dana@lumen.example"))).not.toBeNull();
    expect(shapeRefusal(prop(fc("First name"), "Dr. Simone Achebe, my manager"))).not.toBeNull();
    expect(shapeRefusal(prop(fc("First name"), "Mary Ann"))).toBeNull();
  });
});

describe("sourceLabel: what labels a value, as W1's gate reads it", () => {
  it("is the line's label, the memory entry's label, the field for an instruction, and the part for a derived name", () => {
    expect(sourceLabel(prop(fc("First name"), "Mary Ann", win("Mary Ann", "First name")))).toBe("First name");
    expect(sourceLabel(prop(fc("First name"), "Mary Ann", { kind: "memory", id: "about-1", label: "Name", part: null, whose: "user" }))).toBe("Name");
    expect(sourceLabel(prop(fc("First name"), "Mary Ann", { kind: "instruction", span: "Mary Ann" }))).toBe("First name");
    expect(sourceLabel(prop(fc("First name"), "Mary", { kind: "derived", how: "namePart", base: win("Mary Ann Okafor", "Name"), also: null }))).toBe("first name");
    expect(sourceLabel(prop(fc("City"), "Austin", { kind: "derived", how: "addressPart", base: win("455 Congress Ave, Austin, TX", "Address"), also: null }))).toBe("Address");
  });
});

describe("checkValues and the mint", () => {
  it("mints a value that passes, refuses one that fails as wrongKind, and carries the source label (REVIEW-R2 P2.5)", async () => {
    const first = fc("First name");
    const r = await checkValues([prop(first, "Mary Ann", win("Mary Ann", "First name")), prop(first, "Mary Ann"), prop(fc("Phone"), "dana@lumen.example")], opts);
    expect(r.ok.map((c) => c.text)).toEqual(["Mary Ann"]);
    expect(r.ok[0]?.verdict).toEqual({ by: "code" });
    expect(r.refused.map((x) => [x.proposed.text, x.why])).toEqual([["Mary Ann", "wrongKind"], ["dana@lumen.example", "wrongKind"]]);
  });

  it("refuses a value the instruction labels a secret", async () => {
    const r = await checkValues([prop(fc("Notes"), "sw0rdfish", { kind: "instruction", span: "sw0rdfish" })], { ...opts, instruction: "put my password sw0rdfish in Notes" });
    expect(r.ok).toEqual([]);
  });

  it("is checked only as the very object minted: a structuredClone, a JSON copy or a look-alike is not", async () => {
    const [c] = (await checkValues([prop(fc("Job title"), "lab technician")], opts)).ok;
    expect(isChecked(c)).toBe(true);
    expect(isChecked(structuredClone(c))).toBe(false);
    expect(isChecked(JSON.parse(JSON.stringify(c)))).toBe(false);
    expect(isChecked({ ...c })).toBe(false);
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("requireChecked names what failed: no mint, another text, another field", async () => {
    const [c] = (await checkValues([prop(fc("Job title", { key: "k1" }), "lab technician")], opts)).ok;
    const code = (f: () => unknown): string => {
      try {
        f();
        return "passed";
      } catch (e) {
        return e instanceof ContractError ? e.code : String(e);
      }
    };
    expect(code(() => requireChecked(c, "lab technician", "k1", "x"))).toBe("passed");
    expect(code(() => requireChecked(structuredClone(c), "lab technician", "k1", "x"))).toBe("unchecked");
    expect(code(() => requireChecked(undefined, "lab technician", "k1", "x"))).toBe("unchecked");
    expect(code(() => requireChecked(c, "Senior Engineer", "k1", "x"))).toBe("textMismatch");
    expect(code(() => requireChecked(c, "lab technician", "k2", "x"))).toBe("targetMismatch");
  });

  it("mints an exemption by its rule, and never a value Caret never types", () => {
    const c = mintExempt(prop(fc("Country"), "Canada"), "optionLabel", 1);
    expect(isChecked(c)).toBe(true);
    expect(c.verdict).toEqual({ by: "exempt", rule: "optionLabel" });
    expect(() => mintExempt(prop(fc("Notes"), "4242 4242 4242 4242"), "userTransfer", 1)).toThrow(ContractError);
  });
});

describe("fieldContract", () => {
  it("reads a field as fill does, with the page's input kind, and refuses a field Caret never types", () => {
    const m = desk([field("f/city", "", { label: "City" }), field("f/addr", "", { label: "Address" }), field("f/mail", "", { label: "Email", inputKind: "email", maxLength: 80 }), field("f/ssn", "", { label: "SSN" }), field("f/pin", "", { label: "PIN", states: ["secure"] })]);
    const w = m.windows.get(WIN);
    if (w === undefined) throw new Error("no window");
    const node = (k: string): Node => w.nodes.get(k) as Node;
    // An Address beside a City field is the street line.
    expect(fieldContract(w, node("f/addr")).part).toBe("street");
    expect(fieldContract(w, node("f/mail"))).toMatchObject({ inputKind: "email", maxLength: 80, name: "Email" });
    expect(() => fieldContract(w, node("f/ssn"))).toThrow(ContractError);
    expect(() => fieldContract(w, node("f/pin"))).toThrow(ContractError);
  });
});

describe("validatePlan takes the mints and refuses without one", () => {
  const m = desk([text("n/0", "Job title: lab technician"), field("f/job", "", { label: "Job title" })]);
  const w = m.windows.get(WIN);
  if (w === undefined) throw new Error("no window");
  const plan = { id: "p", title: "p", slots: { v1: "the job" }, steps: [{ says: "Job title", end: { kind: "valueEquals", window: { bundleId: w.app.bundleId, title: "Application" }, target: { key: "f/job", describe: "Job title" }, value: "{{v1}}" } }] };
  const ctx = { model: m, memory: [], instruction: "fill in my job" };

  it("passes the slot's mint for exactly its text in exactly its field", async () => {
    const [c] = (await checkValues([prop(fieldContract(w, w.nodes.get("f/job") as Node), "lab technician")], opts)).ok;
    if (c === undefined) throw new Error("not minted");
    expect(validatePlan(plan, { v1: "lab technician" }, ctx, new Map([["v1", c]])).writes[0]?.checked).toBe(c);
    // Another text than the slot holds, no mint, a copy of the mint: each is the contract's error, not a plan refusal.
    expect(() => validatePlan(plan, { v1: "Job title: lab technician" }, ctx, new Map([["v1", c]]))).toThrow(ContractError);
    expect(() => validatePlan(plan, { v1: "lab technician" }, ctx, new Map())).toThrow(ContractError);
    expect(() => validatePlan(plan, { v1: "lab technician" }, ctx, new Map([["v1", structuredClone(c)]]))).toThrow(ContractError);
  });

  it("refuses a field that no longer reads as it did when its value was checked", async () => {
    const other = makeFieldContract({ windowId: WIN, node: w.nodes.get("f/job") as Node, descriptor: "Job title (as it read before).", name: "Job title", labelWords: ["Job title"], control: "text", kinds: new Set(), part: null });
    const [c] = (await checkValues([prop(other, "lab technician")], opts)).ok;
    try {
      validatePlan(plan, { v1: "lab technician" }, ctx, new Map([["v1", c as never]]));
      throw new Error("passed");
    } catch (e) {
      expect(e instanceof PlannerError ? e.code : String(e)).toBe("unknownTarget");
    }
  });
});
