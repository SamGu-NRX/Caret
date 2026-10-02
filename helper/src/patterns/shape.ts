// Transfer shapes (plan section 4). A shape says what kind of transfer happened without saying
// which row it touched: the source window kind and element template, the part of the source taken,
// and the destination window kind and template. The row is the element's position among the
// window's elements with the same template.
//
// A template is the element key with every ordinal removed, so "textfield:guest~3" and
// "textfield:guest~4" share one. A static text's label is its content, so its own label is
// replaced by "*": the lines of a list then share a template and differ only in position.
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { normalizeValue } from "../normalize.ts";
import type { Node, ValueKind } from "../protocol.ts";
import type { Transfer } from "../transfers.ts";
import type { Observation } from "../rolling-text.ts";

/** Roles whose label is the element's content rather than its name. */
const CONTENT_ROLES = new Set(["AXStaticText"]);

export function templateOf(key: string, role: string): string {
  const segs = key.split("/").map((s) => s.replace(/~\d+$/, ""));
  if (CONTENT_ROLES.has(role)) {
    const last = segs.length - 1;
    const seg = segs[last] ?? "";
    const colon = seg.indexOf(":");
    segs[last] = `${colon < 0 ? seg : seg.slice(0, colon)}:*`;
  }
  return segs.join("/");
}

interface WindowIndex {
  slots: Map<string, { template: string; pos: number }>;
  byTemplate: Map<string, string[]>;
}

/**
 * Template and position of every node, built once per window state. The model replaces a window's
 * state object on every snapshot, so a state object never goes stale in this cache.
 */
const indexes = new WeakMap<WindowState, WindowIndex>();

export function windowIndex(w: WindowState): WindowIndex {
  const hit = indexes.get(w);
  if (hit !== undefined) return hit;
  const slots = new Map<string, { template: string; pos: number }>();
  const byTemplate = new Map<string, string[]>();
  for (const n of w.nodes.values()) {
    const template = templateOf(n.key, n.role);
    let keys = byTemplate.get(template);
    if (keys === undefined) byTemplate.set(template, (keys = []));
    slots.set(n.key, { template, pos: keys.length });
    keys.push(n.key);
  }
  const idx = { slots, byTemplate };
  indexes.set(w, idx);
  return idx;
}

/** Which part of the source element a transfer took: its whole text, or one typed value of a kind. */
export type Part = "whole" | ValueKind;

export interface Side {
  windowId: string;
  bundleId: string;
  appName: string;
  windowKind: string;
  template: string;
  pos: number;
}

export interface SrcOption {
  side: Side & { key: string };
  part: Part;
}

/** A transfer as the recognizers see it. `value` stays in memory; persisted forms hash it. */
export interface PatternTransfer {
  at: number;
  value: string;
  kind: ValueKind | null;
  part: Part;
  /** The source the transfer log credited: the most recently seen window showing the value. */
  src: Side & { key: string };
  dst: Side & { key: string };
  /** Everything but positions and windows: two rounds of one loop, or one step of a routine on two days, share it. */
  shape: string;
  /**
   * Every live window showing the whole value, one element each, the credited source first. The same
   * name can be on screen in a roster and a directory; the loop recognizer picks the window that
   * explains every round.
   */
  srcOptions: SrcOption[];
}

/**
 * Describes a detected transfer structurally, or returns null when it cannot take part in a pattern:
 * its source or destination is no longer in the model, or it took a fragment of a longer text,
 * which a later round could not be predicted from.
 */
export function describeTransfer(model: ScreenModel, t: Transfer, alternatives: readonly Observation[] = []): PatternTransfer | null {
  const sw = model.windows.get(t.src.windowId);
  const dw = model.windows.get(t.dst.windowId);
  if (sw === undefined || dw === undefined) return null;
  const sSlot = windowIndex(sw).slots.get(t.src.nodeKey);
  const dSlot = windowIndex(dw).slots.get(t.dst.key);
  if (sSlot === undefined || dSlot === undefined) return null;
  const part: Part = t.src.kind ?? "whole";
  const whole = t.src.text === t.value || normalizeValue(t.src.text, t.src.kind) === normalizeValue(t.value, t.src.kind);
  if (!whole) return null;
  const side = (w: WindowState, slot: { template: string; pos: number }, key: string): Side & { key: string } => ({
    windowId: w.window.windowId,
    bundleId: w.app.bundleId,
    appName: w.app.name,
    windowKind: w.window.kind,
    template: slot.template,
    pos: slot.pos,
    key,
  });
  const src = side(sw, sSlot, t.src.nodeKey);
  const dst = side(dw, dSlot, t.dst.key);
  const srcOptions: SrcOption[] = [{ side: src, part }];
  for (const o of alternatives) {
    if (srcOptions.some((x) => x.side.windowId === o.windowId)) continue;
    const w = model.windows.get(o.windowId);
    const slot = w === undefined ? undefined : windowIndex(w).slots.get(o.nodeKey);
    if (w === undefined || slot === undefined) continue;
    srcOptions.push({ side: side(w, slot, o.nodeKey), part: o.kind ?? "whole" });
  }
  return { at: t.at, value: t.value, kind: t.kind, part, src, dst, shape: shapeOf(src, part, dst), srcOptions };
}

export function shapeOf(src: Omit<Side, "pos" | "windowId" | "appName">, part: Part, dst: Omit<Side, "pos" | "windowId" | "appName">): string {
  return `${src.bundleId}|${src.windowKind}|${src.template}|${part}>${dst.bundleId}|${dst.windowKind}|${dst.template}`;
}

/** One element found by template and position, with what a fill would copy from it. */
export interface Located {
  windowId: string;
  key: string;
  node: Node;
  /** The text a transfer of this part would copy, or null when the element has no such part. */
  text: string | null;
}

/** Finds the element at `pos` among a window's elements with `template`, and reads `part` from it. */
export function locate(model: ScreenModel, windowId: string, template: string, pos: number, part: Part): Located | null {
  const w = model.windows.get(windowId);
  if (w === undefined || pos < 0) return null;
  const key = windowIndex(w).byTemplate.get(template)?.[pos];
  if (key === undefined) return null;
  const node = w.nodes.get(key);
  if (node === undefined) return null;
  let text: string | null;
  if (part === "whole") {
    const t = nodeText(node);
    text = t.length > 0 ? t : null;
  } else {
    text = w.values.find((v) => v.nodeKey === key && v.kind === part)?.text ?? null;
  }
  return { windowId, key, node, text };
}
