// Data shapes for code-mode planning: the frozen snapshots a program may read, the draft plan it builds,
// and how a run ends. A generated program only ever holds ref strings that the host issued in a
// readWindow result or minted for a step; every API call checks the ref against this run's registry.
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
  | { ref: string; kind: "ask"; question: string };

export interface ChoiceRecord {
  question: string;
  offered: string[];
  chosen: string | null;
}

/** What a program built. Not executable: a later stage validates it against the executor and shows it. */
export interface DraftPlan {
  basedOn: string;
  window: string;
  steps: PlanStep[];
  choices: ChoiceRecord[];
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
  | "fault"; // the worker or the WASM module failed in a way the above do not name

export interface RunStats {
  wallMs: number;
  guestCpuMs: number;
  readWindowCalls: number;
  chooseCalls: number;
  steps: number;
}

export type SandboxOutcome =
  | { ok: true; plan: DraftPlan; stats: RunStats }
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

const StatsSchema = z.object({ wallMs: z.number(), guestCpuMs: z.number(), readWindowCalls: z.number(), chooseCalls: z.number(), steps: z.number() }).strict();

const StepSchema = z.discriminatedUnion("kind", [
  z.object({ ref: z.string(), kind: z.literal("fill"), target: z.string(), value: z.string() }).strict(),
  z.object({ ref: z.string(), kind: z.literal("press"), target: z.string(), effect: z.string() }).strict(),
  z.object({ ref: z.string(), kind: z.literal("waitFor"), effect: z.string(), timeoutMs: z.number() }).strict(),
  z.object({ ref: z.string(), kind: z.literal("ask"), question: z.string() }).strict(),
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
              choices: z.array(z.object({ question: z.string(), offered: z.array(z.string()), chosen: z.string().nullable() }).strict()),
              programDigest: z.string(),
            })
            .strict(),
          stats: StatsSchema,
        })
        .strict(),
      z
        .object({
          ok: z.literal(false),
          kind: z.enum(["source", "input", "busy", "violation", "cpu", "memory", "stack", "deadline", "cancelled", "deadlock", "guestError", "callbackError", "fault"]),
          detail: z.string(),
          stats: StatsSchema,
        })
        .strict(),
    ]),
  })
  .strict();

/** The worker is about to wait for a callback reply; the watchdog pauses until the parent answers. */
export const WaitingMessage = z.object({ type: z.literal("waiting") }).strict();

export const WorkerMessage = z.discriminatedUnion("type", [ChooseRequestMessage, WaitingMessage, DoneMessage]);

/** Parent to worker: the answer to one choose call. */
export type ChooseReply = { type: "chooseResult"; callId: number; chosen: string | null } | { type: "chooseError"; callId: number; kind: "deadline" | "callbackError"; message: string };

export interface WorkerInput {
  js: string;
  programDigest: string;
  snapshots: PlanningSnapshot[];
  limits: SandboxLimits;
}
