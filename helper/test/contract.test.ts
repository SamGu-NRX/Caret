// W2: the write contract (src/fill/contract.ts), each part with one correct answer tested alone: the deterministic
// shape checks, the mint's identity, the compilers' refusals of a missing or mismatched mint. All text is synthetic.
import { TEST_AUTHORITY } from "./mint.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { checkValues, ContractError, fieldContract, isChecked, makeFieldContract, mintExempt, provenanceSays, requireChecked, setTestVerifier, takesSays, shapeRefusal, sourceLabel, VERDICTS, VerifierUnavailable, VERIFY_BATCH, type FieldContract, type Proposed, type Provenance } from "../src/fill/contract.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { fieldKinds } from "../src/fill/kinds.ts";
import { fieldPart } from "../src/fill/derive.ts";
import { PlannerError, validatePlan } from "../src/planner/validate.ts";
import type { Node } from "../src/protocol.ts";
import { field, snap, text } from "./builders.ts";
import { exactJev } from "./mint.ts";

const WIN = "form";
const desk = (nodes: Node[]): ScreenModel => {
  const m = new ScreenModel();
  m.apply(snap(nodes, { at: 1000, windowId: WIN, title: "Application", focused: true }));
  return m;
};
/** A field contract read from a label alone, with an input kind and a maxlength when given. */
const fc = (label: string, o: { inputKind?: Node["inputKind"]; maxLength?: number; key?: string } = {}): FieldContract =>
  makeFieldContract({ windowId: WIN, node: { key: o.key ?? `k:${label}`, parent: null, role: "AXTextField", label, ...(o.inputKind === undefined ? {} : { inputKind: o.inputKind }), ...(o.maxLength === undefined ? {} : { maxLength: o.maxLength }) }, descriptor: label, name: label, labelWords: [label], control: "text", kinds: fieldKinds([label]), part: fieldPart(label) });
const win = (span: string, label: string | null = null, partOf: string | null = null): Provenance => ({ kind: "window", windowId: "note", nodeKey: "n", app: "TextEdit", title: "notes.txt", span, label, line: null, partOf, context: label, lines: [], sentences: [] });
const prop = (field: FieldContract, text: string, provenance: Provenance = win(text)): Proposed => ({ field, text, display: text, provenance, owner: null });
const opts = { askJev: exactJev, ledger: null, now: 1, authority: TEST_AUTHORITY };

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
  it("mints a value that passes, refuses one the shape checks refuse as wrongKind, and keeps its provenance (REVIEW-R2 P2.5)", async () => {
    const first = fc("First name");
    const labelled = prop(first, "Mary Ann", win("Mary Ann", "First name"));
    const r = await checkValues([labelled, prop(fc("Phone"), "dana@lumen.example")], opts);
    expect(r.ok.map((c) => c.text)).toEqual(["Mary Ann"]);
    expect(r.ok[0]?.verdict).toMatchObject({ by: "verifier", confidence: 0.95 });
    expect(r.ok[0]?.provenance).toEqual(labelled.provenance);
    expect(r.refused.map((x) => [x.proposed.text, x.why])).toEqual([["dana@lumen.example", "wrongKind"]]);
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
    expect(code(() => requireChecked(c, "lab technician", "k1", WIN, "x"))).toBe("passed");
    expect(code(() => requireChecked(structuredClone(c), "lab technician", "k1", WIN, "x"))).toBe("unchecked");
    expect(code(() => requireChecked(undefined, "lab technician", "k1", WIN, "x"))).toBe("unchecked");
    expect(code(() => requireChecked(c, "Senior Engineer", "k1", WIN, "x"))).toBe("textMismatch");
    expect(code(() => requireChecked(c, "lab technician", "k2", WIN, "x"))).toBe("targetMismatch");
  });

  it("mints an exemption by its rule, and never a value Caret never types", () => {
    const c = mintExempt(prop(fc("Country"), "Canada"), "optionLabel", 1, "", TEST_AUTHORITY);
    expect(isChecked(c)).toBe(true);
    expect(c.verdict).toEqual({ by: "exempt", rule: "optionLabel" });
    expect(() => mintExempt(prop(fc("Notes"), "4242 4242 4242 4242"), "userTransfer", 1, "", TEST_AUTHORITY)).toThrow(ContractError);
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
  const ctx = { model: m, memory: [], instruction: "fill in my job", origin: TEST_AUTHORITY };

  it("passes the slot's mint for exactly its text in exactly its field", async () => {
    const [c] = (await checkValues([prop(fieldContract(w, w.nodes.get("f/job") as Node), "lab technician", { kind: "instruction", span: "lab technician" })], opts)).ok;
    if (c === undefined) throw new Error("not minted");
    expect(validatePlan(plan, { v1: "lab technician" }, ctx, new Map([["v1", c]])).writes[0]?.checked).toBe(c);
    // Another text than the slot holds, no mint, a copy of the mint: each is the contract's error, not a plan refusal.
    expect(() => validatePlan(plan, { v1: "Job title: lab technician" }, ctx, new Map([["v1", c]]))).toThrow(ContractError);
    expect(() => validatePlan(plan, { v1: "lab technician" }, ctx, new Map())).toThrow(ContractError);
    expect(() => validatePlan(plan, { v1: "lab technician" }, ctx, new Map([["v1", structuredClone(c)]]))).toThrow(ContractError);
  });

  it("refuses a field that no longer reads as it did when its value was checked", async () => {
    const other = makeFieldContract({ windowId: WIN, node: w.nodes.get("f/job") as Node, descriptor: "Job title (as it read before).", name: "Job title", labelWords: ["Job title"], control: "text", kinds: new Set(), part: null });
    const [c] = (await checkValues([prop(other, "lab technician", { kind: "instruction", span: "lab technician" })], opts)).ok;
    try {
      validatePlan(plan, { v1: "lab technician" }, ctx, new Map([["v1", c as never]]));
      throw new Error("passed");
    } catch (e) {
      expect(e instanceof PlannerError ? e.code : String(e)).toBe("unknownTarget");
    }
  });
});

describe("the verifier (AC1 section 4)", () => {
  beforeAll(() => setTestVerifier(null));
  afterAll(() => setTestVerifier(exactJev));
  /** A verifier that answers each wording by rule, and records its requests. */
  const verifier = (rule: (wording: 0 | 1, text: string) => { choice: string; confidence: number } | undefined) => {
    const requests: JevRequest[] = [];
    const ask: AskJev = async (req) => {
      requests.push(req);
      const wording = String(Object.values(req.questions)[0]?.instructions ?? "").startsWith("Field:") ? 0 : 1;
      const answers = Object.fromEntries(Object.entries(req.questions).flatMap(([id, q]) => {
        const text = /"([^"]*)"/u.exec(String(q.instructions))?.[1] ?? "";
        const a = rule(wording, text);
        return a === undefined ? [] : [[id, a]];
      }));
      return { model: "verify-test", answers, inputTokens: 100, latencyMs: wording === 0 ? 120 : 90, costUsd: 0.00001 };
    };
    return { ask, requests };
  };
  const job = fc("Job title");

  it("mints only when both wordings answer exact at the cutoff, and says why otherwise", async () => {
    const v = verifier((w, t) => (t === "lab technician" ? { choice: "exact", confidence: 0.9 } : t === "lab tech" ? { choice: "exact", confidence: w === 0 ? 0.9 : 0.6 } : t === "Lumen Labs" ? { choice: w === 0 ? "exact" : "other", confidence: 0.9 } : { choice: "more", confidence: 0.95 }));
    const r = await checkValues([prop(job, "lab technician"), prop(job, "lab tech"), prop(job, "Lumen Labs"), prop(job, "Lab technician II")], { ...opts, askJev: v.ask });
    expect(r.ok.map((c) => c.text)).toEqual(["lab technician"]);
    expect(r.refused.map((x) => [x.proposed.text, x.why, x.says])).toEqual([
      ["lab tech", "notExact", "Caret wasn't sure enough that 'lab tech' is exactly what the field asks for (0.60 under 0.75)"],
      ["Lumen Labs", "notExact", "Caret's two checks disagreed about 'Lumen Labs'"],
      ["Lab technician II", "notExact", "'Lab technician II' holds more than the field asks for"],
    ]);
    // Two requests, one per wording, in parallel; the cost and the slower one's latency are counted.
    expect(v.requests.map((q) => q.purpose)).toEqual(["fill.verify", "fill.verify"]);
    expect(r.jev).toEqual({ requests: 2, model: "verify-test", latencyMs: 120, inputTokens: 200, costUsd: 0.00002 });
  });

  it("asks nothing about a value the shape checks refuse", async () => {
    const v = verifier(() => ({ choice: "exact", confidence: 0.99 }));
    const r = await checkValues([prop(fc("Phone"), "dana@lumen.example")], { ...opts, askJev: v.ask });
    expect(v.requests).toEqual([]);
    expect(r.refused[0]?.why).toBe("wrongKind");
  });

  it("is unavailable, never a write, on a Jev failure, a missing answer, an abort or no Jev", async () => {
    const failing: AskJev = async () => {
      throw new Error("Jev HTTP 402: no credits");
    };
    await expect(checkValues([prop(job, "lab technician")], { ...opts, askJev: failing })).rejects.toBeInstanceOf(VerifierUnavailable);
    await expect(checkValues([prop(job, "lab technician")], { ...opts, askJev: verifier((w) => (w === 0 ? { choice: "exact", confidence: 0.9 } : undefined)).ask })).rejects.toBeInstanceOf(VerifierUnavailable);
    const aborted = AbortSignal.abort();
    await expect(checkValues([prop(job, "lab technician")], { ...opts, askJev: verifier(() => ({ choice: "exact", confidence: 0.9 })).ask, signal: aborted })).rejects.toBeInstanceOf(VerifierUnavailable);
    await expect(checkValues([prop(job, "lab technician")], { ...opts, askJev: null })).rejects.toBeInstanceOf(VerifierUnavailable);
  });

  it("asks at most VERIFY_BATCH values per request, both wordings per batch", async () => {
    const v = verifier(() => ({ choice: "exact", confidence: 0.9 }));
    const many = Array.from({ length: VERIFY_BATCH + 3 }, (_, i) => prop(fc(`Field ${i}`), `value ${i}`));
    const r = await checkValues(many, { ...opts, askJev: v.ask });
    expect(r.ok).toHaveLength(VERIFY_BATCH + 3);
    expect(v.requests.map((q) => Object.keys(q.questions).length).sort((a, b) => a - b)).toEqual([3, 3, VERIFY_BATCH, VERIFY_BATCH]);
  });

  it("quotes the line, the label or the span by what the ledger admits, and declares only what it sends", async () => {
    const pr = win("lab technician", "Work", "Lumen Labs, lab technician (for my sister)");
    const line: Provenance = { ...pr, line: "Work: Lumen Labs, lab technician (for my sister)" } as Provenance;
    expect(provenanceSays(line, () => true)).toBe(`the line "Work: Lumen Labs, lab technician (for my sister)" in TextEdit 'notes.txt', which is part of "Lumen Labs, lab technician (for my sister)"`);
    expect(provenanceSays(line, (t) => !t.startsWith("Work:"))).toBe(`"lab technician" labelled 'Work' in TextEdit 'notes.txt', which is part of "Lumen Labs, lab technician (for my sister)"`);
    expect(provenanceSays(line, (t) => t === "lab technician")).toBe(`"lab technician" in TextEdit`);
    expect(provenanceSays({ kind: "derived", how: "namePart", base: { kind: "memory", id: "a", label: "Name", part: null, whose: "user" }, also: null }, () => true)).toBe("a part of the name in what the user told Caret as 'Name'");
    const v = verifier(() => ({ choice: "exact", confidence: 0.9 }));
    await checkValues([prop(job, "lab technician", line)], { ...opts, askJev: v.ask, instruction: "fill in my job" });
    for (const q of v.requests) {
      expect(q.state).toMatchObject({ instruction: "fill in my job" });
      expect(Object.values(q.questions)[0]?.criteria).toEqual(VERDICTS);
      const sent = JSON.stringify([q.state, q.questions]);
      for (const sn of q.snippets) expect(sent.includes(sn.text)).toBe(true);
    }
  });
});

describe("the page's autocomplete field name (AC1 step 7)", () => {
  const withAc = (label: string, autocomplete: NonNullable<Node["autocomplete"]>): FieldContract =>
    makeFieldContract({ windowId: WIN, node: { key: `k:${label}`, parent: null, role: "AXTextField", label, autocomplete }, descriptor: label, name: label, labelWords: [label], control: "text", kinds: fieldKinds([label]), part: fieldPart(label) });

  it.each([
    ["Name", "given-name", "first"],
    ["Name", "family-name", "last"],
    ["Address", "street-address", "street"],
    ["Line 2", "address-line2", "unit"],
    ["Town", "address-level2", "city"],
    ["Code", "postal-code", "zip"],
    ["Day", "bday-day", "day"],
    ["Company", "organization", null],
  ] as const)("a '%s' field marked %s takes the part %s", (label, ac, part) => {
    expect(withAc(label, ac).part).toBe(part);
  });

  it("adds the kind the page names and says it to the verifier", () => {
    const f = withAc("Contact", "email");
    expect([...f.kinds]).toContain("email");
    expect(shapeRefusal(prop(f, "Dana Whitfield"))).not.toBeNull();
    expect(takesSays(withAc("Employer", "organization"))).toBe(" The field takes an organization's name.");
    expect(takesSays(withAc("Name", "given-name"))).toBe(" The field takes only a person's first name.");
  });
});
