// The grounded-fill candidate generator. It collects short spans from every window other than
// the form's own: typed values first, then single lines of visible text, splitting "Label: value"
// lines so the value is the span and the label is its context. Jev later picks among these by id,
// and code copies the chosen span verbatim.
import type { FillSource, Node, ValueKind } from "../protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { isLabelLike, nearestText } from "./descriptor.ts";

export interface Candidate {
  id: string;
  text: string;
  kind: ValueKind | null;
  /** The label the span sits next to in its source window, if code found one. */
  context: string | null;
  source: FillSource;
}

/**
 * Jev's accuracy falls with unrelated state (its docs; deep plan section 5), and a Choice allows
 * at most 255 options. The probe measured 36 of 36 correct at 134 candidates; 80 stays well inside that.
 */
export const MAX_CANDIDATES = 80;
const MIN_LINE = 2;
const MAX_LINE = 80;
const LINE_ROLES = new Set(["AXStaticText", "AXCell", "AXHeading", "AXLink"]);
const LABELLED = /^([^:]{1,32}):\s+(.+)$/;

export function generateCandidates(model: ScreenModel, targetWindowId: string, max = MAX_CANDIDATES): Candidate[] {
  const windows = [...model.windows.values()]
    .filter((w) => w.window.windowId !== targetWindowId)
    .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt || b.updatedAt - a.updatedAt);

  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (w: WindowState, node: Node, text: string, kind: ValueKind | null, context: string | null): void => {
    if (out.length >= max || seen.has(text)) return;
    seen.add(text);
    out.push({
      id: `c${out.length + 1}`,
      text,
      kind,
      context,
      source: {
        windowId: w.window.windowId,
        bundleId: w.app.bundleId,
        appName: w.app.name,
        windowTitle: w.window.title,
        nodeKey: node.key,
        kind,
      },
    });
  };

  for (const w of windows) {
    for (const v of w.values) {
      const node = w.nodes.get(v.nodeKey);
      if (node === undefined) continue;
      add(w, node, v.text, v.kind, contextFor(w, node, v.text));
    }
  }
  for (const w of windows) {
    for (const node of w.nodes.values()) {
      const isSourceField = node.editable === true && (node.value ?? "").length > 0 && !node.states?.includes("secure");
      if (!LINE_ROLES.has(node.role) && !isSourceField) continue;
      const lines = nodeText(node).split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.replace(/\s+/g, " ").trim();
        if (line.length < MIN_LINE || line.length > MAX_LINE || !/[\p{L}\p{N}]/u.test(line)) continue;
        if (line.endsWith(":")) continue; // a label, not a value
        const m = LABELLED.exec(line);
        if (m !== null && m[1] !== undefined && m[2] !== undefined) {
          add(w, node, m[2].trim(), null, m[1].trim());
          continue;
        }
        const context = lines.length === 1 ? (isSourceField ? (node.label ?? nearestText(w, node, isLabelLike)) : nearestText(w, node, isLabelLike)) : null;
        add(w, node, line, null, context);
      }
    }
  }
  return out;
}

function contextFor(w: WindowState, node: Node, span: string): string | null {
  for (const line of nodeText(node).split(/\r?\n/)) {
    const m = LABELLED.exec(line.trim());
    if (m !== null && m[1] !== undefined && m[2]?.includes(span)) return m[1].trim();
  }
  if (node.editable === true && node.label !== undefined) return node.label;
  return nearestText(w, node, isLabelLike);
}

export function describeCandidate(c: Candidate): string {
  const parts = [`"${c.text}"`];
  const facts: string[] = [];
  if (c.kind !== null) facts.push(c.kind);
  if (c.context !== null && c.context !== c.text) facts.push(`labelled '${c.context}'`);
  facts.push(`in ${c.source.appName} window '${c.source.windowTitle}'`);
  parts.push(`(${facts.join("; ")})`);
  return parts.join(" ");
}
