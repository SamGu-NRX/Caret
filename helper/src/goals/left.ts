// What a form needs that a goal must account for (G2). A goal is done only when every step it planned was written
// and read back and the windows it writes in are left with nothing their own kind requires:
//   - a message's recipient: the To field of a window with a Send button, or of a reply ("Re: ..."). A goal's To takes
//     only the sender of the message the reply answers (B30, drafts.ts senderOf), which lowering fills itself when the
//     program did not; a recipient code cannot fill is the user's to add.
//   - a field or control the form marks required: a label or placeholder ending in "*", "(required)" or "[required]"
//     (the marks fill/descriptor.ts strips from names), on a text field, a popup (empty while it shows a prompt such as
//     "Select..."), a date or time field, a box (empty while unticked) or a radio group (empty while none is checked;
//     marked on the group). A page's `required` attribute does not reach the screen model, so a field marked only that
//     way is not seen here.
// Read from the screen model when a goal is planned (inventory.ts) and again when it ends (runs.ts).
import type { WindowState } from "../model.ts";
import { FILLABLE_ROLES } from "../fill/fill.ts";
import { fieldKinds } from "../fill/kinds.ts";
import { fieldLabelText } from "../fill/descriptor.ts";
import { fieldName } from "../planner/planner.ts";
import { recipientField } from "./drafts.ts";

const REQUIRED_MARK = /(?:\*+|\(required\)|\[required\])\s*$/iu;
/** What a popup shows while nothing is chosen (fill/controls.ts reads the same prompts). */
const PROMPT = /^(?:|select\b.*|choose\b.*|please (?:select|choose)\b.*|pick\b.*|-+.*-*|month|day|year|—)$/iu;
/** Controls other than text a form can require, and whether each reads as unset. */
const UNSET: Readonly<Record<string, (n: { value?: string; states?: readonly string[] }) => boolean>> = {
  AXPopUpButton: (n) => PROMPT.test((n.value ?? "").trim()),
  AXDateField: (n) => (n.value ?? "").trim() === "",
  AXTimeField: (n) => (n.value ?? "").trim() === "",
  AXCheckBox: (n) => n.states?.includes("checked") !== true,
};

/** A field a goal writing in its window must see filled. `empty` is whether it holds no text now. */
export interface OwedField {
  key: string;
  label: string;
  why: "required" | "recipient";
  empty: boolean;
}

/** Whether a window composes a message: it has a Send button, or its title answers or forwards one. */
export function composes(w: WindowState): boolean {
  return /^\s*(?:re|fwd?|fw)\s*:/iu.test(w.window.title) || [...w.nodes.values()].some((n) => n.role === "AXButton" && /^send\b/iu.test((n.label ?? "").trim()));
}

/**
 * The fields of `w` a goal that writes in it owes: its recipient when it composes a message, and every field marked
 * required. A secure field is left out: its value is never read, so whether it is empty cannot be known.
 */
export function owedFields(w: WindowState): OwedField[] {
  const composer = composes(w);
  const out: OwedField[] = [];
  const marked = (n: { label?: string; placeholder?: string }): boolean => REQUIRED_MARK.test(n.label ?? "") || REQUIRED_MARK.test(n.placeholder ?? "");
  const nodes = [...w.nodes.values()];
  /** Each radio group by its parent's key: how many buttons it has and whether one is checked. */
  const groups = new Map<string, { size: number; checked: boolean }>();
  for (const m of nodes) {
    if (m.role !== "AXRadioButton" || m.parent === null) continue;
    const g = groups.get(m.parent) ?? { size: 0, checked: false };
    groups.set(m.parent, { size: g.size + 1, checked: g.checked || m.states?.includes("checked") === true });
  }
  for (const n of nodes) {
    if (n.states?.includes("disabled")) continue;
    const unset = UNSET[n.role];
    // A page's controls arrive editable (engines/page-link.ts), so a control is read by its role, editable or not.
    if (unset !== undefined && marked(n)) {
      out.push({ key: n.key, label: fieldLabelText(n.label) ?? fieldLabelText(n.placeholder) ?? n.role, why: "required", empty: unset(n) });
      continue;
    }
    // A radio group: its buttons' parent carries the mark; it is unset while none of them is checked.
    const group = groups.get(n.key);
    if (group !== undefined && group.size >= 2 && marked(n)) {
      out.push({ key: n.key, label: fieldLabelText(n.label) ?? "a choice", why: "required", empty: !group.checked });
      continue;
    }
    if (n.editable !== true || !FILLABLE_ROLES.has(n.role) || n.states?.includes("secure")) continue;
    const label = fieldName(w, n);
    // The same reading as lower.ts toField: a To label, or an email field of a window that sends.
    const r = recipientField(label) ?? (fieldKinds([label]).has("email") ? "to" : null);
    const recipient = composer && r === "to";
    const required = marked(n);
    if (!recipient && !required) continue;
    out.push({ key: n.key, label, why: recipient ? "recipient" : "required", empty: (n.value ?? "").trim() === "" });
  }
  return out;
}
