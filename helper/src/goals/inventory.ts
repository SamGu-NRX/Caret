import { Disclosure } from "../privacy/disclosure.ts";
import { instructionForModel } from "../fill/redact.ts";
import { redactWindow } from "../fill/redact.ts";
// The frozen snapshots a goal program reads, and the bindings behind their refs (D2-06). Built from the screen model
// at one moment: each window the goal may act in lists its empty fields, the page controls code can set and its
// labelled buttons as targets; values are the code-plan writer's (planner/codeplan.ts valueList: the instruction's
// spans, memory, and other windows' candidates) plus calendar events code derives from a sentence (event-card.ts).
// Every text the writer sees went through one SnippetLedger, as for a single-window code plan.
import { createHash } from "node:crypto";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import type { PlanningSnapshot } from "../codemode/types.ts";
import { formControls, type FormControl } from "../fill/controls.ts";
import { ContractError, fieldContract, type FieldContract } from "../fill/contract.ts";
import type { Node } from "../protocol.ts";
import { eventCandidate, sentences, spansIn } from "../offers/event-card.ts";
import type { EventClock } from "../offers/event-time.ts";
import { valueList, type Value } from "../planner/codeplan.ts";
import { writableFields } from "../planner/planner.ts";
import type { MemoryValue } from "../planner/trace.ts";
import { WINDOW_CHARS } from "../privacy.ts";
import { RESOLVER_VERSION } from "../values/resolve.ts";
import { allowedEffects } from "./capabilities.ts";
import { markDerived } from "./gates.ts";
import { owedFields, type OwedField } from "./left.ts";
import type { GoalControl, GoalDomain, GoalInventory, ReadValue, TargetBinding, ValueBinding, ValueOrigin } from "./plan.ts";

/** Windows one goal may act in. With the calendar, that is the writer's four snapshots (PlanInputSchema). */
export const MAX_GOAL_WINDOWS = 3;
/** Buttons listed per window. Assumed: a form's own buttons, not a toolbar's. */
const MAX_BUTTONS = 6;

const digest = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Hash the retained nodes in order, matching the goal snapshot and its revalidation view.
 * Discarded secret text does not contribute to this model-facing revision.
 */
export function windowRevision(w: WindowState): string {
  w = redactWindow(w);
  return digest(JSON.stringify([w.window.title, ...[...w.nodes.values()].map((n) => [n.key, n.role, n.label ?? "", n.value ?? "", n.editable === true])]));
}

/** Roles whose text is a message's own words, not a control's: what a message header is read from. */
const STATIC_ROLES = new Set(["AXStaticText", "AXHeading"]);

/**
 * A window's text as a draft's basis (B30): its title and each node's text, one line each; and `message`, its static
 * text alone, which a message's header is read from. Host-side only.
 */
export function basisText(w: WindowState): { title: string; text: string; message: string } {
  w = redactWindow(w);
  const nodes = [...w.nodes.values()];
  const lines = (xs: typeof nodes): string => xs.map((n) => nodeText(n)).filter((t) => t !== "").join("\n");
  return { title: w.window.title, text: lines(nodes), message: lines(nodes.filter((n) => STATIC_ROLES.has(n.role) && n.editable !== true)) };
}


export interface InventoryOptions {
  instruction: string;
  /** Window ids the goal may act in, the one the writer reads first first. */
  windows: readonly string[];
  memory: readonly MemoryValue[];
  /** The calendar events go to; null when no calendar port is configured. */
  calendar: string | null;
  clock: EventClock;
  now: number;
  readerSession: number;
  /** A page window's document generation (its frames' documents and navigations); null for a native window. */
  pageDocument?: (windowId: string) => string | null;
}

export interface Inventory {
  snapshots: PlanningSnapshot[];
  inventory: GoalInventory;
  ledger: Disclosure;
}

const CONTROL: Record<string, GoalControl> = { select: "select", combobox: "combobox", radio: "radio", date: "date" };

function domainOf(w: WindowState): GoalDomain {
  return { kind: "window", windowId: w.window.windowId, pid: w.app.pid, bundleId: w.app.bundleId, appName: w.app.name, title: w.window.title, number: w.window.number ?? null, windowKind: w.window.kind, page: w.window.kind === "page" };
}

/** Builds the snapshots and their bindings. Throws an Error naming what is missing; the caller says it to the user. */
export function buildInventory(model: ScreenModel, o: InventoryOptions): Inventory {
  const localWindows = new Map<string, WindowState>();
  const windows = o.windows.slice(0, MAX_GOAL_WINDOWS).map((id) => {
    const w = model.windows.get(id);
    if (w === undefined) throw new Error(`window ${id} is not open`);
    localWindows.set(id, w);
    return redactWindow(w);
  });
  const first = windows[0];
  if (first === undefined) throw new Error("no window to plan in");
  const ledger = new Disclosure(model.windows.values());
  if (!ledger.plan([instructionForModel(o.instruction)])) throw new Error("the instruction quotes more of an open window than one request may carry");
  const targets = new Map<string, TargetBinding>();
  const values = new Map<string, ValueBinding>();
  const revisions = new Map<string, string>();
  const documents = new Map<string, string>();
  const windowRefs = new Map<string, string>();
  const texts = new Map<string, { title: string; text: string; message: string }>();
  const owed = new Map<string, OwedField[]>();
  const snapshots: PlanningSnapshot[] = [];
  let t = 0;
  let v = 0;
  const people = o.memory.filter((m) => m.whose === "other");

  // Values first: the instruction, memory and other windows' candidates, measured against the first window's room.
  const listed = valueList(o.instruction, model, first, o.memory, ledger, o.now, WINDOW_CHARS);
  const valueOf = (x: Value, snapshot: string): ReadValue => {
    const ref = `v${++v}`;
    const origin: ValueOrigin =
      x.memory !== null
        ? { kind: "memory", entryId: x.memory, fileRevision: "", digest: digest(x.text) }
        : { kind: "span", snapshot, source: x.window?.window.windowId ?? "instruction", startUTF16: 0, endUTF16: x.text.length, digest: digest(x.text) };
    const source = x.window !== null && x.key !== null ? { windowId: x.window.window.windowId, key: x.key, revision: windowRevision(x.window) } : null;
    return { ref, text: x.text, display: x.display, origin, source, memory: x.memory, event: null, draft: null, owner: x.owner, provenance: x.provenance };
  };

  windows.forEach((w, i) => {
    const snapshot = `s${i + 1}`;
    revisions.set(w.window.windowId, windowRevision(w));
    windowRefs.set(`w${i + 1}`, w.window.windowId);
    texts.set(w.window.windowId, basisText(w));
    // Completion is local: a required field Caret never types still needs the user.
    // Raw obligation labels stay in inventory.owed, never in the writer's snapshots.
    owed.set(w.window.windowId, owedFields(localWindows.get(w.window.windowId) ?? w));
    const doc = o.pageDocument?.(w.window.windowId) ?? null;
    if (doc !== null) documents.set(w.window.windowId, doc);
    const title = w.window.title.slice(0, 200);
    if (!ledger.take(w, "descriptor", [title])) throw new Error(`'${title}' is longer than one request may carry`);
    const domain = domainOf(w);
    const snapTargets: PlanningSnapshot["targets"] = [];
    /** `shown`: the label as the writer reads it, when it says more than the control's own (a select's choices). */
    const bind = (b: Omit<TargetBinding, "ref" | "domain">, canFill: boolean, effects: string[], shown = b.label): void => {
      if (!ledger.take(w, "descriptor", [shown])) return;
      const ref = `t${++t}`;
      targets.set(ref, { ref, domain, ...b });
      snapTargets.push({ ref, label: shown.slice(0, 200), kind: b.control, canFill, options: [], allowedPressEffects: effects });
    };
    for (const f of writableFields(w)) {
      if ((f.node.value ?? "") !== "") continue;
      bind({ key: f.node.key, role: f.node.role, label: f.name, own: f.label, placeholder: f.node.placeholder ?? null, control: "text", value: "", options: null, ...contractOf(w, f.node, null) }, true, []);
    }
    // A page's controls the page engine sets (D2-04, W2). Boxes are left out: a goal plan never ticks one.
    if (domain.kind === "window" && domain.page) {
      for (const c of formControls(w)) {
        const control = CONTROL[c.control];
        if (control === undefined || c.label === null) continue;
        bind({ key: c.node.key, role: c.node.role, label: c.label, own: c.label, placeholder: c.node.placeholder ?? null, control, value: "", options: c.options, ...contractOf(w, c.node, c) }, true, [], c.options === null ? c.label : `${c.label} (one of: ${c.options.join(", ")})`);
      }
    }
    let buttons = 0;
    for (const n of w.nodes.values()) {
      const label = (n.label ?? "").trim();
      if (n.role !== "AXButton" || label === "" || n.states?.includes("disabled") || buttons >= MAX_BUTTONS) continue;
      buttons++;
      bind({ key: n.key, role: n.role, label, own: label, placeholder: null, control: "button", value: "", options: null }, false, allowedEffects({ label, role: n.role, windowKind: w.window.kind, bundleId: w.app.bundleId, page: domain.kind === "window" && domain.page }));
    }
    const own = i === 0 ? listed.filter((x) => x.window === null) : [];
    const fromHere = listed.filter((x) => x.window === w);
    const snapValues: PlanningSnapshot["values"] = [];
    for (const x of [...own, ...fromHere]) {
      const b = valueOf(x, snapshot);
      values.set(b.ref, b);
      snapValues.push({ ref: b.ref, display: b.display, origin: b.origin });
    }
    snapshots.push({ snapshot, window: `w${i + 1}`, revision: revisions.get(w.window.windowId) ?? "", title, targets: snapTargets, values: snapValues, questions: [] });
  });

  // Source windows the goal does not act in, with their values and any event code finds in them.
  const sourceWindows = [...new Set(listed.flatMap((x) => (x.window === null || windows.includes(x.window) ? [] : [x.window])))];
  for (const sw of sourceWindows) {
    if (snapshots.length >= (o.calendar === null ? 4 : 3)) break;
    const snapshot = `s${snapshots.length + 1}`;
    revisions.set(sw.window.windowId, windowRevision(sw));
    windowRefs.set(`w${snapshots.length + 1}`, sw.window.windowId);
    texts.set(sw.window.windowId, basisText(sw));
    const snapValues: PlanningSnapshot["values"] = [];
    for (const x of listed.filter((y) => y.window === sw)) {
      const b = valueOf(x, snapshot);
      values.set(b.ref, b);
      snapValues.push({ ref: b.ref, display: b.display, origin: b.origin });
    }
    if (o.calendar !== null) for (const b of eventsIn(sw, people, o.clock, snapshot, ledger, () => `v${++v}`)) {
      values.set(b.ref, b);
      snapValues.push({ ref: b.ref, display: b.display, origin: b.origin });
    }
    snapshots.push({ snapshot, window: `w${snapshots.length + 1}`, revision: revisions.get(sw.window.windowId) ?? "", title: sw.window.title.length <= 200 ? sw.window.title : "", targets: [], values: snapValues, questions: [] });
  }

  if (o.calendar !== null) {
    const ref = `t${++t}`;
    const domain: GoalDomain = { kind: "calendar", calendar: o.calendar };
    targets.set(ref, { ref, domain, key: "calendar", role: "calendar", label: o.calendar, own: o.calendar, placeholder: null, control: "calendar", value: "", options: null });
    snapshots.push({ snapshot: `s${snapshots.length + 1}`, window: `w${snapshots.length + 1}`, revision: "calendar", title: `Calendar '${o.calendar}'`, targets: [{ ref, label: o.calendar, kind: "calendar", canFill: true, options: [], allowedPressEffects: [] }], values: [], questions: [] });
  }
  return { snapshots, inventory: { readerSession: o.readerSession, targets, values, revisions, documents, windowRefs, texts, owed }, ledger };
}

/**
 * W2: a target's field contract (fill/contract.ts fieldContract), or none for a field Caret never types, whose write
 * gates.ts codeGate refuses by name before any contract is asked for.
 */
function contractOf(w: WindowState, node: Node, form: FormControl | null): { field?: FieldContract } {
  try {
    return { field: fieldContract(w, node, form) };
  } catch (e) {
    if (e instanceof ContractError && e.code === "neverTyped") return {};
    throw e;
  }
}

/** Events code reads from a source window's sentences: a resolved time and a person, as an event card would offer. */
function eventsIn(w: WindowState, people: readonly MemoryValue[], clock: EventClock, snapshot: string, ledger: Disclosure, nextRef: () => string): ReadValue[] {
  w = redactWindow(w);
  const out: ReadValue[] = [];
  for (const n of w.nodes.values()) {
    const text = nodeText(n);
    if (text === "") continue;
    for (const sentence of sentences(text, true)) {
      const spans = spansIn(w, n.key, sentence);
      const c = eventCandidate(sentence, spans, people, clock, "conversation");
      if (c === null || c.time.kind !== "resolved") continue;
      // The writer reads the event, not its sentence: what is charged is what the display reveals of the window,
      // the person's name and the date and time spans.
      if (!ledger.take(w, "candidate", [c.person, ...spans])) continue;
      const time = c.time.time;
      const ref = nextRef();
      const display = `the event '${c.title}', ${time.says} (read from '${w.window.title}')`.slice(0, 400);
      // Derived here from a person and a resolved time, so it skips Jev's value question (gates.ts markDerived).
      out.push(markDerived({
        ref,
        text: c.title,
        display,
        origin: { kind: "derived", inputs: [], resolver: "event-card", version: time.resolverVersion || RESOLVER_VERSION, parametersDigest: digest(JSON.stringify([sentence, time.start, time.end])) },
        source: { windowId: w.window.windowId, key: n.key, revision: windowRevision(w) },
        memory: null,
        event: { title: c.title, start: time.start, end: time.end, says: time.says, sentence },
        draft: null,
        owner: null,
      }));
    }
  }
  return out;
}
