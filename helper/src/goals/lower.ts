// Lowering (D2-06, plan section 5 "Validation and resume"): a sandbox DraftPlan, whose steps hold only refs, becomes
// a GoalPlan of executor end states the existing executor already knows how to reach and verify:
//   fill a text field          -> valueEquals on the exact key (reader writes; page writes through the page engine)
//   fill a page select, combobox or radio group -> valueEquals with the option's label (D2-04's control handlers,
//                                 W2's combobox pick), only when the value is exactly one of the options code saw
//   fill a page date field     -> valueEquals with a YYYY-MM-DD value the resolver derived
//   fill the calendar          -> calendarEvent from an event value code derived (the calendar adapter)
//   press with a capability    -> the capability's verifier end state, reached by that press (capabilities.ts)
//   any other press            -> handoff: the user presses it, and the goal ends there
// A write whose value fails fill's value gates (G2, gates.ts: a kind Caret never types, a kind that does not fit the
// field, a value Jev does not confirm belongs there) is dropped, and the preview says why. Jev is not asked about a
// value the helper derived with nothing to choose (G3: the To below, an event inventory.ts built). A reply's To is
// filled with the answered message's sender when the program left it out, or left to the user (left.ts). What the goal
// leaves undone is listed in the plan, so it can never end as done (runs.ts).
// Everything else is refused here with a reason the user can read, before anything is shown as acceptable: a
// question (ask), a wait not tied to the press before it, a fill of a box or a native control, a field that already
// holds other text, a step after a hand-off, a draft or a recipient the B30 rules refuse.
// Steps are then cut into segments: a new segment starts where the window changes (or the calendar starts or ends),
// and after a press whose effect changes what the window offers. Each segment is one executor task, under one
// forward grant for its one window, and needs its own acceptance.
import type { DraftPlan } from "../codemode/types.ts";
import type { Plan, Step, WindowSel } from "../executor/schema.ts";
import type { AskJev } from "../fill/jev.ts";
import { matchOption } from "../fill/controls.ts";
import { MAX_FIELDS } from "../fill/fill.ts";
import type { SnippetLedger } from "../privacy.ts";
import { pressVerdict, YOURS_EFFECT, type HandoffWhy } from "./capabilities.ts";
import { checkDraftText, eventsAsked, DraftRefused, recipientField, senderOf, subjectField, type DraftBasis } from "./drafts.ts";
import { codeGate, eventAsAsked, isDerived, jevGate, JevUnavailable, markDerived, markFilled } from "./gates.ts";
import { checkValues, ContractError, exemptRefusal, mintExempt, requireChecked, VerifierUnavailable, type CheckedValue, type ExemptRule, type Proposed } from "../fill/contract.ts";
import { PAGE_CHECKED } from "../protocol.ts";
import { fieldKinds } from "../fill/kinds.ts";
import { createHash } from "node:crypto";
import { saysPress } from "../planner/says.ts";
import { executable, goalDigest, segmentDigest, type AttachOffer, type GoalDomain, type GoalInventory, type GoalPlan, type GoalSegment, type GoalStep, type LeftItem, type SegmentReason, type TargetBinding, type ValueBinding } from "./plan.ts";

/** Segments one goal may have. Assumed: the scenes need two or three; more is more acceptances than a user follows. */
export const MAX_SEGMENTS = 4;

export type GoalRefusal = "schema" | "unsupportedStep" | "stepAfterHandoff" | "wrongKind" | "notEmpty" | "tooManySegments" | "nothingToDo" | "replay" | "draft" | "recipient" | "unchecked";

/** A press an earlier plan for the same goal made and verified (runs.ts StepReceipt). */
export interface DonePress {
  windowId: string | null;
  key: string;
  effect: string | null;
}

/** A plan code will not offer. `says` is the sentence the user reads; `detail` names refs for the log. */
export class GoalError extends Error {
  readonly code: GoalRefusal;
  readonly says: string;
  /**
   * I6: the plan read the tab the user left, so `says` and the message may quote its text (a hand-off's value): the
   * user is told, and logs name the code only (P4 rule 6).
   */
  fromTab = false;
  constructor(code: GoalRefusal, says: string, detail?: string) {
    super(detail === undefined ? says : `${says} (${detail})`);
    this.code = code;
    this.says = says;
  }
}

const sameDomain = (a: GoalDomain, b: GoalDomain): boolean => (a.kind === "calendar" ? b.kind === "calendar" && a.calendar === b.calendar : b.kind === "window" && a.windowId === b.windowId);

function named(t: TargetBinding): string {
  return t.label === "" ? "a field" : `'${t.label}'`;
}

/** What a draft's facts are checked against: the instruction, its basis windows as frozen, and its memory values. */
export function frozenBasis(instruction: string, v: ValueBinding, inv: GoalInventory): DraftBasis {
  const windows = (v.draft?.windows ?? []).flatMap((id) => {
    const t = inv.texts.get(id);
    return t === undefined ? [] : [t];
  });
  return { instruction, windows, memory: (v.draft?.memory ?? []).map((m) => m.text) };
}

/**
 * Who a message goes to is the user's (B30), for every value, copied or drafted: a Cc or Bcc field is never written, a
 * subject line is never written, and a To field takes only the address on the From line of the message the window
 * answers ("Re: <its subject>"). An email field in a window with a Send button is a To field whatever its label.
 */
/** Whether a target is a To field: by its label, or an email field in a window with a Send button. */
export function toField(t: TargetBinding, inv: GoalInventory): "to" | "copy" | null {
  const composer = t.domain.kind === "window" && [...inv.targets.values()].some((x) => x.domain.kind === "window" && t.domain.kind === "window" && x.domain.windowId === t.domain.windowId && x.control === "button" && /^send\b/iu.test(x.label.trim()));
  return recipientField(t.label) ?? (composer && fieldKinds([t.label]).has("email") ? "to" : null);
}

function recipientCheck(t: TargetBinding, v: ValueBinding, inv: GoalInventory): boolean {
  if (subjectField(t.label)) throw new GoalError("recipient", "Caret doesn't write subject lines", `${t.ref} <- ${v.ref}`);
  const r = toField(t, inv);
  if (r === "copy") throw new GoalError("recipient", "Caret doesn't add people to a message. Add them yourself", `${t.ref} <- ${v.ref}`);
  if (r !== "to") return false;
  const src = v.source === null ? undefined : inv.texts.get(v.source.windowId);
  if (v.draft !== null || t.domain.kind !== "window" || src === undefined || !senderOf(t.domain.title, src, v.text)) throw new GoalError("recipient", `Caret puts only the sender of the message you're answering in ${named(t)}`, `${t.ref} <- ${v.ref}`);
  return true;
}

/** A drafted value's own checks (goals/drafts.ts), against the field it goes in and its frozen basis. */
function draftCheck(v: ValueBinding, basis: DraftBasis): void {
  try {
    checkDraftText(v.text, basis);
  } catch (e) {
    if (e instanceof DraftRefused) throw new GoalError("draft", e.says, `${e.why}: ${v.ref}`);
    throw e;
  }
}

/** A write lowering leaves out: the sentence the preview says (without its period). */
interface Dropped {
  drop: string;
}

/**
 * A fill as the step its control takes, or why its value does not fit the control (dropped, G2). A field that holds
 * other text, a button and a box are refused or handed off as before. `gated`: the value is the pick fill agreed on for
 * this very target (P2), whose own control rules (fill.ts controlValue) already decided a box may be ticked.
 */
function lowerFill(t: TargetBinding, v: ValueBinding, gated: boolean): Pick<GoalStep, "kind" | "says" | "writes" | "handoff"> | Dropped {
  if (t.control === "calendar") {
    if (v.event === null) return { drop: `${clip(v.text)} is not an event Caret can add to a calendar` };
    return { kind: "calendar", says: `Add '${v.event.title}' to your ${t.label} calendar, ${v.event.says}`, writes: null, handoff: null };
  }
  if (v.event !== null) return { drop: `an event goes on the calendar, not in ${named(t)}` };
  const page = t.domain.kind === "window" && t.domain.page;
  switch (t.control) {
    case "text":
      // A field that already holds the value is left as it is (the executor finds it already true); one that holds
      // other text is the user's, and Caret does not write over it. Kinds are gates.ts codeGate's.
      if (t.value !== "" && t.value !== v.text) throw new GoalError("notEmpty", `${named(t)} already holds text, so Caret will not write over it`, t.ref);
      return { kind: "write", says: `${t.label}: ${v.text}`, writes: v.text, handoff: null };
    case "select":
    case "combobox":
    case "radio": {
      if (!page) return { kind: "handoff", says: `Caret leaves setting ${named(t)} to you`, writes: null, handoff: "unverifiable" };
      // A web dropdown hides its options (B27): fill's pick is an option's name by its own rule (fill.ts optionName), and
      // the page engine picks only the one option named exactly that, then verifies it (P2).
      if (t.control === "combobox" && t.options === null && gated) {
        if (t.value !== "" && t.value !== v.text) throw new GoalError("notEmpty", `${named(t)} already has a choice, so Caret will not change it`, t.ref);
        return { kind: "write", says: `${t.label}: ${v.text}`, writes: v.text, handoff: null };
      }
      const option = t.options === null ? null : matchOption(t.options, v.text);
      if (option === null) return { drop: `the field has no choice that is exactly '${clip(v.text)}'` };
      if (t.value !== "" && t.value !== option) throw new GoalError("notEmpty", `${named(t)} already has a choice, so Caret will not change it`, t.ref);
      return { kind: "write", says: `${t.label}: ${option}`, writes: option, handoff: null };
    }
    case "date":
    case "time": {
      if (!page) return { kind: "handoff", says: `Caret leaves setting ${named(t)} to you`, writes: null, handoff: "unverifiable" };
      // A date input takes YYYY-MM-DD, a date-and-time one YYYY-MM-DDTHH:MM (P2: fill's readDateTime), a time one HH:MM.
      // C2: a month input YYYY-MM, only as fill's own pick, which read the input's format (fill.ts controlValue).
      const shape = t.control === "time" ? /^\d{2}:\d{2}$/ : gated ? /^\d{4}-\d{2}(?:-\d{2}(?:T\d{2}:\d{2})?)?$/ : /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/;
      // C2: fill's pick of an About entry (a date of birth) is read by the same resolver, from the entry.
      if ((v.origin.kind !== "derived" && !(gated && v.origin.kind === "memory")) || !shape.test(v.text)) return { drop: `the field takes a ${t.control} the value resolver read, and '${clip(v.text)}' is not one` };
      if (t.value !== "" && t.value !== v.text) throw new GoalError("notEmpty", `${named(t)} already holds a ${t.control}, so Caret will not change it`, t.ref);
      return { kind: "write", says: `${t.label}: ${v.text}`, writes: v.text, handoff: null };
    }
    case "checkbox":
      // Fill's box rules (consent, statements, who states the fact; fill.ts controlValue) are not repeated for a writer's
      // goal: the box is the user's. A page plan's box is ticked only as fill would tick it in a Fill all (P2).
      if (gated && page && v.text === PAGE_CHECKED && t.value === "") return { kind: "write", says: `Tick ${named(t)}`, writes: PAGE_CHECKED, handoff: null };
      return { kind: "handoff", says: `Caret leaves ticking ${named(t)} to you`, writes: null, handoff: "unverifiable" };
    case "button":
      throw new GoalError("schema", `${named(t)} is a button, not a field`, t.ref);
    case "file":
      throw new GoalError("schema", `${named(t)} takes a file, which only an attach step puts there`, t.ref);
  }
}

const clip = (s: string, n = 60): string => {
  const t = s.replace(/\s+/gu, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

/** Where a target is, for a left item: its window, or "calendar". */
const whereOf = (t: TargetBinding): string => (t.domain.kind === "window" ? t.domain.windowId : "calendar");

/**
 * What a write's effect is known by, to match a left item with the step or receipt that makes it: a field's key, or for
 * the calendar the event itself (calendar, title, start, end), since every event shares the calendar's one target.
 */
export function effectKey(t: Pick<TargetBinding, "control" | "key" | "label">, v: Pick<ValueBinding, "event"> | null): string {
  return t.control === "calendar" && v?.event != null ? `event:${t.label}|${v.event.title}|${v.event.start}|${v.event.end}` : t.key;
}

export interface LowerOptions {
  /** Presses an earlier plan for the same goal made (runs.ts): a fresh plan may not make them again. */
  done?: readonly DonePress[];
  /** The model that wrote the program, recorded on each draft's origin. */
  writerModel?: string;
  /** Jev, for the value gate; null confirms nothing, so no copied value is written. */
  askJev: AskJev | null;
  /** The ledger the inventory's texts went through: what a Jev request may carry. */
  ledger: SnippetLedger;
  /** Writes a stopped goal this plan replaces meant and did not make (runs.ts): those this plan leaves out are left. */
  carried?: readonly LeftItem[];
  /**
   * P2: by target ref, the very value object proposeFill agreed on for that target (goals/page-planner.ts). A fill of
   * exactly that pair is gate "fill": Jev's question is not asked again, and every code check still runs. A message's
   * recipient or subject field is dropped for such a value rather than refusing the plan (fill reads no message).
   */
  gated?: ReadonlyMap<string, ValueBinding>;
  /**
   * P3: a page plan's file controls, each with the file its row offers (page-planner.ts). Each becomes an attach step
   * after every other step, so an attach the user leaves without a file (runs.ts drops it from the run) holds up nothing.
   */
  attach?: readonly { target: TargetBinding; file: AttachOffer }[];
  /**
   * I6: a page plan's hand-off row (page-planner.ts handoffRow), put after every other step, attach rows included. It
   * gets no executor step (executorPlan), so nothing ever presses its control.
   */
  handoffRow?: { target: TargetBinding; says: string; why: HandoffWhy };
  /**
   * C2 (lead decision 3): a long page form's part of each fill step, by the draft step's ref (page-planner.ts). Each part
   * is its own segment (reason moreFields), previewed and accepted with its own Tab and undone on its own; attach rows
   * and the hand-off row go with the last.
   */
  parts?: ReadonlyMap<string, number>;
  /** When the write contract's mints are made (fill/contract.ts); now by default. */
  now?: number;
}

/**
 * W2: what the write contract is asked about a value written into a target: the target's field as frozen, what the
 * control will hold, and where the value was read. A target with no field contract is one the inventory never froze
 * one for (a field Caret never types, refused by codeGate before this), so a write into it is a bug.
 */
export function proposedFor(t: TargetBinding, v: ValueBinding, written: string): Proposed {
  if (t.field === undefined) throw new ContractError("unchecked", `${t.ref}: the target has no field contract`);
  const provenance = v.provenance ?? (v.source !== null ? { kind: "window" as const, windowId: v.source.windowId, nodeKey: v.source.key, app: "", title: "", span: v.text, label: null, line: null, partOf: null } : v.memory !== null ? { kind: "memory" as const, id: v.memory, label: "", part: null, whose: v.owner === "user" || v.owner === "other" ? v.owner : null } : { kind: "instruction" as const, span: v.text });
  return { field: t.field, text: written, display: v.display, provenance, owner: v.owner };
}

/** The exemption a non-text control's written value is minted under in a goal: an option's own label or a resolved date. */
const EXEMPT_GOAL: Partial<Record<TargetBinding["control"], ExemptRule>> = { select: "optionLabel", radio: "optionLabel", combobox: "optionLabel", date: "resolverFormat", time: "resolverFormat" };

/** Segment warnings a goalProgress carries at most (protocol GoalProgress.warnings). */
const MAX_WARNINGS = 24;

/**
 * Lowers a sandbox plan against the inventory its snapshots came from. Throws GoalError with the first check that
 * refuses the plan; drops each write whose value fails a gate and says why in `warnings` and `left`. The result is
 * not yet accepted: each segment runs only after an acceptance that names its digest.
 */
export async function lowerGoal(goalId: string, instruction: string, draft: DraftPlan, inv: GoalInventory, o: LowerOptions): Promise<GoalPlan> {
  const done = o.done ?? [];
  const now = o.now ?? Date.now();
  if (!/^[0-9a-f]{64}$/.test(draft.programDigest)) throw new GoalError("schema", "the plan has no program behind it", draft.programDigest);
  // Drafted texts (B30) as values: their basis is the windows and values the program named, by what they stood for.
  // Memory a fill of this plan copies is part of every draft's basis ("memory the plan used").
  const memoryOf = (v: ValueBinding | undefined): { id: string; text: string }[] => (v !== undefined && v.memory !== null ? [{ id: v.memory, text: v.text }] : []);
  const usedMemory = draft.steps.flatMap((s) => (s.kind === "fill" ? memoryOf(inv.values.get(s.value)) : []));
  const drafted = new Map<string, ValueBinding>();
  for (const d of draft.drafts) {
    const windows: string[] = [];
    const memory = [...usedMemory];
    for (const ref of d.from) {
      const w = inv.windowRefs.get(ref);
      const v = inv.values.get(ref);
      if (w !== undefined) windows.push(w);
      // A value stands for its source, never for loose text: a window's value brings its window (so its facts are
      // checked as the window's, for conflicts and again before writing), memory its entry, an instruction span nothing.
      else if (v !== undefined && v.source !== null) windows.push(v.source.windowId);
      else if (v !== undefined && v.memory !== null) memory.push(...memoryOf(v));
      else if (v === undefined) throw new GoalError("schema", "a draft names a basis the snapshot did not list", `${d.ref} from ${ref}`);
    }
    const digest = createHash("sha256").update(d.text).digest("hex");
    drafted.set(d.ref, { ref: d.ref, text: d.text, display: d.text, origin: { kind: "draft", draftId: d.ref, model: o.writerModel ?? "", basis: d.from, digest }, source: null, memory: null, event: null, draft: { windows: [...new Set(windows)], memory }, owner: null });
  }
  let steps: GoalStep[] = [];
  const warnings: string[] = [];
  const asked = eventsAsked(instruction);
  const soleEvent = asked >= 1 && [...inv.values.values()].filter((v) => v.event !== null).length === 1;
  /** Words of the labels the targets showed ("To", the calendar's name): an instruction names them, not an event. */
  const labelWords = new Set([...inv.targets.values()].flatMap((t) => t.label.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "")));
  const left: LeftItem[] = [];
  /** A dropped write is left to the user; in a message's recipient field, as its recipient (left.ts). An event is named by itself. */
  const dropAs = (t: TargetBinding, why: string, v?: ValueBinding | null): void => {
    const recipient = (inv.owed.get(whereOf(t)) ?? []).some((f) => f.key === t.key && f.why === "recipient");
    const says = recipient ? `You add the recipient in ${named(t)}: ${why}` : t.control === "calendar" ? `Caret left the event out of your '${t.label}' calendar: ${why}` : `Caret left ${named(t)} empty: ${why}`;
    left.push({ windowId: whereOf(t), key: effectKey(t, v ?? null), label: t.label, why: recipient ? "recipient" : "dropped", says });
  };
  /** Every target a fill named, dropped or not: a plan that fills one twice is refused either way. */
  const filled = new Set<string>();
  /** Windows the program meant to write in, dropped writes included: what they owe is the goal's (left.ts). */
  const writesIn = new Set<string>();
  /** A press's waitFor, merged into it: only the effect of the press right before may be waited for. */
  let lastPress: GoalStep | null = null;
  for (const s of draft.steps) {
    if (steps.some((x) => x.kind === "handoff")) throw new GoalError("stepAfterHandoff", "the plan goes on after a step that is yours, and Caret cannot know what that step did", s.ref);
    if (s.kind === "ask") throw new GoalError("unsupportedStep", "the plan stops to ask you something, which a goal plan cannot do yet", s.ref);
    if (s.kind === "waitFor") {
      if (lastPress === null || steps.at(-1) !== lastPress || lastPress.effect !== s.effect) throw new GoalError("unsupportedStep", "the plan waits for something no press right before it causes", `${s.ref} ${s.effect}`);
      continue;
    }
    const t = inv.targets.get(s.target);
    if (t === undefined) throw new GoalError("schema", "the plan names a target the snapshot did not list", s.target);
    const index = steps.length;
    if (s.kind === "fill") {
      const v = inv.values.get(s.value) ?? drafted.get(s.value);
      if (v === undefined) throw new GoalError("schema", "the plan names a value the snapshot did not list", s.value);
      if (filled.has(t.ref) && t.control !== "calendar") throw new GoalError("schema", `the plan fills ${named(t)} twice`, t.ref);
      filled.add(t.ref);
      if (t.domain.kind === "window") writesIn.add(t.domain.windowId);
      // A draft is words for a message or description field (gates.ts): anywhere else it is dropped, as a value of the
      // wrong kind is, before its facts are read.
      if (v.draft !== null && t.control !== "text") {
        dropAs(t, "Caret writes drafts only in a field for a message or a description", v);
        continue;
      }
      if (v.draft !== null) draftCheck(v, frozenBasis(instruction, v, inv));
      // By identity: the value object fill agreed on for this target, never a look-alike (gates.ts markFilled).
      const byFill = o.gated?.get(t.ref) === v;
      // Who a message goes to and its subject are the user's (B30) for fill's values too, but a fill is not a plan of
      // the message: the field is left, not the plan refused, and only its own label makes it one (on a page, an email
      // field near a Send button is a contact form's, not a To).
      const pageRule = byFill ? pageRecipientRule(t) : null;
      if (pageRule !== null) {
        dropAs(t, pageRule, v);
        continue;
      }
      const to = t.control === "calendar" || byFill ? false : recipientCheck(t, v, inv);
      const lowered = lowerFill(t, v, byFill);
      if ("drop" in lowered) {
        dropAs(t, lowered.drop, v);
        continue;
      }
      // The gates read what the control will hold (a select's option as matched, an event's title), not the source.
      const written = lowered.kind === "calendar" ? (v.event?.title ?? v.text) : lowered.writes;
      const gated = written === null ? null : codeGate(t, written, v.text, v.draft !== null ? "draft" : lowered.kind === "calendar" ? "event" : "copy", instruction);
      if (gated !== null) {
        dropAs(t, gated, v);
        continue;
      }
      // An event the helper derived (inventory.ts eventsIn) skips Jev's value question (G3) only when nothing was left
      // to choose: the instruction asks for an event, the inventory derived exactly one, and the instruction names
      // nothing that event's sentence lacks (gates.ts eventAsAsked). Otherwise which event is a choice, and Jev answers
      // whether it is the one asked for. Any other value is the writer's pick.
      const derived = lowered.kind === "calendar" && v.event !== null && isDerived(v) && soleEvent && eventAsAsked(instruction, v.event, labelWords);
      const gate = lowered.kind === "handoff" ? null : v.draft !== null ? "draft" : derived ? "derived" : byFill ? "fill" : "jev";
      // W2: the write contract's mint (fill/contract.ts). Fill's own mint for a value fill agreed on for this very target;
      // a draft and a non-text control under their named exemption; a copied text value is checked below, all at once.
      let checked: CheckedValue | undefined;
      if (lowered.kind === "write" && lowered.writes !== null) {
        const at = `step ${s.ref}`;
        if (byFill) checked = requireChecked(v.checked, lowered.writes, t.key, at);
        else if (v.draft !== null) checked = mintExempt(proposedFor(t, v, lowered.writes), "draft", now, instruction);
        else if (t.control !== "text") checked = mintExempt(proposedFor(t, v, lowered.writes), EXEMPT_GOAL[t.control] ?? "optionLabel", now, instruction);
      }
      const step: GoalStep = { ref: s.ref, index, target: t, value: lowered.kind === "handoff" ? null : v, effect: null, to, gate, ...lowered, ...(checked === undefined ? {} : { checked }) };
      steps.push(gate === "derived" ? markDerived(step) : gate === "fill" ? markFilled(step) : step);
      lastPress = null;
      continue;
    }
    // A press. The calendar is never pressed.
    if (t.domain.kind !== "window" || t.control !== "button") throw new GoalError("schema", `${named(t)} is not a control Caret could press`, t.ref);
    const verdict = pressVerdict({ label: t.label, role: t.role, windowKind: t.domain.windowKind, bundleId: t.domain.bundleId, page: t.domain.page }, s.effect);
    if (verdict.kind === "handoff") {
      // Asked for as Caret's own press: the preview says plainly that it is not.
      if (s.effect !== YOURS_EFFECT) warnings.push(`${verdict.says.charAt(0).toUpperCase()}${verdict.says.slice(1)}.`);
      steps.push({ ref: s.ref, index, kind: "handoff", says: verdict.says.charAt(0).toUpperCase() + verdict.says.slice(1), target: t, value: null, writes: null, effect: null, handoff: verdict.why, to: false, gate: null });
      lastPress = null;
      continue;
    }
    // A press is not idempotent: a fresh plan for the same goal may not make one the goal already made (runs.ts receipts).
    if (done.some((d) => t.domain.kind === "window" && d.windowId === t.domain.windowId && d.key === t.key && d.effect === verdict.capability.effect)) {
      throw new GoalError("replay", `the plan would press ${named(t)} again, which Caret already did for this goal`, t.ref);
    }
    if (steps.some((x) => x.kind === "press" && x.target.ref === t.ref && x.effect === verdict.capability.effect)) throw new GoalError("replay", `the plan presses ${named(t)} twice`, t.ref);
    const step: GoalStep = { ref: s.ref, index, kind: "press", says: verdict.capability.says(t.label), target: t, value: null, writes: null, effect: verdict.capability.effect, handoff: null, to: false, gate: null };
    steps.push(step);
    lastPress = step;
  }
  // A reply's recipient (G2, B30): the program does not write To (goal-prompt.ts), so code puts the answered message's
  // sender there, through the never-typed and kind checks; a recipient it cannot find is the user's to add. Code chose
  // the value (recipientCheck, and runs.ts checks it again right before the write), so it skips Jev's value question
  // (G3). A To the program wrote itself, the same address included, is the writer's pick and goes to Jev.
  for (const windowId of writesIn) {
    for (const f of inv.owed.get(windowId) ?? []) {
      if (f.why !== "recipient" || !f.empty || steps.some((x) => x.kind === "write" && x.target.domain.kind === "window" && x.target.domain.windowId === windowId && x.target.key === f.key)) continue;
      const t = [...inv.targets.values()].find((x) => x.domain.kind === "window" && x.domain.windowId === windowId && x.key === f.key && x.control === "text");
      const senders = t === undefined || t.domain.kind !== "window" ? [] : senderValues(t.domain.title, inv);
      const sender = senders[0];
      if (t === undefined || sender === undefined) {
        left.push({ windowId, key: f.key, label: f.label, why: "recipient", says: `You add the recipient in '${f.label}': Caret found no sender of a message this one answers` });
        continue;
      }
      // Two answered messages (the same subject) from different people: which sender is a choice code does not make.
      if (new Set(senders.map((v) => v.text.trim().toLowerCase())).size > 1) {
        left.push({ windowId, key: f.key, label: f.label, why: "recipient", says: `You add the recipient in '${f.label}': more than one message this one answers has a sender, and Caret doesn't pick between them` });
        continue;
      }
      recipientCheck(t, sender, inv);
      // W2: the sender is minted under its exemption, whose shape checks still run (fill/contract.ts exemptRefusal).
      const gated = codeGate(t, sender.text, sender.text, "copy", instruction) ?? exemptRefusal(proposedFor(t, sender, sender.text), "recipientFromFrom", instruction);
      if (gated !== null) {
        left.push({ windowId, key: f.key, label: f.label, why: "recipient", says: `You add the recipient in '${f.label}': ${gated}` });
        continue;
      }
      const at = steps.findIndex((x) => x.target.domain.kind === "window" && x.target.domain.windowId === windowId);
      const step = markDerived<GoalStep>({ ref: `to:${t.ref}`, index: 0, kind: "write", says: `${t.label}: ${sender.text}`, target: t, value: sender, writes: sender.text, effect: null, handoff: null, to: true, gate: "derived", checked: mintExempt(proposedFor(t, sender, sender.text), "recipientFromFrom", now, instruction) });
      steps.splice(at < 0 ? steps.length : at, 0, step);
    }
  }
  // W2: every copied text value the program chose meets the write contract once (fill/contract.ts checkValues), with the
  // provenance the inventory froze; a refusal is dropped and said, as a gate's is.
  const copies = steps.filter((x) => x.kind === "write" && x.checked === undefined && x.writes !== null && x.value !== null);
  if (copies.length > 0) {
    const proposed = copies.map((x) => proposedFor(x.target, x.value as ValueBinding, x.writes as string));
    let result: Awaited<ReturnType<typeof checkValues>>;
    try {
      result = await checkValues(proposed, { askJev: o.askJev, ledger: o.ledger, instruction, now });
    } catch (e) {
      if (e instanceof VerifierUnavailable) throw new GoalError("unchecked", "Caret couldn't check the plan's values just now", e.message);
      throw e;
    }
    const refusedSteps = new Set<GoalStep>();
    for (const r of result.refused) {
      const x = copies[proposed.indexOf(r.proposed)] as GoalStep;
      refusedSteps.add(x);
      dropAs(x.target, r.says, x.value);
    }
    for (const c of result.ok) {
      const x = copies.find((y, i) => proposed[i]?.field === c.field && proposed[i]?.text === c.text) as GoalStep;
      x.checked = c;
    }
    steps = steps.filter((x) => !refusedSteps.has(x));
  }
  // Jev's question for every copied value still in the plan (drafts are drafts.ts's, derived values code's), both
  // wordings, fill's floor.
  let unconfirmed: Map<string, string>;
  try {
    unconfirmed = await jevGate(
      instruction,
      steps.flatMap((x) => {
        if (x.gate !== "jev" || x.value === null) return [];
        const answered = x.to && x.value.source !== null ? inv.texts.get(x.value.source.windowId)?.title : undefined;
        return [{ ref: x.ref, target: x.target, written: x.writes ?? x.value.event?.title ?? x.value.text, value: x.value, ...(answered === undefined ? {} : { senderOf: answered }) }];
      }),
      o.askJev,
      o.ledger,
    );
  } catch (e) {
    if (e instanceof JevUnavailable) throw new GoalError("unchecked", "Caret couldn't check the plan's values with Jev just now", e.message);
    throw e;
  }
  steps = steps.filter((x) => {
    const why = unconfirmed.get(x.ref);
    if (why === undefined) return true;
    dropAs(x.target, why, x.value);
    return false;
  });
  // What the forms the plan writes in still require after its writes (left.ts).
  for (const windowId of writesIn) {
    for (const f of inv.owed.get(windowId) ?? []) {
      if (f.why !== "required" || !f.empty || steps.some((x) => x.kind === "write" && x.target.domain.kind === "window" && x.target.domain.windowId === windowId && x.target.key === f.key)) continue;
      if (left.some((l) => l.windowId === windowId && l.key === f.key)) continue;
      left.push({ windowId, key: f.key, label: f.label, why: "required", says: `'${f.label}' is required, and this plan leaves it empty` });
    }
  }
  // Events the instruction asks for that no step adds: the goal cannot be done without them (runs.ts counts receipts).
  const adds = steps.filter((x) => x.kind === "calendar").length;
  // An event a gate dropped is already left, and said; the rest the plan has no step for at all.
  const droppedEvents = left.filter((l) => l.windowId === "calendar").length;
  if (asked > adds + droppedEvents) {
    const cal = [...inv.targets.values()].find((t) => t.control === "calendar");
    const what = asked === 1 ? "a calendar event" : `${asked} calendar events`;
    const says = cal === undefined ? `You asked for ${what}, and Caret has no calendar to add ${asked === 1 ? "it" : "them"} to` : `You asked for ${what}, and this plan adds ${adds === 0 ? "none" : adds} to your '${cal.label}' calendar`;
    left.push({ windowId: "calendar", key: "calendar:asked", label: cal?.label ?? "calendar", why: "asked", count: asked, says });
  }
  // What a stopped goal this one replaces meant to write: the preview names each one this plan does not write.
  for (const c of o.carried ?? []) {
    const writes = steps.some((x) => (x.kind === "write" || x.kind === "calendar") && whereOf(x.target) === c.windowId && effectKey(x.target, x.value) === c.key);
    if (!writes && !left.some((l) => l.windowId === c.windowId && l.key === c.key)) left.push(c);
  }
  // P3: the file controls, last. Only a page's file control takes one, and only through the page engine.
  for (const [i, a] of (o.attach ?? []).entries()) {
    const t = a.target;
    if (t.control !== "file" || t.domain.kind !== "window" || !t.domain.page) throw new GoalError("schema", `${named(t)} is not a page's file control`, t.ref);
    if (steps.some((x) => x.kind === "attach" && x.target.key === t.key)) throw new GoalError("schema", `the plan attaches to ${named(t)} twice`, t.ref);
    const what = t.label === "" ? "File" : t.label;
    steps.push({ ref: `a${i + 1}`, index: steps.length, kind: "attach", says: a.file.source === "saved" ? `${what}: ${a.file.name}` : `${what}: a file you choose`, target: t, value: null, writes: null, effect: null, handoff: null, to: false, gate: null, file: a.file });
  }
  if (o.handoffRow !== undefined) {
    const h = o.handoffRow;
    if (h.target.domain.kind !== "window" || !h.target.domain.page) throw new GoalError("schema", "only a page plan has a hand-off row", h.target.ref);
    steps.push({ ref: "h1", index: steps.length, kind: "handoff", says: h.says, target: h.target, value: null, writes: null, effect: null, handoff: h.why, to: false, gate: null, row: true });
  }
  steps.forEach((x, i) => (x.index = i));
  // C2: a form filled in parts says so before the first Tab, ahead of what is left (within MAX_WARNINGS, C2 review).
  const partCount = new Set(steps.flatMap((x) => (o.parts?.has(x.ref) === true ? [o.parts.get(x.ref) as number] : []))).size;
  if (partCount > 1) warnings.unshift(`Caret fills this form in ${partCount} parts of up to ${MAX_FIELDS} fields, each with its own preview and Tab.`);
  // A goalProgress carries MAX_WARNINGS sentences (P2: a 40-field form can leave more): the rest are named in one.
  const said = left.map((l) => `${l.says}.`);
  const room = MAX_WARNINGS - warnings.length;
  if (said.length <= room) warnings.push(...said);
  else {
    warnings.push(...said.slice(0, Math.max(0, room - 1)));
    const rest = left.slice(Math.max(0, room - 1));
    warnings.push(clip(`${rest.length} more are left to you: ${rest.map((l) => `'${l.label}'`).join(", ")}.`, 590));
  }
  const acting = steps.filter((x) => x.kind !== "handoff");
  if (acting.length === 0) {
    // Every write was dropped: the refusal says why for each, in the preview's words.
    const dropped = left.filter((l) => l.why !== "required").map((l) => l.says);
    if (dropped.length > 0) throw new GoalError("nothingToDo", clip(dropped.join("; "), 590));
    // A plan that only hands the user a send, submit, pay or delete is said as an Ask says it (B26 lead decision 3).
    const press = steps.find((x) => x.kind === "handoff" && x.handoff !== null && x.handoff !== "unverifiable" && x.handoff !== "system");
    throw new GoalError("nothingToDo", press?.handoff == null ? "the plan leaves every step to you, so there is nothing for Caret to do" : saysPress(press.handoff, press.target.label));
  }
  const segments = cut(draft.programDigest, steps, warnings, o.parts);
  if (segments.length > MAX_SEGMENTS) throw new GoalError("tooManySegments", `the plan needs ${segments.length} separate acceptances; Caret offers at most ${MAX_SEGMENTS}`);
  return { goalId, instruction, programHash: draft.programDigest, segments, warnings, left, digest: goalDigest(draft.programDigest, segments.map((x) => x.digest), warnings), inventory: inv };
}

/** Why a fill's value may not go in a page field because the field is a message's recipient or subject (B30), or null. */
function pageRecipientRule(t: TargetBinding): string | null {
  if (t.control === "calendar") return null;
  if (subjectField(t.label)) return "Caret doesn't write subject lines";
  const r = recipientField(t.label);
  if (r === "copy") return "Caret doesn't add people to a message. Add them yourself";
  return r === "to" ? "Caret puts in a message's recipient only from a goal that answers it" : null;
}

/** The values the inventory lists that are the From address of a message the window titled `reply` answers. */
function senderValues(reply: string, inv: GoalInventory): ValueBinding[] {
  return [...inv.values.values()].filter((v) => {
    const src = v.source === null ? undefined : inv.texts.get(v.source.windowId);
    return v.draft === null && v.event === null && src !== undefined && senderOf(reply, src, v.text);
  });
}

function cut(programHash: string, steps: readonly GoalStep[], warnings: readonly string[], parts?: ReadonlyMap<string, number>): GoalSegment[] {
  const groups: { domain: GoalDomain; reason: SegmentReason; steps: GoalStep[] }[] = [];
  let part: number | undefined;
  for (const s of steps) {
    const last = groups.at(-1);
    const prev = last?.steps.at(-1);
    const revealed = prev?.kind === "press";
    // C2: a step of the next part of a long page form starts its own segment.
    const next = parts?.get(s.ref);
    const nextPart = next !== undefined && part !== undefined && next !== part;
    if (next !== undefined) part = next;
    if (last !== undefined && sameDomain(last.domain, s.target.domain) && !revealed && !nextPart) {
      last.steps.push(s);
      continue;
    }
    groups.push({ domain: s.target.domain, reason: last === undefined ? "start" : nextPart && sameDomain(last.domain, s.target.domain) ? "moreFields" : revealed && sameDomain(last.domain, s.target.domain) ? "afterReveal" : "crossWindow", steps: [s] });
  }
  return groups.map((g, index) => segmentOf(programHash, { index, domain: g.domain, reason: g.reason, steps: g.steps }, warnings));
}

/**
 * A segment from its steps: the executor plan and slots made from them, and the digest over both. H9's edit of a draft
 * (runs.ts edit) rebuilds the one segment it changes here, so an edited segment is lowered exactly as a planned one.
 */
export function segmentOf(programHash: string, base: Pick<GoalSegment, "index" | "domain" | "reason" | "steps">, warnings: readonly string[]): GoalSegment {
  const { plan, slots } = executorPlan(`segment-${base.index}`, base);
  return { ...base, plan, slots, digest: segmentDigest(programHash, base, warnings, executable({ plan, slots })) };
}

/**
 * The executor plan of one segment. Every string read from the screen or a source (titles, labels, keys, values) is a
 * slot, so braces in it are never read as a placeholder (offers/fill-popup.ts fillPlan does the same).
 */
function executorPlan(id: string, s: { domain: GoalDomain; steps: readonly GoalStep[] }): { plan: Plan; slots: Record<string, string> } {
  const slots: Record<string, string> = {};
  const declared: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const slot = (name: string, value: string, what: string, from?: string): string => {
    slots[name] = value;
    declared[name] = what;
    if (from !== undefined) sources[name] = from;
    return `{{${name}}}`;
  };
  const d = s.domain;
  const sel: WindowSel | null = d.kind === "window" ? { bundleId: d.bundleId, title: slot("title", d.title, "the window's title", d.windowId), ...(d.number === null ? {} : { number: d.number }), ...(d.page ? { page: true as const, windowId: d.windowId } : {}) } : null;
  // I6: a hand-off row is the plan's last step and is never run, so the executor plan stops before it; every other step
  // keeps its index.
  const out: Step[] = s.steps.filter((x) => x.row !== true).map((x, i): Step => {
    if (x.kind === "calendar") {
      const ev = x.value?.event;
      if (ev == null || d.kind !== "calendar") throw new GoalError("schema", "a calendar step needs an event and the calendar", x.ref);
      return { says: slot(`s${i}`, x.says, `step ${i + 1}`), end: { kind: "calendarEvent", calendar: slot("calendar", d.calendar, "the calendar"), title: slot(`t${i}`, ev.title, `the title of event ${i + 1}`, x.value?.source?.windowId), start: ev.start, end: ev.end } };
    }
    if (sel === null) throw new GoalError("schema", "a window step outside a window segment", x.ref);
    // Exact: the element the preview named, with its role, and a button's own label; never a look-alike by label.
    const target = {
      key: slot(`k${i}`, x.target.key, `the key of target ${i + 1}`),
      role: slot(`r${i}`, x.target.role, `the role of target ${i + 1}`),
      describe: slot(`l${i}`, x.target.label, `the name of target ${i + 1}`, d.kind === "window" ? d.windowId : undefined),
      exact: true as const,
      // A button's own label, and (P3) a file control's, an empty one included: the executor finds the element only while
      // it still reads so (fix-check: an unlabelled control that gained a label after the precheck was still taken).
      ...(x.target.control === "button" || x.target.control === "file" ? { label: `{{l${i}}}` } : {}),
    };
    const says = slot(`s${i}`, x.says, `step ${i + 1}`);
    if (x.kind === "write") {
      const value = slot(`v${i}`, x.writes ?? "", `value ${i + 1}`, x.value?.source?.windowId);
      return { says, end: { kind: "valueEquals", window: sel, target, value }, ...(x.value?.memory == null ? {} : { memory: x.value.memory }) };
    }
    if (x.kind === "press") return { says, end: { kind: "fieldsRevealed", window: sel, target }, via: { kind: "press", target } };
    // P3: the file the acceptance confirmed for this field, verified by the page's own file list or rendered name.
    if (x.kind === "attach") return { says, end: { kind: "fileAttached", window: sel, target, wants: slot(`w${i}`, clip(x.target.label === "" ? "a file" : x.target.label, 80), `the file control ${i + 1}`) } };
    return { says, end: { kind: "handoff", window: sel, target, why: x.handoff ?? "unverifiable" } };
  });
  return {
    plan: { id, title: d.kind === "window" ? `Goal step in ${d.appName}` : `Goal step in the ${d.calendar} calendar`, slots: declared, ...(Object.keys(sources).length === 0 ? {} : { sources }), steps: out },
    slots,
  };
}
