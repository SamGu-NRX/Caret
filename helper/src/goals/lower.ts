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
// field, a value Jev does not confirm belongs there) is dropped, and the preview says why. A reply's To is filled
// with the answered message's sender when the program left it out, or left to the user (left.ts). What the goal
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
import type { SnippetLedger } from "../privacy.ts";
import { pressVerdict, YOURS_EFFECT, type HandoffWhy } from "./capabilities.ts";
import { checkDraftText, DraftRefused, recipientField, senderOf, subjectField, type DraftBasis } from "./drafts.ts";
import { codeGate, jevGate, JevUnavailable } from "./gates.ts";
import { fieldKinds } from "../fill/kinds.ts";
import { createHash } from "node:crypto";
import { saysPress } from "../planner/says.ts";
import { executable, goalDigest, segmentDigest, type GoalDomain, type GoalInventory, type GoalPlan, type GoalSegment, type GoalStep, type LeftItem, type SegmentReason, type TargetBinding, type ValueBinding } from "./plan.ts";

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
function draftCheck(t: TargetBinding, v: ValueBinding, basis: DraftBasis): void {
  if (t.control !== "text") throw new GoalError("wrongKind", `Caret writes drafts only in a text field, and ${named(t)} is not one`, `${t.ref} <- ${v.ref}`);
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
 * other text, a button and a box are refused or handed off as before.
 */
function lowerFill(t: TargetBinding, v: ValueBinding): Pick<GoalStep, "kind" | "says" | "writes" | "handoff"> | Dropped {
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
      const option = t.options === null ? null : matchOption(t.options, v.text);
      if (option === null) return { drop: `the field has no choice that is exactly '${clip(v.text)}'` };
      if (t.value !== "" && t.value !== option) throw new GoalError("notEmpty", `${named(t)} already has a choice, so Caret will not change it`, t.ref);
      return { kind: "write", says: `${t.label}: ${option}`, writes: option, handoff: null };
    }
    case "date": {
      if (!page) return { kind: "handoff", says: `Caret leaves setting ${named(t)} to you`, writes: null, handoff: "unverifiable" };
      if (v.origin.kind !== "derived" || !/^\d{4}-\d{2}-\d{2}$/.test(v.text)) return { drop: `the field takes a date the value resolver read, and '${clip(v.text)}' is not one` };
      if (t.value !== "" && t.value !== v.text) throw new GoalError("notEmpty", `${named(t)} already holds a date, so Caret will not change it`, t.ref);
      return { kind: "write", says: `${t.label}: ${v.text}`, writes: v.text, handoff: null };
    }
    case "checkbox":
      // Fill's box rules (consent, statements, who states the fact) are not repeated for goals: the box is the user's.
      return { kind: "handoff", says: `Caret leaves ticking ${named(t)} to you`, writes: null, handoff: "unverifiable" };
    case "button":
      throw new GoalError("schema", `${named(t)} is a button, not a field`, t.ref);
  }
}

const clip = (s: string): string => {
  const t = s.replace(/\s+/gu, " ").trim();
  return t.length <= 60 ? t : `${t.slice(0, 59)}…`;
};

/** Where a target is, for a left item: its window, or "calendar". */
const whereOf = (t: TargetBinding): string => (t.domain.kind === "window" ? t.domain.windowId : "calendar");

export interface LowerOptions {
  /** Presses an earlier plan for the same goal made (runs.ts): a fresh plan may not make them again. */
  done?: readonly DonePress[];
  /** The model that wrote the program, recorded on each draft's origin. */
  writerModel?: string;
  /** Jev, for the value gate; null confirms nothing, so no copied value is written. */
  askJev: AskJev | null;
  /** The ledger the inventory's texts went through: what a Jev request may carry. */
  ledger: SnippetLedger;
}

/**
 * Lowers a sandbox plan against the inventory its snapshots came from. Throws GoalError with the first check that
 * refuses the plan; drops each write whose value fails a gate and says why in `warnings` and `left`. The result is
 * not yet accepted: each segment runs only after an acceptance that names its digest.
 */
export async function lowerGoal(goalId: string, instruction: string, draft: DraftPlan, inv: GoalInventory, o: LowerOptions): Promise<GoalPlan> {
  const done = o.done ?? [];
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
  const left: LeftItem[] = [];
  /** A dropped write is left to the user; in a message's recipient field, as its recipient (left.ts). */
  const dropAs = (t: TargetBinding, why: string): void => {
    const recipient = (inv.owed.get(whereOf(t)) ?? []).some((f) => f.key === t.key && f.why === "recipient");
    left.push({ windowId: whereOf(t), key: t.key, label: t.label, why: recipient ? "recipient" : "dropped", says: recipient ? `You add the recipient in ${named(t)}: ${why}` : `Caret left ${named(t)} empty: ${why}` });
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
      if (v.draft !== null) draftCheck(t, v, frozenBasis(instruction, v, inv));
      const to = t.control === "calendar" ? false : recipientCheck(t, v, inv);
      const gated = codeGate(t, v, instruction);
      if (gated !== null) {
        dropAs(t, gated);
        continue;
      }
      const lowered = lowerFill(t, v);
      if ("drop" in lowered) {
        dropAs(t, lowered.drop);
        continue;
      }
      const gate = lowered.kind !== "write" ? null : v.draft !== null ? "draft" : "jev";
      steps.push({ ref: s.ref, index, target: t, value: lowered.kind === "handoff" ? null : v, effect: null, to, gate, ...lowered });
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
  // sender there, through the same gates as any other write; a recipient it cannot find is the user's to add.
  for (const windowId of writesIn) {
    for (const f of inv.owed.get(windowId) ?? []) {
      if (f.why !== "recipient" || !f.empty || steps.some((x) => x.kind === "write" && x.target.domain.kind === "window" && x.target.domain.windowId === windowId && x.target.key === f.key)) continue;
      const t = [...inv.targets.values()].find((x) => x.domain.kind === "window" && x.domain.windowId === windowId && x.key === f.key && x.control === "text");
      const sender = t === undefined || t.domain.kind !== "window" ? undefined : senderValue(t.domain.title, inv);
      if (t === undefined || sender === undefined) {
        left.push({ windowId, key: f.key, label: f.label, why: "recipient", says: `You add the recipient in '${f.label}': Caret found no sender of a message this one answers` });
        continue;
      }
      recipientCheck(t, sender, inv);
      const at = steps.findIndex((x) => x.target.domain.kind === "window" && x.target.domain.windowId === windowId);
      const step: GoalStep = { ref: `to:${t.ref}`, index: 0, kind: "write", says: `${t.label}: ${sender.text}`, target: t, value: sender, writes: sender.text, effect: null, handoff: null, to: true, gate: "jev" };
      steps.splice(at < 0 ? steps.length : at, 0, step);
    }
  }
  // Jev's question for every copied value still in the plan (drafts are drafts.ts's), both wordings, fill's floor.
  let unconfirmed: Map<string, string>;
  try {
    unconfirmed = await jevGate(instruction, steps.flatMap((x) => (x.kind === "write" && x.gate === "jev" && x.value !== null ? [{ ref: x.ref, target: x.target, value: x.value }] : [])), o.askJev, o.ledger);
  } catch (e) {
    if (e instanceof JevUnavailable) throw new GoalError("unchecked", "Caret couldn't check the plan's values with Jev just now", e.message);
    throw e;
  }
  steps = steps.filter((x) => {
    const why = unconfirmed.get(x.ref);
    if (why === undefined) return true;
    dropAs(x.target, why);
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
  steps.forEach((x, i) => (x.index = i));
  warnings.push(...left.map((l) => `${l.says}.`));
  const acting = steps.filter((x) => x.kind !== "handoff");
  if (acting.length === 0) {
    const dropped = left.find((l) => l.why !== "required");
    if (dropped !== undefined) throw new GoalError("nothingToDo", dropped.says);
    // A plan that only hands the user a send, submit, pay or delete is said as an Ask says it (B26 lead decision 3).
    const press = steps.find((x) => x.kind === "handoff" && x.handoff !== null && x.handoff !== "unverifiable" && x.handoff !== "system");
    throw new GoalError("nothingToDo", press?.handoff == null ? "the plan leaves every step to you, so there is nothing for Caret to do" : saysPress(press.handoff, press.target.label));
  }
  const segments = cut(draft.programDigest, steps, warnings);
  if (segments.length > MAX_SEGMENTS) throw new GoalError("tooManySegments", `the plan needs ${segments.length} separate acceptances; Caret offers at most ${MAX_SEGMENTS}`);
  return { goalId, instruction, programHash: draft.programDigest, segments, warnings, left, digest: goalDigest(draft.programDigest, segments.map((x) => x.digest), warnings), inventory: inv };
}

/** The value the inventory lists that is the From address of the message the window titled `reply` answers. */
function senderValue(reply: string, inv: GoalInventory): ValueBinding | undefined {
  return [...inv.values.values()].find((v) => {
    const src = v.source === null ? undefined : inv.texts.get(v.source.windowId);
    return v.draft === null && v.event === null && src !== undefined && senderOf(reply, src, v.text);
  });
}

function cut(programHash: string, steps: readonly GoalStep[], warnings: readonly string[]): GoalSegment[] {
  const groups: { domain: GoalDomain; reason: SegmentReason; steps: GoalStep[] }[] = [];
  for (const s of steps) {
    const last = groups.at(-1);
    const prev = last?.steps.at(-1);
    const revealed = prev?.kind === "press";
    if (last !== undefined && sameDomain(last.domain, s.target.domain) && !revealed) {
      last.steps.push(s);
      continue;
    }
    groups.push({ domain: s.target.domain, reason: last === undefined ? "start" : revealed && sameDomain(last.domain, s.target.domain) ? "afterReveal" : "crossWindow", steps: [s] });
  }
  return groups.map((g, index) => {
    const base = { index, domain: g.domain, reason: g.reason, steps: g.steps };
    const { plan, slots } = executorPlan(`segment-${index}`, base);
    return { ...base, plan, slots, digest: segmentDigest(programHash, base, warnings, executable({ plan, slots })) };
  });
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
  const sel: WindowSel | null = d.kind === "window" ? { bundleId: d.bundleId, title: slot("title", d.title, "the window's title", d.windowId), ...(d.number === null ? {} : { number: d.number }) } : null;
  const out: Step[] = s.steps.map((x, i): Step => {
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
      ...(x.target.control === "button" ? { label: `{{l${i}}}` } : {}),
    };
    const says = slot(`s${i}`, x.says, `step ${i + 1}`);
    if (x.kind === "write") {
      const value = slot(`v${i}`, x.writes ?? "", `value ${i + 1}`, x.value?.source?.windowId);
      return { says, end: { kind: "valueEquals", window: sel, target, value }, ...(x.value?.memory == null ? {} : { memory: x.value.memory }) };
    }
    if (x.kind === "press") return { says, end: { kind: "fieldsRevealed", window: sel, target }, via: { kind: "press", target } };
    return { says, end: { kind: "handoff", window: sel, target, why: x.handoff ?? "unverifiable" } };
  });
  return {
    plan: { id, title: d.kind === "window" ? `Goal step in ${d.appName}` : `Goal step in the ${d.calendar} calendar`, slots: declared, ...(Object.keys(sources).length === 0 ? {} : { sources }), steps: out },
    slots,
  };
}
