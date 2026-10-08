// What the verifier and value settlement seal, measured in their final bytes: a provenance's texts are quoted at the
// ranges their own roles were read at, a typed value no line shows charges the node it was read from, and the owner-note
// allotment goes only to owner questions. Every name and value is invented.
import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { Disclosure, LedgerRefused, measureBytes } from "../src/privacy/disclosure.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { OWNER_QUESTION_PURPOSES, SHAPES } from "../src/privacy/shapes.ts";
import { OWNER_NOTE_CHARS } from "../src/privacy.ts";
import { collectCandidates } from "../src/fill/candidates.ts";
import { candidateProvenance, proposeFill, type FillScope } from "../src/fill/fill.ts";
import { fieldContract, makeFieldContract, setTestVerifier, verifyProposed, type Proposed, type Provenance } from "../src/fill/contract.ts";
import { sealRequest, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import type { Node } from "../src/protocol.ts";
import { field, snap, text } from "./builders.ts";
import { TEST_AUTHORITY } from "./mint.ts";
import { STAND_IN } from "./setup/verifier.ts";

const MESSAGES = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
const TEXTEDIT = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const FORM_APP = { pid: 5150, bundleId: "dev.caret.fixture", name: "Fixture" };
const FORM = "5150-7";
const REF = "dev.caret.fixture/standard/textfield:reference~0";

afterEach(() => setTestVerifier(STAND_IN));

/** What each sealed request said at its seal, by purpose: its charges, or the seal's refusal. */
type Sealed = { purpose: string; charged?: Readonly<Record<string, number>>; bytes?: string; refused?: string };

/** Seals a request as the Jev client does (jev.ts sealRequest) and records what the seal said; a refusal is thrown on. */
function sealed(req: JevRequest, out: Sealed[]): void {
  try {
    const s = sealRequest(req).sealed;
    out.push({ purpose: req.purpose ?? "", charged: s.charged, bytes: s.bytes });
  } catch (e) {
    if (!(e instanceof LedgerRefused)) throw e;
    out.push({ purpose: req.purpose ?? "", refused: e.message });
    throw e;
  }
}

/** A form with one Reference field, focused, beside `source`. */
function desk(source: Node[], o: { title: string; app?: typeof MESSAGES; values?: { kind: "date"; text: string; nodeKey: string }[] }): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap(source, { at: 1000, windowId: "src-1", title: o.title, app: o.app ?? MESSAGES, ...(o.values === undefined ? {} : { values: o.values }) }));
  m.apply(snap([field(REF, "", { label: "Reference", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
  return m;
}

/** The verifier's two wordings for one proposed value, each sealed, with a fresh Disclosure over `m`. */
async function verified(m: ScreenModel, value: string, provenance: Provenance): Promise<Sealed[] & { asked?: boolean }> {
  const form = m.windows.get(FORM) as WindowState;
  const proposed: Proposed = { field: fieldContract(form, form.nodes.get(REF) as Node), text: value, display: value, provenance, owner: null };
  const out: Sealed[] & { asked?: boolean } = [];
  setTestVerifier(async (req) => {
    sealed(req, out);
    return STAND_IN(req);
  });
  const r = await verifyProposed([proposed], { askJev: STAND_IN, ledger: new Disclosure(m), now: 3000, authority: TEST_AUTHORITY }).catch((e: unknown) => {
    if (!(e instanceof LedgerRefused)) throw e;
    return null;
  });
  // Whether the value was put to the verifier at all: a value the ledger refuses at mint is not asked about.
  if (r !== null) out.asked = r.asks.some((a) => a !== null);
  return out;
}

describe("the verifier quotes each text of a provenance at its own role's range", () => {
  it("charges the value 'AB01' where it was read, not at a window title spelled the same: 11 of a limit of 11", async () => {
    // T = 4 + 9 + 11 = 24, limit 11. The title (4), the value in the label (4) and the rest of the label (3) are 11.
    const m = desk([text("c0", "Ref: AB01"), { key: "c1", parent: null, role: "AXButton", label: "ZZZZZZZZZZZ" }], { title: "AB01" });
    const c = collectCandidates(m, FORM, { now: 3000 }).candidates.find((x) => x.text === "AB01");
    expect(c).toBeDefined();
    const out = await verified(m, "AB01", candidateProvenance(m, c!));
    expect(out.length, "both wordings were sealed").toBe(2);
    for (const r of out) {
      expect(r.bytes).toContain("labelled 'Ref'");
      expect(r.charged?.["src-1"], "the title, the value at [5, 9) of the label, and 'Ref'").toBe(11);
    }
  });

  it("at a limit of 8, leaves out the label it cannot also pay for, and sends no more than 8: 'AB01' and the title", async () => {
    // T = 4 + 9 + 5 = 18, limit 8. Charged at the title alone, the three texts were sent for 7.
    const m = desk([text("c0", "Ref: AB01"), { key: "c1", parent: null, role: "AXButton", label: "ZZZZZ" }], { title: "AB01" });
    const c = collectCandidates(m, FORM, { now: 3000 }).candidates.find((x) => x.text === "AB01");
    expect(c).toBeDefined();
    const out = await verified(m, "AB01", candidateProvenance(m, c!));
    expect(out.length, "both wordings were sealed").toBe(2);
    for (const r of out) {
      expect(r.bytes).not.toContain("labelled 'Ref'");
      expect(r.charged?.["src-1"]).toBe(8);
    }
  });
});

describe("a typed value no line shows charges the node it was read from, whole", () => {
  /** Kofi's chat, saying "the following Friday", which the reader typed as 2026-10-16, and `pad` more characters. */
  const fridayDesk = (pad: number): ScreenModel =>
    desk([text("c0", "the following Friday"), { key: "c1", parent: null, role: "AXButton", label: "Z".repeat(pad) }], { title: "Kofi", values: [{ kind: "date", text: "2026-10-16", nodeKey: "c0" }] });
  const yearOf = (m: ScreenModel): Provenance => {
    const c = collectCandidates(m, FORM, { now: 3000 }).candidates.find((x) => x.text === "2026-10-16");
    expect(c, "the typed date is offered").toBeDefined();
    return { kind: "derived", how: "datePart", base: candidateProvenance(m, c!), also: null };
  };

  it("charges '2026', the year of a typed '2026-10-16' read from 'the following Friday', the title and that node: 24", async () => {
    // T = 4 + 20 + 26 = 50, limit 24. No line shows the date, so its node is charged whole, with the title.
    const m = fridayDesk(26);
    const out = await verified(m, "2026", yearOf(m));
    expect(out.length, "both wordings were sealed").toBe(2);
    for (const r of out) expect(r.charged?.["src-1"], "the title, 4, and the whole node, 20").toBe(24);
  });

  it("does not ask about '2026' when the node it was read from does not fit: 24 of a limit of 11", async () => {
    // T = 4 + 20 = 24, limit 11. Charged nothing for the typed date, the request went at the title's 4.
    const m = fridayDesk(0);
    const out = await verified(m, "2026", yearOf(m));
    expect(out.asked, "the verifier was not asked about the value").toBe(false);
    expect(out.length, "nothing was sealed").toBe(0);
  });

  it("charges a derivation from a typed basis the node: '2026' from the basis '2026-10-16' takes 20 at seal", () => {
    // Disclosure.basis applies candidate()'s rule: a basis no line shows declares the node it was read from.
    const m = fridayDesk(26);
    const d = new Disclosure(m);
    const view = redactWindow(m.windows.get("src-1") as WindowState);
    const b = d.basis(view, "2026-10-16");
    expect(b).not.toBeNull();
    const year = d.derived(b!, "2026");
    expect(year).not.toBeNull();
    expect(measureBytes({ purpose: "test", disclosure: d }, JSON.stringify({ year })).charged["src-1"]).toBe(20);
  });
});

describe("the owner-note allotment, only for owner questions", () => {
  // TextEdit's two notes, 705 and 699 characters, each the whole unit a phone number sits in. T = 5 + 705 + 699 = 1409.
  const NOTE_A = `Phone: 555-0101 ${"alfa ".repeat(137)}alfa`;
  const NOTE_B = `Phone: 555-0102 ${"bravo ".repeat(113)}bravo`;
  const PHONE = "dev.caret.fixture/standard/textfield:phone~0";

  it("holds value settlement's notes to the window's limit: two owner notes of 1404 do not go in fill.values", async () => {
    const m = new ScreenModel();
    m.apply(snap([field("n0", NOTE_A, { role: "AXTextArea" }), field("n1", NOTE_B, { role: "AXTextArea" })], { at: 1000, windowId: "note-1", title: "Notes", app: TEXTEDIT }));
    m.apply(snap([field(PHONE, "", { label: "Phone", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const scope: FillScope = { fields: [PHONE], windows: null, memory: false, instruction: "put my phone in", person: null, literals: new Map() };
    const out: Sealed[] = [];
    // Every value is the user's; the base question's two wordings disagree (555-0101 against none), so settlement asks.
    const ask: AskJev = async (req) => {
      sealed(req, out);
      const answers: Record<string, { choice: string; confidence: number }> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        if (id.endsWith("_whose") || id.endsWith("_owner")) answers[id] = { choice: "user", confidence: 0.95 };
        else {
          const hit = Object.entries(q.criteria).find(([, d]) => d?.startsWith('"555-0101"') || d?.startsWith('Proposed value: "555-0101"'))?.[0];
          answers[id] = { choice: String(q.instructions).startsWith("Instruction from the user:") ? "none" : (hit ?? "none"), confidence: 0.95 };
        }
      }
      return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    await proposeFill(m, ask, FORM, PHONE, 3000, { scope });
    expect(out.some((r) => r.purpose === "fill.whose" && r.bytes?.includes(NOTE_A) === true), "the owner question carried the notes at the allotment").toBe(true);
    const others = out.filter((r) => r.purpose !== "fill.whose");
    expect(others.length).toBeGreaterThan(0);
    // Settlement was asked, and named no more of the notes than the window's limit allows: before, it sent both at 1409.
    expect(others.filter((r) => r.purpose === "fill.values").length, "the base question and settlement").toBe(4);
    for (const r of others) expect(r.charged?.["note-1"], `${r.purpose}: ${JSON.stringify(r.charged ?? r.refused)}`).toBe(725);
  });

  it("holds the verifier's notes after settlement to the window's limit too: settlement and fill.verify stay within 1200 and 555-0101 is filled", async () => {
    const m = new ScreenModel();
    m.apply(snap([field("n0", NOTE_A, { role: "AXTextArea" }), field("n1", NOTE_B, { role: "AXTextArea" })], { at: 1000, windowId: "note-1", title: "Notes", app: TEXTEDIT }));
    m.apply(snap([field(PHONE, "", { label: "Phone", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const scope: FillScope = { fields: [PHONE], windows: null, memory: false, instruction: "put my phone in", person: null, literals: new Map() };
    const out: Sealed[] = [];
    let values = 0;
    // The base question's wordings disagree; settlement's agree on 555-0101, which then goes to the verifier.
    const ask: AskJev = async (req) => {
      sealed(req, out);
      const settling = req.purpose === "fill.values" && values++ >= 2;
      const answers: Record<string, { choice: string; confidence: number }> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        if (id.endsWith("_whose") || id.endsWith("_owner")) answers[id] = { choice: "user", confidence: 0.95 };
        else if (req.purpose === "fill.verify") answers[id] = { choice: "exact", confidence: 0.95 };
        else {
          const hit = Object.entries(q.criteria).find(([, d]) => d?.startsWith('"555-0101"') || d?.startsWith('Proposed value: "555-0101"'))?.[0];
          answers[id] = { choice: !settling && String(q.instructions).startsWith("Instruction from the user:") ? "none" : (hit ?? "none"), confidence: 0.95 };
        }
      }
      return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    setTestVerifier(async (req) => {
      sealed(req, out);
      return STAND_IN(req);
    });
    const p = await proposeFill(m, ask, FORM, PHONE, 3000, { scope });
    expect(p.fields.find((f) => f.key === PHONE)?.value).toBe("555-0101");
    const verify = out.filter((r) => r.purpose === "fill.verify");
    expect(verify.length, "the settled value was verified").toBeGreaterThan(0);
    for (const r of out.filter((x) => x.purpose !== "fill.whose")) expect(r.charged?.["note-1"], `${r.purpose}: ${JSON.stringify(r.charged ?? r.refused)}`).toBeLessThanOrEqual(1200);
  });

  it("refuses at seal two owner notes under source_notes in fill.values and fill.verify, and admits them in fill.whose", () => {
    const m = new ScreenModel();
    m.apply(snap([field("n0", NOTE_A, { role: "AXTextArea" }), field("n1", NOTE_B, { role: "AXTextArea" })], { at: 1000, windowId: "note-1", title: "Notes", app: TEXTEDIT }));
    const charge = (purpose: string): number | string => {
      const d = new Disclosure(m);
      const notes = d.ownerNotesOnScreen([NOTE_A, NOTE_B]);
      expect(notes, "both notes minted as owner notes").not.toBeNull();
      try {
        return measureBytes({ purpose, disclosure: d }, JSON.stringify({ state: { source_notes: { note_1: notes![0], note_2: notes![1] } } })).charged["note-1"] ?? 0;
      } catch (e) {
        if (!(e instanceof LedgerRefused)) throw e;
        return e.message;
      }
    };
    // Each request's key "source_notes" holds the title "Notes" whole, so the seal charges all 1409 of the window.
    expect(charge("fill.whose")).toBe(1409);
    expect(charge("plan.verify")).toBe(1409);
    expect(charge("fill.values")).toMatch(/reveals 1409 characters of window note-1, over its limit of 1200/u);
    expect(charge("fill.verify")).toMatch(/reveals 1409 characters of window note-1, over its limit of 1200/u);
  });

  it("names as owner-question requests exactly the shapes whose source_notes take the owner-note allotment", () => {
    const allotted = Object.entries(SHAPES).filter(([, slots]) => slots["state.source_notes.*"]?.max === OWNER_NOTE_CHARS).map(([k]) => k);
    expect(new Set(allotted)).toEqual(OWNER_QUESTION_PURPOSES);
  });
});

describe("the verifier's source_notes, per batch", () => {
  it("sends each batch only its own values' units: 21 values in two batches, 20 and 1 notes, none refused for its shape", async () => {
    const m = new ScreenModel();
    const d = new Disclosure(m);
    const units = new Map<Proposed, { id: ReturnType<Disclosure["id"]>; text: NonNullable<ReturnType<Disclosure["candidate"]>> }>();
    const proposed: Proposed[] = [];
    for (let i = 0; i < 21; i++) {
      m.apply(snap([text("t", `Value: X${i}`)], { at: i + 1, windowId: `n${i}`, title: `N${i}`, app: TEXTEDIT }));
      const view = redactWindow(m.windows.get(`n${i}`) as WindowState);
      const f = makeFieldContract({ windowId: FORM, node: field(`f${i}`, "", { label: "Reference" }), descriptor: "Text field. Label: Reference.", name: "Reference", labelWords: ["Reference"], control: "text", kinds: new Set(), part: null });
      const p: Proposed = { field: f, text: `X${i}`, display: `X${i}`, provenance: { kind: "instruction", span: `X${i}` }, owner: null };
      proposed.push(p);
      units.set(p, { id: d.id(`note_${i}`), text: d.candidate(view, `Value: X${i}`)! });
    }
    const out: Sealed[] = [];
    setTestVerifier(async (req) => {
      sealed(req, out);
      return STAND_IN(req);
    });
    const r = await verifyProposed(proposed, { askJev: STAND_IN, ledger: d, now: 3000, authority: TEST_AUTHORITY, unitOf: (p) => units.get(p) ?? null });
    expect(r.asks.every((a) => a !== null)).toBe(true);
    const notes = out.map((x) => (JSON.parse(x.bytes ?? "{}") as { state?: { source_notes?: Record<string, string> } }).state?.source_notes ?? {});
    expect(notes.map((n) => Object.keys(n).length).sort((a, b) => a - b)).toEqual([1, 1, 20, 20]);
  });
});

describe("no text is minted or sent without its provenance", () => {
  it("refuses a derived value whose basis the ledger refuses: '2026-10-16' from a chat's '16/10/2026' is not asked about", async () => {
    // T = 4 + 10 = 14, limit 6. The basis is 10; re-minted as plan text, the ISO date stood in no line and charged 4.
    const m = desk([text("c0", "16/10/2026")], { title: "Kofi" });
    const c = collectCandidates(m, FORM, { now: 3000 }).candidates.find((x) => x.text === "16/10/2026");
    expect(c).toBeDefined();
    const pr: Provenance = { kind: "derived", how: "resolved", base: candidateProvenance(m, c!), also: null };
    const out = await verified(m, "2026-10-16", pr);
    expect(out.asked, "the derived value is not asked about").toBe(false);
    expect(out.length).toBe(0);
  });

  /** Kofi's chat saying "the following Friday", which the reader typed with runs of spaces, and `pad` more characters. */
  const spacedDesk = (pad: number): { m: ScreenModel; d: Disclosure; view: WindowState } => {
    const m = desk([text("c0", "the following Friday"), { key: "c1", parent: null, role: "AXButton", label: "Z".repeat(pad) }], { title: "Kofi", values: [{ kind: "date", text: "Oct   16, 2026", nodeKey: "c0" }] });
    return { m, d: new Disclosure(m), view: redactWindow(m.windows.get("src-1") as WindowState) };
  };

  it("charges a typed value read with runs of spaces its node: 'Oct   16, 2026' from 'the following Friday' takes 20", () => {
    // T = 4 + 20 + 26 = 50, limit 24. Compared with the typed value as the reader spelled it, the collapsed text matched
    // no value, and the node was charged nothing.
    const { d, view } = spacedDesk(26);
    const said = d.candidate(view, "Oct   16, 2026");
    expect(said).not.toBeNull();
    expect(measureBytes({ purpose: "test", disclosure: d }, JSON.stringify({ said })).charged["src-1"]).toBe(20);
    const e = spacedDesk(26);
    const b = e.d.basis(e.view, "Oct   16, 2026");
    const year = e.d.derived(b!, "2026");
    expect(measureBytes({ purpose: "test", disclosure: e.d }, JSON.stringify({ year })).charged["src-1"]).toBe(20);
  });

  it("refuses the spaced typed value and a derivation from it at a limit of 11", () => {
    // T = 4 + 20 = 24, limit 11.
    const { d, view } = spacedDesk(0);
    expect(d.candidate(view, "Oct   16, 2026")).toBeNull();
    const b = d.basis(view, "Oct   16, 2026");
    expect(b === null ? null : d.derived(b, "2026")).toBeNull();
  });

  it("keeps a mail a conversation from the moment its view is read: a basis from a mail closed before any measurement is held to 41", () => {
    // A mail in Chrome: "From:" and a "Subject:" line redaction removes (it names a password) make it a conversation.
    // T = 14 + 10 + 24 + 35 = 83, limit 41. Classified from the kept view alone after it closed, it was a page at 1200.
    const m = new ScreenModel();
    const body = ["see you at five tomorrow", "and the venue holds the date for us"];
    const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
    m.apply(snap([text("h0", "From: Dana"), text("h1", "Subject: my password is violet-orchard-seven"), ...body.map((l, i) => text(`b${i}`, l))], { at: 2, windowId: "mail-1", title: "Inbox - Chrome", app: chrome }));
    const view = redactWindow(m.windows.get("mail-1") as WindowState);
    // The Disclosure is built and the bases read before anything is measured; the mail then closes.
    const d = new Disclosure(m);
    const bases = body.map((l) => d.basis(view, l)!);
    m.close("mail-1", 3);
    const said = d.derived(bases, body.join(" "));
    expect(said, "refused at mint: 59 of a limit of 41").toBeNull();
  });
});

describe("a choice made from minted bases", () => {
  it("charges its bases' spans: 'Texas', the option a note's 'TX' names, takes the note's 2 for TX besides any line holding it", () => {
    const m = new ScreenModel();
    m.apply(snap([text("n0", "State: TX"), text("n1", "Z".repeat(40))], { at: 1, windowId: "note-1", title: "N", app: TEXTEDIT }));
    const d = new Disclosure(m);
    const view = redactWindow(m.windows.get("note-1") as WindowState);
    const tx = d.candidate(view, "TX", { part: "node\u0000n0\u0000label", start: 7, end: 9 })!;
    expect(d.derived(tx, "Texas"), "no word of 'Texas' is the base's").toBeNull();
    const texas = d.chosen([tx], "Texas");
    expect(texas).toBe("Texas");
    // Only the choice is sent: it is charged TX's range, which plan text alone would not charge.
    expect(measureBytes({ purpose: "test", disclosure: d }, JSON.stringify({ texas })).charged["note-1"]).toBe(2);
    const plain = new Disclosure(m);
    expect(measureBytes({ purpose: "test", disclosure: plain }, JSON.stringify({ texas: plain.planText("Texas") })).charged["note-1"] ?? 0, "as plan text").toBe(0);
  });
});
