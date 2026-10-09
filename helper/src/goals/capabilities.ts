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
