// W2: tests of validatePlan's own rules, with each written value minted by the write contract first (fill/contract.ts),
// as every drafter mints before validation. A literal value in a valueEquals step becomes a slot, and is minted in
// its field (fieldContract) with the provenance traceValue finds. A value the contract refuses is left unminted: when
// validatePlan reaches it (no earlier rule refused the plan), the refusal is thrown as the PlannerError("wrongKind")
// the drafter would have thrown.
import { Plan } from "../src/executor/schema.ts";
import { resolveLocally } from "../src/executor/target.ts";
import { checkValues, ContractError, fieldContract, makeFieldContract, mintExempt, windowProvenance, type CheckedValue, type FieldContract, type Provenance } from "../src/fill/contract.ts";
import type { ScreenModel } from "../src/model.ts";
import { fieldPart } from "../src/fill/derive.ts";
import { fieldKinds } from "../src/fill/kinds.ts";
import type { Control } from "../src/fill/controls.ts";
import type { TargetBinding } from "../src/goals/plan.ts";
import { bindMint } from "../src/fill/fill.ts";
import type { FillProposal } from "../src/protocol.ts";
import { traceValue } from "../src/planner/trace.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { PlannerError, validatePlan, type CheckedPlan, type PlanContext } from "../src/planner/validate.ts";

/**
 * A stand-in verifier that answers "exact" at 0.95 to every value check (fill/contract.ts), so a test of what comes after
 * the contract sees the shape checks alone. Any other question is not its to answer.
 */
export const exactJev: AskJev = async (req) => {
  if (req.purpose !== "fill.verify") throw new Error(`exactJev answers only the verifier, not ${req.purpose ?? "a request with no purpose"}`);
  return { model: "verify-stand-in", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "exact", confidence: 0.95 }])), inputTokens: 0, latencyMs: 0, costUsd: 0 };
};

export async function validateMinted(raw: unknown, slots: Record<string, string>, ctx: PlanContext): Promise<CheckedPlan> {
  const parsed = Plan.safeParse(raw);
  if (!parsed.success) return validatePlan(raw, slots, ctx, new Map());
  const plan = structuredClone(parsed.data);
  const filled: Record<string, string> = { ...slots };
  const mints = new Map<string, CheckedValue>();
  const refused = new Map<number, string>();
  for (const [i, st] of plan.steps.entries()) {
    const end = st.end;
    if (end.kind !== "valueEquals") continue;
    const ref = /^\{\{(\w+)\}\}$/u.exec(end.value)?.[1];
    const text = ref === undefined ? end.value : filled[ref];
    if (text === undefined) continue;
    const w = [...ctx.model.windows.values()].find((x) => (end.window.bundleId === undefined || x.app.bundleId === end.window.bundleId) && (end.window.title === undefined || x.window.title === end.window.title));
    const found = w === undefined ? null : resolveLocally(w, end.target);
    if (w === undefined || found === null || !("node" in found)) continue;
    const slot = ref ?? `minted${i}`;
    filled[slot] = text;
    plan.slots[slot] ??= `value ${i + 1}`;
    end.value = `{{${slot}}}`;
    let field;
    try {
      field = fieldContract(w, found.node);
    } catch (e) {
      if (e instanceof ContractError) continue;
      throw e;
    }
    const t = traceValue(text, ctx.model, ctx.memory, ctx.instruction);
    // I1: a window value's provenance records the lines around it, as fill's does (contract.ts windowProvenance).
    const provenance: Provenance = t?.from === "window" ? windowProvenance(ctx.model.windows.get(t.windowId), { text, context: null, source: { windowId: t.windowId, nodeKey: t.nodeKey ?? "", appName: "", windowTitle: "" } }) : t?.from === "memory" ? { kind: "memory", id: t.id, label: "", part: null, whose: "user" } : { kind: "instruction", span: text };
    const r = await checkValues([{ field, text, display: text, provenance, owner: null }], { askJev: exactJev, ledger: null, instruction: ctx.instruction, now: 0 });
    const ok = r.ok[0];
    if (ok !== undefined) mints.set(slot, ok);
    else refused.set(i, r.refused[0]?.says ?? "refused");
  }
  try {
    return validatePlan(plan, filled, ctx, mints);
  } catch (e) {
    if (!(e instanceof ContractError)) throw e;
    const at = /^step (\d+) /u.exec(e.message)?.[1];
    const says = at === undefined ? undefined : refused.get(Number(at) - 1);
    if (says !== undefined) throw new PlannerError("wrongKind", says);
    throw e;
  }
}

/**
 * A hand-built goal target's field contract, read from its label as fieldContract reads a text field's own label: for
 * tests that build an inventory without a window. Undefined for a target that is no field (a button, a file, the
 * calendar).
 */
export function targetField(t: Omit<TargetBinding, "field">): FieldContract | undefined {
  const control = t.control as Control;
  if (!["text", "combobox", "select", "radio", "checkbox", "date", "time"].includes(control)) return undefined;
  const typed = control === "text" || control === "combobox";
  return makeFieldContract({ windowId: t.domain.kind === "window" ? t.domain.windowId : "calendar", node: { key: t.key, parent: null, role: t.role, label: t.label }, descriptor: t.label, name: t.label, labelWords: [t.label], control, kinds: typed ? fieldKinds([t.label]) : new Set(), part: typed ? fieldPart(t.label) : null });
}

/**
 * A hand-built fill proposal with each field it writes minted by the write contract (fill/contract.ts), for tests of
 * what comes after proposeFill: a text value through checkValues (its field read from the key and descriptor alone), a
 * saved answer and a control's value under their exemptions. Throws when the contract refuses a test's value. I1: with
 * `model`, a window value's provenance records the lines around it there (contract.ts windowProvenance), as fill's does;
 * without it, it records none, and the recheck before a write never holds it.
 */
export async function minted(p: FillProposal, model?: ScreenModel): Promise<FillProposal> {
  for (const f of p.fields) {
    const text = f.value ?? (f.handoff?.writes === true ? f.handoff.value : null);
    if (text === null) continue;
    const label = f.descriptor.replace(/[.:]\s*$/u, "");
    const control = f.control as Control;
    const field = makeFieldContract({ windowId: p.windowId, node: { key: f.key, parent: null, role: "AXTextField", label }, descriptor: f.descriptor, name: label, labelWords: [label], control, kinds: control === "text" ? fieldKinds([label]) : new Set(), part: null });
    const source = f.source ?? f.handoff?.source ?? null;
    const provenance: Provenance = f.answer !== undefined ? { kind: "answer", id: f.answer.id, question: f.memory?.label ?? "" } : source !== null ? windowProvenance(model?.windows.get(source.windowId) ?? undefined, { text, context: null, source }) : { kind: "instruction", span: text };
    const proposed = { field, text, display: text, provenance, owner: null };
    if (f.answer !== undefined) bindMint(f, p.windowId, mintExempt(proposed, "savedAnswerShown", 0));
    else if (control !== "text" && control !== "combobox") bindMint(f, p.windowId, mintExempt(proposed, control === "checkbox" ? "boxFromLabelledLine" : control === "date" || control === "time" ? "resolverFormat" : "optionLabel", 0));
    else {
      const r = await checkValues([proposed], { askJev: exactJev, ledger: null, now: 0 });
      const c = r.ok[0];
      if (c === undefined) throw new Error(`the write contract refused the test's value '${text}' for ${f.key}: ${r.refused[0]?.says}`);
      bindMint(f, p.windowId, c);
    }
  }
  return p;
}
