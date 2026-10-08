import { Disclosure, type Minted, type ModelText } from "../privacy/disclosure.ts";
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
import { eventCandidate, eventWord, sentences, spansIn } from "../offers/event-card.ts";
import type { EventClock } from "../offers/event-time.ts";
import { valueList, type Value } from "../planner/codeplan.ts";
import { mintFieldName, writableFields } from "../planner/planner.ts";
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
  /** What the goal writer reads, every text minted by `ledger` (SC1 2b). */
  snapshots: Minted<PlanningSnapshot>[];
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
  const snapshots: Minted<PlanningSnapshot>[] = [];
  const d = ledger;
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
    const titleText = d.descriptor(w, title) ?? d.own("");
    const domain = domainOf(w);
    const snapTargets: Minted<PlanningSnapshot>["targets"] = [];
    /**
     * `cut`: the window texts the writer reads the label by (a select's label and its choices), each cut from the view
     * (PV2: located where it is cut), never the composed label, whose wording is Caret's. `said` mints the label, and
     * with it the binding's own label, which the gates name the target by (gates.ts).
     */
    const bind = (b: Omit<TargetBinding, "ref" | "domain">, canFill: boolean, effects: string[], said: () => ModelText | null, cut: readonly string[] = [b.label]): void => {
      if (!ledger.take(w, "descriptor", cut)) return;
      const label = said();
      if (label === null) return;
      const ref = `t${++t}`;
      targets.set(ref, { ref, domain, ...b });
      snapTargets.push({ ref: d.id(ref), label: d.slice(label, 200), kind: d.id(b.control), canFill, options: [], allowedPressEffects: effects.map((e) => d.id(e)) });
    };
    for (const f of writableFields(w)) {
      if ((f.node.value ?? "") !== "") continue;
      bind({ key: f.node.key, role: f.node.role, label: f.name, own: f.label, placeholder: f.node.placeholder ?? null, control: "text", value: "", options: null, ...contractOf(w, f.node, null) }, true, [], () => mintFieldName(d, w, f));
    }
    // A page's controls the page engine sets (D2-04, W2). Boxes are left out: a goal plan never ticks one.
    if (domain.kind === "window" && domain.page) {
      for (const c of formControls(w)) {
        const control = CONTROL[c.control];
        if (control === undefined || c.label === null) continue;
        const label = c.label;
        const options = c.options;
        bind({ key: c.node.key, role: c.node.role, label, own: label, placeholder: c.node.placeholder ?? null, control, value: "", options, ...contractOf(w, c.node, c) }, true, [], () => {
          const name = d.descriptor(w, label);
          if (name === null || options === null) return name;
          const minted = options.map((x) => d.descriptor(w, x)).filter((x): x is ModelText => x !== null);
          return minted.length !== options.length ? null : d.t`${name} (one of: ${d.join(minted, ", ")})`;
        }, options === null ? [label] : [label, ...options]);
      }
    }
    let buttons = 0;
    for (const n of w.nodes.values()) {
      const label = (n.label ?? "").trim();
      if (n.role !== "AXButton" || label === "" || n.states?.includes("disabled") || buttons >= MAX_BUTTONS) continue;
      buttons++;
      bind({ key: n.key, role: n.role, label, own: label, placeholder: null, control: "button", value: "", options: null }, false, allowedEffects({ label, role: n.role, windowKind: w.window.kind, bundleId: w.app.bundleId, page: domain.kind === "window" && domain.page }), () => d.descriptor(w, label));
    }
    const own = i === 0 ? listed.filter((x) => x.window === null) : [];
    const fromHere = listed.filter((x) => x.window === w);
    const snapValues: Minted<PlanningSnapshot>["values"] = [];
    for (const x of [...own, ...fromHere]) {
      const b = valueOf(x, snapshot);
      values.set(b.ref, b);
      snapValues.push({ ref: d.id(b.ref), display: x.display, origin: mintOrigin(d, b.origin) });
    }
    snapshots.push({ snapshot: d.id(snapshot), window: d.id(`w${i + 1}`), revision: d.id(revisions.get(w.window.windowId) ?? "none"), title: titleText, targets: snapTargets, values: snapValues, questions: [] });
  });

  // Source windows the goal does not act in, with their values and any event code finds in them.
  const sourceWindows = [...new Set(listed.flatMap((x) => (x.window === null || windows.includes(x.window) ? [] : [x.window])))];
  for (const sw of sourceWindows) {
    if (snapshots.length >= (o.calendar === null ? 4 : 3)) break;
    const snapshot = `s${snapshots.length + 1}`;
    revisions.set(sw.window.windowId, windowRevision(sw));
    windowRefs.set(`w${snapshots.length + 1}`, sw.window.windowId);
    texts.set(sw.window.windowId, basisText(sw));
    const snapValues: Minted<PlanningSnapshot>["values"] = [];
    for (const x of listed.filter((y) => y.window === sw)) {
      const b = valueOf(x, snapshot);
      values.set(b.ref, b);
      snapValues.push({ ref: d.id(b.ref), display: x.display, origin: mintOrigin(d, b.origin) });
    }
    if (o.calendar !== null) for (const { b, display } of eventsIn(sw, people, o.clock, snapshot, ledger, () => `v${++v}`)) {
      values.set(b.ref, b);
      snapValues.push({ ref: d.id(b.ref), display, origin: mintOrigin(d, b.origin) });
    }
    const swTitle = sw.window.title.length <= 200 ? (d.descriptor(sw, sw.window.title) ?? d.own("")) : d.own("");
    snapshots.push({ snapshot: d.id(snapshot), window: d.id(`w${snapshots.length + 1}`), revision: d.id(revisions.get(sw.window.windowId) ?? "none"), title: swTitle, targets: [], values: snapValues, questions: [] });
  }

  if (o.calendar !== null) {
    const ref = `t${++t}`;
    const domain: GoalDomain = { kind: "calendar", calendar: o.calendar };
    targets.set(ref, { ref, domain, key: "calendar", role: "calendar", label: o.calendar, own: o.calendar, placeholder: null, control: "calendar", value: "", options: null });
    // The calendar's name is the user's own setting, minted as what the user told Caret.
    const name = d.memoryText(null, o.calendar);
    if (name !== null) snapshots.push({ snapshot: d.id(`s${snapshots.length + 1}`), window: d.id(`w${snapshots.length + 1}`), revision: d.own("calendar"), title: d.t`Calendar '${name}'`, targets: [{ ref: d.id(ref), label: name, kind: d.own("calendar"), canFill: true, options: [], allowedPressEffects: [] }], values: [], questions: [] });
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
export function eventsIn(w: WindowState, people: readonly MemoryValue[], clock: EventClock, snapshot: string, ledger: Disclosure, nextRef: () => string): { b: ReadValue; display: ModelText }[] {
  w = redactWindow(w);
  const d = ledger;
  const out: { b: ReadValue; display: ModelText }[] = [];
  for (const n of w.nodes.values()) {
    const text = nodeText(n);
    if (text === "") continue;
    for (const sentence of sentences(text, true)) {
      const spans = spansIn(w, n.key, sentence);
      const c = eventCandidate(sentence, spans, people, clock, "conversation");
      if (c === null || c.time.kind !== "resolved") continue;
      // The writer reads the event, not its sentence: what is charged is what the display reveals of the window,
      // the person's name and the date and time spans.
      // Each date and time the reader typed on this node that the spans join, as the view keeps it.
      const parts = w.values.filter((v) => v.nodeKey === n.key && (v.kind === "date" || v.kind === "time") && spans.some((x) => x.includes(v.text))).map((v) => v.text);
      if (!ledger.take(w, "candidate", [c.person, ...parts])) continue;
      const time = c.time.time;
      // The title and time are code's reading of the sentence: each word one the sentence shows, a number or a calendar word.
      const sentenceBasis = d.basis(w, sentence);
      // The title as offers/event-card.ts eventTitle writes it: Caret's template words around the person (taken above)
      // and the kind of event the sentence names (charged as a derivation from it).
      const person = d.candidate(w, c.person);
      const kind = eventWord(sentence);
      const word = kind === null || sentenceBasis === null ? null : d.derived(sentenceBasis, kind);
      const titled = person === null || (kind !== null && word === null) ? null : word === null ? d.t`Meet ${person}` : d.t`${word} with ${person}`;
      // Never a title other than the one the event carries (eventTitle's); none at all rather than another.
      const said = titled === c.title ? titled : null;
      // The time as code says it, read from the dates and times taken above (already charged), not from the sentence.
      const partTexts = parts.map((x) => d.candidate(w, x)).filter((x): x is ModelText => x !== null);
      const when = partTexts.length === 0 || partTexts.length !== parts.length ? null : d.derived(partTexts, time.says, ["utc"]);
      const from = d.descriptor(w, w.window.title);
      if (said === null || when === null || from === null) continue;
      const ref = nextRef();
      const minted = d.slice(d.t`the event '${said}', ${when} (read from '${from}')`, 400);
      const display: string = minted;
      // Derived here from a person and a resolved time, so it skips Jev's value question (gates.ts markDerived).
      out.push({ display: minted, b: markDerived({
        ref,
        text: c.title,
        display,
        origin: { kind: "derived", inputs: [], resolver: "event-card", version: time.resolverVersion || RESOLVER_VERSION, parametersDigest: digest(JSON.stringify([sentence, time.start, time.end])) },
        source: { windowId: w.window.windowId, key: n.key, revision: windowRevision(w) },
        memory: null,
        event: { title: c.title, start: time.start, end: time.end, says: time.says, sentence },
        draft: null,
        owner: null,
      }) });
    }
  }
  return out;
}

/** A value's origin as the writer reads it, every text a code-made id or Caret's word (SC1 2b). */
function mintOrigin(d: Disclosure, o: ValueOrigin): Minted<PlanningSnapshot>["values"][number]["origin"] {
  switch (o.kind) {
    case "span":
      return { kind: d.own("span"), snapshot: d.id(o.snapshot), source: d.id(o.source), startUTF16: o.startUTF16, endUTF16: o.endUTF16, digest: d.id(o.digest) };
    case "memory":
      return { kind: d.own("memory"), entryId: d.id(o.entryId), fileRevision: o.fileRevision === "" ? d.own("") : d.id(o.fileRevision), digest: d.id(o.digest) };
    case "derived":
      return { kind: d.own("derived"), inputs: o.inputs.map((x) => d.id(x)), resolver: d.id(o.resolver), version: d.id(o.version), parametersDigest: d.id(o.parametersDigest) };
    case "draft":
      return { kind: d.own("draft"), draftId: d.id(o.draftId), model: d.id(o.model), basis: o.basis.map((x) => d.id(x)), digest: d.id(o.digest) };
  }
}
