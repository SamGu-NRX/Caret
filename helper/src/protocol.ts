// Wire protocol between caret-screen (the Swift reader), this helper, and consumers
// such as the host app. One NDJSON message per line over ~/.caret-run/sockets/screen.sock.
// These zod schemas are the single source of truth: `pnpm schema` exports them to
// schemas/screen-protocol.schema.json, and the Swift side decodes the golden fixture
// in fixtures/golden/ in its own tests.
import * as z from "zod";
import { ActionBar, CheckedValue, PopupSpec } from "./popup.ts";

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

/** `watch` is a re-read of a window under a pending-state watch, on its notifications or every 10 s. */
export const WalkReason = z.enum(["initial", "focus", "event", "leave", "background", "request", "watch"]);
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
 * `watchWindows` replaces the set of windows under a pending-state watch: the reader re-reads each
 * when the app posts a notification about it and every 10 s, as `watch` walks that send a snapshot
 * only when something changed. An empty list ends every watch. It only reads, so it needs no `--act-pids`.
 * `raise` brings one window to the front and activates its app (AXRaise, then activation), re-walks it
 * and sends the snapshot; it writes nothing, but it moves focus, so it too needs `--act-pids`.
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
    z.object({ kind: z.literal("watchWindows"), windows: z.array(z.object({ pid: z.number().int(), windowId: z.string() })) }),
    z.object({ kind: z.literal("raise"), pid: z.number().int(), windowId: z.string() }),
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

/**
 * Controls one task in the activity feed. `pause` stops a run at its next step boundary, before the
 * next act; `resume` continues a paused run or watch; `stop` ends it there for good (state failed,
 * cause you); `takeOver` pauses like `pause` and hands the run back to the user, and its activity
 * record names the step it reached and the steps that remain. `undo` restores everything a finished,
 * stopped or paused run wrote. A watch takes pause, resume and stop only.
 */
export const TaskControl = z.object({
  type: z.literal("taskControl"),
  v: z.literal(PROTOCOL_VERSION),
  taskId: z.string(),
  action: z.enum(["pause", "resume", "stop", "takeOver", "undo"]),
  /**
   * Why the host paused: `input` when it saw the user's own input in the task's window. The pause then
   * keeps the reader's wording ("typing in 'Claim form'") when the reader reported that input too.
   * Only with `pause`.
   */
  reason: z.enum(["input"]).optional(),
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

/**
 * The host's report on one field of a fill proposal: what it did with the proposed value and how.
 * `inserted` marks the matching transfer as Caret's; `undone` removes that transfer from the log again.
 */
export const FillResult = z.object({
  type: z.literal("fillResult"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  proposalId: z.string(),
  windowId: z.string(),
  fieldKey: z.string(),
  outcome: z.enum(["inserted", "rejected", "failed", "undone", "undoFailed"]),
  reason: z.string().nullable(),
  method: z.enum(["pastePid", "axSelectedText", "axValue"]).nullable(),
  valueLength: z.number().int().nonnegative(),
});
export type FillResult = z.infer<typeof FillResult>;

/** `list` returns every task record; `since` returns the activity messages after sequence number `since`. */
export const ActivityRequest = z.object({
  type: z.literal("activityRequest"),
  v: z.literal(PROTOCOL_VERSION),
  /** Echoed in the reply, whose size is capped, so it is short. */
  requestId: z.string().min(1).max(200),
  op: z.enum(["list", "since"]),
  since: z.number().int().nonnegative().optional(),
});
export type ActivityRequest = z.infer<typeof ActivityRequest>;

// MARK: - offers to the host (plan section 2): alternatives, action lines and pop-ups

/**
 * The field an offer belongs to. The host shows an offer only while this field has focus, and matches
 * it by frame, since it cannot recompute the reader's element keys.
 */
export const OfferField = z.object({
  pid: z.number().int(),
  windowId: z.string(),
  /** The reader's element key. */
  key: z.string(),
  frame: Frame.nullable(),
});
export type OfferField = z.infer<typeof OfferField>;

/**
 * Values for the focused field, best first: the top one shows faintly at the caret, the arrows reveal
 * the rest, Tab inserts the one shown. The host inserts the text itself; the helper sees it arrive as a
 * transfer, so there is no offerAccept for alternatives. `quoted`: the top value is quoted from a
 * source on screen, so it carries the uneven underline while collapsed.
 */
export const OfferAlternatives = z.object({
  type: z.literal("alternatives"),
  v: z.literal(PROTOCOL_VERSION),
  offerKey: z.string(),
  at: ms,
  field: OfferField,
  candidates: z.array(CheckedValue).min(1).max(3),
  quoted: z.boolean(),
});
export type OfferAlternatives = z.infer<typeof OfferAlternatives>;

/**
 * One action in another app, as a line: "Calendar  Coffee with Dana, Thu 3:00 to 3:30  Tab". `endState`
 * is the work's result in one sentence. `actions` follow the rules of a pop-up's actions block, with a
 * Tab action. `variants` is what the down arrow opens.
 */
export const OfferAction = z.object({
  type: z.literal("action"),
  v: z.literal(PROTOCOL_VERSION),
  offerKey: z.string(),
  at: ms,
  field: OfferField,
  /** The app the action happens in, as the line names it. */
  app: z.string().min(1),
  endState: CheckedValue,
  actions: ActionBar,
  variants: PopupSpec.optional(),
});
export type OfferAction = z.infer<typeof OfferAction>;

/** Help bigger than a sentence: a validated PopupSpec (popup.ts). */
export const OfferPopup = z.object({
  type: z.literal("popup"),
  v: z.literal(PROTOCOL_VERSION),
  offerKey: z.string(),
  at: ms,
  field: OfferField,
  spec: PopupSpec,
});
export type OfferPopup = z.infer<typeof OfferPopup>;

/**
 * The user took an action of an action line or pop-up. `overrides` holds the rows the user picked
 * first: the highlighted row of a choices block by the block's id (`choices` when it has none), or
 * `variants` for an action line's picker, zero-based. The work runs as a task whose id is `offerId`,
 * so its taskProgress and activity messages carry that id, and the last taskProgress (done, stopped
 * or handoff) ends the host's working line.
 */
export const OfferAccept = z.object({
  type: z.literal("offerAccept"),
  v: z.literal(PROTOCOL_VERSION),
  offerId: z.string(),
  actionId: z.string(),
  overrides: z.record(z.string(), z.number().int().nonnegative()),
  at: ms,
});
export type OfferAccept = z.infer<typeof OfferAccept>;

/** Esc on running work: the same as taskControl stop for the task the offer started. */
export const OfferStop = z.object({
  type: z.literal("offerStop"),
  v: z.literal(PROTOCOL_VERSION),
  offerId: z.string(),
  at: ms,
});
export type OfferStop = z.infer<typeof OfferStop>;

export const ConsumerMessage = z.discriminatedUnion("type", [Hello, FillRequest, RunPlan, TaskControl, OfferControl, MemoryRequest, FillResult, ActivityRequest, OfferAccept, OfferStop]);
export type ConsumerMessage = z.infer<typeof ConsumerMessage>;

export const FillSource = z.object({
  pid: z.number().int(),
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
  /** The process that owns the form's window. */
  pid: z.number().int(),
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
 * the user typing them, or the user went to the window it offered to open. `diverged`: the user entered
 * something else. `idle`: no longer sent; lifetimes replaced it. `stale`: a window it reads or writes
 * closed or changed, the reader restarted, or its memory entry was paused or forgotten. `expired`: its
 * lifetime ended (offers/lifetimes.ts). `id` is a patternOffer's id, or the offerKey of an
 * alternatives, action or popup message.
 */
export const OfferWithdrawn = z.object({
  type: z.literal("offerWithdrawn"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  id: z.string(),
  reason: z.enum(["taken", "dismissed", "diverged", "idle", "stale", "expired"]),
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

// MARK: - tasks and the activity feed (plan section 3, "Reporting")

/**
 * Where a piece of Caret's work stands. `preparing`: Caret is building it before anyone asked.
 * `ready`: prepared and offered, waiting to be taken. `running`: acting, or watching a window.
 * `paused`: stopped at a step boundary and resumable. `needsYou`: the user has to act (a hand-off, or a
 * watched window waiting on them). `done`: every end state holds, or the watched work finished.
 * `failed`: it ended without reaching its end state; `cause` says who ended it. `undone`: what it
 * wrote was restored, or an offer was withdrawn before it ran, so nothing of it stands.
 */
export const TaskState = z.enum(["preparing", "ready", "running", "paused", "needsYou", "done", "failed", "undone"]);
export type TaskState = z.infer<typeof TaskState>;
/** Who caused the latest transition: Caret's own judgment, the user (a control, or real input), or the screen (a window closed or changed). */
export const TaskCause = z.enum(["caret", "you", "screen"]);
export type TaskCause = z.infer<typeof TaskCause>;
/** `plan` is a runPlan or a taken loopNext; `loopFinish` and `routine` start as ready offers; `watch` is a pending-state watch. */
export const TaskKind = z.enum(["plan", "loopFinish", "routine", "watch"]);
export type TaskKind = z.infer<typeof TaskKind>;

/** One of Jev's two pending answers, as chosen. */
export const PendingAnswer = z.object({ choice: z.string(), confidence: z.number() });

export const PendingInfo = z.object({
  /** The line that marked the window as unfinished when the user left it: a status text, or the indicator's role. */
  markedBy: z.string(),
  /** The first line that differs from what the window showed when the watch began; null before any change. */
  status: z.string().nullable(),
  /** Has the work finished: yes, failed or no. Null until the window first changes. */
  finished: PendingAnswer.nullable(),
  /** Is the window waiting on the user: yes or no. */
  waiting: PendingAnswer.nullable(),
  /** Jev requests made for this watch so far. */
  asks: z.number().int().nonnegative(),
});
export type PendingInfo = z.infer<typeof PendingInfo>;

export const TaskRecord = z.object({
  /** The taskId of a run, the offer id of a loopFinish or routine (taking it runs under the same id), or `watch-…`. */
  id: z.string(),
  kind: TaskKind,
  state: TaskState,
  cause: TaskCause.nullable(),
  /** The work as a sentence: the plan's title, the offer's sentence, or what is being watched. */
  says: z.string(),
  app: AppRef.nullable(),
  windowId: z.string().nullable(),
  windowTitle: z.string().nullable(),
  /**
   * The task window's frame, read when the record was made and on each change of state or step, so the
   * host can find the window without matching its title. Null when the task has no window yet or the
   * reader read no frame.
   */
  frame: Frame.nullable(),
  /** Zero-based index of the step the run is at, or stopped or paused before. Null for watches and before the first step. */
  step: z.number().int().nonnegative().nullable(),
  steps: z.number().int().nonnegative().nullable(),
  /** The current step's end state as a sentence. */
  stepSays: z.string().nullable(),
  /** End states not yet reached, from `step` on, so a paused or taken-over row can say what remains. */
  remaining: z.array(z.string()),
  detail: z.string().nullable(),
  /** True while the run has writes undo could restore. */
  undoable: z.boolean(),
  startedAt: ms,
  updatedAt: ms,
  pending: PendingInfo.nullable(),
});
export type TaskRecord = z.infer<typeof TaskRecord>;

/** Sent to every consumer on each transition, and on step changes of a running task. `seq` rises by one per message. */
export const Activity = z.object({
  type: z.literal("activity"),
  v: z.literal(PROTOCOL_VERSION),
  seq: z.number().int().positive(),
  at: ms,
  /** The state before this message; null when the record is new. Equal to `task.state` for a step change. */
  from: TaskState.nullable(),
  task: TaskRecord,
});
export type Activity = z.infer<typeof Activity>;

/**
 * Sent to the asking consumer only. `seq` is the latest activity sequence number. `list` fills `tasks`,
 * newest first; `since` fills `events`, oldest first. Either stops before the reply would pass 1 MiB
 * (tasks/registry.ts MAX_REPLY_BYTES). `truncated` means the reply is incomplete: for `list`, the oldest
 * records were left out; for `since`, events after `since` were dropped from the helper's buffer or left
 * out, so the consumer must `list` instead.
 */
export const ActivityReply = z.object({
  type: z.literal("activityReply"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string(),
  error: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  tasks: z.array(TaskRecord),
  events: z.array(Activity),
  truncated: z.boolean(),
});
export type ActivityReply = z.infer<typeof ActivityReply>;

export const HelperMessage = z.discriminatedUnion("type", [
  FillProposal, HelperError, TaskProgress, PatternOffer, OfferWithdrawn, MemoryReply, Activity, ActivityReply, OfferAlternatives, OfferAction, OfferPopup,
]);
/** The messages that put something on screen at the caret; each is checked against HelperMessage before it is published. */
export const HOST_OFFER_TYPES: ReadonlySet<string> = new Set(["alternatives", "action", "popup"]);
/** What the helper sends the reader. */
export const HelperToReader = z.discriminatedUnion("type", [ReaderCommand]);
export type HelperMessage = z.infer<typeof HelperMessage>;

/** Every message that may appear on the socket in either direction. */
export const AnyMessage = z.union([ReaderMessage, ConsumerMessage, HelperMessage, HelperToReader]);
export type AnyMessage = z.infer<typeof AnyMessage>;
