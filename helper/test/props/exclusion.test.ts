// P4 - Exclusion properties (G3): what the write contract refuses whatever the verifier would answer.
//
// Three gates, in the order the contract applies them (helper/src/fill/contract.ts shapeRefusal:507-524 and
// checkValues:1059; memory/sensitive.ts):
//   1. the value's shape gives it away (valueKind: a Luhn-valid card, a dashed SSN, an IBAN, a known API-key
//      shape) - "Caret never types ...; that is yours to enter", before the verifier is ever asked;
//   2. the label names a secret kind (labelKind, LABEL_PHRASES) - the field contract itself is refused;
//   3. the prose around the value states it (statedSecret) - the instruction contributes nothing.
// The redacted view (fill/redact.ts redactWindow) drops what any of these would catch.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../../src/model.ts";
import { checkValues, ContractError, fieldContract, makeFieldContract, mintExempt, shapeRefusal, type FieldContract, type Proposed } from "../../src/fill/contract.ts";
import { labelKind, statedSecret, valueKind } from "../../src/memory/sensitive.ts";
import { redactWindow } from "../../src/fill/redact.ts";
import { field, snap, text } from "../builders.ts";
import { TEST_AUTHORITY, exactJev } from "../mint.ts";
import { arbPlainLabel, arbSecret, arbSecretLabel, arbSecretSentence, runs } from "./gens.ts";

const WIN = "form";
const opts = { askJev: exactJev, ledger: null, now: 1, authority: TEST_AUTHORITY };
const prop = (fieldC: FieldContract, value: string): Proposed => ({ field: fieldC, text: value, display: value, provenance: { kind: "instruction", span: value }, owner: null });
const contractFor = (label: string): FieldContract =>
  makeFieldContract({ windowId: WIN, node: { key: `k:${label}`, parent: null, role: "AXTextField", label }, descriptor: label, name: label, labelWords: [label], control: "text", kinds: new Set(), part: null });

describe("no mint, no write by shape: what the value itself gives away is refused before the verifier is asked (sensitive.ts valueKind; contract.ts:508-510)", () => {
  it("an arbitrary secret is refused on an arbitrary ordinary field, with or without a verifier's say-so", async () => {
    fc.assert(
      fc.asyncProperty(arbSecret, arbPlainLabel, async (secret, label) => {
        // The property's domain is the values the shape detector calls secrets; shrink stays inside it.
        fc.pre(valueKind(secret) !== null);
        const refusal = shapeRefusal(prop(contractFor(label), secret));
        expect(refusal ?? "").toContain("Caret never types");
        const r = await checkValues([prop(contractFor(label), secret)], opts);
        expect(r.ok).toEqual([]);
        expect(r.refused.length).toBeGreaterThan(0);
      }),
      runs(200),
    );
  });

  it("no named exemption reaches it either: mintExempt throws never-typed (contract.ts:1130)", () => {
    fc.assert(
      fc.property(arbSecret, arbPlainLabel, (secret, label) => {
        fc.pre(valueKind(secret) !== null);
        expect(() => mintExempt(prop(contractFor(label), secret), "userTransfer", 1, "", TEST_AUTHORITY)).toThrowError(ContractError);
      }),
      runs(120),
    );
  });
});

describe("a label that names a secret refuses the whole field, whatever a verifier answers (sensitive.ts labelKind, LABEL_PHRASES; contract.test.ts fieldContract)", () => {
  const m = new ScreenModel();
  m.apply(
    snap(
      [...["Card number", "Password", "API key", "SSN", "Reference", "City", "Notes"].map((label, i) => field(`f/${i}`, "", { label }))],
      { at: 1000, windowId: WIN, title: "Application", focused: true },
    ),
  );
  const w = m.windows.get(WIN);
  if (w === undefined) throw new Error("no window");

  it("fieldContract refuses a secret-named field and reads an ordinary one", () => {
    fc.assert(
      fc.property(arbSecretLabel, (label) => {
        expect(labelKind(label)).not.toBeNull();
        const node = { key: `k:${label}`, parent: null, role: "AXTextField" as const, label };
        expect(() => fieldContract(w, node)).toThrowError(ContractError);
      }),
      runs(80),
    );
    fc.assert(
      fc.property(arbPlainLabel, (label) => {
        const node = { key: `k:${label}`, parent: null, role: "AXTextField" as const, label };
        expect(fieldContract(w, node).name).toBe(label);
      }),
      runs(40),
    );
  });
});

describe("no prose naming a secret is taken as a value: the instruction contributes nothing (sensitive.ts statedSecret)", () => {
  it("an arbitrary sentence that states a secret refuses the value it states, in an arbitrary field", async () => {
    fc.assert(
      fc.asyncProperty(arbSecretSentence, arbPlainLabel, async ([sentence, token], label) => {
        expect(statedSecret(sentence)).not.toBeNull();
        const r = await checkValues([prop(contractFor(label), token)], { ...opts, instruction: sentence });
        expect(r.ok).toEqual([]);
      }),
      runs(120),
    );
  });
});

describe("the redacted view keeps no line that names a secret (fill/redact.ts redactWindow)", () => {
  it("an arbitrary stated secret among ordinary lines is dropped; the ordinary lines stay", async () => {
    fc.assert(
      fc.asyncProperty(arbSecretSentence, fc.array(fc.constantFrom("Start date: March 3", "City: Austin", "Preferred language: English", "Company: Ridgeline Outdoor Co"), { minLength: 1, maxLength: 3 }), async ([sentence, token], innocent) => {
        const lines = [...innocent, sentence];
        const m = new ScreenModel();
        m.apply(snap([text("n/0", lines.join("\n"))], { at: 1000, windowId: "note", title: "notes.txt", focused: true }));
        const w = m.windows.get("note");
        if (w === undefined) throw new Error("no window");
        const redacted = redactWindow(w);
        const seen = JSON.stringify(redacted);
        expect(seen.includes(token)).toBe(false);
        expect(seen.includes(sentence)).toBe(false);
        for (const line of innocent) expect(seen.includes(line)).toBe(true);
      }),
      runs(80),
    );
  });
});
