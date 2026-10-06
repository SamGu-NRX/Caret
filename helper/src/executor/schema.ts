// Plans for the executor (deep plan section 7). A plan is an ordered list of intended end states,
// each a predicate on the screen model, with slots filled in when the plan runs. The executor
// checks each end state first and acts only when it does not already hold, so a finished plan can
// be run again and does nothing. `pnpm schema` exports these to schemas/plan.schema.json.
import * as z from "zod";

/** Picks one window, resolved to a windowId when the task starts. Every given field must match. */
export const WindowSel = z
  .object({
    bundleId: z.string().optional(),
    /** Exact title. */
    title: z.string().optional(),
    /** Title prefix, for windows whose title an earlier step changes. */
    titleStartsWith: z.string().optional(),
    /**
     * The window server's number (WindowRef.number): only that window matches. The planner sets it when the
     * reader read one, so two windows of one app with one title ("Untitled") are told apart (B21 review).
     */
    number: z.number().int().positive().optional(),
  })
  .refine((w) => w.title !== undefined || w.titleStartsWith !== undefined, { message: "a window needs title or titleStartsWith" });
export type WindowSel = z.infer<typeof WindowSel>;

/**
 * One element in a window. An exact `key` wins when it is present. Otherwise `role` and `label`
 * filter the window's nodes; one match is used, and several are put to Jev as a two-ask target
 * question with `describe` as the goal.
 */
export const Target = z
  .object({
    key: z.string().optional(),
    role: z.string().optional(),
    /** Compared after trimming and lowercasing. */
    label: z.string().optional(),
    /** What the element is, in words. Shown to the user on a hand-off and to Jev when the locator is ambiguous. */
    describe: z.string(),
    /**
     * D2-06: only the element at `key`, and only while it still has `role` (and `label`, when given). Never another
     * element by role or label: a goal plan's acceptance covers the element it previewed, not a look-alike.
     */
    exact: z.literal(true).optional(),
  })
  .refine((t) => t.key !== undefined || t.label !== undefined || t.role !== undefined, { message: "a target needs key, label or role" })
  .refine((t) => t.exact === undefined || (t.key !== undefined && t.role !== undefined), { message: "an exact target needs key and role" });
export type Target = z.infer<typeof Target>;

const InWindow = { window: WindowSel, target: Target };

export const EndState = z.discriminatedUnion("kind", [
  /** The element's text equals `value`: an editable field's value, or any other node's visible text. */
  z.object({ kind: z.literal("valueEquals"), ...InWindow, value: z.string() }),
  z.object({ kind: z.literal("exists"), ...InWindow }),
  z.object({ kind: z.literal("absent"), ...InWindow }),
  z.object({ kind: z.literal("focused"), ...InWindow }),
  /** The selected window's title equals `title`. */
  z.object({ kind: z.literal("windowTitle"), window: WindowSel, title: z.string() }),
  /**
   * The selected window is the one the user is in. Needs no `via`: the executor asks the reader to
   * raise the window and activate its app. It writes nothing, so it leaves nothing for undo.
   */
  z.object({ kind: z.literal("windowFocused"), window: WindowSel }),
  /**
   * The user presses this control themselves. It never holds and the executor never acts on it: the run
   * resolves the control, then stops there as a hand-off that names it. A planner writes it where a press
   * reads as outbound, destructive or money (risk.ts), or where code cannot predict what the press changes
   * and so could not verify it (`unverifiable`).
   */
  z.object({ kind: z.literal("handoff"), ...InWindow, why: z.enum(["outbound", "destructive", "money", "system", "unverifiable"]) }),
  /**
   * The page's file control holds the file the user confirmed for this run (H5, lead decision 7). `wants` says which
   * file in the user's words ("your resume"), for the slip and a hand-off. The executor attaches only through the
   * page engine, and only the file confirmed for the task (engines/attach.ts); with no confirmation the step is the
   * user's. It never holds beforehand, and nothing can undo it: a page may upload a file the moment it gets one.
   */
  z.object({ kind: z.literal("fileAttached"), ...InWindow, wants: z.string().min(1).max(80) }),
  /**
   * D2-06: pressing `via` (a press, required) showed at least one editable field the window did not show right before
   * the press, and changed or removed none it did show; the window keeps its id and title. An event, not a state: it
   * never holds before the press, so a run never skips it. Only a goal plan writes it, for a press a registered
   * capability describes (goals/capabilities.ts). `target` is the control pressed.
   */
  z.object({ kind: z.literal("fieldsRevealed"), ...InWindow }),
  /** An event with this title, start and end exists in the named calendar. Checked through the calendar interface, not the screen. */
  z.object({
    kind: z.literal("calendarEvent"),
    calendar: z.string(),
    title: z.string(),
    /** ISO 8601 with offset. Code parses dates; Jev never compares them. */
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  }),
]);
export type EndState = z.infer<typeof EndState>;

/**
 * How to reach an end state that a direct write cannot. Value and focus end states need no `via`:
 * the executor writes the value or the focus itself. Calendar end states use the calendar interface.
 */
export const Via = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("press"), target: Target }),
  z.object({ kind: z.literal("openUrl"), url: z.url() }),
]);
export type Via = z.infer<typeof Via>;

export const Step = z.object({
  /** The end state as a sentence, for progress, the activity view and a hand-off. */
  says: z.string(),
  end: EndState,
  via: Via.optional(),
  /**
   * The memory entry the step's value came from (B17: a typed About entry). Right before writing, the
   * executor asks that the entry still holds the value, and stops the run if it does not: the user forgot,
   * paused or changed it after accepting the offer.
   */
  memory: z.string().min(1).optional(),
});
export type Step = z.infer<typeof Step>;

export const Plan = z.object({
  id: z.string(),
  title: z.string(),
  /** Slot names and what each holds. Strings in steps refer to them as {{name}}. */
  slots: z.record(z.string(), z.string()),
  /**
   * For a slot whose value was copied from a window, that window's id. When a step's goal or target
   * quotes the value in a Jev target question, the question charges it to that window's budget
   * (privacy.ts), as if it took the value from the window itself. A slot not listed is plan text.
   */
  sources: z.record(z.string(), z.string()).optional(),
  steps: z.array(Step).min(1),
});
export type Plan = z.infer<typeof Plan>;

export class PlanError extends Error {}

const SLOT = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/**
 * Fills every {{slot}} in every string of the plan. A slot the plan does not declare, or a declared
 * slot with no value, is an error, never an empty string.
 */
export function fillSlots(plan: Plan, values: Record<string, string>): Plan {
  for (const name of Object.keys(plan.slots)) {
    if (values[name] === undefined) throw new PlanError(`slot ${name} has no value`);
  }
  for (const name of Object.keys(plan.sources ?? {})) {
    if (!(name in plan.slots)) throw new PlanError(`source for ${name}, which is not a declared slot of plan ${plan.id}`);
  }
  const sub = (s: string): string =>
    s.replace(SLOT, (_, name: string) => {
      if (!(name in plan.slots)) throw new PlanError(`{{${name}}} is not a declared slot of plan ${plan.id}`);
      return values[name] ?? "";
    });
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return sub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return Plan.parse({ ...plan, steps: walk(plan.steps) });
}
