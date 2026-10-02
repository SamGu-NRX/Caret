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

export const ReaderMessage = z.discriminatedUnion("type", [Hello, Snapshot, Focus, AppSwitch, WindowClosed, Pasteboard]);
export type ReaderMessage = z.infer<typeof ReaderMessage>;

/** Consumer asks for a fill proposal for the form around one field, without waiting for a focus event. */
export const FillRequest = z.object({
  type: z.literal("fillRequest"),
  v: z.literal(PROTOCOL_VERSION),
  windowId: z.string(),
  fieldKey: z.string(),
});
export type FillRequest = z.infer<typeof FillRequest>;

export const ConsumerMessage = z.discriminatedUnion("type", [Hello, FillRequest]);
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

export const FillField = z.object({
  key: z.string(),
  /** Where the field is on screen, so a consumer can draw the proposed value in place. */
  frame: Frame.nullable(),
  descriptor: z.string(),
  /** Jev's choice: a candidate id, or "none". */
  choice: z.string(),
  confidence: z.number(),
  /** The chosen candidate's text, copied verbatim by code. Null when the choice is "none". */
  value: z.string().nullable(),
  source: FillSource.nullable(),
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
  jev: z.object({
    model: z.string(),
    latencyMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
});
export type FillProposal = z.infer<typeof FillProposal>;

export const HelperError = z.object({
  type: z.literal("error"),
  v: z.literal(PROTOCOL_VERSION),
  at: ms,
  message: z.string(),
});
export type HelperError = z.infer<typeof HelperError>;

export const HelperMessage = z.discriminatedUnion("type", [FillProposal, HelperError]);
export type HelperMessage = z.infer<typeof HelperMessage>;

/** Every message that may appear on the socket in either direction. */
export const AnyMessage = z.union([ReaderMessage, FillRequest, HelperMessage]);
export type AnyMessage = z.infer<typeof AnyMessage>;
