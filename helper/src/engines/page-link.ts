// The executor's ReaderLink for one page engine. The executor speaks reader verbs (walk, write, press) about
// windows; for a page window this link turns them into page verbs on the element the last walk named, applies the
// tab's snapshot to the screen model before answering, as the reader does, and maps the page outcome back onto
// the reader's. Its grant() turns the executor's one-window ActGrant into one ScopedActGrant per frame of the tab
// as last walked, each pinned to that frame's origin and navigation generation.
import { PAGE_CHECKED, PAGE_SUBROLE, PROTOCOL_VERSION, type ActGrant, type ActRevoke, type CalendarGrant, type Node, type NodeState, type PageControl, type PageControlKind, type PageFrame, type PageResult, type PageSnapshot, type PageVerb, type ReaderVerb, type Snapshot, type VerbOutcome, type VerbResult } from "../protocol.ts";
import type { ReaderLink } from "../executor/means.ts";
import type { EngineSession } from "./session.ts";
import type { ConfirmedFiles } from "./attach.ts";
import { pageWindowId, parsePageWindow } from "./windows.ts";

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

/** Kinds a pageWrite sets. A contenteditable is a hand-off in v1 (memo section 1, write path). */
export const TEXT_KINDS: ReadonlySet<PageControlKind> = new Set(["text", "email", "tel", "url", "number", "search", "date", "time", "datetime", "month", "week", "textarea"]);

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
export function toWindowSnapshot(s: PageSnapshot, session: EngineSession, seq: number): Snapshot {
  const nodes: Node[] = [];
  let focusedKey: string | null = null;
  for (const f of s.frames) {
    nodes.push({ key: frameKey(f.frameId), parent: f.parentFrameId < 0 ? null : frameKey(f.parentFrameId), role: "AXWebArea", label: f.title || `${f.origin}${f.path}` });
    const groups = new Set<string>();
    for (const c of f.controls) {
      let parent = frameKey(f.frameId);
      if (c.kind === "radio") {
        parent = radioGroupKey(f.frameId, c);
        if (!groups.has(parent)) {
          groups.add(parent);
          const checked = radioMembers(f, parent).find((m) => m.checked === true);
          nodes.push({ key: parent, parent: frameKey(f.frameId), role: "AXGroup", subrole: "AXFieldset", ...(c.group === undefined ? {} : { label: c.group.name }), value: checked?.name ?? "", editable: true });
        }
      }
      const press = isPressOption(c);
      if (press) {
        parent = pressGroupKey(f.frameId, c.group.id);
        if (!groups.has(parent)) {
          groups.add(parent);
          const options = f.controls.filter((o) => isPressOption(o) && o.group.id === c.group.id);
          nodes.push({ key: parent, parent: frameKey(f.frameId), role: "AXGroup", subrole: PAGE_SUBROLE.pressGroup, label: c.group.name, value: pressedValue(options), editable: true });
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
      const value = c.kind === "select" ? (selected === undefined ? undefined : selected.value === "" ? "" : selected.label) : box ? (c.checked === true ? PAGE_CHECKED : "") : c.value;
      const subrole = subroleOf(c);
      nodes.push({
        key: nodeKey(f.frameId, c),
        parent,
        role: press ? "AXRadioButton" : ROLE[c.kind],
        ...(subrole === undefined || press ? {} : { subrole }),
        label: c.name,
        ...(value === undefined ? {} : { value }),
        // A custom listbox takes a value too (pageChooseOption picks the option named exactly that), and so does a native
        // select (pageSelect, verified by selectedOptions; W3) and a checkbox (pageSetChecked, D2-04): without `editable`
        // the executor never reaches their write.
        ...(VALUE_KINDS.has(c.kind) || box ? { editable: true as const } : {}),
        ...(states.length > 0 ? { states } : {}),
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
    window: { windowId: pageWindowId(session.info.engine, s.tabId), kind: "page", title: s.title, frame: null },
    // The selected tab of a background browser window is not where the user is (W3): only the selected tab of the
    // window Chrome last focused counts, and the model's frontmost app (the reader's) decides whether that browser does.
    focused: s.active && s.inFocusedWindow,
    root: null,
    nodes,
    values: [],
    focusedKey,
    stats: { walkMs: 0, visited: nodes.length, truncated: s.frames.some((f) => f.truncated) || s.missing.length > 0 },
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
      return verbResult("changed", detail);
    case "noElement":
      return verbResult("noElement", detail);
    case "notSameElement":
      return verbResult("notSameElement", detail);
    case "excluded":
      return verbResult("secure", detail);
    case "handoff":
      return verbResult("notAllowed", detail);
    case "failed":
      // A Yes/No press after which the page navigated or submitted (B28): may have landed, and the executor stops at once.
      if (r.pageChanged !== undefined) return { ...verbResult("axError", detail), pageChanged: r.pageChanged };
      return verbResult(r.readings === undefined || r.readings.afterBlur !== r.readings.before ? "axError" : "changed", detail);
    case "unsupported":
    case "error":
      return verbResult("axError", detail);
    case "siteOff":
      return verbResult("notAllowed", detail);
  }
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

export class PageEngineLink implements ReaderLink {
  private readonly session: EngineSession;
  private seq = 0;
  /**
   * B23's element identity for page writes (S1 audit #6): the element each marked write went to. An undo carries the
   * mark as sameAs and is refused as notSameElement unless the key still names that element in the same document.
   * Lost with the link, so an undo after a helper or bridge restart is refused, as the reader refuses after its own.
   */
  private readonly marks = new Map<string, MarkedElement>();
  /** Applies a window snapshot to the screen model. */
  private readonly apply: (s: Snapshot) => void;

  constructor(session: EngineSession, apply: (s: Snapshot) => void) {
    this.session = session;
    this.apply = apply;
    session.onSnapshot = (s) => this.apply(toWindowSnapshot(s, session, ++this.seq));
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
        } else if (TEXT_KINDS.has(t.control.kind)) {
          page = { kind: "pageWrite", ...base, expect: verb.expect, value: verb.value };
        } else if (t.control.kind === "combobox") {
          // The model shows what the control shows (react-select's chip); the handler picks the option named `value`.
          page = { kind: "pageChooseOption", ...base, expect: verb.expect, value: verb.value };
        } else if (t.control.kind === "checkbox") {
          // D2-04: the model shows a box as PAGE_CHECKED or "" (toWindowSnapshot), so a write of one of the two sets the
          // checked state, which the content script verifies; it never toggles blindly (alreadyTrue when it holds).
          const shown = t.control.checked === true ? PAGE_CHECKED : "";
          if (verb.value !== PAGE_CHECKED && verb.value !== "") return verbResult("axError", `a checkbox holds '${PAGE_CHECKED}' or nothing, not '${verb.value}'`);
          if (shown !== verb.expect) return verbResult("changed", `'${t.control.name}' is ${shown === "" ? "not ticked" : "ticked"}, which is not what the write expects`);
          page = { kind: "pageSetChecked", ...base, checked: verb.value === PAGE_CHECKED };
        } else return verbResult("axError", `'${t.control.name}' is a ${t.control.kind}, which takes no value write`);
        if (verb.mark !== undefined) this.remember(verb.mark, { tabId: w.tabId, frameId: t.frameId, documentId: t.documentId, id: t.id });
        return page.kind === "pageSetChecked" && verb.sameAs === undefined ? this.notUnderIt(await this.act(page, w.tabId), t.control.name) : this.act(page, w.tabId);
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
    const a = await this.session.command({ kind: "pageWalk", tabId });
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
    const file = files.read(taskId);
    if ("refused" in file) return { verb: verbResult("notAllowed", file.refused), page: null };
    const verb: PageVerb = { kind: "pageAttachFile", tabId: w.tabId, frameId: t.frameId, documentId: t.documentId, id: t.id, control: t.control.kind, name: t.control.name, taskId, file };
    const a = await this.session.command(verb, SLOW_VERB_TIMEOUT_MS);
    if (a.result.outcome !== "notAllowed" && a.result.outcome !== "handoff" && a.result.outcome !== "siteOff") await this.session.command({ kind: "pageWalk", tabId: w.tabId });
    return { verb: toVerbOutcome(a.result), page: a.result };
  }

  private remember(mark: string, e: MarkedElement): void {
    this.marks.delete(mark);
    this.marks.set(mark, e);
    while (this.marks.size > MAX_MARKS) this.marks.delete(this.marks.keys().next().value as string);
  }

  /**
   * Acts, then re-walks the tab so the model holds the result before the executor reads the answer. A press after which
   * the page left is answered at once, with no walk: the run stops on it, and a page on its way out may not answer a
   * walk before the command times out (B28 review).
   */
  private async act(verb: PageVerb, tabId: number): Promise<VerbResult> {
    const a = await this.session.command(verb, verb.kind === "pageChooseOption" || verb.kind === "pageAttachFile" ? SLOW_VERB_TIMEOUT_MS : undefined);
    const out = toVerbOutcome(a.result);
    if (a.result.pageChanged !== undefined) return out;
    if (a.result.outcome !== "notAllowed" && a.result.outcome !== "handoff" && a.result.outcome !== "siteOff") await this.session.command({ kind: "pageWalk", tabId });
    return out;
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
