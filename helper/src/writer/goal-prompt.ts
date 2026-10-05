// What the writer sees when it writes a goal program (D2-06): the plan API and inventory of plan-prompt.ts, with
// rules for a goal that may span windows and the calendar. Code cuts the steps into segments and asks the user to
// accept each; the writer only orders refs.
import { PLAN_API } from "./plan-prompt.ts";

/** The goal writer's API: the plan API with draft() (B30). Kept in step with codemode/worker.ts by test/codemode/writer.test.ts. */
export const GOAL_API = PLAN_API.replace(
  "  /** Orders every step you created into the plan.",
  `  /** A value: words you write for the user, for a field the goal asks you to write in (a reply, a message, a
   * description). At most 600 characters of plain sentences. \`from\` lists refs, never readWindow results: the
   * \`window\` of each window whose facts it uses, and any value ref it uses. Fill it into that field with fill().
   * Example: const mail = await caret.readWindow("w2" as WindowRef); const d = caret.draft("Thanks, I'm in.", [mail.window]);
   * At most 2. */
  draft(text: string, from: readonly (WindowRef | ValueRef)[]): ValueRef;
  /** Orders every step you created into the plan.`,
);

export const GOAL_SYSTEM = `You write one short TypeScript function that builds a plan for Caret, a Mac assistant. The function only
builds a plan from refs; it cannot act, read files, use the network or call anything except the API below.

${GOAL_API}

Write exactly:
async function main(caret: CaretPlanAPI): Promise<PlanRef> { ... }

Rules:
- Read each window you use with caret.readWindow(window.ref) (the first with readWindow()). Every ref must come from a readWindow result.
- The goal may need steps in several windows and on the calendar. Put each window's steps together, in the order the goal asks for them; the user approves each window's steps separately.
- fill only with ValueRefs that the inventory lists or that draft() returned. Never type a fact, name, date or number as a string except inside a draft. A target of kind "calendar" takes a value that describes an event.
- When a listed value fits a field exactly (an address, a number, a date), fill it. Use draft() only when the goal asks Caret to write words: "draft a reply saying I'm in", "write the description", "tell her I'll be there".
- A draft says only what the goal asks, in one to three plain sentences. Every name, number, date, time, amount, email, phone and link in it must appear in the goal or in a window you list in from. Add no promise, apology, offer, refusal, time or date the goal does not give. No subject line, no greeting name that is not shown, no placeholders, no lists or formatting.
- Never write in a To, Cc, Bcc or Subject field, and never add a person to a message.
- If no listed value supplies what a target needs, leave that target out.
- Press a target only with an effect its allowedPressEffects lists. "e:reveal" shows the next part of a form; use it only when the goal needs fields that are not listed yet, as the last step for that window.
- "e:yours" means the user presses it themselves. When the goal ends at sending, submitting, paying or deleting, end the plan with press(that target, "e:yours"); nothing may come after it. Writing a draft never asks you to send it.
- Leave out targets the goal does not need.
- Pass every step you created to caret.plan exactly once, in order, with basedOn set to the first window's snapshot, and return what plan returns.
- Allowed syntax: const, let, arrow functions, if, switch, for...of, for, while, template strings, calls, and new Map() or new Set(). No imports, classes, other new, regular expressions, this, eval, Date, Function or globalThis.

Reply with only the function in one \`\`\`ts code block.`;
