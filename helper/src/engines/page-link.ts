// The executor's ReaderLink for one page engine. The executor speaks reader verbs (walk, write, press) about
// windows; for a page window this link turns them into page verbs on the element the last walk named, applies the
// tab's snapshot to the screen model before answering, as the reader does, and maps the page outcome back onto
// the reader's. Its grant() turns the executor's one-window ActGrant into one ScopedActGrant per frame of the tab
// as last walked, each pinned to that frame's origin and navigation generation.
import { PROTOCOL_VERSION, type ActGrant, type ActRevoke, type CalendarGrant, type Node, type NodeState, type PageControl, type PageControlKind, type PageResult, type PageSnapshot, type PageVerb, type ReaderVerb, type Snapshot, type VerbOutcome, type VerbResult } from "../protocol.ts";
import type { ReaderLink } from "../executor/means.ts";
import type { EngineSession } from "./session.ts";
import { pageWindowId, parsePageWindow } from "./windows.ts";

/** The reader role a page control reads as, so plans and the planner see pages as they see native forms. */
const ROLE: Record<PageControlKind, string> = {
  text: "AXTextField", email: "AXTextField", tel: "AXTextField", url: "AXTextField", number: "AXTextField", search: "AXTextField",
  date: "AXDateField", time: "AXDateField", datetime: "AXDateField", month: "AXDateField", week: "AXDateField",
  textarea: "AXTextArea", select: "AXPopUpButton", checkbox: "AXCheckBox", radio: "AXRadioButton", combobox: "AXComboBox",
  button: "AXButton", link: "AXLink", file: "AXButton", contenteditable: "AXTextArea", range: "AXSlider", color: "AXColorWell",
};

/** Kinds a pageWrite sets. A contenteditable is a hand-off in v1 (memo section 1, write path). */
export const TEXT_KINDS: ReadonlySet<PageControlKind> = new Set(["text", "email", "tel", "url", "number", "search", "date", "time", "datetime", "month", "week", "textarea"]);

export interface PageTargetRef {
  frameId: number;
  documentId: string;
  id: string;
  control: PageControl;
}

const frameKey = (frameId: number): string => `f${frameId}`;
const nodeKey = (frameId: number, c: PageControl): string => `${frameKey(frameId)}/${c.key}`;

/** The window snapshot the screen model takes for a tab: one AXWebArea per frame, its controls below it. */
export function toWindowSnapshot(s: PageSnapshot, session: EngineSession, seq: number): Snapshot {
  const nodes: Node[] = [];
  let focusedKey: string | null = null;
  for (const f of s.frames) {
    nodes.push({ key: frameKey(f.frameId), parent: f.parentFrameId < 0 ? null : frameKey(f.parentFrameId), role: "AXWebArea", label: f.title || `${f.origin}${f.path}` });
    for (const c of f.controls) {
      const states: NodeState[] = [];
      if (s.focused !== null && s.focused.frameId === f.frameId && s.focused.id === c.id) {
        states.push("focused");
        focusedKey = nodeKey(f.frameId, c);
      }
      if (c.checked === true) states.push("checked");
      if (c.disabled === true) states.push("disabled");
      const value = c.kind === "select" ? c.options?.find((o) => o.selected)?.label : c.value;
      nodes.push({
        key: nodeKey(f.frameId, c),
        parent: frameKey(f.frameId),
        role: ROLE[c.kind],
        label: c.name,
        ...(value === undefined ? {} : { value }),
        ...(TEXT_KINDS.has(c.kind) ? { editable: true as const } : {}),
        ...(states.length > 0 ? { states } : {}),
      });
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
    focused: s.active,
    root: null,
    nodes,
    values: [],
    focusedKey,
    stats: { walkMs: 0, visited: nodes.length, truncated: s.frames.some((f) => f.truncated) || s.missing.length > 0 },
  };
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
    case "excluded":
      return verbResult("secure", detail);
    case "handoff":
      return verbResult("notAllowed", detail);
    case "failed":
      return verbResult(r.readings === undefined || r.readings.afterBlur !== r.readings.before ? "axError" : "changed", detail);
    case "unsupported":
    case "error":
      return verbResult("axError", detail);
  }
}

export class PageEngineLink implements ReaderLink {
  private readonly session: EngineSession;
  private seq = 0;
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
        const t = targetFor(this.session.tabs.get(w.tabId), verb.key);
        if (t === null) return verbResult("noElement", `no element ${verb.key} in the tab's last walk`);
        if (verb.taskId === undefined) return verbResult("notAllowed", "a page write needs its task's grant");
        const base = { tabId: w.tabId, frameId: t.frameId, documentId: t.documentId, id: t.id, control: t.control.kind, name: t.control.name, taskId: verb.taskId };
        let page: PageVerb;
        if (t.control.kind === "select") {
          // The model shows a select's selected label; the page verb names options by value.
          const want = t.control.options?.find((o) => o.label === verb.value || o.value === verb.value);
          const had = t.control.options?.find((o) => o.label === verb.expect || o.value === verb.expect);
          if (want === undefined) return verbResult("noElement", `'${t.control.name}' has no option '${verb.value}'`);
          page = { kind: "pageSelect", ...base, expect: had?.value ?? verb.expect, value: want.value };
        } else if (TEXT_KINDS.has(t.control.kind)) {
          page = { kind: "pageWrite", ...base, expect: verb.expect, value: verb.value };
        } else return verbResult("axError", `'${t.control.name}' is a ${t.control.kind}, which takes no value write`);
        return this.act(page, w.tabId);
      }
      case "press": {
        const t = targetFor(this.session.tabs.get(w.tabId), verb.key);
        if (t === null) return verbResult("noElement", `no element ${verb.key} in the tab's last walk`);
        if (verb.taskId === undefined) return verbResult("notAllowed", "a page press needs its task's grant");
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

  private async walk(tabId: number): Promise<VerbResult> {
    const a = await this.session.command({ kind: "pageWalk", tabId });
    if (a.result.outcome !== "ok") return toVerbOutcome(a.result);
    return a.snapshot === null ? verbResult("axError", "the engine answered the walk without a snapshot") : verbResult("ok", null);
  }

  /** Acts, then re-walks the tab so the model holds the result before the executor reads the answer. */
  private async act(verb: PageVerb, tabId: number): Promise<VerbResult> {
    const a = await this.session.command(verb);
    const out = toVerbOutcome(a.result);
    if (a.result.outcome !== "notAllowed" && a.result.outcome !== "handoff") await this.session.command({ kind: "pageWalk", tabId });
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
