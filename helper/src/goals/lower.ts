// Lowering (D2-06, plan section 5 "Validation and resume"): a sandbox DraftPlan, whose steps hold only refs, becomes
// a GoalPlan of executor end states the existing executor already knows how to reach and verify:
//   fill a text field          -> valueEquals on the exact key (reader writes; page writes through the page engine)
//   fill a page select, combobox or radio group -> valueEquals with the option's label (D2-04's control handlers,
//                                 W2's combobox pick), only when the value is exactly one of the options code saw
//   fill a page date field     -> valueEquals with a YYYY-MM-DD value the resolver derived
//   fill the calendar          -> calendarEvent from an event value code derived (the calendar adapter)
//   press with a capability    -> the capability's verifier end state, reached by that press (capabilities.ts)
//   any other press            -> handoff: the user presses it, and the goal ends there
// Everything else is refused here with a reason the user can read, before anything is shown as acceptable: a
// question (ask), a wait not tied to the press before it, a fill of a box or a native control, a value whose kind
// does not fit its field, a field that already holds other text, a step after a hand-off.
// Steps are then cut into segments: a new segment starts where the window changes (or the calendar starts or ends),
// and after a press whose effect changes what the window offers. Each segment is one executor task, under one
// forward grant for its one window, and needs its own acceptance.
import type { DraftPlan } from "../codemode/types.ts";
import type { Plan, Step, WindowSel } from "../executor/schema.ts";
import { matchOption } from "../fill/controls.ts";
import { misfit } from "../fill/kinds.ts";
import { pressVerdict, YOURS_EFFECT, type HandoffWhy } from "./capabilities.ts";
import { checkDraftText, DraftRefused, recipientField, subjectField, type DraftBasis } from "./drafts.ts";
import { createHash } from "node:crypto";
import { saysPress } from "../planner/says.ts";
import { executable, goalDigest, segmentDigest, type GoalDomain, type GoalInventory, type GoalPlan, type GoalSegment, type GoalStep, type SegmentReason, type TargetBinding, type ValueBinding } from "./plan.ts";

/** Segments one goal may have. Assumed: the scenes need two or three; more is more acceptances than a user follows. */
export const MAX_SEGMENTS = 4;

export type GoalRefusal = "schema" | "unsupportedStep" | "stepAfterHandoff" | "wrongKind" | "notEmpty" | "tooManySegments" | "nothingToDo" | "replay" | "draft" | "recipient";

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

/** What a draft's facts are checked against: the instruction, its basis windows as frozen, and its basis values' texts. */
export function frozenBasis(instruction: string, v: ValueBinding, inv: GoalInventory): DraftBasis {
  const windows = (v.draft?.windows ?? []).flatMap((id) => {
    const t = inv.texts.get(id);
    return t === undefined ? [] : [t];
  });
  return { instruction, windows, memory: v.draft?.texts ?? [] };
}

/**
 * Who a message goes to is the user's (B30): a Cc or Bcc field is never written, and a To field takes only an address
 * its source shows as the sender of the message being answered. Checked for every value, copied or drafted.
 */
function recipientCheck(t: TargetBinding, v: ValueBinding): void {
  const r = recipientField(t.label);
  if (r === "copy") throw new GoalError("recipient", "Caret doesn't add people to a message. Add them yourself", `${t.ref} <- ${v.ref}`);
  if (r === "to" && (v.draft !== null || !v.sender)) throw new GoalError("recipient", `Caret puts only the sender of the message you're answering in ${named(t)}`, `${t.ref} <- ${v.ref}`);
}

/** A drafted value's own checks (goals/drafts.ts), against the field it goes in and its frozen basis. */
function draftCheck(t: TargetBinding, v: ValueBinding, basis: DraftBasis): void {
  if (t.control !== "text") throw new GoalError("wrongKind", `Caret writes drafts only in a text field, and ${named(t)} is not one`, `${t.ref} <- ${v.ref}`);
  if (subjectField(t.label)) throw new GoalError("draft", "Caret doesn't write subject lines", `${t.ref} <- ${v.ref}`);
  try {
    checkDraftText(v.text, basis);
  } catch (e) {
    if (e instanceof DraftRefused) throw new GoalError("draft", e.says, `${e.why}: ${v.ref}`);
    throw e;
  }
}

function lowerFill(t: TargetBinding, v: ValueBinding): Pick<GoalStep, "kind" | "says" | "writes" | "handoff"> {
  recipientCheck(t, v);
  if (t.control === "calendar") {
    if (v.event === null) throw new GoalError("wrongKind", `${v.display} is not an event Caret can add to a calendar`, `${t.ref} <- ${v.ref}`);
    return { kind: "calendar", says: `Add '${v.event.title}' to your ${t.label} calendar, ${v.event.says}`, writes: null, handoff: null };
  }
  if (v.event !== null) throw new GoalError("wrongKind", `an event goes on the calendar, not in ${named(t)}`, `${t.ref} <- ${v.ref}`);
  const page = t.domain.kind === "window" && t.domain.page;
  switch (t.control) {
    case "text": {
      const bad = misfit(v.text, [t.label]);
      if (bad !== null) throw new GoalError("wrongKind", `${named(t)} does not take that value: ${bad}`, `${t.ref} <- ${v.ref}`);
      // A field that already holds the value is left as it is (the executor finds it already true); one that holds
      // other text is the user's, and Caret does not write over it.
      if (t.value !== "" && t.value !== v.text) throw new GoalError("notEmpty", `${named(t)} already holds text, so Caret will not write over it`, t.ref);
      return { kind: "write", says: `${t.label}: ${v.text}`, writes: v.text, handoff: null };
    }
    case "select":
    case "combobox":
    case "radio": {
      if (!page) return { kind: "handoff", says: `Caret leaves setting ${named(t)} to you`, writes: null, handoff: "unverifiable" };
      const option = t.options === null ? null : matchOption(t.options, v.text);
      if (option === null) throw new GoalError("wrongKind", `${named(t)} has no choice that is exactly '${v.text}'`, `${t.ref} <- ${v.ref}`);
      if (t.value !== "" && t.value !== option) throw new GoalError("notEmpty", `${named(t)} already has a choice, so Caret will not change it`, t.ref);
      return { kind: "write", says: `${t.label}: ${option}`, writes: option, handoff: null };
    }
    case "date": {
      if (!page) return { kind: "handoff", says: `Caret leaves setting ${named(t)} to you`, writes: null, handoff: "unverifiable" };
      if (v.origin.kind !== "derived" || !/^\d{4}-\d{2}-\d{2}$/.test(v.text)) throw new GoalError("wrongKind", `${named(t)} takes a date the value resolver read, and ${v.display} is not one`, `${t.ref} <- ${v.ref}`);
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

/**
 * Lowers a sandbox plan against the inventory its snapshots came from. Throws GoalError with the first check that
 * fails. The result is not yet accepted: each segment runs only after an acceptance that names its digest.
 */
export function lowerGoal(goalId: string, instruction: string, draft: DraftPlan, inv: GoalInventory, done: readonly DonePress[] = [], writerModel = ""): GoalPlan {
  if (!/^[0-9a-f]{64}$/.test(draft.programDigest)) throw new GoalError("schema", "the plan has no program behind it", draft.programDigest);
  // Drafted texts (B30) as values: their basis is the windows and values the program named, by what they stood for.
  // Memory a fill of this plan copies is part of every draft's basis ("memory the plan used").
  const usedMemory = draft.steps.flatMap((s) => (s.kind === "fill" ? [inv.values.get(s.value)] : [])).flatMap((v) => (v !== undefined && v.origin.kind === "memory" ? [v.text] : []));
  const drafted = new Map<string, ValueBinding>();
  for (const d of draft.drafts) {
    const windows: string[] = [];
    const texts: string[] = [...usedMemory];
    for (const ref of d.from) {
      const w = inv.windowRefs.get(ref);
      const v = inv.values.get(ref);
      if (w !== undefined) windows.push(w);
      else if (v !== undefined) texts.push(v.text);
      else throw new GoalError("schema", "a draft names a basis the snapshot did not list", `${d.ref} from ${ref}`);
    }
    const digest = createHash("sha256").update(d.text).digest("hex");
    drafted.set(d.ref, { ref: d.ref, text: d.text, display: d.text, origin: { kind: "draft", draftId: d.ref, model: writerModel, basis: d.from, digest }, source: null, memory: null, event: null, draft: { windows: [...new Set(windows)], texts }, sender: false });
  }
  const steps: GoalStep[] = [];
  const warnings: string[] = [];
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
      if (steps.some((x) => x.target.ref === t.ref && x.kind !== "calendar")) throw new GoalError("schema", `the plan fills ${named(t)} twice`, t.ref);
      if (v.draft !== null) {
        recipientCheck(t, v);
        draftCheck(t, v, frozenBasis(instruction, v, inv));
      }
      const lowered = lowerFill(t, v);
      steps.push({ ref: s.ref, index, target: t, value: lowered.kind === "handoff" ? null : v, effect: null, ...lowered });
      lastPress = null;
      continue;
    }
    // A press. The calendar is never pressed.
    if (t.domain.kind !== "window" || t.control !== "button") throw new GoalError("schema", `${named(t)} is not a control Caret could press`, t.ref);
    const verdict = pressVerdict({ label: t.label, role: t.role, windowKind: t.domain.windowKind, bundleId: t.domain.bundleId, page: t.domain.page }, s.effect);
    if (verdict.kind === "handoff") {
      // Asked for as Caret's own press: the preview says plainly that it is not.
      if (s.effect !== YOURS_EFFECT) warnings.push(`${verdict.says.charAt(0).toUpperCase()}${verdict.says.slice(1)}.`);
      steps.push({ ref: s.ref, index, kind: "handoff", says: verdict.says.charAt(0).toUpperCase() + verdict.says.slice(1), target: t, value: null, writes: null, effect: null, handoff: verdict.why });
      lastPress = null;
      continue;
    }
    // A press is not idempotent: a fresh plan for the same goal may not make one the goal already made (runs.ts receipts).
    if (done.some((d) => t.domain.kind === "window" && d.windowId === t.domain.windowId && d.key === t.key && d.effect === verdict.capability.effect)) {
      throw new GoalError("replay", `the plan would press ${named(t)} again, which Caret already did for this goal`, t.ref);
    }
    if (steps.some((x) => x.kind === "press" && x.target.ref === t.ref && x.effect === verdict.capability.effect)) throw new GoalError("replay", `the plan presses ${named(t)} twice`, t.ref);
    const step: GoalStep = { ref: s.ref, index, kind: "press", says: verdict.capability.says(t.label), target: t, value: null, writes: null, effect: verdict.capability.effect, handoff: null };
    steps.push(step);
    lastPress = step;
  }
  const acting = steps.filter((x) => x.kind !== "handoff");
  if (acting.length === 0) {
    // A plan that only hands the user a send, submit, pay or delete is said as an Ask says it (B26 lead decision 3).
    const press = steps.find((x) => x.kind === "handoff" && x.handoff !== null && x.handoff !== "unverifiable" && x.handoff !== "system");
    throw new GoalError("nothingToDo", press?.handoff == null ? "the plan leaves every step to you, so there is nothing for Caret to do" : saysPress(press.handoff, press.target.label));
  }
  const segments = cut(draft.programDigest, steps, warnings);
  if (segments.length > MAX_SEGMENTS) throw new GoalError("tooManySegments", `the plan needs ${segments.length} separate acceptances; Caret offers at most ${MAX_SEGMENTS}`);
  return { goalId, instruction, programHash: draft.programDigest, segments, warnings, digest: goalDigest(draft.programDigest, segments.map((x) => x.digest), warnings), inventory: inv };
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
