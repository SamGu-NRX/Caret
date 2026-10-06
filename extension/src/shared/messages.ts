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
  /**
   * The question a radio or a press-group option answers, and an id for its group (W4): a radio's fieldset legend or
   * the text around its group; for a toggle button of a Yes/No question (content/question.ts pressGroup), that question.
   */
  group?: { id: string; name: string };
  /** A press-group option's aria-pressed (W4). */
  pressed?: boolean;
  /** A text input whose inputmode is numeric or decimal (B29): undo compares its value as a number. */
  numeric?: true;
  /** S1: a text input's or textarea's maxlength, when the page sets one. */
  maxLength?: number;
  /** S1: how a text input's or textarea's text was entered since it was last empty (content/entry.ts); absent when no edit was seen. */
  entry?: "typed" | "pasted" | "other";
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
  flavor: "aria" | "reactSelect" | "pressGroup";
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

/**
 * What showed that the page changed after a Yes/No press (B28): the frame's navigation generation moved (`navigated`),
 * a navigation began in it (`navigationStarted`), or its document lost its answer channel (`documentGone`), as the
 * worker saw; or the frame fired beforeunload, pagehide or submit, as the content script saw.
 */
export type PageChange = "navigated" | "navigationStarted" | "documentGone" | "beforeunload" | "pagehide" | "submit";

/**
 * P4: what a text read of the tab the user just left found (protocol.ts PageTabText). `leftAt`: when the user left the
 * tab; `frames`: every frame whose text is in it, top first.
 */
export interface TabText {
  tabId: number;
  leftAt: number;
  title: string;
  frames: { frameId: number; origin: string }[];
  selection: string[];
  blocks: string[];
  cut: boolean;
  docsText: "on" | "off" | null;
}

export interface ActAnswer {
  outcome: PageOutcome;
  detail: string | null;
  /** pageReadText only, with outcome ok. */
  text?: TabText;
  readings?: WriteReadings;
  risk?: HandoffRisk;
  choice?: Choice;
  attached?: Attached;
  /** With outcome failed only: the press may have landed and the page then changed, so the run stops (B28). */
  pageChanged?: PageChange[];
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
  /** A forward write's undo mark: the element the act reaches is kept under it. */
  mark?: string;
  /** An undo's: the element at `id` must be the one kept under this mark. */
  sameAs?: string;
}

export type ActVerb =
  | ({ kind: "pageWrite"; expect: string; value: string } & TargetFields)
  | ({ kind: "pagePress" } & TargetFields)
  | ({ kind: "pageSelect"; expect: string; value: string } & TargetFields)
  /** `question` (W4): for a press-group option, the question the plan names; the content script requires it unchanged. */
  | ({ kind: "pageChooseOption"; expect: string; value: string; question?: string } & TargetFields)
  | ({ kind: "pageSetChecked"; checked: boolean } & TargetFields)
  | ({ kind: "pageAttachFile"; file: { name: string; type: string; size: number; sha256: string; data: string } } & TargetFields)
  /** P4 item 8: `text` at the caret of the focused field, whose text before the caret must be `expect` (content/insert.ts). */
  | ({ kind: "pageInsertText"; expect: string; text: string } & TargetFields);

export type PageVerb = { kind: "pageWalk"; tabId: number | null } | ActVerb;

/**
 * H10: how the focused field draws its text, so the host can draw a fill value where the user's own typing would go:
 * the text's left inset (padding and border, CSS pixels), its font size (CSS pixels), whether a placeholder shows now,
 * and whether its text is light (a dark field). No text of the page travels.
 */
export interface FieldLook {
  inset: number;
  fontSize: number;
  placeholder: boolean;
  dark: boolean;
}

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
  /**
   * H10: the browser window's outer frame as the page sees it, [screenX, screenY, outerWidth, outerHeight], in screen
   * points with a top-left origin. Measured in the rig VM (evidence/host/h10/probe): Chrome for Testing reported the
   * window server's own frame for its window here, at 100% and 125% page zoom alike. The worker reads the top frame's.
   */
  screen: [number, number, number, number];
  excluded: Partial<Record<PageExclusion, number>>;
  truncated: boolean;
  /** P4 item 7: `text`, the text around the caret of a focused text control (content/field-text.ts); null when it holds none. */
  focused: { id: string; selection: [number, number] | null; look?: FieldLook; text: FieldText | null; caret?: [number, number, number, number] | null; hasFocus?: boolean } | null;
  /** P4 items 6 and 7: a Google Docs or Sheets editor's top frame only (content/field-text.ts docsFocus). */
  docs?: { kind: "document" | "spreadsheet"; text: "on" | "off"; field: FieldText | null };
  hasFocus: boolean;
  /** P1: how long this frame's own walk took in the page, in ms (performance.now, rounded to 0.1). */
  walkMs: number;
}

/**
 * Worker to content script. `caret` marks the extension's own messages. `guard` arms the frame's report of the
 * user's own input until `until` (epoch ms; 0 disarms): sent when a grant for the frame arrives and when its last one
 * ends (W3). An act arms its document too, until `guardUntil` (its grant's end), so no act runs unarmed.
 */
export type ToContent =
  /** `caretText: false` (P4): a frame on a site on the deny list reports no text around the caret. */
  | { caret: 1; op: "walk"; caretText?: false }
  /** P4: about the frame itself, no text (FrameSelfAnswer), so the worker knows it is visible before it asks for text. */
  | { caret: 1; op: "frame" }
  /**
   * P4: the frame's visible text, once, for the tab the user just left (content/text.ts). Answered with FrameTextAnswer;
   * nothing after `until` (epoch ms), or from a frame whose own viewport is a pixel or less (its iframe was hidden).
   */
  | { caret: 1; op: "text"; until: number }
  /** The frame's viewport only, [innerWidth, innerHeight]: asked of a captcha frame, which is never walked (W4). */
  | { caret: 1; op: "viewport" }
  | { caret: 1; op: "act"; verb: ActVerb; deadline: number; guardUntil: number }
  | { caret: 1; op: "guard"; until: number };

/** The text around the caret of the field the user is typing in (P4 item 7; content/field-text.ts). */
export interface FieldText {
  before: string;
  after: string;
  selection: string;
}

/**
 * P4: one frame's answer about itself before a text read, with no text: what composition needs to tell whether the
 * frame is visible (its origin, viewport and visible iframes, as a walk reports them).
 */
export interface FrameSelfAnswer {
  origin: string;
  viewport: [number, number];
  iframes: { src: string; rect: Rect; inner: [number, number] }[];
}

/** P4: one visible frame's text (content/text.ts FrameTextReport). */
export interface FrameTextAnswer {
  selection: string[];
  blocks: string[];
  cut: boolean;
  docsText: "on" | "off" | null;
}

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
