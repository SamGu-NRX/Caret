// P4 - Exclusion properties (G3): what the write contract refuses whatever the verifier would answer.
//
// Three gates, in the order the contract applies them (helper/src/fill/contract.ts shapeRefusal:507-524 and
// checkValues:1059; memory/sensitive.ts):
//   1. the value's shape gives it away (valueKind: a Luhn-valid card, a dashed SSN, an IBAN, a known API-key
//      shape) - "Caret never types ...; that is yours to enter", before the verifier is ever asked;
//   2. the label names a secret kind (labelKind, LABEL_PHRASES) - the field contract itself is refused;
//   3. the prose around the value states it (trace.ts secretIn: the four words either side of the value name a
//      secret kind) - the instruction contributes nothing. statedSecret (sensitive.ts) is the memory-capture
//      cousin, written for saved answers; it is stricter about form and misses imperatives, which is safe there.
// The redacted view (fill/redact.ts redactWindow) drops what any of these would catch.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ScreenModel, nodeText } from "../../src/model.ts";
import { checkValues, ContractError, fieldContract, makeFieldContract, mintExempt, shapeRefusal, type FieldContract, type Proposed } from "../../src/fill/contract.ts";
import { labelKind, valueKind } from "../../src/memory/sensitive.ts";
import { secretIn } from "../../src/planner/trace.ts";
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

describe("no prose naming a secret is taken as a value: the instruction contributes nothing (trace.ts secretIn)", () => {
  it("a sentence the prose gate flags refuses the value it states, in an arbitrary field", async () => {
    // Awaited: an un-awaited property outlives its test and races the next test's beforeEach/afterEach,
    // which is how the seed-20261008 CI run ended in unhandled rejections on a closed store.
    await fc.assert(
      fc.asyncProperty(arbSecretSentence, arbPlainLabel, async ([sentence, token], label) => {
        // What matters is the write, not the memory-capture verdict: whatever the prose gate flags is
        // never minted for any field. Where the window misses (filler between the label phrase and the
        // value), the it.fails below records the escape end to end.
        if (secretIn(token, sentence) !== null) {
          const r = await checkValues([prop(contractFor(label), token)], { ...opts, instruction: sentence });
          expect(r.ok).toEqual([]);
        }
      }),
      runs(120),
    );
  });

  it.fails("a stated password escapes when filler words push the label phrase out of the four-word window", async () => {
    // REAL BUG (found by this property's CI seed): 'my password for the portal is aaaaaa' - statedSecret
    // catches it, but the write path does not. secretIn (planner/trace.ts:24) reads only the four words
    // before and after the value ('for the portal is'), so the label phrase is out of reach,
    // neverTypedRefusal (fill/contract.ts) does not refuse, and the mint lands; validatePlan accepts the
    // traced value and the executor types the password. A miss costs a typed secret - the widest-cost side
    // of the window trade-off - so the window (or the shape of the sentence it reads) has to widen.
    const sentence = "my password for the portal is aaaaaa";
    const r = await checkValues([prop(contractFor("Notes"), "aaaaaa")], { ...opts, instruction: sentence });
    expect(r.ok).toEqual([]);
  });
});

describe("the redacted view keeps no line that names a secret (fill/redact.ts redactWindow)", () => {
  it("an arbitrary stated secret among ordinary lines is dropped, whatever happens to the lines around it", async () => {
    // Awaited: the property must live inside its test's lifetime (see the prose-gate property above).
    await fc.assert(
      fc.asyncProperty(arbSecretSentence, fc.array(fc.constantFrom("Start date: March 3", "City: Austin", "Preferred language: English", "Company: Ridgeline Outdoor Co"), { minLength: 1, maxLength: 3 }), async ([sentence, token], innocent) => {
        const lines = [...innocent, sentence];
        const m = new ScreenModel();
        m.apply(snap([text("n/0", lines.join("\n"))], { at: 1000, windowId: "note", title: "notes.txt", focused: true }));
        const w = m.windows.get("note");
        if (w === undefined) throw new Error("no window");
        const redacted = redactWindow(w);
        // The leak surface is what fill reads: the window's title and every node's text and label. Checking the
        // whole serialized view would trip on coordinates and keys; the value's characters there are not a leak.
        const texts = redacted === null ? "" : [redacted.window.title, ...[...redacted.nodes.values()].flatMap((n) => [n.label ?? "", nodeText(n)])].join("\n");
        expect(texts.includes(token)).toBe(false);
        expect(texts.includes(sentence)).toBe(false);
        // No expectation that the innocent lines stay: redactWindow drops a text node whole rather than
        // leak, so a secret sharing a node with ordinary lines takes them with it. Over-withholding is the
        // safe side; per-line surgery is not this function's contract.
      }),
      runs(80),
    );
  });
});
