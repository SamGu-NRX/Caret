// What a fill offers is admitted once, where it is collected: a candidate goes in with every fact it is described by,
// at the ranges they were read from, or it is cut and the cut rules withhold its kind. Building the requests afterwards
// never shrinks that set. And the wording reserved before any value is admitted is the wording that will be sent.
// Every name and value is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill, valueSettlementOf, type FillScope } from "../src/fill/fill.ts";
import { sealRequest, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import { STAND_IN } from "./setup/verifier.ts";
import type { Node } from "../src/protocol.ts";
import { field, node, snap, text } from "./builders.ts";
import { associationKey, collectCandidates } from "../src/fill/candidates.ts";
import { kindTerm } from "../src/fill/kinds.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";

const MESSAGES = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
const FORM_APP = { pid: 5150, bundleId: "dev.caret.fixture", name: "Fixture" };
const FORM = "5150-7";
const key = (label: string): string => `dev.caret.fixture/standard/textfield:${label.toLowerCase().replace(/ /g, "-")}~0`;

/** A chat, then a form with `labels`, focused on the first. */
function desk(chat: Node[], labels: string[], title = "K"): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap(chat, { at: 1000, windowId: "chat-1", title, app: MESSAGES }));
  m.apply(snap(labels.map((l, i) => field(key(l), "", { label: l, frame: [100, 40 + i * 40, 300, 24] })), { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
  return m;
}

/** Picks, for each field's question, the offered value its label's entry names (by the description's start), else none. */
function picking(want: Record<string, string>, seen: JevRequest[] = []): AskJev {
  return async (req) => {
    seen.push(req);
    const answers: Record<string, { choice: string; confidence: number }> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      // Whose details a field wants, and whose a value is: the user's.
      if (id.endsWith("_whose") || id.endsWith("_owner")) {
        answers[id] = { choice: "user", confidence: 0.95 };
        continue;
      }
      const label = Object.keys(want).find((l) => String(q.instructions).includes(`'${l}'`));
      const hit = label === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want[label]}"`))?.[0];
      answers[id] = { choice: hit ?? "none", confidence: 0.95 };
    }
    return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  };
}

/** The values a request's question for `label` offers, by their description's quoted text. */
const offered = (req: JevRequest, label: string): string[] =>
  Object.values(req.questions).filter((q) => String(q.instructions).includes(`'${label}'`)).flatMap((q) => Object.values(q.criteria).flatMap((d) => /^"([^"]*)"/.exec(String(d))?.[1] ?? []));

describe("a fill's candidates, admitted once with their facts", () => {
  it("cuts a value whose facts do not fit, so a field is not handed the other one as if it were the only one", async () => {
    // T = 1 + 9 + 9 + 11 = 30, limit 14. AB01 with its label and the title is 8; AB02 and its own label 7 more.
    const m = desk([text("c0", "Ref: AB01"), text("c1", "Ref: AB02"), { key: "c2", parent: null, role: "AXButton", label: "ZZZZZZZZZZZ" }], ["Reference"]);
    const seen: JevRequest[] = [];
    const p = await proposeFill(m, picking({ Reference: "AB01" }, seen), FORM, key("Reference"), 3000);
    const f = p.fields.find((x) => x.key === key("Reference"))!;
    // AB02 did not fit: the window is cut, and a pick under the label the cut value shares is withheld, not filled.
    expect(seen.flatMap((r) => offered(r, "Reference"))).not.toContain("AB02");
    expect(f.value, "AB01 is not the only value the chat shows").toBeNull();
    expect(f.withheld).toBe("sourceCut");
  });

  it("reserves only the wording the requests will carry: a chat line 'country' does not cost AB01 its description", async () => {
    // T = 1 + 9 + 7 = 17, limit 8: AB01, its label and the title take 8. The derived-values sentence names "country",
    // and no value here is derived, so it is not sent and not reserved.
    const m = desk([text("c0", "Ref: AB01"), text("c1", "country")], ["Reference"]);
    const p = await proposeFill(m, picking({ Reference: "AB01" }), FORM, key("Reference"), 3000);
    expect(p.fields.find((x) => x.key === key("Reference"))?.value).toBe("AB01");
  });

  it("derives a part from its base where the base was read: 'Austin' from an address on a long chat line", async () => {
    const line = `Address: 123 Main St, Austin, TX 78701 ${"Z".repeat(80)}`;
    // T = 4 + 120 = 124, limit 61: the address at its range, its label and the title fit; the whole line does not.
    const m = new ScreenModel();
    m.apply(snap([text("c0", line)], { at: 1000, windowId: "chat-1", title: "Kofi", app: MESSAGES, values: [{ kind: "address", text: "123 Main St, Austin, TX 78701", nodeKey: "c0" }] }));
    m.apply(snap([field(key("City"), "", { label: "City", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    // No whose questions: a conversation's value is never owner-judged (HA2 rule c), which is not what this case is about.
    const p = await proposeFill(m, picking({ City: "Austin" }), FORM, key("City"), 3000, { whose: false });
    expect(p.fields.find((x) => x.key === key("City"))?.value).toBe("Austin");
  });
});

const NOTES = { pid: 6161, bundleId: "dev.caret.notes", name: "Notes" };

describe("collection order, associations, one membership, kept ranges", () => {
  it("reads the windows by recency: a note's eighty dates do not crowd out the date of the chat the user just left", async () => {
    const m = new ScreenModel();
    const day = (i: number): string => new Date(Date.UTC(2026, 0, 1 + i)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    m.apply(snap(Array.from({ length: 80 }, (_, i) => text(`n${i}`, day(i))), { at: 500, windowId: "note-1", title: "Orders", app: NOTES }));
    m.apply(snap([text("c0", "Date: 2026-10-08"), text("c1", "see you at the venue tomorrow morning")], { at: 1000, windowId: "chat-1", title: "K", app: MESSAGES, focused: true }));
    m.apply(snap([field(key("Date"), "", { label: "Date", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const seen: JevRequest[] = [];
    // A Jev that takes the note's first date whenever it is offered.
    const p = await proposeFill(m, picking({ Date: "Jan 1, 2026" }, seen), FORM, key("Date"), 3000);
    const f = p.fields.find((x) => x.key === key("Date"))!;
    // The chat is read first, so its date is offered; the note's dates then reach the generator's cap partway, the date
    // kind is cut, and the field is withheld rather than filled with a date that was not the only one.
    expect(seen.flatMap((r) => offered(r, "Date")).concat(f.withheld === "sourceCut" ? ["2026-10-08"] : [])).toContain("2026-10-08");
    expect(f.value, "never the note's first date as if the chat's were not there").not.toBe("Jan 1, 2026");
  });

  it("reads each window whole in recency order: a newer note's 'Ref: AB01' is offered before an older chat's 80 refs fill the cap", async () => {
    const m = new ScreenModel();
    m.apply(snap([...Array.from({ length: 80 }, (_, i) => text(`c${i}`, `Ref: AB${String(i + 2).padStart(2, "0")}`)), node("pad", "AXButton", { label: "Z".repeat(1400) })], { at: 500, windowId: "chat-1", title: "K", app: MESSAGES }));
    m.apply(snap([text("n0", "Ref: AB01")], { at: 1000, windowId: "note-1", title: "N", app: NOTES, focused: true }));
    m.apply(snap([field(key("Reference"), "", { label: "Reference", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const seen: JevRequest[] = [];
    const p = await proposeFill(m, picking({ Reference: "AB02" }, seen), FORM, key("Reference"), 3000);
    expect(seen.flatMap((r) => offered(r, "Reference")), "the newer note's value").toContain("AB01");
    // The cap stopped the chat partway, so its Ref values are cut: AB02 is not written as if it were the only one.
    const f = p.fields.find((x) => x.key === key("Reference"))!;
    expect(f.value).toBeNull();
    expect(f.withheld).toBe("sourceCut");
  });

  it("counts a window the cap never reached as cut: a chat's date withholds Date when a newer note's 80 lines fill the cap", async () => {
    const m = new ScreenModel();
    m.apply(snap([text("c0", "Date: 2026-10-08")], { at: 500, windowId: "chat-1", title: "K", app: MESSAGES, values: [{ kind: "date", text: "2026-10-08", nodeKey: "c0" }] }));
    m.apply(snap(Array.from({ length: 80 }, (_, i) => text(`n${i}`, `Ref: AB${String(i + 1).padStart(2, "0")}`)), { at: 1000, windowId: "note-1", title: "N", app: NOTES, focused: true }));
    m.apply(snap([field(key("Date"), "", { label: "Date", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    // The chat is cut as a privacy cut would cut it: its date's kind, words and label are what it may hold.
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [new Set(["date", kindTerm("date")])] });
    expect(c.candidates.length).toBe(80);
    expect(c.cut).toEqual(["chat-1"]);
    expect([...c.cutTerms]).toEqual(expect.arrayContaining(["date", kindTerm("date")]));
    expect(c.omitted).toContain(associationKey("chat-1", null, "Date"));
    // Read in two passes, the chat's typed date went in first and was written; now the date kind is cut.
    const p = await proposeFill(m, picking({ Date: "2026-10-08" }), FORM, key("Date"), 3000);
    const f = p.fields.find((x) => x.key === key("Date"))!;
    expect(f.value).toBeNull();
    expect(f.withheld).toBe("sourceCut");
  });

  it("counts a note the cap never reached as cut: its 'Locker' line withholds Locker when a newer note's 80 lockers fill the cap", async () => {
    // Neither note is the window the user just left, so no anchor lets a labelled pick stand on its own. "Locker" names
    // no kind, so the cut's words decide (fill.ts unknownCut).
    const m = new ScreenModel();
    m.apply(snap([text("o0", "Locker: L99")], { at: 500, windowId: "note-2", title: "O", app: NOTES }));
    m.apply(snap(Array.from({ length: 80 }, (_, i) => text(`n${i}`, `Locker: L${String(i + 1).padStart(2, "0")}`)), { at: 1000, windowId: "note-1", title: "N", app: NOTES }));
    m.apply(snap([field(key("Locker"), "", { label: "Locker", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    // Left out silently as the least recent, the older note's L99 was never weighed, and L01 was written.
    const p = await proposeFill(m, picking({ Locker: "L01" }), FORM, key("Locker"), 3000);
    const f = p.fields.find((x) => x.key === key("Locker"))!;
    expect(f.value).toBeNull();
    expect(f.withheld).toBe("sourceCut");
  });

  it("counts the unread rest of the window the cap stopped in: a note's last line says L81 is the current locker", async () => {
    const m = new ScreenModel();
    const lines = Array.from({ length: 81 }, (_, i) => `Locker: L${String(i + 1).padStart(2, "0")}${i === 80 ? "\nL81 is the current locker; all previous numbers are obsolete." : ""}`);
    m.apply(snap(lines.map((l, i) => text(`n${i}`, l)), { at: 1000, windowId: "note-1", title: "N", app: NOTES }));
    m.apply(snap([field(key("Locker"), "", { label: "Locker", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [new Set(["locker"])] });
    expect(c.candidates).toHaveLength(80);
    expect(c.cut).toEqual(["note-1"]);
    // What the cap left unread is counted as a cut's is: its words and its label's association.
    expect([...c.cutTerms]).toEqual(expect.arrayContaining(["locker", "l81", "current"]));
    expect(c.omitted).toContain(associationKey("note-1", null, "Locker"));
    const p = await proposeFill(m, picking({ Locker: "L01" }), FORM, key("Locker"), 3000);
    const f = p.fields.find((x) => x.key === key("Locker"))!;
    expect(f.value, "L01 is not the only locker the note shows").toBeNull();
    expect(f.withheld).toBe("sourceCut");
  });

  it("does not count a second 'Date: 2026-10-08' as left out: the same value under the same label is offered", async () => {
    const m = new ScreenModel();
    m.apply(snap([node("a", "AXButton", { label: "Date: 2026-10-08" }), node("b", "AXButton", { label: "Date: 2026-10-08" }), node("pad", "AXButton", { label: "Z".repeat(100) })], { at: 1000, windowId: "chat-1", title: "K", app: MESSAGES, values: [{ kind: "date", text: "2026-10-08", nodeKey: "a" }, { kind: "date", text: "2026-10-08", nodeKey: "b" }] }));
    m.apply(snap([field(key("Date"), "", { label: "Date", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [new Set(["date", kindTerm("date")])] });
    expect([...c.omitted]).toEqual([]);
    const p = await proposeFill(m, picking({ Date: "2026-10-08" }), FORM, key("Date"), 3000);
    expect(p.fields.find((x) => x.key === key("Date"))?.value).toBe("2026-10-08");
  });

  it("omits a chat's typed 'Date' value a newer note offered as 'Other': October 8 is not the only Date value", async () => {
    const m = new ScreenModel();
    m.apply(snap([node("a", "AXButton", { label: "Date: 2026-10-08" }), node("b", "AXButton", { label: "Date: 2026-10-09" }), node("pad", "AXButton", { label: "Z".repeat(100) })], { at: 1000, windowId: "chat-1", title: "K", app: MESSAGES, values: [{ kind: "date", text: "2026-10-08", nodeKey: "a" }, { kind: "date", text: "2026-10-09", nodeKey: "b" }] }));
    m.apply(snap([text("n0", "Other: 2026-10-09")], { at: 1500, windowId: "note-1", title: "N", app: NOTES }));
    m.apply(snap([field(key("Date"), "", { label: "Date", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const p = await proposeFill(m, picking({ Date: "2026-10-08" }), FORM, key("Date"), 3000);
    const f = p.fields.find((x) => x.key === key("Date"))!;
    expect(f.value).toBeNull();
    expect(f.withheld).toBe("sourceCut");
  });

  it("keeps a chat's 'Ref' association whose text a newer note offered: AB01 is not the only Ref value", async () => {
    const m = new ScreenModel();
    m.apply(snap([text("c0", "Ref: AB01"), text("c1", "Ref: AB02")], { at: 1000, windowId: "chat-1", title: "K", app: MESSAGES }));
    m.apply(snap([text("n0", "Other: AB02")], { at: 1500, windowId: "note-1", title: "N", app: NOTES }));
    m.apply(snap([field(key("Reference"), "", { label: "Reference", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const p = await proposeFill(m, picking({ Reference: "AB01" }), FORM, key("Reference"), 3000);
    const f = p.fields.find((x) => x.key === key("Reference"))!;
    expect(f.value, "the chat's other Ref value was offered only as the note's 'Other'").toBeNull();
    expect(f.withheld).toBe("sourceCut");
  });

  it("omits at collection a name its line does not spell, rather than failing the fill when the request is built", async () => {
    const m = desk([text("c0", "From: Dana (Whitfield) <dana@example.com>"), text("c1", "see you then")], ["Full name"]);
    const p = await proposeFill(m, picking({ "Full name": "Dana Whitfield" }), FORM, key("Full name"), 3000);
    expect(p.fields.find((x) => x.key === key("Full name"))?.value).not.toBe("Dana Whitfield");
  });

  it("keeps a value's ranges across an identical refresh of its window during the fill: 'Austin' is still verified", async () => {
    const line = `Address: 123 Main St, Austin, TX 78701 ${"Z".repeat(80)}`;
    const m = new ScreenModel();
    const chat = (at: number): void => void m.apply(snap([text("c0", line)], { at, windowId: "chat-1", title: "Kofi", app: MESSAGES, values: [{ kind: "address", text: "123 Main St, Austin, TX 78701", nodeKey: "c0" }] }));
    chat(1000);
    m.apply(snap([field(key("City"), "", { label: "City", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const pick = picking({ City: "Austin" });
    let refreshed = false;
    const ask: AskJev = async (req) => {
      if (!refreshed) {
        refreshed = true;
        chat(2500);
      }
      return pick(req);
    };
    const p = await proposeFill(m, ask, FORM, key("City"), 3000, { whose: false });
    expect(p.fields.find((x) => x.key === key("City"))?.value).toBe("Austin");
  });

  it("does not count a Backup 'Ref' cut against a Primary 'Ref': they are other associations", async () => {
    // T = 1 + 7 + 9 + 6 + 9 + 11 = 43, limit 21: AB01 with its label, section and the title is 15; AB02's 13 more do not fit.
    const m = desk(
      [node("g0", "AXGroup", { label: "Primary" }), text("c0", "Ref: AB01", undefined, "g0"), node("g1", "AXGroup", { label: "Backup" }), text("c1", "Ref: AB02", undefined, "g1"), { key: "c2", parent: null, role: "AXButton", label: "ZZZZZZZZZZZ" }],
      ["Reference"],
    );
    const p = await proposeFill(m, picking({ Reference: "AB01" }), FORM, key("Reference"), 3000);
    expect(p.fields.find((x) => x.key === key("Reference"))?.value).toBe("AB01");
  });
});

describe("value settlement's wording, reserved when settlement decides to ask", () => {
  it("does not lose the settlement request at seal to a chat line its task sentence holds: 'evidence'", async () => {
    // T = 1 + 9 + 8 = 18, limit 8: AB01, its label and the title take 8. VALUE_TASK holds "evidence", the chat's other line.
    const m = desk([text("c0", "Ref: AB01"), text("c1", "evidence")], ["Reference"]);
    const scope: FillScope = { fields: [key("Reference")], windows: null, memory: false, instruction: "put the ref in", person: null, literals: new Map() };
    // The base question's two wordings disagree (AB01 against none), so the field goes on to value settlement.
    const seen: JevRequest[] = [];
    // Each request is sealed as the Jev client seals it (jev.ts sealRequest), so the seal's measure applies.
    const ask: AskJev = async (req) => {
      sealRequest(req);
      seen.push(req);
      const answers: Record<string, { choice: string; confidence: number }> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        const hit = Object.entries(q.criteria).find(([, d]) => d?.startsWith('"AB01"') || d?.startsWith('Proposed value: "AB01"'))?.[0];
        const second = String(q.instructions).startsWith("Instruction from the user:");
        answers[id] = { choice: second ? "none" : (hit ?? "none"), confidence: 0.95 };
      }
      return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    const p = await proposeFill(m, ask, FORM, key("Reference"), 3000, { scope, whose: false });
    expect(seen.filter((r) => r.purpose === "fill.values").length, "the base question's two wordings were asked").toBeGreaterThanOrEqual(2);
    expect(p.jev.model, "settlement was not refused at seal").not.toMatch(/value settlement unavailable/u);
    // Settlement's wording does not fit beside AB01 in the chat, so it is not asked: the field stays as the base left it.
    expect(seen.filter((r) => r.purpose === "fill.values").length, "no settlement request").toBe(2);
    expect(p.fields.find((x) => x.key === key("Reference"))?.withheld).toBe("disagree");
  });
});

describe("one admission path for every value settlement request", () => {
  const scoped = (label: string): FillScope => ({ fields: [key(label)], windows: null, memory: false, instruction: "put the value in", person: null, literals: new Map() });
  /**
   * A Jev that seals each request as the client does and records its purpose, or the seal's refusal. Unless `agree`, the
   * base question's second wording answers none, so a field goes on to settlement; settlement's wordings and the verifier
   * answer as told.
   */
  function sealingPicker(want: string, o: { verifyLow?: boolean; agree?: boolean; seen: { purpose: string; refused?: string }[] }): AskJev {
    return async (req) => {
      try {
        sealRequest(req);
        o.seen.push({ purpose: req.purpose ?? "" });
      } catch (e) {
        o.seen.push({ purpose: req.purpose ?? "", refused: e instanceof Error ? e.message : String(e) });
        throw e;
      }
      const answers: Record<string, { choice: string; confidence: number }> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        if (req.purpose === "fill.verify") {
          answers[id] = { choice: "exact", confidence: o.verifyLow === true ? 0.1 : 0.99 };
          continue;
        }
        const hit = Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`) || d?.startsWith(`Proposed value: "${want}"`))?.[0];
        const second = String(q.instructions).startsWith("Instruction from the user:");
        answers[id] = { choice: second && o.agree !== true ? "none" : (hit ?? Object.keys(q.criteria).find((k) => k !== "none" && !k.includes("_")) ?? "none"), confidence: 0.99 };
      }
      return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
  }

  it("admits settlement by the wording it sends: 'rewritten' in a derivation's sentence keeps it from being asked, not refused at seal", async () => {
    // T = 1 + 17 + 9 + 10 = 37, limit 18. The resolved date's derivation says "rewritten", the chat's other line.
    const m = desk([text("c0", "Date: Oct 8, 2026"), node("word", "AXButton", { label: "rewritten" }), node("pad", "AXButton", { label: "Z".repeat(10) })], []);
    m.apply(snap([field(key("Date"), "", { label: "Date", role: "AXDateField", subrole: "CaretDateInput", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const seen: { purpose: string; refused?: string }[] = [];
    const p = await proposeFill(m, sealingPicker("2026-10-08", { seen }), FORM, key("Date"), 3000, { scope: scoped("Date"), whose: false });
    expect(seen.filter((r) => r.refused !== undefined), "no request is refused at seal").toEqual([]);
    expect(p.jev.model).not.toMatch(/value settlement unavailable/u);
    expect(p.fields.find((x) => x.key === key("Date"))?.withheld).toBe("disagree");
  });

  it("does not hold settlement back for a branch it does not send: a chat line 'source_notes' with no unit to name", async () => {
    // T = 1 + 9 + 12 = 22, limit 10. No option names a whole unit, so the request has no source_notes.
    const m = desk([text("c0", "Ref: AB01"), node("pad", "AXButton", { label: "source_notes" })], ["Reference"]);
    const seen: { purpose: string; refused?: string }[] = [];
    const p = await proposeFill(m, sealingPicker("AB01", { seen }), FORM, key("Reference"), 3000, { scope: scoped("Reference"), whose: false });
    expect(seen.filter((r) => r.purpose === "fill.values").length, "the base question and settlement").toBe(4);
    expect(seen.filter((r) => r.refused !== undefined)).toEqual([]);
    expect(p.fields.find((x) => x.key === key("Reference"))?.value).toBe("AB01");
  });

  it("lets the base's answer stand when settlement's request cannot be built: a 624-character URL is over a slot's length", async () => {
    const url = `https://example.com/${"a".repeat(604)}`;
    const m = new ScreenModel();
    m.apply(snap([text("u", `Website: ${url}`)], { at: 1000, windowId: "note-1", title: "N", app: NOTES }));
    m.apply(snap([field(key("Website"), "", { label: "Website", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const seen: { purpose: string; refused?: string }[] = [];
    const p = await proposeFill(m, sealingPicker(url, { seen }), FORM, key("Website"), 3000, { scope: scoped("Website"), whose: false });
    expect(seen.filter((r) => r.refused !== undefined)).toEqual([]);
    expect(p.fields.find((x) => x.key === key("Website"))?.withheld, "as the base's two wordings left it").toBe("disagree");
  });

  it("does not offer a value for clarification whose settlement request cannot be sent: 'necessarily' in its task", async () => {
    // T = 1 + 9 + 11 = 21, limit 10. The verifier calls AB01 exact under its cutoff; asking again would carry
    // VALUE_TASK, which holds the chat's other line, past the limit.
    const m = desk([text("c0", "Ref: AB01"), node("pad", "AXButton", { label: "necessarily" })], ["Reference"]);
    const seen: { purpose: string; refused?: string }[] = [];
    const ask = sealingPicker("AB01", { seen, verifyLow: true, agree: true });
    setTestVerifier(ask);
    const p = await proposeFill(m, ask, FORM, key("Reference"), 3000, { scope: scoped("Reference"), whose: false }).finally(() => setTestVerifier(STAND_IN));
    expect(p.fields.find((x) => x.key === key("Reference"))?.withheld).toBe("notExact");
    const vs = valueSettlementOf(p);
    expect(vs?.unresolved.map((u) => u.options.map((o) => o.value)), "eligible, before admission").toEqual([["AB01"]]);
    expect(vs?.unresolved.map((u) => vs.sendable(u)), "no pick is offered that could not be asked").toEqual([null]);
    expect(seen.filter((r) => r.refused !== undefined)).toEqual([]);
  });
});
