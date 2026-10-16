// Shapes the extension speaks. The page wire (helper/src/protocol.ts, "the page engine") is validated with zod on the
// helper's side; here the worker checks only what it needs to route safely (wire.ts). The worker-to-content-script
// messages below never leave the extension.

export type PageControlKind =
  | "text" | "email" | "tel" | "url" | "number" | "search" | "date" | "time" | "datetime" | "month" | "week" | "textarea"
  | "select" | "checkbox" | "radio" | "combobox" | "button" | "link" | "file" | "contenteditable" | "range" | "color";

export type PageExclusion = "password" | "hidden" | "payment" | "oneTimeCode" | "invisible" | "ariaHidden" | "selfIdentification";

export type Rect = [number, number, number, number];

/**
 * Text controls: every input whose type holds typed text (anything but checkbox, radio, file, submit, button, reset,
 * image, range, color and hidden; walker.ts kindOf maps the rest of them here, so a toggle to number or search cannot
 * leave the set), a textarea, a combobox's text and a contenteditable region. Their value never leaves the content
 * script: a walk carries hasValue and rev instead (content/revs.ts), and the type has no `value` to fill in.
 */
export const TEXT_CONTROL_KINDS = ["text", "email", "tel", "url", "number", "search", "date", "time", "datetime", "month", "week", "textarea", "combobox", "contenteditable"] as const;
export type TextControlKind = (typeof TEXT_CONTROL_KINDS)[number];
export type ChoiceControlKind = Exclude<PageControlKind, TextControlKind>;

export function isTextKind(k: PageControlKind): k is TextControlKind {
  return (TEXT_CONTROL_KINDS as readonly string[]).includes(k);
}

/** Why a text control's text is withheld from hasValue, rev, the focused text, compares and copies (content/revs.ts). */
export type Withheld = "secret" | "unknownHistory" | "replacement" | "prefilled" | "programmatic";

interface ControlBase {
  id: string;
  key: string;
  strongKey: string | null;
  role: string;
  name: string;
  form: string | null;
  rect: Rect;
  /**
   * v2/inline: where the control's label text is, in the same viewport pixels as `rect` (walker.ts labelRectOf): a Range
   * over the label's text, not the label element's box, which often spans the row. Absent when no label is drawn.
   */
  labelRect?: Rect;
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
  /** A text input whose inputmode is numeric or decimal (B29): the page compares its value as a number. */
  numeric?: true;
  /** S1: a text input's or textarea's maxlength, when the page sets one. */
  maxLength?: number;
  /** S1: how a text input's or textarea's text was entered since it was last empty (content/entry.ts); absent when no edit was seen. */
  entry?: "typed" | "pasted" | "other";
  /**
   * Issue #26: when the user's own input last reached the control (content/user-input.ts), on this frame's wall clock;
   * absent when none did in the last USER_INPUT_RECENT_MS. Never on an excluded control.
   */
  inputAt?: number;
  /** H14, file inputs only: the accept attribute's extensions and MIME types, lowercased (walker.ts acceptOf). */
  accept?: string[];
  /** W2: the autocomplete attribute's field name, when it is one Caret reads (walker.ts autocompleteOf). */
  autocomplete?: string;
  /**
   * SC1 2a: a password, card or one-time-code field, sent with its kind, role, name, form and rect only (walker.ts
   * markedControl), never a value, options or entry, so the helper knows it is there and never targets it.
   */
  excluded?: "password" | "payment" | "oneTimeCode";
  /**
   * SCP1: the ids of the section occurrences the control sits in, outermost first (content/sections.ts), which the
   * frame's `sections` list. Absent when it is in none.
   */
  sections?: string[];
}

/**
 * A text control as a walk sends it: whether it holds text and its change counter, never its text. `hasValue` and `rev`
 * are null when its text is withheld and it holds some, and for a secret field always (content/revs.ts presence).
 */
export interface TextControl extends ControlBase {
  kind: TextControlKind;
  hasValue: boolean | null;
  rev: number | null;
  withheld?: Withheld;
  value?: never;
  checked?: never;
  options?: never;
}

/** A select, checkbox, radio, button, link, file, range or color control: its state is page text, sent as before. */
export interface ChoiceControl extends ControlBase {
  kind: ChoiceControlKind;
  value?: string;
  checked?: boolean;
  options?: { value: string; label: string; selected: boolean }[];
}

export type PageControl = TextControl | ChoiceControl;

export type PageOutcome = "ok" | "alreadyTrue" | "notAllowed" | "stale" | "failed" | "handoff" | "noElement" | "notSameElement" | "excluded" | "unsupported" | "error" | "siteOff";
export type HandoffRisk = "outbound" | "destructive" | "money" | "system" | "unclassified" | "submitsForm" | "pageScript";

/**
 * What a write found, computed in the page, so no text of the field travels (protocol.ts PageWriteReadings):
 * `sameAsBefore`, the field holds exactly what it held before; `landed`, exactly what Caret wrote; `equivalent`, what
 * Caret wrote under the element's own kind (values/equivalent.ts); `empty`, nothing; `typedBetween`, a trusted event
 * of the user's reached it while Caret wrote; `rev`, its change counter after the write, null for a choice control (a
 * select, a Yes/No question), which has none.
 */
export interface WriteReadings {
  sameAsBefore: boolean;
  landed: boolean;
  equivalent: boolean;
  empty: boolean;
  typedBetween: boolean;
  rev: number | null;
}

/** pageRestore's answer (protocol.ts PageRestored). `rev`: the field's change counter after the restore. */
export type Restored = { outcome: "restored"; rev: number } | { outcome: "refused"; why: "changed" | "mayIncludeInput" | "gone" | "reloaded" | "noRecord" };

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
  /**
   * pageInsertText only, with outcome failed (H13 review): `unchanged`, the field reads as it did before the insert;
   * `unverified`, it changed, but not exactly to its text with the insert at the caret. Nothing is undone.
   */
  insert?: "unchanged" | "unverified";
  /** pageRestore only. */
  restore?: Restored;
  /** pageCompare only, with outcome ok: one answer per candidate, in order. */
  compare?: ("equal" | "equivalent" | "different" | "unknown")[];
  /** pageSourceGrant only, with outcome ok: each id's text, null where it is withheld or gone. */
  source?: Record<string, string | null>;
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
  /** `expectRev`: the rev the walk reported; any other rev now is stale. */
  | ({ kind: "pageWrite"; expectRev: number; value: string } & TargetFields)
  | ({ kind: "pagePress" } & TargetFields)
  /** A select is a choice control: `expect` is the option value the walk sent. */
  | ({ kind: "pageSelect"; expect: string; value: string } & TargetFields)
  /**
   * A combobox takes `expectRev`, its text never having left the page; a press-group option (W4, control "button")
   * takes `expect`, the names of the options pressed before, and `question`, which the content script requires unchanged.
   */
  /** `wrote` (an undo's clear of a combobox, value ""): Caret's own pick, which the control must still show. */
  | ({ kind: "pageChooseOption"; value: string; expectRev?: number; expect?: string; question?: string; wrote?: string } & TargetFields)
  | ({ kind: "pageSetChecked"; checked: boolean } & TargetFields)
  | ({ kind: "pageAttachFile"; file: { name: string; type: string; size: number; sha256: string; data: string } } & TargetFields)
  /** P4 item 8: `text` at the caret of the focused field, whose text before the caret must be `expect` (content/insert.ts). */
  | ({ kind: "pageInsertText"; expect: string; text: string; replace?: number } & TargetFields)
  /**
   * Undo of Caret's own text write (counsel, pageRestore): restores the `before` this page kept, in one page-side step,
   * only while the field is the element Caret wrote, unchanged since (its rev), with no input of the user's, and
   * equivalent to `wrote` (`exact`: equal to it, S1's rule for a write whose answer was lost). The helper never holds
   * `before`.
   */
  | ({ kind: "pageRestore"; wrote: string; exact?: true } & TargetFields)
  /** Whole-value comparison of the field with each candidate, at most 8 per control and 64 per task in this document. */
  | ({ kind: "pageCompare"; candidates: string[] } & TargetFields)
  /**
   * The text of fields `ids` of one frame the user picked as a copy source (counsel, pageSourceGrant): null for any that
   * is withheld, secret or gone. Under the task's grant, as every act.
   */
  | { kind: "pageSourceGrant"; tabId: number; frameId: number; documentId: string; taskId: string; ids: string[] };

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
  /**
   * SCP1: the frame's section occurrences in document order: id, whether a heading, text unless an exclusion took it,
   * and its name's digest, which the worker turns into a salted token and drops (worker/section-names.ts).
   */
  sections?: { id: string; heading: boolean; text?: string; digest?: string }[];
  /** SCP1: digests of section names past the occurrence cap, which have no id or text. */
  sectionOverflow?: string[];
  /** SCP1: the frame has more section names than a walk digests. */
  sectionsCut?: true;
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
  focused: { id: string; selection: [number, number] | null; look?: FieldLook; text: FieldText | null; caret?: [number, number, number, number] | null; hasFocus?: boolean; withheld?: Withheld } | null;
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
  | { caret: 1; op: "walk" }
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
  /** Milliseconds since the last paste, drop, undo or redo in this document, when under 2 s (content/field-text.ts). */
  quietMs?: number;
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
  /** The document's own title, clipped: the read's title comes from the document read, never from the tab. */
  title: string;
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
