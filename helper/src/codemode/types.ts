// Data shapes for code-mode planning: the frozen snapshots a program may read, the draft plan it builds,
// and how a run ends. A generated program only ever holds ref strings that the host issued in a
// readWindow result or minted for a step; every API call checks the ref against this run's registry.
import { createHash } from "node:crypto";
import * as z from "zod";
import type { SandboxLimits } from "./limits.ts";

/** A host-issued opaque reference. A string the guest writes or casts itself is checked, never trusted. */
export const RefString = z.string().regex(/^[A-Za-z0-9:_.\-]{1,128}$/);

export const ValueOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("span"), snapshot: RefString, source: z.string(), startUTF16: z.number().int().nonnegative(), endUTF16: z.number().int().nonnegative(), digest: z.string() }).strict(),
  z.object({ kind: z.literal("memory"), entryId: z.string(), fileRevision: z.string(), digest: z.string() }).strict(),
  z.object({ kind: z.literal("derived"), inputs: z.array(RefString), resolver: z.string(), version: z.string(), parametersDigest: z.string() }).strict(),
  z.object({ kind: z.literal("draft"), draftId: z.string(), model: z.string(), basis: z.array(RefString), digest: z.string() }).strict(),
]);

/**
 * One window frozen for a planning run: the ReadWindow of plan section 5. Question options carry a label
 * because choose() sends that label to Jev, and the label is code-written, not the program's.
 */
export const PlanningSnapshotSchema = z
  .object({
    snapshot: RefString,
    window: RefString,
    revision: z.string().max(128),
    title: z.string().max(200),
    targets: z.array(
      z
        .object({
          ref: RefString,
          label: z.string().max(200),
          kind: z.string().max(40),
          canFill: z.boolean(),
          options: z.array(RefString),
          allowedPressEffects: z.array(RefString),
          /** Slice 2: a list row's navigation effects (goals/capabilities.ts navVerdict); absent on every other target. */
          allowedNavigateEffects: z.array(RefString).optional(),
        })
        .strict(),
    ),
    values: z.array(z.object({ ref: RefString, display: z.string().max(400), origin: ValueOriginSchema }).strict()),
    questions: z.array(
      z
        .object({
          ref: RefString,
          text: z.string().max(400),
          options: z.array(z.object({ ref: RefString, label: z.string().max(200) }).strict()).min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type PlanningSnapshot = z.infer<typeof PlanningSnapshotSchema>;

export type PlanStep =
  | { ref: string; kind: "fill"; target: string; value: string }
  | { ref: string; kind: "press"; target: string; effect: string }
  | { ref: string; kind: "waitFor"; effect: string; timeoutMs: number }
  | { ref: string; kind: "ask"; question: string }
  /** Slice 2: open or select a list row; `effect` is "e:select", "e:open" or "e:yours". */
  | { ref: string; kind: "navigate"; target: string; effect: string }
  /** Slice 2: the window read again after the navigate step `after`, which must be the step registered just before. */
  | { ref: string; kind: "observe"; after: string };

export interface ChoiceRecord {
  question: string;
  offered: string[];
  chosen: string | null;
  /** requestDigest of the choose request as the worker sent it: a replay answers from the record only for the same request. */
  requestDigest: string;
}

/**
 * A run that stopped at an observe it may not serve from its record (CU-COUNSEL-R2 D4): the observe step's ref, the
 * navigate it follows, and how many observations were served before it. The run's plan ends with `after`.
 */
export interface PendingObserve {
  ref: string;
  after: string;
  index: number;
}

/**
 * What a replay serves from: the observations taken so far (refs prefixed `g<n>:`), each choice's request digest and
 * answer in order, and the steps already executed (the prefix), in registration order with their observe steps.
 */
export interface Recorded {
  observations: PlanningSnapshot[];
  choices: { requestDigest: string; chosen: string | null }[];
  prefix: PlanStep[];
}

export const NO_RECORD: Recorded = Object.freeze({ observations: [], choices: [], prefix: [] });

/** JSON with object keys sorted, so equal content always hashes and compares equal. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** A step as replay compares it: every field, canonical. */
export const stepKey = (s: PlanStep): string => canonicalJson(s);

/** SHA-256 of a choose request's window, question and options (ref and label each), as the worker sent it. */
export function requestDigest(r: { window: string; question: { ref: string; text: string }; options: readonly { ref: string; label: string }[] }): string {
  return createHash("sha256")
    .update(canonicalJson({ window: r.window, question: { ref: r.question.ref, text: r.question.text }, options: r.options.map((o) => ({ ref: o.ref, label: o.label })) }))
    .digest("hex");
}

/**
 * Text a goal program wrote for a field (B30), as a value ref `ref` its fill steps may name. `from` are the window and
 * value refs the program names as the draft's basis. Nothing checks the text here: goals/drafts.ts does, in lowering.
 */
export interface ProgramDraft {
  ref: string;
  text: string;
  from: string[];
}

/** What a program built. Not executable: a later stage validates it against the executor and shows it. */
export interface DraftPlan {
  basedOn: string;
  window: string;
  steps: PlanStep[];
  choices: ChoiceRecord[];
  /** Texts the program drafted (B30); always empty unless the run allowed drafts. */
  drafts: ProgramDraft[];
  /** SHA-256 of the TypeScript source the writer produced. */
  programDigest: string;
}

export type RefusalKind =
  | "source" // too large, not TypeScript the stripper accepts, or not the allowed program shape
  | "input" // the host's own snapshots are malformed or too large to hand to the guest
  | "busy" // another planning run holds the worker
  | "violation" // an API call broke a rule: unknown ref, budget, oversize argument, malformed plan
  | "cpu" // guest compute budget
  | "memory" // QuickJS heap, WASM memory or worker heap
  | "stack"
  | "deadline" // wall clock, including a host callback that did not return in time
  | "cancelled"
  | "deadlock" // the program awaited something nothing will settle
  | "guestError" // the program threw
  | "callbackError" // a host callback (Jev) failed
  | "fault" // the worker or the WASM module failed in a way the above do not name
  | "diverged" // a replay registered a step or asked a choice other than the recorded one
  | "observeBudget"; // the goal took its MAX_OBSERVES observations and the program asked for another

export interface RunStats {
  wallMs: number;
  guestCpuMs: number;
  readWindowCalls: number;
  chooseCalls: number;
  steps: number;
}

export type SandboxOutcome =
  /** `pending`: the run stopped at an observe the host will serve once the plan's steps ran; its steps end with `after`. */
  | { ok: true; plan: DraftPlan; stats: RunStats; pending: PendingObserve | null }
  | { ok: false; kind: RefusalKind; detail: string; stats: RunStats };

export const ZERO_STATS: RunStats = Object.freeze({ wallMs: 0, guestCpuMs: 0, readWindowCalls: 0, chooseCalls: 0, steps: 0 });

// Worker protocol. The parent validates every message from the worker against these schemas.

export const ChooseRequestMessage = z
  .object({
    type: z.literal("choose"),
    callId: z.number().int().nonnegative(),
    window: RefString,
    question: z.object({ ref: RefString, text: z.string() }).strict(),
    options: z.array(z.object({ ref: RefString, label: z.string() }).strict()).min(1),
  })
  .strict();
export type ChooseRequest = z.infer<typeof ChooseRequestMessage>;

/** The worker asks for observation `index` after the navigate step `after`. */
export const ObserveRequestMessage = z.object({ type: z.literal("observe"), callId: z.number().int().nonnegative(), after: RefString, index: z.number().int().nonnegative() }).strict();
export type ObserveRequest = z.infer<typeof ObserveRequestMessage>;

const StatsSchema = z.object({ wallMs: z.number(), guestCpuMs: z.number(), readWindowCalls: z.number(), chooseCalls: z.number(), steps: z.number() }).strict();

const StepSchema = z.discriminatedUnion("kind", [
  z.object({ ref: z.string(), kind: z.literal("fill"), target: z.string(), value: z.string() }).strict(),
  z.object({ ref: z.string(), kind: z.literal("press"), target: z.string(), effect: z.string() }).strict(),
  z.object({ ref: z.string(), kind: z.literal("waitFor"), effect: z.string(), timeoutMs: z.number() }).strict(),
  z.object({ ref: z.string(), kind: z.literal("ask"), question: z.string() }).strict(),
  z.object({ ref: z.string(), kind: z.literal("navigate"), target: z.string(), effect: z.string() }).strict(),
  z.object({ ref: z.string(), kind: z.literal("observe"), after: z.string() }).strict(),
]);

export const DoneMessage = z
  .object({
    type: z.literal("done"),
    outcome: z.union([
      z
        .object({
          ok: z.literal(true),
          plan: z
            .object({
              basedOn: z.string(),
              window: z.string(),
              steps: z.array(StepSchema),
              choices: z.array(z.object({ question: z.string(), offered: z.array(z.string()), chosen: z.string().nullable(), requestDigest: z.string() }).strict()),
              drafts: z.array(z.object({ ref: z.string(), text: z.string(), from: z.array(z.string()) }).strict()),
              programDigest: z.string(),
            })
            .strict(),
          stats: StatsSchema,
          pending: z.object({ ref: z.string(), after: z.string(), index: z.number().int().nonnegative() }).strict().nullable(),
        })
        .strict(),
      z
        .object({
          ok: z.literal(false),
          kind: z.enum(["source", "input", "busy", "violation", "cpu", "memory", "stack", "deadline", "cancelled", "deadlock", "guestError", "callbackError", "fault", "diverged", "observeBudget"]),
          detail: z.string().max(2000),
          stats: StatsSchema,
        })
        .strict(),
    ]),
  })
  .strict();

/** The worker is about to wait for a callback reply; the watchdog pauses until the parent answers. */
export const WaitingMessage = z.object({ type: z.literal("waiting"), consumed: z.number().int().nonnegative() }).strict();

export const WorkerMessage = z.discriminatedUnion("type", [ChooseRequestMessage, ObserveRequestMessage, WaitingMessage, DoneMessage]);

/** Parent to worker: the answer to one choose call. */
export type ChooseReply = { type: "chooseResult"; callId: number; chosen: string | null } | { type: "chooseError"; callId: number; kind: "deadline" | "callbackError"; message: string };

/**
 * Parent to worker: the answer to one observe call. `observeResult` serves a recorded observation (refs prefixed `g<n>:`);
 * `observeEnd` tells the worker to end the run as pending there, with no snapshot.
 */
export type ObserveReply = { type: "observeResult"; callId: number; snapshot: PlanningSnapshot } | { type: "observeEnd"; callId: number };

export type HostReply = ChooseReply | ObserveReply;

export interface WorkerInput {
  js: string;
  programDigest: string;
  snapshots: PlanningSnapshot[];
  limits: SandboxLimits;
  /** Steps may target any snapshot the program read (sandbox.ts RunOptions.multiWindow). */
  multiWindow: boolean;
  /** The program may call draft() (sandbox.ts RunOptions.drafts). */
  drafts: boolean;
  /** The program may call navigate() and observe() (sandbox.ts RunOptions.navigation). */
  navigation: boolean;
  /** What this run replays (sandbox.ts RunOptions.replay); NO_RECORD for a first run. */
  recorded: Recorded;
  /** False once the goal took MAX_OBSERVES observations: an observe past the record then ends the run as observeBudget. */
  mayObserve: boolean;
}
