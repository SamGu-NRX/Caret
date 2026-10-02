// Builders for synthetic reader messages. All names, numbers and addresses are invented.
import { PROTOCOL_VERSION, type AppRef, type Focus, type Frame, type Node, type Snapshot, type TypedValue, type ValueKind } from "../src/protocol.ts";

export const FIXTURE_APP: AppRef = { pid: 5150, bundleId: "dev.caret.fixture", name: "Caret Fixture" };
export const MAIL_APP: AppRef = { pid: 6160, bundleId: "dev.caret.mail", name: "Mail Fixture" };

export function node(key: string, role: string, extra: Partial<Node> = {}): Node {
  return { key, parent: null, role, ...extra };
}

export function text(key: string, label: string, frame?: Frame, parent: string | null = null): Node {
  return { key, parent, role: "AXStaticText", label, ...(frame === undefined ? {} : { frame }) };
}

export function field(key: string, value: string, extra: Partial<Node> = {}): Node {
  return { key, parent: null, role: "AXTextField", editable: true, ...(value === "" ? {} : { value }), ...extra };
}

export function value(kind: ValueKind, t: string, nodeKey: string): TypedValue {
  return { kind, text: t, nodeKey };
}

export interface SnapOpts {
  at: number;
  windowId: string;
  title?: string;
  app?: AppRef;
  focused?: boolean;
  root?: string | null;
  values?: TypedValue[];
  focusedKey?: string | null;
  seq?: number;
  reason?: Snapshot["reason"];
}

export function snap(nodes: Node[], o: SnapOpts): Snapshot {
  return {
    type: "snapshot",
    v: PROTOCOL_VERSION,
    seq: o.seq ?? 0,
    at: o.at,
    reason: o.reason ?? "event",
    app: o.app ?? FIXTURE_APP,
    window: { windowId: o.windowId, kind: "standard", title: o.title ?? o.windowId, frame: [0, 0, 800, 600] },
    focused: o.focused ?? false,
    root: o.root ?? null,
    nodes,
    values: o.values ?? [],
    focusedKey: o.focusedKey ?? null,
    stats: { walkMs: 5, visited: nodes.length, truncated: false },
  };
}

export function focus(windowId: string, key: string | null, at: number, o: { empty?: boolean; editable?: boolean; app?: AppRef } = {}): Focus {
  return {
    type: "focus",
    v: PROTOCOL_VERSION,
    at,
    app: o.app ?? FIXTURE_APP,
    windowId,
    key,
    role: "AXTextField",
    editable: o.editable ?? true,
    empty: o.empty ?? true,
    frontmost: true,
  };
}
