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
import { FILE_INPUT_SUBROLE } from "../engines/page-link.ts";
import { PAGE_WINDOW_KIND } from "../engines/windows.ts";
import type { ScreenModel, WindowState } from "../model.ts";
import type { Node } from "../protocol.ts";
import { describeField } from "../fill/descriptor.ts";
import { headingsBefore } from "../fill/ask-scope.ts";
import { formControls, inWebArea, type Control } from "../fill/controls.ts";
import { FILLABLE_ROLES, neverTypedNode, type FillScope } from "../fill/fill.ts";
import { mentionedKind, type SensitiveKind } from "../memory/sensitive.ts";
import { SnippetLedger } from "../privacy.ts";
import { occursBounded, secretIn, type MemoryValue } from "./trace.ts";
import { instructionValues } from "./spans.ts";
import { fieldWords, namedSources, onlyInSources, restrictsSources, senderNames, senderOf, type NamedSource } from "./sources.ts";
import { PlannerError } from "./validate.ts";
import { peopleOnScreen, PRONOUN_DETAILS, type PersonCandidate } from "./people.ts";
import { SAYS, SaidError, Unclear, saysLeftToYou, saysNeverTyped, saysPressAsked, saysSsn, type AskPart } from "./says.ts";

export const ROUTES = ["fill", "plan", "ask", "refuse"] as const;
export type AskRoute = (typeof ROUTES)[number];
/** Why an intent refuses, or what it asks; each has a sentence in says.ts (sayWhy). */
export const REASONS = ["none", "neverTyped", "noSuchField", "notOnScreen", "pressOrSend", "payment", "otherPersonUnnamed", "nothingToFill", "whichFields", "whichSource", "whichPerson"] as const;
export type Reason = (typeof REASONS)[number];

export interface AskIntent {
  route: AskRoute;
  why: Reason;
  /**
   * "none" only for a route that fills nothing (refuse, ask, plan). A3: a plan from the heads maker carries Jev's
   * fields as a list, for a page host that fills a plan's form instead (ask.ts planAsAll).
   */
  scope: "all" | "section" | "list" | "none";
  /** A section ref ("s1") when scope is section; "none" otherwise. */
  section: string;
  /** Field refs ("f3") when scope is list. */
  fields: readonly string[];
  /** Window refs ("w2"), "memory", "instruction", or "any" for every source fill reads today. */
  sources: readonly string[];
  /** "user", "unnamed" (someone else, not named), or a person ref ("p1") from the snapshot. */
  whose: string;
  literals: readonly { field: string; text: string }[];
  /**
   * The parts a maker could not settle, in the order to ask them (B29). Only on route "ask"; the rest of the intent
   * holds what it did settle. Absent when the maker says only `why`.
   */
  open?: readonly AskPart[];
  /**
   * A3: the fields are Jev's own answers, field by field, in two wordings that both said "asks" at the cutoff
   * (intent-heads.ts). planAsk asks no further confirmation of them. Only the heads maker sets it; the writer's strict
   * schema has no such key.
   */
  agreed?: true;
  /** I2 ruling B: the upload fields (IntentSnapshot.uploads refs) Jev's scope question chose, which join the Ask's scope. */
  uploads?: string[];
  /**
   * A3: the fields (refs) to offer when this intent asks which fields: those Jev left unclear, with those it chose. Only
   * the heads maker sets it, and choices.ts offers exactly these, never fields code picked itself.
   */
  options?: readonly string[];
  /**
   * A3: Jev chose every empty field, so fill asks their values as Fill all does (FillScope.wholeForm). The scope is
   * still the list of those fields. Only the heads maker sets it.
   */
  wholeForm?: true;
  /**
   * A3: on a plan from the heads maker, the parts its fill would leave open, in the order to ask them. A page host that
   * fills the plan's form instead asks these first (ask.ts planAsAll); every other consumer plans and ignores them.
   */
  pageOpen?: readonly AskPart[];
  /**
   * A1: whose details go in, as code resolved them to a name the instruction does not spell (people.ts): the one other
   * person in its sources, or a memory entry for the relation it names. Takes the place of a person ref in `whose`.
   */
  person?: string;
}

/**
 * What the user picked in answer to an Ask's questions (B29), by what code resolved each pick to: the fields' node
 * keys, the window to copy from, whose details. Each replaces that part of the intent and grants nothing else.
 */
export interface AskFixed {
  fields?: readonly string[];
  /** A window by id, or what the user told Caret. */
  source?: { kind: "window"; windowId: string } | { kind: "memory" };
  person?: { kind: "user" } | { kind: "person"; name: string };
}

export interface IntentField {
  ref: string;
  key: string;
  name: string;
  /** The field's group or fieldset label (describeField's section). */
  section: string | null;
  /** A3: the nearest heading before the field in document order, when the ledger took its text. */
  heading: string | null;
  control: Control;
  /** A text field that already holds a value; only a list names it. */
  filled: boolean;
  neverTyped: SensitiveKind | null;
  /** I2: a page's file control, asked about only by the scope ask (intent-heads.ts settleUploads); never a fill field. */
  upload?: true;
}

export interface IntentSnapshot {
  instruction: string;
  window: WindowState;
  /** The form window's title as the request carries it, or null when it did not fit its budget. */
  title: string | null;
  fields: IntentField[];
  /**
   * I2 lead ruling B: a page's file controls, in document order, each an upload field the scope question asks about
   * with the fields (intent-heads.ts scopeRequest), never a field a fill writes; refs u1, u2, ...
   */
  uploads: IntentField[];
  sections: { ref: string; name: string }[];
  /** Other open windows a value could come from, most recent first, by title, and a mail's sender when it shows one. */
  windows: { ref: string; windowId: string; app: string; title: string; from: string | null }[];
  /** Labels of what the user told Caret (About entries, people), never their values. */
  memory: string[];
  /** People the instruction names, as exact spans of it ("Gary", "my sister"). */
  persons: { ref: string; span: string }[];
  /** Values the instruction spells out, as exact spans of it (spans.ts), for a maker that can only choose. */
  literals: string[];
  /** A1: the people in the other windows and in memory (people.ts), for code's reading of whose details; never sent to a model. */
  others: PersonCandidate[];
  /** A1: what the user told Caret, for code's reading of a relation ("my wife"); never sent to a model. */
  memoryValues: readonly MemoryValue[];
  /** Windows the instruction names as its source, resolved by code (sources.ts): read with consent (privacy.ts). */
  named: NamedSource[];
  /** Windows the instruction rules out ("without using Dana's email"): never read for this Ask. */
  excluded: string[];
  /** The instruction names a source no open window could be ("off my LinkedIn" with no LinkedIn open). */
  missing: boolean;
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
  if (!ledger.plan([instruction])) throw new SaidError("privacy", SAYS.privacy, "the instruction quotes more of an open window than one request may carry");
  const title = ledger.take(w, "descriptor", [w.window.title]) ? w.window.title : null;
  const fields: IntentField[] = [];
  const sections: { ref: string; name: string }[] = [];
  const headings = headingsBefore(w);
  for (const x of formInventory(w)) {
    if (fields.length >= MAX_INTENT_FIELDS) break;
    const d = describeField(w, x.node);
    const name = x.control === "text" || x.control === "combobox" ? (d.label ?? d.nearest ?? d.placeholder) : (d.label ?? d.nearest);
    if (name === null || !ledger.take(w, "descriptor", [name, d.section])) continue;
    if (d.section !== null && !sections.some((s) => s.name === d.section)) sections.push({ ref: `s${sections.length + 1}`, name: d.section });
    const filled = x.control === "text" && (x.node.value ?? "") !== "";
    const h = headings.get(x.node.key) ?? null;
    const heading = h !== null && ledger.take(w, "descriptor", [h]) ? h : null;
    fields.push({ ref: `f${fields.length + 1}`, key: x.node.key, name, section: d.section, heading, control: x.control, filled, neverTyped: x.control === "text" ? neverTypedNode(w, x.node) : null });
  }
  // File controls, as upload fields for the scope question: the name and its group taken together, as a field's are.
  const uploads: IntentField[] = [];
  for (const n of w.window.kind === PAGE_WINDOW_KIND ? w.nodes.values() : []) {
    if (n.subrole !== FILE_INPUT_SUBROLE || n.states?.includes("disabled") === true || !inWebArea(w, n)) continue;
    const d = describeField(w, n);
    const name = d.label ?? d.nearest;
    if (name === null || !ledger.take(w, "descriptor", [name, d.section])) continue;
    const h = headings.get(n.key) ?? null;
    const heading = h !== null && ledger.take(w, "descriptor", [h]) ? h : null;
    uploads.push({ ref: `u${uploads.length + 1}`, key: n.key, name, section: d.section, heading, control: "text", filled: false, neverTyped: null, upload: true });
  }
  // Other windows by title, most recently focused first. A title is what names a source ("Morgan's email"); a
  // window whose title does not fit what the ledger allows is left out.
  const windows: IntentSnapshot["windows"] = [];
  const others = [...model.windows.values()].filter((o) => o !== w && o.window.title.trim() !== "").sort((a, b) => b.lastFocusedAt - a.lastFocusedAt || b.updatedAt - a.updatedAt);
  for (const o of others) {
    if (windows.length >= MAX_INTENT_WINDOWS) break;
    if (!ledger.take(o, "candidate", [o.window.title])) continue;
    // A mail's sender names it as people do ("Ines's email", "the slot Chris offered"); its subject often does not.
    const sender = senderOf(o);
    const from = sender !== null && sender.length <= 60 && ledger.take(o, "candidate", [sender]) ? sender : null;
    windows.push({ ref: `w${windows.length + 1}`, windowId: o.window.windowId, app: o.app.name, title: o.window.title, from });
  }
  const labels = [...new Set(memory.map((m) => m.label))];
  const memoryLabels = labels.length > 0 && ledger.memory(labels) ? labels : [];
  // People the instruction names: capitalized names and relations, and words that are a mail sender's name however typed.
  const persons = [...new Set([...personSpans(instruction), ...senderNames(instruction, model, w)])];
  const sources = namedSources(instruction, model, w, persons);
  return {
    instruction,
    window: w,
    title,
    fields,
    uploads,
    sections,
    windows,
    memory: memoryLabels,
    persons: persons.map((span, i) => ({ ref: `p${i + 1}`, span })),
    others: peopleOnScreen(model, w, memory),
    memoryValues: memory,
    literals: instructionValues(instruction),
    named: sources.named,
    excluded: sources.excluded,
    missing: sources.missing,
    ledger,
  };
}

/** An intent checked against its snapshot: the fill engine's scope, and what the route needs. */
export type CheckedIntent =
  | { route: "fill"; scope: FillScope; fields: IntentField[]; trigger: string; leftToYou: IntentField[] }
  | { route: "plan" };

/** The plan error code a refusal or an ask is reported under (protocol PlanErrorCode, unchanged). */
const REFUSE_CODE = { neverTyped: "notEditable", noSuchField: "unknownTarget", notOnScreen: "noWindow", pressOrSend: "unsupportedStep", payment: "unsupportedStep", otherPersonUnnamed: "unsure", nothingToFill: "nothingToDo" } as const;

/** What an Ask says for each reason (says.ts). A never-typed refusal names the kind the instruction or a field names. */
function sayWhy(why: Exclude<Reason, "none">, snap: IntentSnapshot, fields: readonly IntentField[] = [], kind: SensitiveKind | null = null): string {
  switch (why) {
    case "neverTyped": {
      if (kind !== null) return saysNeverTyped(kind, kind === "governmentId" && saysSsn(snap.instruction));
      const said = mentionedKind(snap.instruction);
      if (said !== null) return saysNeverTyped(said.kind, said.ssn);
      const f = fields.find((x) => x.neverTyped !== null);
      return f === undefined ? saysNeverTyped("governmentId", false) : saysNeverTyped(f.neverTyped as SensitiveKind, saysSsn(f.name));
    }
    case "pressOrSend":
      return saysPressAsked(snap.instruction);
    case "payment":
      return SAYS.payment;
    case "noSuchField":
      return SAYS.noSuchField;
    case "notOnScreen":
      return SAYS.notOnScreen;
    case "otherPersonUnnamed":
    case "whichPerson":
      return SAYS.whichPerson;
    case "nothingToFill":
      return SAYS.cannot;
    case "whichFields":
      return SAYS.whichFields;
    case "whichSource":
      return SAYS.whichSource;
  }
}

/** The part each unclear reason leaves open (B29): a question with choices may settle it. */
export const UNCLEAR_PART: Partial<Record<Reason, AskPart>> = { whichFields: "fields", whichSource: "source", whichPerson: "person", otherPersonUnnamed: "person" };

function stop(why: Exclude<Reason, "none">, snap: IntentSnapshot, fields: readonly IntentField[] = [], kind: SensitiveKind | null = null): never {
  const part = UNCLEAR_PART[why];
  if (part !== undefined) throw new Unclear(part, sayWhy(why, snap, fields, kind), `the intent's reason: ${why}`);
  const code = why in REFUSE_CODE ? REFUSE_CODE[why as keyof typeof REFUSE_CODE] : "unsure";
  throw new SaidError(code, sayWhy(why, snap, fields, kind), `the intent's reason: ${why}`);
}

/**
 * Checks an intent against its snapshot and the instruction, and builds the fill's scope. Every ref must be one
 * the snapshot lists, every literal an exact span of the instruction tied to a field in scope, and a person one
 * the snapshot found in the instruction. Throws PlannerError("schema") for an intent that breaks those rules, and
 * the refusal's or the question's code when the intent (or a rule code applies regardless of it) says so:
 * someone's details by a pronoun with no one named, or only fields Caret never types.
 *
 * `fixed` holds the user's picks (B29), already applied to `intent` by the caller for its fields and source. A picked
 * person settles whose details go in, the pronoun rule included. A picked source is the only source read: a picked
 * window is consented to as a window the instruction names is, and no other window is read, named or not.
 */
export function checkIntent(intent: AskIntent, snap: IntentSnapshot, fixed: AskFixed = {}): CheckedIntent {
  const bad = (what: string): never => {
    throw new PlannerError("schema", `the intent ${what}`);
  };
  if (!ROUTES.includes(intent.route)) bad(`has route '${intent.route}'`);
  if (!REASONS.includes(intent.why)) bad(`gives reason '${intent.why}'`);
  // Someone's details by a pronoun, with no one named, is refused whatever the maker said: fill would take the
  // user's own (B25 held-out rule 4).
  // Read on the field words: "everything's in her email" names where to copy from, not someone's email (B26 held-out-2).
  if (fixed.person === undefined && intent.person === undefined && snap.persons.length === 0 && PRONOUN_DETAILS.test(fieldWords(snap.instruction))) stop("otherPersonUnnamed", snap);
  // An instruction that names a kind Caret never types ("my SSN goes in there too") is refused for that, whatever
  // reason the maker gave: B25's held-out run told the user "Caret stops before payment" for an SSN.
  // B30: a plan as well, since a goal plan is planned from the instruction's words too.
  if ((intent.route === "refuse" || intent.route === "ask" || intent.route === "plan") && mentionedKind(snap.instruction) !== null) stop("neverTyped", snap);
  // A source no open window could be is said as such, whether the maker filled, asked or refused vaguely: B26's
  // held-out runs told "grab my job title and company off my linkedin" that Caret found nothing to put in Job title,
  // and asked "Where should Caret copy from?" for "grab my company and title off my LinkedIn".
  const vague = intent.route === "refuse" && (intent.why === "none" || intent.why === "nothingToFill" || intent.why === "notOnScreen");
  if (snap.missing && (intent.route === "fill" || intent.route === "ask" || intent.route === "plan" || vague)) stop("notOnScreen", snap);
  if (intent.route === "refuse" || intent.route === "ask") stop(intent.why === "none" ? (intent.route === "ask" ? "whichFields" : "nothingToFill") : intent.why, snap);
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
  } else bad(`fills with scope '${String(intent.scope)}'`);
  // Document order, whatever order the maker listed them in.
  scoped.sort((a, b) => snap.fields.indexOf(a) - snap.fields.indexOf(b));
  const leftToYou = scoped.filter((f) => f.neverTyped !== null);
  const fields = scoped.filter((f) => f.neverTyped === null);
  if (fields.length === 0) stop(leftToYou.length > 0 ? "neverTyped" : "noSuchField", snap, leftToYou);

  const literals = new Map<string, string>();
  for (const l of intent.literals) {
    const f = byRef.get(l.field) ?? bad(`ties a value to field '${l.field}', which the snapshot does not list`);
    if (!fields.includes(f)) bad(`ties '${l.text}' to ${f.name}, which is not among its fields`);
    const text = l.text.trim();
    if (text === "" || text.length > 200 || !occursBounded(snap.instruction, text)) bad(`ties '${text.slice(0, 60)}' to ${f.name}, and that is not a span of the instruction`);
    const secret = secretIn(text, snap.instruction);
    if (secret !== null) stop("neverTyped", snap, [], secret);
    if (literals.has(f.key) && literals.get(f.key) !== text) bad(`ties two values to ${f.name}`);
    literals.set(f.key, text);
  }

  let any = intent.sources.length === 0 || intent.sources.includes("any");
  const windows = new Set<string>();
  let memory = any;
  for (const s of intent.sources) {
    // The instruction is always a source of its own literals; naming it adds nothing else.
    if (s === "any" || s === "instruction") continue;
    if (s === "memory") memory = true;
    else windows.add((snap.windows.find((x) => x.ref === s) ?? bad(`names source '${s}', which the snapshot does not list`)).windowId);
  }
  // The windows the instruction names, as code resolved them (sources.ts), are read whatever windows the maker chose.
  // The instruction alone gives only its own literals: a field in scope with none reads the named windows, or every
  // source when it names none. B25's maker answered "instruction" for "put Bea down as my guest with her meal" and
  // "make my wife the emergency contact", and fill then read no window at all (held-11, held-12, held-14).
  // An instruction that keeps Caret to its own words ("only use what I typed", "don't read other windows") is never
  // widened, and a window it rules out ("without using Dana's email") is never read (B26 review).
  const named = snap.named.map((n) => n.windowId);
  if (!any && windows.size === 0 && !memory && fields.some((f) => !literals.has(f.key)) && !restrictsSources(snap.instruction)) {
    if (named.length === 0) (any = true), (memory = true);
  }
  if (!any) for (const id of named) windows.add(id);
  // A picked source is the only one (B29 review 1): the windows the instruction named are not read beside it.
  if (fixed.source !== undefined) {
    any = false;
    windows.clear();
    if (fixed.source.kind === "window") windows.add(fixed.source.windowId);
    memory = fixed.source.kind === "memory";
  }
  if (snap.excluded.length > 0) {
    // Every source but those: the listed windows, less the excluded. A window past the snapshot's list is not read.
    if (any) for (const x of snap.windows) windows.add(x.windowId);
    any = false;
    for (const id of snap.excluded) windows.delete(id);
  }

  let person: string | null = null;
  if (fixed.person !== undefined) person = fixed.person.kind === "user" ? null : fixed.person.name;
  else if (intent.person !== undefined) {
    // Code resolved this name from the people on screen and in memory; it must still be one of them.
    if (!snap.others.some((p) => p.name === intent.person)) bad(`names '${intent.person}', who is no longer on screen or in memory`);
    person = intent.person;
  }
  else {
    if (intent.whose === "unnamed") stop("otherPersonUnnamed", snap);
    else if (intent.whose !== "user") person = (snap.persons.find((p) => p.ref === intent.whose) ?? bad(`names person '${intent.whose}', whom the instruction does not name`)).span;
    // A person the instruction names only as where to copy from ("from Morgan's email", "the Saturday Chris mentioned")
    // is not whose details go in: the source's words never set the scope. Unless the instruction asks for someone's
    // details by a pronoun ("from Dana's message, with her contact details"): then the source is whose they are.
    if (person !== null && onlyInSources(snap.instruction, person) && !PRONOUN_DETAILS.test(fieldWords(snap.instruction))) person = null;
  }

  const scope: FillScope = {
    fields: fields.map((f) => f.key),
    windows: any ? null : windows,
    memory,
    instruction: snap.instruction,
    person,
    literals,
    consented: fixed.source === undefined ? new Set(named) : new Set(fixed.source.kind === "window" ? [fixed.source.windowId] : []),
    first: [...new Set(snap.named.flatMap((n) => n.names))],
    // C1: a whole-form Ask that narrows nothing asks values as a Fill all does (fill.ts plainAsk).
    wholeForm: intent.scope === "all" || (intent.wholeForm === true && fixed.fields === undefined),
  };
  // The fill engine's trigger: the focused field when it is in scope, else the first field in scope.
  const focused = snap.window.focusedKey;
  const trigger = fields.some((f) => f.key === focused) ? (focused as string) : (fields[0] as IntentField).key;
  return { route: "fill", scope, fields, trigger, leftToYou };
}

/** How the user is told what an Ask left to them. */
export function leftToYouSays(fields: readonly IntentField[]): string | null {
  return saysLeftToYou(fields.flatMap((f) => (f.neverTyped === null ? [] : [{ name: f.name, kind: f.neverTyped }])));
}
