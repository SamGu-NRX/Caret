// HA2 review of df8056b: the whole-note evidence an owner judgement rested on is bound to the value and rechecked before
// it is written (P1); an instruction's own literal keeps its instruction provenance (P2); and incomplete evidence fails
// closed (lead decision): every node that holds the value is shown (a), a note redaction cut is incomplete (b), and a
// text in a window of separate runs is judged in its whole window (c). Fresh synthetic fixtures.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { heldReason, mintOf, NOTE_PRIVATE, NOTE_UNSHOWN, proposeFill, type FillScope } from "../src/fill/fill.ts";
import { guardFor, setTestVerifier } from "../src/fill/contract.ts";
import { fillPlan, recheckFill, writtenFields } from "../src/offers/fill-popup.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import type { Node } from "../src/protocol.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { field, node, snap, text } from "./builders.ts";

const T0 = 1_000_000;
const PHONE = "555-0388";
const OPENING = ["Signing up for the Thursday pottery class.", "I'm Odile Ferrant, second term."];
/** A note line over 80 characters, so the note has prose; LONG_PROSE is enough of them to pass the 2,000-character owner-note allotment (privacy.ts OWNER_NOTE_CHARS). */
const PROSE = "Reminder to myself: bring the receipt from last term, because the front desk asked about it twice already.";
const LONG_PROSE = Array.from({ length: 20 }, (_, i) => `${PROSE} (${i + 1})`).join("\n");
/** Lines between the phone and the note's last sentence, so a change there is outside the phone's own neighbourhood. */
const BETWEEN = ["Class starts at six.", "Bring an apron.", "Parking is behind the hall."];
const MINE = [...OPENING, `Phone: ${PHONE}`, ...BETWEEN, "Contact lines are mine."];
const NOT_MINE = "Neither contact line is mine.";

const noteNode = (key: string, body: string): Node => field(key, body, { role: "AXTextArea" });
function desk(sources: { windowId: string; nodes: Node[]; title?: string }[], labels: readonly string[] = ["Phone"]): ScreenModel {
  const m = new ScreenModel();
  // The first source is the window the user just left: applied last.
  [...sources].reverse().forEach((s, j) => m.apply(snap(s.nodes, { at: T0 - 20_000 + 1000 * j, windowId: s.windowId, title: s.title ?? `Note ${sources.length - j}.txt`, focused: true })));
  m.apply(snap(labels.map((l, i) => field(`form/${i}`, "", { label: l, frame: [100, 40 + 40 * i, 200, 24] })), { at: T0, windowId: "form", title: "Studio registration", focused: true, focusedKey: "form/0" }));
  return m;
}
const setNote = (m: ScreenModel, windowId: string, nodes: Node[], at: number): void => void m.apply(snap(nodes, { at, windowId, title: "Note 1.txt", focused: false }));

/** The notes an owner question names ("note_1 and note_2 in source_notes"), from its request's state, joined. */
const notesIn = (req: JevRequest, ins: string): string => {
  const ids = /((?:note_\d+)(?: and note_\d+)*) in source_notes/u.exec(ins)?.[1]?.split(" and ") ?? [];
  const notes = (req.state as { source_notes?: Record<string, string> }).source_notes ?? {};
  return ids.map((id) => notes[id] ?? "").join("\n");
};

/** A Jev at confidence 1: picks PHONE, every field wants the user's, every check exact; an owner question is "other" when what it shows disclaims. */
function jev(owner?: () => "user" | "other"): AskJev {
  return async (req) => {
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        if (req.purpose === "fill.verify") return [id, { choice: "exact", confidence: 1 }];
        if (id.endsWith("_whose")) return [id, { choice: "user", confidence: 1 }];
        if (id.endsWith("_owner")) return [id, { choice: owner?.() ?? (/\bneither\b[^.\n]*\bmine\b/iu.test(`${ins}\n${notesIn(req, ins)}`) ? "other" : "user"), confidence: 1 }];
        const hit = Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${PHONE}"`))?.[0];
        return [id, { choice: hit ?? "none", confidence: 1 }];
      }),
    );
    return { model: "jev-ha2", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
}

const phoneOf = async (m: ScreenModel, ask: AskJev = jev(), scope?: FillScope) => {
  const p = await proposeFill(m, ask, "form", "form/0", T0, { rand: () => 0, ...(scope === undefined ? {} : { scope }) });
  return { p, f: p.fields[0] };
};

beforeEach(() => setTestVerifier(null));
afterEach(() => setTestVerifier(STAND_IN));

describe("P1: the note an owner judgement saw is rechecked before the write", () => {
  const nodes = (last: string): Node[] => [noteNode("note/body", [...MINE.slice(0, -1), last].join("\n"))];

  it("refuses at acceptance and right before dispatch once the note's last sentence disclaims the phone", async () => {
    const m = desk([{ windowId: "note", nodes: nodes("Contact lines are mine.") }]);
    const { p, f } = await phoneOf(m);
    expect(f?.value).toBe(PHONE);
    const g = writtenFields(p, m.windows.get("form"));
    const { checks } = fillPlan(m, g);
    expect(recheckFill(m, g, () => null, undefined, null, () => [])).toBeNull();
    setNote(m, "note", nodes(NOT_MINE), T0 + 1000);
    expect(recheckFill(m, g, () => null, undefined, null, () => [])).not.toBeNull();
    const w = m.windows.get("form");
    const target = w === undefined ? undefined : { windowId: "form", node: w.nodes.get("form/0") as Node, window: w };
    expect(guardFor(() => m, checks, { kind: "fill", proposalId: p.id }, null, () => [])(0, PHONE, target)).toMatch(/note/u);
  });

  it("binds the note to the value's mint, so the provenance recheck alone refuses it", async () => {
    const m = desk([{ windowId: "note", nodes: nodes("Contact lines are mine.") }]);
    const { f } = await phoneOf(m);
    const mint = f === undefined ? undefined : mintOf(f);
    expect(mint?.provenance).toMatchObject({ kind: "window", owned: { units: [{ windowId: "note" }] } });
  });
});

describe("P2: a value the instruction spells out keeps its instruction provenance", () => {
  it("fills 'put 555-0388 in Phone' though the same phone sits in a note too long to show, minted as the instruction's", async () => {
    const m = desk([{ windowId: "note", nodes: [noteNode("note/body", [...OPENING, LONG_PROSE, `Phone: ${PHONE}`].join("\n"))] }]);
    const scope: FillScope = { fields: ["form/0"], windows: null, memory: false, instruction: `put ${PHONE} in Phone`, person: null, literals: new Map([["form/0", PHONE]]) };
    const { f } = await phoneOf(m, jev(() => "user"), scope);
    expect(f?.value).toBe(PHONE);
    const mint = f === undefined ? undefined : mintOf(f);
    expect(mint?.provenance).toMatchObject({ kind: "instruction", span: PHONE });
  });
});

describe("incomplete evidence fails closed (lead decision)", () => {
  it("(a) withholds a phone that two notes hold when the other one disclaims it", async () => {
    const m = desk([
      { windowId: "note", nodes: [noteNode("note/body", MINE.join("\n"))] },
      { windowId: "note2", nodes: [noteNode("note2/body", ["Copied from a visitor card:", `Phone: ${PHONE}`, ...BETWEEN, NOT_MINE].join("\n"))] },
    ]);
    const { f } = await phoneOf(m);
    expect(f?.value ?? null).toBeNull();
    expect(f === undefined ? undefined : mintOf(f)).toBeUndefined();
  });

  it("(a) withholds it when the other note holding it is too long to show, even with 'user' at confidence 1", async () => {
    const m = desk([
      { windowId: "note", nodes: [noteNode("note/body", MINE.join("\n"))] },
      { windowId: "note2", nodes: [noteNode("note2/body", [LONG_PROSE, `Phone: ${PHONE}`].join("\n"))] },
    ]);
    const { f } = await phoneOf(m, jev(() => "user"));
    expect(f?.value ?? null).toBeNull();
    expect(f === undefined ? null : heldReason(f)).toBe(`Caret left Phone: ${NOTE_UNSHOWN}.`);
  });

  it("(b) withholds a value from a note whose disclaimer sits on a line redaction removes, even with 'user' at confidence 1", async () => {
    const m = desk([{ windowId: "note", nodes: [noteNode("note/body", [...OPENING, `Phone: ${PHONE}`, `API key note: ${NOT_MINE}`].join("\n"))] }]);
    const sent: JevRequest[] = [];
    const ask = jev(() => "user");
    const { f } = await phoneOf(m, async (r) => (sent.push(r), ask(r)));
    expect(f?.value ?? null).toBeNull();
    expect(f === undefined ? null : heldReason(f)).toBe(`Caret left Phone: ${NOTE_PRIVATE}.`);
    expect(JSON.stringify(sent)).not.toContain("API key");
  });

  it("(c) withholds a phone whose window's sibling text run disclaims it", async () => {
    const group = node("mail/group", "AXGroup");
    const m = desk([{ windowId: "mail", title: "Visitor card", nodes: [group, text("mail/p1", "Copied from a visitor card:", undefined, "mail/group"), text("mail/p2", `Phone: ${PHONE}`, undefined, "mail/group"), text("mail/p3", NOT_MINE, undefined, "mail/group")] }]);
    const { f } = await phoneOf(m);
    expect(f?.value ?? null).toBeNull();
    expect(f === undefined ? undefined : mintOf(f)).toBeUndefined();
  });

  it("(c) still fills from a window of text runs that is the user's, once Jev saw the whole window and said 'user'", async () => {
    const group = node("mail/group", "AXGroup");
    const m = desk([{ windowId: "mail", title: "My card", nodes: [group, text("mail/p1", "My own card:", undefined, "mail/group"), text("mail/p2", `Phone: ${PHONE}`, undefined, "mail/group")] }]);
    const { f } = await phoneOf(m);
    expect(f?.value).toBe(PHONE);
  });
});
