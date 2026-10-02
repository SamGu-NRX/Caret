// Wire protocol between caret-screen (the Swift reader), this helper, and consumers
// such as the host app. One NDJSON message per line over ~/.caret-run/sockets/screen.sock.
// These zod schemas are the single source of truth: `pnpm schema` exports them to
// schemas/screen-protocol.schema.json, and the Swift side decodes the golden fixture
// in fixtures/golden/ in its own tests.
import * as z from "zod";

export const PROTOCOL_VERSION = 1;

const ms = z.number().int().nonnegative().describe("Milliseconds since the Unix epoch");

/** [x, y, width, height] in global screen points, top-left origin (Accessibility coordinates). */
export const Frame = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Frame = z.infer<typeof Frame>;

export const AppRef = z.object({
  pid: z.number().int(),
  bundleId: z.string(),
  name: z.string(),
});
export type AppRef = z.infer<typeof AppRef>;

export const WindowRef = z.object({
  /** Reader-assigned, stable for the life of the window: "<pid>-<n>". */
  windowId: z.string(),
  /** Window subrole plus normalized AXIdentifier, part of every element key. */
  kind: z.string(),
  title: z.string(),
  frame: Frame.nullable(),
});
export type WindowRef = z.infer<typeof WindowRef>;

/** Non-default states only. Enabled, unfocused and unselected are the defaults and are omitted. */
export const NodeState = z.enum(["focused", "selected", "disabled", "expanded", "checked", "secure"]);
export type NodeState = z.infer<typeof NodeState>;

export const Node = z.object({
  /** Caret's element key: app, window kind, named ancestors, role, normalized label, ordinal. */
  key: z.string(),
  /** Key of the nearest kept ancestor. Null for top-level nodes of the window. */
  parent: z.string().nullable(),
  role: z.string(),
  subrole: z.string().optional(),
  /** The element's name: title, description, title element text, or the text of static text. */
  label: z.string().optional(),
  /** String value. Omitted when equal to label, and never present for secure fields. */
  value: z.string().optional(),
  placeholder: z.string().optional(),
  frame: Frame.optional(),
  editable: z.literal(true).optional(),
  states: z.array(NodeState).optional(),
});
export type Node = z.infer<typeof Node>;

export const ValueKind = z.enum(["date", "time", "email", "phone", "url", "address", "amount", "id"]);
export type ValueKind = z.infer<typeof ValueKind>;

export const TypedValue = z.object({
  kind: ValueKind,
  /** The span exactly as it appears in the node's text. */
  text: z.string(),
  nodeKey: z.string(),
});
export type TypedValue = z.infer<typeof TypedValue>;

export const WalkReason = z.enum(["initial", "focus", "event", "leave", "background", "request"]);
export type WalkReason = z.infer<typeof WalkReason>;

export const Hello = z.object({
  type: z.literal("hello"),
  v: z.literal(PROTOCOL_VERSION),
  role: z.enum(["reader", "consumer"]),
  /** "shadow" makes the helper log opportunities and never call Jev or publish proposals. */
  mode: z.enum(["live", "shadow"]),
  pid: z.number().int(),
  version: z.string(),
});
export type Hello = z.infer<typeof Hello>;

export const Snapshot = z.object({
  type: z.literal("snapshot"),
  v: z.literal(PROTOCOL_VERSION),
  seq: z.number().int().nonnegative(),
  at: ms,
  reason: WalkReason,
  app: AppRef,
  window: WindowRef,
  /** True when this window is the focused window of the app the reader treats as active. */
  focused: z.boolean(),
  /**
   * Null for a full walk, which replaces the window. Otherwise the key of the subtree root:
   * the root and every node below it are replaced, everything else is kept.
   */
  root: z.string().nullable(),
  nodes: z.array(Node),
  /** Typed values found in these nodes. A partial snapshot carries only its subtree's values. */
  values: z.array(TypedValue),
  focusedKey: z.string().nullable(),
  stats: z.object({
    walkMs: z.number().nonnegative(),
    visited: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const Focus = z.object({
  type: z.literal("focus"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  app: AppRef,
  windowId: z.string(),
  /** Key of the focused element in the snapshot sent just before, or null if it was not kept. */
  key: z.string().nullable(),
  role: z.string(),
  editable: z.boolean(),
  empty: z.boolean(),
  /** False when the app is not frontmost and the reader watches it only by explicit flag. */
  frontmost: z.boolean(),
});
export type Focus = z.infer<typeof Focus>;

export const AppSwitch = z.object({
  type: z.literal("appSwitch"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  from: AppRef.nullable(),
  to: AppRef,
});
export type AppSwitch = z.infer<typeof AppSwitch>;

export const WindowClosed = z.object({
  type: z.literal("windowClosed"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  windowId: z.string(),
});
export type WindowClosed = z.infer<typeof WindowClosed>;

/** The general pasteboard's change count. Contents are never read. */
export const Pasteboard = z.object({
  type: z.literal("pasteboard"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  changeCount: z.number().int(),
});
export type Pasteboard = z.infer<typeof Pasteboard>;

/**
 * The helper asks the reader to act. `walk` re-reads one window and sends its snapshot. `write` and
 * `press` re-walk the window, find the element by key, check that it still has the expected role,
 * label and value, act, re-walk and send the new snapshot, then answer with a verbResult. They act
 * only on processes the reader was started with `--act-pids` for. `watchInput` names the processes
 * whose real key and mouse input the reader reports as userInput; an empty list stops reporting.
 */
export const ReaderCommand = z.object({
  type: z.literal("readerCommand"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  /**
   * After this time the reader must not act on the command: the helper has stopped waiting and
   * reported the step as failed. Checked immediately before the write or press.
   */
  expires: ms,
  verb: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("walk"), pid: z.number().int(), windowId: z.string() }),
    z.object({
      kind: z.literal("write"),
      pid: z.number().int(),
      windowId: z.string(),
      key: z.string(),
      role: z.string(),
      /** "value" sets AXValue; "focused" sets AXFocused to true and ignores `value`. */
      attribute: z.enum(["value", "focused"]),
      /** The value the field must hold right before the write; "" for empty. */
      expect: z.string(),
      value: z.string(),
    }),
    z.object({
      kind: z.literal("press"),
      pid: z.number().int(),
      windowId: z.string(),
      key: z.string(),
      role: z.string(),
      /** The label the element must still carry; the helper's risk check ran on this text. */
      label: z.string(),
    }),
    z.object({ kind: z.literal("watchInput"), pids: z.array(z.number().int()) }),
  ]),
});
export type ReaderCommand = z.infer<typeof ReaderCommand>;
export type ReaderVerb = ReaderCommand["verb"];

export const VerbOutcome = z.enum([
  "ok",
  /** The process is not one the reader may act on. */
  "notAllowed",
  "noWindow",
  "noElement",
  /** Role, label or value differed from what the helper expected. */
  "changed",
  "secure",
  /** The Accessibility call itself failed; `detail` holds its error code. */
  "axError",
]);
export type VerbOutcome = z.infer<typeof VerbOutcome>;

/** The reader's answer to one readerCommand. Any snapshot the verb produced was sent before it. */
export const VerbResult = z.object({
  type: z.literal("verbResult"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  at: ms,
  outcome: VerbOutcome,
  detail: z.string().nullable(),
});
export type VerbResult = z.infer<typeof VerbResult>;

/**
 * Real input in a watched process: no key codes, characters or text, only that it happened.
 * `point` is the mouse location for clicks, in the same coordinates as frames; null for keys.
 */
export const UserInput = z.object({
  type: z.literal("userInput"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  pid: z.number().int(),
  kind: z.enum(["key", "mouse"]),
  point: z.tuple([z.number(), z.number()]).nullable(),
});
export type UserInput = z.infer<typeof UserInput>;

export const ReaderMessage = z.discriminatedUnion("type", [Hello, Snapshot, Focus, AppSwitch, WindowClosed, Pasteboard, VerbResult, UserInput]);
export type ReaderMessage = z.infer<typeof ReaderMessage>;

/** Consumer asks for a fill proposal for the form around one field, without waiting for a focus event. */
export const FillRequest = z.object({
  type: z.literal("fillRequest"),
  v: z.literal(PROTOCOL_VERSION),
  windowId: z.string(),
  fieldKey: z.string(),
});
export type FillRequest = z.infer<typeof FillRequest>;

/** Runs a plan (executor/schema.ts) with its slots filled. Progress comes back as taskProgress. */
export const RunPlan = z.object({
  type: z.literal("runPlan"),
  v: z.literal(PROTOCOL_VERSION),
  taskId: z.string(),
  plan: z.unknown(),
  slots: z.record(z.string(), z.string()),
});
export type RunPlan = z.infer<typeof RunPlan>;

/** Continue a paused task, or restore everything a finished or stopped task wrote. */
export const TaskControl = z.object({
  type: z.literal("taskControl"),
  v: z.literal(PROTOCOL_VERSION),
  taskId: z.string(),
  action: z.enum(["resume", "undo"]),
});
export type TaskControl = z.infer<typeof TaskControl>;

// MARK: - patterns and memory (plan section 4)

export const OfferKind = z.enum([
  /** The next round of a loop, predicted after two rounds. */
  "loopNext",
  /** Every remaining round of a loop whose prediction the user took or typed. */
  "loopFinish",
  /** A learned routine, at the opening of its next occurrence. */
  "routine",
]);
export type OfferKind = z.infer<typeof OfferKind>;

/** Take runs the offer's plan through the executor; dontOfferHere also writes a visible rule. */
export const OfferControl = z.object({
  type: z.literal("offerControl"),
  v: z.literal(PROTOCOL_VERSION),
  offerId: z.string(),
  action: z.enum(["take", "dismiss", "dontOfferHere"]),
});
export type OfferControl = z.infer<typeof OfferControl>;

export const MemoryKind = z.enum(["about", "people", "preference", "routine", "permission"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

/**
 * List, edit, pause, resume or forget memory entries. `kind` narrows a list; `id` names the entry
 * for every other op; `fields` holds an edit's new values, checked against the entry's kind.
 */
export const MemoryRequest = z.object({
  type: z.literal("memoryRequest"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string(),
  op: z.enum(["list", "edit", "pause", "resume", "forget"]),
  id: z.string().optional(),
  kind: MemoryKind.optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});
export type MemoryRequest = z.infer<typeof MemoryRequest>;

export const ConsumerMessage = z.discriminatedUnion("type", [Hello, FillRequest, RunPlan, TaskControl, OfferControl, MemoryRequest]);
export type ConsumerMessage = z.infer<typeof ConsumerMessage>;

export const FillSource = z.object({
  windowId: z.string(),
  bundleId: z.string(),
  appName: z.string(),
  windowTitle: z.string(),
  nodeKey: z.string(),
  kind: ValueKind.nullable(),
});
export type FillSource = z.infer<typeof FillSource>;

/** One of the two independent asks behind a fill: what it picked, with ids mapped back to the first ask's numbering. */
export const FillAsk = z.object({
  choice: z.string(),
  confidence: z.number(),
  /** The picked candidate's text, or null for "none". */
  value: z.string().nullable(),
});
export type FillAsk = z.infer<typeof FillAsk>;

export const FillField = z.object({
  key: z.string(),
  /** Where the field is on screen, so a consumer can draw the proposed value in place. */
  frame: Frame.nullable(),
  descriptor: z.string(),
  /** The proposed candidate id, or "none" when the asks chose none or the proposal was withheld. */
  choice: z.string(),
  /** The lower of the two asks' confidences when they agree; 0 when they disagree. */
  confidence: z.number(),
  /** The chosen candidate's text, copied verbatim by code. Null when the choice is "none". */
  value: z.string().nullable(),
  source: FillSource.nullable(),
  /**
   * Why a value was not proposed although an ask picked one: the two asks picked different
   * candidates, or they agreed below the confidence cutoff. Null otherwise.
   */
  withheld: z.enum(["disagree", "lowConfidence"]).nullable(),
  /** The first ask, and the second with candidates shuffled and the field reworded. */
  asks: z.tuple([FillAsk, FillAsk]),
});
export type FillField = z.infer<typeof FillField>;

export const FillProposal = z.object({
  type: z.literal("fillProposal"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  at: ms,
  windowId: z.string(),
  bundleId: z.string(),
  /** The field whose focus (or request) produced this proposal. */
  triggerKey: z.string(),
  fields: z.array(FillField),
  candidates: z.number().int().nonnegative(),
  /** Both asks together: latency is the slower of the two parallel requests, tokens and cost are summed. */
  jev: z.object({
    model: z.string(),
    latencyMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
  /** The confidence an agreed choice had to reach to be proposed. */
  cutoff: z.number(),
});
export type FillProposal = z.infer<typeof FillProposal>;

export const HelperError = z.object({
  type: z.literal("error"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  message: z.string(),
});
export type HelperError = z.infer<typeof HelperError>;

export const TaskPhase = z.enum([
  /** The task started; `step` is null. */
  "started",
  /** The step's end state already held, so nothing was done. */
  "skipped",
  /** About to act; `detail` names the means and the predicted change. */
  "acting",
  /** The act happened and the observed change matched the prediction. */
  "verified",
  /** Real input in the target window paused the run before this step. */
  "paused",
  /** The step's target reads as send, submit, delete or pay; the run stops and the press is left to the user. */
  "handoff",
  /** A recheck, mismatch or failure stopped the run at this step; `detail` says why. */
  "stopped",
  /** Every end state holds. */
  "done",
  /** Undo finished; `detail` counts what was restored and what was not. */
  "undone",
]);
export type TaskPhase = z.infer<typeof TaskPhase>;

export const TaskProgress = z.object({
  type: z.literal("taskProgress"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  taskId: z.string(),
  planId: z.string(),
  phase: TaskPhase,
  /** Zero-based step index, or null for task-level phases. */
  step: z.number().int().nonnegative().nullable(),
  steps: z.number().int().nonnegative(),
  /** The step's end state as a sentence, for the steps block and the activity view. */
  says: z.string().nullable(),
  detail: z.string().nullable(),
});
export type TaskProgress = z.infer<typeof TaskProgress>;

/** One value an offer would write, copied verbatim by code from a live source and then changed only by memory rules. */
export const OfferCell = z.object({
  windowId: z.string(),
  key: z.string(),
  frame: Frame.nullable(),
  value: z.string(),
  source: z.object({ windowId: z.string(), nodeKey: z.string(), appName: z.string(), windowTitle: z.string() }),
  /** Memory entries that changed the source text into `value`. */
  memory: z.array(z.string()),
});
export type OfferCell = z.infer<typeof OfferCell>;

export const PatternOffer = z.object({
  type: z.literal("patternOffer"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  at: ms,
  kind: OfferKind,
  /** The loop or routine behind the offer. */
  patternId: z.string(),
  /** The offer as a sentence. */
  says: z.string(),
  windowId: z.string(),
  bundleId: z.string(),
  /** For loopNext, the cells shown as ghost values; for loopFinish and routine, every cell the plan writes. */
  cells: z.array(OfferCell),
  /** The gate's estimate that the offer is right, logged with the decision. See patterns/gate.ts. */
  showProbability: z.number(),
});
export type PatternOffer = z.infer<typeof PatternOffer>;

/**
 * The offer is no longer valid; a consumer removes it. `taken`: its values were entered, by Caret or by
 * the user typing them. `diverged`: the user entered something else. `idle`: the loop went quiet.
 * `stale`: a window it reads or writes closed, the reader restarted, or its memory entry was paused or forgotten.
 */
export const OfferWithdrawn = z.object({
  type: z.literal("offerWithdrawn"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  id: z.string(),
  reason: z.enum(["taken", "dismissed", "diverged", "idle", "stale"]),
});
export type OfferWithdrawn = z.infer<typeof OfferWithdrawn>;

export const MemoryStatus = z.enum(["learning", "active", "paused"]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

/** Action types from plan section 3, "Permission per action type". */
export const ActionType = z.enum(["read", "show", "writeHere", "writeElsewhere", "outbound", "destructive", "sensitive"]);
export type ActionType = z.infer<typeof ActionType>;
export const PermissionRule = z.enum(["act", "actIfApproved", "ask", "handoff"]);
export type PermissionRule = z.infer<typeof PermissionRule>;

export const AboutFields = z.object({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(500),
  source: z.enum(["contacts", "typed", "edit"]),
});
export const PeopleFields = z.object({ alias: z.string().min(1).max(80), name: z.string().min(1).max(200) });
export const PreferenceFields = z.discriminatedUnion("rule", [
  /** Digits of a value of this kind are written into `template`, each "#" taking one digit. */
  z.object({ rule: z.literal("format"), valueKind: z.literal("phone"), template: z.string() }),
  /** A field of this shape that would get a certain value gets the About-you entry `aboutId` instead. */
  z.object({ rule: z.literal("useInstead"), field: z.string(), aboutId: z.string() }),
  z.object({ rule: z.literal("dontOffer"), offerKind: OfferKind, bundleId: z.string(), appName: z.string() }),
]);
export const RoutineFields = z.object({
  srcApps: z.array(z.string()),
  dstApp: z.string(),
  steps: z.number().int().positive(),
  /** Set by a person, or later by a background model; the routine itself is the typed steps. */
  name: z.string().nullable(),
  /** Silent predictions scored against what the user then did. */
  silent: z.object({ hits: z.number().int().nonnegative(), misses: z.number().int().nonnegative() }),
});
export const PermissionFields = z.object({ action: ActionType, rule: PermissionRule, fixed: z.boolean() });

const entryBase = {
  id: z.string(),
  status: MemoryStatus,
  /** The entry as a sentence, rendered by code from its fields. */
  says: z.string(),
  evidence: z.object({ count: z.number().int().nonnegative(), lastSeen: ms, app: z.string().nullable() }),
};
export const MemoryEntry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("about"), ...entryBase, fields: AboutFields }),
  z.object({ kind: z.literal("people"), ...entryBase, fields: PeopleFields }),
  z.object({ kind: z.literal("preference"), ...entryBase, fields: PreferenceFields }),
  z.object({ kind: z.literal("routine"), ...entryBase, fields: RoutineFields }),
  z.object({ kind: z.literal("permission"), ...entryBase, fields: PermissionFields }),
]);
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const MemoryReply = z.object({
  type: z.literal("memoryReply"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string(),
  /** Null on success; otherwise what was wrong with the request. */
  error: z.string().nullable(),
  /** For list, the entries; for every other op, the entry after the change, or none after forget. */
  entries: z.array(MemoryEntry),
});
export type MemoryReply = z.infer<typeof MemoryReply>;

export const HelperMessage = z.discriminatedUnion("type", [FillProposal, HelperError, TaskProgress, PatternOffer, OfferWithdrawn, MemoryReply]);
/** What the helper sends the reader. */
export const HelperToReader = z.discriminatedUnion("type", [ReaderCommand]);
export type HelperMessage = z.infer<typeof HelperMessage>;

/** Every message that may appear on the socket in either direction. */
export const AnyMessage = z.union([ReaderMessage, ConsumerMessage, HelperMessage, HelperToReader]);
export type AnyMessage = z.infer<typeof AnyMessage>;
