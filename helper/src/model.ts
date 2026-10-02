// The screen model: the latest compacted tree of every open window, as the reader last saw it,
// and the change log of what differed between one walk of a window and the next.
import type { AppRef, Node, Snapshot, TypedValue, WindowRef } from "./protocol.ts";

export interface WindowState {
  app: AppRef;
  window: WindowRef;
  focused: boolean;
  /** Nodes in document order. */
  nodes: Map<string, Node>;
  values: TypedValue[];
  focusedKey: string | null;
  updatedAt: number;
  /** Last time this window was the reader's focused window. */
  lastFocusedAt: number;
}

export type ChangeKind = "value" | "added" | "removed" | "windowOpened" | "windowClosed";

/** One entry of the change log. Text lives here only while the entry is inside the rolling window. */
export interface Change {
  at: number;
  windowId: string;
  kind: ChangeKind;
  key: string | null;
  editable: boolean;
  before: string | null;
  after: string | null;
}

export const ROLLING_WINDOW_MS = 10 * 60 * 1000;
/** Bound on in-memory change entries, so a window that streams text cannot grow the log without limit. No measurement behind the number. */
const MAX_CHANGES = 50_000;

/** The text a node contributes to matching: an editable field's value, or everything else's visible text. */
export function nodeText(node: Node): string {
  if (node.editable) return node.value ?? "";
  if (node.label !== undefined && node.value !== undefined) return `${node.label}\n${node.value}`;
  return node.value ?? node.label ?? "";
}

export class ScreenModel {
  readonly windows = new Map<string, WindowState>();
  private changes: Change[] = [];
  /** Window that most recently arrived with focused=true. */
  focusedWindowId: string | null = null;

  /** Applies one snapshot and returns the changes it produced. */
  apply(snap: Snapshot): Change[] {
    const id = snap.window.windowId;
    const prior = this.windows.get(id);
    const out: Change[] = [];
    let nodes: Map<string, Node>;
    let values: TypedValue[];

    if (snap.root === null || prior === undefined) {
      nodes = new Map(snap.nodes.map((n) => [n.key, n]));
      values = snap.values;
      if (prior === undefined) {
        out.push({ at: snap.at, windowId: id, kind: "windowOpened", key: null, editable: false, before: null, after: null });
      }
    } else {
      const removed = subtreeKeys(prior.nodes, snap.root);
      nodes = new Map();
      let inserted = false;
      for (const [k, n] of prior.nodes) {
        if (removed.has(k)) {
          if (!inserted) {
            for (const nn of snap.nodes) nodes.set(nn.key, nn);
            inserted = true;
          }
          continue;
        }
        nodes.set(k, n);
      }
      if (!inserted) for (const nn of snap.nodes) nodes.set(nn.key, nn);
      values = prior.values.filter((v) => !removed.has(v.nodeKey)).concat(snap.values);
    }

    if (prior !== undefined) out.push(...diffNodes(prior.nodes, nodes, snap, id));

    const state: WindowState = {
      app: snap.app,
      window: snap.window,
      focused: snap.focused,
      nodes,
      values,
      focusedKey: snap.focusedKey,
      updatedAt: snap.at,
      lastFocusedAt: snap.focused ? snap.at : (prior?.lastFocusedAt ?? 0),
    };
    this.windows.set(id, state);
    if (snap.focused) {
      this.focusedWindowId = id;
      for (const [otherId, w] of this.windows) if (otherId !== id && w.app.pid === snap.app.pid) w.focused = false;
    }
    this.changes.push(...out);
    return out;
  }

  close(windowId: string, at: number): Change | null {
    if (!this.windows.delete(windowId)) return null;
    if (this.focusedWindowId === windowId) this.focusedWindowId = null;
    const c: Change = { at, windowId, kind: "windowClosed", key: null, editable: false, before: null, after: null };
    this.changes.push(c);
    return c;
  }

  /** Drops change-log entries older than the rolling window, and the oldest beyond MAX_CHANGES. */
  prune(now: number): void {
    const cutoff = now - ROLLING_WINDOW_MS;
    let i = 0;
    while (i < this.changes.length && (this.changes[i]?.at ?? now) < cutoff) i++;
    i = Math.max(i, this.changes.length - MAX_CHANGES);
    if (i > 0) this.changes = this.changes.slice(i);
  }

  changeLog(): readonly Change[] {
    return this.changes;
  }
}

function subtreeKeys(nodes: Map<string, Node>, root: string): Set<string> {
  const out = new Set<string>([root]);
  // Nodes arrive in document order, so one pass reaches every descendant after its parent.
  for (const n of nodes.values()) if (n.parent !== null && out.has(n.parent)) out.add(n.key);
  return out;
}

function diffNodes(before: Map<string, Node>, after: Map<string, Node>, snap: Snapshot, windowId: string): Change[] {
  const out: Change[] = [];
  const scope = snap.root === null ? null : subtreeKeys(after, snap.root);
  for (const [k, n] of after) {
    if (scope !== null && !scope.has(k)) continue;
    const old = before.get(k);
    if (old === undefined) {
      out.push({ at: snap.at, windowId, kind: "added", key: k, editable: n.editable === true, before: null, after: nodeText(n) });
      continue;
    }
    const a = nodeText(old);
    const b = nodeText(n);
    if (a !== b) out.push({ at: snap.at, windowId, kind: "value", key: k, editable: n.editable === true, before: a, after: b });
  }
  const removedScope = snap.root === null ? null : subtreeKeys(before, snap.root);
  for (const [k, n] of before) {
    if (removedScope !== null && !removedScope.has(k)) continue;
    if (!after.has(k)) out.push({ at: snap.at, windowId, kind: "removed", key: k, editable: n.editable === true, before: nodeText(n), after: null });
  }
  return out;
}
