// The planner's gate. Whoever drafted a plan (code and Jev's choices today), it runs only after code
// has checked it against the screen as it is now:
//   - it parses as a Plan, and its slots fill;
//   - it writes fields and hands off presses, in one window, since an act grant covers one window;
//   - every window and target exists in the screen model, and every written target is an editable field;
//   - every value traces verbatim to a window, a memory entry or the instruction (trace.ts);
//   - every value carries the write contract's mint for exactly that text in exactly that field (W2,
//     fill/contract.ts), whose deterministic checks are run again here: no whole address in City, no email in Phone;
//   - a hand-off comes last, and its reason is the one the risk table gives its control's label, so a
//     Send press can never be passed off as merely unverifiable.
// Each failure is a PlannerError with a code the host can act on and a sentence that says what failed.
import { Plan, PlanError, fillSlots, type EndState, type WindowSel } from "../executor/schema.ts";
import { classifyLabel } from "../executor/risk.ts";
import { resolveLocally } from "../executor/target.ts";
import type { ScreenModel, WindowState } from "../model.ts";
import type { Node, PlanErrorCode } from "../protocol.ts";
import { secretIn, traceValue, type MemoryValue, type Trace } from "./trace.ts";
import { describeField } from "../fill/descriptor.ts";
import { contractStale, provenanceStale, requireChecked, shapeRefusal, type CheckedValue } from "../fill/contract.ts";
import { labelKind, SENSITIVE_SAYS } from "../memory/sensitive.ts";
import { FILE_INPUT_SUBROLE } from "../engines/page-link.ts";
import { PAGE_WINDOW_KIND } from "../engines/windows.ts";

export class PlannerError extends Error {
  readonly code: PlanErrorCode;
  /** The window the planner had chosen when it failed, when it had chosen one; the code-mode writer plans there next (B24). */
  windowId: string | null = null;
  constructor(code: PlanErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type HandoffWhy = Extract<EndState, { kind: "handoff" }>["why"];

export interface CheckedPlan {
  /** The plan with its slots filled. */
  plan: Plan;
  window: WindowState;
  /** For each step that writes, the field, where its value came from, and the write contract's mint for it. */
  writes: { step: number; node: Node; value: string; trace: Trace; checked: CheckedValue }[];
  /** The mints by slot name, as validatePlan took them: a revalidation before the run passes them again. */
  mints: ReadonlyMap<string, CheckedValue>;
  /** The last step, when it hands a press to the user. */
  handoff: { step: number; node: Node; label: string; why: HandoffWhy } | null;
  /** The step that attaches the file the user confirms (H5), at most one; null when the plan attaches none. */
  attach: { step: number; node: Node; label: string; wants: string } | null;
}

export interface PlanContext {
  model: ScreenModel;
  memory: readonly MemoryValue[];
  instruction: string;
}

/** The hand-off reason the risk table gives a control's label: its risk class, or unverifiable for a safe or unlabelled one. */
export function handoffWhy(label: string): HandoffWhy {
  const risk = classifyLabel(label);
  return risk === "safe" ? "unverifiable" : risk;
}

/**
 * Checks a drafted plan against the screen model now. Throws PlannerError naming the first rule it breaks, and
 * ContractError (fill/contract.ts) for a write whose value is "{{slot}}" without the mint `checked` holds for that slot,
 * for exactly its text in exactly its field: whoever drafted the plan mints its values before it is checked.
 */
export function validatePlan(raw: unknown, slots: Record<string, string>, ctx: PlanContext, checked: ReadonlyMap<string, CheckedValue>): CheckedPlan {
  const parsed = Plan.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PlannerError("schema", `the plan is not a valid plan: ${issue?.message ?? "invalid"} at ${(issue?.path ?? []).join(".") || "the plan"}`);
  }
  let plan: Plan;
  try {
    plan = fillSlots(parsed.data, slots);
  } catch (e) {
    if (e instanceof PlanError) throw new PlannerError("schema", e.message);
    throw e;
  }

  let window: WindowState | null = null;
  let windowKey: string | null = null;
  const writes: CheckedPlan["writes"] = [];
  let handoff: CheckedPlan["handoff"] = null;
  let attach: CheckedPlan["attach"] = null;
  for (const [i, step] of plan.steps.entries()) {
    const at = `step ${i + 1} ('${step.says}')`;
    if (handoff !== null) throw new PlannerError("stepAfterHandoff", `${at} comes after the hand-off at step ${handoff.step + 1}, so it would never run`);
    const end = step.end;
    if (end.kind !== "valueEquals" && end.kind !== "handoff" && end.kind !== "fileAttached") throw new PlannerError("unsupportedStep", `${at} is a ${end.kind} step; a planned task only writes fields, attaches a file you confirm, and hands presses to you`);
    if (step.via !== undefined) throw new PlannerError("unsupportedStep", `${at} acts through ${step.via.kind}; a planned task never presses or opens anything itself`);

    const key = JSON.stringify(end.window);
    if (windowKey !== null && key !== windowKey) throw new PlannerError("multipleWindows", `${at} is in another window than step 1; a planned task acts in one window`);
    windowKey = key;
    const w = bindWindow(ctx.model, end.window, at);
    window = w;

    const found = resolveLocally(w, end.target);
    if ("missing" in found) throw new PlannerError("unknownTarget", `${at}: ${found.missing}`);
    if ("ambiguous" in found) throw new PlannerError("ambiguousTarget", `${at}: ${found.ambiguous.length} elements match its target in '${w.window.title}'`);
    const node = found.node;

    if (end.kind === "fileAttached") {
      // Only a page's file input takes a file, through its page engine (engines/page-link.ts attachFile).
      if (node.subrole !== FILE_INPUT_SUBROLE) throw new PlannerError("notEditable", `${at}: ${node.label === undefined ? "its target" : `'${node.label}'`} is not a file input`);
      if (attach !== null) throw new PlannerError("unsupportedStep", `${at} attaches a second file; a planned task attaches one`);
      attach = { step: i, node, label: (node.label ?? "").trim(), wants: end.wants };
      continue;
    }
    if (end.kind === "valueEquals") {
      if (node.editable !== true) throw new PlannerError("notEditable", `${at}: ${node.label === undefined ? "its target" : `'${node.label}'`} is not a field Caret can write`);
      if (node.states?.includes("secure")) throw new PlannerError("notEditable", `${at}: its target is a password field, which is left to you`);
      // Caret never types these, from any source; fill leaves the same fields and values out, by the classifier memory
      // uses for what it never keeps (memory/sensitive.ts; B25 lead decision 2).
      const d = describeField(w, node);
      const secretField = labelKind(d.label ?? d.nearest) ?? labelKind(d.placeholder);
      if (secretField !== null) throw new PlannerError("notEditable", `${at}: its target asks for one of the ${SENSITIVE_SAYS[secretField]} Caret never types; that is left to you`);
      const secretValue = secretIn(end.value, ctx.instruction);
      if (secretValue !== null) throw new PlannerError("notEditable", `${at}: its value is one of the ${SENSITIVE_SAYS[secretValue]} Caret never types; that is left to you`);
      const trace = traceValue(end.value, ctx.model, ctx.memory, ctx.instruction);
      if (trace === null) throw new PlannerError("untracedValue", `${at}: '${clip(end.value)}' is not in any window, in memory or in your instruction`);
      // W2: the mint the drafter made for this slot's value in this field (fill/contract.ts), never a recomputed guess:
      // the field and provenance it was checked with travel with it (REVIEW-R2 P2.5: "Mary Ann" lost her source label here).
      const slot = /^\{\{(\w+)\}\}$/u.exec(rawValue(parsed.data, i) ?? "")?.[1];
      const mint = requireChecked(slot === undefined ? undefined : checked.get(slot), end.value, node.key, w.window.windowId, at);
      if ((mint.field.descriptor !== d.text && mint.verdict.by !== "exempt") || contractStale(node, mint.field, end.value) !== null) throw new PlannerError("unknownTarget", `${at}: the field no longer reads as it did when its value was checked`);
      // W2 review: and the value's source must still say what it said then (the line, its sentences, its label).
      const stale = provenanceStale(ctx.model, mint.provenance);
      if (stale !== null) throw new PlannerError("untracedValue", `${at}: ${stale}`);
      const bad = mint.verdict.by === "exempt" ? null : shapeRefusal(mint);
      if (bad !== null) throw new PlannerError("wrongKind", `${at}: ${bad}`);
      writes.push({ step: i, node, value: end.value, trace, checked: mint });
      continue;
    }
    const label = (node.label ?? "").trim();
    const why = handoffWhy(label);
    if (end.why !== why) throw new PlannerError("riskMismatch", `${at} hands off ${label === "" ? "an unlabelled control" : `'${label}'`} as ${end.why}, but the risk table reads it as ${why}`);
    handoff = { step: i, node, label, why };
  }
  // The schema requires a step, so the loop bound a window.
  if (window === null) throw new PlannerError("schema", "the plan has no steps");
  return { plan, window, writes, handoff, attach, mints: checked };
}

/** A step's raw value before its slots are filled: "{{v1}}" for a value a drafter minted. */
function rawValue(p: Plan, i: number): string | undefined {
  const end = p.steps[i]?.end;
  return end?.kind === "valueEquals" ? end.value : undefined;
}

function bindWindow(model: ScreenModel, sel: WindowSel, at: string): WindowState {
  const hits = [...model.windows.values()].filter(
    (w) =>
      (sel.bundleId === undefined || w.app.bundleId === sel.bundleId) &&
      (sel.title === undefined || w.window.title === sel.title) &&
      (sel.titleStartsWith === undefined || w.window.title.startsWith(sel.titleStartsWith)) &&
      (sel.number === undefined || w.window.number === sel.number) &&
      (sel.page === undefined || w.window.kind === PAGE_WINDOW_KIND) &&
      (sel.windowId === undefined || w.window.windowId === sel.windowId),
  );
  const named = sel.title ?? sel.titleStartsWith ?? "";
  if (hits.length === 0) throw new PlannerError("unknownWindow", `${at}: no open window matches '${named}'`);
  if (hits.length > 1) throw new PlannerError("ambiguousWindow", `${at}: ${hits.length} open windows match '${named}'`);
  return hits[0] as WindowState;
}

function clip(s: string): string {
  return s.length <= 60 ? s : `${s.slice(0, 59)}…`;
}
