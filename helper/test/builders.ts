// Builders for synthetic reader messages. All names, numbers and addresses are invented.
import type { AskJev } from "../src/fill/jev.ts";
import type { Whose } from "../src/fill/fill.ts";
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

/**
 * A fake Jev that answers each fill question by candidate text, so the same pick holds in both asks
 * although the second ask shuffles and renumbers the candidates. `pick` returns the text to choose,
 * or null for none. `whose` answers each whose-details question; the user's by default.
 */
export function jevPickingText(pick: (fieldId: string, instructions: string) => string | null, confidence = 0.9, whose: (instructions: string) => Whose = () => "user"): AskJev {
  return async (req) => ({
    model: "jev-test",
    answers: Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
        // A whose-details question (fill.ts whoseId) asked beside a field offered a value from memory.
        if (id.endsWith("_whose")) return [id, { choice: whose(ins), confidence }];
        const want = pick(id, ins);
        const hit = want === null ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`));
        return [id, { choice: hit?.[0] ?? "none", confidence }];
      }),
    ),
    inputTokens: 1000,
    latencyMs: 12,
    costUsd: 0.000042,
  });
}
