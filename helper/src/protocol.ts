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
  /** The window server's number (CGWindowID), read once per window; absent when the app gave none. */
  number: z.number().int().positive().optional(),
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
 * only under a live act grant (ActGrant) for the command's `taskId`, process and window, or in a
 * process the reader was started with `--act-pids` for (tests). `watchInput` names the processes
 * whose real key and mouse input the reader reports as userInput; an empty list stops reporting.
 * `watchWindows` replaces the set of windows under a pending-state watch: the reader re-reads each
 * when the app posts a notification about it and every 10 s, as `watch` walks that send a snapshot
 * only when something changed. An empty list ends every watch. It only reads, so it needs no `--act-pids`.
 * `raise` brings one window to the front and activates its app (AXRaise, then activation), re-walks it
 * and sends the snapshot; it writes nothing, but it moves focus, so it is gated like write and press.
 * The calendar verbs (B16) reach EventKit, which needs a native process. The reader answers them only when
 * started with --calendar-test, and then only in calendars it created itself on a local (On My Mac)
 * source, which `calendarDispose` deletes. A write (add, remove, dispose) names its task and needs that
 * task's live CalendarGrant, checked right before the write. It never asks for Calendar access: without
 * it, or without a local source, the answer is `blocked`.
 */
/** One event in a calendar, as the calendar verbs name it: times are ISO 8601 with offset. */
const CalendarSlot = { calendar: z.string().min(1), title: z.string(), start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) };
export const CalendarEventShape = z.object({ id: z.string().min(1), ...CalendarSlot });
/** Why the reader's calendar refused: no Calendar access (it never asks), or no local source to create its calendar on. */
export const CalendarBlock = z.enum(["tcc", "noLocalSource"]);
export type CalendarBlock = z.infer<typeof CalendarBlock>;

/** The task whose act grant covers a write, press or raise. Without it only `--act-pids` processes are acted in. */
const GrantTask = z.string().min(1).optional();
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
      /**
       * "value" sets AXValue. "focused" sets AXFocused to true and ignores `value`. "insert" focuses the
       * field, selects all of its text and replaces the selection with `value`, as typing over it would:
       * the executor's fallback when an app answers a value write with success and changes nothing (B15).
       */
      attribute: z.enum(["value", "focused", "insert"]),
      /** The value the field must hold right before the write; "" for empty. */
      expect: z.string(),
      value: z.string(),
      taskId: GrantTask,
    }),
    z.object({
      kind: z.literal("press"),
      pid: z.number().int(),
      windowId: z.string(),
      key: z.string(),
      role: z.string(),
      /** The label the element must still carry; the helper's risk check ran on this text. */
      label: z.string(),
      taskId: GrantTask,
    }),
    z.object({ kind: z.literal("watchInput"), pids: z.array(z.number().int()) }),
    z.object({ kind: z.literal("watchWindows"), windows: z.array(z.object({ pid: z.number().int(), windowId: z.string() })) }),
    z.object({ kind: z.literal("raise"), pid: z.number().int(), windowId: z.string(), taskId: GrantTask }),
    /** The event with this title, start and end in the reader's calendar of this name, if any. */
    z.object({ kind: z.literal("calendarFind"), ...CalendarSlot }),
    /** Adds the event, creating the calendar on a local source first if the reader has not yet; an identical event already there is returned instead. */
    z.object({ kind: z.literal("calendarAdd"), ...CalendarSlot, taskId: z.string().min(1) }),
    /** One event by id, only if it is one the reader added. */
    z.object({ kind: z.literal("calendarGet"), id: z.string().min(1) }),
    /** Removes an event by id, only one the reader added. */
    z.object({ kind: z.literal("calendarRemove"), id: z.string().min(1), taskId: z.string().min(1) }),
    /** Deletes the calendar of this name the reader created, with its events. Nothing else is touched. */
    z.object({ kind: z.literal("calendarDispose"), calendar: z.string().min(1), taskId: z.string().min(1) }),
  ]),
});
export type ReaderCommand = z.infer<typeof ReaderCommand>;
export type ReaderVerb = ReaderCommand["verb"];
export type CalendarVerb = Extract<ReaderVerb, { kind: "calendarFind" | "calendarAdd" | "calendarGet" | "calendarRemove" | "calendarDispose" }>;
const CALENDAR_VERBS: ReadonlySet<string> = new Set(["calendarFind", "calendarAdd", "calendarGet", "calendarRemove", "calendarDispose"]);
/** A verb for the reader's calendar adapter rather than an app's window. */
export function isCalendarVerb(v: ReaderVerb): v is CalendarVerb {
  return CALENDAR_VERBS.has(v.kind);
}

/**
 * Longest an act grant lasts after the reader receives it, whatever its `expires` says. Assumed, not
 * tuned (brief B15). The slowest of B2's 100 fixture runs took 2.5 s (executor run-4), so 120 s leaves
 * wide room on a loaded Mac, and a grant the helper never revokes still ends on its own.
 */
export const GRANT_MAX_MS = 120_000;

/**
 * Lets the reader act for one task in one window of one process until `expires`, at most GRANT_MAX_MS
 * after `at`. The helper sends it when an accepted offer starts the task, and again when the user
 * resumes or undoes that task; never for a consumer's runPlan. A later grant for the same task replaces
 * the earlier one. The reader drops every grant when its connection to the helper closes.
 */
export const ActGrant = z
  .object({
    type: z.literal("actGrant"),
    v: z.literal(PROTOCOL_VERSION),
    taskId: z.string().min(1),
    pid: z.number().int(),
    windowId: z.string().min(1),
    at: ms,
    expires: ms,
  })
  .refine((g) => g.expires > g.at && g.expires - g.at <= GRANT_MAX_MS, {
    message: `expires must be after at and at most ${GRANT_MAX_MS} ms after it`,
    path: ["expires"],
  });
export type ActGrant = z.infer<typeof ActGrant>;

/**
 * Lets the reader write to its calendars for one task until `expires`, at most GRANT_MAX_MS after `at`.
 * The helper sends it only for a task from an accepted offer, before the task's first calendar write and
 * again for its undo; the task's actRevoke ends it with the act grant.
 */
export const CalendarGrant = z
  .object({ type: z.literal("calendarGrant"), v: z.literal(PROTOCOL_VERSION), taskId: z.string().min(1), at: ms, expires: ms })
  .refine((g) => g.expires > g.at && g.expires - g.at <= GRANT_MAX_MS, { message: `expires must be after at and at most ${GRANT_MAX_MS} ms after it`, path: ["expires"] });
export type CalendarGrant = z.infer<typeof CalendarGrant>;

/** Ends a task's act grant and calendar grant: the run finished, paused, was stopped or taken over, or its undo finished. */
export const ActRevoke = z.object({
  type: z.literal("actRevoke"),
  v: z.literal(PROTOCOL_VERSION),
  taskId: z.string().min(1),
  at: ms,
});
export type ActRevoke = z.infer<typeof ActRevoke>;

export const VerbOutcome = z.enum([
  "ok",
  /** No live act grant covers this task, process and window, and the process is not in `--act-pids`; `detail` says which. */
  "notAllowed",
  "noWindow",
  "noElement",
  /** Role, label or value differed from what the helper expected. */
  "changed",
  "secure",
  /** The Accessibility call itself failed; `detail` holds its error code. */
  "axError",
  /** A calendar verb the reader may not carry out here; `blocked` says why. */
  "blocked",
]);
export type VerbOutcome = z.infer<typeof VerbOutcome>;

/**
 * The reader's answer to one readerCommand. Any snapshot the verb produced was sent before it. A calendar
 * verb's answer carries the event it found, added or got (absent when there is none); `blocked` comes
 * with outcome `blocked` and no other.
 */
export const VerbResult = z
  .object({
    type: z.literal("verbResult"),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string(),
    at: ms,
    outcome: VerbOutcome,
    detail: z.string().nullable(),
    event: CalendarEventShape.optional(),
    blocked: CalendarBlock.optional(),
  })
  .refine((r) => (r.outcome === "blocked") === (r.blocked !== undefined), { message: "blocked comes with outcome blocked, and blocked needs it", path: ["blocked"] });
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

/** `skill` (B19): a routine the user chose to keep, with its name, trigger and run counts. */
export const MemoryKind = z.enum(["about", "people", "preference", "routine", "permission", "skill"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const MemoryOp = z.enum(["list", "edit", "pause", "resume", "forget", "add"]);
export type MemoryOp = z.infer<typeof MemoryOp>;

/**
 * List, edit, pause, resume, forget or add memory entries. `kind` narrows a list; `id` names the entry
 * for edit, pause, resume and forget; `fields` holds an edit's new values, checked against the entry's
 * kind. `add` keeps a value the user typed into Caret (the host's onboarding asks for a name and an
 * email): `kind` "about", `fields` {label, value, source: "typed"}, and no `id`. A second add with the
 * same label replaces that entry's value. The host's contract for it is
 * apps/caret/Tests/CaretHostCoreTests/Fixtures/memory.ndjson on v2/host, copied byte for byte into
 * fixtures/golden/memory.ndjson.
 */
export const MemoryRequest = z.object({
  type: z.literal("memoryRequest"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string(),
  op: MemoryOp,
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
  /**
   * The field's window as the host can check it, so two identical windows are not confused by frame:
   * the window server's number (null when the reader could not read one) and the title when offered.
   */
  window: z.object({ number: z.number().int().positive().nullable(), title: z.string() }),
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
  /** A grounded fill's source apps, each once, in the order of the fields they fill; absent for other pop-ups. */
  sourceApps: z.array(z.string().min(1)).min(1).refine((a) => new Set(a).size === a.length, "sourceApps repeats an app").optional(),
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

// MARK: - the user's settings (host to helper)

/**
 * What Caret helps with, as the host's onboarding and menu bar name it (CaretRole on v2/host). `fill` is
 * grounded fill, `repeat` loops and routines, `watch` the pending-state watch, `calendar` the event card
 * (B16; v2/host's CaretRole does not list it yet, so a host that sends its own roles turns it off),
 * `words` the host's own
 * ghost text, which the helper accepts and ignores.
 */
export const SettingsRole = z.enum(["fill", "repeat", "watch", "calendar", "words"]);
export type SettingsRole = z.infer<typeof SettingsRole>;
/** How often Caret speaks up. The helper's gate reads it from offers/settings.ts LEVELS. */
export const SettingsLevel = z.enum(["quiet", "balanced", "eager"]);
export type SettingsLevel = z.infer<typeof SettingsLevel>;

/**
 * The user's settings, sent by the host on connect and on every change. The helper's gate applies them
 * to its next decision: paused holds every offer and withdraws those shown (reason `settings`), a role
 * left out disables its producers and withdraws their offers, and the level sets the hourly budget and
 * which families may speak. Roles are listed once each.
 */
export const Settings = z.object({
  type: z.literal("settings"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  roles: z.array(SettingsRole).refine((r) => new Set(r).size === r.length, "roles lists a role twice"),
  level: SettingsLevel,
  paused: z.boolean(),
});
export type Settings = z.infer<typeof Settings>;

// MARK: - the first look (host's contract: CaretHostCore/FirstLook.swift and first-look.ndjson on v2/host)

/**
 * At the end of onboarding the host asks for the best real offer across the windows already open. The
 * helper walks every window once, runs each named family's generator once, and answers within
 * `deadlineMs` with `firstLookReply`, to the asker only. `families` is checked by the helper rather than
 * here, so an unknown name is answered as an error reply the host is waiting for, not a bare error.
 */
export const FirstLook = z.object({
  type: z.literal("firstLook"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1),
  at: ms,
  families: z.array(z.string()),
  level: SettingsLevel,
  deadlineMs: z.number().int().positive(),
});
export type FirstLook = z.infer<typeof FirstLook>;

/**
 * The user asked Caret to do something. The helper plans it against the screen model and memory and
 * answers with `planProposal`, to the asker only. `windowId` is the window the user means, when the host
 * knows it (the one they were in when they asked); without it Caret picks among the open windows.
 */
export const PlanRequest = z.object({
  type: z.literal("planRequest"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).max(200),
  at: ms,
  instruction: z.string().min(1).max(500),
  windowId: z.string().min(1).optional(),
});
export type PlanRequest = z.infer<typeof PlanRequest>;

/**
 * The user's answer to a skillOffer (B19), by the offer's `id`. The helper ends the offer with
 * offerWithdrawn: `taken` after accept, `dismissed` after decline. An answer to an offer that is gone
 * (expired, answered, or never made) is refused with an error and changes nothing.
 */
export const SkillAnswer = z.object({
  type: z.literal("skillAnswer"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  answer: z.enum(["accept", "decline"]),
  at: ms,
});
export type SkillAnswer = z.infer<typeof SkillAnswer>;

export const ConsumerMessage = z.discriminatedUnion("type", [Hello, FillRequest, RunPlan, TaskControl, OfferControl, MemoryRequest, FillResult, ActivityRequest, OfferAccept, OfferStop, Settings, FirstLook, PlanRequest, SkillAnswer]);
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

/**
 * A value that came from memory rather than a window: an About entry the user typed into Caret (B17,
 * fill/about.ts). `says` is the source line after "from": "what you told Caret".
 */
export const FillMemory = z.object({ id: z.string().min(1), label: z.string(), says: z.string() });
export type FillMemory = z.infer<typeof FillMemory>;

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
  /** The window the value was copied from. Null when there is no value, or when it came from memory. */
  source: FillSource.nullable(),
  /**
   * The memory entry the value came from, when it came from one; null otherwise. A value has exactly one
   * of `source` and `memory`. A line from a helper before B17 has no key, which reads as null. A host that reads only `source` finds none here and offers nothing, which
   * is safe; offering it needs the host to name "what you told Caret" and to skip its source-window check.
   */
  memory: FillMemory.nullable().default(null),
  /**
   * Why no value was proposed although one might have been: the two asks picked different candidates,
   * they agreed below the confidence cutoff (for a value from memory, also when the asks did not both say,
   * at WHOSE_CUTOFF or above, that the field wants the user's own details), or a window's privacy budget cut a value of the kind the
   * field takes or the asks picked ("sourceCut", fill.ts), so the candidates of that kind were a partial
   * set. Null otherwise.
   */
  withheld: z.enum(["disagree", "lowConfidence", "sourceCut"]).nullable(),
  /**
   * The first ask, and the second with candidates shuffled and the field reworded. Empty when the field
   * was not asked: withheld as "sourceCut" before any ask, or, with `withheld` null, nothing could be
   * offered for it (no window gave a candidate, and nothing the user told Caret fits it).
   */
  asks: z.union([z.tuple([FillAsk, FillAsk]), z.tuple([])]),
}).refine((f) => (f.value === null ? f.source === null && f.memory === null : (f.source === null) !== (f.memory === null)), {
  message: "a value comes with exactly one of source and memory, and no value with neither",
  path: ["memory"],
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
  /**
   * The confidence an agreed choice of a window's value had to reach to be proposed. A value from memory
   * is held to fill.ts MEMORY_CUTOFF and its whose-details answers to WHOSE_CUTOFF instead (B18).
   */
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

/**
 * Why a run stopped, for the host to name the stop without reading `detail`, which is a sentence for
 * people. "you": the user stopped it. "changed": the screen changed under the run, such as a field typed
 * into since the plan started, or one the step did not target changing while it acted. "sheet": a sheet
 * covers the window. "windowGone": the window closed, or no window matches. "ambiguous": several
 * windows match. "readerRestarted": a new reader session, so the run's window ids no longer apply.
 * "reader": the reader refused a verb, could not re-read a window, or cannot watch for input.
 * "mismatch": after Caret acted, the step's end state does not hold. "unreachable": no means to reach the
 * target, or the target was not found. "notConfigured": the step needs a URL opener or a calendar the
 * helper does not have. "refused": the helper refused an offer's accept (gone, expired, or already run).
 * "error": anything else that ended the run.
 */
export const StopReason = z.enum(["you", "changed", "sheet", "windowGone", "ambiguous", "readerRestarted", "reader", "mismatch", "unreachable", "notConfigured", "refused", "error"]);
export type StopReason = z.infer<typeof StopReason>;

const TaskProgressFields = z.object({
  type: z.literal("taskProgress"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  taskId: z.string(),
  planId: z.string(),
  /** Zero-based step index, or null for task-level phases. */
  step: z.number().int().nonnegative().nullable(),
  steps: z.number().int().nonnegative(),
  /** The step's end state as a sentence, for the steps block and the activity view. */
  says: z.string().nullable(),
  detail: z.string().nullable(),
  /** On `done` only: the fields the run wrote, each counted once. */
  written: z.number().int().nonnegative().optional(),
  /** On `undone` only: the writes and events restored, those left as they were, and presses, which no undo reverses. `detail` says the same in words. */
  restored: z.number().int().nonnegative().optional(),
  notRestored: z.number().int().nonnegative().optional(),
  notUndoablePresses: z.number().int().nonnegative().optional(),
  /**
   * B19: true on every progress of a run a skill started from its trigger without a Tab, because the
   * user agreed to let it run on its own. The host shows such a run with its progress, a toast, undo and
   * take over. Absent on every other run.
   */
  unprompted: z.literal(true).optional(),
});
/**
 * A stopped progress says why in `stopReason`, and no other phase may carry one. A hand-off may say
 * `blocked` (B16): the calendar step needs something only the user can give, Calendar access or a local
 * calendar account. Variants on the phase rather than refinements, so the exported JSON Schema states
 * the rules too.
 */
export const TaskProgress = z.discriminatedUnion("phase", [
  TaskProgressFields.extend({ phase: TaskPhase.exclude(["stopped", "handoff"]), stopReason: z.never().optional(), blocked: z.never().optional() }),
  TaskProgressFields.extend({ phase: z.literal("handoff"), stopReason: z.never().optional(), blocked: CalendarBlock.optional() }),
  /** The activity record of the same stop says "failed". */
  TaskProgressFields.extend({ phase: z.literal("stopped"), stopReason: StopReason, blocked: z.never().optional() }),
]);
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
 * lifetime ended (offers/lifetimes.ts). `reoffered`: the user entered some of a loopFinish's or
 * routine's values by hand, and the rest are offered again under the key in `replacedBy`, which comes
 * with this reason and no other. `settings`: the user paused Caret, or turned off the role or level
 * that allows this kind of offer. `id` is a patternOffer's id, the offerKey of an alternatives,
 * action or popup message, or a skillOffer's id (B19: `taken` after accept, `dismissed` after decline).
 */
export const OfferWithdrawn = z
  .object({
    type: z.literal("offerWithdrawn"),
    v: z.literal(PROTOCOL_VERSION),
    at: ms,
    id: z.string(),
    reason: z.enum(["taken", "dismissed", "diverged", "idle", "stale", "expired", "reoffered", "settings"]),
    replacedBy: z.string().min(1).optional(),
  })
  .refine((m) => (m.reason === "reoffered") === (m.replacedBy !== undefined), {
    message: "replacedBy comes with reason reoffered, and reoffered needs it",
    path: ["replacedBy"],
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

/** The risk classes a press can have (executor/risk.ts), as a skill's hand-off names them. */
export const PressRisk = z.enum(["outbound", "destructive", "money"]);
export type PressRisk = z.infer<typeof PressRisk>;

/**
 * A routine the user kept (B19). Code renders every string from the routine's structure: `name` passed
 * the naming check (patterns/naming.ts: at most six words, names the destination app or a field, holds
 * no value seen in the routine) or the user typed it.
 */
export const SkillFields = z.object({
  routineId: z.string().min(1),
  name: z.string().min(1).max(80),
  /** When Caret offers it, as a clause: "a Tracker window opens with Order, Carrier and Tracking empty". */
  trigger: z.string().min(1),
  /** Caret's runs of the skill since it was kept. */
  runs: z.number().int().nonnegative(),
  /** Verified clean runs in a row since the last failure, mismatch, undo or take over. */
  cleanRuns: z.number().int().nonnegative(),
  /** Clean runs in a row before Caret offers to run it without a Tab. */
  needed: z.number().int().positive(),
  /** The user agreed: a run starts from the trigger without a Tab, with progress, a toast, undo and take over. */
  onItsOwn: z.boolean(),
  /** A press the skill always leaves to the user, such as Send. A skill with one is never run on its own. */
  handsOff: z.object({ label: z.string().min(1), why: PressRisk }).nullable(),
});

/** How a use of a permission ended: done; handed off to the user; stopped partway; or tried and failed. */
export const UseOutcome = z.enum(["done", "handedOff", "stopped", "failed"]);
export type UseOutcome = z.infer<typeof UseOutcome>;
/** Uses each permission keeps, newest first; older ones are deleted. The host shows them all (A11). */
export const MAX_PERMISSION_USES = 5;

/**
 * One use of a permission: what Caret did under it (`says`, outcome included, as the host shows it),
 * where (`app`), when (`at`) and how it ended (`outcome`). The host's contract (fixtures/golden/
 * memory.ndjson) has the first three; `outcome` is always set by this helper and optional only so the
 * contract's lines, which predate it, still parse.
 */
export const PermissionUse = z.object({ at: ms, says: z.string().min(1), app: z.string().nullable(), outcome: UseOutcome.optional() });
export type PermissionUse = z.infer<typeof PermissionUse>;

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
  /** `uses`: the permission's last MAX_PERMISSION_USES uses, newest first; this helper always sends it, empty when none. */
  z.object({ kind: z.literal("permission"), ...entryBase, fields: PermissionFields, uses: z.array(PermissionUse).max(MAX_PERMISSION_USES).optional() }),
  /** Status: `learning` while it runs on Tab, `active` once it runs on its own, `paused` when the user paused it. */
  z.object({ kind: z.literal("skill"), ...entryBase, fields: SkillFields }),
]);
export type MemoryEntry = z.infer<typeof MemoryEntry>;

/**
 * A one-time question about a routine at the end of a run that succeeded (B19), shown with that run, whose
 * task id is `taskId`. `keep`: "Keep this as <name>?", which makes the routine a skill; `skillId` is null.
 * `promote`: after enough clean runs in a row, "Do this one on your own from now on?" for skill `skillId`.
 * The host answers with skillAnswer naming `id`; the helper ends the offer with offerWithdrawn, `expired`
 * when nobody answers within its lifetime (offers/lifetimes.ts). Every string is rendered by code.
 */
export const SkillOffer = z
  .object({
    type: z.literal("skillOffer"),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().min(1),
    at: ms,
    kind: z.enum(["keep", "promote"]),
    taskId: z.string().min(1),
    routineId: z.string().min(1),
    skillId: z.string().min(1).nullable(),
    name: z.string().min(1).max(80),
    /** The question, naming the skill. */
    says: z.string().min(1),
    /** What answering yes means, in one sentence. */
    detail: z.string().min(1),
    actions: z.tuple([z.object({ id: z.literal("accept"), label: z.string().min(1) }), z.object({ id: z.literal("decline"), label: z.string().min(1) })]),
  })
  .refine((m) => (m.kind === "keep") === (m.skillId === null), { message: "a keep offer has no skillId yet, and a promote offer names one", path: ["skillId"] });
export type SkillOffer = z.infer<typeof SkillOffer>;

export const MemoryReply = z.object({
  type: z.literal("memoryReply"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string(),
  /** Null on success; otherwise what was wrong with the request. */
  error: z.string().nullable(),
  /** For list, the entries; for every other op, the entry after the change, or none after forget. */
  entries: z.array(MemoryEntry),
  /**
   * On a list reply only: the ops this helper accepts. The host shows onboarding's typed step only when
   * this names `add`, since nothing else keeps what is typed there.
   */
  ops: z.array(MemoryOp).optional(),
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

/** The best offer a first look found: a pop-up spec, so every value on it points back to the screen. */
export const FirstLookFound = z.object({
  /** `action`: something Caret can do; `fill`: values to copy into a form; `report`: work that finished or needs the user. */
  kind: z.enum(["action", "fill", "report"]),
  /** The family that produced it; one of the request's families. */
  family: z.string().min(1),
  /** The helper's key: offerAccept with it runs the offer as the task with this id. */
  offerKey: z.string().min(1),
  window: z.object({ pid: z.number().int(), windowId: z.string(), appName: z.string(), title: z.string() }),
  spec: PopupSpec,
  /** A fill's source apps, each once, in field order, as OfferPopup.sourceApps; absent for a report. */
  sourceApps: z.array(z.string().min(1)).min(1).refine((a) => new Set(a).size === a.length, "sourceApps repeats an app").optional(),
});
export type FirstLookFound = z.infer<typeof FirstLookFound>;

/**
 * The first look's answer. Every key is present, null where it does not apply, and the host refuses a
 * reply whose fields contradict its outcome: `found` exactly with an offer, `error` exactly with a
 * non-empty reason (window ids and reasons, never screen text), `nothing` with neither.
 */
export const FirstLookReply = z
  .object({
    type: z.literal("firstLookReply"),
    v: z.literal(PROTOCOL_VERSION),
    requestId: z.string(),
    at: ms,
    outcome: z.enum(["found", "nothing", "error"]),
    found: FirstLookFound.nullable(),
    scanned: z.object({ windows: z.number().int().nonnegative(), apps: z.number().int().nonnegative(), ms: z.number().int().nonnegative() }).nullable(),
    error: z.string().nullable(),
  })
  .superRefine((m, ctx) => {
    const problem = firstLookProblem(m);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem, path: ["outcome"] });
  });
export type FirstLookReply = z.infer<typeof FirstLookReply>;

/** The host's FirstLookReply.problem, rule for rule: what makes a reply contradict its outcome, or null. */
export function firstLookProblem(m: Pick<FirstLookReply, "outcome" | "found" | "error">): string | null {
  switch (m.outcome) {
    case "found":
      if (m.found === null) return "outcome found needs found";
      if (m.error !== null) return "outcome found carries no error";
      return null;
    case "nothing":
      return m.found !== null || m.error !== null ? "outcome nothing carries neither found nor error" : null;
    case "error":
      if (m.found !== null) return "outcome error carries no found";
      return (m.error ?? "") === "" ? "outcome error needs error" : null;
  }
}

// MARK: - the planner: "do X" becomes a checked plan


/**
 * Why no plan was proposed. `schema`: the drafted plan is not a valid plan. `noWindow`: no open window
 * can carry the task, or Jev chose none. `unsure`: Jev's two asks disagreed, or agreed below the cutoff.
 * `nothingToDo`: no field to write and no control to press. `unsupportedStep`: a step other than a field
 * write or a hand-off. `multipleWindows`: steps in more than one window. `unknownWindow`,
 * `ambiguousWindow`, `unknownTarget`, `ambiguousTarget`: a window or target is not (or not uniquely) in
 * the screen model now. `notEditable`: a write to something that is not a writable field.
 * `untracedValue`: a value that no window, memory entry or the instruction shows verbatim.
 * `wrongKind`: a value whose kind does not fit its field, such as a whole address in City (B18, kinds.ts misfit).
 * `stepAfterHandoff`: a step after the press handed to the user. `riskMismatch`: a hand-off whose reason
 * is not the one the risk table gives its control. `unavailable`: Jev is off, the helper is in shadow
 * mode, Caret is paused, or no reader is connected. `jevFailed`: the Jev request failed. `privacy`: the
 * question would carry more of a window than one Jev request may (privacy.ts), so it was not asked. `internal`: the
 * planner failed in a way no other code names; the helper logged why.
 */
export const PlanErrorCode = z.enum([
  "schema", "noWindow", "unsure", "nothingToDo", "unsupportedStep", "multipleWindows", "unknownWindow", "ambiguousWindow",
  "unknownTarget", "ambiguousTarget", "notEditable", "untracedValue", "wrongKind", "stepAfterHandoff", "riskMismatch", "unavailable", "jevFailed", "privacy", "internal",
]);
export type PlanErrorCode = z.infer<typeof PlanErrorCode>;

/**
 * The planner's answer. A proposal is an offer: nothing runs until the host sends offerAccept with
 * `offerKey` and the spec's Tab action, and then the plan runs through the executor under an act grant
 * for `window` only. `spec` lists each field write with its value and source, and the press left to the
 * user, if any; `handoff` names that press. On `error`, `error.code` says which check failed and
 * `error.detail` says it in a sentence that may quote the plan's own step. The reply goes to the asker
 * only, as a memory reply does.
 */
export const PlanProposal = z
  .object({
    type: z.literal("planProposal"),
    v: z.literal(PROTOCOL_VERSION),
    requestId: z.string(),
    at: ms,
    outcome: z.enum(["proposed", "error"]),
    offerKey: z.string().min(1).nullable(),
    window: z.object({ pid: z.number().int(), windowId: z.string(), appName: z.string(), title: z.string() }).nullable(),
    spec: PopupSpec.nullable(),
    handoff: z.object({ label: z.string(), why: z.enum(["outbound", "destructive", "money", "unverifiable"]) }).nullable(),
    error: z.object({ code: PlanErrorCode, detail: z.string().min(1) }).nullable(),
  })
  .superRefine((m, ctx) => {
    const proposed = m.outcome === "proposed";
    const problem = proposed
      ? m.offerKey === null || m.window === null || m.spec === null
        ? "outcome proposed needs offerKey, window and spec"
        : m.error !== null
          ? "outcome proposed carries no error"
          : null
      : m.error === null
        ? "outcome error needs error"
        : m.offerKey !== null || m.spec !== null || m.handoff !== null
          ? "outcome error carries no offerKey, spec or handoff"
          : null;
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem, path: ["outcome"] });
  });
export type PlanProposal = z.infer<typeof PlanProposal>;

export const HelperMessage = z.discriminatedUnion("type", [
  FillProposal, HelperError, TaskProgress, PatternOffer, OfferWithdrawn, MemoryReply, Activity, ActivityReply, OfferAlternatives, OfferAction, OfferPopup, FirstLookReply, PlanProposal, SkillOffer,
]);
/** The messages that put something on screen at the caret; each is checked against HelperMessage before it is published. */
export const HOST_OFFER_TYPES: ReadonlySet<string> = new Set(["alternatives", "action", "popup"]);
/** What the helper sends the reader. A consumer can send none of these: ConsumerMessage refuses them. */
export const HelperToReader = z.discriminatedUnion("type", [ReaderCommand, ActGrant, ActRevoke, CalendarGrant]);
export type HelperToReader = z.infer<typeof HelperToReader>;
export type HelperMessage = z.infer<typeof HelperMessage>;

/** Every message that may appear on the socket in either direction. */
export const AnyMessage = z.union([ReaderMessage, ConsumerMessage, HelperMessage, HelperToReader]);
export type AnyMessage = z.infer<typeof AnyMessage>;
