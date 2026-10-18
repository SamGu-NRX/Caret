// P1 - No mint, no write (G3): an arbitrary value reaches the page only through the write contract.
//
// The three gates, each with its own property below:
//   1. checkValues mints a value (contract.ts:1059) or refuses it - a value without a verifier is never minted;
//   2. requireChecked (contract.ts:1152-1157) rejects a copy of the mint, another text, another field - identity,
//      not resemblance;
//   3. validatePlan (planner/validate.ts) types a slot only for the mint made of exactly its text - the compiler,
//      not the planner, decides what a plan may write.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../../src/model.ts";
import { checkValues, ContractError, fieldContract, isChecked, requireChecked, setTestVerifier, VerifierUnavailable, type FieldContract, type Proposed } from "../../src/fill/contract.ts";
import type { Node } from "../../src/protocol.ts";
import { validatePlan, PlannerError } from "../../src/planner/validate.ts";
import { field, snap, text } from "../builders.ts";
import { STAND_IN } from "../setup/verifier.ts";
import { TEST_AUTHORITY, exactJev } from "../mint.ts";
import { arbPlainValue, runs } from "./gens.ts";

const WIN = "form";
const desk = (): ScreenModel => {
  const m = new ScreenModel();
  m.apply(snap([text("n/0", "Job title: lab technician"), field("f/job", "", { label: "Job title" }), field("f/mail", "", { label: "Email" })], { at: 1000, windowId: WIN, title: "Application", focused: true }));
  return m;
};

const opts = { askJev: exactJev, ledger: null, now: 1, authority: TEST_AUTHORITY };
const prop = (fieldC: FieldContract, value: string): Proposed => ({ field: fieldC, text: value, display: value, provenance: { kind: "instruction", span: value }, owner: null });

describe("no mint, no write: a value reaches a field only as the checkValues mint of exactly its text, for exactly its field (contract.ts:1152-1157)", () => {
  const m = desk();
  const w = m.windows.get(WIN);
  if (w === undefined) throw new Error("no window");
  const contractFor = (key: string): FieldContract => fieldContract(w, w.nodes.get(key) as Node);
  const plan = { id: "p", title: "p", slots: { v1: "the value" }, steps: [{ says: "Job title", end: { kind: "valueEquals", window: { bundleId: w.app.bundleId, title: "Application" }, target: { key: "f/job", describe: "Job title" }, value: "{{v1}}" } }] };
  const ctx = { model: m, memory: [], instruction: "fill in my job", origin: TEST_AUTHORITY };

  it("an arbitrary value that checkValues minted passes requireChecked only as itself, for its own field", async () => {
    // Every fc.assert here is awaited: an un-awaited property outlives its test and races the next test's
    // beforeEach/afterEach, which is how the seed-20261008 CI run ended in unhandled rejections.
    await fc.assert(
      fc.asyncProperty(arbPlainValue, async (value) => {
        const [c] = (await checkValues([prop(contractFor("f/job"), value)], opts)).ok;
        if (c === undefined) throw new Error("not minted");
        expect(isChecked(c)).toBe(true);
        expect(requireChecked(c, value, "f/job", WIN, "at") === c).toBe(true);
        // Identity, not resemblance: a structurally identical copy is refused exactly like another text.
        expect(() => requireChecked(structuredClone(c), value, "f/job", WIN, "at")).toThrowError(ContractError);
      }),
      runs(150),
    );
  });

  it("a copy of the mint, another text, or another field is the contract's error, not a write (identity, not resemblance)", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlainValue, async (value) => {
        const [c] = (await checkValues([prop(contractFor("f/job"), value)], opts)).ok;
        if (c === undefined) throw new Error("not minted");
        // JSON round-trips are the ordinary way a value crosses a boundary; the mint survives none of them.
        const copies = [structuredClone(c), JSON.parse(JSON.stringify(c)) as unknown, { ...c }];
        for (const copy of copies) expect(() => requireChecked(copy, value, "f/job", WIN, "at")).toThrowError(ContractError);
        expect(() => requireChecked(c, `${value}.`, "f/job", WIN, "at")).toThrowError(ContractError);
        expect(() => requireChecked(c, value, "f/mail", WIN, "at")).toThrowError(ContractError);
      }),
      runs(150),
    );
  });

  it("the compiler types a plan slot only for the mint made of exactly its text (planner/validate.ts)", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlainValue, async (value) => {
        const [c] = (await checkValues([prop(contractFor("f/job"), value)], opts)).ok;
        if (c === undefined) throw new Error("not minted");
        // The mint is typed for the plan only when the instruction carries the value: an untraced value is
        // refused even with its own mint in hand (validate.ts traceValue).
        const traced = { ...ctx, instruction: `fill in my job: ${value}` };
        expect(validatePlan(plan, { v1: value }, traced, new Map([["v1", c]])).writes[0]?.checked).toBe(c);
        // No mint at all, or a copy: the contract refuses the write (requireChecked, contract.ts).
        expect(() => validatePlan(plan, { v1: value }, traced, new Map())).toThrowError(ContractError);
        expect(() => validatePlan(plan, { v1: value }, traced, new Map([["v1", structuredClone(c)] as never]))).toThrowError(ContractError);
        // A slot whose text only contains the mint's text is refused, by whichever gate reaches it first: a
        // value no window holds traces nowhere (validate.ts PlannerError), one the window does hold hits the
        // mint's text mismatch (contract.ts ContractError). Either way there is no write.
        try {
          validatePlan(plan, { v1: `Job title: ${value}` }, traced, new Map([["v1", c]]));
          expect.unreachable("a slot text that only contains the mint's text must be refused");
        } catch (e) {
          expect(e instanceof ContractError || e instanceof PlannerError).toBe(true);
        }
      }),
      runs(120),
    );
  });

  it("no verifier, no mint: with the verifier unavailable, checkValues throws VerifierUnavailable and mints nothing", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlainValue, async (value) => {
        // The W2 setup installs a stand-in verifier for every file; the unavailable path is setTestVerifier(null)
        // with askJev: null (test/setup/verifier.ts, CheckOptions.askJev: null verifies nothing). There is no
        // silent fall-through: with no Jev to verify values with, checkValues throws VerifierUnavailable.
        setTestVerifier(null);
        try {
          await expect(checkValues([prop(contractFor("f/job"), value)], { ...opts, askJev: null })).rejects.toThrowError(VerifierUnavailable);
        } finally {
          setTestVerifier(STAND_IN);
        }
      }),
      runs(60),
    );
  });
});
