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

/** Bound on the focus history; a form looks back one entry, so this is generous. */
const MAX_FOCUS_HISTORY = 100;

export class ScreenModel {
  readonly windows = new Map<string, WindowState>();
  private changes: Change[] = [];
  /**
   * Window that most recently arrived with focused=true. A request walk reports an app's own focused
   * window as focused even while the app is in the background, so this alone does not say the user is
   * in that window; frontmostPid does.
   */
  focusedWindowId: string | null = null;
  /** The app the user is in, from the reader's appSwitch and frontmost focus events; null until one arrives. */
  frontmostPid: number | null = null;
  /** Every change of focused window, oldest first. */
  private readonly focusHistory: { windowId: string; at: number }[] = [];

  /** Applies one snapshot and returns the changes it produced. */
  apply(snap: Snapshot): Change[] {
    const id = snap.window.windowId;
    const prior = this.windows.get(id);
    const out: Change[] = [];
    let nodes: Map<string, Node>;
    let values: TypedValue[];

    const unreached = prior === undefined ? null : cutWalkUnreached(prior, snap);
    if (unreached !== null && prior !== undefined) {
      nodes = mergeCutWalk(prior.nodes, snap.nodes);
      values = snap.values.concat(prior.values.filter((v) => unreached.has(v.nodeKey)));
    } else if (snap.root === null || prior === undefined) {
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

    // A partial snapshot only knows focus inside its subtree; outside it, the earlier focus stands
    // as long as that node is still there.
    let focusedKey = snap.focusedKey;
    if (snap.root !== null && focusedKey === null && prior !== undefined && prior.focusedKey !== null && nodes.has(prior.focusedKey)) {
      const replaced = subtreeKeys(prior.nodes, snap.root);
      if (!replaced.has(prior.focusedKey)) focusedKey = prior.focusedKey;
    }
    if (unreached !== null && focusedKey === null && prior !== undefined && prior.focusedKey !== null && unreached.has(prior.focusedKey)) focusedKey = prior.focusedKey;
    const state: WindowState = {
      app: snap.app,
      window: snap.window,
      focused: snap.focused,
      nodes,
      values,
      focusedKey,
      updatedAt: snap.at,
      lastFocusedAt: snap.focused ? snap.at : (prior?.lastFocusedAt ?? 0),
    };
    this.windows.set(id, state);
    if (snap.focused) {
      if (this.focusedWindowId !== id) {
        this.focusHistory.push({ windowId: id, at: snap.at });
        if (this.focusHistory.length > MAX_FOCUS_HISTORY) this.focusHistory.shift();
      }
      this.focusedWindowId = id;
      for (const [otherId, w] of this.windows) if (otherId !== id && w.app.pid === snap.app.pid) w.focused = false;
    }
    this.changes.push(...out);
    return out;
  }

  /**
   * The window the user is in: the one most recently focused in the frontmost app (frontmostPid), or in any
   * app while the frontmost app is unknown. A request walk marks a background app's own window focused and
   * moves focusedWindowId to it, so the frontmost app decides which focus counts (B21).
   */
  userWindow(): WindowState | null {
    let best: WindowState | null = null;
    for (const w of this.windows.values()) {
      if (w.lastFocusedAt <= 0 || (this.frontmostPid !== null && w.app.pid !== this.frontmostPid)) continue;
      if (best === null || w.lastFocusedAt > best.lastFocusedAt) best = w;
    }
    return best;
  }

  /**
   * The window the user was in just before they last came to `windowId`. When `windowId` was never
   * focused (a fill requested for a background form), the most recently focused other window.
   */
  windowBefore(windowId: string): string | null {
    let i = this.focusHistory.length - 1;
    const last = this.focusHistory.findLastIndex((e) => e.windowId === windowId);
    if (last >= 0) i = last - 1;
    for (; i >= 0; i--) {
      const e = this.focusHistory[i];
      if (e !== undefined && e.windowId !== windowId && this.windows.has(e.windowId)) return e.windowId;
    }
    return null;
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

  /** Forgets every window, for a new reader session whose window ids start over. */
  reset(): void {
    this.windows.clear();
    this.focusedWindowId = null;
    this.frontmostPid = null;
    this.focusHistory.length = 0;
  }

  /**
   * P4: when the user last left `windowId`, the moment another window came to the front after its last focus; null
   * while it is still the window they are in, or if it never had focus.
   */
  leftAt(windowId: string): number | null {
    const i = this.focusHistory.findLastIndex((e) => e.windowId === windowId);
    return i < 0 ? null : (this.focusHistory[i + 1]?.at ?? null);
  }

  /**
   * P4: a read-only view of the model in which the windows `extra` names also hold its nodes (and its title, when given),
   * for the one reader that may see them: fill, reading the tab the user just left (engines/tab-source.ts). The model
   * itself never holds them, so no other reader of the screen (the router, event cards, the shadow log, transfers)
   * can see them, and they go when the view does. A window the model no longer has is not brought back. The view's
   * change log starts empty: fill does not read it, and the nodes must never enter the model's.
   */
  withNodes(extra: ReadonlyMap<string, { nodes: readonly Node[]; title: string | null }>): ScreenModel {
    const v = new ScreenModel();
    for (const [id, w] of this.windows) {
      const add = extra.get(id);
      if (add === undefined) {
        v.windows.set(id, w);
        continue;
      }
      const nodes = new Map(w.nodes);
      for (const n of add.nodes) nodes.set(n.key, n);
      v.windows.set(id, { ...w, window: add.title === null ? w.window : { ...w.window, title: add.title }, nodes });
    }
    v.focusedWindowId = this.focusedWindowId;
    v.frontmostPid = this.frontmostPid;
    v.focusHistory.push(...this.focusHistory);
    return v;
  }
}

/**
 * The prior nodes a full walk cut short did not send, or null when `snap` replaces the window whole.
 *
 * The reader walks depth first and stops at its deadline or node budget (Walker.swift), then sends what it read as a
 * full snapshot (root null) with stats.truncated. Replacing the window with that dropped every node after the cut:
 * H10's TextEdit note lost its text area until the next background walk 30 s later, and a fill whose source was that
 * text was refused as "source gone". A cut walk cannot say which of the nodes it did not send are gone, so every one of
 * them is kept until a complete walk replaces the window. (Reading "gone" from the old order failed when a node had
 * moved ahead of the cut, P3 review: the text area behind it was dropped.) A page is replaced whole: its walk is cut per
 * frame, not at one point in document order, and after navigation the old document's fields must not survive.
 */
function cutWalkUnreached(prior: WindowState, snap: Snapshot): Set<string> | null {
  if (snap.root !== null || !snap.stats.truncated || snap.window.kind === "page") return null;
  const sent = new Set(snap.nodes.map((n) => n.key));
  return new Set([...prior.nodes.keys()].filter((k) => !sent.has(k)));
}

/**
 * A cut walk's nodes with every prior node it did not send, in document order as far as both say it: the prior order,
 * each sent node at its own place in the walk (a node new to the walk goes in before the next node the walk sent).
 */
function mergeCutWalk(prior: Map<string, Node>, sent: readonly Node[]): Map<string, Node> {
  const at = new Map(sent.map((n, i) => [n.key, i]));
  const out = new Map<string, Node>();
  let next = 0;
  for (const [k, n] of prior) {
    const i = at.get(k);
    if (i === undefined) out.set(k, n);
    else for (; next <= i; next++) out.set((sent[next] as Node).key, sent[next] as Node);
  }
  for (; next < sent.length; next++) out.set((sent[next] as Node).key, sent[next] as Node);
  return out;
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
