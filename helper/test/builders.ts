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
  /** The window server's number, when the test needs one (B21's planRequest window). */
  number?: number;
  /** The window's kind from its subrole (ElementKey.windowKind); "standard" when absent. B22: "systemdialog" for a system prompt. */
  kind?: string;
}

export function snap(nodes: Node[], o: SnapOpts): Snapshot {
  return {
    type: "snapshot",
    v: PROTOCOL_VERSION,
    seq: o.seq ?? 0,
    at: o.at,
    reason: o.reason ?? "event",
    app: o.app ?? FIXTURE_APP,
    window: { windowId: o.windowId, kind: o.kind ?? "standard", title: o.title ?? o.windowId, frame: [0, 0, 800, 600], ...(o.number === undefined ? {} : { number: o.number }) },
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
export function jevPickingText(
  pick: (fieldId: string, instructions: string) => string | null,
  confidence = 0.9,
  whose: (instructions: string) => Whose = () => "user",
  /** Answers each whose-value question (fill.ts ownerId) by the value's description; the user's by default. */
  owner: (instructions: string) => Whose = () => "user",
): AskJev {
  return async (req) => ({
    model: "jev-test",
    answers: Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
        // A whose-details question (fill.ts whoseId) asked beside a field offered a value from memory.
        if (id.endsWith("_whose")) return [id, { choice: whose(ins), confidence }];
        if (id.endsWith("_owner")) return [id, { choice: owner(ins), confidence }];
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

/**
 * I2 ruling D: every Ask route asks Jev's per-field scope question (planner/intent-heads.ts settleFields). A stand-in
 * written before it answers that question here: every field it is asked about is one the request asks for (the maker's
 * own fields stay as they were), unless `choose` says otherwise; every other request goes to `ask`. SCP1: its section
 * question is answered "particular fields", so no section veto applies.
 */
export function answeringScope(ask: AskJev, choose: (instructions: string) => "asks" | "not" | "unclear" = () => "asks"): AskJev {
  return async (req) =>
    req.purpose === "ask.scope"
      ? { model: "scope-stand-in", inputTokens: 0, latencyMs: 0, costUsd: 0, answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: id === "section" ? "fields" : choose(String(q.instructions)), confidence: 0.95 }])) }
      : ask(req);
}

/** The label a scope question (planner/intent-heads.ts SCOPE_WORDINGS) asks about, for stand-ins that answer by label; "" for any other question. */
export function scopeLabel(instructions: string): string {
  return /Field: "(.*?)"\. Control: "/u.exec(instructions)?.[1] ?? "";
}
