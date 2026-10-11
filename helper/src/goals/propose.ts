// A goal from the user's words to a plan code will offer (D2-06): the inventory of the windows it may act in, one
// writer program, the sandbox (steps may target any window the program read), and lowering. Nothing acts here.
import type { AskScope, DocumentReader, ScopeSet } from "../fill/ask-scope.ts";
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
import { draftAsk } from "../writer/local-draft.ts";
import { LocalModelUnavailable, type LocalModelPort } from "../writer/local-port.ts";
import type { DraftPlan } from "../codemode/types.ts";
import type { GoalInventory } from "./plan.ts";
import { buildInventory } from "./inventory.ts";
import { frozenBasis, GoalError, lowerGoal, type DonePress } from "./lower.ts";
import { addsRecipient, confirmClaims, DraftRefused } from "./drafts.ts";
import type { GoalPlan, LeftItem } from "./plan.ts";

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
  /** Presses a stopped plan for the same goal already made: a fresh plan may not make them again. */
  done?: readonly DonePress[];
  /** Writes a stopped goal this one replaces meant and did not make (runs.ts Replan.owed). */
  carried?: readonly LeftItem[];
  signal?: AbortSignal;
  /**
   * L1: the local model writes every draft's words in place of the program's text, which then only says where a draft
   * goes and what it may draw on. Absent: the program's text, as before. Lead decision 2026-10-05: no default path sets
   * it; the evaluations do. A draft the model cannot write refuses the goal; the program's text never stands in.
   */
  drafter?: LocalModelPort;
  /** I2: an Ask's goal's scopes, its document reader, and how it settles a window it has none for (goals/lower.ts LowerOptions). */
  scopes?: ScopeSet;
  documentOf?: DocumentReader | null;
  settleScope?: (windowId: string, document: string | null) => Promise<AskScope>;
}

/** The writer's program for a goal, run and lowered. Throws GoalError; `use` is set once the writer answered. */
export async function planGoal(model: ScreenModel, o: PlanGoalOptions, use: { value: GoalWriterUse | null } = { value: null }): Promise<GoalPlan> {
  if (addsRecipient(o.instruction)) throw new GoalError("recipient", "Caret doesn't add people to a message. Add them yourself, then ask again for the rest");
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
    written = await o.writer.write(inv.ledger.seal({ kind: "goal", disclosureId: o.goalId, disclosed, input: { goal: inv.ledger.slice(inv.ledger.instruction(o.instruction), 500), snapshots: inv.snapshots }, maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS, signal: o.signal ?? AbortSignal.timeout(15_000) }));
  } catch (e) {
    throw new GoalError("nothingToDo", "the plan writer is not available now", e instanceof Error ? e.message.slice(0, 200) : String(e));
  }
  use.value = { model: written.model, latencyMs: written.latencyMs, costUsd: written.costUsd, inputTokens: written.inputTokens, outputTokens: written.outputTokens, program: written.output.program };
  if (written.output.program === null) throw new GoalError("schema", "the plan writer wrote no program");
  const choose: ChooserPort = o.askJev === null ? async () => null : jevChooser(o.askJev, o.instruction, inv.ledger);
  const ran = await runCodePlan(written.output.program, inv.snapshots, choose, { multiWindow: true, drafts: true, ...(o.signal === undefined ? {} : { signal: o.signal }) });
  if (!ran.ok) throw new GoalError("schema", "the plan program broke the rules a plan must keep", `${ran.kind}: ${ran.detail.slice(0, 200)}`);
  const local = o.drafter === undefined || ran.plan.drafts.length === 0 ? null : await localDrafts(o.drafter, o.instruction, ran.plan, inv.inventory, o.now, o.signal);
  // A draft's origin names the model that wrote its words: the local model's when it did.
  const plan = await lowerGoal(o.goalId, o.instruction, local?.plan ?? ran.plan, inv.inventory, { done: o.done ?? [], writerModel: local?.model ?? written.model, askJev: o.askJev, ledger: inv.ledger, ...(o.carried === undefined ? {} : { carried: o.carried }), ...(o.scopes === undefined ? {} : { scopes: o.scopes, documentOf: o.documentOf ?? null }), ...(o.settleScope === undefined ? {} : { settleScope: o.settleScope }) });
  // Code checked each draft's facts in lowering; what it says the user promises or turns down goes to Jev (B30).
  const drafts = plan.segments.flatMap((g) => g.steps.flatMap((x) => (x.value?.draft == null ? [] : [{ text: x.value.text, basis: frozenBasis(o.instruction, x.value, inv.inventory) }])));
  try {
    await confirmClaims(o.instruction, drafts, o.askJev, inv.ledger.declared().snippets, model);
  } catch (e) {
    if (e instanceof DraftRefused) throw new GoalError("draft", e.says, `${e.why}: ${e.word ?? ""}`);
    throw e;
  }
  return plan;
}

/**
 * Each draft's words from the local model (L1), for the field the program fills with it and from the windows and memory
 * it names, each window as its title and message were frozen. A draft no text field takes is left as written: lowering
 * drops it (lower.ts), so the model is not asked.
 */
async function localDrafts(drafter: LocalModelPort, instruction: string, plan: DraftPlan, inv: GoalInventory, now: number, signal?: AbortSignal): Promise<{ plan: DraftPlan; model: string | null }> {
  let model: string | null = null;
  const drafts: DraftPlan["drafts"] = [];
  for (const d of plan.drafts) {
    const fill = plan.steps.find((s) => s.kind === "fill" && s.value === d.ref);
    const target = fill?.kind === "fill" ? inv.targets.get(fill.target) : undefined;
    if (target === undefined || target.control !== "text") {
      drafts.push(d);
      continue;
    }
    const basis = d.from.flatMap((ref) => {
      const v = inv.values.get(ref);
      const id = inv.windowRefs.get(ref) ?? v?.source?.windowId;
      const t = id === undefined ? undefined : inv.texts.get(id);
      if (t !== undefined) return [`${t.title}\n${t.message === "" ? t.text : t.message}`];
      return v !== undefined && v.memory !== null ? [v.text] : [];
    });
    let r: Awaited<ReturnType<LocalModelPort["complete"]>>;
    try {
      r = await drafter.complete(draftAsk(instruction, { name: target.own === "" ? target.label : target.own, placeholder: target.placeholder }, [...new Set(basis)], now), signal);
    } catch (e) {
      if (e instanceof LocalModelUnavailable) throw new GoalError("draft", "Caret's local model couldn't write the draft just now", `${e.why}: ${e.message}`);
      throw e;
    }
    if (r.stop === "maxTokens") throw new GoalError("draft", "The draft ran past its length, so Caret left it out", `${d.ref}: the local model hit its output cap`);
    model = r.model;
    drafts.push({ ...d, text: r.text });
  }
  return { plan: { ...plan, drafts }, model };
}
