// A goal from the user's words to a plan code will offer (D2-06): the inventory of the windows it may act in, one
// writer program, the sandbox (steps may target any window the program read), and lowering. Nothing acts here.
import { runCodePlan } from "../codemode/sandbox.ts";
import { jevChooser } from "../codemode/jev-chooser.ts";
import type { ChooserPort } from "../codemode/sandbox.ts";
import type { AskJev } from "../fill/jev.ts";
import type { ScreenModel } from "../model.ts";
import type { EventClock } from "../offers/event-time.ts";
import { disclosureFor } from "../planner/codeplan.ts";
import type { MemoryValue } from "../planner/trace.ts";
import { WRITER_MAX_OUTPUT_TOKENS } from "../writer/config.ts";
import type { WriterPort } from "../writer/port.ts";
import { buildInventory } from "./inventory.ts";
import { GoalError, lowerGoal } from "./lower.ts";
import type { GoalPlan } from "./plan.ts";

export interface GoalWriterUse {
  model: string;
  latencyMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  program: string | null;
}

export interface PlanGoalOptions {
  goalId: string;
  instruction: string;
  writer: WriterPort;
  /** Jev, for the program's choose(); null answers every choice with no pick. */
  askJev: AskJev | null;
  windows: readonly string[];
  memory: readonly MemoryValue[];
  calendar: string | null;
  clock: EventClock;
  now: number;
  readerSession: number;
  pageDocument?: (windowId: string) => string | null;
  signal?: AbortSignal;
}

/** The writer's program for a goal, run and lowered. Throws GoalError; `use` is set once the writer answered. */
export async function planGoal(model: ScreenModel, o: PlanGoalOptions, use: { value: GoalWriterUse | null } = { value: null }): Promise<GoalPlan> {
  let inv: ReturnType<typeof buildInventory>;
  try {
    inv = buildInventory(model, { instruction: o.instruction, windows: o.windows, memory: o.memory, calendar: o.calendar, clock: o.clock, now: o.now, readerSession: o.readerSession, ...(o.pageDocument === undefined ? {} : { pageDocument: o.pageDocument }) });
  } catch (e) {
    throw new GoalError("nothingToDo", e instanceof Error ? e.message : String(e));
  }
  if (inv.inventory.targets.size === 0) throw new GoalError("nothingToDo", "no open window has a field or control Caret could use for this");
  const disclosed = disclosureFor(inv.ledger.declared().snippets, inv.snapshots, o.instruction);
  let written: Awaited<ReturnType<WriterPort["write"]>>;
  try {
    written = await o.writer.write({ kind: "goal", disclosureId: o.goalId, disclosed, input: { goal: o.instruction.slice(0, 500), snapshots: inv.snapshots }, maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS, signal: o.signal ?? AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new GoalError("nothingToDo", "the plan writer is not available now", e instanceof Error ? e.message.slice(0, 200) : String(e));
  }
  use.value = { model: written.model, latencyMs: written.latencyMs, costUsd: written.costUsd, inputTokens: written.inputTokens, outputTokens: written.outputTokens, program: written.output.program };
  if (written.output.program === null) throw new GoalError("schema", "the plan writer wrote no program");
  const choose: ChooserPort = o.askJev === null ? async () => null : jevChooser(o.askJev, o.instruction);
  const ran = await runCodePlan(written.output.program, inv.snapshots, choose, { multiWindow: true, ...(o.signal === undefined ? {} : { signal: o.signal }) });
  if (!ran.ok) throw new GoalError("schema", "the plan program broke the rules a plan must keep", `${ran.kind}: ${ran.detail.slice(0, 200)}`);
  return lowerGoal(o.goalId, o.instruction, ran.plan, inv.inventory);
}
