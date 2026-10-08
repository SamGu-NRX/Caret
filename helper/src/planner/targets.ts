// I2 lead ruling: one inventory of the fields an Ask may write, read by the intent snapshot (intent.ts, which the
// per-field scope question asks about) and the native planner (planner.ts writableFields, the code-mode writer and goal
// inventories through it). Before it the two built their lists apart, so the planner could write a field the scope
// question never saw. A field with no readable name cannot be scoped meaningfully: it is in no list, an Ask leaves it
// to the user (ask.ts), and the guard refuses it as outside every scope.
import type { WindowState } from "../model.ts";
import type { Node } from "../protocol.ts";
import { describeField } from "../fill/descriptor.ts";
import { formControls, inWebArea, type Control } from "../fill/controls.ts";
import { FILLABLE_ROLES } from "../fill/fill.ts";

export interface WritableTarget {
  node: Node;
  control: Control;
  /** What the field is called: its label, nearest text, or (a typed field's) placeholder. */
  name: string;
}

/** A window's fields: the page's text fields (never the browser's own) and its controls, in document order. */
function formInventory(w: WindowState): { node: Node; control: Control }[] {
  const web = [...w.nodes.values()].some((n) => n.role === "AXWebArea");
  const out: { node: Node; control: Control }[] = [];
  const byKey = new Map(formControls(w).map((c) => [c.node.key, c]));
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

const nameOf = (w: WindowState, x: { node: Node; control: Control }): string | null => {
  const d = describeField(w, x.node);
  return x.control === "text" || x.control === "combobox" ? (d.label ?? d.nearest ?? d.placeholder) : (d.label ?? d.nearest);
};

/** The fields an Ask or the native planner may write, each with a readable name, in document order. */
export function writableTargets(w: WindowState): WritableTarget[] {
  return formInventory(w).flatMap((x) => {
    const name = nameOf(w, x);
    return name === null ? [] : [{ ...x, name }];
  });
}

/** The fields a window has that no name reads: never an Ask's to write. */
export function unnamedTargets(w: WindowState): Node[] {
  return formInventory(w).filter((x) => nameOf(w, x) === null).map((x) => x.node);
}
