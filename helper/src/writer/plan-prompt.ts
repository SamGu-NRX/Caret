// What the writer model sees when it writes a plan program, and how its answer becomes source text. The
// writer gets the user's goal and a bounded inventory of the frozen snapshots: labels, kinds, refs,
// value displays and question options. Value origins, digests and anything outside the snapshots stay
// with the host. Each window's inventory text is held to the helper's per-window budget.
import * as z from "zod";
import { WINDOW_CHARS } from "../privacy.ts";
import { PlanningSnapshotSchema, type PlanningSnapshot } from "../codemode/types.ts";

export const PlanInputSchema = z.object({ goal: z.string().min(1).max(500), snapshots: z.array(PlanningSnapshotSchema).min(1).max(4) }).strict();
export type PlanInput = z.infer<typeof PlanInputSchema>;

/** The API as the writer reads it. Kept in step with codemode/worker.ts by test/codemode/writer.test.ts. */
export const PLAN_API = `type Ref<K extends string> = string & { readonly __ref: K };
type WindowRef = Ref<"window">; type TargetRef = Ref<"target">; type ValueRef = Ref<"value">;
type OptionRef = Ref<"option">; type EffectRef = Ref<"effect">; type QuestionRef = Ref<"question">;
type StepRef = Ref<"step">; type SnapshotRef = Ref<"snapshot">; type PlanRef = Ref<"plan">;

interface ReadWindow {
  snapshot: SnapshotRef; window: WindowRef; revision: string; title: string;
  targets: readonly { ref: TargetRef; label: string; kind: string; canFill: boolean;
    options: readonly OptionRef[]; allowedPressEffects: readonly EffectRef[] }[];
  values: readonly { ref: ValueRef; display: string }[];
  questions: readonly { ref: QuestionRef; text: string; options: readonly { ref: OptionRef; label: string }[] }[];
}
interface CaretPlanAPI {
  /** The focused window when called with no argument; another listed window by its ref. At most 4 calls. */
  readWindow(window?: WindowRef): Promise<ReadWindow>;
  /** Step: put a value into a fillable target. */
  fill(target: TargetRef, value: ValueRef): StepRef;
  /** Step: press a target, expecting one of its allowedPressEffects. */
  press(target: TargetRef, expectedEffect: EffectRef): StepRef;
  /** Step: wait (at most 10000 ms) for an effect a press in this plan expects. */
  waitFor(effect: EffectRef, timeoutMs: number): StepRef;
  /** Asks a judge to pick among one question's options; null means no confident pick. At most 4 calls. */
  choose(options: readonly OptionRef[]): Promise<OptionRef | null>;
  /** Step: ask the user one listed question. At most 1. */
  ask(question: QuestionRef): StepRef;
  /** Orders every step you created into the plan. Call once and return its result. */
  plan(draft: { basedOn: SnapshotRef; steps: readonly StepRef[] }): PlanRef;
}`;

export const PLAN_SYSTEM = `You write one short TypeScript function that builds a plan for Caret, a Mac assistant. The function only
builds a plan from refs; it cannot act, read files, use the network or call anything except the API below.

${PLAN_API}

Write exactly:
async function main(caret: CaretPlanAPI): Promise<PlanRef> { ... }

Rules:
- Every ref must come from a readWindow result. The inventory shows which refs exist; read a window before using its refs.
- Targets and pressed effects must come from the focused window (readWindow() with no argument). Other windows supply values only.
- fill only with ValueRefs that the inventory lists. Never type a fact, name, date or number as a string.
- If the goal needs a fact no listed value supplies and a listed question asks for it, use caret.ask(question.ref). Otherwise leave that target out.
- Use caret.choose(question.options.map(o => o.ref)) only when picking between a question's options needs judgment.
- An OptionRef is not a value. After choose, fill with the listed value whose display equals the chosen option's label.
- Press a target only when the goal itself asks for what its effect does ("subscribe me" asks for Subscribe). Filling in a form does not ask to send, submit, save or continue it.
- Leave out targets the goal does not need.
- Pass every step you created to caret.plan exactly once, in the order they should run, with basedOn set to the focused window's snapshot, and return what plan returns.
- Allowed syntax: const, let, arrow functions, if, for...of, for, while, template strings, calls, and new Map() or new Set(). No imports, classes, other new, regular expressions, this, eval, Date, Function or globalThis.

Reply with only the function in one \`\`\`ts code block.`;

/** The text a window contributes to the writer's prompt, by the measure the per-window budget uses. */
function windowText(s: PlanningSnapshot): string[] {
  return [s.title, ...s.targets.map((t) => t.label), ...s.values.map((v) => v.display), ...s.questions.flatMap((q) => [q.text, ...q.options.map((o) => o.label)])];
}

/** The user message for a plan request. Throws when a window's inventory text is over budget. */
export function planUserMessage(input: PlanInput): string {
  const windows = input.snapshots.map((s, i) => {
    const chars = windowText(s).reduce((n, t) => n + t.length, 0);
    if (chars > WINDOW_CHARS) throw new Error(`window ${s.window} gives the writer ${chars} characters; the per-window budget is ${WINDOW_CHARS}`);
    return {
      window: s.window,
      focused: i === 0,
      title: s.title,
      snapshot: s.snapshot,
      targets: s.targets.map((t) => ({ ref: t.ref, label: t.label, kind: t.kind, canFill: t.canFill, ...(t.options.length > 0 ? { options: t.options } : {}), ...(t.allowedPressEffects.length > 0 ? { allowedPressEffects: t.allowedPressEffects } : {}) })),
      values: s.values.map((v) => ({ ref: v.ref, display: v.display })),
      questions: s.questions,
    };
  });
  return `Goal: ${input.goal}\n\nWindows (the first is focused):\n${JSON.stringify(windows, null, 1)}`;
}

/** The program in a writer's reply: the first fenced code block, or the whole reply if it is bare code. */
export function extractProgram(reply: string): string | null {
  const fenced = /```(?:ts|typescript|js|javascript)?[ \t]*\r?\n([\s\S]*?)```/.exec(reply);
  const code = (fenced?.[1] ?? reply).trim();
  return /^async\s+function\s+main\s*\(/.test(code) ? code : null;
}
