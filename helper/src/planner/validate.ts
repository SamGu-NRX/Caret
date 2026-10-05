// The planner's gate. Whoever drafted a plan (code and Jev's choices today), it runs only after code
// has checked it against the screen as it is now:
//   - it parses as a Plan, and its slots fill;
//   - it writes fields and hands off presses, in one window, since an act grant covers one window;
//   - every window and target exists in the screen model, and every written target is an editable field;
//   - every value traces verbatim to a window, a memory entry or the instruction (trace.ts);
//   - every value's kind fits its field: no whole address in City, no email in Phone (kinds.ts misfit);
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
import { misfit } from "../fill/kinds.ts";
import { labelKind, SENSITIVE_SAYS } from "../memory/sensitive.ts";
import { FILE_INPUT_SUBROLE } from "../engines/page-link.ts";

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
  /** For each step that writes, the field and where its value came from. */
  writes: { step: number; node: Node; value: string; trace: Trace }[];
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

/** Checks a drafted plan against the screen model now. Throws PlannerError naming the first rule it breaks. */
export function validatePlan(raw: unknown, slots: Record<string, string>, ctx: PlanContext): CheckedPlan {
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
      // The field's own label, nearest label or placeholder, as the planner names it (planner.ts Field.label).
      const bad = misfit(end.value, [d.label ?? d.nearest ?? d.placeholder]);
      if (bad !== null) throw new PlannerError("wrongKind", `${at}: ${bad}`);
      writes.push({ step: i, node, value: end.value, trace });
      continue;
    }
    const label = (node.label ?? "").trim();
    const why = handoffWhy(label);
    if (end.why !== why) throw new PlannerError("riskMismatch", `${at} hands off ${label === "" ? "an unlabelled control" : `'${label}'`} as ${end.why}, but the risk table reads it as ${why}`);
    handoff = { step: i, node, label, why };
  }
  // The schema requires a step, so the loop bound a window.
  if (window === null) throw new PlannerError("schema", "the plan has no steps");
  return { plan, window, writes, handoff, attach };
}

function bindWindow(model: ScreenModel, sel: WindowSel, at: string): WindowState {
  const hits = [...model.windows.values()].filter(
    (w) =>
      (sel.bundleId === undefined || w.app.bundleId === sel.bundleId) &&
      (sel.title === undefined || w.window.title === sel.title) &&
      (sel.titleStartsWith === undefined || w.window.title.startsWith(sel.titleStartsWith)) &&
      (sel.number === undefined || w.window.number === sel.number),
  );
  const named = sel.title ?? sel.titleStartsWith ?? "";
  if (hits.length === 0) throw new PlannerError("unknownWindow", `${at}: no open window matches '${named}'`);
  if (hits.length > 1) throw new PlannerError("ambiguousWindow", `${at}: ${hits.length} open windows match '${named}'`);
  return hits[0] as WindowState;
}

function clip(s: string): string {
  return s.length <= 60 ? s : `${s.slice(0, 59)}…`;
}
