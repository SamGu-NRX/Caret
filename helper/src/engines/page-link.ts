// The executor's ReaderLink for one page engine. The executor speaks reader verbs (walk, write, press) about
// windows; for a page window this link turns them into page verbs on the element the last walk named, applies the
// tab's snapshot to the screen model before answering, as the reader does, and maps the page outcome back onto
// the reader's. Its grant() turns the executor's one-window ActGrant into one ScopedActGrant per frame of the tab
// as last walked, each pinned to that frame's origin and navigation generation.
import { canonicalOrigin } from "../privacy/denied-origins.ts";
import { excludedSection } from "./page-exclusions.ts";
import { PAGE_CHECKED, PAGE_SUBROLE, PROTOCOL_VERSION, isTextKind, type ActGrant, type ActRevoke, type CalendarGrant, type Node, type NodeState, type PageControl, type PageControlKind, type PageFrame, type PageResult, type PageSnapshot, type PageVerb, type ReaderVerb, type Snapshot, type TextPageControl, type VerbOutcome, type VerbResult } from "../protocol.ts";
import type { ReaderLink } from "../executor/means.ts";
import type { EngineSession } from "./session.ts";
import { ConfirmedFiles } from "./attach.ts";
import { PAGE_WINDOW_KIND, pageWindowId, parsePageWindow } from "./windows.ts";

/**
 * The reader role a page control reads as, so plans, the planner and fill (fill/controls.ts) see pages as they see
 * native forms. A time input is AXTimeField, as Chrome's Accessibility shows it (B24 capture-2); as AXDateField, fill
 * took it for a date. The roles of datetime, month and week inputs are not captured; they stay AXDateField.
 */
const ROLE: Record<PageControlKind, string> = {
  text: "AXTextField", email: "AXTextField", tel: "AXTextField", url: "AXTextField", number: "AXTextField", search: "AXTextField",
  date: "AXDateField", time: "AXTimeField", datetime: "AXDateField", month: "AXDateField", week: "AXDateField",
  textarea: "AXTextArea", select: "AXPopUpButton", checkbox: "AXCheckBox", radio: "AXRadioButton", combobox: "AXComboBox",
  button: "AXButton", link: "AXLink", file: "AXButton", contenteditable: "AXTextArea", range: "AXSlider", color: "AXColorWell",
};

/**
 * The subrole a file input's node carries (H5). Chrome's Accessibility shows a file input as a button, so the role
 * alone cannot tell it from one; the planner reads this to find where a confirmed file goes (planner/attach.ts).
 * H5 and D2-04 each named one; it is D2-04's PAGE_SUBROLE.file, so fill and attach read the same node the same way.
 */
export const FILE_INPUT_SUBROLE = PAGE_SUBROLE.file;

/** Kinds a pageWrite sets. A contenteditable is a hand-off in v1 (memo section 1, write path). */
export const TEXT_KINDS: ReadonlySet<PageControlKind> = new Set(["text", "email", "tel", "url", "number", "search", "date", "time", "datetime", "month", "week", "textarea"]);

/**
 * P4 item 8: kinds pageInsertText types into: those whose caret Chrome exposes (an email or number input has none) and a
 * contenteditable editor (extension content/field-text.ts).
 */
export const INSERT_KINDS: ReadonlySet<PageControlKind> = new Set(["text", "search", "url", "tel", "textarea", "contenteditable"]);

/** Kinds the executor may write a value to: text, a native select (by option label) and a custom listbox (by option name). */
export const VALUE_KINDS: ReadonlySet<PageControlKind> = new Set([...TEXT_KINDS, "select", "combobox"]);

/**
 * How long a combobox pick or a file attach may take. Each waits for the page (the list to open and settle, the pick or
 * the file name to show: up to about 4 s in content/combobox.ts), so they get longer than COMMAND_TIMEOUT_MS. Assumed.
 */
export const SLOW_VERB_TIMEOUT_MS = 10_000;

/**
 * Marks one link remembers; past this the oldest is forgotten, and an undo under it is refused rather than guessed.
 * Assumed, as the reader's bound is: a run writes tens of fields, and undo follows within the activity list's day.
 */
export const MAX_MARKS = 512;

/**
 * How long after the last patched act (see act()) the link walks the tab once, so the model catches what the page did
 * in reaction (a revealed field, reformatting, another injector). Each later act on the tab pushes it back; any walk of
 * the tab cancels it. Assumed, not measured: long enough that an executor's next step (whose refresh walk cancels it)
 * normally comes first, so it runs once at the end of a run of writes.
 */
export const TRAILING_WALK_MS = 150;

/**
 * What the helper itself knows a page text field holds, though the page never sends it (counsel 2026-10-09): the value
 * Caret wrote, or the one the page answered was already there, or the one Caret put back, at the rev the page reported
 * then. While the walk reports that same rev, the field's node holds this text; once the rev moves, the node is unread.
 */
export interface KnownText {
  text: string;
  rev: number;
}

/** A text field's place in a tab's walks: frame, document and registry id. */
const knownKey = (frameId: number, documentId: string, id: string): string => `${frameId}:${documentId}:${id}`;
const restoreKey = (v: { tabId: number; frameId: number; documentId: string; id: string; taskId: string }): string => `${v.tabId}:${knownKey(v.frameId, v.documentId, v.id)}:${v.taskId}`;

/**
 * What a text control's node holds: "" for a field the page says is empty, the helper's own known text while the rev is
 * the one it knew it at, and otherwise nothing it can read (`unread`). Never a value the page sent: it sends none.
 */
export function textValueOf(c: TextPageControl, known: KnownText | undefined): { value: string } | { unread: true } {
  if (c.hasValue === false) return { value: "" };
  if (c.hasValue === true && c.rev !== null && known !== undefined && known.rev === c.rev) return { value: known.text };
  return { unread: true };
}

/** The page element a forward write went to, kept under the write's mark so its undo can require the same element. */
interface MarkedElement {
  tabId: number;
  frameId: number;
  documentId: string;
  id: string;
}

export interface PageTargetRef {
  frameId: number;
  documentId: string;
  id: string;
  control: PageControl;
}

const frameKey = (frameId: number): string => `f${frameId}`;
const nodeKey = (frameId: number, c: PageControl): string => `${frameKey(frameId)}/${c.key}`;

/**
 * The group node a radio button sits under, as Chrome's Accessibility puts a fieldset's radios under an AXGroup
 * (B24 capture-2), so fill reads one radio group per set of buttons and not one per frame. Buttons that share an
 * author-chosen identifier (the `name` attribute, in strongKey) in one form are one group. A button without one
 * gets a group of its own, which fill does not offer (a group needs two buttons), rather than joining every other
 * such button of the frame. The group is labelled with the question its buttons answer (PageControl.group: the
 * fieldset legend, else the text around the group, W4), which fill reads as the radio group's label.
 */
function radioGroupKey(frameId: number, c: PageControl): string {
  // W4: the walk's own group (the buttons that share a name attribute in the page, whatever the name looks like):
  // Lever names its radios "cards[<uuid>][field0]", which strongKey rejects as generated, so every button stood alone.
  if (c.group !== undefined) return `${frameKey(frameId)}/radiogroup:${c.group.id}`;
  const ident = c.strongKey === null ? null : (JSON.parse(c.strongKey) as unknown[])[2];
  return `${frameKey(frameId)}/radiogroup:${typeof ident === "string" ? `${c.form ?? ""}/${ident}` : c.key}`;
}

/** A frame's radio buttons under one group node, in walk order. */
function radioMembers(f: PageFrame, groupKey: string): PageControl[] {
  return f.controls.filter((c) => c.kind === "radio" && radioGroupKey(f.frameId, c) === groupKey);
}

/** The radio group a node key names in a tab's last walk: its frame and buttons, or null (D2-04). */
export function radioGroupFor(s: PageSnapshot | undefined, key: string): { frameId: number; documentId: string; buttons: PageControl[] } | null {
  if (s === undefined) return null;
  for (const f of s.frames) {
    const buttons = radioMembers(f, key);
    if (buttons.length > 0) return { frameId: f.frameId, documentId: f.documentId, buttons };
  }
  return null;
}

/** Issue #26: a radio or press group's node carries its buttons' latest input (PageControl.inputAt), since a write targets the group. */
function latestInput(members: readonly PageControl[]): { inputAt?: number } {
  const at = Math.max(...members.map((m) => m.inputAt ?? -1));
  return at < 0 ? {} : { inputAt: at };
}

/** The node key of a press group (W4): one per group container, by the registry id the walk gave it. */
const pressGroupKey = (frameId: number, groupId: string): string => `${frameKey(frameId)}/pressgroup:${groupId}`;

/** A press-group option: a toggle button of a Yes/No question (content/question.ts pressGroup). */
const isPressOption = (c: PageControl): c is PageControl & { group: { id: string; name: string }; pressed: boolean } => c.kind === "button" && c.group !== undefined && c.pressed !== undefined;

/** What a press group shows as its answer: the pressed options' names, comma-joined ("" for none), as content/press.ts reads it. */
function pressedValue(options: readonly PageControl[]): string {
  return options.filter((o) => o.pressed === true).map((o) => o.name).join(", ");
}

/** The reader-like subrole of a page control whose role alone does not say what fill must know (PAGE_SUBROLE). */
function subroleOf(c: PageControl): string | undefined {
  switch (c.kind) {
    case "date":
    case "time":
    case "datetime":
    case "month":
    case "week":
    case "file":
      return PAGE_SUBROLE[c.kind];
    case "number":
      return PAGE_SUBROLE.number;
    case "text":
      return c.numeric === true ? PAGE_SUBROLE.number : undefined;
    case "checkbox":
      return c.role === "switch" ? PAGE_SUBROLE.switch : undefined;
    default:
      return undefined;
  }
}

/**
 * A rect of the top frame's viewport (CSS pixels, PageRect) in screen points, top-left origin (Frame), or null when the
 * walk did not say where the viewport is (PageSnapshot.view).
 *
 * The viewport is taken to fill the window's width from its left edge and to end at its bottom edge, with the browser's
 * own toolbars, tab strip and infobars above it. Measured in the rig VM (evidence/host/h10/probe): Chrome for Testing's
 * page read the window server's own frame as its screen position and outer size, and the space above the viewport was
 * outerHeight − innerHeight × zoom (143 points, with Chrome for Testing's infobar) at 100% and at 125% zoom alike. That
 * space is not a constant: H5 assumed an 88-point toolbar. Developer tools docked beside or below the page break the
 * edges assumed here; a fill offer would then be drawn off its field. Not measured.
 */
export function screenRect(view: NonNullable<PageSnapshot["view"]>, rect: readonly [number, number, number, number]): [number, number, number, number] {
  const [wx, wy, , wh] = view.window;
  const z = view.zoom;
  const top = wy + wh - view.viewport[1] * z;
  return [wx + rect[0] * z, top + rect[1] * z, rect[2] * z, rect[3] * z];
}

/** The smallest rect holding every one of `rects`, or null for none. */
function union(rects: readonly (readonly [number, number, number, number])[]): [number, number, number, number] | null {
  if (rects.length === 0) return null;
  const x0 = Math.min(...rects.map((r) => r[0]));
  const y0 = Math.min(...rects.map((r) => r[1]));
  const x1 = Math.max(...rects.map((r) => r[0] + r[2]));
  const y1 = Math.max(...rects.map((r) => r[1] + r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/** SCP1: an outline occurrence's key in the window: its frame's web area key and its id in that frame's walk. */
const occurrenceKey = (frameId: number, id: string): string => `${frameKey(frameId)}#${id}`;

/** SCP1: a control's sections as its node carries them, by occurrence key; a radio or press group takes its first option's. */
const sectionsOf = (frameId: number, c: PageControl): Pick<Node, "sections"> => (c.sections === undefined || c.sections.length === 0 ? {} : { sections: c.sections.map((id) => occurrenceKey(frameId, id)) });

/**
 * SCP1: the frame's section occurrences as its web area node carries them, with any text the walk's self-identification
 * exclusion matches taken out again here (page-exclusions.ts): an occurrence keeps its key, its place and its name's
 * token, so it still ends the section before it and still counts as a section of that name, and loses only its text.
 * One source of section text: a frame with an outline carries no separate heading list; one from an extension before
 * SCP1 carries its heading list alone.
 */
function frameSections(f: PageFrame): Pick<Node, "headings" | "outline" | "sectionNames" | "sectionsCut"> {
  const outline = (f.sections ?? []).map((o) => ({ key: occurrenceKey(f.frameId, o.id), heading: o.heading, ...(o.text === undefined || excludedSection(o.text) ? {} : { text: o.text }), ...(o.name === undefined ? {} : { name: o.name }) }));
  const headings = outline.length > 0 ? [] : f.headings.filter((h) => !excludedSection(h));
  return { ...(headings.length === 0 ? {} : { headings }), ...(outline.length === 0 ? {} : { outline }), ...(f.sectionNames === undefined || f.sectionNames.length === 0 ? {} : { sectionNames: f.sectionNames }), ...(f.sectionsCut === true ? { sectionsCut: true as const } : {}) };
}

/**
 * The window snapshot the screen model takes for a tab: one AXWebArea per frame, its controls below it.
 *
 * A press group (W4: Ashby's Yes/No questions built from toggle buttons) reads as Chrome shows a radio group: an AXGroup
 * labelled with the question, holding one AXRadioButton per option, checked when pressed. The group node holds the
 * answer as its value and is editable: a write of an option's name is the one press the page engine makes there
 * (pageChooseOption on that option, content/press.ts), verified by aria-pressed afterwards.
 *
 * D2-04: a radio group's node does the same for its buttons: it holds the checked button's name ("" for none) and is
 * editable, and a write of a button's name checks that button (pageSetChecked), verified by its checked state. A
 * checkbox holds PAGE_CHECKED while ticked and "" while not, and is editable the same way. So the executor reads,
 * writes, verifies and undoes both as it does a text field.
 */
/**
 * Whether a tab's page is at a site Caret may read: its top frame reported, and its origin not switched off. The one
 * check every reader of a tab's walk makes before it takes the tab's title, frames or headings (SC1 2a).
 */
export function topFrameOn(s: PageSnapshot, off: ReadonlySet<string>): boolean {
  const top = s.frames.find((f) => f.parentFrameId < 0);
  return top !== undefined && !off.has(canonicalOrigin(top.origin));
}

export function toWindowSnapshot(s: PageSnapshot, session: EngineSession, seq: number, known: (frameId: number, documentId: string, id: string) => KnownText | undefined = () => undefined): Snapshot {
  const nodes: Node[] = [];
  let focusedKey: string | null = null;
  const view = s.view ?? null;
  // SC1 2a: a frame at a site the user turned Caret off for never enters the model, whatever the engine sent. A tab whose
  // top frame is at such a site is that site's page: none of its frames enters, nor its title (PV2 review). A walk with
  // no report from its top frame is of a site Caret cannot know, so it fails closed the same way (PV2 re-review).
  const tabOff = !topFrameOn(s, session.offSites);
  const kept = new Set(tabOff ? [] : s.frames.filter((f) => !session.offSites.has(canonicalOrigin(f.origin))).map((f) => f.frameId));
  for (const f of s.frames) {
    if (!kept.has(f.frameId)) continue;
    // H10: screen frames for the top frame's nodes only. A child frame's rects are in its own viewport, whose place in
    // the page this walk does not pin down; its controls have no frame, so the host draws no offer at them.
    const onScreen = view !== null && f.parentFrameId < 0 ? (r: readonly [number, number, number, number]) => ({ frame: screenRect(view, r) }) : () => ({});
    const groupFrame = (members: readonly PageControl[]) => {
      const u = view !== null && f.parentFrameId < 0 ? union(members.map((m) => screenRect(view, m.rect))) : null;
      return u === null ? {} : { frame: u };
    };
    nodes.push({ key: frameKey(f.frameId), parent: f.parentFrameId < 0 || !kept.has(f.parentFrameId) ? null : frameKey(f.parentFrameId), role: "AXWebArea", label: f.title || `${f.origin}${f.path}`, ...frameSections(f), ...(view !== null && f.parentFrameId < 0 ? onScreen([0, 0, view.viewport[0], view.viewport[1]]) : {}) });
    const groups = new Set<string>();
    for (const c of f.controls) {
      if (c.excluded !== undefined) {
        // SC1 2a: a control the walker marks arrives with no value; it reads as a secure field does through Accessibility,
        // so nothing targets it, and the model keeps it marked (privacy/exclude.ts).
        const focusedHere = s.focused !== null && s.focused.frameId === f.frameId && s.focused.id === c.id;
        if (focusedHere) focusedKey = nodeKey(f.frameId, c);
        nodes.push({ key: nodeKey(f.frameId, c), parent: frameKey(f.frameId), role: ROLE[c.kind], label: c.name, ...(VALUE_KINDS.has(c.kind) ? { editable: true as const } : {}), states: focusedHere ? ["focused", "secure"] : ["secure"], excluded: c.excluded, ...onScreen(c.rect) });
        continue;
      }
      let parent = frameKey(f.frameId);
      if (c.kind === "radio") {
        parent = radioGroupKey(f.frameId, c);
        if (!groups.has(parent)) {
          groups.add(parent);
          const members = radioMembers(f, parent);
          const checked = members.find((m) => m.checked === true);
          nodes.push({ key: parent, parent: frameKey(f.frameId), role: "AXGroup", subrole: "AXFieldset", ...(c.group === undefined ? {} : { label: c.group.name }), value: checked?.name ?? "", editable: true, ...sectionsOf(f.frameId, c), ...groupFrame(members), ...latestInput(members) });
        }
      }
      const press = isPressOption(c);
      if (press) {
        parent = pressGroupKey(f.frameId, c.group.id);
        if (!groups.has(parent)) {
          groups.add(parent);
          const options = f.controls.filter((o) => isPressOption(o) && o.group.id === c.group.id);
          nodes.push({ key: parent, parent: frameKey(f.frameId), role: "AXGroup", subrole: PAGE_SUBROLE.pressGroup, label: c.group.name, value: pressedValue(options), editable: true, ...sectionsOf(f.frameId, c), ...groupFrame(options), ...latestInput(options) });
        }
      }
      const states: NodeState[] = [];
      if (s.focused !== null && s.focused.frameId === f.frameId && s.focused.id === c.id) {
        states.push("focused");
        focusedKey = nodeKey(f.frameId, c);
      }
      if (c.checked === true || (press && c.pressed === true)) states.push("checked");
      if (c.disabled === true) states.push("disabled");
      // A select shows its selected option's label, unless that option's value is empty: then it is the HTML placeholder,
      // and nothing is chosen whatever it says (HubSpot's "Employees*" select shows a prompt with value ""), so the node
      // holds no value and fill counts it unfilled (I2's queue, W4).
      const selected = c.kind === "select" ? c.options?.find((o) => o.selected) : undefined;
      const box = c.kind === "checkbox";
      // A text control's text never came: the node holds "" for an empty one, the helper's own known text, or is unread.
      // By kind, never by shape: a text control that came with no hasValue is unread, and its value is never read.
      const text = isTextKind(c.kind) ? ("hasValue" in c ? textValueOf(c, known(f.frameId, f.documentId, c.id)) : { unread: true as const }) : null;
      const value = text !== null ? ("value" in text ? text.value : undefined) : c.kind === "select" ? (selected === undefined ? undefined : selected.value === "" ? "" : selected.label) : box ? (c.checked === true ? PAGE_CHECKED : "") : c.value;
      const subrole = subroleOf(c);
      nodes.push({
        key: nodeKey(f.frameId, c),
        parent,
        role: press ? "AXRadioButton" : ROLE[c.kind],
        ...(subrole === undefined || press ? {} : { subrole }),
        label: c.name,
        ...(value === undefined ? {} : { value }),
        ...(text !== null && "unread" in text ? { unread: true as const } : {}),
        ...("rev" in c && c.rev !== null ? { rev: c.rev } : {}),
        // A custom listbox takes a value too (pageChooseOption picks the option named exactly that), and so does a native
        // select (pageSelect, verified by selectedOptions; W3) and a checkbox (pageSetChecked, D2-04): without `editable`
        // the executor never reaches their write.
        ...(VALUE_KINDS.has(c.kind) || box ? { editable: true as const } : {}),
        ...(states.length > 0 ? { states } : {}),
        ...onScreen(c.rect),
        // S1: what saved answers need: the field's maxlength, and whether the user typed its text themselves.
        ...(c.maxLength === undefined ? {} : { maxLength: c.maxLength }),
        ...(c.entry === undefined ? {} : { entry: c.entry }),
        // Issue #26: the user's own input on it, which a recovery read after Stop checks (executor.ts readUnconfirmed).
        ...(c.inputAt === undefined ? {} : { inputAt: c.inputAt }),
        // H14: the types a file control's chooser may offer, for its attach row.
        ...(c.accept === undefined ? {} : { accept: c.accept }),
        // W2: a text input's own kind, which the write contract checks a value's shape against (fill/contract.ts).
        ...(TEXT_KINDS.has(c.kind) ? { inputKind: c.kind as NonNullable<Node["inputKind"]> } : {}),
        ...(c.autocomplete === undefined ? {} : { autocomplete: c.autocomplete }),
        ...sectionsOf(f.frameId, c),
      });
      // A native select's options, as the AXMenuItem children fill reads a select's options from (controls.ts), so a
      // hand-off for it can name one. Chrome's Accessibility shows only the selected one. An option whose value is
      // empty is the HTML placeholder ("Select..."), not a choice.
      if (c.kind === "select")
        for (const [i, o] of (c.options ?? []).entries())
          if (o.value !== "" && o.label.trim() !== "") nodes.push({ key: `${nodeKey(f.frameId, c)}/option~${i}`, parent: nodeKey(f.frameId, c), role: "AXMenuItem", label: o.label });
    }
  }
  return {
    type: "snapshot",
    v: PROTOCOL_VERSION,
    seq,
    at: s.at,
    reason: "request",
    app: session.info.browser,
    window: { windowId: pageWindowId(session.info.engine, s.tabId), kind: PAGE_WINDOW_KIND, title: tabOff ? "" : s.title, frame: view === null ? null : [...view.window] },
    // The selected tab of a background browser window is not where the user is (W3): only the selected tab of the
    // window Chrome last focused counts, and the model's frontmost app (the reader's) decides whether that browser does.
    focused: s.active && s.inFocusedWindow,
    root: null,
    nodes,
    values: [],
    focusedKey,
    // The extension's own walk time (P1); 0 from an extension built before it reported one.
    stats: { walkMs: s.walkMs ?? 0, visited: nodes.length, truncated: s.frames.some((f) => f.truncated) || s.missing.length > 0 },
  };
}

/** The press group a node key names in a tab's last walk: its frame, question and options, or null. */
export function pressGroupFor(s: PageSnapshot | undefined, key: string): { frameId: number; documentId: string; question: string; options: PageControl[] } | null {
  if (s === undefined) return null;
  for (const f of s.frames) {
    const options = f.controls.filter((c) => isPressOption(c) && pressGroupKey(f.frameId, c.group.id) === key);
    if (options.length > 0) return { frameId: f.frameId, documentId: f.documentId, question: options[0]?.group?.name ?? "", options };
  }
  return null;
}

/** The element a node key names in a tab's last walk, or null. */
/**
 * H13: the walked element a key names, as one opaque string: its frame, its document and its id in that document's
 * registry. A node key is a label and an ordinal, so a page that replaces a field with another of the same label keeps
 * the key; this token changes. The host gets it with the field (pageField) and gives it back with an insert.
 */
export function elementToken(t: { frameId: number; documentId: string; id: string }): string {
  return `${t.frameId}:${t.documentId}:${t.id}`;
}

export function targetFor(s: PageSnapshot | undefined, key: string): PageTargetRef | null {
  if (s === undefined) return null;
  for (const f of s.frames) for (const c of f.controls) if (nodeKey(f.frameId, c) === key) return { frameId: f.frameId, documentId: f.documentId, id: c.id, control: c };
  return null;
}

function verbResult(outcome: VerbOutcome, detail: string | null): VerbResult {
  return { type: "verbResult", v: PROTOCOL_VERSION, id: "page", at: Date.now(), outcome, detail };
}

/**
 * A page outcome as the executor reads a reader outcome. `failed` with the old value back is `changed` (nothing
 * landed, the run stops). A failed write that left another value, or that stopped midway with no readings (the
 * field changed under it), is `axError`, which the executor treats as "may have landed" and judges by re-reading.
 * A failed press with `pageChanged` keeps it, so the executor stops without judging (B28).
 */
export function toVerbOutcome(r: PageResult): VerbResult {
  const detail = r.detail === null ? r.outcome : `${r.outcome}: ${r.detail}`;
  switch (r.outcome) {
    case "ok":
    case "alreadyTrue":
      return verbResult("ok", r.outcome === "alreadyTrue" ? "alreadyTrue" : null);
    case "notAllowed":
      return verbResult("notAllowed", detail);
    case "stale":
      if (r.restore?.outcome === "refused") return restoreRefusal(r.restore.why, detail);
      return verbResult("changed", detail);
    case "noElement":
      return verbResult("noElement", detail);
    case "notSameElement":
      if (r.restore?.outcome === "refused") return restoreRefusal(r.restore.why, detail);
      return verbResult("notSameElement", detail);
    case "excluded":
      return verbResult("secure", detail);
    case "handoff":
      return verbResult("notAllowed", detail);
    case "failed":
      // A Yes/No press after which the page navigated or submitted (B28): may have landed, and the executor stops at once.
      if (r.pageChanged !== undefined) return { ...verbResult("axError", detail), pageChanged: r.pageChanged };
      // An inline insert (H13 review): the field as it was is nothing landed; any other change may have.
      if (r.insert === "unchanged") return { ...verbResult("changed", detail), insert: "unchanged" };
      if (r.insert === "unverified") return { ...verbResult("axError", detail), insert: "unverified" };
      // An undo the page refused for good: the field changed, or holds input, or is not the element Caret wrote.
      if (r.restore?.outcome === "refused") return restoreRefusal(r.restore.why, detail);
      return verbResult(r.readings === undefined || !r.readings.sameAsBefore ? "axError" : "changed", detail);
    case "unsupported":
    case "error":
      return verbResult("axError", detail);
    case "siteOff":
      return verbResult("notAllowed", detail);
  }
}

/**
 * A refused pageRestore as the executor reads a refused undo: the field changed or may hold the user's input is
 * `changed`; a field that is gone, replaced, in a reloaded page or of which the page keeps no record is `notSameElement`.
 * The detail names why, never the field's text.
 */
function restoreRefusal(why: NonNullable<Extract<PageResult["restore"], { outcome: "refused" }>>["why"], detail: string): VerbResult {
  return verbResult(why === "changed" || why === "mayIncludeInput" ? "changed" : "notSameElement", `${detail} (${why})`);
}

/**
 * Whether a failed dropdown pick was put back, by the page's own readings (C1, lead decision for item 4): the combobox
 * handler stopped (content/combobox.ts stopped) with the control showing what it showed before, the list closed by
 * aria-expanded=false, and react-select's form value unchanged. Anything else (no readings: it may have landed; other
 * text; a list still open or a control that says nothing about it; a form value that moved; a Yes/No press) is not.
 */
export function restoredPick(verb: PageVerb, r: PageResult): boolean {
  if (verb.kind !== "pageChooseOption" || verb.control !== "combobox") return false;
  if (r.outcome !== "failed" || r.pageChanged !== undefined || r.readings === undefined || r.choice === undefined) return false;
  return r.readings.sameAsBefore && r.choice.expanded === false && r.choice.hiddenInput !== "set";
}

/**
 * The reader role a key's node has in a tab's last walk, as toWindowSnapshot projects it: AXGroup for a radio or press
 * group, the control's ROLE otherwise; null when no control has the key. A verb whose role is not this one was resolved
 * against another kind of control (D2-06 re-check: a select replaced by a combobox at the same key), and is refused.
 */
export function projectedRole(s: PageSnapshot | undefined, key: string): string | null {
  if (pressGroupFor(s, key) !== null || radioGroupFor(s, key) !== null) return "AXGroup";
  const t = targetFor(s, key);
  return t === null ? null : ROLE[t.control.kind];
}

/**
 * One page command as the link timed it (P1), for the latency budget (plans/fast-browser.md). `commandMs` is the round
 * trip from the helper through the bridge to the content script and back; for a walk, `extensionMs` is the share the
 * extension reports for itself (PageSnapshot.walkMs), so the difference is the hop chain. An act's `rewalkMs` is the walk
 * act() makes after it, which the executor waits for before it reads the answer.
 */
export interface VerbTiming {
  verb: PageVerb["kind"];
  /** The control the verb acted on; null for a walk. */
  control: PageControlKind | null;
  outcome: PageResult["outcome"];
  commandMs: number;
  /** A walk's own time in the extension; null for an act, or a walk an extension built before P1 answered. */
  extensionMs: number | null;
  rewalk: { commandMs: number; extensionMs: number | null } | null;
  at: number;
}

const since = (t0: number): number => Math.round((performance.now() - t0) * 10) / 10;

export class PageEngineLink implements ReaderLink {
  private readonly session: EngineSession;
  private seq = 0;
  /**
   * B23's element identity for page writes (S1 audit #6): the element each marked write went to. An undo carries the
   * mark as sameAs and is refused as notSameElement unless the key still names that element in the same document.
   * Lost with the link, so an undo after a helper or bridge restart is refused, as the reader refuses after its own.
   */
  private readonly marks = new Map<string, MarkedElement>();
  /** Per tab, what the helper itself knows its text fields hold (KnownText), by knownKey; at most MAX_MARKS per tab. */
  private readonly known = new Map<number, Map<string, KnownText>>();
  /** Applies a window snapshot to the screen model. */
  private readonly apply: (s: Snapshot) => void;
  /** Told each command's timing (P1); nothing is kept here. */
  private readonly onTiming: ((t: VerbTiming) => void) | null;
  /** Per tab: the trailing walk waiting to run, and the one on its way (see act()). */
  private readonly trailing = new Map<number, { timer: NodeJS.Timeout | null; running: Promise<void> | null }>();

  constructor(session: EngineSession, apply: (s: Snapshot) => void, onTiming: ((t: VerbTiming) => void) | null = null) {
    this.session = session;
    this.apply = apply;
    this.onTiming = onTiming;
    session.onSnapshot = (s) => this.apply(this.project(s));
  }

  /** A tab's walk as the model takes it, with the text the helper knows its fields hold (KnownText). */
  private project(s: PageSnapshot): Snapshot {
    const mine = this.known.get(s.tabId);
    return toWindowSnapshot(s, this.session, ++this.seq, (frameId, documentId, id) => mine?.get(knownKey(frameId, documentId, id)));
  }

  /** Notes what a text field holds, as Caret's own write, the page's alreadyTrue or a restore says, at `rev`. */
  private know(tabId: number, frameId: number, documentId: string, id: string, text: string, rev: number): void {
    const mine = this.known.get(tabId) ?? new Map<string, KnownText>();
    const k = knownKey(frameId, documentId, id);
    mine.delete(k);
    mine.set(k, { text, rev });
    while (mine.size > MAX_MARKS) mine.delete(mine.keys().next().value as string);
    this.known.set(tabId, mine);
  }

  /** What the node of a text control holds now, as toWindowSnapshot projects it. */
  private textNow(tabId: number, frameId: number, documentId: string, c: TextPageControl): { value: string } | { unread: true } {
    return textValueOf(c, this.known.get(tabId)?.get(knownKey(frameId, documentId, c.id)));
  }

  /** A tab's last walk as the model takes it under the sites now switched off, for EngineRegistry.setSitesOff's purge. */
  readAgain(s: PageSnapshot): Snapshot {
    return this.project(s);
  }

  /** A page command, timed; a walk's answer carries the extension's own time in its snapshot. */
  private async timed(verb: PageVerb, timeoutMs?: number): Promise<{ answer: Awaited<ReturnType<EngineSession["command"]>>; commandMs: number; extensionMs: number | null }> {
    const t0 = performance.now();
    const answer = await this.session.command(verb, timeoutMs);
    return { answer, commandMs: since(t0), extensionMs: answer.snapshot?.walkMs ?? null };
  }

  private report(verb: PageVerb, outcome: PageResult["outcome"], commandMs: number, extensionMs: number | null, rewalk: VerbTiming["rewalk"]): void {
    this.onTiming?.({ verb: verb.kind, control: verb.kind === "pageWalk" ? null : verb.control, outcome, commandMs, extensionMs, rewalk, at: Date.now() });
  }

  async run(verb: ReaderVerb): Promise<VerbResult> {
    if (!("windowId" in verb)) return verbResult("axError", `${verb.kind} is not a page verb`);
    const w = parsePageWindow(verb.windowId);
    if (w === null || w.engine !== this.session.info.engine) return verbResult("noWindow", `${verb.windowId} is not a window of engine ${this.session.info.engine}`);
    switch (verb.kind) {
      case "walk":
        return this.walk(w.tabId);
      case "write": {
        if (verb.attribute !== "value") return verbResult("axError", `a page field takes value writes only, not ${verb.attribute}`);
        const snap = this.session.tabs.get(w.tabId);
        if (verb.taskId === undefined) return verbResult("notAllowed", "a page write needs its task's grant");
        const role = projectedRole(snap, verb.key);
        if (role !== null && role !== verb.role) return verbResult("changed", `${verb.key} is now a ${role}, not the ${verb.role} the write was made for`);
        const group = pressGroupFor(snap, verb.key);
        if (group !== null) return this.pressAnswer(w.tabId, verb.key, group, verb.expect, verb.value, verb.taskId, verb.sameAs !== undefined);
        const radios = radioGroupFor(snap, verb.key);
        if (radios !== null) return this.checkRadio(w.tabId, verb.key, radios, verb);
        const t = targetFor(snap, verb.key);
        if (t === null) return verbResult("noElement", `no element ${verb.key} in the tab's last walk`);
        if (verb.sameAs !== undefined) {
          const was = this.marks.get(verb.sameAs);
          if (was === undefined) return verbResult("notSameElement", "the page engine holds no element under this mark (it restarted, or never wrote it)");
          // An undo after a reload is refused: the page that kept the field's text before Caret's write went with it.
          if (was.tabId === w.tabId && was.frameId === t.frameId && was.documentId !== t.documentId) return verbResult("notSameElement", `the page reloaded since Caret wrote '${t.control.name}', so Undo cannot put it back (reloaded)`);
          // Same tab, frame and document here; the content script then requires the very object the write reached
          // (it keeps it under the mark), which a rebind or a re-render can give another registry id (W3 review #2).
          if (was.tabId !== w.tabId || was.frameId !== t.frameId || was.documentId !== t.documentId) return verbResult("notSameElement", `the key ${verb.key} is now in another document or frame`);
        }
        // An undo never rebinds by strong key and must reach the object its write reached; a forward write records it (W3).
        const identity = verb.sameAs !== undefined ? { rebind: false as const, sameAs: verb.sameAs } : verb.mark !== undefined ? { mark: verb.mark } : {};
        const base = { tabId: w.tabId, frameId: t.frameId, documentId: t.documentId, id: t.id, control: t.control.kind, name: t.control.name, taskId: verb.taskId, ...identity };
        let page: PageVerb;
        if (t.control.kind === "select") {
          // The model shows a select's selected label, so a write names the option by its label: exactly one option may
          // carry it, and the option values are only what the page verb sends. Before is the option the walk saw
          // selected, which must still be the label the executor expects (W3 review #8).
          const options = t.control.options ?? [];
          // "" names the placeholder option (value ""), the value the model shows while it is selected, so an undo of a
          // first pick puts the placeholder back.
          const want = verb.value === "" ? options.filter((o) => o.value === "") : options.filter((o) => o.label === verb.value);
          if (want.length !== 1 || want[0] === undefined) return verbResult("noElement", `'${t.control.name}' has ${want.length} options labelled '${verb.value}'`);
          // The page verb names the option by value, and setting a value picks the first option holding it (W3 second review #5).
          if (options.filter((o) => o.value === want[0]?.value).length !== 1) return verbResult("noElement", `in '${t.control.name}', '${verb.value}' shares its value with another option, so Caret cannot pick it alone`);
          const had = options.find((o) => o.selected);
          // What the model shows for it (toWindowSnapshot): a placeholder option, whose value is empty, shows as "".
          const shown = had === undefined || had.value === "" ? "" : had.label;
          if (shown !== verb.expect) return verbResult("changed", `'${t.control.name}' shows '${shown}', not '${verb.expect}'`);
          page = { kind: "pageSelect", ...base, expect: had?.value ?? "", value: want[0].value };
        } else if (TEXT_KINDS.has(t.control.kind) && "hasValue" in t.control) {
          if (verb.sameAs !== undefined) {
            // Undo of Caret's own write: the page restores the text it kept from before the write, after its own check
            // that the field holds exactly what Caret wrote and nothing changed since (pageRestore). The helper never
            // had that text; `expect` is what the executor holds Caret wrote.
            // A node the helper cannot read is a write whose answer was lost (Executor.undoWrite delegates only those):
            // S1 recognizes it only exactly, so the page must find exactly what Caret was writing.
            const exact = "unread" in this.textNow(w.tabId, t.frameId, t.documentId, t.control);
            page = { kind: "pageRestore", ...base, wrote: verb.expect, ...(exact ? { exact: true as const } : {}) };
          } else {
            const refused = this.writable(w.tabId, t.frameId, t.documentId, t.control, verb.expect);
            if (refused !== null) return refused;
            page = { kind: "pageWrite", ...base, expectRev: t.control.rev as number, value: verb.value };
          }
        } else if (t.control.kind === "combobox" && "hasValue" in t.control) {
          // The model shows what the control shows (react-select's chip), as far as the helper knows it; the handler
          // picks the option named `value`, while the control's rev is the one the walk read. An undo's clear names
          // Caret's own pick (`wrote`), which the page requires the control still shows: the helper may not know.
          if (verb.sameAs !== undefined && verb.value === "") {
            if (t.control.rev === null) return verbResult("changed", `'${t.control.name}' holds text Caret does not read, so Caret will not change it`);
            page = { kind: "pageChooseOption", ...base, expectRev: t.control.rev, value: "", wrote: verb.expect };
          } else {
            const refused = this.writable(w.tabId, t.frameId, t.documentId, t.control, verb.expect);
            if (refused !== null) return refused;
            page = { kind: "pageChooseOption", ...base, expectRev: t.control.rev as number, value: verb.value };
          }
        } else if (t.control.kind === "checkbox") {
          // D2-04: the model shows a box as PAGE_CHECKED or "" (toWindowSnapshot), so a write of one of the two sets the
          // checked state, which the content script verifies; it never toggles blindly (alreadyTrue when it holds).
          const shown = t.control.checked === true ? PAGE_CHECKED : "";
          if (verb.value !== PAGE_CHECKED && verb.value !== "") return verbResult("axError", `a checkbox holds '${PAGE_CHECKED}' or nothing, not '${verb.value}'`);
          if (shown !== verb.expect) return verbResult("changed", `'${t.control.name}' is ${shown === "" ? "not ticked" : "ticked"}, which is not what the write expects`);
          page = { kind: "pageSetChecked", ...base, checked: verb.value === PAGE_CHECKED };
        } else return verbResult("axError", `'${t.control.name}' is a ${t.control.kind}, which takes no value write`);
        if (verb.mark !== undefined) this.remember(verb.mark, { tabId: w.tabId, frameId: t.frameId, documentId: t.documentId, id: t.id });
        if (page.kind === "pageSetChecked" && verb.sameAs === undefined) return this.notUnderIt(await this.act(page, w.tabId), t.control.name);
        if (page.kind !== "pageRestore") return this.act(page, w.tabId, verb.expect);
        // What the undo puts back is the executor's own record of the text before Caret's write ("" or Caret's earlier
        // value): once the page says it restored, the node holds it at the rev the page reported.
        const k = restoreKey(page);
        this.restoring.set(k, verb.value);
        try {
          return await this.act(page, w.tabId);
        } finally {
          this.restoring.delete(k);
        }
      }
      case "press": {
        const t = targetFor(this.session.tabs.get(w.tabId), verb.key);
        if (t === null) return verbResult("noElement", `no element ${verb.key} in the tab's last walk`);
        if (verb.taskId === undefined) return verbResult("notAllowed", "a page press needs its task's grant");
        if (ROLE[t.control.kind] !== verb.role) return verbResult("changed", `${verb.key} is now a ${ROLE[t.control.kind]}, not the ${verb.role} the press was made for`);
        if (t.control.name !== verb.label) return verbResult("changed", `the element is now named '${t.control.name}', not '${verb.label}'`);
        return this.act({ kind: "pagePress", tabId: w.tabId, frameId: t.frameId, documentId: t.documentId, id: t.id, control: t.control.kind, name: t.control.name, taskId: verb.taskId }, w.tabId);
      }
      case "raise":
        // A page task never raises or focuses a window (memo section 8, risk 4): the engine writes in place.
        return verbResult("notAllowed", "Caret never raises a browser window for a page task");
      default:
        return verbResult("axError", "not a page verb");
    }
  }

  /**
   * Why a forward write to a text control (or an undo's clear of a combobox) is refused before it is sent, or null. The
   * node must hold what the executor expects, which for a page field is "" for an empty one or the helper's own known
   * text (KnownText): a field that holds text the page does not send is never written over, and one whose text is
   * withheld has no rev to name.
   */
  private writable(tabId: number, frameId: number, documentId: string, c: TextPageControl, expect: string): VerbResult | null {
    const now = this.textNow(tabId, frameId, documentId, c);
    if ("unread" in now || c.rev === null) return verbResult("changed", `'${c.name}' holds text Caret does not read, so Caret will not write over it`);
    if (now.value !== expect) return verbResult("changed", `'${c.name}' no longer holds what the write expects`);
    return null;
  }

  /**
   * A write to a press group (W4): exactly one option must carry the name written, and the group must show `expect` as
   * its answer in the last walk. The page verb names the option and the question; the content script presses only
   * that option and only while the question is the same. An undo is refused: no press can put "unanswered" back.
   */
  private async pressAnswer(tabId: number, key: string, g: NonNullable<ReturnType<typeof pressGroupFor>>, expect: string, value: string, taskId: string, undo: boolean): Promise<VerbResult> {
    if (undo) return verbResult("notSameElement", `'${g.question}' was answered by a press, which Caret cannot take back; change the answer yourself`);
    const want = g.options.filter((o) => o.name === value);
    if (want.length !== 1 || want[0] === undefined) return verbResult("noElement", `'${g.question}' has ${want.length} options named '${value}'`);
    const shown = pressedValue(g.options);
    if (shown !== expect) return verbResult("changed", `'${g.question}' shows '${shown}' answered, not '${expect}' (${key})`);
    const o = want[0];
    return this.act({ kind: "pageChooseOption", tabId, frameId: g.frameId, documentId: g.documentId, id: o.id, control: "button", name: o.name, taskId, expect, value, question: g.question }, tabId);
  }

  /**
   * A write to a radio group's node (D2-04). Forward, it checks the one button named `value`, while the group shows
   * `expect` checked ("" for none), and records that button under the write's mark. An undo (`sameAs`) may only put the
   * group back to no choice: it unchecks the very button its forward write checked (rebind: false), which the content
   * script does only for an undo. Any other undo is refused: a restore that checks another button is a new choice.
   */
  private async checkRadio(tabId: number, key: string, g: NonNullable<ReturnType<typeof radioGroupFor>>, verb: Extract<ReaderVerb, { kind: "write" }>): Promise<VerbResult> {
    const taskId = verb.taskId as string;
    const shown = g.buttons.find((b) => b.checked === true)?.name ?? "";
    if (shown !== verb.expect) return verbResult("changed", `the choice ${key} shows '${shown}' checked, not '${verb.expect}'`);
    if (verb.sameAs !== undefined) {
      const was = this.marks.get(verb.sameAs);
      const b = was === undefined ? undefined : g.buttons.find((x) => x.id === was.id);
      if (was === undefined || b === undefined || was.tabId !== tabId || was.frameId !== g.frameId || was.documentId !== g.documentId) {
        return verbResult("notSameElement", "the page engine holds no button of this choice under this mark (it restarted, the page reloaded, or the button was replaced)");
      }
      if (verb.value !== "") return verbResult("notSameElement", `Caret puts a choice back only to no answer; choosing '${verb.value}' again is yours`);
      return this.act({ kind: "pageSetChecked", tabId, frameId: g.frameId, documentId: g.documentId, id: b.id, control: "radio", name: b.name, taskId, checked: false, rebind: false, sameAs: verb.sameAs }, tabId);
    }
    if (verb.value === "") return verbResult("axError", "a choice is cleared only by undoing Caret's own pick");
    const want = g.buttons.filter((b) => b.name === verb.value);
    if (want.length !== 1 || want[0] === undefined) return verbResult("noElement", `the choice ${key} has ${want.length} buttons named '${verb.value}'`);
    const b = want[0];
    if (verb.mark !== undefined) this.remember(verb.mark, { tabId, frameId: g.frameId, documentId: g.documentId, id: b.id });
    return this.notUnderIt(await this.act({ kind: "pageSetChecked", tabId, frameId: g.frameId, documentId: g.documentId, id: b.id, control: "radio", name: b.name, taskId, checked: true, ...(verb.mark === undefined ? {} : { mark: verb.mark }) }, tabId), b.name);
  }

  /**
   * A forward tick or radio check the page answered "already so" was made by someone else after the walk that planned
   * it (D2-04 review): Caret did nothing, and the field changed under the task, which stops it. Recorded as a write,
   * its undo would clear the user's own tick.
   */
  private notUnderIt(r: VerbResult, name: string): VerbResult {
    return r.outcome === "ok" && r.detail === "alreadyTrue" ? verbResult("changed", `'${name}' was set by someone else since the walk`) : r;
  }

  private async walk(tabId: number): Promise<VerbResult> {
    const verb: PageVerb = { kind: "pageWalk", tabId };
    const { answer: a, commandMs, extensionMs } = await this.walkCommand(tabId);
    this.report(verb, a.result.outcome, commandMs, extensionMs, null);
    if (a.result.outcome !== "ok") return toVerbOutcome(a.result);
    return a.snapshot === null ? verbResult("axError", "the engine answered the walk without a snapshot") : verbResult("ok", null);
  }

  /**
   * Attaches the file the user confirmed for `taskId` (attach.ts) to the control `key` names in the tab's last walk:
   * a file input, or a dropzone. The only way the helper builds a pageAttachFile.
   */
  async attachFile(windowId: string, key: string, taskId: string, files: ConfirmedFiles): Promise<{ verb: VerbResult; page: PageResult | null }> {
    const w = parsePageWindow(windowId);
    if (w === null || w.engine !== this.session.info.engine) return { verb: verbResult("noWindow", `${windowId} is not a window of engine ${this.session.info.engine}`), page: null };
    const t = targetFor(this.session.tabs.get(w.tabId), key);
    if (t === null) return { verb: verbResult("noElement", `no element ${key} in the tab's last walk`), page: null };
    // A file input, or a dropzone (which walks as a button); the content script then requires the dropzone to hold its
    // own file input. No text field or link is ever sent a file's bytes.
    if (t.control.kind !== "file" && t.control.kind !== "button") return { verb: verbResult("axError", `'${t.control.name}' is a ${t.control.kind}, which takes no file`), page: null };
    const file = files.read(taskId, ConfirmedFiles.target(windowId, key));
    if ("refused" in file) return { verb: verbResult("notAllowed", file.refused), page: null };
    const verb: PageVerb = { kind: "pageAttachFile", tabId: w.tabId, frameId: t.frameId, documentId: t.documentId, id: t.id, control: t.control.kind, name: t.control.name, taskId, file };
    await this.trailing.get(w.tabId)?.running;
    const { answer: a, commandMs } = await this.timed(verb, SLOW_VERB_TIMEOUT_MS);
    const rewalk = a.result.outcome !== "notAllowed" && a.result.outcome !== "handoff" && a.result.outcome !== "siteOff" ? await this.walkCommand(w.tabId) : null;
    this.report(verb, a.result.outcome, commandMs, null, rewalk === null ? null : { commandMs: rewalk.commandMs, extensionMs: rewalk.extensionMs });
    return { verb: toVerbOutcome(a.result), page: a.result };
  }

  /**
   * P4 item 8: `text` at the caret of the field `key` names, which must be the field that had focus in the tab's last
   * walk (the one the offer was made for); the content script inserts only while that very element still has focus and
   * reads exactly `expect` before its caret, by execCommand("insertText"), so the page's own Undo takes it back. Under
   * the task's grant, as every act. Only an accepted inline offer on a page calls this (the host's half, H13).
   */
  async insertText(windowId: string, key: string, expect: string, text: string, taskId: string, token?: string, replace?: number): Promise<VerbResult> {
    const w = parsePageWindow(windowId);
    if (w === null || w.engine !== this.session.info.engine) return verbResult("noWindow", `${windowId} is not a window of engine ${this.session.info.engine}`);
    const snap = this.session.tabs.get(w.tabId);
    const t = targetFor(snap, key);
    if (t === null) return verbResult("noElement", `no element ${key} in the tab's last walk`);
    // Refusals before anything is sent are `changed`: the helper says axError as unverified (H13 review).
    if (!INSERT_KINDS.has(t.control.kind)) return verbResult("changed", `'${t.control.name}' is a ${t.control.kind}, which takes no typed text`);
    if (snap?.focused?.frameId !== t.frameId || snap.focused.id !== t.id) return verbResult("changed", `'${t.control.name}' is not the field that has focus`);
    // H13 review: the key may name another element now (the page replaced the field with one of the same label).
    if (token !== undefined && elementToken(t) !== token) return verbResult("changed", `'${t.control.name}' is not the element the offer was made for`);
    if ((replace ?? 0) > expect.length) return verbResult("changed", "replace exceeds the text before the caret");
    return this.act({ kind: "pageInsertText", tabId: w.tabId, frameId: t.frameId, documentId: t.documentId, id: t.id, control: t.control.kind, name: t.control.name, taskId, expect, text, ...(replace === undefined ? {} : { replace }) }, w.tabId);
  }

  private remember(mark: string, e: MarkedElement): void {
    this.marks.delete(mark);
    this.marks.set(mark, e);
    while (this.marks.size > MAX_MARKS) this.marks.delete(this.marks.keys().next().value as string);
  }

  /**
   * Acts, then brings the model up to date before the executor reads the answer.
   *
   * A text write or tick/radio check the page verified (ok or alreadyTrue) is not followed by a walk:
   * the model is patched for that one control from what the verb set and the page's readings say (patched(), learn()). P1 measured
   * about 110 ms per re-walk on Lever against about 1 ms for the hop (~/.caret-run/evidence/screen/p1/loop-canned/
   * page-loop.md), and the executor walks the window again at the start of its next step anyway, so each write paid
   * for two walks. The content script's rev check still guards each write against a field that changed since the
   * walk. What the page does in reaction (a revealed field, reformatting, another injector's write) is seen by the next
   * step's refresh walk, and after the last such act by one trailing walk (TRAILING_WALK_MS).
   *
   * A forward write with no answer leaves the recovery read to the executor. Other acts re-walk the tab: a combobox or
   * Yes/No pick and an attach change more than one value,
   * and a failed or refused act may have left anything. So does a native select (P2 review): the page reads back the
   * option's value, not the label the model shows, and a page that relabels the chosen option would have Caret verify
   * a label the walk before the act showed. A press after which the page left is answered at once, with no
   * walk: the run stops on it, and a page on its way out may not answer a walk before the command times out (B28 review).
   */
  private async act(verb: PageVerb, tabId: number, expectText = ""): Promise<VerbResult> {
    await this.trailing.get(tabId)?.running;
    const { answer: a, commandMs } = await this.timed(verb, verb.kind === "pageChooseOption" || verb.kind === "pageAttachFile" ? SLOW_VERB_TIMEOUT_MS : undefined);
    this.learn(verb, a.result, expectText);
    const out: VerbResult = restoredPick(verb, a.result) ? { ...toVerbOutcome(a.result), restored: true } : toVerbOutcome(a.result);
    if (a.result.pageChanged !== undefined) {
      // The page is leaving; a trailing walk of it would only wait out its timeout.
      this.cancelTrailingWalks(tabId);
      this.report(verb, a.result.outcome, commandMs, null, null);
      return out;
    }
    const patched = this.patched(verb, a.result);
    if (patched !== null) {
      this.session.tabs.set(tabId, patched);
      this.apply(this.project(patched));
      this.scheduleTrailingWalk(tabId);
      this.report(verb, a.result.outcome, commandMs, null, null);
      return out;
    }
    // A timed-out forward write goes back as axError. The executor owns its single recovery read and
    // already saved the original before dispatch; re-walking here would read twice and delay Stop's reconciliation.
    // An undo restore (sameAs) is still walked: Executor.undoWrite runs no recovery read (PR #21 review).
    if (a.result.outcome === "error" && (verb.kind === "pageWrite" || verb.kind === "pageSelect" || verb.kind === "pageChooseOption" || verb.kind === "pageSetChecked") && verb.sameAs === undefined) {
      this.cancelTrailingWalks(tabId);
      this.report(verb, a.result.outcome, commandMs, null, null);
      return out;
    }
    const rewalk = a.result.outcome !== "notAllowed" && a.result.outcome !== "handoff" && a.result.outcome !== "siteOff" ? await this.walkCommand(tabId) : null;
    // A refused act changed nothing, so a trailing walk still pending waits out this act too.
    if (rewalk === null && (this.trailing.get(tabId)?.timer ?? null) !== null) this.scheduleTrailingWalk(tabId);
    this.report(verb, a.result.outcome, commandMs, null, rewalk === null ? null : { commandMs: rewalk.commandMs, extensionMs: rewalk.extensionMs });
    return out;
  }

  /**
   * Notes what an act's answer tells the helper a text field holds (KnownText), before any walk after it is projected:
   * a write the page verified holds Caret's value; a pick that landed holds the option's name; a write or pick that left
   * the field exactly as it was holds what the executor expected before (`expectText`, "" or the helper's own known
   * text); a restore holds what the executor puts back. Each at the rev the page reported.
   */
  private learn(verb: PageVerb, r: PageResult, expectText: string): void {
    if (verb.kind === "pageWalk") return;
    // Under the element the act reached: a rebound write went to a replacement with an id of its own.
    const id = r.reboundTo ?? verb.id;
    const at = (text: string, rev: number | null | undefined): void => {
      if (rev !== null && rev !== undefined) this.know(verb.tabId, verb.frameId, verb.documentId, id, text, rev);
    };
    if (verb.kind === "pageRestore") {
      if (r.restore?.outcome === "restored") at(this.restoring.get(restoreKey(verb)) ?? "", r.restore.rev);
      return;
    }
    if (verb.kind !== "pageWrite" && !(verb.kind === "pageChooseOption" && verb.control === "combobox")) return;
    const rd = r.readings;
    if (rd === undefined) return;
    if ((r.outcome === "ok" || r.outcome === "alreadyTrue") && (rd.landed || rd.equivalent) && !rd.typedBetween) at(verb.value, rd.rev);
    else if (rd.sameAsBefore && !rd.typedBetween) at(expectText, rd.rev);
  }

  /** What each pageRestore under way puts back, as the executor's undo names it, so its answer can be learned (learn()). */
  private readonly restoring = new Map<string, string>();

  /**
   * The tab's last walk with the one control a verified write or check set, or null when the act does not
   * qualify (see act()) or the control is not in that walk. A new snapshot: the stored one is never changed in place.
   */
  private patched(verb: PageVerb, r: PageResult): PageSnapshot | null {
    if (r.outcome !== "ok" && r.outcome !== "alreadyTrue") return null;
    // A rebound act reached another element than the walked one: only a walk names it.
    if (r.reboundTo !== undefined) return null;
    if (verb.kind !== "pageWrite" && verb.kind !== "pageSetChecked") return null;
    const last = this.session.tabs.get(verb.tabId);
    if (last === undefined) return null;
    const s = structuredClone(last);
    // Not a walk: no walk time to report for it.
    delete s.walkMs;
    s.at = Date.now();
    const f = s.frames.find((x) => x.frameId === verb.frameId && x.documentId === verb.documentId);
    const c = f?.controls.find((x) => x.id === verb.id);
    if (f === undefined || c === undefined || c.kind !== verb.control) return null;
    switch (verb.kind) {
      case "pageWrite":
        // ok means the page found the field holding the value, or one equivalent to it under its kind; alreadyTrue,
        // that it held it already. The page sends no text: the node holds Caret's value at the rev it reported (learn()).
        if (!("hasValue" in c) || r.readings === undefined || r.readings.rev === null || r.readings.typedBetween) return null;
        c.hasValue = !r.readings.empty;
        c.rev = r.readings.rev;
        return s;
      case "pageSetChecked":
        if (c.kind === "checkbox") {
          c.checked = verb.checked;
          return s;
        }
        if (c.kind !== "radio") return null;
        c.checked = verb.checked;
        if (verb.checked) {
          const group = radioGroupKey(f.frameId, c);
          for (const other of radioMembers(f, group)) if (other !== c) other.checked = false;
        }
        return s;
    }
  }

  /** Walks the tab for an act or the executor: any trailing walk waiting is dropped, and one on its way is let finish first. */
  private async walkCommand(tabId: number): ReturnType<PageEngineLink["timed"]> {
    this.cancelTrailingWalks(tabId);
    await this.trailing.get(tabId)?.running;
    return this.timed({ kind: "pageWalk", tabId });
  }

  /** (Re)starts the tab's trailing walk timer. The walk is a read; its outcome only goes to the timing report. */
  private scheduleTrailingWalk(tabId: number): void {
    const t = this.trailing.get(tabId) ?? { timer: null, running: null };
    if (t.timer !== null) clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      t.timer = null;
      // EngineSession has no close hook: a session closed meanwhile is not walked.
      if (this.session.closed) return;
      const verb: PageVerb = { kind: "pageWalk", tabId };
      const running = this.timed(verb).then(
        ({ answer, commandMs, extensionMs }) => this.report(verb, answer.result.outcome, commandMs, extensionMs, null),
        () => undefined,
      ).finally(() => {
        if (t.running === running) t.running = null;
        if (t.timer === null && t.running === null && this.trailing.get(tabId) === t) this.trailing.delete(tabId);
      });
      t.running = running;
    }, TRAILING_WALK_MS);
    t.timer.unref();
    this.trailing.set(tabId, t);
  }

  /** Drops the trailing walk waiting for one tab, or for every tab. A walk already on its way runs to its end. */
  cancelTrailingWalks(tabId?: number): void {
    for (const [id, t] of this.trailing) {
      if (tabId !== undefined && id !== tabId) continue;
      if (t.timer !== null) clearTimeout(t.timer);
      t.timer = null;
    }
  }

  grant(m: ActGrant | ActRevoke | CalendarGrant): void {
    if (m.type === "calendarGrant") return;
    if (m.type === "actRevoke") {
      this.session.revoke(m.taskId);
      return;
    }
    const w = parsePageWindow(m.windowId);
    if (w === null || w.engine !== this.session.info.engine) return;
    const snap = this.session.tabs.get(w.tabId);
    // No walk of the tab yet: no frame to pin, so no grant; the first act answers notAllowed.
    if (snap === undefined) return;
    for (const f of snap.frames) {
      this.session.grant({
        type: "scopedActGrant",
        v: PROTOCOL_VERSION,
        taskId: m.taskId,
        scope: { kind: "page", engine: this.session.info.engine, tabId: w.tabId, frameId: f.frameId, origin: f.origin, navGen: f.navGen },
        at: m.at,
        expires: m.expires,
      });
    }
  }
}
