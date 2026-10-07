// HA2 (lead decisions on the df8056b review): the text an owner judgement must have seen before it counts, and the digest
// a value admitted by it is held to until it is written. Every path that asks whose a window value is reads it here:
// fill's owner questions (fill.ts), the planner's and the code writer's (planner/codeplan.ts verifyWrites), and a writer
// goal's value gate (goals/gates.ts jevGate, through the notes its inventory froze). Incomplete evidence fails closed:
//   (a) every node on screen that holds the value is shown, not only the one the candidate generator kept (it keeps one
//       source per text, candidates.ts add): the same phone in a second note that disclaims it is evidence too;
//   (b) a unit redaction cut (fill/redact.ts drops secret lines and nodes) is incomplete, and no value from it is admitted
//       on ownership: the cut line may be the disclaimer, and showing it would reveal the secret;
//   (c) the unit is the text area itself (TextEdit, Notes: one editable text holds the whole note), and for any other node
//       the whole window: a mail's paragraphs or a page's text runs are fragments of a region Caret can't bound from the
//       walk, and the window always contains it. Showing more than the region is safe; a window too large to show
//       withholds.
import { createHash } from "node:crypto";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import type { Node } from "../protocol.ts";
import { redactWindow } from "./redact.ts";

/** A text owner questions show whole. */
export interface NoteUnit {
  windowId: string;
  /** The text area the unit is, or null for its whole window. */
  nodeKey: string | null;
  /** The unit as the redacted view shows it. */
  text: string;
  /** False when redaction removed any of it (b): its values are never admitted on ownership. */
  complete: boolean;
  /** Over the window, the unit and its text, and whether it is complete: what a value admitted on it is bound to. */
  digest: string;
}

/** A text that holds a whole note by itself: a text area, or an editable text field (a note app's body). */
function textArea(n: Node): boolean {
  return n.role === "AXTextArea" || (n.role === "AXTextField" && n.editable === true);
}

const flat = (t: string): string => t.replace(/\s+/gu, " ").trim();

/** The unit a source node belongs to (c), or null when its window or node is gone. */
export function unitOf(model: ScreenModel, windowId: string, nodeKey: string): NoteUnit | null {
  const raw = model.windows.get(windowId);
  const node = raw?.nodes.get(nodeKey);
  if (raw === undefined || node === undefined) return null;
  return build(raw, textArea(node) ? nodeKey : null);
}

function build(raw: WindowState, nodeKey: string | null): NoteUnit {
  const view = redactWindow(raw);
  const keys = nodeKey === null ? [...raw.nodes.keys()] : [nodeKey];
  let complete = true;
  const texts: string[] = [];
  for (const k of keys) {
    const r = raw.nodes.get(k);
    const v = view.nodes.get(k);
    const rt = r === undefined ? "" : nodeText(r).trim();
    const vt = v === undefined ? "" : nodeText(v).trim();
    // (b): any line or node the view does not give is a cut, whatever it held.
    if (rt !== vt) complete = false;
    if (vt !== "") texts.push(vt);
  }
  const text = texts.join("\n");
  const digest = createHash("sha256").update(`${raw.window.windowId}\u0000${nodeKey ?? "*"}\u0000${complete ? "1" : "0"}\u0000${text}`).digest("hex").slice(0, 32);
  return { windowId: raw.window.windowId, nodeKey, text, complete, digest };
}

/** The identity of a unit, for sets and maps. */
export const unitKey = (u: { windowId: string; nodeKey: string | null }): string => `${u.windowId}\u0000${u.nodeKey ?? "*"}`;

/**
 * Every unit on screen that holds `value` (a), read in the raw windows, so a node redaction dropped still counts and makes
 * its unit incomplete, and `from`, the unit the value was read from; never the form's own window (`form`). Read locally
 * only: nothing here is sent.
 */
export function unitsHolding(model: ScreenModel, value: string, form: string | null, from: { windowId: string; nodeKey: string } | null): NoteUnit[] | null {
  const want = flat(value);
  const out = new Map<string, NoteUnit>();
  if (from !== null) {
    const own = unitOf(model, from.windowId, from.nodeKey);
    if (own === null) return null;
    out.set(unitKey(own), own);
  }
  if (want === "") return [...out.values()];
  for (const w of model.windows.values()) {
    if (w.window.windowId === form) continue;
    for (const n of w.nodes.values()) {
      if (!flat(nodeText(n)).includes(want)) continue;
      const k = unitKey({ windowId: w.window.windowId, nodeKey: textArea(n) ? n.key : null });
      if (!out.has(k)) out.set(k, build(w, textArea(n) ? n.key : null));
    }
  }
  return [...out.values()];
}

/** What a value admitted on ownership is bound to (contract.ts Provenance owned): the form, and each unit's digest. */
export interface OwnedEvidence {
  form: string | null;
  units: readonly { windowId: string; nodeKey: string | null; digest: string }[];
}

export function ownedOf(form: string | null, units: readonly NoteUnit[]): OwnedEvidence {
  return { form, units: units.map((u) => ({ windowId: u.windowId, nodeKey: u.nodeKey, digest: u.digest })) };
}

/**
 * P1: why a value admitted on ownership may no longer be written, or null: the units that hold it now must be exactly the
 * units its owner judgement saw, each with the digest it had. A changed note, a cut that appeared, a note that now holds
 * the value or one that no longer does, all refuse it.
 */
export function ownedStale(model: ScreenModel, span: string, from: { windowId: string; nodeKey: string }, owned: OwnedEvidence): string | null {
  const now = unitsHolding(model, span, owned.form, from);
  if (now === null) return "the note Jev judged whose it is is gone";
  const was = new Map(owned.units.map((u) => [unitKey(u), u.digest]));
  if (now.length !== was.size || now.some((u) => was.get(unitKey(u)) !== u.digest)) return "the note Jev judged whose it is changed";
  return null;
}
