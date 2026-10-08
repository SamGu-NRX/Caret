// HA2 (lead decisions on the df8056b review): the text an owner judgement must have seen before it counts, and the digest
// a value admitted by it is held to until it is written. Every path that asks whose a window value is reads it here:
// fill's owner questions (fill.ts), the planner's and the code writer's (planner/codeplan.ts verifyWrites), and a writer
// goal's value gate (goals/gates.ts jevGate, through the notes its inventory froze). Incomplete evidence fails closed:
//   (a) every node on screen that holds the value is shown, not only the one the candidate generator kept (it keeps one
//       source per text, candidates.ts add): the same phone in a second note that disclaims it is evidence too;
//   (b) a unit redaction cut (fill/redact.ts drops secret lines and nodes) is incomplete, and no value from it is admitted
//       on ownership: the cut line may be the disclaimer, and showing it would reveal the secret;
//   (c) the unit is the text area itself (TextEdit, Notes: one text area holds the whole note), and for any other node
//       the whole window: a mail's paragraphs or a page's text runs are fragments of a region Caret can't bound from the
//       walk, and the window always contains it. Showing more than the region is safe; a window too large to show
//       withholds.
import { createHash } from "node:crypto";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import type { Node } from "../protocol.ts";
import { sectionTexts } from "../privacy.ts";
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

/**
 * A text that holds a whole note by itself: a text area (TextEdit's and Notes' bodies). HA2 review 2, item 6: an editable
 * one-line field is not one, whatever it holds; it is judged with its whole window, as any other node is.
 */
function textArea(n: Node): boolean {
  return n.role === "AXTextArea";
}

const flat = (t: string): string => t.replace(/\s+/gu, " ").trim();

/**
 * A node's text as a unit reads it: its own text (model.ts nodeText) and SCP1's section texts, its heading list and
 * outline (INT1 review P1). A page's heading can be the disclaimer ("Neither contact line is mine."), so it is evidence;
 * a heading redaction removed makes the unit incomplete (b), and the digest covers it.
 */
function unitText(n: Node): string {
  const own = nodeText(n);
  const sections = sectionTexts(n);
  return sections.length === 0 ? own : [own, ...sections].filter((t) => t !== "").join("\n");
}

/** The unit a source node belongs to (c), or null when its window or node is gone. */
export function unitOf(model: ScreenModel, windowId: string, nodeKey: string): NoteUnit | null {
  const raw = model.windows.get(windowId);
  const node = raw?.nodes.get(nodeKey);
  if (raw === undefined || node === undefined) return null;
  return build(raw, textArea(node) ? nodeKey : null);
}

/** The unit by its identity (unitKey): a text area of the window, or (null) the whole window; null when either is gone. */
export function unitAt(model: ScreenModel, windowId: string, nodeKey: string | null): NoteUnit | null {
  const raw = model.windows.get(windowId);
  if (raw === undefined) return null;
  if (nodeKey === null) return build(raw, null);
  const node = raw.nodes.get(nodeKey);
  return node === undefined || !textArea(node) ? null : build(raw, nodeKey);
}

/**
 * Every text of a node the redacted view shows (privacy/disclosure.ts viewText): its label, value and placeholder, and its
 * section texts. Unlike unitText, an editable field's label is in it ("Optional services, not requested" over "Oil change").
 */
function shownText(n: Node): string {
  return [n.label, n.value, n.placeholder, ...sectionTexts(n)].filter((t): t is string => t !== undefined && t !== "").join("\n");
}

/**
 * The nodes of a window's own content: in a browser, its page (the AXWebArea and everything under it, as controls.ts
 * formControls reads a page's controls), not the browser's toolbar and tabs; any other window's every node. The toolbar and
 * tab strip are the browser's, not part of anyone's message.
 */
function contentNodes(raw: WindowState): Map<string, Node> {
  const web = [...raw.nodes.values()].find((n) => n.role === "AXWebArea");
  if (web === undefined) return raw.nodes;
  const out = new Map<string, Node>([[web.key, web]]);
  for (const n of raw.nodes.values()) if (n.parent !== null && out.has(n.parent)) out.set(n.key, n);
  return out;
}

/**
 * The basis a choice is judged against (fill.ts), one text for what is sent, what completeness is judged on and what the
 * digest rechecks: the window's title, then every text each node of its content shows. The content holds every message's
 * headers, body and disclaimer, whatever nodes carry them; a text area alone is no message, since nothing on the walk says
 * where the message it is part of begins or ends. Incomplete when redaction removed any of it (b). Null when the window is
 * gone or shows no text.
 */
export function windowUnit(model: ScreenModel, windowId: string): NoteUnit | null {
  const raw = model.windows.get(windowId);
  if (raw === undefined) return null;
  const nodes = contentNodes(raw);
  if (![...nodes.values()].some((n) => shownText(n).trim() !== "")) return null;
  const view = redactWindow(raw);
  let complete = raw.window.title === view.window.title;
  const texts = view.window.title.trim() === "" ? [] : [view.window.title.trim()];
  for (const [k, r] of nodes) {
    const v = view.nodes.get(k);
    const vt = v === undefined ? "" : shownText(v).trim();
    if (shownText(r).trim() !== vt) complete = false;
    if (vt !== "") texts.push(vt);
  }
  const text = texts.join("\n");
  const digest = createHash("sha256").update(`${windowId}\u0000shown\u0000${complete ? "1" : "0"}\u0000${text}`).digest("hex").slice(0, 32);
  return { windowId, nodeKey: null, text, complete, digest };
}

function build(raw: WindowState, nodeKey: string | null): NoteUnit {
  const view = redactWindow(raw);
  const keys = nodeKey === null ? [...raw.nodes.keys()] : [nodeKey];
  let complete = true;
  const texts: string[] = [];
  for (const k of keys) {
    const r = raw.nodes.get(k);
    const v = view.nodes.get(k);
    const rt = r === undefined ? "" : unitText(r).trim();
    const vt = v === undefined ? "" : unitText(v).trim();
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
      if (!flat(unitText(n)).includes(want)) continue;
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
