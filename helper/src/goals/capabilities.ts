// Which presses Caret may make itself (D2-06, plan section 5: "Predictable safe presses need a registered capability
// describing both effect and verifier; 'the model said Save is safe' is not one"). A goal plan's press is lowered by
// pressVerdict, and since G1 (CU-COUNSEL-R2 Q3) the executor asks it again before any plan's press (executor.ts
// pressStep), so this table is the one authority for Caret's presses.
//
// The registry is code, frozen, and deliberately small: one capability. pressVerdict decides, in this order:
//   1. A control whose label reads as outbound, destructive, money or system (risk.ts: Send, Submit, Pay, Delete,
//      Allow and their kin), or any control in a system prompt, is the user's to press. No capability is consulted.
//   2. A page control is the user's to press: the page engine never runs a page's own script (extension
//      content/actions.ts answers every pagePress with a hand-off).
//   3. A capability whose effect the program named, whose role matches, and whose labels hold the control's whole
//      label, makes the press. Its verifier is an executor end state checked after the press.
//   4. Everything else is the user's to press, said as such ("Caret cannot check what pressing X changes").
// The reader and the executor still check every press against their own tables (RiskTable.swift, risk.ts
// classifyPress) right before it is made: a capability can only narrow what they allow, never widen it.
import { classifyPress, type RiskClass } from "../executor/risk.ts";
import type { Identity } from "../executor/schema.ts";
import { anchorsOf } from "./identity.ts";

/** The effect a goal plan names for a press the user makes. Every pressable target lists it. */
export const YOURS_EFFECT = "e:yours";

export interface PressCapability {
  /** The EffectRef a program passes to press(). */
  readonly effect: string;
  /** Whole labels, lowercased with spaces collapsed. Each must be one the boundary tables already allow. */
  readonly labels: readonly string[];
  readonly roles: readonly string[];
  /** What the press does, for the preview. */
  readonly says: (label: string) => string;
  /** The executor end state that verifies it (executor/schema.ts). */
  readonly verifier: "fieldsRevealed";
  /** The effect changes what the window offers, so the steps after it need another acceptance. */
  readonly endsSegment: boolean;
}

/**
 * "Next" shows the next part of a form in the same window. Verified as executor end state fieldsRevealed: at least
 * one editable field the window did not show before, none it showed changed or gone, same window and title.
 *
 * Not "Continue": macOS and web dialogs use it to confirm what came before ("This will erase the disk. Continue"),
 * so it stays unclassified at every boundary and a goal plan hands it to the user. Not "Next page": the fixture
 * and real apps use it to page through results, which reveals no field.
 */
const REVEAL_FIELDS: PressCapability = Object.freeze({
  effect: "e:reveal",
  labels: Object.freeze(["next"]),
  roles: Object.freeze(["AXButton"]),
  says: (label: string) => `Press '${label}' to show the next fields`,
  verifier: "fieldsRevealed",
  endsSegment: true,
});

export const PRESS_CAPABILITIES: readonly PressCapability[] = Object.freeze([REVEAL_FIELDS]);

const wholeLabel = (label: string): string => label.trim().replace(/\s+/g, " ").toLowerCase();

export type HandoffWhy = Exclude<RiskClass, "safe"> | "unverifiable";

export type PressVerdict =
  | { kind: "press"; capability: PressCapability }
  | { kind: "handoff"; why: HandoffWhy; says: string };

export interface PressTarget {
  label: string;
  role: string;
  /** The window's kind (reader subrole spelling) and its app, for the system-prompt check. */
  windowKind: string;
  bundleId: string;
  /** A page engine's window: its presses are always the user's. */
  page: boolean;
}

/** The effects a program may name for this control: a capability's when one could apply, and always YOURS_EFFECT. */
export function allowedEffects(t: PressTarget): string[] {
  const v = pressVerdict(t, null);
  return v.kind === "press" ? [v.capability.effect, YOURS_EFFECT] : [YOURS_EFFECT];
}

/**
 * How a goal plan's press of `t` is lowered. `effect` is what the program asked for; null asks which capability
 * would apply. A program can never turn a risk-class or page press into Caret's own by naming an effect.
 */
export function pressVerdict(t: PressTarget, effect: string | null): PressVerdict {
  const label = t.label.trim();
  const named = label === "" ? "this control" : `'${label}'`;
  const risk = classifyPress({ label, windowKind: t.windowKind, bundleId: t.bundleId });
  if (risk !== "safe" && risk !== "unclassified") return { kind: "handoff", why: risk, says: `${named} reads as ${risk}; you press it` };
  if (t.page) return { kind: "handoff", why: "unverifiable", says: `${named} runs the page's own script; you press it` };
  if (effect === YOURS_EFFECT) return { kind: "handoff", why: "unverifiable", says: `you press ${named}` };
  const whole = wholeLabel(label);
  const cap = PRESS_CAPABILITIES.find((c) => (effect === null || c.effect === effect) && c.roles.includes(t.role) && c.labels.includes(whole));
  // The boundary tables must allow it too; a capability that names a label they do not is a registry bug.
  if (cap !== undefined && risk === "safe") return { kind: "press", capability: cap };
  return { kind: "handoff", why: "unverifiable", says: `Caret cannot check what pressing ${named} changes; you press it` };
}

// MARK: - navigation (slice 2, CU-COUNSEL-R2)

/**
 * What a navigation may change in its window, checked after the act instead of the executor's "nothing else changed"
 * rule. `window` "same": a new window or sheet of the app during the act stops the step. `history` (page only): "none",
 * the navigation generation must not move; "sameDocument", at most one history update with the same document id and
 * origin, and a commit stops and revokes. `editable` "mayReplaceEmpty": no editable field may change value; fields may
 * appear; a field may vanish only if it was empty or held a value this task wrote.
 */
export interface ExpectedTransition {
  window: "same";
  history: "none" | "sameDocument";
  editable: "mayReplaceEmpty";
  title: "same" | "any";
}

export interface NavCapability {
  readonly name: "selectRow" | "openItem";
  /** The EffectRef a program passes to navigate(). */
  readonly effect: "e:select" | "e:open";
  /** Roles a target may have: a native row, or a page row, option or list item (as the page engine names them). */
  readonly targets: { readonly native: readonly string[]; readonly page: readonly string[] };
  /** The executor end state that verifies it (executor/schema.ts). */
  readonly verifier: "rowSelected" | "itemOpened";
  readonly transition: ExpectedTransition;
  /** The detail changes what the window offers, so the steps after it need another acceptance. */
  readonly endsSegment: true;
  readonly undo: "reselect";
  /** The preview's row: Caret's act, or the user's with Caret continuing after it. */
  readonly says: (id: Identity, actor: "caret" | "you") => string;
}

/** An identity in the user's words: its longest anchor quoted, the other anchors after it ("'Flight itinerary' (Kayak)"). */
function rowWords(id: Identity): string {
  const anchors = anchorsOf(id);
  const main = [...anchors].sort((a, b) => b.length - a.length)[0] ?? id.cells[0] ?? "";
  const rest = anchors.filter((a) => a !== main);
  return `'${main}'${rest.length === 0 ? "" : ` (${rest.join(", ")})`}`;
}

/**
 * Select one row of a table, outline or list; verified by rowSelected on the exact row. Native AXRow only once the
 * reader reports the row selectable (AXSelected or the parent's AXSelectedRows settable); that probe has not run on the
 * caret-fixture NSTableView yet, so every native row is the user's to select (navVerdict).
 */
const SELECT_ROW: NavCapability = Object.freeze({
  name: "selectRow",
  effect: "e:select",
  targets: Object.freeze({ native: Object.freeze(["AXRow"]), page: Object.freeze(["row", "option"]) }),
  verifier: "rowSelected",
  transition: Object.freeze({ window: "same", history: "none", editable: "mayReplaceEmpty", title: "same" }),
  endsSegment: true,
  undo: "reselect",
  says: (id: Identity, actor: "caret" | "you") => (actor === "caret" ? `Select ${rowWords(id)}` : `Select ${rowWords(id)} yourself. Caret continues once it is selected`),
});

/**
 * Open the item a row names, shown in the same window; verified by itemOpened. Title "any": Gmail retitles the document
 * on open. Page targets are a `row` in grid, treegrid or table, an `option` in listbox, and a `listitem` in list only with
 * an explicit role or a tabindex; a link only with no href or a hash-only one. Google Calendar's events are role=button,
 * so they are not targets.
 */
const OPEN_ITEM: NavCapability = Object.freeze({
  name: "openItem",
  effect: "e:open",
  targets: Object.freeze({ native: Object.freeze(["AXRow"]), page: Object.freeze(["row", "option", "listitem"]) }),
  verifier: "itemOpened",
  transition: Object.freeze({ window: "same", history: "sameDocument", editable: "mayReplaceEmpty", title: "any" }),
  endsSegment: true,
  undo: "reselect",
  says: (id: Identity, actor: "caret" | "you") => (actor === "caret" ? `Open ${rowWords(id)}` : `Open ${rowWords(id)} yourself. Caret continues once it's open`),
});

export const NAV_CAPABILITIES: readonly NavCapability[] = Object.freeze([SELECT_ROW, OPEN_ITEM]);

export interface NavTarget {
  /** The target's kind as the reader or page engine names it: an AX role natively, an ARIA role on a page. */
  kind: string;
  page: boolean;
  label: string;
  windowKind: string;
  bundleId: string;
  /** Native: the walker found AXSelected or the parent's AXSelectedRows settable. False until the reader reports it. */
  selectable: boolean;
  /** Page: computed by the walker from the live DOM; null until the page engine reports it (slice 2 step 3). */
  inForm: boolean | null;
  href: "none" | "hash" | "other" | null;
}

export type NavVerdict =
  | { kind: "navigate"; capability: NavCapability; actor: "caret" }
  | { kind: "navigate"; capability: NavCapability; actor: "you"; why: string }
  | { kind: "refuse"; why: HandoffWhy; says: string };

/**
 * How a navigate step on `t` with `effect` is lowered. Refused: a row whose label reads as a risk class, or any row of a
 * system prompt, as pressVerdict narrows. The user's ("you"): the effect asked for it (YOURS_EFFECT, which opens), or
 * Caret cannot make the transition itself here: a page target the page engine has not qualified, is in a form, or links
 * elsewhere; a native row the reader cannot select. Otherwise Caret's. A program names the effect; it never picks the
 * actor.
 */
export function navVerdict(t: NavTarget, effect: string): NavVerdict {
  const label = t.label.trim();
  const named = label === "" ? "this row" : `'${label}'`;
  const risk = classifyPress({ label, windowKind: t.windowKind, bundleId: t.bundleId });
  if (risk !== "safe" && risk !== "unclassified") return { kind: "refuse", why: risk, says: `${named} reads as ${risk}; Caret does not open it` };
  const capability = effect === YOURS_EFFECT ? OPEN_ITEM : NAV_CAPABILITIES.find((c) => c.effect === effect);
  if (capability === undefined) return { kind: "refuse", why: "unverifiable", says: `Caret has no way to check what ${effect} does to ${named}` };
  if (!t.page && !capability.targets.native.includes(t.kind)) return { kind: "refuse", why: "unverifiable", says: `${named} is not a row Caret can ${capability.name === "openItem" ? "open" : "select"}` };
  if (effect === YOURS_EFFECT) return { kind: "navigate", capability, actor: "you", why: "the plan leaves it to you" };
  // A page target the engine has not qualified (null) is treated as one that failed: the user clicks it.
  if (t.page && (!capability.targets.page.includes(t.kind) || t.inForm !== false || t.href === null || t.href === "other")) return { kind: "navigate", capability, actor: "you", why: "Caret cannot click this row without running more of the page's script than a row click" };
  if (!t.page && !t.selectable) return { kind: "navigate", capability, actor: "you", why: "the app does not let Caret select this row" };
  return { kind: "navigate", capability, actor: "caret" };
}

/** The navigate effects a program may name for a row: each capability whose targets take it, and YOURS_EFFECT. Empty when every one refuses. */
export function allowedNavigateEffects(t: NavTarget): string[] {
  const ok = NAV_CAPABILITIES.filter((c) => navVerdict(t, c.effect).kind === "navigate").map((c) => c.effect);
  return ok.length === 0 ? [] : [...ok, YOURS_EFFECT];
}
