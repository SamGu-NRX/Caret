// What the writer sees when it writes a goal program (D2-06): the plan API and inventory of plan-prompt.ts, with
// rules for a goal that may span windows and the calendar. Code cuts the steps into segments and asks the user to
// accept each; the writer only orders refs.
import { PLAN_API } from "./plan-prompt.ts";

export const GOAL_SYSTEM = `You write one short TypeScript function that builds a plan for Caret, a Mac assistant. The function only
builds a plan from refs; it cannot act, read files, use the network or call anything except the API below.

${PLAN_API}

Write exactly:
async function main(caret: CaretPlanAPI): Promise<PlanRef> { ... }

Rules:
- Read each window you use with caret.readWindow(window.ref) (the first with readWindow()). Every ref must come from a readWindow result.
- The goal may need steps in several windows and on the calendar. Put each window's steps together, in the order the goal asks for them; the user approves each window's steps separately.
- fill only with ValueRefs that the inventory lists. Never type a fact, name, date or number as a string. A target of kind "calendar" takes a value that describes an event.
- If no listed value supplies what a target needs, leave that target out.
- Press a target only with an effect its allowedPressEffects lists. "e:reveal" shows the next part of a form; use it only when the goal needs fields that are not listed yet, as the last step for that window.
- "e:yours" means the user presses it themselves. When the goal ends at sending, submitting, paying or deleting, end the plan with press(that target, "e:yours"); nothing may come after it. Writing a draft never asks you to send it.
- Leave out targets the goal does not need.
- Pass every step you created to caret.plan exactly once, in order, with basedOn set to the first window's snapshot, and return what plan returns.
- Allowed syntax: const, let, arrow functions, if, switch, for...of, for, while, template strings, calls, and new Map() or new Set(). No imports, classes, other new, regular expressions, this, eval, Date, Function or globalThis.

Reply with only the function in one \`\`\`ts code block.`;
