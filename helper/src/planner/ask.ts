// Ask (B25): an instruction becomes an intent (intent.ts), code checks it, and the route decides what runs.
//   - fill: the fill engine (fill/fill.ts proposeFill) restricted to the intent's fields, sources, person and
//     spelled-out values; its text writes become the planner's plan of field writes, checked by validatePlan as
//     every plan is, and its controls (a select's option, a date) are listed for the user to set.
//   - plan: the planner as before: the deterministic planner, then the code-mode writer for an instruction it
//     cannot ground. Plans still run only after the host accepts them.
//   - ask or refuse: a PlannerError whose sentence code wrote.
// Nothing here acts.
import type { ScreenModel, WindowState } from "../model.ts";
import type { FillField, FillProposal } from "../protocol.ts";
import type { AskJev } from "../fill/jev.ts";
import type { AboutValue } from "../fill/about.ts";
import { FillError, memoryRefOf, proposeFill } from "../fill/fill.ts";
import type { Plan, Step, WindowSel } from "../executor/schema.ts";
import type { WriterPort } from "../writer/port.ts";
import { planTask, taskWindow, type PlanDraft, type PlannerMemory } from "./planner.ts";
import { planWithCode, type WriterUse } from "./codeplan.ts";
import { checkIntent, intentSnapshot, leftToYouSays, type AskIntent, type IntentField } from "./intent.ts";
import type { IntentMaker, MakerUse } from "./intent-makers.ts";
import { handoffWhy, PlannerError, validatePlan, type PlanContext } from "./validate.ts";

export interface AskOptions {
  askJev: AskJev;
  maker: IntentMaker;
  /** The code-mode writer for the plan route; null leaves an instruction the planner cannot ground refused. */
  writer: WriterPort | null;
  offerKey: string;
  /** The window the user means, when the host knows it. */
  windowId?: string;
  now?: number;
  rand?: (n: number) => number;
  /** Fault-injection seam for the planner evaluation (PlanTaskOptions.beforeCheck). */
  beforeCheck?: () => Promise<void>;
}

export type AskDraft = PlanDraft & {
  route: "fill" | "plan";
  intent: AskIntent;
  maker: MakerUse;
  /** The fill the plan came from, for evaluation; null on the plan route. */
  fill: FillProposal | null;
  writer?: WriterUse;
};

/** An Ask that ended without a plan, with the intent and what making it cost when the maker got that far. */
export class AskRefused extends PlannerError {
  readonly intent: AskIntent | null;
  readonly maker: MakerUse | null;
  constructor(e: PlannerError, intent: AskIntent | null, maker: MakerUse | null) {
    super(e.code, e.message);
    this.windowId = e.windowId;
    this.intent = intent;
    this.maker = maker;
  }
}

/** Plans an Ask. Throws PlannerError (AskRefused once an intent exists) with the failing check's code and sentence. */
export async function planAsk(instruction: string, model: ScreenModel, memory: PlannerMemory, about: readonly AboutValue[], o: AskOptions): Promise<AskDraft> {
  const now = o.now ?? Date.now();
  const jev = { calls: 0, costUsd: 0, latencyMs: 0 };
  const askJev: AskJev = async (req) => {
    let r: Awaited<ReturnType<AskJev>>;
    try {
      r = await o.askJev(req);
    } catch (e) {
      // A Jev failure anywhere in an Ask (a timeout, an HTTP error) is reported as the planner reports one.
      throw new PlannerError("jevFailed", `the Jev request failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
    jev.calls++;
    jev.costUsd += r.costUsd;
    return r;
  };
  let w: WindowState;
  if (o.windowId !== undefined) {
    const named = model.windows.get(o.windowId);
    if (named === undefined) throw new PlannerError("unseenWindow", `window ${o.windowId} is not open`);
    w = named;
  } else w = (await taskWindow(instruction, model, { askJev, ...(o.rand === undefined ? {} : { rand: o.rand }) })).window;

  const snap = intentSnapshot(instruction, model, w, memory.values());
  const { intent, use } = await o.maker.make(snap);
  const refused = (e: unknown): never => {
    if (e instanceof PlannerError) {
      e.windowId ??= w.window.windowId;
      throw new AskRefused(e, intent, use);
    }
    throw e;
  };
  let checked: ReturnType<typeof checkIntent>;
  try {
    checked = checkIntent(intent, snap);
  } catch (e) {
    return refused(e);
  }
  const extra = { intent, maker: use, fill: null };

  if (checked.route === "plan") {
    try {
      const d = await planTask(instruction, model, memory, { askJev, offerKey: o.offerKey, windowId: w.window.windowId, now, ...(o.rand === undefined ? {} : { rand: o.rand }), ...(o.beforeCheck === undefined ? {} : { beforeCheck: o.beforeCheck }) });
      return { ...d, ...extra, route: "plan" };
    } catch (e) {
      if (!(e instanceof PlannerError) || (e.code !== "unsure" && e.code !== "nothingToDo") || o.writer === null) return refused(e);
      try {
        const d = await planWithCode(instruction, model, memory, { writer: o.writer, askJev, offerKey: o.offerKey, windowId: w.window.windowId, now });
        return { ...d, ...extra, route: "plan" };
      } catch (e2) {
        if (e2 instanceof PlannerError) return refused(new PlannerError(e.code, `${e.message}; the plan writer did not help either: ${e2.message}`));
        throw e2;
      }
    }
  }

  let p: FillProposal;
  try {
    p = await proposeFill(model, askJev, w.window.windowId, checked.trigger, now, { about, scope: checked.scope, newId: () => o.offerKey, ...(o.rand === undefined ? {} : { rand: o.rand }) });
  } catch (e) {
    if (e instanceof FillError) return refused(new PlannerError("nothingToDo", `Caret found nothing to fill there: ${e.message}`));
    return refused(e);
  }
  const nameOf = new Map(checked.fields.map((f) => [f.key, f]));
  const name = (f: FillField): string => nameOf.get(f.key)?.name ?? f.descriptor;
  // A value the user spelled out that the value resolver cannot read alone ("8:15" with no am or pm) is asked
  // about rather than guessed, and nothing else is proposed until it is answered.
  for (const f of p.fields) {
    const said = checked.scope.literals.get(f.key);
    if (said !== undefined && f.withheld === "ambiguous" && f.asks.some((a) => a.value === said)) return refused(new PlannerError("unsure", askAbout(said, nameOf.get(f.key))));
  }
  const writes = p.fields.filter((f) => f.control === "text" && f.value !== null);
  const controls = p.fields.filter((f) => f.handoff !== null);
  if (writes.length === 0 && controls.length === 0) {
    const unsure = p.fields.filter((f) => f.withheld === "disagree" || f.withheld === "lowConfidence");
    if (unsure.length > 0) return refused(new PlannerError("unsure", `Jev was not sure enough about ${unsure.map((f) => `${name(f)} (${f.withheld === "disagree" ? "the asks disagreed" : "low confidence"})`).join(", ")}, and nothing else is left to do`));
    const left = leftToYouSays(checked.leftToYou);
    return refused(new PlannerError("nothingToDo", `Caret found no value for ${checked.fields.map((f) => f.name).join(", ")} on screen, in memory or in your instruction${left === null ? "" : `; ${left} is yours to type`}`));
  }

  const sel: WindowSel = { bundleId: w.app.bundleId, title: w.window.title, ...(w.window.number === undefined ? {} : { number: w.window.number }) };
  const slots: Record<string, string> = {};
  const slotNames: Record<string, string> = {};
  const steps: Step[] = writes.map((f, i) => {
    const slot = `v${i + 1}`;
    slots[slot] = f.value as string;
    slotNames[slot] = `the value for ${name(f)}`;
    return {
      says: `${name(f)} holds {{${slot}}}`,
      end: { kind: "valueEquals", window: sel, target: { key: f.key, describe: `the ${name(f)} field` }, value: `{{${slot}}}` },
      // A value copied from memory names its entry, so the executor checks it is still there before writing (B17).
      ...(f.memory === null ? {} : { memory: memoryRefOf(f.memory) }),
    };
  });
  // A plan needs a step; with only controls to set, it is one hand-off that names the first of them.
  if (steps.length === 0) {
    const first = controls[0] as FillField;
    const label = (w.nodes.get(first.key)?.label ?? "").trim();
    steps.push({ says: `You set ${name(first)}`, end: { kind: "handoff", window: sel, target: { key: first.key, describe: `the ${name(first)} control` }, why: handoffWhy(label) } });
  }
  const plan: Plan = { id: o.offerKey, title: instruction.replace(/\s+/g, " ").trim().slice(0, 100), slots: slotNames, steps };
  await o.beforeCheck?.();
  const ctx: PlanContext = { model, memory: memory.values(), instruction };
  let checkedPlan: ReturnType<typeof validatePlan>;
  try {
    checkedPlan = validatePlan(plan, slots, ctx);
  } catch (e) {
    return refused(e);
  }
  if (checkedPlan.window.window.windowId !== w.window.windowId) return refused(new PlannerError("unknownWindow", `'${w.window.title}' closed while Caret planned, and another window took its title`));
  // A value copied from a window charges that window when a target question quotes it (Plan.sources).
  const sources: Record<string, string> = {};
  for (const wr of checkedPlan.writes) if (wr.trace.from === "window") sources[`v${wr.step + 1}`] = wr.trace.windowId;
  return {
    plan: { ...plan, ...(Object.keys(sources).length === 0 ? {} : { sources }) },
    slots,
    checked: checkedPlan,
    answers: {},
    withheld: p.fields.flatMap((f) => (f.withheld === "disagree" || f.withheld === "lowConfidence" ? [{ name: name(f), why: f.withheld }] : [])),
    jev: { calls: jev.calls, costUsd: jev.costUsd, latencyMs: p.jev.latencyMs + use.latencyMs },
    controls: controls.map((f) => ({ key: f.key, name: name(f), value: f.handoff?.value ?? "", display: f.handoff?.display ?? "" })),
    leftToYou: leftToYouSays(checked.leftToYou),
    route: "fill",
    intent,
    maker: use,
    fill: p,
  };
}

/** The question for a value the user spelled out that reads more than one way. */
function askAbout(said: string, f: IntentField | undefined): string {
  const name = f?.name ?? "that field";
  switch (f?.control) {
    case "time":
      return `"${said}" for ${name}: in the morning or the evening? Say it with am or pm`;
    case "date":
      return `"${said}" for ${name}: which date do you mean? Say the day, the month and the year`;
    case "select":
    case "radio":
      return `"${said}" for ${name} matches none of its options, or more than one; say which option`;
    default:
      return `"${said}" for ${name} reads more than one way; say it in full`;
  }
}
