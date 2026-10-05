// What a goal plan is once code has checked and lowered it (D2-06): the bindings the program's refs stood for when
// its snapshots were frozen, and the steps cut into segments, each an executor plan run under one acceptance.
// Nothing here acts. The digests are what an acceptance names, so a plan that changes in any way a user could care
// about (order, target, value, where the value came from, what must hold first, what a press does, a warning) is
// another plan that needs its own acceptance.
import { createHash } from "node:crypto";
import type * as z from "zod";
import type { ValueOriginSchema } from "../codemode/types.ts";
import type { Plan } from "../executor/schema.ts";
import type { HandoffWhy } from "./capabilities.ts";

export type ValueOrigin = z.infer<typeof ValueOriginSchema>;

/** Where a step acts: one window, or the calendar adapter. A segment never spans two. */
export type GoalDomain =
  | { kind: "window"; windowId: string; pid: number; bundleId: string; appName: string; title: string; number: number | null; windowKind: string; page: boolean }
  | { kind: "calendar"; calendar: string };

/** What a target looked like as a control: how a fill of it is lowered. */
export type GoalControl = "text" | "select" | "combobox" | "radio" | "date" | "checkbox" | "button" | "calendar";

/** What a target ref stood for when its snapshot was frozen. Code issued it; a program only names it. */
export interface TargetBinding {
  ref: string;
  domain: GoalDomain;
  /** The node's key in the reader's (or page engine's) walk; "calendar" for the calendar. */
  key: string;
  role: string;
  label: string;
  control: GoalControl;
  /** What it held then: a field's text, a control's choice, "" when empty. */
  value: string;
  /** The choices a select, combobox or radio group showed; null when code could not see them. */
  options: string[] | null;
}

/** What a value ref stood for: its exact text and where it came from. */
export interface ValueBinding {
  ref: string;
  text: string;
  display: string;
  origin: ValueOrigin;
  /** The window and node it was read from, and the window's revision then; null for the instruction and memory. */
  source: { windowId: string; key: string; revision: string } | null;
  /** The memory entry it was copied from (Step.memory), or null. */
  memory: string | null;
  /** A calendar event code derived from `sentence` (event-card.ts), which its source must still show; null for every other value. */
  event: { title: string; start: string; end: string; says: string; sentence: string } | null;
  /**
   * Text the writer composed (B30, goals/drafts.ts): the windows, by id, and the memory entries its facts may come from
   * beside the instruction. A value the program named as its basis stands for its source: a window's value adds that
   * window, an instruction span adds nothing (the instruction is always in), a memory value adds its entry, which must
   * still hold when the draft is written. Null for a value code read or derived.
   */
  draft: { windows: string[]; memory: { id: string; text: string }[] } | null;
}

/** Everything a program's refs may stand for, kept on the host side of the sandbox. */
export interface GoalInventory {
  /** The helper's reader session when the snapshots were frozen: window ids hold only within it. */
  readerSession: number;
  targets: ReadonlyMap<string, TargetBinding>;
  values: ReadonlyMap<string, ValueBinding>;
  /** Each window's revision when frozen, by window id (inventory.ts windowRevision). */
  revisions: ReadonlyMap<string, string>;
  /** Each page window's document generation when frozen (its frames' documents), by window id. */
  documents: ReadonlyMap<string, string>;
  /** The window id behind each snapshot's window ref ("w2"), for a draft's `from` (B30). */
  windowRefs: ReadonlyMap<string, string>;
  /** Each frozen window's title and text, by window id: what a draft's facts are checked against. Never sent. */
  texts: ReadonlyMap<string, { title: string; text: string }>;
}

export type GoalStepKind = "write" | "calendar" | "press" | "handoff";

export interface GoalStep {
  /** The program's step ref. */
  ref: string;
  /** Position in the whole goal, from 0. */
  index: number;
  kind: GoalStepKind;
  /** The step as the user reads it in the preview and in progress. */
  says: string;
  target: TargetBinding;
  value: ValueBinding | null;
  /** The value the step writes, as the control takes it (an option's label); null for presses and the calendar. */
  writes: string | null;
  /** The capability's effect for a press Caret makes; null otherwise. */
  effect: string | null;
  /** For a hand-off: why it is the user's. */
  handoff: HandoffWhy | null;
  /** A write into a To field (B30): its value must still be the answered message's sender right before it runs. */
  to: boolean;
}

export type SegmentReason = "start" | "crossWindow" | "afterReveal";

export interface GoalSegment {
  index: number;
  domain: GoalDomain;
  reason: SegmentReason;
  steps: GoalStep[];
  /** The executor task: its plan and slots. Every screen string goes in a slot, never into the plan's text. */
  plan: Plan;
  slots: Record<string, string>;
  /** What one acceptance of this segment names. */
  digest: string;
}

export interface GoalPlan {
  goalId: string;
  instruction: string;
  /** SHA-256 of the program's TypeScript source (codemode DraftPlan.programDigest). */
  programHash: string;
  segments: GoalSegment[];
  /** Things the user should know before accepting, shown with the first segment and covered by every digest. */
  warnings: string[];
  /** Over every segment's digest, in order. */
  digest: string;
  inventory: GoalInventory;
}

/** JSON with object keys sorted, so equal content always hashes equal. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * A segment's digest: the program, the segment's place and window, and per step its order, target as frozen (what it
 * held is the step's precondition), value with its provenance, the effect a press must have, and the hand-off, plus
 * the goal's warnings and the hash of the executor plan and slots made from them (runs.ts executable).
 */
export function segmentDigest(programHash: string, s: Omit<GoalSegment, "digest" | "plan" | "slots">, warnings: readonly string[], executable: string): string {
  return sha256(
    canonical({
      programHash,
      executable,
      index: s.index,
      reason: s.reason,
      domain: s.domain,
      steps: s.steps.map((x) => ({
        ref: x.ref,
        index: x.index,
        kind: x.kind,
        says: x.says,
        target: { domain: x.target.domain, key: x.target.key, role: x.target.role, label: x.target.label, control: x.target.control, precondition: x.target.value },
        value: x.value === null ? null : { text: x.value.text, origin: x.value.origin, source: x.value.source, memory: x.value.memory, event: x.value.event, draft: x.value.draft },
        writes: x.writes,
        effect: x.effect,
        handoff: x.handoff,
      })),
      warnings,
    }),
  );
}

/** The executor plan and slots a segment runs, as one hash: covered by its digest, so what runs is what was shown. */
export function executable(seg: Pick<GoalSegment, "plan" | "slots">): string {
  return sha256(canonical({ plan: seg.plan, slots: seg.slots }));
}

export function goalDigest(programHash: string, segmentDigests: readonly string[], warnings: readonly string[]): string {
  return sha256(canonical({ programHash, segments: segmentDigests, warnings }));
}
