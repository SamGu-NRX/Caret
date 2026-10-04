// Shapes the extension speaks. The page wire (helper/src/protocol.ts, "the page engine") is validated with zod on the
// helper's side; here the worker checks only what it needs to route safely (wire.ts). The worker-to-content-script
// messages below never leave the extension.

export type PageControlKind =
  | "text" | "email" | "tel" | "url" | "number" | "search" | "date" | "time" | "datetime" | "month" | "week" | "textarea"
  | "select" | "checkbox" | "radio" | "combobox" | "button" | "link" | "file" | "contenteditable" | "range" | "color";

export type PageExclusion = "password" | "hidden" | "payment" | "oneTimeCode" | "invisible" | "ariaHidden" | "selfIdentification";

export type Rect = [number, number, number, number];

export interface PageControl {
  id: string;
  key: string;
  strongKey: string | null;
  kind: PageControlKind;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  options?: { value: string; label: string; selected: boolean }[];
  form: string | null;
  rect: Rect;
  required?: true;
  disabled?: true;
  invalid?: true;
  shadow?: "open" | "closed";
}

export type PageOutcome = "ok" | "alreadyTrue" | "notAllowed" | "stale" | "failed" | "handoff" | "noElement" | "notSameElement" | "excluded" | "unsupported" | "error" | "siteOff";
export type HandoffRisk = "outbound" | "destructive" | "money" | "system" | "unclassified" | "submitsForm" | "pageScript";

export interface WriteReadings {
  before: string;
  afterInput: string;
  afterBlur: string;
  invalid: boolean;
  error: string | null;
}

/** pageChooseOption's findings (protocol.ts PageChoice). */
export interface Choice {
  flavor: "aria" | "reactSelect";
  matches: string[];
  expanded: boolean | null;
  hiddenInput: "set" | "unchanged" | "none";
}

/** pageAttachFile's findings (protocol.ts PageAttached). */
export interface Attached {
  via: "input" | "drop";
  file: { name: string; size: number } | null;
  shown: boolean;
}

export interface ActAnswer {
  outcome: PageOutcome;
  detail: string | null;
  readings?: WriteReadings;
  risk?: HandoffRisk;
  choice?: Choice;
  attached?: Attached;
}

interface TargetFields {
  tabId: number;
  frameId: number;
  documentId: string;
  id: string;
  control: PageControlKind;
  name: string;
  taskId: string;
  /** false: only the element the walk retained; a replaced one is notSameElement, never rebound (undo, W3). */
  rebind?: false;
}

export type ActVerb =
  | ({ kind: "pageWrite"; expect: string; value: string } & TargetFields)
  | ({ kind: "pagePress" } & TargetFields)
  | ({ kind: "pageSelect"; expect: string; value: string } & TargetFields)
  | ({ kind: "pageChooseOption"; expect: string; value: string } & TargetFields)
  | ({ kind: "pageSetChecked"; checked: boolean } & TargetFields)
  | ({ kind: "pageAttachFile"; file: { name: string; type: string; size: number; sha256: string; data: string } } & TargetFields);

export type PageVerb = { kind: "pageWalk"; tabId: number | null } | ActVerb;

/** What one frame's content script reports for a walk; the worker adds frame ids, document and navGen. */
export interface FrameReport {
  origin: string;
  path: string;
  title: string;
  headings: string[];
  controls: PageControl[];
  iframes: { src: string; rect: Rect; inner: [number, number] }[];
  /** The frame's own viewport, [innerWidth, innerHeight]: 0 by 0 inside an iframe its embedder hides with display:none. */
  viewport: [number, number];
  excluded: Partial<Record<PageExclusion, number>>;
  truncated: boolean;
  focused: { id: string; selection: [number, number] | null } | null;
  hasFocus: boolean;
}

/**
 * Worker to content script. `caret` marks the extension's own messages. `guard` arms the frame's report of the
 * user's own input until `until` (epoch ms; 0 disarms): sent when a grant for the frame arrives and when its last one
 * ends (W3).
 */
export type ToContent =
  | { caret: 1; op: "walk" }
  | { caret: 1; op: "act"; verb: ActVerb; deadline: number }
  | { caret: 1; op: "guard"; until: number };

/** Content script to worker, on its own: the document moved in history (pageshow from the back-forward cache, popstate, hashchange). */
export interface NavChanged {
  caret: 1;
  op: "navChanged";
  why: "pageshow" | "popstate" | "hashchange";
}

/** Content script to worker, on its own: focus moved to another element while this document has focus and is visible. Nothing about the element. */
export interface FocusMoved {
  caret: 1;
  op: "focusMoved";
}

/**
 * Content script to worker, during a multi-stage act (combobox, attach): is the task's grant for this very frame
 * still alive? Asked at each stage boundary, so a revoke that arrives mid-act stops the next stage (memo section 2).
 */
export interface GrantAlive {
  caret: 1;
  op: "grantAlive";
  taskId: string;
}

/**
 * Content script to worker, on its own, only while the worker has armed the frame (a grant covers it): the user
 * pressed a key or a pointer here, an event the browser marked trusted. Nothing about the element or the key (W3).
 */
export interface UserActed {
  caret: 1;
  op: "userInput";
  kind: "key" | "mouse";
}
