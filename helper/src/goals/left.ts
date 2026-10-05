// What a form needs that a goal must account for (G2). A goal is done only when every step it planned was written
// and read back and the windows it writes in are left with nothing their own kind requires:
//   - a message's recipient: the To field of a window with a Send button, or of a reply ("Re: ..."). A goal's To takes
//     only the sender of the message the reply answers (B30, drafts.ts senderOf), which lowering fills itself when the
//     program did not; a recipient code cannot fill is the user's to add.
//   - a field the form marks required: a label or placeholder ending in "*", "(required)" or "[required]" (the marks
//     fill/descriptor.ts strips from names). A page's `required` attribute does not reach the screen model, so a field
//     marked only that way is not seen here.
// Read from the screen model when a goal is planned (inventory.ts) and again when it ends (runs.ts).
import type { WindowState } from "../model.ts";
import { FILLABLE_ROLES } from "../fill/fill.ts";
import { fieldKinds } from "../fill/kinds.ts";
import { fieldName } from "../planner/planner.ts";
import { recipientField } from "./drafts.ts";

const REQUIRED_MARK = /(?:\*+|\(required\)|\[required\])\s*$/iu;

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
  for (const n of w.nodes.values()) {
    if (n.editable !== true || !FILLABLE_ROLES.has(n.role) || n.states?.includes("secure")) continue;
    const label = fieldName(w, n);
    // The same reading as lower.ts toField: a To label, or an email field of a window that sends.
    const r = recipientField(label) ?? (fieldKinds([label]).has("email") ? "to" : null);
    const recipient = composer && r === "to";
    const required = REQUIRED_MARK.test(n.label ?? "") || REQUIRED_MARK.test(n.placeholder ?? "");
    if (!recipient && !required) continue;
    out.push({ key: n.key, label, why: recipient ? "recipient" : "required", empty: (n.value ?? "").trim() === "" });
  }
  return out;
}
