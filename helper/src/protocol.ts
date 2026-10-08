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

/**
 * S1: how the text now in a page text field got there, as the extension's content script saw it since the field was
 * last empty. "typed": only the user's own typing (trusted input events of a typing kind) changed it, and the value is
 * what that typing left. "pasted": the user pasted or dropped text into it, or the browser replaced text (autofill,
 * a spelling fix). "other": a script changed it (the page's, or Caret's own writes, which are untrusted events), or
 * the value changed with no input event. Absent: the content script saw no edit, so nothing is known.
 */
export const PageEntry = z.enum(["typed", "pasted", "other"]);
export type PageEntry = z.infer<typeof PageEntry>;

/** W2: the autocomplete field names a page control may carry (extension walker.ts AUTOCOMPLETE_TOKENS), one value's meaning each. */
export const AutocompleteToken = z.enum(["name", "given-name", "additional-name", "family-name", "nickname", "organization", "organization-title", "street-address", "address-line1", "address-line2", "address-level1", "address-level2", "country", "country-name", "postal-code", "email", "tel", "tel-national", "url", "bday", "bday-day", "bday-month", "bday-year"]);
export type AutocompleteToken = z.infer<typeof AutocompleteToken>;

/**
 * SC1 2a: why the screen model keeps a node without its value (privacy/exclude.ts): a secure field, a page control the
 * walker marks, or an editable control whose own label, placeholder or containing group names a sensitive kind.
 */
export const NodeExclusion = z.enum(["secure", "password", "hidden", "payment", "oneTimeCode", "cardNumber", "accountNumber", "governmentId", "apiKey"]);
export type NodeExclusion = z.infer<typeof NodeExclusion>;

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
  /** S1, page text fields only: the field's maxlength attribute, when the page sets one. */
  maxLength: z.number().int().nonnegative().optional(),
  /** S1, page text fields only: how the field's text was entered (PageEntry). */
  entry: PageEntry.optional(),
  /** H14, page file controls only: the accept attribute's tokens, lowercased. */
  accept: z.array(z.string().min(1).max(100)).max(20).optional(),
  /**
   * W2, page text inputs only: the input's kind as the page walk read it (PageControlKind, one of page-link.ts
   * TEXT_KINDS), which the write contract checks a value's shape against (fill/contract.ts FieldContract.inputKind).
   */
  inputKind: z.enum(["text", "email", "tel", "url", "number", "search", "date", "time", "datetime", "month", "week", "textarea"]).optional(),
  /** W2, page controls only: the autocomplete field name the page gives it (PageControl.autocomplete). */
  autocomplete: AutocompleteToken.optional(),
  /** SC1 2a: set by the screen model, never by a reader: the node is one whose content Caret never carries, and it has no value. */
  excluded: NodeExclusion.optional(),
  /**
   * SCP1, page web areas only: the frame's heading list (PageFrame.headings), the sections an Ask's section question
   * offers when the walk gave no outline (fill/ask-scope.ts windowOutline). It says nothing about which control is under
   * which heading.
   */
  headings: z.array(z.string()).optional(),
  /**
   * SCP1, page web areas only: the frame's section occurrences in document order (PageFrame.sections), each by a key
   * unique in the window, with its text unless an exclusion or redaction took it. Page controls name them in `sections`.
   */
  outline: z.array(z.object({ key: z.string(), heading: z.boolean(), text: z.string().optional(), name: z.string().optional() })).optional(),
  /** SCP1, page web areas only: the tokens of section names past the frame's occurrence cap (PageFrame.sectionNames). */
  sectionNames: z.array(z.string()).optional(),
  /** SCP1, page web areas only: the frame's section list is incomplete (PageFrame.sectionsCut). */
  sectionsCut: z.literal(true).optional(),
  /** SCP1, page controls and their groups only: the keys of the outline occurrences the control sits in, outermost first. */
  sections: z.array(z.string()).optional(),
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

export const Hello = z
  .object({
    type: z.literal("hello"),
    v: z.literal(PROTOCOL_VERSION),
    role: z.enum(["reader", "consumer"]),
    /** "shadow" makes the helper log opportunities and never call Jev or publish proposals. */
    mode: z.enum(["live", "shadow"]),
    pid: z.number().int(),
    version: z.string(),
    /**
     * A consumer that is the host app: only its session counts as "host connected", and only it keeps a run
     * with no Tab alive (B23). Other consumers (evaluation scripts, the page engine) leave it out.
     */
    host: z.literal(true).optional(),
    /**
     * The reader's launch id, random per process: the same reader reconnecting sends the same one, so the
     * helper knows its window ids and the elements it recorded (write `mark`) still hold (B23).
     */
    session: z.string().min(8).optional(),
    /**
     * The reader's challenge, base64 of 32 random bytes per connection. The helper answers helperAuth before
     * anything else; until the proof checks out the reader sends nothing more and acts on nothing (B23).
     */
    challenge: z.string().min(16).optional(),
    /**
     * What a consumer understands beyond protocol 1 (M1). With MEMORY_DOCUMENTS_CAPABILITY it gets noticed facts as
     * `noticed` with their source, memoryProvenance lines, and may send memoryNotRight and memoryDocumentRequest.
     * Without it, a noticed fact reads as active and those messages are refused by name.
     */
    capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .refine((h) => h.host === undefined || h.role === "consumer", { message: "only a consumer says host", path: ["host"] })
  .refine((h) => h.capabilities === undefined || h.role === "consumer", { message: "only a consumer sends capabilities", path: ["capabilities"] })
  .refine((h) => (h.session === undefined && h.challenge === undefined) || h.role === "reader", { message: "only the reader sends session and challenge", path: ["session"] });
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
 * `watchPresses` (B20) replaces the set of windows whose user presses the reader reports as userPress: a
 * click the user makes on a button, link or other pressable element inside one of them. It only reads;
 * the reader never presses for it. An empty list stops reporting.
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
       * "value" sets AXValue. "focused" sets AXFocused to true and ignores `value`. "focusValue" sets AXFocused,
       * rechecks the value, then sets AXValue: a WebKit window that is not key drops a bare value write and takes
       * this one (B20, 3 of 3 in the candidate table). "insert" focuses the field, selects all of its text and
       * replaces the selection with `value`, as typing over it would. The executor tries value, then
       * focusValue, then insert, each only when the one before answered ok and changed nothing.
       */
      attribute: z.enum(["value", "focused", "focusValue", "insert"]),
      /** The value the field must hold right before the write; "" for empty. */
      expect: z.string(),
      value: z.string(),
      taskId: GrantTask,
      /**
       * B23 (S1 audit #6): the reader keeps the native element it writes under this name, the helper's, for as
       * long as the reader runs and the element's process lives. Undo names it again in `sameAs`.
       */
      mark: z.string().min(1).optional(),
      /**
       * The element at `key` must be the one the reader keeps under this mark: not a sibling that took over the
       * key, and not one a restarted reader found. Otherwise the answer is notSameElement and nothing is written.
       */
      sameAs: z.string().min(1).optional(),
    }).refine((v) => v.mark === undefined || v.sameAs === undefined, { message: "a write records a mark or checks one, not both", path: ["sameAs"] }),
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
    z.object({ kind: z.literal("watchPresses"), windows: z.array(z.object({ pid: z.number().int(), windowId: z.string() })) }),
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

/**
 * B23: the helper's answer to the reader's hello challenge, sent before anything else on the connection:
 * base64 of HMAC-SHA256(launch secret, "caret-helper-proof\n" + challenge + "\n" + pid), where `pid` is the
 * helper's own process. The launcher hands both processes the secret on an inherited descriptor. The reader
 * checks that `pid` is its socket's peer (LOCAL_PEERPID), so a proof another process relays from the real
 * helper names a pid that is not the reader's peer. A reader that gets no valid proof sends the helper nothing
 * more and acts on none of its lines.
 */
export const HelperAuth = z.object({
  type: z.literal("helperAuth"),
  v: z.literal(PROTOCOL_VERSION),
  proof: z.string().min(1),
  pid: z.number().int().positive(),
});
export type HelperAuth = z.infer<typeof HelperAuth>;

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
  /**
   * B23 (S1 audit #6): a write's `sameAs` did not hold. The reader keeps no element under that mark (it
   * restarted, or the element's process went), or another element now has the key. Nothing was written.
   */
  "notSameElement",
  /**
   * B23 (S1 audit #14): after the reader focused a web field for a focus-first write, focus was not on that
   * field in that window (a page handler moved it). Nothing was written; the executor hands the field off.
   */
  "focusMoved",
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
    /**
     * Page engines only (B28): the write was a Yes/No press, and the page then navigated or submitted (PageResult
     * pageChanged). Comes with outcome axError: the press may have landed, and the run stops at once.
     */
    pageChanged: z.lazy(() => PageChanges).optional(),
    /**
     * Page engines only (C1): a dropdown pick that failed, after which the page closed the list, put the control's text
     * back and read it as it showed before, with its form value unchanged (engines/page-link.ts restoredPick). Comes with
     * outcome changed. A goal run may then leave that field to the user and go on (executor RunOptions.leaveFailedToYou).
     */
    restored: z.literal(true).optional(),
    /**
     * Page engines only, an inline insert (H13 review; PageResult insert): `unchanged` comes with outcome changed (the
     * field reads as before the insert), `unverified` with axError (it changed, but not exactly to the insert).
     */
    insert: z.enum(["unchanged", "unverified"]).optional(),
  })
  .refine((r) => (r.outcome === "blocked") === (r.blocked !== undefined), { message: "blocked comes with outcome blocked, and blocked needs it", path: ["blocked"] })
  .refine((r) => r.insert === undefined || (r.insert === "unchanged" ? r.outcome === "changed" : r.outcome === "axError"), { message: "insert unchanged comes with outcome changed, unverified with axError", path: ["insert"] })
  .refine((r) => r.pageChanged === undefined || r.outcome === "axError", { message: "pageChanged comes with outcome axError", path: ["pageChanged"] })
  .refine((r) => r.restored === undefined || r.outcome === "changed", { message: "restored comes with outcome changed", path: ["restored"] });
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

/**
 * The user pressed something in a window under a press watch (B20): the pressable element under their
 * click, or the button a key pressed (B21), its role and its label as the reader last read it, and when the
 * button or key went down. `key` is the element's key in the window's latest walk, null when that walk did
 * not keep it. `via` says how: `click`; `return` or `enter` (keypad), which press the window's default
 * button; or `space`, which presses the focused button. A key is read only as one of those three, held with
 * no Command, Control, Option or Shift, and never while a text field has focus; no other key is reported or
 * kept. The reader only observes; routines learn the press an occurrence ends with from it
 * (patterns/routines.ts).
 */
export const PressVia = z.enum(["click", "return", "enter", "space"]);
export type PressVia = z.infer<typeof PressVia>;
export const UserPress = z.object({
  type: z.literal("userPress"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  pid: z.number().int(),
  windowId: z.string(),
  key: z.string().nullable(),
  role: z.string(),
  label: z.string(),
  via: PressVia,
});
export type UserPress = z.infer<typeof UserPress>;

export const ReaderMessage = z.discriminatedUnion("type", [Hello, Snapshot, Focus, AppSwitch, WindowClosed, Pasteboard, VerbResult, UserInput, UserPress]);
export type ReaderMessage = z.infer<typeof ReaderMessage>;

/** Consumer asks for a fill proposal for the form around one field, without waiting for a focus event. */
export const FillRequest = z.object({
  type: z.literal("fillRequest"),
  v: z.literal(PROTOCOL_VERSION),
  windowId: z.string(),
  fieldKey: z.string(),
});
export type FillRequest = z.infer<typeof FillRequest>;

/**
 * The hello capability for `fillAll` (D2-04). Only a host that sends it may send one; anyone else's is refused by
 * name, as a routingContext without ROUTING_CAPABILITY is.
 */
export const FILL_ALL_CAPABILITY = "fillAll";

/**
 * Host to helper (D2-04): Command-1 on a per-field fill proposal (ghost fill) asks the helper to fill the whole form
 * in one transaction, as the fill pop-up's Fill all does: every field the proposal gives a value Caret writes (text,
 * and the controls whose handoff says `writes`), under one grant, each read back, undone in one undo. The run is the
 * task `proposalId`, reported as taskProgress under that id; a refusal is an error plus a stopped taskProgress with
 * stopReason "refused", as an offerAccept's is. A proposal can be run once, and only while every field and source
 * still shows what it showed.
 */
export const FillAll = z.object({
  type: z.literal("fillAll"),
  v: z.literal(PROTOCOL_VERSION),
  proposalId: z.string().min(1),
  at: ms,
  /**
   * H10: Tab on one field of a page proposal. The host cannot write a page field itself (Chrome shows Accessibility no
   * web content), so it asks for this field only: the same transaction, rechecks and undo, for this one field, as the
   * task fillFieldTask(proposalId, fieldKey). Each field of a proposal can be run once; a Fill all of the whole
   * proposal is still refused after one, as after a Tab into a native form (the host stops offering ⌘1 then).
   */
  fieldKey: z.string().min(1).optional(),
});
export type FillAll = z.infer<typeof FillAll>;

/** The task a `fillAll` with `fieldKey` runs as (H10): the proposal's id, a slash, the field's key. The host forms the same id. */
export function fillFieldTask(proposalId: string, fieldKey: string): string {
  return `${proposalId}/${fieldKey}`;
}

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

export const MemoryOp = z.enum(["list", "edit", "pause", "resume", "forget", "add", "offerOnItsOwn"]);
export type MemoryOp = z.infer<typeof MemoryOp>;

/**
 * List, edit, pause, resume, forget or add memory entries. `kind` narrows a list; `id` names the entry
 * for edit, pause, resume and forget; `fields` holds an edit's new values, checked against the entry's
 * kind. `add` keeps a value the user typed into Caret (the host's onboarding asks for a name and an
 * email): `kind` "about", `fields` {label, value, source: "typed"}, and no `id`. A second add with the
 * same label replaces that entry's value. The host's contract for it is
 * apps/caret/Tests/CaretHostCoreTests/Fixtures/memory.ndjson on v2/host, copied byte for byte into
 * fixtures/golden/memory.ndjson.
 *
 * `offerOnItsOwn` (B22) is the skill row's "Let it run on its own…": `id` names a skill on Tab, and the
 * helper answers with the skill unchanged and publishes the normal promote skillOffer, whose `taskId` is
 * this request's `requestId`. Running on its own still comes only from accepting that offer, never from an
 * edit. A skill the user put back on Tab is never offered it again unless they ask this way. Refused, with
 * the reason in `error`, for a skill that is paused, already on its own, ends in a press Caret leaves to
 * the user, or has an offer out, and while Caret is paused or routines are off.
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

// MARK: - spend (H8 decision 4)

/** The hello capability for `spend`: a consumer that names it gets the helper's model spend. */
export const SPEND_CAPABILITY = "spend";

/** Calls to one kind of model, and what their providers reported. A failed call reported no usage and adds none. */
export const SpendBucket = z.object({
  calls: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type SpendBucket = z.infer<typeof SpendBucket>;

/**
 * Helper to consumer: what this helper process has spent on models since `since`, when it started (src/spend.ts).
 * `jev` is TypeSafe's Jev (input tokens only; output is free), `writer` every writer route (plan, goal, intent).
 * Sent to consumers whose hello names SPEND_CAPABILITY when they connect and within a second after model calls.
 */
export const Spend = z.object({
  type: z.literal("spend"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  since: ms,
  jev: SpendBucket,
  writer: SpendBucket,
});
export type Spend = z.infer<typeof Spend>;

// MARK: - routing (D2-02, action engine v2 section 3)

/**
 * The hello capability for the two routing messages. A host that sends it takes route decisions: only while such a
 * host is connected is `write` a legal outcome, since the helper writes nothing itself. Without it both messages are
 * refused by name, and no routeDecision is sent.
 */
export const ROUTING_CAPABILITY = "routing";

/**
 * Host to helper: what only the host knows about the field the user is in, sent when it changes. The reader says
 * which field has focus and what it holds; the host adds the selection, whether an input method is composing, its own
 * text revision for the field, and a breakpoint it saw in the text the reader may not have walked yet. It describes
 * only the field it names: the helper ignores it for any other.
 */
export const RoutingContext = z.object({
  type: z.literal("routingContext"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  windowId: z.string().min(1),
  key: z.string().min(1),
  selection: z.enum(["caret", "range", "none"]),
  composing: z.boolean(),
  /** The host's revision of the field's text and selection, opaque to the helper, echoed in each routeDecision. */
  textRevision: z.string().min(1).max(64),
  /** A sentence or paragraph the user just finished, which opens a new decision; null when this message reports none. */
  breakpoint: z.enum(["sentence", "paragraph"]).nullable(),
});
export type RoutingContext = z.infer<typeof RoutingContext>;

/**
 * Why a routeDecision is `error` (R2 lead decision 1): the router did not decide, so the host does what it does with
 * no router for this context. `failed`: the Jev call or the router's own code threw. `timeout`: the call ran out of
 * time. `missing`, `forged`, `nonfinite`: Jev answered nothing, an option nobody listed, or a confidence outside 0..1.
 * `stale`: the answer came for a context that had already changed. A weak but readable answer is not a failure: it is
 * `abstain`.
 */
export const RouteFailure = z.enum(["failed", "timeout", "missing", "forged", "nonfinite", "stale"]);
export type RouteFailure = z.infer<typeof RouteFailure>;

/**
 * Helper to host: the router's decision for one context, or that a decision is being made again. It grants nothing:
 * `act` and `ask` arrive as the producer's own offer, which the user accepts with Tab as before. `write` lets the
 * host's writing help run in this field until the next routeDecision or `expires`, whichever comes first. A null
 * outcome means a breakpoint ended the last decision and a new one is under way: the host stops its writing help in
 * this field until the next routeDecision. `error` means the router failed for this context (`failure` says how): the
 * host falls back to its behavior without a router there, as it does when no decision comes in time. A write session
 * survives a sentence end in its own field: that context's decision is `write` again, sent at once with no model call.
 */
export const RouteDecision = z
  .object({
    type: z.literal("routeDecision"),
    v: z.literal(PROTOCOL_VERSION),
    at: ms,
    /** The context's number, increasing in one helper process: a decision with a lower number is older. */
    context: z.number().int().positive(),
    windowId: z.string().min(1),
    /** The field the decision is about; null when focus is on no field. */
    key: z.string().min(1).nullable(),
    /** The host's textRevision when it sent one for this field, else the helper's own digest of the field. */
    textRevision: z.string().min(1).max(64),
    outcome: z.enum(["abstain", "write", "ask", "act", "error"]).nullable(),
    /** For act, what was chosen: "fillAll", "workflow:event", "workflow:openApp", "workflow:loop", "handoff" and so on. */
    route: z.string().min(1).max(80).nullable(),
    /** Present on an error decision only. */
    failure: RouteFailure.optional(),
    expires: ms,
  })
  .refine((m) => m.route === null || m.outcome === "act", { message: "only an act decision names a route", path: ["route"] })
  .refine((m) => m.outcome !== "write" || m.key !== null, { message: "a write decision names its field", path: ["key"] })
  .refine((m) => (m.outcome === "error") === (m.failure !== undefined), { message: "an error decision, and only one, says its failure", path: ["failure"] });
export type RouteDecision = z.infer<typeof RouteDecision>;

// MARK: - markdown memory (M1, plan section 6 and lead decisions 1-3 of 2026-10-04)

/** The hello capability that turns on noticed facts, provenance, "Not right" and the document messages. */
export const MEMORY_DOCUMENTS_CAPABILITY = "memoryDocuments";

/** A memory document, named by the helper: one of three fixed files or a skill's. Never a path. */
export const MemoryDocId = z.string().regex(/^(?:about-me|people|preferences|answers|skills\/[A-Za-z0-9][A-Za-z0-9_-]{2,79})$/, "a memory document is about-me, people, preferences, answers or skills/<id>");

/**
 * "Not right" on an offer (lead decision 3), about one fact the offer used, which its memoryProvenance named.
 * `correction` null forgets the fact; a string replaces an About value or a person's name with what the user
 * typed, active from then on. A preference can only be forgotten. Every offer that used the fact is withdrawn
 * as stale and every task that copies it is revoked. Answered with memoryReply under `requestId`: the entry
 * after the change, or none after a forget.
 */
export const MemoryNotRight = z.object({
  type: z.literal("memoryNotRight"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string(),
  memoryId: z.string().min(1),
  /** The offer the user said it on, for the record; null from anywhere else. */
  offerKey: z.string().min(1).nullable(),
  correction: z.string().min(1).max(500).nullable(),
});
export type MemoryNotRight = z.infer<typeof MemoryNotRight>;

export const MemoryDocumentOp = z.enum(["list", "read", "save"]);
export type MemoryDocumentOp = z.infer<typeof MemoryDocumentOp>;

/**
 * The memory window's documents. `list`: every document with its path, revision and problems, and the folder for
 * Show in Finder. `read`: one document's text. `save`: the host's editor writes `text` over `doc`, only if the file
 * is still at `baseRevision` (null: it does not exist yet); otherwise the reply carries `conflict` and nothing is
 * written, and the host offers Reload or Keep my text. Text holding what Caret never keeps is refused, naming the line.
 */
export const MemoryDocumentRequest = z
  .object({
    type: z.literal("memoryDocumentRequest"),
    v: z.literal(PROTOCOL_VERSION),
    requestId: z.string(),
    op: MemoryDocumentOp,
    doc: MemoryDocId.optional(),
    baseRevision: z.string().min(1).nullable().optional(),
    text: z.string().max(256 * 1024).optional(),
  })
  .superRefine((m, ctx) => {
    const has = { doc: m.doc !== undefined, baseRevision: m.baseRevision !== undefined, text: m.text !== undefined };
    const want = m.op === "list" ? { doc: false, baseRevision: false, text: false } : m.op === "read" ? { doc: true, baseRevision: false, text: false } : { doc: true, baseRevision: true, text: true };
    for (const k of ["doc", "baseRevision", "text"] as const) {
      if (has[k] !== want[k]) ctx.addIssue({ code: "custom", message: `${m.op} ${want[k] ? "needs" : "takes no"} ${k}`, path: [k] });
    }
  });
export type MemoryDocumentRequest = z.infer<typeof MemoryDocumentRequest>;

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
 * (B16; on v2/host since A13), `words` the host's own ghost text, which the helper accepts and ignores.
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
/** A web origin as a page frame reports it: scheme and host, with any port, and nothing after. */
export const WebOrigin = z.string().regex(/^https?:\/\/[^/\s]+$/);

export const Settings = z.object({
  type: z.literal("settings"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  roles: z.array(SettingsRole).refine((r) => new Set(r).size === r.length, "roles lists a role twice"),
  level: SettingsLevel,
  paused: z.boolean(),
  /**
   * "Not on this site" (H5): every origin the user turned Caret off for in What Caret knows, the whole list each time.
   * The helper passes it to every page engine (pageSitesOff), which then reads and acts in no frame at these origins.
   * Absent from a host before H5, which leaves the list the helper has as it is.
   */
  sitesOff: z.array(WebOrigin).max(1000).optional(),
});
export type Settings = z.infer<typeof Settings>;

/**
 * HA2 lever 2 (Sam's rule 3, iii): the user locked the screen or signed out of their Mac session. The helper clears the
 * session's owner verdicts (fill/owner-cache.ts). No host sends it yet: the host's wiring is v2/hostint's follow-up.
 */
export const SessionLocked = z.object({
  type: z.literal("sessionLocked"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  why: z.enum(["lock", "signOut"]),
});
export type SessionLocked = z.infer<typeof SessionLocked>;

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
 * The window a host means in a planRequest (B21): the one the user was in when they opened Ask Caret, as the
 * host knows it. `number` is the window server's number (CGWindowID); the helper matches it, with `pid`,
 * against the numbers the reader read for its windows (WindowRef.number). `title` is what the host saw,
 * for its own messages; titles change (a browser switching tabs), so the helper does not match on it.
 */
export const PlanWindow = z.object({
  pid: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string(),
});
export type PlanWindow = z.infer<typeof PlanWindow>;

/**
 * The user asked Caret to do something. The helper plans it against the screen model and memory and
 * answers with `planProposal`, to the asker only. The window the user means is named by `window` (what a
 * host can know) or `windowId` (the reader's id, for consumers that have it), never both. A named window
 * the reader has not read is refused with `unseenWindow`. With neither, Caret plans in the window the
 * user last focused in the frontmost app, and picks among the open windows only when that window has no
 * field or button.
 */
export const PlanRequest = z
  .object({
    type: z.literal("planRequest"),
    v: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1).max(200),
    at: ms,
    instruction: z.string().min(1).max(500),
    windowId: z.string().min(1).optional(),
    window: PlanWindow.optional(),
  })
  .refine((m) => m.windowId === undefined || m.window === undefined, "a planRequest names its window by window or windowId, not both");
export type PlanRequest = z.infer<typeof PlanRequest>;

/** Options one askQuestion lists at most. Assumed, not measured: the brief's cap for "which fields". */
export const MAX_ASK_OPTIONS = 8;

/**
 * Consumer to helper (B29): the user's answer to an askQuestion, by option id. A question takes one answer, from the
 * connection it was sent to. The helper replies under this message's `requestId` with a planProposal (or a further
 * askQuestion); a question that is unknown, expired or answered gets a planProposal error with code `questionGone`.
 * No picks answers only a fields question that names fields it is `filling`: Caret fills those alone. Any other empty
 * answer gets a planProposal error with code `schema`.
 */
export const AskAnswer = z.object({
  type: z.literal("askAnswer"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).max(200),
  at: ms,
  questionId: z.string().min(1),
  picks: z.array(z.string().min(1)).max(MAX_ASK_OPTIONS),
});
export type AskAnswer = z.infer<typeof AskAnswer>;

// MARK: - goal plans (D2-06)

/**
 * The hello capability for goal plans: a code plan that may span windows and the calendar, run one segment at a time.
 * Only a host that declares it may send goalRequest or goalAccept, and only such hosts get goalProgress.
 */
export const GOAL_PLANS_CAPABILITY = "goalPlans";

/**
 * P3: the hello capability for files in goal plans. A goal-planning host that declares it is offered attach steps (an
 * attach row with a file chooser, or a saved file), sends goalAccept.confirmedFile, and gets fileSaveOffer. Any other
 * host's page goals leave every file control to the user, as before P3, so a host that cannot show an attach row never
 * receives one.
 */
export const GOAL_FILES_CAPABILITY = "goalFiles";

/** An absolute path on this Mac, as a file chooser returns it. */
export const AbsolutePath = z
  .string()
  .min(2)
  .max(4096)
  .refine((p) => p.startsWith("/") && !p.includes("\0"), "must be an absolute path");

/** Host to helper: plan this goal. The reply is a goalProgress under `requestId`: the first segment's preview, or a stop saying why not. */
export const GoalRequest = z.object({
  type: z.literal("goalRequest"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).max(200),
  instruction: z.string().min(1).max(500),
  at: ms,
});
export type GoalRequest = z.infer<typeof GoalRequest>;

const Digest = z.string().regex(/^[0-9a-f]{64}$/, "a digest is 64 lowercase hex digits");

/**
 * Host to helper: the user accepted segment `segment` of goal `goalId` as previewed. `digest` is the preview's: an
 * acceptance of any other plan, a segment already accepted, one from another connection, or one after the preview
 * expired is refused by name and nothing runs. One acceptance runs one segment, under one grant for its one window
 * (or the calendar). Nothing else accepts a goal's steps.
 */
export const GoalAccept = z.object({
  type: z.literal("goalAccept"),
  v: z.literal(PROTOCOL_VERSION),
  goalId: z.string().min(1).max(240),
  segment: z.number().int().nonnegative(),
  digest: Digest,
  at: ms,
  /**
   * P3: the file the user confirmed in this preview for the attach step `step` (its index in the goal, as the segment's
   * steps list it): one they chose in the attach row's file chooser, or the saved file the row showed. The helper reads
   * it once now and binds it to that step's field for this run alone (engines/attach.ts); a path it was never sent here
   * is never attached. An attach step with no confirmed file is left to the user, and the rest of the segment runs. A
   * file the helper refuses (not a regular file, a link, too large, unreadable) refuses the whole acceptance, so the user
   * can choose another and press Tab again. `step` is explicit because a page may have two file controls (a file input
   * and a dropzone), and one file goes to one of them.
   */
  confirmedFile: z.object({ step: z.number().int().nonnegative(), path: AbsolutePath }).optional(),
});
export type GoalAccept = z.infer<typeof GoalAccept>;

/**
 * Host to helper (H9): the user replaced the text Caret drafted for step `step` of the segment previewed under `digest`
 * with their own words. The helper checks it as it checks an acceptance (this goal, this connection, the segment waiting,
 * its digest, in time) and that the step is a drafted write, then previews the segment again with `text` as the user's
 * value, not a draft, under a new digest. Nothing runs: the new preview needs its own goalAccept, and an acceptance of
 * the old digest is refused. A refusal comes back as an error naming why ("goalEdit refused: ...").
 */
export const GoalEdit = z.object({
  type: z.literal("goalEdit"),
  v: z.literal(PROTOCOL_VERSION),
  goalId: z.string().min(1).max(240),
  segment: z.number().int().nonnegative(),
  digest: Digest,
  step: z.number().int().nonnegative(),
  text: z.string().min(1).max(600),
  at: ms,
});
export type GoalEdit = z.infer<typeof GoalEdit>;

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

/**
 * Host to helper (H5, lead decision 7): the user took the file the slip proposed for the plan offer `taskId`, which
 * attaches one (planProposal `attach`). Sent from the slip only, right before offerAccept, once per run: a path the host
 * saved never stands for it. The helper reads the file once now and keeps its identity and digest for that task
 * alone (engines/attach.ts), and answers with fileConfirmReply to this connection.
 */
export const FileConfirm = z.object({
  type: z.literal("fileConfirm"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1),
  at: ms,
  taskId: z.string().min(1),
  /** Absolute. The file's own name is what the page will be given. */
  path: z.string().min(1).max(4096),
});
export type FileConfirm = z.infer<typeof FileConfirm>;

/**
 * The answer to fileConfirm. `confirmed`: the file is the task's until the run reads it, ends, or GRANT_MAX_MS passes;
 * `file` names it. `refused`: `says` is the user's sentence, and the run will hand the step over.
 */
export const FileConfirmReply = z
  .object({
    type: z.literal("fileConfirmReply"),
    v: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1),
    taskId: z.string().min(1),
    outcome: z.enum(["confirmed", "refused"]),
    file: z.object({ name: z.string().min(1), size: z.number().int().nonnegative() }).nullable(),
    says: z.string().min(1).max(400).nullable(),
  })
  .refine((m) => (m.outcome === "confirmed" ? m.file !== null && m.says === null : m.file === null && m.says !== null), {
    message: "confirmed carries the file and no sentence; refused carries a sentence and no file",
    path: ["outcome"],
  });
export type FileConfirmReply = z.infer<typeof FileConfirmReply>;

// MARK: - the host's local model (L1; ~/.caret-run/plans/fast-browser.md, "local text")

/**
 * The hello capability for local text. A host that sends it answers localTextRequest from the on-device model it already
 * loaded for ghost text, so the model is in memory once. The helper sends localTextRequest only to the most recent host
 * that declared it, and takes localTextReply only from that host. Lead decision (2026-10-05): no default path sends one
 * yet; L1 measures drafts through the same request on G1's tool (writer/local-port.ts).
 */
export const LOCAL_MODEL_CAPABILITY = "localModel";

/**
 * Helper to host: words for one field, from the host's local model. `draft` composes new text, `rewrite` changes text the
 * prompt's basis holds. `grammar` is GBNF whose root rule is the only language the text may be in; null for none. The
 * host builds its model's prompt from `prompt` (writer/local-draft.ts renders the one L1 measured) and answers once,
 * before `deadlineMs` (milliseconds since the Unix epoch), with localTextReply naming `id`.
 */
export const LocalTextRequest = z.object({
  type: z.literal("localTextRequest"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1).max(64),
  kind: z.enum(["draft", "rewrite"]),
  grammar: z.string().min(1).max(16_000).nullable(),
  prompt: z.object({
    instruction: z.string().min(1).max(500),
    field: z.object({ name: z.string().max(200), placeholder: z.string().max(200).nullable() }),
    /** The texts the words may draw on: each window's title and message as the helper read them. */
    basis: z.array(z.string().max(4000)).max(8),
  }),
  maxTokens: z.number().int().min(1).max(512),
  deadlineMs: ms,
});
export type LocalTextRequest = z.infer<typeof LocalTextRequest>;

/**
 * Host to helper: the answer to localTextRequest `id`. `ok` carries the text. Otherwise `text` is null and `outcome` says
 * why: `busy` (the engine is serving the user's typing and the host did not queue the request), `unavailable` (no model
 * is loaded), `timeout` (the deadline passed), `refused` (the host will not run this request, such as a grammar its
 * engine cannot apply). `model` is the model file's name, empty when none is loaded; `latencyMs` the host's time.
 */
export const LocalTextReply = z
  .object({
    type: z.literal("localTextReply"),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().min(1).max(64),
    outcome: z.enum(["ok", "busy", "unavailable", "timeout", "refused"]),
    text: z.string().max(4000).nullable(),
    model: z.string().max(200),
    latencyMs: z.number().nonnegative(),
  })
  .refine((m) => (m.outcome === "ok") === (m.text !== null), { message: "text comes with outcome ok, and ok needs it", path: ["text"] });
export type LocalTextReply = z.infer<typeof LocalTextReply>;


// MARK: - saved answers (S1)

/** P4 item 7: characters of a field's text the walk reports before its caret, after it, and selected. */
export const FIELD_BEFORE_MAX = 2000;
export const FIELD_AFTER_MAX = 500;
export const FIELD_SELECTION_MAX = 2000;

/**
 * P4 item 7: the text around the caret of the field the user is typing in (extension content/field-text.ts), for the
 * host's inline text, which had no context in any web page. Only for a control the walk kept, so never for a password,
 * card, one-time-code or hidden field, a self-identification question, or a frame on a site Caret is off for. Kept
 * only in the tab's latest snapshot in memory; never logged or stored.
 */
export const PageFocusText = z.object({
  before: z.string().max(FIELD_BEFORE_MAX),
  after: z.string().max(FIELD_AFTER_MAX),
  selection: z.string().max(FIELD_SELECTION_MAX),
});
export type PageFocusText = z.infer<typeof PageFocusText>;

/**
 * P4 items 6 and 7: a Google Docs or Sheets editor, whose text is drawn on a canvas. `text`: whether its text for
 * assistive technology is there ("off" until the user turns on screen reader and braille support); `field`: the text
 * around the caret there while the user types in it. From the tab's top frame only.
 */
export const PageDocs = z.object({
  kind: z.enum(["document", "spreadsheet"]),
  text: z.enum(["on", "off"]),
  field: PageFocusText.nullable(),
});
export type PageDocs = z.infer<typeof PageDocs>;

/**
 * P4 items 7 and 9: what the host's pageField says about the field the user is typing in on a page, beside the field's
 * key and frame (H10's PageField, on v2/host: spread this shape into it). `text`: the text around its caret
 * (PageFocusText), null when no field has focus, the control holds no text the user types, or its caret is not exposed.
 * `ownSuggestions`: the page offers its own inline suggestions there ("gmail": Gmail's compose body; "google-docs": a
 * Google Doc), decided by origin and path (engines/field-text.ts); the host decides what to do about it. `docsText`: in
 * a Google Docs or Sheets editor, whether its text for assistive technology is there, so the host can tell the user how
 * to turn it on ("off"); null elsewhere. Never logged or stored; the host's debug state redacts `text`.
 */
export const PageFieldText = z.object({
  text: PageFocusText.nullable(),
  ownSuggestions: z.enum(["gmail", "google-docs"]).nullable(),
  docsText: z.enum(["on", "off"]).nullable(),
});
export type PageFieldText = z.infer<typeof PageFieldText>;

/**
 * H13: the hello capability for page text. A host that lists it draws inline text in a page field from the text around
 * its caret, and promises never to log or store that text, nor show it on its debug socket. Only such a host is sent a
 * pageField's text and caret (every other consumer gets pageField without them), and only it may send pageInsert.
 */
export const PAGE_TEXT_CAPABILITY = "pageText";

/**
 * H13: insert `text` at the caret of the page field `key` names in page window `windowId`: the inline text the user
 * accepted with Tab there. The helper sends the page engine one pageInsertText for it (engines/page-link.ts insertText),
 * under a grant for this one insert, so it goes in through the page's own editing and the page's Undo removes it.
 * `expect` is the text before the caret the offer was made for, with any characters the user typed through since; the
 * page refuses unless its field reads exactly that before its caret, still has focus, and the tab is the one the user
 * is in. Answered with pageInsertReply under `requestId`, to the asker only.
 */
export const PageInsert = z.object({
  type: z.literal("pageInsert"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).max(80),
  windowId: z.string().min(1),
  key: z.string().min(1),
  expect: z.string().max(FIELD_BEFORE_MAX),
  text: z.string().min(1).max(FIELD_BEFORE_MAX),
  /** The element the offer was made for, as pageField.token named it; the page engine refuses any other (H13 review). */
  token: z.string().min(1).max(300),
  at: ms,
});
export type PageInsert = z.infer<typeof PageInsert>;
/**
 * The hello capability for saved answers (S1). A consumer that lists it promises to show a saved answer's whole text
 * before it inserts it, and to insert one only on the user's own acceptance after that. Only such a consumer is sent an
 * answer: a fill value with `answer`, a pop-up that writes one, an answerSaveOffer; and only it may send answerSave.
 */
export const SAVED_ANSWERS_CAPABILITY = "savedAnswers";
/** W2: a consumer that reads FillWithheld's "notExact" and "unverified"; any other is sent "wrongKind" for both. */
export const VALUE_CHECKS_CAPABILITY = "valueChecks";
/**
 * I2: a consumer that reads "outOfScope", as FillWithheld and as PlanErrorCode (fill/ask-scope.ts: a value for a field the
 * Ask did not settle, or that changed since). Any other is sent "wrongKind" and "unknownWindow" in its place.
 */
export const ASK_SCOPE_CAPABILITY = "askScope";

/** The longest answer Caret keeps. Its record line must stay under memory/parse.ts MAX_LINE_CHARS once JSON-quoted. */
export const MAX_ANSWER_CHARS = 4000;

/**
 * A saved answer's fields in answers.md: the question as the form asked it, the user's answer verbatim, where it was
 * saved (the page's address and title) and when (ISO 8601). Only the user's own words, saved only with their consent.
 */
export const AnswerFields = z.object({
  question: z
    .string()
    .min(1)
    .max(300)
    .refine((s) => s.trim() === s && !/[\r\n]/u.test(s), "must be one line of text without spaces around it"),
  answer: z
    .string()
    .max(MAX_ANSWER_CHARS)
    .refine((s) => s.trim() !== "", "must not be blank"),
  site: z.string().min(1).max(500).nullable(),
  form: z.string().min(1).max(200).nullable(),
  savedOn: z.iso.datetime(),
});
export type AnswerFields = z.infer<typeof AnswerFields>;

/**
 * The user's consent to save an answer (S1), answered with answerSaveReply under `requestId`. `offer`: yes to an
 * answerSaveOffer. `field`: "remember this answer" for a field on a page form. Either way the helper checks the field
 * again: it saves only text the user typed there, as the field holds it now.
 */
export const AnswerSave = z.object({
  type: z.literal("answerSave"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1),
  from: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("offer"), offerId: z.string().min(1) }),
    z.object({ kind: z.literal("field"), windowId: z.string().min(1), fieldKey: z.string().min(1) }),
  ]),
});
export type AnswerSave = z.infer<typeof AnswerSave>;

/**
 * P3: a saved file's fields in files.md: the question of the file control it was attached to (`question`, as the page
 * named the control; `normalized`, lowercased with digits masked and spacing collapsed, what a later field is compared by
 * before Jev is asked; `site`, the page's address), the file's absolute `path`, and when it was saved (ISO 8601). Saved
 * only with the user's yes to a fileSaveOffer, after an attach the user confirmed. A saved file is only ever offered in a
 * preview's attach row; it is attached only when that preview's acceptance names it (goalAccept.confirmedFile).
 */
export const FileFields = z.object({
  question: z
    .string()
    .min(1)
    .max(300)
    .refine((s) => s.trim() === s && !/[\r\n]/u.test(s), "must be one line of text without spaces around it"),
  normalized: z.string().min(1).max(300),
  site: z.string().min(1).max(500).nullable(),
  path: AbsolutePath,
  savedOn: z.iso.datetime(),
});
export type FileFields = z.infer<typeof FileFields>;

/** P3: the user's yes to a fileSaveOffer, answered with fileSaveReply under `requestId`. */
export const FileSave = z.object({
  type: z.literal("fileSave"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1),
  offerId: z.string().min(1),
});
export type FileSave = z.infer<typeof FileSave>;

/**
 * H14: the memory window's Files section asks for the files the user kept (files.md), or forgets one. Only for a host
 * that declared GOAL_FILES_CAPABILITY; answered with savedFilesReply under `requestId`, to the asker only. `forget` names
 * the file's `id`; `list` names none.
 */
export const SavedFilesRequest = z
  .object({
    type: z.literal("savedFilesRequest"),
    v: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1).max(200),
    op: z.enum(["list", "forget"]),
    id: z.string().min(1).max(80).optional(),
  })
  .refine((m) => (m.op === "forget") === (m.id !== undefined), { message: "forget names the file's id; list names none", path: ["id"] });
export type SavedFilesRequest = z.infer<typeof SavedFilesRequest>;

export const ConsumerMessage = z.discriminatedUnion("type", [Hello, FillRequest, FillAll, RunPlan, TaskControl, OfferControl, MemoryRequest, FillResult, ActivityRequest, OfferAccept, OfferStop, Settings, FirstLook, PlanRequest, SkillAnswer, MemoryNotRight, MemoryDocumentRequest, RoutingContext, FileConfirm, AskAnswer, GoalRequest, GoalAccept, GoalEdit, LocalTextReply, AnswerSave, FileSave, PageInsert, SavedFilesRequest, SessionLocked]);
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
  /**
   * The picked candidate's text, or null for "none". S1: null for a saved answer's pick too; its text travels only in
   * FillField.value, beside `answer`, which only a host that shows answers whole is sent.
   */
  value: z.string().nullable(),
});
export type FillAsk = z.infer<typeof FillAsk>;

/**
 * A value that came from memory rather than a window: an About entry the user typed into Caret (B17,
 * fill/about.ts). `says` is the source line after "from": "what you told Caret".
 */
export const FillMemory = z.object({
  id: z.string().min(1),
  label: z.string(),
  says: z.string(),
  /**
   * The part of a remembered name the value is (B24, fill/derive.ts): "first" for "Riley" from Name "Riley
   * Okafor". C2 adds the parts of a remembered address ("zip" for "97214" from Home address "2210 Willow Bend Drive,
   * Portland, Oregon 97214") and of a remembered date ("month" for "March" from Date of birth "March 14, 1990"). Each
   * is a substring of the entry. Absent: the value is the whole entry. A check that the entry still holds the value
   * splits it again.
   */
  part: z.enum(["first", "middle", "last", "street", "unit", "city", "state", "zip", "month", "day", "year"]).optional(),
});
export type FillMemory = z.infer<typeof FillMemory>;

/**
 * Why no value was proposed although one might have been. The first three are B11-B13's; B24 added:
 * "wrongKind": the agreed value is not the kind the field takes (a whole address in Street, kinds.ts misfit);
 * "otherPerson": both asks said the field wants one person's details and the value is another's, or the field
 * wants the user's and the asks did not both say the value is the user's;
 * "ambiguous": code could not read the value without guessing (a single name for First/Last, a date that
 * could be two days, no option or more than one that the source names).
 * W2 (fill/contract.ts) adds "notExact": Caret's check of the value says it is not exactly the field's value, and
 * "unverified": that check could not run just now, so nothing was written. A consumer whose hello lacks
 * VALUE_CHECKS_CAPABILITY is sent "wrongKind" for both (server.ts), the nearest of the six it reads.
 */
// I2: "outOfScope", a value for a field the Ask did not settle, changed since, or not the picked person's (fill/ask-scope.ts).
export const FillWithheld = z.enum(["disagree", "lowConfidence", "sourceCut", "wrongKind", "otherPerson", "ambiguous", "notExact", "unverified", "outOfScope"]);
export type FillWithheld = z.infer<typeof FillWithheld>;

/**
 * What a control is (B24): a text field Caret writes, or a control whose value comes as `handoff`. "combobox" is a
 * web page's custom dropdown (react-select and the like): typing into it does not pick an option. A control's value
 * is never `value`, whoever sets it: in a window the page engine owns, Caret writes it in a Fill all (D2-04,
 * FillHandoff.writes); anywhere else the user sets it.
 */
export const FillControl = z.enum(["text", "date", "time", "select", "radio", "checkbox", "combobox"]);
export type FillControl = z.infer<typeof FillControl>;

/**
 * A value for a control: the option to pick, "checked" for a box to tick, or the input's own wire format of a date
 * (YYYY-MM-DD), time (HH:MM, 24-hour) or date and time (YYYY-MM-DDTHH:MM), with what it is read from. `value` stays
 * null for such a control, so a consumer that does not know this key never writes it itself. `display` is how the
 * host says it ("Mar 3, 1991").
 *
 * `writes` (D2-04): Caret writes this control in the form's one Fill all transaction, through the page engine's
 * verified handler for it (a native select by option label, a checkbox or radio by its checked state, a date or time
 * by its value, a custom dropdown by its option's name), and undoes it with the rest. Absent: the user sets it. Before
 * D2-04 a page dropdown's pick came as `value`, which the host's decoder refuses on any control but text.
 */
export const FillHandoff = z.object({
  value: z.string(),
  display: z.string(),
  source: FillSource.nullable(),
  memory: FillMemory.nullable(),
  /**
   * D2-04: when the value was read from a "Label: value" line of the source, that label ("Valid driving license" in
   * "Valid driving license: yes"). A recheck before the Fill all asks the source for that very line, since a short
   * value such as "yes" can stay on screen in another line after the one it came from says "no".
   */
  context: z.string().min(1).optional(),
  writes: z.literal(true).optional(),
});
export type FillHandoff = z.infer<typeof FillHandoff>;

/**
 * S1: why a saved answer that matched a field is not offered. "otherOrganization": the answer, or the question it was
 * saved for, names an organization, product or role that this page does not show. "tooLong": the field's maxlength is
 * shorter than the answer, and Caret never cuts the user's words to fit.
 */
export const AnswerWithheld = z.enum(["otherOrganization", "tooLong"]);
export type AnswerWithheld = z.infer<typeof AnswerWithheld>;

/**
 * S1: a field's value is one of the user's saved answers (answers.md), their own words from an earlier form, copied
 * whole. The value carries `memory` too ({id, label: the question, says}), so a host that checks only "exactly one of
 * source and memory" stays correct. `withheld` non-null: the answer matched but code withheld it; the field then has
 * no value, `FillField.withheld` holds the nearest older reason (otherPerson for otherOrganization, wrongKind for
 * tooLong, since a host before S1 decodes only those six) and `says` is the sentence for the user.
 */
export const FillAnswer = z.object({
  id: z.string().min(1),
  /** The question the answer was saved for, as that form asked it. */
  question: z.string().min(1),
  /** Where it was saved: the page's address without query or fragment; null when unknown. */
  site: z.string().nullable(),
  /** The title of the page it was saved from; null when unknown. */
  form: z.string().nullable(),
  /** When it was saved, ISO 8601. */
  savedOn: z.string().min(1),
  withheld: z.object({ why: AnswerWithheld, says: z.string().min(1) }).nullable(),
});
export type FillAnswer = z.infer<typeof FillAnswer>;

export const FillField = z.object({
  key: z.string(),
  /** What the control is; absent from a helper before B24, which read text fields only. */
  control: FillControl.default("text"),
  /** For a control other than text: the value the user should set, or null when none is proposed. */
  handoff: FillHandoff.nullable().default(null),
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
  withheld: FillWithheld.nullable(),
  /**
   * The first ask, and the second with candidates shuffled and the field reworded. Empty when the field
   * was not asked: withheld as "sourceCut" before any ask, or, with `withheld` null, nothing could be
   * offered for it (no window gave a candidate, and nothing the user told Caret fits it).
   */
  asks: z.union([z.tuple([FillAsk, FillAsk]), z.tuple([])]),
  /**
   * S1: the saved answer the field matched (FillAnswer). Only a consumer with SAVED_ANSWERS_CAPABILITY is sent a field
   * that has one; absent everywhere else.
   */
  answer: FillAnswer.optional(),
  /**
   * G2: what a proposed value's reading rests on besides its source, which a recheck holds it to again (offers/
   * fill-popup.ts valueStale, goals/runs.ts precheck). `identity`: the value (or, for a part, the value it was split
   * from) is exactly the user's own email, phone or full name in memory entry `memoryId`, which made it the user's
   * without asking Jev (fill/whose.ts); `key` is that identity as fill compared it (identityKey). Editing or forgetting
   * the entry withdraws the offer, and the write is checked against it. Absent from a helper before G2.
   * I1: G2's `clause`, `lines`, `from` and `how` are gone from the wire: the helper keeps them in each value's
   * write-contract provenance (fill/contract.ts Provenance), which its one recheck reads; no host read them.
   */
  basis: z
    .object({
      // `part`: the value is that part of the identity (a first or last name split from a full name), as FillMemory.part.
      identity: z.object({ memoryId: z.string().min(1), kind: z.enum(["email", "phone", "name"]), key: z.string().min(1), part: z.enum(["first", "middle", "last"]).optional() }).optional(),
    })
    .optional(),
})
  .refine((f) => f.answer === undefined || (f.answer.withheld === null ? f.control === "text" && f.value !== null && f.memory?.id === f.answer.id : f.value === null), {
    message: "an offered answer is a text field's value from that answer's memory entry, and a withheld one gives no value",
    path: ["answer"],
  })
  .refine((f) => (f.value === null ? f.source === null && f.memory === null : (f.source === null) !== (f.memory === null)), {
    message: "a value comes with exactly one of source and memory, and no value with neither",
    path: ["memory"],
  })
  .refine((f) => (f.control === "text" ? f.handoff === null : f.value === null), {
    message: "a text field's value is written and never handed off; any other control is never written, its value comes as a handoff",
    path: ["handoff"],
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
  /**
   * H13: a fill found nothing because its source, the tab the user just left, was a Google Docs or Sheets editor whose
   * text for assistive technology is off; `message` says what to turn on. The host shows it at the field the user is in,
   * also for a fill nobody asked for, which otherwise ends in silence.
   */
  sourceOff: z.enum(["Google Docs", "Google Sheets"]).optional(),
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

/**
 * `noticed` (M1): a fact Caret saw itself, used at once, whose offers say where it came from; about, people and
 * preference entries only. A host without MEMORY_DOCUMENTS_CAPABILITY is sent `active` instead.
 */
export const MemoryStatus = z.enum(["learning", "active", "paused", "noticed"]);
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

/** The risk classes a press can have (executor/risk.ts), as a skill's hand-off names them. `system` (B22): a permission dialog or system prompt. */
export const PressRisk = z.enum(["outbound", "destructive", "money", "system"]);
export type PressRisk = z.infer<typeof PressRisk>;

/**
 * A routine the user kept (B19). Code renders every string from the routine's structure: `name` passed
 * the naming check (patterns/naming.ts: at most six words, names the destination app or a field, holds
 * no value seen in the routine) or the user typed it.
 */
/** The two write rules a skill's runs can write under (B19): in the window the user is in, or in another. */
export const WriteRule = z.enum(["writeHere", "writeElsewhere"]);
export type WriteRule = z.infer<typeof WriteRule>;

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
  /**
   * The write rules its clean runs in a row wrote under, each once: what running it on its own would do unasked. The
   * host's permissions page lists the skill under each (A16; the host's memory.ndjson host-memory-9). Empty after any
   * reset.
   */
  wrote: z.array(WriteRule).refine((w) => new Set(w).size === w.length, "wrote names a rule twice"),
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

/** Where Caret noticed a fact: the app and window title when known, and when. */
export const NoticedSource = z.object({ app: z.string().nullable(), windowTitle: z.string().nullable(), at: ms });
export type NoticedSource = z.infer<typeof NoticedSource>;

const entryBase = {
  id: z.string(),
  status: MemoryStatus,
  /** The entry as a sentence, rendered by code from its fields. */
  says: z.string(),
  evidence: z.object({ count: z.number().int().nonnegative(), lastSeen: ms, app: z.string().nullable() }),
};
/** Only a skill says what it wrote: the key is refused in any other kind's fields, not dropped. */
const notWrote = { wrote: z.never().optional() };
/** A noticed entry says where it came from; other statuses may keep it as history (M1). */
const noticedNeedsSource = (e: { status: string; noticed?: unknown }, ctx: z.RefinementCtx): void => {
  if (e.status === "noticed" && e.noticed === undefined) ctx.addIssue({ code: "custom", message: "a noticed entry says where Caret noticed it", path: ["noticed"] });
};
const neverNoticed = (e: { status: string }, ctx: z.RefinementCtx): void => {
  if (e.status === "noticed") ctx.addIssue({ code: "custom", message: "only about, people and preference entries are noticed", path: ["status"] });
};
export const MemoryEntry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("about"), ...entryBase, noticed: NoticedSource.optional(), fields: AboutFields.extend(notWrote) }).superRefine(noticedNeedsSource),
  z.object({ kind: z.literal("people"), ...entryBase, noticed: NoticedSource.optional(), fields: PeopleFields.extend(notWrote) }).superRefine(noticedNeedsSource),
  z.object({ kind: z.literal("preference"), ...entryBase, noticed: NoticedSource.optional(), fields: PreferenceFields.and(z.object(notWrote)) }).superRefine(noticedNeedsSource),
  z.object({ kind: z.literal("routine"), ...entryBase, fields: RoutineFields.extend(notWrote) }).superRefine(neverNoticed),
  /** `uses`: the permission's last MAX_PERMISSION_USES uses, newest first; this helper always sends it, empty when none. */
  z.object({ kind: z.literal("permission"), ...entryBase, fields: PermissionFields.extend(notWrote), uses: z.array(PermissionUse).max(MAX_PERMISSION_USES).optional() }).superRefine(neverNoticed),
  /**
   * Status: `learning` while it runs on Tab, `active` once it runs on its own, `paused` when the user paused
   * it. A skill that hands a press to the user never runs on its own. CaretScreenCore's MemoryEntry refuses
   * the same two shapes.
   */
  z
    .object({ kind: z.literal("skill"), ...entryBase, fields: SkillFields })
    .superRefine((e, ctx) => {
      if (e.fields.onItsOwn && e.fields.handsOff !== null) ctx.addIssue({ code: "custom", message: "a skill that hands a press to the user never runs on its own", path: ["fields", "onItsOwn"] });
      if (e.status !== "paused" && e.status !== (e.fields.onItsOwn ? "active" : "learning")) {
        ctx.addIssue({ code: "custom", message: `a skill ${e.fields.onItsOwn ? "on its own is active" : "on Tab is learning"}, or paused`, path: ["status"] });
      }
    }),
]);
export type MemoryEntry = z.infer<typeof MemoryEntry>;

/**
 * A one-time question about a routine at the end of a run that succeeded (B19), shown with that run, whose
 * task id is `taskId`. `keep`: "Keep this as <name>?", which makes the routine a skill; `skillId` is null.
 * `promote`: after enough clean runs in a row, "Do this one on your own from now on?" for skill `skillId`;
 * or the same offer the user asked for from the skill's row (memoryRequest offerOnItsOwn, B22), whose
 * `taskId` is that request's `requestId`.
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

/**
 * The noticed facts an offer was built from (M1, lead decision 3), sent right after the offer to consumers with
 * MEMORY_DOCUMENTS_CAPABILITY, and with a planProposal to its asker. `offerKey` is the offer's key or a
 * patternOffer's id. The host shows `says` on the offer ("from what Caret noticed in Mail, Tue") with "Not right"
 * (memoryNotRight). Taking the offer confirms each fact: it becomes active. An offer with no noticed fact gets none.
 */
export const MemoryProvenance = z.object({
  type: z.literal("memoryProvenance"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  offerKey: z.string().min(1),
  facts: z
    .array(
      z.object({
        memoryId: z.string().min(1),
        kind: z.enum(["about", "people", "preference"]),
        /** The fact's label: an About label, a person's alias, the field a rule fills. */
        label: z.string(),
        says: z.string().min(1),
        noticed: NoticedSource,
      }),
    )
    .min(1),
});
export type MemoryProvenance = z.infer<typeof MemoryProvenance>;

/** A problem in a memory document, by line and field (1-based line). Errors disable the record; warnings change nothing. */
export const MemoryDiagnostic = z.object({ line: z.number().int().positive(), field: z.string().nullable(), severity: z.enum(["error", "warning"]), message: z.string().min(1) });
export type MemoryDiagnostic = z.infer<typeof MemoryDiagnostic>;

export const MemoryDocument = z.object({
  doc: MemoryDocId,
  /** The file's name inside the folder: "people.md", "skills/skill-1a2b3c4d.md". */
  file: z.string().min(1),
  /** Its absolute path, for Edit (open in the user's editor) and Show in Finder. */
  path: z.string().min(1),
  /** Null when the file does not exist yet. */
  revision: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  diagnostics: z.array(MemoryDiagnostic),
});
export type MemoryDocument = z.infer<typeof MemoryDocument>;

/**
 * The answer to memoryDocumentRequest, to the asker only. `documents`: every document for list; the one document
 * for read and save. `text`: the document's text for read, else null. `conflict`: on a save refused because the
 * file changed since `baseRevision`, its revision now (null: removed); nothing was written.
 */
export const MemoryDocumentReply = z
  .object({
    type: z.literal("memoryDocumentReply"),
    v: z.literal(PROTOCOL_VERSION),
    requestId: z.string(),
    error: z.string().nullable(),
    conflict: z.object({ revision: z.string().nullable() }).nullable(),
    /** The memory folder, for Show in Finder. */
    folder: z.string().min(1),
    documents: z.array(MemoryDocument),
    text: z.string().nullable(),
  })
  .refine((m) => m.conflict === null || m.error !== null, { message: "a conflict comes with an error saying so", path: ["conflict"] });
export type MemoryDocumentReply = z.infer<typeof MemoryDocumentReply>;

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
 * the screen model now. `unseenWindow`: the request named a window (planRequest `window` or `windowId`)
 * that the reader has not read: closed, never walked, or an app it skips (B21). `notEditable`: a write to something that is not a writable field.
 * `untracedValue`: a value that no window, memory entry or the instruction shows verbatim.
 * `wrongKind`: a value whose kind does not fit its field, such as a whole address in City (B18, kinds.ts misfit).
 * `stepAfterHandoff`: a step after the press handed to the user. `riskMismatch`: a hand-off whose reason
 * is not the one the risk table gives its control. `unavailable`: Jev is off, the helper is in shadow
 * mode, Caret is paused, or no reader is connected. `jevFailed`: the Jev request failed. `privacy`: the
 * question would carry more of a window than one Jev request may (privacy.ts), so it was not asked. `internal`: the
 * planner failed in a way no other code names; the helper logged why. `questionGone`: an askAnswer named a question that
 * is unknown, expired, already answered or another connection's (B29).
 */
export const PlanErrorCode = z.enum([
  "schema", "noWindow", "unsure", "nothingToDo", "unsupportedStep", "multipleWindows", "unknownWindow", "ambiguousWindow",
  "unknownTarget", "ambiguousTarget", "notEditable", "untracedValue", "wrongKind", "stepAfterHandoff", "riskMismatch", "unavailable", "jevFailed", "privacy", "internal",
  "unseenWindow", "questionGone",
  // I2: a write outside the Ask's settled scope (fill/ask-scope.ts).
  "outOfScope",
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
    handoff: z.object({ label: z.string(), why: z.enum(["outbound", "destructive", "money", "system", "unverifiable"]) }).nullable(),
    /**
     * H5 (lead decision 7): the plan attaches a file at step `step`, into the file input `field`, and `wants` says which
     * in the user's words ("your resume"). The host proposes the likely file in the slip and sends fileConfirm with the
     * one the user takes, before offerAccept; without a confirmation the step is the user's. Absent when the plan
     * attaches nothing, and from a helper before H5.
     */
    attach: z.object({ step: z.number().int().nonnegative(), field: z.string().min(1), wants: z.string().min(1).max(80) }).optional(),
    error: z
      .object({
        code: PlanErrorCode,
        detail: z.string().min(1),
        /**
         * What the user reads (H5): the sentence planner/says.ts wrote for this refusal or question, which names no
         * window id, ref, or model or provider text. The host shows it as it is. Absent from a helper before H5, whose
         * host builds its own sentence from `code`.
         */
        says: z.string().min(1).max(400).optional(),
      })
      .nullable(),
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

/**
 * The hello capability for Ask questions with choices (B29). A consumer that sends it may get an askQuestion in place
 * of a planProposal whose error asks the user something, and may answer it with askAnswer. Any other consumer gets
 * the planProposal error as before; an askAnswer from it is refused by name.
 */
export const ASK_CHOICES_CAPABILITY = "askChoices";
/**
 * The hello capability for value questions (design/ask/VALUE-SETTLEMENT.md): a consumer that declares it beside
 * ASK_CHOICES_CAPABILITY may get an askQuestion whose part is `value`. Any other consumer gets the proposal with those
 * values left to the user, as before, so a host that cannot draw value rows never receives one.
 */
export const ASK_VALUES_CAPABILITY = "askValues";

/**
 * One choice of an askQuestion, typed by what it fixes. `id` is the helper's, valid for that question only; the host
 * sends it back and never a field key or window id. `field`: a field of the form (its label, and its section's
 * heading). `window`: an open window to copy from, as the user knows it. `memory`: what the user told Caret about
 * themselves. `you`: the user's own details. `person`: someone named in the instruction or on screen. `value`: a value
 * for the question's field, exactly as Caret would put it in (`value`), and where Caret read it, in the user's words
 * (`source`: "Your saved Email", or a window's title and the line). `blank`: leave the field blank.
 */
export const AskOption = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field"), id: z.string().min(1), label: z.string().min(1), section: z.string().nullable() }),
  z.object({ kind: z.literal("window"), id: z.string().min(1), app: z.string(), title: z.string() }),
  z.object({ kind: z.literal("memory"), id: z.string().min(1) }),
  z.object({ kind: z.literal("you"), id: z.string().min(1) }),
  z.object({ kind: z.literal("person"), id: z.string().min(1), name: z.string().min(1) }),
  z.object({ kind: z.literal("value"), id: z.string().min(1), value: z.string().min(1), source: z.string().min(1) }),
  z.object({ kind: z.literal("blank"), id: z.string().min(1) }),
]);
export type AskOption = z.infer<typeof AskOption>;

/**
 * Helper to the asker, in place of a planProposal (B29): the Ask needs one part settled, and code listed that part's
 * real choices from the screen. `part` says which: `fields` (pick one or more), `source` (one window, or memory), `person` (whose
 * details) or `value` (which value goes in one field: its values, then exactly one `blank`; only to a consumer that
 * declared ASK_VALUES_CAPABILITY). `text` is the question as the user reads it. Answered with askAnswer naming
 * `questionId` and the picks, once, before `expires`; the answer's reply is a planProposal or another askQuestion.
 * `window` is the form. `filling`, on a fields question, labels the fields Caret fills whatever is picked; with it, an
 * answer with no picks fills those alone, so the user can decline the offered fields without dismissing the Ask. On a
 * value question it lists the values already checked, each as "Label: value", which a pick leaves as they are.
 */
export const AskQuestion = z
  .object({
    type: z.literal("askQuestion"),
    v: z.literal(PROTOCOL_VERSION),
    requestId: z.string(),
    at: ms,
    questionId: z.string().min(1),
    part: z.enum(["fields", "source", "person", "value"]),
    text: z.string().min(1),
    pick: z.enum(["one", "many"]),
    options: z.array(AskOption).min(1).max(MAX_ASK_OPTIONS),
    filling: z.array(z.string().min(1)).min(1).optional(),
    window: z.object({ pid: z.number().int(), windowId: z.string(), appName: z.string(), title: z.string() }),
    expires: ms,
  })
  .superRefine((m, ctx) => {
    const kinds = { fields: ["field"], source: ["window", "memory"], person: ["you", "person"], value: ["value", "blank"] }[m.part];
    const pick = m.part === "fields" ? "many" : "one";
    const problem = m.pick !== pick
      ? `a ${m.part} question picks ${pick}`
      : m.filling !== undefined && m.part !== "fields" && m.part !== "value"
        ? "only a fields or value question names what it is filling"
        : m.options.some((o) => !kinds.includes(o.kind))
          ? `a ${m.part} question lists only ${kinds.join(" or ")} options`
          : m.part === "value" && (m.options.filter((o) => o.kind === "blank").length !== 1 || m.options.at(-1)?.kind !== "blank" || m.options.length < 2)
            ? "a value question lists its values, then one blank"
            : new Set(m.options.map((o) => o.id)).size !== m.options.length
              ? "option ids repeat"
              : null;
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem, path: ["options"] });
  });
export type AskQuestion = z.infer<typeof AskQuestion>;

/**
 * Whether Caret can see the pages of a Chromium browser (browser layer W2, memo section 6). `missing`: the reader
 * reports the browser frontmost, the user has typed in it since it came to the front, and no Caret page engine is
 * connected for that process. The host shows "Caret can't see this page yet" at most once per browser per session
 * (v2/host). `connected`: an engine for that browser said hello, so the host can say "Caret for Chrome is
 * connected" and drop the ask. Sent on each change of state for a browser process, never repeated while it holds.
 */
export const PageEngineState = z.object({
  type: z.literal("pageEngine"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  browser: AppRef,
  state: z.enum(["missing", "connected"]),
});
export type PageEngineState = z.infer<typeof PageEngineState>;

/**
 * H10: how a focused page field draws its text, so the host draws a fill value where the user's typing would go:
 * `inset` from the field's left edge to its text (padding and border), `fontSize`, whether a placeholder shows now, and
 * `dark`, light text on a dark field. In CSS pixels on a page snapshot, in screen points on pageField.
 */
export const FieldLook = z.object({
  inset: z.number().nonnegative(),
  fontSize: z.number().nonnegative(),
  placeholder: z.boolean(),
  dark: z.boolean(),
});
export type FieldLook = z.infer<typeof FieldLook>;

/**
 * H10: the field the user is in on a page, for the host, which cannot read it: Chrome shows Accessibility no web
 * content and no focused element while a page field has focus (evidence/host/h10/probe). Sent after each walk of the
 * tab the user is in (engines/page-focus.ts): when focus moves in it, when another tab or browser window comes to the
 * front, and when the page scrolls or zooms while a control has focus. `key` is the focused control's node key in the
 * page window, the key fill proposals and offers name; null when no control of that tab has focus, or the tab is not
 * the user's. `frame` is the control in screen points (page-link screenRect), null when the walk did not say where the
 * viewport is. The browser is `app`, the process the bridge was launched by, never one the page names. No value, no
 * label: `empty` says only whether the control holds any text.
 */
/** H13: the kinds of page field whose text a pageField carries (PageField.fieldKind). */
export const PageFieldKind = z.enum(["input", "textarea", "contenteditable"]);
export type PageFieldKind = z.infer<typeof PageFieldKind>;

export const PageField = z.object({
  type: z.literal("pageField"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  app: AppRef,
  windowId: z.string().min(1),
  title: z.string(),
  key: z.string().min(1).nullable(),
  role: z.string(),
  editable: z.boolean(),
  empty: z.boolean(),
  frame: Frame.nullable(),
  /** How the field draws its text, in screen points; absent when the walk did not say, or the field is in a child frame. */
  look: FieldLook.optional(),
  /**
   * H13, P4 items 7 and 9 (PageFieldText): the text around the caret, whether the page offers its own suggestions there,
   * and a Docs editor's text for assistive technology. Sent only to hosts that declared PAGE_TEXT_CAPABILITY; absent for
   * every other consumer (server.ts) and from a helper before H13.
   */
  text: PageFocusText.nullable().optional(),
  ownSuggestions: z.enum(["gmail", "google-docs"]).nullable().optional(),
  docsText: z.enum(["on", "off"]).nullable().optional(),
  /** H13: the caret in screen points, for a field of the top frame; with `text`, to the same hosts only. */
  caret: Frame.nullable().optional(),
  /**
   * H13 review: the walked element itself (page-link.ts elementToken: frame, document, registry id), with `text`. The
   * key is a label and an ordinal, which a replacement field of the same label keeps; an insert names this token.
   */
  token: z.string().min(1).max(300).optional(),
  /**
   * H13 review: false when the field's document has lost focus (the user clicked the address bar): the host offers no
   * inline text there, since Tab would go to the browser. With `text`, to the same hosts only; absent before H13.
   */
  pageFocused: z.boolean().optional(),
  /**
   * H13: what kind of field `text` is from (engines/field-text.ts fieldKind): a text input, a textarea or a
   * contenteditable editor. The host decides by it where inline text may show, since one ⌘Z after typing behaves per
   * kind. With `text`, to the same hosts only; absent before H13 and where the kind is none of these.
   */
  fieldKind: PageFieldKind.optional(),
});
export type PageField = z.infer<typeof PageField>;

/**
 * H13: what became of a pageInsert. `inserted`: the page took the text, and the whole field reads as before with the
 * text at the caret and the caret after it. `refused`: checked before any write, the field changed, lost focus, has
 * no single caret, is composing or is not the user's, so nothing went in. `failed`: the write was tried and the field
 * reads as it did before. `unverified` (H13 review): the field changed, but not exactly to the insert, or the page did
 * not say (a timeout, an error mid-way); it is left as it is. `says` is for the log and names no text from the page.
 */
export const PageInsertReply = z.object({
  type: z.literal("pageInsertReply"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).max(80),
  outcome: z.enum(["inserted", "refused", "failed", "unverified"]),
  says: z.string().max(300),
  at: ms,
});
export type PageInsertReply = z.infer<typeof PageInsertReply>;

/**
 * One step of a goal as the user reads it: what it does, and whether Caret does it or hands it over. `drafted` (B30) is
 * present only on a write of text Caret composed rather than copied: the whole text, which `says` also holds after the
 * field's name. A host shows it marked as Caret's, with an Edit action; it is written only on acceptance.
 */
export const GoalStepView = z
  .object({
    index: z.number().int().nonnegative(),
    kind: z.enum(["write", "calendar", "press", "handoff", "attach"]),
    says: z.string().min(1).max(900),
    drafted: z.string().min(1).max(600).optional(),
    /**
     * P3: on an attach step only, the file its row offers. `choose`: none yet; the host's row says "Choose a file" and
     * opens a file chooser. `saved`: a file the user saved for this question before (fileSave), which a Jev choice matched
     * to this field; the row shows its `name` and when it was last `edited` (its modification time, so a stale resume
     * shows as one), and is confirmed only by the user's own action on this preview's row (⌘2/⌘3 or a click in H14's
     * host; Tab alone never confirms a file), after which the next Tab sends its path as confirmedFile. Caret never
     * looks for a file on disk.
     */
    file: z
      .discriminatedUnion("source", [
        z.object({ source: z.literal("choose") }),
        z.object({ source: z.literal("saved"), savedId: z.string().min(1).max(80), path: AbsolutePath, name: z.string().min(1).max(255), edited: ms }),
      ])
      .optional(),
  })
  .refine((v) => (v.kind === "attach") === (v.file !== undefined), { message: "an attach step names its file, and no other step does", path: ["file"] });
export type GoalStepView = z.infer<typeof GoalStepView>;

/**
 * Why a goal stopped. `refused`: code will not offer the plan (the sentence says which check). `dialog`: a dialog or
 * sheet opened in the window. `reload`: the page reloaded or navigated. `sourceChanged`: a window or memory entry a value
 * came from no longer shows it. `targetChanged`: a field changed, went or was replaced before Caret reached it.
 * `timeout`: what a press should do did not happen in time. `unexpectedEffect`: something other than what the step
 * predicted changed. `handedOff`: Caret could not do a step it planned (an app that did not take a write, focus that
 * moved) and left it to the user, before the plan's own end. `revealed`: the plan's last press showed fields it could
 * not name, so the goal is not done; `freshPlan` names a plan for them when Caret could make one. `windowGone`, `you` (the user stopped it or took the window
 * back), `readerRestarted`, `hostGone`, `expired` (no acceptance in time), `error` (anything else; the sentence says what).
 */
export const GoalStopReason = z.enum(["refused", "dialog", "reload", "sourceChanged", "targetChanged", "timeout", "unexpectedEffect", "handedOff", "revealed", "windowGone", "you", "readerRestarted", "hostGone", "expired", "error"]);
export type GoalStopReason = z.infer<typeof GoalStopReason>;

/**
 * H11: what a host's page task panel shows for a segment that writes in a page window, beside `steps`; absent for every
 * other segment. Nothing here is covered by `digest`: it is how the preview reads, and every value in it is a step's.
 * - `windowId`: the page window the segment writes in; `app`, the browser it is in, whose keys Tab and Esc arrive on.
 * - `anchor`: the first field the segment writes, in screen points (top-left origin), when it lies inside `viewport`;
 *   null otherwise, and the host anchors to `viewport`'s top edge instead.
 * - `viewport`: the page's visible area on screen (its top frame); null when the walk did not say where it is.
 * - `from`: where the values came from, worded as the fill pop-up's source line ("Notes, Robin's details and what you
 *   told Caret"); empty when no write has a source.
 * - `rows`: each write step whose value reads as "field: value", by its index in the goal; `picked` for a value chosen
 *   from a list (a select or a combobox). A write with no row (a box to tick) reads from its step's `says`.
 * - `attach`: the labels of the page's empty file inputs the Ask's scope takes that no step of the plan attaches to (for
 *   a host without GOAL_FILES_CAPABILITY, every one), so the host names each as the user's.
 * - `files`: H14: each attach step's row as the panel shows it: the control's name and the types its chooser may offer.
 *   Not under the digest. `accept` is the control's accept tokens (Node.accept), empty when it names none. Absent when
 *   the segment has no attach step.
 */
export const GoalPageView = z.object({
  windowId: z.string().min(1),
  app: AppRef,
  anchor: Frame.nullable(),
  viewport: Frame.nullable(),
  from: z.string().max(300),
  rows: z.array(z.object({ step: z.number().int().nonnegative(), label: z.string().max(300), value: z.string().max(900), picked: z.boolean() })).max(24),
  attach: z.array(z.string().min(1).max(200)).max(8),
  files: z
    .array(z.object({ step: z.number().int().nonnegative(), label: z.string().min(1).max(300), accept: z.array(z.string().min(1).max(100)).max(20) }))
    .max(8)
    .refine((f) => new Set(f.map((x) => x.step)).size === f.length, "each attach step has one row")
    .optional(),
});
export type GoalPageView = z.infer<typeof GoalPageView>;

const GoalHead = {
  type: z.literal("goalProgress"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  goalId: z.string().min(1).max(240),
  /** The goalRequest this answers; null on every later message. */
  requestId: z.string().min(1).max(200).nullable(),
};

/**
 * Helper to a host that declared GOAL_PLANS_CAPABILITY (D2-06). `segment`: a segment waits for the user's acceptance
 * (goalAccept with this `digest`) until `expires`; `reason` says why it is separate (`start`, `crossWindow`: another
 * window or the calendar, `afterReveal`: a press showed new fields, `freshPlan`: replanned after a stop, `nextPage`
 * (P3): the user's own Next took the page to a new document, and a goal whose scope was the whole form or a section was
 * planned again there, its values chosen afresh from the sources as they read now, `moreFields` (C2): the next part of
 * a page form over 20 fields, at most 20 more of its fields, which the goal planned with the rest and runs only on this
 * segment's own acceptance) and `replaces` names the goal it was
 * replanned from or carried on from. `step`: one step verified, already true, or handed to the user, with the
 * executor task it ran in. `stopped`: the goal stopped; `freshPlan` names the replanned goal offered in its place, or
 * null. `finished`: every segment ran; `outcome` is `done` only when every step Caret makes was verified and nothing is
 * left to the user, `handoff` when what is left is only the user's own part (the press that sends a ready draft, a
 * message's recipient), `partial` when a write the plan meant was dropped or a field the form requires is still empty
 * (G2). `left` says each thing left, in the preview's words; empty exactly when done.
 */
export const GoalProgress = z.discriminatedUnion("event", [
  z.object({
    ...GoalHead,
    event: z.literal("segment"),
    segment: z.number().int().nonnegative(),
    segments: z.number().int().positive(),
    reason: z.enum(["start", "crossWindow", "afterReveal", "freshPlan", "nextPage", "moreFields"]),
    replaces: z.string().min(1).max(240).nullable(),
    digest: Digest,
    expires: ms,
    where: z.discriminatedUnion("kind", [z.object({ kind: z.literal("window"), app: z.string(), title: z.string() }), z.object({ kind: z.literal("calendar"), calendar: z.string().min(1) })]),
    steps: z.array(GoalStepView).min(1).max(24),
    warnings: z.array(z.string().min(1).max(600)).max(24),
    page: GoalPageView.optional(),
  }),
  z.object({
    ...GoalHead,
    event: z.literal("step"),
    segment: z.number().int().nonnegative(),
    taskId: z.string().min(1),
    step: z.number().int().nonnegative(),
    steps: z.number().int().positive(),
    phase: z.enum(["verified", "skipped", "handoff"]),
    says: z.string().min(1).max(900),
  }),
  z.object({
    ...GoalHead,
    event: z.literal("stopped"),
    segment: z.number().int().nonnegative().nullable(),
    step: z.number().int().nonnegative().nullable(),
    reason: GoalStopReason,
    says: z.string().min(1).max(600),
    freshPlan: z.string().min(1).max(240).nullable(),
  }),
  z
    .object({
      ...GoalHead,
      event: z.literal("finished"),
      outcome: z.enum(["done", "handoff", "partial"]),
      verified: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      left: z.array(z.string().min(1).max(300)).max(24),
      says: z.string().min(1).max(600),
    })
    .refine((m) => (m.outcome === "done") === (m.left.length === 0) || m.outcome === "handoff", { message: "done leaves nothing, and partial names what it leaves", path: ["left"] }),
]);
export type GoalProgress = z.infer<typeof GoalProgress>;

/**
 * S1: the user left a prose field on a page form that they typed into, and Caret may offer to keep what they wrote. The
 * host shows `says` with the whole answer when it chooses; the user's yes is answerSave {kind: "offer"}. Nothing is
 * saved without it. `replaces`: the saved answer to the same question on the same site that a yes would update.
 */
export const AnswerSaveOffer = z.object({
  type: z.literal("answerSaveOffer"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  at: ms,
  windowId: z.string().min(1),
  fieldKey: z.string().min(1),
  question: AnswerFields.shape.question,
  answer: AnswerFields.shape.answer,
  site: AnswerFields.shape.site,
  form: AnswerFields.shape.form,
  replaces: z.string().min(1).nullable(),
  says: z.string().min(1),
});
export type AnswerSaveOffer = z.infer<typeof AnswerSaveOffer>;

/** Why an answer was not saved (S1); `says` on the reply is the sentence for the user. */
export const AnswerRefusal = z.enum([
  "notPage",
  "notProse",
  "noQuestion",
  "neverTyped",
  "secret",
  "pasted",
  "caretWrote",
  "notTyped",
  "unseen",
  "empty",
  "tooLong",
  "changed",
  "noOffer",
  "unavailable",
]);
export type AnswerRefusal = z.infer<typeof AnswerRefusal>;

/** The answer to answerSave, to the asker only: the saved answer's id, or why nothing was saved. */
export const AnswerSaveReply = z
  .object({
    type: z.literal("answerSaveReply"),
    v: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1),
    outcome: z.enum(["saved", "refused"]),
    answerId: z.string().min(1).nullable(),
    why: AnswerRefusal.nullable(),
    says: z.string().min(1),
  })
  .refine((m) => (m.outcome === "saved") === (m.answerId !== null) && (m.outcome === "saved") === (m.why === null), {
    message: "a saved reply names the answer and no refusal; a refused one names the refusal and no answer",
    path: ["why"],
  });
export type AnswerSaveReply = z.infer<typeof AnswerSaveReply>;

/**
 * P3: Caret attached a file the user confirmed in a goal's preview, and may keep it for the same question next time
 * ("Use this file for résumés next time?"). Sent once, after the attach step verified, to the host the goal was offered
 * to, if it declared GOAL_FILES_CAPABILITY. Nothing is saved without fileSave naming `id`; the offer lapses at `expires`.
 * `replaces`: the saved file for the same question on the same site that a yes would replace.
 */
export const FileSaveOffer = z.object({
  type: z.literal("fileSaveOffer"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  at: ms,
  expires: ms,
  goalId: z.string().min(1).max(240),
  question: FileFields.shape.question,
  site: FileFields.shape.site,
  file: z.object({ name: z.string().min(1).max(255) }),
  replaces: z.string().min(1).max(80).nullable(),
  says: z.string().min(1).max(300),
});
export type FileSaveOffer = z.infer<typeof FileSaveOffer>;

/** The answer to fileSave, to the asker only: the saved file's id, or why nothing was saved, in `says`. */
export const FileSaveReply = z
  .object({
    type: z.literal("fileSaveReply"),
    v: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1),
    outcome: z.enum(["saved", "refused"]),
    fileId: z.string().min(1).max(80).nullable(),
    says: z.string().min(1).max(300),
  })
  .refine((m) => (m.outcome === "saved") === (m.fileId !== null), { message: "a saved reply names the file; a refused one names none", path: ["fileId"] });
export type FileSaveReply = z.infer<typeof FileSaveReply>;

/**
 * H14: one saved file as the memory window's Files section shows it: its record `id`, the `question` and `site` it was
 * kept for, the file's `name` (the basename of `path`), when it was saved (`savedOn`, from files.md's Saved on), when the
 * file was last modified (`edited`, by lstat, only for a regular file, never following a link; null when it is gone or
 * not a regular file), and whether Caret offers it (`status`).
 */
export const SavedFileView = z.object({
  id: z.string().min(1).max(80),
  question: FileFields.shape.question,
  site: FileFields.shape.site,
  name: z.string().min(1).max(255),
  path: AbsolutePath,
  savedOn: ms,
  edited: ms.nullable(),
  status: z.enum(["active", "paused"]),
});
export type SavedFileView = z.infer<typeof SavedFileView>;

/**
 * H14: the answer to savedFilesRequest, to the asker only. `files` is the list newest saved first: for `list`, as files.md
 * holds it; for `forget`, after the removal. Forget removes the record from files.md as it was read: an edit since is a
 * conflict, refused with the reason in `error`. Any refusal (that, an unknown id, memory still in the old encrypted
 * store) has `error` set and `files` empty; the host asks for the list again.
 */
export const SavedFilesReply = z.object({
  type: z.literal("savedFilesReply"),
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).max(200),
  error: z.string().nullable(),
  files: z.array(SavedFileView).max(200),
});
export type SavedFilesReply = z.infer<typeof SavedFilesReply>;

export const HelperMessage = z.discriminatedUnion("type", [
  FillProposal, HelperError, TaskProgress, PatternOffer, OfferWithdrawn, MemoryReply, Activity, ActivityReply, OfferAlternatives, OfferAction, OfferPopup, FirstLookReply, PlanProposal, SkillOffer,
  PageEngineState, MemoryProvenance, MemoryDocumentReply, RouteDecision, FileConfirmReply, AskQuestion, GoalProgress, Spend, PageField, LocalTextRequest, AnswerSaveOffer, AnswerSaveReply, FileSaveOffer, FileSaveReply, PageInsertReply, SavedFilesReply,
]);
/** The messages that put something on screen at the caret; each is checked against HelperMessage before it is published. */
export const HOST_OFFER_TYPES: ReadonlySet<string> = new Set(["alternatives", "action", "popup"]);
/** What the helper sends the reader. A consumer can send none of these: ConsumerMessage refuses them. */
export const HelperToReader = z.discriminatedUnion("type", [ReaderCommand, ActGrant, ActRevoke, CalendarGrant, HelperAuth]);
export type HelperToReader = z.infer<typeof HelperToReader>;
export type HelperMessage = z.infer<typeof HelperMessage>;

/** Every message that may appear on the socket in either direction. */
export const AnyMessage = z.union([ReaderMessage, ConsumerMessage, HelperMessage, HelperToReader]);
export type AnyMessage = z.infer<typeof AnyMessage>;

// MARK: - the page engine (browser layer, W1: ~/.caret-run/plans/browser-layer.md sections 1 and 2)
//
// Caret's own MV3 extension is a second reader. Its service worker talks to the helper through the Swift
// Native Messaging bridge (bridge/) over a socket of its own, page.sock, never the reader's screen.sock. These
// messages travel only there. They are additions: no shape above changes, and the reader never sees one.
// The Swift mirror is bridge/Sources/CaretPageProtocol; both sides decode fixtures/golden/page.ndjson.

/**
 * Where an act grant holds. `native` is a reader window, as ActGrant names it. `page` pins one frame of one
 * tab in one engine session, at the origin and navigation generation the task was planned against: a
 * navigation, a new document or another origin in that frame ends the grant's reach there.
 */
export const GrantScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native"), pid: z.number().int(), windowId: z.string().min(1) }),
  z.object({
    kind: z.literal("page"),
    /** The engine session the helper gave the extension at its hello (engineWelcome). */
    engine: z.string().min(1),
    tabId: z.number().int().nonnegative(),
    /** Chrome's frame id: 0 for the top frame. */
    frameId: z.number().int().nonnegative(),
    /** scheme://host[:port], as the frame's URL had it when walked. */
    origin: z.string().min(1),
    navGen: z.number().int().nonnegative(),
  }),
]);
export type GrantScope = z.infer<typeof GrantScope>;

/**
 * ActGrant with a scope discriminator. The engine acts for `taskId` only inside `scope`, until `expires`, at
 * most GRANT_MAX_MS after it received the grant. The task's actRevoke ends every scope it holds. A page task
 * whose form spans frames holds one grant per frame.
 */
export const ScopedActGrant = z
  .object({ type: z.literal("scopedActGrant"), v: z.literal(PROTOCOL_VERSION), taskId: z.string().min(1), scope: GrantScope, at: ms, expires: ms })
  .refine((g) => g.expires > g.at && g.expires - g.at <= GRANT_MAX_MS, { message: `expires must be after at and at most ${GRANT_MAX_MS} ms after it`, path: ["expires"] });
export type ScopedActGrant = z.infer<typeof ScopedActGrant>;

/** What a page control is, from its tag, type and ARIA role. */
export const PageControlKind = z.enum([
  "text", "email", "tel", "url", "number", "search", "date", "time", "datetime", "month", "week", "textarea",
  "select", "checkbox", "radio", "combobox", "button", "link", "file", "contenteditable", "range", "color",
]);
export type PageControlKind = z.infer<typeof PageControlKind>;

/**
 * Subroles the page engine's window snapshot (engines/page-link.ts toWindowSnapshot) gives nodes whose reader role
 * alone does not say what fill must know (D2-04): a date-like input's own value format (each is AXDateField or
 * AXTimeField, as Chrome's Accessibility shows them), a file input (an AXButton, like a dropzone), an ARIA switch (an
 * AXCheckBox that often acts at once, which a Fill all leaves to the user), and a Yes/No question built from toggle
 * buttons (W4), whose press cannot be taken back, so a Fill all leaves it to the user too. A radio group keeps
 * Chrome's AXFieldset.
 */
export const PAGE_SUBROLE = {
  date: "CaretDateInput",
  time: "CaretTimeInput",
  datetime: "CaretDateTimeInput",
  month: "CaretMonthInput",
  week: "CaretWeekInput",
  file: "CaretFileInput",
  /** B29: an input of type number, or a text input whose inputmode is numeric or decimal. Undo compares its value as a number. */
  number: "CaretNumberInput",
  switch: "AXSwitch",
  pressGroup: "CaretPressGroup",
  /**
   * P4 rule 6: text Caret read on demand from the tab the user just left, as static text of that tab's window. Such a
   * node exists only in the view fill reads (ScreenModel.withNodes, engines/tab-source.ts), never in the model.
   */
  readOnDemand: "CaretReadOnDemand",
} as const;

/**
 * What a page checkbox's node holds while it is ticked (D2-04); "" while it is not. A Fill all writes this value to tick
 * one, and its undo writes "" back. It is the value FillHandoff carries for a box to tick.
 */
export const PAGE_CHECKED = "checked";

/** [x, y, width, height] in CSS pixels of the frame's own viewport. */
export const PageRect = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/**
 * One visible interactive control. Never a password, hidden, credit-card or one-time-code input, nor anything
 * hidden, zero-size, off-screen or aria-hidden, nor a consent or self-identification group: the content
 * script drops those before anything leaves the frame and counts them only in PageFrame.excluded.
 */
export const PageControl = z.object({
  /** The frame's registry id for the element: valid only in this document (PageFrame.documentId). */
  id: z.string().min(1),
  /** Structural key (ancestors, role, name, ordinal). Fills Node.key; never a basis for rebinding. */
  key: z.string().min(1),
  /** JSON array (origin, form, name|id|data-automation-id, kind) when the page author named it; null for a generated or missing identifier. */
  strongKey: z.string().nullable(),
  kind: PageControlKind,
  /** The ARIA role the control has or implies. */
  role: z.string().min(1),
  /** The accessible name the user sees. */
  name: z.string(),
  value: z.string().optional(),
  checked: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string(), selected: z.boolean() })).optional(),
  /** The form identity the strong key uses; null outside a form. */
  form: z.string().nullable(),
  rect: PageRect,
  required: z.literal(true).optional(),
  disabled: z.literal(true).optional(),
  invalid: z.literal(true).optional(),
  /** Inside a shadow root, and which kind; the walker descends closed roots through chrome.dom. */
  shadow: z.enum(["open", "closed"]).optional(),
  /**
   * W4: the question a radio or a press-group option answers (a fieldset legend, else the text around the group), and
   * an id for its group, valid in this document. A press-group option is a toggle button of a Yes/No question.
   */
  group: z.object({ id: z.string().min(1), name: z.string().min(1) }).optional(),
  /** W4: a press-group option's aria-pressed. */
  pressed: z.boolean().optional(),
  /** B29: a text input whose inputmode is numeric or decimal. */
  numeric: z.literal(true).optional(),
  /** S1: a text input's or textarea's maxlength, when the page sets one. */
  maxLength: z.number().int().nonnegative().optional(),
  /** S1: how a text input's or textarea's text was entered since it was last empty (PageEntry); absent when no edit was seen. */
  entry: PageEntry.optional(),
  /** H14, page file controls only: the accept attribute's tokens, lowercased. */
  accept: z.array(z.string().min(1).max(100)).max(20).optional(),
  /** W2: the autocomplete attribute's field name (extension walker.ts autocompleteOf), which the write contract reads. */
  autocomplete: AutocompleteToken.optional(),
  /**
   * SC1 2a: a control the walker keeps out of reach (a password, card or one-time-code field). It arrives with its kind,
   * role, name, form and rect only, never a value, options or entry, so the helper knows the field is there and never
   * targets it; the frame also counts it in `excluded`.
   */
  excluded: z.enum(["password", "payment", "oneTimeCode"]).optional(),
  /**
   * SCP1: the ids of the section occurrences (PageFrame.sections) the control sits in, outermost first (extension
   * content/sections.ts). Absent when it is in none.
   */
  sections: z.array(z.string().min(1).max(40)).max(8).optional(),
});
export type PageControl = z.infer<typeof PageControl>;

/** Why controls were left out, by count only: what they were called or held never leaves the frame. */
export const PageExclusion = z.enum(["password", "hidden", "payment", "oneTimeCode", "invisible", "ariaHidden", "selfIdentification"]);
export type PageExclusion = z.infer<typeof PageExclusion>;

/** SCP1: a section name's token, HMAC-SHA256 under a salt the extension's worker makes per snapshot and never sends. */
export const SectionToken = z.string().regex(/^[0-9a-f]{64}$/u);

export const PageFrame = z.object({
  frameId: z.number().int().nonnegative(),
  /** -1 for the top frame. */
  parentFrameId: z.number().int().min(-1),
  documentId: z.string().min(1),
  origin: z.string().min(1),
  /** The URL's path; the query string and fragment are dropped. */
  path: z.string(),
  navGen: z.number().int().nonnegative(),
  title: z.string(),
  /** h1 and h2 text, clipped, none the walk's exclusions match. No body prose. SCP1: from the section outline. */
  headings: z.array(z.string()),
  /**
   * SCP1: the frame's section occurrences in document order (extension content/sections.ts): each heading, fieldset with
   * a legend, or labelled group or region, by an id unique within the walk, and its text unless an exclusion took it.
   * `name`: a token of its name (worker/section-names.ts), equal for equal names across every frame of this snapshot and
   * nothing more, excluded occurrences included. Absent from an extension before SCP1.
   */
  sections: z.array(z.object({ id: z.string().min(1).max(40), heading: z.boolean(), text: z.string().min(1).max(200).optional(), name: SectionToken.optional() })).max(200).optional(),
  /** SCP1: the tokens of section names past the frame's occurrence cap, which have no id or text. */
  sectionNames: z.array(SectionToken).max(2000).optional(),
  /** SCP1: the frame has more section names than a walk tokens: its section list is incomplete. */
  sectionsCut: z.literal(true).optional(),
  controls: z.array(PageControl),
  /** The frame's visible <iframe> elements, origin plus path of src and rect: the worker drops a child frame none of them holds. */
  iframes: z.array(z.object({ src: z.string(), rect: PageRect })),
  excluded: z.partialRecord(PageExclusion, z.number().int().positive()),
  truncated: z.boolean(),
  /** P1: how long the frame's content script took to walk it, in ms; absent from an extension built before P1. */
  walkMs: z.number().nonnegative().optional(),
});
export type PageFrame = z.infer<typeof PageFrame>;


/**
 * One tab, composed by the worker from every frame that answered. `id` names the pageWalk it answers; the
 * pageResult for that command follows it. `missing` lists frames that did not answer, with why.
 */
export const PageSnapshot = z.object({
  type: z.literal("pageSnapshot"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  at: ms,
  tabId: z.number().int().nonnegative(),
  /** Chrome's window id of the tab. */
  browserWindowId: z.number().int(),
  /** The tab is the selected one of its browser window, which may be a background window. */
  active: z.boolean(),
  /**
   * The tab's browser window is the one chrome.windows.getLastFocused names (W3). Only an active tab of that window is
   * the tab the user is in, and only while the reader reports the browser frontmost: a background window's selected
   * tab is not the user's.
   */
  inFocusedWindow: z.boolean(),
  title: z.string(),
  frames: z.array(PageFrame).min(1),
  missing: z.array(z.object({ frameId: z.number().int().nonnegative(), reason: z.string() })),
  /** The focused control and its text and selection, when one has focus. `text` (P4 item 7): absent from an extension before P4. */
  focused: z
    .object({
      frameId: z.number().int().nonnegative(),
      id: z.string().min(1),
      selection: z.tuple([z.number().int(), z.number().int()]).nullable(),
      /** H10: how the field draws its text, in CSS pixels (FieldLook); absent from a worker before H10. */
      look: FieldLook.optional(),
      /** P4 item 7: the text around the caret; absent from an extension before P4. */
      text: PageFocusText.nullable().optional(),
      /**
       * H13: the caret, in the frame's viewport CSS pixels as control rects are (extension content/caret-rect.ts); null
       * when the page cannot place it, absent from an extension before H13.
       */
      caret: Frame.nullable().optional(),
      /** H13 review: the focused control's document has focus (not the browser's address bar, nor another window). */
      hasFocus: z.boolean().optional(),
    })
    .nullable(),
  /**
   * H10: where the tab's viewport is on screen, from the top frame. `window`: the browser window's outer frame as the
   * page reads it (screenX, screenY, outerWidth, outerHeight), in screen points, top-left origin. `viewport`: the top
   * frame's innerWidth and innerHeight in CSS pixels. `zoom`: the tab's page zoom (chrome.tabs.getZoom). Null or absent
   * from a worker before H10, or when the top frame did not answer; the page's controls then have no screen frame.
   */
  view: z
    .object({
      window: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]),
      viewport: z.tuple([z.number().nonnegative(), z.number().nonnegative()]),
      zoom: z.number().positive(),
    })
    .nullable()
    .optional(),
  /** P4 items 6 and 7: present only for a Google Docs or Sheets editor tab. */
  docs: PageDocs.optional(),
  /**
   * P1: the walk's time in the extension, from the worker's receipt of the command to the snapshot it sends (its frames
   * walked in parallel), in ms; absent from an extension built before P1.
   */
  walkMs: z.number().nonnegative().optional(),
});
export type PageSnapshot = z.infer<typeof PageSnapshot>;

/**
 * The element a mutating page verb acts on, as the last walk named it. `name` is the accessible name the
 * helper planned and judged risk on; the content script re-reads it and refuses on a difference.
 */
/**
 * The largest file pageAttachFile carries. Assumed, not measured: resumes and cover letters are a few MB, and the
 * line stays far under the worker's 32 MB chunk join cap (extension/src/worker/wire.ts Chunks.MAX).
 */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

const PageTarget = {
  tabId: z.number().int().nonnegative(),
  frameId: z.number().int().nonnegative(),
  documentId: z.string().min(1),
  id: z.string().min(1),
  /** The control's kind as walked (PageControl.kind); a different kind now is stale. */
  control: PageControlKind,
  name: z.string(),
  /** Mutating page verbs always name their task: there is no fixture bypass for pages. */
  taskId: z.string().min(1),
  /**
   * `false`: act only on the element the walk retained, alive and in this document; a replaced element is
   * `notSameElement`, never rebound by its strong key. Undo sends it (W3): a restore must reach the element Caret
   * wrote, not a re-rendered one that took its identifier. Absent: a strong-key rebind is allowed.
   */
  rebind: z.literal(false).optional(),
  /**
   * A forward write's undo mark (W3 review #2): the content script keeps the element the act actually reached under it,
   * after any rebind, before it touches the page. An undo names it in `sameAs` and is notSameElement unless the element
   * at `id` is that very object, alive in this document. A verb carries one or the other.
   */
  mark: z.string().min(1).max(64).optional(),
  sameAs: z.string().min(1).max(64).optional(),
};

/**
 * The helper asks the engine to read or act. `pageWalk` reads a tab (null: the active tab of the focused
 * browser window) and answers with a pageSnapshot, then a pageResult. Every other verb acts on one element
 * under a live ScopedActGrant for its task, after the worker's check (task, tab, frame, origin, navGen,
 * expiry, revocation) and the content script's (element alive or strongly rebound, kind, name, value before).
 * `pageWrite` sets a text control: `expect` is the value it must hold right before. `pageSelect` picks the
 * option of a native <select> whose value is `value`; `expect` is the selected value before. `pageSetChecked`
 * sets a checkbox or radio. `pagePress` is always a hand-off in v1: the engine names the risk and leaves the press to
 * the user, without touching the page.
 *
 * `pageChooseOption` picks an option of a custom listbox (generic ARIA or react-select, memo section 2): `expect` is
 * the text the control shows before (react-select's chip, an ARIA combobox's own value), `value` the option's name.
 * The handler opens the control, types `value` as the filter, and picks only an option whose normalized name
 * equals it; zero or several such options stop it with their names in `choice.matches`. Its mousedown, click and
 * keys land only on the control it was given and that control's own listbox options: the one exception to "every
 * page press is a hand-off".
 *
 * W4: `pageChooseOption` with `control: "button"` answers a Yes/No question built from toggle buttons (Ashby): `id` is
 * the option to press, `question` the question the plan names, `expect` the group's pressed answer before ("" for
 * none). The content script presses only that option, only while it is still an option of that question (2 to 6
 * aria-pressed buttons that send no form, alone in one container), and verifies aria-pressed afterwards: the second
 * exception (extension/src/content/press.ts).
 *
 * `pageAttachFile` puts one file into a file input, or drops it on any other control (a dropzone), through
 * DataTransfer. `file.data` is the whole file, base64; a line over Chrome's 1 MB frame reaches the extension as
 * pageChunk parts. The worker checks `size` and `sha256` against the bytes before the page sees them. The helper
 * builds this verb only from the file the user confirmed for the run (engines/attach.ts).
 */
export const PageVerb = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pageWalk"), tabId: z.number().int().nonnegative().nullable() }),
  /**
   * P4 item 8: `text` at the caret of the focused field `id` names, by document.execCommand("insertText"), so the page's
   * own Undo takes it back. Only while that very element (no strong-key rebind) still has focus, holds no selection and
   * reads exactly `expect` before its caret (PageFocusText.before); read back afterwards.
   */
  z.object({ kind: z.literal("pageInsertText"), ...PageTarget, expect: z.string().max(FIELD_BEFORE_MAX), text: z.string().min(1).max(FIELD_BEFORE_MAX) }),
  z.object({ kind: z.literal("pageWrite"), ...PageTarget, expect: z.string(), value: z.string() }),
  z.object({ kind: z.literal("pagePress"), ...PageTarget }),
  z.object({ kind: z.literal("pageSelect"), ...PageTarget, expect: z.string(), value: z.string() }),
  z.object({ kind: z.literal("pageChooseOption"), ...PageTarget, expect: z.string(), value: z.string(), question: z.string().min(1).optional() }),
  z.object({ kind: z.literal("pageSetChecked"), ...PageTarget, checked: z.boolean() }),
  z.object({
    kind: z.literal("pageAttachFile"),
    ...PageTarget,
    file: z
      .object({
        /** The file's own name, no directory: what the page will show. */
        name: z.string().min(1).max(255).refine((n) => !/[/\\\0]/.test(n), "a file name, not a path"),
        type: z.string(),
        size: z.number().int().nonnegative().max(MAX_ATTACH_BYTES),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        /** The bytes, base64. */
        data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
      })
      .refine((f) => Math.floor((f.data.length * 3) / 4) - (f.data.endsWith("==") ? 2 : f.data.endsWith("=") ? 1 : 0) === f.size, { message: "data holds another number of bytes than size", path: ["data"] }),
  }),
]);
export type PageVerb = z.infer<typeof PageVerb>;
export type PageActVerb = Exclude<PageVerb, { kind: "pageWalk" }>;

/** A page verb with the readerCommand envelope: the engine must not act after `expires`. */
export const PageCommand = z.object({ type: z.literal("pageCommand"), v: z.literal(PROTOCOL_VERSION), id: z.string().min(1), expires: ms, verb: PageVerb });
export type PageCommand = z.infer<typeof PageCommand>;

export const PageOutcome = z.enum([
  /** Done and verified: for a write, both readings (after input, after blur) hold the value. */
  "ok",
  /** The end state already held, so nothing was done. */
  "alreadyTrue",
  /** No live grant covers this task, tab, frame, origin and navigation generation; `detail` says which. */
  "notAllowed",
  /** The page moved on since the walk: a navigation, another document, a value or name that differs from the walk's. */
  "stale",
  /** Caret acted and the page did not take it: a value that returned to `before` is "the page kept the old value". */
  "failed",
  /** A press Caret leaves to the user: in v1, every page press. */
  "handoff",
  /** The element is gone and no strong key rebinds it. */
  "noElement",
  /** A verb with `rebind: false` found its element replaced: nothing was done (W3, undo). */
  "notSameElement",
  /** The element is one Caret never reads or writes (PageExclusion). */
  "excluded",
  /** A verb this build does not carry out yet. */
  "unsupported",
  "error",
  /** The user turned Caret off for this site ("Not on this site", pageSitesOff): nothing was read or done there. */
  "siteOff",
]);
export type PageOutcome = z.infer<typeof PageOutcome>;

/** The two readings a write is judged on, and what the page said about the field after blur. */
export const PageWriteReadings = z.object({
  before: z.string(),
  afterInput: z.string(),
  afterBlur: z.string(),
  invalid: z.boolean(),
  /** The error text aria-describedby or aria-errormessage pointed at after blur, clipped; null when none. */
  error: z.string().nullable(),
});
export type PageWriteReadings = z.infer<typeof PageWriteReadings>;

/**
 * What pageChooseOption found and checked. The readings carry the control's shown text (before, after the pick,
 * after blur). `matches`: the names of the options whose normalized name equals the value, or, when none does,
 * those that contain it; exactly one exact match is picked, anything else stops with these named. `expanded`:
 * aria-expanded on the control at the end (null when it has none). `hiddenInput`: react-select's hidden form input
 * took a new, non-empty value (`set`), did not (`unchanged`), or the control has none (`none`); its value never
 * leaves the frame, since hidden inputs are never read out.
 */
export const PageChoice = z.object({
  /** pressGroup (W4): a Yes/No question's toggle; `matches` is the option pressed. */
  flavor: z.enum(["aria", "reactSelect", "pressGroup"]),
  matches: z.array(z.string()).max(20),
  expanded: z.boolean().nullable(),
  hiddenInput: z.enum(["set", "unchanged", "none"]),
});
export type PageChoice = z.infer<typeof PageChoice>;

/** What pageAttachFile checked: the input's files[0] (null for a drop), and whether the page now shows the file's name where it did not before. */
export const PageAttached = z.object({
  via: z.enum(["input", "drop"]),
  file: z.object({ name: z.string(), size: z.number().int().nonnegative() }).nullable(),
  shown: z.boolean(),
});
export type PageAttached = z.infer<typeof PageAttached>;

/**
 * What showed that the page changed after a Yes/No press (B28): the worker saw the frame's navigation generation move
 * (`navigated`), a navigation begin in it (`navigationStarted`), or its document go before answering
 * (`documentGone`); the content script saw beforeunload, pagehide or submit in the frame.
 */
export const PageChanges = z.array(z.enum(["navigated", "navigationStarted", "documentGone", "beforeunload", "pagehide", "submit"])).min(1).max(6);
export type PageChanges = z.infer<typeof PageChanges>;

/** P4 rule 4: the most text one read of a tab carries, in UTF-8 bytes, all frames together (extension shared/tab-text.ts). */
export const TAB_TEXT_BYTES = 16 * 1024;
/**
 * P4 rule 2: how long after the user leaves a tab its text may be read, and the longest any read is kept. Two minutes,
 * the window fill already treats as recent. The extension's worker holds the same bound (worker/left-tab.ts LEFT_TAB_MS).
 */
export const LEFT_TAB_MS = 120_000;
const utf8 = new TextEncoder();

/**
 * P4: the visible text of the tab the user just left, as one pageReadText found it: paragraphs of what the user had
 * selected there, then of the page's main region, top frame first, at most TAB_TEXT_BYTES in all (checked again here).
 * `leftAt`: when the user left the tab, by the worker's clock. `frames`: each frame read, with its origin. `docsText`:
 * for a Google Docs or Sheets editor, whether its text for assistive technology was there; null on other pages. The
 * helper holds it in memory for one fill only (engines/tab-source.ts), and never logs or stores it.
 */
export const PageTabText = z
  .object({
    tabId: z.number().int().nonnegative(),
    leftAt: ms,
    title: z.string(),
    frames: z.array(z.object({ frameId: z.number().int().nonnegative(), origin: z.string().min(1) })).min(1),
    selection: z.array(z.string().min(1)),
    blocks: z.array(z.string().min(1)),
    cut: z.boolean(),
    docsText: z.enum(["on", "off"]).nullable(),
  })
  .refine((t) => [...t.selection, ...t.blocks].reduce((n, p) => n + utf8.encode(p).length + 1, 0) <= TAB_TEXT_BYTES + 1, { message: `more than ${TAB_TEXT_BYTES} bytes of text`, path: ["blocks"] });
export type PageTabText = z.infer<typeof PageTabText>;

export const PageResult = z
  .object({
    type: z.literal("pageResult"),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().min(1),
    at: ms,
    outcome: PageOutcome,
    detail: z.string().nullable(),
    readings: PageWriteReadings.optional(),
    /**
     * On a handoff: the risk class the visible name reads as. `pageScript`: a page press whose name reads as no risk;
     * every page press is a hand-off in v1, since the button runs the page's own script. `unclassified` and
     * `submitsForm` are kept for a later build that presses.
     */
    risk: z.enum(["outbound", "destructive", "money", "system", "unclassified", "submitsForm", "pageScript"]).optional(),
    /** pageChooseOption only. */
    choice: PageChoice.optional(),
    /** pageAttachFile only. */
    attached: PageAttached.optional(),
    /** A Yes/No press after which the page navigated or submitted (B28): with outcome failed and no readings. */
    pageChanged: PageChanges.optional(),
    /** P4: pageReadText only, with outcome ok. */
    text: PageTabText.optional(),
    /**
     * pageInsertText only, with outcome failed (H13 review): `unchanged`, the field reads as it did just before the
     * insert; `unverified`, it changed, but not exactly to its text with the insert at the caret and the caret after it.
     * The page leaves either as it is; nothing is undone.
     */
    insert: z.enum(["unchanged", "unverified"]).optional(),
  })
  .refine((r) => (r.outcome === "handoff") === (r.risk !== undefined), { message: "risk comes with outcome handoff, and handoff needs it", path: ["risk"] })
  .refine((r) => r.pageChanged === undefined || (r.outcome === "failed" && r.readings === undefined), { message: "pageChanged comes with outcome failed and no readings", path: ["pageChanged"] })
  .refine((r) => r.text === undefined || r.outcome === "ok", { message: "text comes with outcome ok", path: ["text"] })
  .refine((r) => r.insert === undefined || r.outcome === "failed", { message: "insert comes with outcome failed", path: ["insert"] });
export type PageResult = z.infer<typeof PageResult>;

/** The worker's first message once the bridge says the engine is ready. One per worker instance and connection. */
export const PageHello = z.object({
  type: z.literal("pageHello"),
  v: z.literal(PROTOCOL_VERSION),
  extensionId: z.string().regex(/^[a-p]{32}$/),
  version: z.string().min(1),
  /** A random id the extension keeps per browser profile, so two profiles of one browser are two engines. */
  profile: z.string().min(1),
  /** A random id per service-worker start: a new one means the worker restarted. */
  instance: z.string().min(1),
  startedAt: ms,
  capabilities: z.array(z.string()),
});
export type PageHello = z.infer<typeof PageHello>;

/** Liveness check with no side effect; the answer names the worker instance so a restart cannot pass for the same one. */
export const PagePing = z.object({ type: z.literal("pagePing"), v: z.literal(PROTOCOL_VERSION), id: z.string().min(1) });
export type PagePing = z.infer<typeof PagePing>;
export const PagePong = z.object({ type: z.literal("pagePong"), v: z.literal(PROTOCOL_VERSION), id: z.string().min(1), at: ms, instance: z.string().min(1), startedAt: ms });
export type PagePong = z.infer<typeof PagePong>;

// The bridge's handshake. The helper writes the launch's page key, derived from the launch secret (engines/auth.ts),
// readable by the user only. Each side proves it holds the key with an HMAC over both nonces, so a process that took
// over the socket path learns nothing and a peer without the key is refused before any page message. The helper's
// proof also names its pid, which the bridge requires to be its socket's peer (B23's rule for the reader).

const Nonce = z.string().regex(/^[0-9a-f]{64}$/);
const Proof = z.string().regex(/^[0-9a-f]{64}$/);

/** Helper to bridge, first line on every page.sock connection. */
export const EngineChallenge = z.object({ type: z.literal("engineChallenge"), v: z.literal(PROTOCOL_VERSION), nonce: Nonce });
export type EngineChallenge = z.infer<typeof EngineChallenge>;

/**
 * Bridge to helper. `proof` is HMAC-SHA256(key, "caret-page-bridge\n" + challenge nonce + "\n" + nonce), hex.
 * `browser` is the bridge's parent process, the browser that launched it. `extensionId` comes from the origin
 * Chrome passed the bridge.
 */
export const EngineHello = z.object({
  type: z.literal("engineHello"),
  v: z.literal(PROTOCOL_VERSION),
  role: z.literal("page"),
  browser: AppRef,
  extensionId: z.string().regex(/^[a-p]{32}$/),
  bridgeVersion: z.string().min(1),
  nonce: Nonce,
  proof: Proof,
});
export type EngineHello = z.infer<typeof EngineHello>;

/**
 * Helper to bridge after a valid hello. `proof` is HMAC-SHA256(key, "caret-page-helper\n" + bridge nonce + "\n" +
 * challenge nonce + "\n" + pid), hex; `pid` is the helper's own, which the bridge checks against its socket's peer.
 */
export const EngineWelcome = z.object({ type: z.literal("engineWelcome"), v: z.literal(PROTOCOL_VERSION), engine: z.string().min(1), proof: Proof, pid: z.number().int().positive() });
export type EngineWelcome = z.infer<typeof EngineWelcome>;

/** Bridge to extension once the helper proved itself: the engine session id, nothing secret. */
export const EngineReady = z.object({ type: z.literal("engineReady"), v: z.literal(PROTOCOL_VERSION), engine: z.string().min(1) });
export type EngineReady = z.infer<typeof EngineReady>;

/**
 * Part of a helper line too long for one Native Messaging frame (Chrome caps host-to-extension messages at
 * 1 MB). The bridge splits; the worker joins parts by `id` in order and parses the whole.
 */
export const PageChunk = z.object({
  type: z.literal("pageChunk"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  index: z.number().int().nonnegative(),
  count: z.number().int().min(2),
  data: z.string(),
});
export type PageChunk = z.infer<typeof PageChunk>;

/**
 * Focus moved to another element in a frame of the tab the user is in (the active tab of the focused browser
 * window, visible, its document focused). Carries nothing about the element: the helper decides whether to walk the
 * tab (engines/page-focus.ts). The worker sends at most one per tab per 150 ms, and none for a site that is off.
 */
export const PageFocusMoved = z.object({ type: z.literal("pageFocus"), v: z.literal(PROTOCOL_VERSION), at: ms, tabId: z.number().int().nonnegative(), frameId: z.number().int().nonnegative() });
export type PageFocusMoved = z.infer<typeof PageFocusMoved>;

/**
 * "Not on this site": every origin the user turned Caret off for, the whole list each time (the helper's list
 * replaces the worker's). The worker then walks no frame and acts in no frame at these origins, a tab whose top
 * frame is at one answers `siteOff`, and focus there is not reported. The helper sends it after every hello.
 */
export const PageSitesOff = z.object({ type: z.literal("pageSitesOff"), v: z.literal(PROTOCOL_VERSION), origins: z.array(WebOrigin).max(1000) });
export type PageSitesOff = z.infer<typeof PageSitesOff>;

/**
 * The user's own pointer or key press in a frame that holds a live grant (W3): an event the browser marks trusted
 * (`isTrusted`), which page scripts and Caret's own synthetic events cannot produce. Nothing about the element or the
 * key travels. The worker drops the frame's grants at once and sends this; the helper pauses every task acting in the
 * tab, as it does for the reader's userInput.
 */
export const PageInput = z.object({ type: z.literal("pageInput"), v: z.literal(PROTOCOL_VERSION), at: ms, tabId: z.number().int().nonnegative(), frameId: z.number().int().nonnegative(), kind: z.enum(["key", "mouse"]) });
export type PageInput = z.infer<typeof PageInput>;

/**
 * P4: the visible text of `tabId`, once, for a fill that needs its source. The worker reads only the tab the user just
 * left, within LEFT_TAB_MS and unchanged since, on no excluded site (rules 1 to 5; extension worker/left-tab.ts), and
 * answers with a pageResult of the same id carrying `text`, or notAllowed, stale or siteOff and why. Nothing is acted
 * on. Its own message, not a PageVerb, whose every verb but the walk names an element; only engines/tab-source.ts
 * sends it, and the engine must not answer after `expires`.
 */
export const PageReadText = z.object({ type: z.literal("pageReadText"), v: z.literal(PROTOCOL_VERSION), id: z.string().min(1), expires: ms, tabId: z.number().int().nonnegative() });
export type PageReadText = z.infer<typeof PageReadText>;

/** What the extension sends the helper after the handshake. */
export const EngineMessage = z.discriminatedUnion("type", [PageHello, PageSnapshot, PageResult, PagePong, PageFocusMoved, PageInput]);
export type EngineMessage = z.infer<typeof EngineMessage>;
/** What the helper sends the extension after the handshake. ActRevoke is the native one, unchanged. */
export const HelperToEngine = z.discriminatedUnion("type", [PageCommand, ScopedActGrant, ActRevoke, PagePing, PageSitesOff, PageReadText]);
export type HelperToEngine = z.infer<typeof HelperToEngine>;
/** Every message on page.sock or the Native Messaging port, handshake included. */
export const AnyPageMessage = z.union([EngineMessage, HelperToEngine, EngineChallenge, EngineHello, EngineWelcome, EngineReady, PageChunk]);
export type AnyPageMessage = z.infer<typeof AnyPageMessage>;
