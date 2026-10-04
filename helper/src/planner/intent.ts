// Ask as a scoped fill (B25 lead decision 1). An instruction becomes a small intent, and every part of it is a
// choice from what code listed or an exact span of the instruction:
//   - the route: fill, plan, ask or refuse;
//   - the fields: every empty one, a section, or a list, each by its ref in the snapshot;
//   - the sources: windows by ref, memory, the instruction, or any;
//   - whose details: the user's (each field says whose it wants, as fill decides today), or a person the
//     instruction names;
//   - literal values: exact substrings of the instruction, each tied to a field in scope.
// An intent maker (the writer's strict JSON, or Jev's staged Choice and Noul) fills in the parts; checkIntent
// checks each against the snapshot and the instruction, and turns the intent into the fill engine's scope
// (fill.ts FillScope). Jev stays the chooser of values: the intent only narrows what fill asks about.
import type { ScreenModel, WindowState } from "../model.ts";
import type { Node } from "../protocol.ts";
import { describeField } from "../fill/descriptor.ts";
import { formControls, inWebArea, type Control } from "../fill/controls.ts";
import { FILLABLE_ROLES, neverTypedNode, type FillScope } from "../fill/fill.ts";
import { NEVER_TYPED_SAYS, neverTypedValue, type NeverTyped } from "../fill/never-typed.ts";
import { SnippetLedger } from "../privacy.ts";
import { occursBounded, type MemoryValue } from "./trace.ts";
import { instructionValues } from "./spans.ts";
import { PlannerError } from "./validate.ts";

export const ROUTES = ["fill", "plan", "ask", "refuse"] as const;
export type AskRoute = (typeof ROUTES)[number];
/** Why an intent refuses, or what it asks; each has a sentence code writes (WHY_SAYS). */
export const REASONS = ["none", "neverTyped", "noSuchField", "notOnScreen", "pressOrSend", "payment", "otherPersonUnnamed", "nothingToFill", "whichFields", "whichSource", "whichPerson"] as const;
export type Reason = (typeof REASONS)[number];

export interface AskIntent {
  route: AskRoute;
  why: Reason;
  scope: "all" | "section" | "list";
  /** A section ref ("s1") when scope is section; "none" otherwise. */
  section: string;
  /** Field refs ("f3") when scope is list. */
  fields: readonly string[];
  /** Window refs ("w2"), "memory", "instruction", or "any" for every source fill reads today. */
  sources: readonly string[];
  /** "user", "unnamed" (someone else, not named), or a person ref ("p1") from the snapshot. */
  whose: string;
  literals: readonly { field: string; text: string }[];
}

export interface IntentField {
  ref: string;
  key: string;
  name: string;
  section: string | null;
  control: Control;
  /** A text field that already holds a value; only a list names it. */
  filled: boolean;
  neverTyped: NeverTyped | null;
}

export interface IntentSnapshot {
  instruction: string;
  window: WindowState;
  /** The form window's title as the request carries it, or null when it did not fit its budget. */
  title: string | null;
  fields: IntentField[];
  sections: { ref: string; name: string }[];
  /** Other open windows a value could come from, most recent first, by title. */
  windows: { ref: string; windowId: string; app: string; title: string }[];
  /** Labels of what the user told Caret (About entries, people), never their values. */
  memory: string[];
  /** People the instruction names, as exact spans of it ("Gary", "my sister"). */
  persons: { ref: string; span: string }[];
  /** Values the instruction spells out, as exact spans of it (spans.ts), for a maker that can only choose. */
  literals: string[];
  ledger: SnippetLedger;
}

/** Fields and windows one snapshot lists at most: the plan's provisional inventory limit (section 4), and sources by recency. */
export const MAX_INTENT_FIELDS = 40;
export const MAX_INTENT_WINDOWS = 8;

/** Relations that name a person without a name ("my sister"). Written for common requests, not measured. */
const RELATION = /\b(?:my|our)\s+(?:sister|brother|mom|mother|dad|father|wife|husband|partner|spouse|son|daughter|kid|child|roommate|landlord|landlady|manager|boss|reference|friend|colleague|coworker|co-worker|guest|plus-one|assistant|grandma|grandmother|grandpa|grandfather|aunt|uncle|cousin|fianc[eé]e?|girlfriend|boyfriend|neighbor|neighbour|advisor|recruiter|doctor)\b/giu;
/** A capitalized word, with an optional second one: a name the instruction says ("Gary", "Dr. Simone Achebe"). */
const CAPITALIZED = /(?<![\p{L}\p{N}'’])(?:Dr\.\s+|Ms\.\s+|Mr\.\s+|Mrs\.\s+)?\p{Lu}[\p{Ll}'’-]+(?:\s+\p{Lu}[\p{Ll}'’-]+)?/gu;
/** Capitalized words that are not people in an instruction. Written for common requests, not measured. */
const NOT_PEOPLE = new Set(["I", "RSVP", "Caret", "Please", "Fill", "Use", "Put", "Add", "Make", "Set", "Ship", "Book", "Sign", "Pick", "Choose", "Do", "Can", "Just", "Go", "Grab", "Register", "Write", "Copy", "Enter", "Type", "Change", "Ok", "Okay", "Actually", "My", "Our", "The", "This", "That", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December", "LinkedIn", "GitHub", "Google", "Chrome", "Mail", "Gmail", "Outlook", "TextEdit", "Notes", "SSN"]);

/** The people an instruction names, each an exact span of it once: names (a possessive's "'s" dropped) and relations. */
export function personSpans(instruction: string): string[] {
  const out: string[] = [];
  const add = (s: string): void => {
    const t = s.trim();
    if (t !== "" && !out.includes(t) && occursBounded(instruction, t)) out.push(t);
  };
  for (const m of instruction.matchAll(CAPITALIZED)) {
    const words = m[0].replace(/['’]s$/u, "").split(/\s+/u);
    // Drop a sentence's capitalized first word ("Use Gary's info"): only the words after it can be a name.
    const kept = words.filter((w) => !NOT_PEOPLE.has(w.replace(/['’]s$/u, "")));
    if (kept.length > 0) add(kept.join(" ").replace(/['’]s$/u, ""));
  }
  for (const m of instruction.matchAll(RELATION)) add(m[0]);
  return out;
}

/** "his phone", "her email", "their address": someone's details by a pronoun. */
const PRONOUN_DETAILS = /\b(?:his|her|their|hers|theirs)\s+(?:\w+\s+){0,2}?(?:name|email|e-mail|phone|number|cell|mobile|address|details|info|information|contact|birthday|date of birth|dob)\b/iu;

/** The fields a snapshot lists: the page's text fields (never the browser's own) and its empty controls, in document order. */
function formInventory(w: WindowState): { node: Node; control: Control }[] {
  const web = [...w.nodes.values()].some((n) => n.role === "AXWebArea");
  const out: { node: Node; control: Control }[] = [];
  const controls = formControls(w);
  const byKey = new Map(controls.map((c) => [c.node.key, c]));
  for (const n of w.nodes.values()) {
    const c = byKey.get(n.key);
    if (c !== undefined) {
      out.push({ node: c.node, control: c.control });
      continue;
    }
    if (n.editable !== true || !FILLABLE_ROLES.has(n.role) || n.states?.includes("secure")) continue;
    // In a browser window, the page's fields only: the address bar is the browser's.
    if (web && !inWebArea(w, n)) continue;
    out.push({ node: n, control: n.role === "AXComboBox" && inWebArea(w, n) ? "combobox" : "text" });
  }
  return out;
}

/**
 * The snapshot an intent maker chooses from, with its text taken through one ledger: the form's title and
 * field names as descriptors, the other windows' titles and memory labels as plan text, and the instruction.
 * Throws PlannerError("privacy") when the instruction cannot go out.
 */
export function intentSnapshot(instruction: string, model: ScreenModel, w: WindowState, memory: readonly MemoryValue[]): IntentSnapshot {
  const ledger = new SnippetLedger(model.windows.values());
  if (!ledger.plan([instruction])) throw new PlannerError("privacy", "your instruction quotes more of an open window than one request may carry");
  const title = ledger.take(w, "descriptor", [w.window.title]) ? w.window.title : null;
  const fields: IntentField[] = [];
  const sections: { ref: string; name: string }[] = [];
  for (const x of formInventory(w)) {
    if (fields.length >= MAX_INTENT_FIELDS) break;
    const d = describeField(w, x.node);
    const name = x.control === "text" || x.control === "combobox" ? (d.label ?? d.nearest ?? d.placeholder) : (d.label ?? d.nearest);
    if (name === null || !ledger.take(w, "descriptor", [name, d.section])) continue;
    if (d.section !== null && !sections.some((s) => s.name === d.section)) sections.push({ ref: `s${sections.length + 1}`, name: d.section });
    const filled = x.control === "text" && (x.node.value ?? "") !== "";
    fields.push({ ref: `f${fields.length + 1}`, key: x.node.key, name, section: d.section, control: x.control, filled, neverTyped: x.control === "text" ? neverTypedNode(w, x.node) : null });
  }
  // Other windows by title, most recently focused first. A title is what names a source ("Morgan's email"); a
  // window whose title does not fit what the ledger allows is left out.
  const windows: IntentSnapshot["windows"] = [];
  const others = [...model.windows.values()].filter((o) => o !== w && o.window.title.trim() !== "").sort((a, b) => b.lastFocusedAt - a.lastFocusedAt || b.updatedAt - a.updatedAt);
  for (const o of others) {
    if (windows.length >= MAX_INTENT_WINDOWS) break;
    if (ledger.take(o, "candidate", [o.window.title])) windows.push({ ref: `w${windows.length + 1}`, windowId: o.window.windowId, app: o.app.name, title: o.window.title });
  }
  const labels = [...new Set(memory.map((m) => m.label))];
  const memoryLabels = labels.length > 0 && ledger.memory(labels) ? labels : [];
  return {
    instruction,
    window: w,
    title,
    fields,
    sections,
    windows,
    memory: memoryLabels,
    persons: personSpans(instruction).map((span, i) => ({ ref: `p${i + 1}`, span })),
    literals: instructionValues(instruction),
    ledger,
  };
}

/** The sentence each reason says, to the user, when an Ask refuses or asks. */
export const WHY_SAYS: Record<Exclude<Reason, "none">, string> = {
  neverTyped: "Caret never types a Social Security number, a card number, a password or a one-time code; that is yours to type",
  noSuchField: "this form has no field for what you asked",
  notOnScreen: "what you asked to copy from is not open on screen",
  pressOrSend: "Caret never submits, sends or presses a button for you; that is yours to do",
  payment: "Caret stops before payment; paying is yours to do",
  otherPersonUnnamed: "whose details you mean is not clear; say their name",
  nothingToFill: "Caret found nothing in your instruction to fill here",
  whichFields: "which fields do you mean?",
  whichSource: "where should Caret copy from?",
  whichPerson: "whose details do you mean?",
};

/** An intent checked against its snapshot: the fill engine's scope, and what the route needs. */
export type CheckedIntent =
  | { route: "fill"; scope: FillScope; fields: IntentField[]; trigger: string; leftToYou: IntentField[] }
  | { route: "plan" };

/** The plan error code a refusal or an ask is reported under (protocol PlanErrorCode, unchanged). */
const REFUSE_CODE = { neverTyped: "notEditable", noSuchField: "unknownTarget", notOnScreen: "noWindow", pressOrSend: "unsupportedStep", payment: "unsupportedStep", otherPersonUnnamed: "unsure", nothingToFill: "nothingToDo" } as const;

function stop(why: Exclude<Reason, "none">): never {
  const code = why in REFUSE_CODE ? REFUSE_CODE[why as keyof typeof REFUSE_CODE] : "unsure";
  throw new PlannerError(code, WHY_SAYS[why]);
}

/**
 * Checks an intent against its snapshot and the instruction, and builds the fill's scope. Every ref must be one
 * the snapshot lists, every literal an exact span of the instruction tied to a field in scope, and a person one
 * the snapshot found in the instruction. Throws PlannerError("schema") for an intent that breaks those rules, and
 * the refusal's or the question's code when the intent (or a rule code applies regardless of it) says so:
 * someone's details by a pronoun with no one named, or only fields Caret never types.
 */
export function checkIntent(intent: AskIntent, snap: IntentSnapshot): CheckedIntent {
  const bad = (what: string): never => {
    throw new PlannerError("schema", `the intent ${what}`);
  };
  if (!ROUTES.includes(intent.route)) bad(`has route '${intent.route}'`);
  if (!REASONS.includes(intent.why)) bad(`gives reason '${intent.why}'`);
  // Someone's details by a pronoun, with no one named, is refused whatever the maker said: fill would take the
  // user's own (B25 held-out rule 4).
  if (snap.persons.length === 0 && PRONOUN_DETAILS.test(snap.instruction)) stop("otherPersonUnnamed");
  if (intent.route === "refuse" || intent.route === "ask") stop(intent.why === "none" ? (intent.route === "ask" ? "whichFields" : "nothingToFill") : intent.why);
  if (intent.route === "plan") return { route: "plan" };

  const byRef = new Map(snap.fields.map((f) => [f.ref, f]));
  let scoped: IntentField[] = [];
  if (intent.scope === "all") scoped = snap.fields.filter((f) => !f.filled);
  else if (intent.scope === "section") {
    const s = snap.sections.find((x) => x.ref === intent.section) ?? bad(`names section '${intent.section}', which the snapshot does not list`);
    scoped = snap.fields.filter((f) => f.section === s.name && !f.filled);
  } else if (intent.scope === "list") {
    scoped = [];
    for (const r of intent.fields) {
      const f = byRef.get(r) ?? bad(`names field '${r}', which the snapshot does not list`);
      if (!scoped.includes(f)) scoped.push(f);
    }
  } else bad(`has scope '${String(intent.scope)}'`);
  // Document order, whatever order the maker listed them in.
  scoped.sort((a, b) => snap.fields.indexOf(a) - snap.fields.indexOf(b));
  const leftToYou = scoped.filter((f) => f.neverTyped !== null);
  const fields = scoped.filter((f) => f.neverTyped === null);
  if (fields.length === 0) stop(leftToYou.length > 0 ? "neverTyped" : "noSuchField");

  const any = intent.sources.length === 0 || intent.sources.includes("any");
  const windows = new Set<string>();
  let memory = any;
  for (const s of intent.sources) {
    // The instruction is always a source of its own literals; naming it adds nothing else.
    if (s === "any" || s === "instruction") continue;
    if (s === "memory") memory = true;
    else windows.add((snap.windows.find((x) => x.ref === s) ?? bad(`names source '${s}', which the snapshot does not list`)).windowId);
  }

  let person: string | null = null;
  if (intent.whose === "unnamed") stop("otherPersonUnnamed");
  else if (intent.whose !== "user") person = (snap.persons.find((p) => p.ref === intent.whose) ?? bad(`names person '${intent.whose}', whom the instruction does not name`)).span;

  const literals = new Map<string, string>();
  for (const l of intent.literals) {
    const f = byRef.get(l.field) ?? bad(`ties a value to field '${l.field}', which the snapshot does not list`);
    if (!fields.includes(f)) bad(`ties '${l.text}' to ${f.name}, which is not among its fields`);
    const text = l.text.trim();
    if (text === "" || text.length > 200 || !occursBounded(snap.instruction, text)) bad(`ties '${text.slice(0, 60)}' to ${f.name}, and that is not a span of the instruction`);
    if (neverTypedValue(text) !== null) stop("neverTyped");
    if (literals.has(f.key) && literals.get(f.key) !== text) bad(`ties two values to ${f.name}`);
    literals.set(f.key, text);
  }

  const scope: FillScope = {
    fields: fields.map((f) => f.key),
    windows: any ? null : windows,
    memory,
    instruction: snap.instruction,
    person,
    literals,
  };
  // The fill engine's trigger: the focused field when it is in scope, else the first field in scope.
  const focused = snap.window.focusedKey;
  const trigger = fields.some((f) => f.key === focused) ? (focused as string) : (fields[0] as IntentField).key;
  return { route: "fill", scope, fields, trigger, leftToYou };
}

/** How the user is told what an Ask left to them. */
export function leftToYouSays(fields: readonly IntentField[]): string | null {
  if (fields.length === 0) return null;
  return fields.map((f) => `${f.name} (${NEVER_TYPED_SAYS[f.neverTyped as NeverTyped]})`).join(", ");
}
