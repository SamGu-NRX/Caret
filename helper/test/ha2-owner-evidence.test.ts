// HA2: an owner judgement counts only if both owner questions showed the whole note the value was read from, and code
// makes no ownership claim of its own. Fresh synthetic fixtures: every name, value and sentence is invented here.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { heldReason, mintOf, NOTE_UNSHOWN, proposeFill, type FillScope } from "../src/fill/fill.ts";
import { makeFieldContract, setTestVerifier, verifyProposed } from "../src/fill/contract.ts";
import type { AboutValue } from "../src/fill/about.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { field, snap } from "./builders.ts";
import { OWNER_NOTE_CHARS, setOwnerNoteChars } from "../src/privacy.ts";

const T0 = 1_000_000;
const PHONE = "555-0388";
const EMAIL = "bram.k@example.org";
const USER_PHONE = "555-0412";
const USER_EMAIL = "odile.f@example.com";
const OPENING = ["Signing up for the Thursday pottery class.", "I'm Odile Ferrant, second term."];
const CONTACTS = ["Copied from the visitor card:", `Phone: ${PHONE}`, `Email: ${EMAIL}`];
/** A line over the 80 characters of a card's line, so the note has prose and only under half of it may be sent. */
const PROSE = "Reminder to myself: bring the receipt from last term, because the front desk asked about it twice already.";

/** A note the user just left, and a form asking for the user's own details in front of it. */
function desk(note: string, labels: readonly string[] = ["Phone", "Email"]): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("note/body", note, { role: "AXTextArea" })], { at: T0 - 20_000, windowId: "note", title: "Class signup.txt", focused: true }));
  m.apply(snap(labels.map((l, i) => field(`form/${i}`, "", { label: l, frame: [100, 40 + 40 * i, 200, 24] })), { at: T0, windowId: "form", title: "Studio registration", focused: true, focusedKey: "form/0" }));
  return m;
}

/** The whole note an owner question names (fill.ts describeOwned: "note N in source_notes"), from its request's state. */
function noteOf(req: JevRequest, instructions: string): string {
  const id = /(note \d+) in source_notes/u.exec(instructions)?.[1];
  const notes = (req.state as { source_notes?: Record<string, string> }).source_notes ?? {};
  return id === undefined ? "" : (notes[id] ?? "");
}

/**
 * A Jev that answers from what each question shows: an owner question is "other" when it, or the note it names, says
 * the lines are not the user's, else "user"; every field wants the user's details; every value check says exact; each
 * field picks `pick(label)`. Every answer at confidence 1.
 */
function jev(pick: (label: string) => string | null, owner: (shown: string) => "user" | "other" = (s) => (/\bnot mine\b|\bneither\b[^.\n]*\bmine\b/iu.test(s) ? "other" : "user")): AskJev & { reqs: JevRequest[] } {
  const reqs: JevRequest[] = [];
  const f = async (req: JevRequest) => {
    reqs.push(req);
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        if (req.purpose === "fill.verify") return [id, { choice: "exact", confidence: 1 }];
        if (id.endsWith("_whose")) return [id, { choice: "user", confidence: 1 }];
        if (id.endsWith("_owner")) return [id, { choice: owner(`${ins}\n${noteOf(req, ins)}`), confidence: 1 }];
        const want = pick(/Label: '([^']+)'/u.exec(ins)?.[1] ?? "");
        const hit = want === null ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`))?.[0];
        return [id, { choice: hit ?? "none", confidence: 1 }];
      }),
    );
    return { model: "jev-ha2", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
  return Object.assign(f, { reqs });
}

const theirs = (label: string): string | null => (label === "Phone" ? PHONE : label === "Email" ? EMAIL : null);

async function fill(note: string, pick: (label: string) => string | null = theirs, o: { about?: AboutValue[]; labels?: string[]; owner?: (shown: string) => "user" | "other"; scope?: FillScope } = {}) {
  const j = jev(pick, o.owner);
  const p = await proposeFill(desk(note, o.labels), j, "form", "form/0", T0, { about: o.about ?? [], rand: () => 0, ...(o.scope === undefined ? {} : { scope: o.scope }) });
  const by = (label: string) => p.fields[(o.labels ?? ["Phone", "Email"]).indexOf(label)];
  return { p, j, by };
}

beforeEach(() => setTestVerifier(null));
afterEach(() => setTestVerifier(STAND_IN));

describe("HA2 rule 2: the owner questions show the whole note", () => {
  it.each([
    ["named, after the lines", [...OPENING, ...CONTACTS, "Both lines above belong to Bram Keller. Neither is mine."]],
    ["nameless, after the lines", [...OPENING, ...CONTACTS, "Neither of those lines is mine."]],
    ["nameless, before the lines", [...OPENING, "Neither of the next two lines is mine.", ...CONTACTS]],
    ["nameless, after a blank line", [...OPENING, ...CONTACTS, "", "Neither of those lines is mine."]],
  ])("writes and mints neither the phone nor the email of another person's card, disclaimer %s", async (_, lines) => {
    const { by } = await fill(lines.join("\n"));
    for (const label of ["Phone", "Email"]) {
      const f = by(label);
      expect(f?.value ?? null, label).toBeNull();
      expect(f === undefined ? undefined : mintOf(f), label).toBeUndefined();
    }
  });

  it("asks both owner questions with the whole note, and no code-made claim that it names no one", async () => {
    const note = [...OPENING, ...CONTACTS, "Neither of those lines is mine."].join("\n");
    const { j } = await fill(note);
    const whose = j.reqs.filter((r) => r.purpose === "fill.whose");
    expect(whose).toHaveLength(2);
    for (const r of whose) {
      const owner = Object.entries(r.questions).filter(([id]) => id.endsWith("_owner")).map(([, q]) => String(q.instructions));
      expect(owner.length).toBeGreaterThan(0);
      for (const ins of owner) {
        expect(noteOf(r, ins)).toBe(note);
        expect(ins).not.toContain("names no other person");
      }
    }
  });

  it("withholds a value from a note too long to show whole, even with 'user' and 'exact' at confidence 1", async () => {
    const { by } = await fill([...OPENING, PROSE, ...CONTACTS].join("\n"), theirs, { owner: () => "user" });
    for (const label of ["Phone", "Email"]) {
      const f = by(label);
      expect(f?.value ?? null, label).toBeNull();
      expect(f === undefined ? undefined : mintOf(f), label).toBeUndefined();
      expect(f === undefined ? null : heldReason(f), label).toBe(`Caret left ${label}: ${NOTE_UNSHOWN}.`);
    }
  });

  it("withholds a part derived from an address in a note too long to show whole", async () => {
    const note = [...OPENING, PROSE, "Copied from the visitor card:", "Address: 41 Quarry Lane, Dover, DE 19901"].join("\n");
    const labels = ["Street address", "City"];
    const pick = (l: string): string | null => (l === "City" ? "Dover" : l === "Street address" ? "41 Quarry Lane" : null);
    const { by } = await fill(note, pick, { labels, owner: () => "user" });
    for (const label of labels) {
      const f = by(label);
      expect(f?.value ?? null, label).toBeNull();
      expect(f === undefined ? undefined : mintOf(f), label).toBeUndefined();
    }
  });

  it("keeps its exceptions: the user's exact identity from memory, and a value the instruction spells out", async () => {
    const note = [...OPENING, PROSE, `Email: ${USER_EMAIL}`, `Phone: ${PHONE}`].join("\n");
    const about: AboutValue[] = [{ id: "a-email", label: "Email", kind: "email", value: USER_EMAIL }];
    const mine = await fill(note, (l) => (l === "Email" ? USER_EMAIL : null), { about, owner: () => "user" });
    expect(mine.by("Email")?.value).toBe(USER_EMAIL);
    const scope: FillScope = { fields: ["form/0"], windows: null, memory: false, instruction: `put ${USER_PHONE} in Phone`, person: null, literals: new Map([["form/0", USER_PHONE]]) };
    const said = await fill(note, (l) => (l === "Phone" ? USER_PHONE : null), { owner: () => "user", scope, labels: ["Phone"] });
    expect(said.by("Phone")?.value).toBe(USER_PHONE);
  });
});

describe("HA2 rule 2 for address parts (lead decision): a lone city, ZIP or country line is a person's detail too", () => {
  const ADDRESS = ["Street address", "City", "State", "ZIP code", "Country"];
  const card = ["Copied from the visitor card:", "41 Quarry Lane", "Dover", "Delaware", "19901", "United States"];
  const parts = (l: string): string | null => ({ "Street address": "41 Quarry Lane", City: "Dover", State: "Delaware", "ZIP code": "19901", Country: "United States" })[l] ?? null;

  it.each([
    ["after the lines", [...OPENING, ...card, "Neither of those lines is mine."]],
    ["before the lines", [...OPENING, "The next lines are not mine.", ...card]],
  ])("writes no part of another person's address, disclaimer %s", async (_, lines) => {
    const { by } = await fill(lines.join("\n"), parts, { labels: ADDRESS });
    for (const label of ADDRESS) {
      const f = by(label);
      expect(f?.value ?? f?.handoff?.value ?? null, label).toBeNull();
      expect(f === undefined ? undefined : mintOf(f), label).toBeUndefined();
    }
  });

  it("withholds a lone ZIP line from a note too long to show whole, even with 'user' and 'exact' at confidence 1", async () => {
    const { by } = await fill([...OPENING, PROSE, "19901"].join("\n"), parts, { labels: ["ZIP code"], owner: () => "user" });
    const f = by("ZIP code");
    expect(f?.value ?? null).toBeNull();
    expect(f === undefined ? null : heldReason(f)).toBe(`Caret left ZIP code: ${NOTE_UNSHOWN}.`);
  });

  it("fills the user's own lone city and ZIP lines from a note that fits, once Jev saw it and said 'user'", async () => {
    const { by } = await fill([...OPENING, "Dover", "19901"].join("\n"), parts, { labels: ["City", "ZIP code"] });
    expect([by("City")?.value, by("ZIP code")?.value]).toEqual(["Dover", "19901"]);
  });
});

describe("HA2's cost: notes that fit still fill", () => {
  it("fills the user's own phone and email from a note that names no other person", async () => {
    const note = [...OPENING, `Phone: ${USER_PHONE}`, `Email: ${USER_EMAIL}`].join("\n");
    const { by } = await fill(note, (l) => (l === "Phone" ? USER_PHONE : l === "Email" ? USER_EMAIL : null));
    expect([by("Phone")?.value, by("Email")?.value]).toEqual([USER_PHONE, USER_EMAIL]);
  });

  it("fills them from a note that names another person in an unrelated sentence, once Jev saw it and said 'user'", async () => {
    const note = [...OPENING, "Lunch with Bram Keller on Friday.", `Phone: ${USER_PHONE}`, `Email: ${USER_EMAIL}`].join("\n");
    const { by } = await fill(note, (l) => (l === "Phone" ? USER_PHONE : l === "Email" ? USER_EMAIL : null));
    expect([by("Phone")?.value, by("Email")?.value]).toEqual([USER_PHONE, USER_EMAIL]);
  });
});

describe("HA2 rule 1: the exactness check makes no ownership claim", () => {
  it("asks both wordings exactly, whatever owner the value carries", async () => {
    const field = makeFieldContract({ windowId: "form", node: { key: "form/0", parent: null, role: "AXTextField", editable: true }, descriptor: "Text field. Label: 'Phone'.", name: "Phone", labelWords: ["Phone"], control: "text", kinds: new Set(), part: null });
    const sent: string[] = [];
    const ask: AskJev = async (req) => {
      for (const q of Object.values(req.questions)) sent.push(String(q.instructions));
      return { model: "jev-ha2", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "exact", confidence: 1 }])), inputTokens: 0, latencyMs: 0, costUsd: 0 };
    };
    await verifyProposed([{ field, text: USER_PHONE, display: USER_PHONE, provenance: { kind: "instruction", span: USER_PHONE }, owner: "user" }], { askJev: ask, ledger: null, now: T0, authority: { kind: "fill", proposalId: "p1" } });
    expect(sent.sort()).toEqual(
      [
        `Field: Text field. Label: 'Phone'. Caret proposes to type this into it, with nothing added or removed: "${USER_PHONE}". It was read from the user's instruction. What is the proposed text, for this field?`,
        `Proposed text for the field 'Phone': "${USER_PHONE}". Read from the user's instruction. The field: Text field. Label: 'Phone'. If Caret typed exactly this text into the field, what would it have typed?`,
      ].sort(),
    );
  });
});

describe("HA2 recall lever 1: the owner-note allotment (privacy.ts OWNER_NOTE_CHARS, off in the product)", () => {
  afterEach(() => setOwnerNoteChars(null));
  const LONG_MINE = [...OPENING, PROSE, `Phone: ${USER_PHONE}`, `Email: ${USER_EMAIL}`].join("\n");
  const mine = (l: string): string | null => (l === "Phone" ? USER_PHONE : l === "Email" ? USER_EMAIL : null);

  it("is off by default: a note with a prose line is withheld as too long", async () => {
    expect(OWNER_NOTE_CHARS).toBe(0);
    const { by } = await fill(LONG_MINE, mine);
    expect(by("Phone")?.value ?? null).toBeNull();
  });

  it("with an allotment the note fits, shows the whole note in both owner questions and fills the user's own values", async () => {
    setOwnerNoteChars(4000);
    const { by, j } = await fill(LONG_MINE, mine);
    expect([by("Phone")?.value, by("Email")?.value]).toEqual([USER_PHONE, USER_EMAIL]);
    const whose = j.reqs.filter((r) => r.purpose === "fill.whose");
    expect(whose.every((r) => Object.values((r.state as { source_notes?: Record<string, string> }).source_notes ?? {}).includes(LONG_MINE))).toBe(true);
  });

  it("still withholds another person's card from a long note once the shown note disclaims it", async () => {
    setOwnerNoteChars(4000);
    const { by } = await fill([...OPENING, PROSE, ...CONTACTS, "Neither of those lines is mine."].join("\n"));
    expect([by("Phone")?.value ?? null, by("Email")?.value ?? null]).toEqual([null, null]);
  });

  it("never sends a note longer than the allotment, nor a line redaction cut", async () => {
    setOwnerNoteChars(200);
    const { by, j } = await fill(LONG_MINE, mine);
    expect(by("Phone")?.value ?? null).toBeNull();
    expect(JSON.stringify(j.reqs)).not.toContain(PROSE);
  });
});
