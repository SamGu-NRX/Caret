// The page planner (P2, plans/fast-browser.md "Page planner"): a goal for one page window planned by code, with no
// program writer. Fill's one round decides every field's value (proposeFill: both wordings agreeing at FILL_CUTOFF, the
// owner veto, the cut rules and its control rules), and its agreed picks become a DraftPlan in document order, lowered
// by lowerGoal as any goal is, so the page gets D2-06's digest-bound acceptance, receipts, precheck, revocation, replan
// and "left" accounting. A step lowered from fill's own pick for its own field is gate "fill" (gates.ts markFilled) and
// is not asked Jev's value question again; the code gates (never-typed, misfit, a message's recipient and subject) still
// run. Caret presses nothing on a page: what the user presses is theirs, and so is every field fill withheld, a kind
// Caret never types, and a form's fields past what one fill asks about (the size hand-off), each named before Tab.
// Nothing here acts.
import type { ScreenModel, WindowState } from "../model.ts";
import { PAGE_SUBROLE, type Node } from "../protocol.ts";
import type { AboutValue } from "../fill/about.ts";
import type { AskJev } from "../fill/jev.ts";
import { conversionOf, FILLABLE_ROLES, FillError, MAX_FIELDS, memoryRefOf, neverTypedNode, PAGE_WINDOW_KIND, proposeFill, type FillOptions, type FillScope } from "../fill/fill.ts";
import { formControls, inWebArea } from "../fill/controls.ts";
import { describeField } from "../fill/descriptor.ts";
import { isAnswerField } from "../fill/answers.ts";
import { asksCountry, fieldPart } from "../fill/derive.ts";
import { labelKind, SENSITIVE_SAYS } from "../memory/sensitive.ts";
import type { EventClock } from "../offers/event-time.ts";
import { writtenFields } from "../offers/fill-popup.ts";
import { fieldName } from "../planner/planner.ts";
import { saysNoValue } from "../planner/says.ts";
import { handoffWhy } from "../planner/validate.ts";
import { RESOLVER_VERSION } from "../values/resolve.ts";
import type { DraftPlan } from "../codemode/types.ts";
import { buildInventory, windowRevision } from "./inventory.ts";
import { GoalError, lowerGoal, MAX_SEGMENTS } from "./lower.ts";
import { canonical, sha256, type AttachOffer, type GoalControl, type GoalInventory, type GoalPlan, type LeftItem, type PageGoal, type TargetBinding, type ValueBinding } from "./plan.ts";
import type { Replan } from "./runs.ts";

/** The planner's version, in every page plan's identity (programHash). I6: page/2 adds the hand-off row. */
export const PAGE_PLANNER = "page/2";

/**
 * I6 (lead decision): the names that read as a form's forward control. A label reads so when, lowercased with its
 * punctuation and arrows dropped, it is one of these or one of these followed by at most two more words ("Submit
 * application", "Continue to payment"; not "Apply for this job", which opens a form rather than sending one). A closed
 * list, as scope words are (scope-words.ts): a word added here changes which pages say "You press".
 */
const FORWARD = ["save and continue", "next", "continue", "review", "submit", "apply"] as const;
const FORWARD_TAIL_WORDS = 2;

export function readsForward(label: string): boolean {
  const s = label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return FORWARD.some((f) => s === f || (s.startsWith(`${f} `) && s.split(" ").length - f.split(" ").length <= FORWARD_TAIL_WORDS));
}

/**
 * The form a page control's key places it in (extension content/walker.ts: `fN/` then the form's scope, `form[id]`,
 * `form@i` or a shadow host, then `role:name~ordinal`), or "" for a control in no form. The frame is part of it.
 */
export function formScopeOf(key: string): string {
  const slash = key.indexOf("/");
  if (slash < 0) return key;
  const frame = key.slice(0, slash);
  const rest = key.slice(slash + 1);
  if (rest.startsWith("form[")) {
    const end = rest.indexOf("]/");
    return end < 0 ? frame : `${frame}/${rest.slice(0, end + 1)}`;
  }
  const colon = rest.indexOf(":");
  const sep = rest.indexOf("/");
  return sep >= 0 && (colon < 0 || sep < colon) ? `${frame}/${rest.slice(0, sep)}` : frame;
}

/**
 * I6 (lead decision, the memo's hand-off): the page plan's last row. A page plan presses nothing, so the panel says
 * who goes on: "You press <label>" when the form the plan fills (the forms and frames of the controls it writes or
 * attaches to) shows exactly one enabled button whose name reads as forward (readsForward); "The rest is yours" with
 * none, or with more than one, since Caret cannot tell which the user means. The button is named by its own label.
 * The row is never pressed (lower.ts gives it no executor step).
 */
export function handoffRow(w: WindowState, domain: TargetBinding["domain"], keys: readonly string[]): { target: TargetBinding; says: string; why: ReturnType<typeof handoffWhy> } {
  const scopes = new Set(keys.map(formScopeOf));
  const forward = [...w.nodes.values()].filter(
    (n) => n.role === "AXButton" && n.subrole !== PAGE_SUBROLE.file && n.states?.includes("disabled") !== true && inWebArea(w, n) && scopes.has(formScopeOf(n.key)) && readsForward(n.label ?? ""),
  );
  const one = forward.length === 1 ? forward[0] : undefined;
  if (one !== undefined) {
    const label = (one.label ?? "").trim();
    return { target: { ref: "th", domain, key: one.key, role: one.role, label, own: label, placeholder: null, control: "button", value: "", options: null }, says: `You press ${label}`, why: handoffWhy(label) };
  }
  // No one control to name: the row stands for the page itself.
  const frame = keys[0]?.split("/")[0] ?? "f0";
  return { target: { ref: "th", domain, key: frame, role: "AXWebArea", label: "", own: "", placeholder: null, control: "button", value: "", options: null }, says: "The rest is yours", why: "unverifiable" };
}

export interface PlanPageOptions {
  goalId: string;
  /**
   * I6: the model fill reads the values' sources from, when it is not `model` itself: the model with the text of the tab
   * the user just left, held for this goal (helper.ts pagePlan, engines/tab-source.ts). Only fill's round and each
   * value's source binding read it; the page, the inventory and its ledger read `model`, so the plan keeps none of
   * that tab's text beyond the values and spans fill chose.
   */
  sources?: ScreenModel;
  /** The Ask's instruction; null for an ambient "fill this page" (no Ask scopes it). */
  instruction: string | null;
  /** A page window (kind "page"). */
  windowId: string;
  /** From the Ask's checked intent; null with no Ask: every empty control fill asks about on focus. */
  scope: FillScope | null;
  /** Which fields the scope takes, for the reveal continuation (runs.ts): every empty control, a section's, or a list. */
  kind: PageGoal["kind"];
  section: string | null;
  /** What the user told Caret (fill/about.ts), as a Fill all offers it. */
  about: readonly AboutValue[];
  askJev: AskJev;
  now: number;
  clock: EventClock;
  readerSession: number;
  /** The page's document generation; required, so a page that reloads or navigates stops the goal before it writes. */
  pageDocument: (windowId: string) => string | null;
  /** From the goal this plan replaces (runs.ts Replan): what it still owed. Receipts need nothing here: done fields are filled. */
  carried?: Pick<Replan, "owed">;
  /** The controls a finished page goal's writes revealed (runs.ts afterReveal): this plan's only fields. */
  revealed?: readonly string[];
  /** Test seams of proposeFill (its shuffles' randomness, the proposal id). */
  fill?: Pick<FillOptions, "rand" | "newId" | "trace">;
  /**
   * P3: what each file control in scope offers in its attach row, for a host that shows attach rows (protocol
   * GOAL_FILES_CAPABILITY): a saved file a Jev choice matched (helper.ts), else "choose". Absent: the host cannot show
   * one, and every file control stays the user's, as before P3.
   */
  attachOffer?: (w: WindowState, node: Node, label: string) => Promise<AttachOffer>;
  /** P3: file controls a goal this plan replaces already attached to, by key (runs.ts Replan.completed): never again. */
  attached?: ReadonlySet<string>;
}

/** A value fill would write, with what it was read from: a Fill all's GroundedField, or a value the instruction spells out. */
type Written = Pick<ReturnType<typeof writtenFields>["fields"][number], "key" | "control" | "value" | "display" | "span" | "context" | "source" | "memory">;

/** An empty control of a page fill can ask about, in document order: what a page goal may fill. */
interface PageInput {
  node: Node;
  control: GoalControl;
  /** The control's label as formControls reads it, for anything but a text field or a web dropdown. */
  label: string | null;
  options: string[] | null;
}

/**
 * A page window's empty controls Caret could fill, in document order: text fields and web dropdowns (empty, not secure),
 * and unset selects, radio groups, unticked boxes (never a consent or sign-up box, formControls) and date and time fields.
 * A field of a kind Caret never types is not one of them (neverTyped lists those).
 */
function pageInputs(w: WindowState): { inputs: PageInput[]; neverTyped: Node[] } {
  const controls = new Map(formControls(w).map((c) => [c.node.key, c]));
  const inputs: PageInput[] = [];
  const neverTyped: Node[] = [];
  for (const n of w.nodes.values()) {
    const c = controls.get(n.key);
    if (c !== undefined) {
      if (c.control === "checkbox" || c.control === "radio" || c.control === "select" || c.control === "date" || c.control === "time") inputs.push({ node: n, control: c.control, label: c.label, options: c.options });
      continue;
    }
    if (!FILLABLE_ROLES.has(n.role) || n.editable !== true || (n.value ?? "") !== "" || n.states?.includes("secure") === true || n.states?.includes("disabled") === true) continue;
    if (neverTypedNode(w, n) !== null) {
      neverTyped.push(n);
      continue;
    }
    inputs.push({ node: n, control: n.role === "AXComboBox" && inWebArea(w, n) ? "combobox" : "text", label: null, options: null });
  }
  return { inputs, neverTyped };
}

/** P3: a page window's empty controls Caret could fill, in document order (offers/ready-on-load.ts counts them). */
export function pageInputNodes(w: WindowState): Node[] {
  return pageInputs(w).inputs.map((x) => x.node);
}

/** The keys of a page window's empty controls Caret could fill (runs.ts reads which of them a goal's writes revealed). */
export function pageInputKeys(w: WindowState): string[] {
  return [...pageInputs(w).inputs.map((x) => x.node.key), ...fileControls(w).map((n) => n.key)];
}

/**
 * A page window's file controls Caret could attach to, in document order (P3): file inputs and the hidden inputs a
 * dropzone or attach button owns (the page engine reports both as PAGE_SUBROLE.file), enabled. A file input's contents
 * are not in the walk, so whether one already holds a file is read from the goal's own receipts (`attached`).
 */
export function fileControls(w: WindowState): Node[] {
  return [...w.nodes.values()].filter((n) => n.subrole === PAGE_SUBROLE.file && n.states?.includes("disabled") !== true && inWebArea(w, n));
}

/**
 * Document order, then what a form declares by its labels: a country before the state, city or ZIP that may depend on
 * it (a state list that follows the country). Written for that one dependency; no other is read.
 */
function ordered<T extends { node: Node }>(w: WindowState, xs: readonly T[]): T[] {
  const at = new Map([...w.nodes.keys()].map((k, i) => [k, i]));
  const out = [...xs].sort((a, b) => (at.get(a.node.key) ?? 0) - (at.get(b.node.key) ?? 0));
  const name = (x: T): string | null => {
    const d = describeField(w, x.node);
    return d.label ?? d.nearest ?? d.placeholder;
  };
  const country = out.findIndex((x) => asksCountry(name(x)));
  const dependent = out.findIndex((x) => ["state", "city", "zip"].includes(fieldPart(name(x)) ?? ""));
  if (country > dependent && dependent >= 0) out.splice(dependent, 0, ...out.splice(country, 1));
  return out;
}

const shortDigest = (s: string): string => sha256(s).slice(0, 16);
/** The rows one segment's preview shows at most (protocol GoalProgress segment `steps`). */
const STEP_VIEWS = 24;
const clip = (s: string, n = 60): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * A value as Jev would read it in a goal's value question (gates.ts jevGate), with where it came from, as fill's own
 * candidate descriptions say it: a page plan's value skips that question (gate "fill"), so this is read only by the
 * disagreement report (P2) and logs. The preview says the field and value, not this.
 */
function provenance(f: Written): string {
  const quoted = `"${f.span}"`;
  if (f.memory !== null) return `${quoted} (the user's own ${f.memory.label}, which the user told Caret)`;
  if (f.source === null) return `${quoted} (written in the user's instruction for this field)`;
  const line = f.context === null ? "" : `on the line labelled '${f.context}' `;
  return `${quoted} (${line}in ${f.source.appName} window '${f.source.windowTitle}')`;
}

/** Why fill left a field it asked about, in the preview's words. */
const WITHHELD_SAYS: Record<string, string> = {
  disagree: "Caret wasn't sure what goes there",
  lowConfidence: "Caret wasn't sure what goes there",
  sourceCut: "Caret couldn't read every value of its kind on screen",
  wrongKind: "the value Caret found doesn't fit it",
  otherPerson: "the value Caret found is someone else's",
  ambiguous: "the value Caret found could mean more than one thing",
};

/**
 * Plans one page as a goal. Throws GoalError with what the user reads when nothing can be offered. The plan's first
 * segment runs only after an acceptance that names its digest (runs.ts).
 */
export async function planPage(model: ScreenModel, o: PlanPageOptions): Promise<GoalPlan> {
  const w = model.windows.get(o.windowId);
  if (w === undefined) throw new GoalError("nothingToDo", "the page closed");
  if (w.window.kind !== PAGE_WINDOW_KIND) throw new GoalError("schema", "a page plan needs a page window", o.windowId);
  const document = o.pageDocument(o.windowId);
  if (document === null) throw new GoalError("nothingToDo", "Caret can't tell which page this is, so it won't plan a fill of it");
  const instruction = o.instruction ?? "Fill this page";

  // 1. What the page offers, and which of it the scope takes.
  const { inputs, neverTyped } = pageInputs(w);
  const byKey = new Map(inputs.map((x) => [x.node.key, x]));
  const sectionOf = (n: Node): string | null => describeField(w, n).section;
  const left: LeftItem[] = [];
  const leave = (n: Node, says: string, quotes?: LeftItem["quotes"], whose = "is yours"): void => {
    const label = fieldName(w, n);
    left.push({ windowId: o.windowId, key: n.key, label, why: "dropped", says: `'${label}' ${whose}: ${says}`, ...(quotes === undefined ? {} : { quotes }) });
  };
  let wanted: PageInput[];
  if (o.revealed !== undefined) wanted = o.revealed.flatMap((k) => byKey.get(k) ?? []);
  else if (o.scope === null || o.kind === "all") wanted = inputs;
  else if (o.kind === "section") wanted = inputs.filter((x) => sectionOf(x.node) === o.section);
  else {
    // A list names fields; one that already holds a value stays as it is (a page goal fills empty fields only).
    wanted = [];
    for (const k of o.scope.fields) {
      const x = byKey.get(k);
      const n = w.nodes.get(k);
      if (x !== undefined) wanted.push(x);
      // (After a stop, a field the goal it replaces already wrote is filled for that reason, and is not left.)
      else if (o.carried === undefined && n !== undefined && (n.value ?? "") !== "" && neverTypedNode(w, n) === null) leave(n, "it already holds something, and Caret fills only empty fields here");
    }
  }
  // Fields of a kind Caret never types that the scope takes are named before Tab.
  const scopeKeys = o.scope === null || o.kind === "all" ? null : new Set(o.kind === "list" ? o.scope.fields : []);
  for (const n of neverTyped) {
    const inScope = o.revealed === undefined && (scopeKeys === null || scopeKeys.has(n.key) || (o.kind === "section" && sectionOf(n) === o.section));
    const kind = labelKind(describeField(w, n).label ?? describeField(w, n).nearest) ?? labelKind(describeField(w, n).placeholder);
    if (inScope && kind !== null) leave(n, `Caret never types ${SENSITIVE_SAYS[kind]}`);
  }
  // P3: the file controls the scope takes, for a host that shows attach rows; one a goal before this already attached is done.
  const files =
    o.attachOffer === undefined
      ? []
      : fileControls(w).filter((n) => {
          if (o.attached?.has(n.key) === true) return false;
          if (o.revealed !== undefined) return o.revealed.includes(n.key);
          if (o.scope === null || o.kind === "all") return true;
          if (o.kind === "section") return sectionOf(n) === o.section;
          return o.scope.fields.includes(n.key);
        });
  if (wanted.length === 0 && files.length === 0) throw new GoalError("nothingToDo", left.length > 0 ? clip(left.map((l) => l.says).join("; "), 590) : "this page has no empty field Caret could fill");
  wanted = ordered(w, wanted);
  // C2 (lead decision 3): a form over MAX_FIELDS is filled in parts of at most MAX_FIELDS, in this order. One fill asks
  // about one part; each part is its own segment of the goal, previewed and accepted with its own Tab and undone on its
  // own (lowerGoal `parts`). The goal has at most MAX_SEGMENTS segments, so the fields past that many parts are named
  // as the user's, in one line (the size hand-off, P2). The segment that ends up last also shows the attach rows and
  // the hand-off row, and a preview shows at most STEP_VIEWS rows, so with many file controls every part is smaller
  // (C2 review: 40 fields and four uploads made a last segment of 25 rows, which the protocol refuses).
  // At most STEP_VIEWS - 2 attach rows, so one write and the hand-off row still fit; the rest are the user's (fix-check).
  for (const n of files.splice(STEP_VIEWS - 2)) leave(n, `Caret offers at most ${STEP_VIEWS - 2} files to attach at once`);
  const partSize = Math.max(1, Math.min(MAX_FIELDS, STEP_VIEWS - 1 - files.length));
  const room = partSize * MAX_SEGMENTS;
  const asked = wanted.slice(0, room);
  const rest = wanted.slice(room);
  if (rest.length > 0) {
    const names = rest.map((x) => `'${fieldName(w, x.node)}'`);
    left.push({ windowId: o.windowId, key: `size:${o.windowId}`, label: `${rest.length} more fields`, why: "dropped", says: clip(`Caret fills ${room} fields of a form, ${partSize} at a time, so ${rest.length} more are yours: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}`, 590) });
  }
  const parts: PageInput[][] = [];
  for (let i = 0; i < asked.length; i += partSize) parts.push(asked.slice(i, i + partSize));

  // 2. Values: fill's one round over exactly each part's fields, under the Ask's scope; the parts' rounds run together.
  const scopeOf = (part: readonly PageInput[]): FillScope | undefined =>
    o.scope === null ? undefined : { ...o.scope, fields: part.map((x) => x.node.key), literals: new Map([...o.scope.literals].filter(([k]) => part.some((x) => x.node.key === k))) };
  const rounds = await Promise.all(
    parts.map(async (part) => {
      const scope = scopeOf(part);
      try {
        // With no scope, the part's own fields (C2 review: a fill on focus asks about the 20 nearest the trigger, which
        // on a long form of look-alike fields were not the part's).
        const which = scope === undefined ? { only: part.map((x) => x.node.key) } : { scope };
        return { part, scope, proposal: await proposeFill(o.sources ?? model, o.askJev, o.windowId, (part[0] as PageInput).node.key, o.now, { about: o.about, ...which, ...(o.fill ?? {}) }), error: null };
      } catch (e) {
        if (e instanceof FillError) return { part, scope, proposal: null, error: e };
        throw e;
      }
    }),
  );
  // A part fill had nothing for leaves its fields to the user when another part, or a file control's attach row, still
  // has something to offer (before C2: with a file control only). A fill that failed any other way refuses the plan.
  const failed = rounds.find((x) => x.error !== null && x.error.why !== "nothingToCopy")?.error;
  if (failed !== undefined && failed !== null) throw new GoalError("nothingToDo", "Caret couldn't read this form's values", failed.message);
  if (rounds.every((x) => x.error !== null) && rounds.length > 0 && files.length === 0) throw new GoalError("nothingToDo", saysNoValue(asked.map((x) => fieldName(w, x.node))), rounds[0]?.error?.message);
  for (const x of rounds) if (x.error !== null) for (const y of x.part) leave(y.node, "Caret found nothing on screen or in memory for it");
  // What a Fill all would write: text values and the controls fill says it writes, each with its span and source; and
  // (an Ask's own) a value the instruction spells out for the field, which both asks chose as written there.
  const writes = new Map<string, Written>();
  for (const { proposal, scope } of rounds) {
    if (proposal === null) continue;
    for (const f of writtenFields(proposal, undefined, { answers: false }).fields) writes.set(f.key, f);
    for (const f of proposal.fields) {
      const said = scope?.literals.get(f.key);
      if (writes.has(f.key) || said === undefined || f.asks[0]?.value !== said) continue;
      if (f.control === "text" && f.value === said && f.source === null && f.memory === null) writes.set(f.key, { key: f.key, control: f.control, value: said, display: said, span: said, context: null, source: null, memory: null });
      else if (f.handoff !== null && f.handoff.writes === true && f.handoff.source === null && f.handoff.memory === null) writes.set(f.key, { key: f.key, control: f.control, value: f.handoff.value, display: f.handoff.display, span: said, context: null, source: null, memory: null });
    }
    for (const f of proposal.fields) {
      if (writes.has(f.key)) continue;
      const n = w.nodes.get(f.key);
      if (n === undefined) continue;
      // H13: a field that takes a written answer is the user's by design, whatever Jev made of it: "wasn't sure" would say
      // Caret tried to write it. A saved answer matched to it but held back (`answer`) keeps that reason instead.
      if (f.withheld !== null && f.answer === undefined && isAnswerField(n)) leave(n, "Caret doesn't write answers", undefined, "is yours to write");
      else if (f.withheld !== null) leave(n, WITHHELD_SAYS[f.withheld] ?? "Caret wasn't sure what goes there");
      else if (f.handoff !== null) leave(n, `Caret leaves setting it to you ('${clip(f.handoff.display)}' fits it)`, f.handoff.source === null ? undefined : { windowId: f.handoff.source.windowId, text: clip(f.handoff.display) });
    }
  }
  if (writes.size === 0 && files.length === 0) {
    const unsure = left.filter((l) => l.key !== `size:${o.windowId}`);
    throw new GoalError("nothingToDo", unsure.length > 0 ? clip(unsure.map((l) => l.says).join("; "), 590) : saysNoValue(asked.map((x) => fieldName(w, x.node))));
  }

  // 3. The inventory: the page as frozen (revision, document, owed fields), and a target for each field fill writes.
  let inv: ReturnType<typeof buildInventory>;
  try {
    inv = buildInventory(model, { instruction, windows: [o.windowId], memory: [], calendar: null, clock: o.clock, now: o.now, readerSession: o.readerSession, pageDocument: o.pageDocument });
  } catch (e) {
    throw new GoalError("nothingToDo", e instanceof Error ? e.message : String(e));
  }
  const domain = { kind: "window" as const, windowId: o.windowId, pid: w.app.pid, bundleId: w.app.bundleId, appName: w.app.name, title: w.window.title, number: w.window.number ?? null, windowKind: w.window.kind, page: true };
  const targets = new Map<string, TargetBinding>();
  const values = new Map<string, ValueBinding>(inv.inventory.values);
  const gated = new Map<string, ValueBinding>();
  const steps: DraftPlan["steps"] = [];
  /** C2: each fill step's part, by its ref: lowerGoal starts a segment where the part changes. */
  const stepParts = new Map<string, number>();
  const partOf = new Map(parts.flatMap((p, i) => p.map((x) => [x.node.key, i] as const)));
  let ref = 0;
  // In the parts' order (document order, a country before what depends on it: `wanted`), so each part's steps are together.
  for (const x of asked.filter((a) => writes.has(a.node.key))) {
    const f = writes.get(x.node.key);
    if (f === undefined) continue;
    const n = x.node;
    const d = describeField(w, n);
    // Named as runs.ts sameField reads it again before each write: a text field or web dropdown by fieldName, any
    // other control by formControls' label.
    const named = x.control === "text" || x.control === "combobox";
    const t: TargetBinding = { ref: `t${++ref}`, domain, key: n.key, role: n.role, label: named ? fieldName(w, n) : (x.label ?? ""), own: named ? (d.label ?? d.nearest ?? d.placeholder ?? "") : (x.label ?? ""), placeholder: n.placeholder ?? null, control: x.control, value: "", options: x.options };
    const src = f.source === null ? undefined : (o.sources ?? model).windows.get(f.source.windowId);
    if (f.source !== null && src === undefined) continue;
    const resolved = x.control === "date" || x.control === "time";
    const v: ValueBinding = {
      ref: `p${ref}`,
      text: f.value,
      display: provenance(f),
      origin:
        f.memory !== null
          ? { kind: "memory", entryId: f.memory.id, fileRevision: "", digest: shortDigest(f.value) }
          : resolved
            ? { kind: "derived", inputs: [], resolver: "fill/when", version: RESOLVER_VERSION, parametersDigest: shortDigest(f.span) }
            : { kind: "span", snapshot: "s1", source: f.source?.windowId ?? "instruction", startUTF16: 0, endUTF16: f.span.length, digest: shortDigest(f.span) },
      source: f.source === null || src === undefined ? null : { windowId: f.source.windowId, key: f.source.nodeKey, revision: windowRevision(src) },
      memory: f.memory === null ? null : memoryRefOf(f.memory, conversionOf(f.control)),
      event: null,
      draft: null,
      owner: f.memory !== null ? "user" : null,
      fill: { span: f.span, context: f.context, control: f.control, ...(f.memory === null ? {} : { memoryLabel: f.memory.label }) },
    };
    targets.set(t.ref, t);
    values.set(v.ref, v);
    gated.set(t.ref, v);
    stepParts.set(`s${steps.length + 1}`, partOf.get(n.key) ?? 0);
    steps.push({ ref: `s${steps.length + 1}`, kind: "fill", target: t.ref, value: v.ref });
  }
  // 4. Attach (P3): each file control in scope, with what its row offers. Caret never looks for a file on disk: the row
  // offers a file the user saved for this question, or none, and the user confirms one in the preview.
  const attach: { target: TargetBinding; file: AttachOffer }[] = [];
  for (const n of files) {
    const label = (n.label ?? "").trim();
    const t: TargetBinding = { ref: `t${++ref}`, domain, key: n.key, role: n.role, label, own: label, placeholder: n.placeholder ?? null, control: "file", value: "", options: null };
    targets.set(t.ref, t);
    attach.push({ target: t, file: o.attachOffer === undefined ? { source: "choose" } : await o.attachOffer(w, n, label) });
  }
  const inventory: GoalInventory = { ...inv.inventory, targets, values };
  // I6: who goes on after Caret's steps, as the plan's last row.
  const row = handoffRow(w, domain, [...[...gated.keys()].map((r) => (targets.get(r) as TargetBinding).key), ...attach.map((a) => a.target.key)]);

  // 5. Lowering, with fill's picks gated by fill. 6. The planning's identity.
  const programHash = sha256(canonical({ planner: PAGE_PLANNER, instruction, scopeKind: o.kind, section: o.section, revealed: o.revealed ?? null, revision: windowRevision(w), document, fields: asked.map((x) => x.node.key), parts: parts.map((p) => p.length), files: files.map((n) => n.key) }));
  const draft: DraftPlan = { basedOn: windowRevision(w), window: o.windowId, steps, choices: [], drafts: [], programDigest: programHash };
  const plan = await lowerGoal(o.goalId, instruction, draft, inventory, { askJev: o.askJev, ledger: inv.ledger, gated, carried: [...(o.carried?.owed ?? []), ...left], attach, handoffRow: row, parts: stepParts });
  const page: PageGoal = {
    windowId: o.windowId,
    scope: o.scope ?? { fields: [], windows: null, memory: true, instruction, person: null, literals: new Map() },
    kind: o.kind,
    section: o.section,
    keys: [...w.nodes.keys()],
  };
  return { ...plan, page };
}

/**
 * The FillScope a page goal's fresh plan asks under: after a stop, the same scope; for controls its writes revealed, the
 * scope's sources and person alone (planPage asks only the revealed controls, and no value of the instruction is tied
 * to one of them).
 */
export function continuationScope(page: PageGoal, revealed: boolean): FillScope {
  return revealed ? { ...page.scope, fields: [], literals: new Map() } : page.scope;
}
