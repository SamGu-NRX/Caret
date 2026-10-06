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
import { FILLABLE_ROLES, FillError, MAX_FIELDS, memoryRefOf, neverTypedNode, PAGE_WINDOW_KIND, proposeFill, type FillOptions, type FillScope } from "../fill/fill.ts";
import { formControls, inWebArea } from "../fill/controls.ts";
import { describeField } from "../fill/descriptor.ts";
import { asksCountry, fieldPart } from "../fill/derive.ts";
import { labelKind, SENSITIVE_SAYS } from "../memory/sensitive.ts";
import type { EventClock } from "../offers/event-time.ts";
import { writtenFields } from "../offers/fill-popup.ts";
import { fieldName } from "../planner/planner.ts";
import { saysNoValue } from "../planner/says.ts";
import { RESOLVER_VERSION } from "../values/resolve.ts";
import type { DraftPlan } from "../codemode/types.ts";
import { buildInventory, windowRevision } from "./inventory.ts";
import { GoalError, lowerGoal } from "./lower.ts";
import { canonical, sha256, type AttachOffer, type GoalControl, type GoalInventory, type GoalPlan, type LeftItem, type PageGoal, type TargetBinding, type ValueBinding } from "./plan.ts";
import type { Replan } from "./runs.ts";

/** The planner's version, in every page plan's identity (programHash). */
export const PAGE_PLANNER = "page/1";

export interface PlanPageOptions {
  goalId: string;
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
  fill?: Pick<FillOptions, "rand" | "newId">;
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
  const leave = (n: Node, says: string): void => {
    const label = fieldName(w, n);
    left.push({ windowId: o.windowId, key: n.key, label, why: "dropped", says: `'${label}' is yours: ${says}` });
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
  // The size hand-off: one fill asks about MAX_FIELDS fields at most; the rest of the form is named as the user's, in one line.
  const asked = wanted.slice(0, MAX_FIELDS);
  const rest = wanted.slice(MAX_FIELDS);
  if (rest.length > 0) {
    const names = rest.map((x) => `'${fieldName(w, x.node)}'`);
    left.push({ windowId: o.windowId, key: `size:${o.windowId}`, label: `${rest.length} more fields`, why: "dropped", says: clip(`Caret fills ${MAX_FIELDS} fields of a form at once, so ${rest.length} more are yours: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}`, 590) });
  }

  // 2. Values: fill's one round over exactly those fields, under the Ask's scope.
  const scope: FillScope | undefined =
    o.scope === null ? undefined : { ...o.scope, fields: asked.map((x) => x.node.key), literals: new Map([...o.scope.literals].filter(([k]) => asked.some((x) => x.node.key === k))) };
  let proposal: Awaited<ReturnType<typeof proposeFill>> | null = null;
  try {
    // A page whose only controls in scope are file controls asks fill nothing.
    if (asked.length > 0) proposal = await proposeFill(model, o.askJev, o.windowId, (asked[0] as PageInput).node.key, o.now, { about: o.about, ...(scope === undefined ? {} : { scope }), ...(o.fill ?? {}) });
  } catch (e) {
    // With a file control to attach to, a form fill has nothing for still leaves the attach rows to offer.
    if (e instanceof FillError && e.why === "nothingToCopy" && files.length > 0) for (const x of asked) leave(x.node, "Caret found nothing on screen or in memory for it");
    else if (e instanceof FillError) throw new GoalError("nothingToDo", e.why === "nothingToCopy" ? saysNoValue(asked.map((x) => fieldName(w, x.node))) : "Caret couldn't read this form's values", e.message);
    else throw e;
  }
  // What a Fill all would write: text values and the controls fill says it writes, each with its span and source; and
  // (an Ask's own) a value the instruction spells out for the field, which both asks chose as written there.
  const grounded = proposal === null ? { fields: [] } : writtenFields(proposal, undefined, { answers: false });
  const writes = new Map<string, Written>(grounded.fields.map((f) => [f.key, f]));
  for (const f of proposal?.fields ?? []) {
    const said = scope?.literals.get(f.key);
    if (writes.has(f.key) || said === undefined || f.asks[0]?.value !== said) continue;
    if (f.control === "text" && f.value === said && f.source === null && f.memory === null) writes.set(f.key, { key: f.key, control: f.control, value: said, display: said, span: said, context: null, source: null, memory: null });
    else if (f.handoff !== null && f.handoff.writes === true && f.handoff.source === null && f.handoff.memory === null) writes.set(f.key, { key: f.key, control: f.control, value: f.handoff.value, display: f.handoff.display, span: said, context: null, source: null, memory: null });
  }
  for (const f of proposal?.fields ?? []) {
    if (writes.has(f.key)) continue;
    const n = w.nodes.get(f.key);
    if (n === undefined) continue;
    if (f.withheld !== null) leave(n, WITHHELD_SAYS[f.withheld] ?? "Caret wasn't sure what goes there");
    else if (f.handoff !== null) leave(n, `Caret leaves setting it to you ('${clip(f.handoff.display)}' fits it)`);
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
  let ref = 0;
  for (const x of ordered(w, asked.filter((a) => writes.has(a.node.key)))) {
    const f = writes.get(x.node.key);
    if (f === undefined) continue;
    const n = x.node;
    const d = describeField(w, n);
    // Named as runs.ts sameField reads it again before each write: a text field or web dropdown by fieldName, any
    // other control by formControls' label.
    const named = x.control === "text" || x.control === "combobox";
    const t: TargetBinding = { ref: `t${++ref}`, domain, key: n.key, role: n.role, label: named ? fieldName(w, n) : (x.label ?? ""), own: named ? (d.label ?? d.nearest ?? d.placeholder ?? "") : (x.label ?? ""), placeholder: n.placeholder ?? null, control: x.control, value: "", options: x.options };
    const src = f.source === null ? undefined : model.windows.get(f.source.windowId);
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
      memory: f.memory === null ? null : memoryRefOf(f.memory),
      event: null,
      draft: null,
      owner: f.memory !== null ? "user" : null,
      fill: { span: f.span, context: f.context, control: f.control, ...(f.memory === null ? {} : { memoryLabel: f.memory.label }) },
    };
    targets.set(t.ref, t);
    values.set(v.ref, v);
    gated.set(t.ref, v);
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

  // 5. Lowering, with fill's picks gated by fill. 6. The planning's identity.
  const programHash = sha256(canonical({ planner: PAGE_PLANNER, instruction, scopeKind: o.kind, section: o.section, revealed: o.revealed ?? null, revision: windowRevision(w), document, fields: asked.map((x) => x.node.key), files: files.map((n) => n.key) }));
  const draft: DraftPlan = { basedOn: windowRevision(w), window: o.windowId, steps, choices: [], drafts: [], programDigest: programHash };
  const plan = await lowerGoal(o.goalId, instruction, draft, inventory, { askJev: o.askJev, ledger: inv.ledger, gated, carried: [...(o.carried?.owed ?? []), ...left], attach });
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
