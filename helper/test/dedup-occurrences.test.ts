// Deduplication merges a value's occurrences and never discards them: a candidate carries every other line of its window
// that holds its exact value, as evidence for the value questions and the verifier, each minted where it was read. When
// the ledger cannot admit them all, the candidate is withheld. Every name and value is invented.
import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { collectCandidates } from "../src/fill/candidates.ts";
import { fieldTerms } from "../src/fill/kinds.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { provenanceStale, setTestVerifier } from "../src/fill/contract.ts";
import { candidateProvenance } from "../src/fill/fill.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { field, snap, text } from "./builders.ts";
import { STAND_IN } from "./setup/verifier.ts";

const NOTES = { pid: 4242, bundleId: "com.apple.Notes", name: "Notes" };
const MESSAGES = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
const FORM_APP = { pid: 5150, bundleId: "dev.caret.fixture", name: "Fixture" };
const FORM = "5150-7";
const key = (label: string): string => `dev.caret.fixture/standard/textfield:${label.toLowerCase().replace(/ /g, "-")}~0`;
const WARNING = "Do not use this booking ref: QX7-4410";

afterEach(() => setTestVerifier(STAND_IN));

/** A source window of `lines`, one node each, then a form with a Booking ref field. */
function desk(lines: string[], app = NOTES): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap(lines.map((l, i) => text(`n${i}`, l)), { at: 1000, windowId: "src-1", title: "Trip", app }));
  m.apply(snap([field(key("Booking ref"), "", { label: "Booking ref", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
  return m;
}
const SEATS = Array.from({ length: 10 }, (_, i) => `Seat ${i}: row ${i} by the window with a long description of the cabin and the meal plan ${i}`);

/** Picks QX7-4410 for Booking ref, and keeps every request's text, by whether the verifier or fill asked it. */
function recording(): { jev: AskJev; asked: string[]; verified: string[] } {
  const asked: string[] = [];
  const verified: string[] = [];
  setTestVerifier(async (req) => {
    verified.push(JSON.stringify(req));
    return STAND_IN(req);
  });
  const jev: AskJev = async (req) => {
    asked.push(JSON.stringify(req));
    return {
      model: "jev-test",
      answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => {
        if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user", confidence: 0.95 }];
        const hit = Object.entries(q.criteria).find(([, d]) => d?.startsWith('"QX7-4410"'))?.[0];
        return [id, { choice: hit ?? "none", confidence: 0.95 }];
      })),
      inputTokens: 1, latencyMs: 1, costUsd: 0,
    };
  };
  return { jev, asked, verified };
}

describe("a value's other lines in its window", () => {
  it("carries a later 'Do not use this booking ref: QX7-4410' with QX7-4410 to the value question and the verifier", async () => {
    const m = desk(["Booking ref: QX7-4410", ...SEATS, WARNING]);
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [fieldTerms(["Booking ref"])] }).candidates.find((x) => x.text === "QX7-4410");
    expect(c?.also).toEqual([WARNING]);
    const r = recording();
    await proposeFill(m, r.jev, FORM, key("Booking ref"), 3000, { whose: false });
    expect(r.asked.some((q) => q.includes(WARNING)), "the value question shows the warning").toBe(true);
    expect(r.verified.some((q) => q.includes(WARNING)), "the verifier shows the warning").toBe(true);
  });

  it("still fills a value whose other line is neutral, and carries a repeat of its own line once", async () => {
    const m = desk(["Booking ref: QX7-4410", ...SEATS, "Confirmation QX7-4410 was mailed to you", "Booking ref: QX7-4410"]);
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [fieldTerms(["Booking ref"])] }).candidates.find((x) => x.text === "QX7-4410");
    expect(c?.also).toEqual(["Confirmation QX7-4410 was mailed to you"]);
    const r = recording();
    const p = await proposeFill(m, r.jev, FORM, key("Booking ref"), 3000, { whose: false });
    expect(p.fields.find((f) => f.key === key("Booking ref"))?.value).toBe("QX7-4410");
  });

  it("withholds a value whose other lines the ledger cannot admit with it: a chat's limit holds its line, not its warning too", async () => {
    // T = 5 + 21 + 61 + 2 + 2 = 91, limit 45: the value's own line fits, with the warning it does not.
    const m = desk(["Booking ref: QX7-4410", "Do not use QX7-4410, that booking was cancelled last week", "ok", "ok"], MESSAGES);
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [fieldTerms(["Booking ref"])] });
    expect(c.candidates.map((x) => x.text)).not.toContain("QX7-4410");
    const p = await proposeFill(m, recording().jev, FORM, key("Booking ref"), 3000, { whose: false });
    const f = p.fields.find((x) => x.key === key("Booking ref"))!;
    expect([f.value, f.withheld]).toEqual([null, "sourceCut"]);
  });
});

describe("what a candidate withheld for its other lines costs", () => {
  it("withholds a field of its kind, not an unrelated one: a bystander chat's withheld Thursday leaves Email and Locker filled", async () => {
    // The chat's limit holds "Thursday" on its own line, not with its two other lines; the line's other words ("email")
    // are no evidence about the email the note gives.
    const m = new ScreenModel();
    m.apply(snap([text("c0", "Thursday works, I'll email the review notes"), text("c1", "Could we move Thursday's review to 2:30 PM?"), text("c2", "Thursday is the only day the room is free"), text("c3", "ok")], { at: 500, windowId: "chat-1", title: "Kofi", app: MESSAGES, values: [{ kind: "date", text: "Thursday", nodeKey: "c0" }] }));
    m.apply(snap([text("n0", "Email: jordan.reyes@example.org"), text("n1", "Locker: L12")], { at: 1000, windowId: "note-1", title: "Me", app: NOTES }));
    // The user just left a window with no values, so no window answers on its own (fill.ts anchor) and every cut rule applies.
    m.apply(snap([{ key: "b0", parent: null, role: "AXButton", label: "Done" }], { at: 1500, windowId: "blank-1", title: "Blank", app: NOTES, focused: true }));
    m.apply(snap([field(key("Email"), "", { label: "Email", frame: [100, 40, 300, 24] }), field(key("Meeting date"), "", { label: "Meeting date", frame: [100, 80, 300, 24] }), field(key("Locker"), "", { label: "Locker", frame: [100, 120, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [fieldTerms(["Email"]), fieldTerms(["Meeting date"]), fieldTerms(["Locker"])] });
    expect(c.candidates.map((x) => x.text)).not.toContain("Thursday");
    expect(c.cut, "the chat is not cut whole").not.toContain("chat-1");
    expect([...c.cutKinds]).toContain("date");
    const WANT: Record<string, string> = { Email: "jordan.reyes@example.org", Locker: "L12", "Meeting date": "Thursday" };
    const jev: AskJev = async (req) => ({
      model: "jev-test",
      answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => {
        const want = Object.entries(WANT).find(([l]) => String(q.instructions).includes(`'${l}'`))?.[1];
        return [id, { choice: Object.entries(q.criteria).find(([, d]) => want !== undefined && d?.startsWith(`"${want}"`))?.[0] ?? "none", confidence: 0.95 }];
      })),
      inputTokens: 1, latencyMs: 1, costUsd: 0,
    });
    const p = await proposeFill(m, jev, FORM, key("Email"), 3000, { whose: false });
    expect(p.fields.find((f) => f.key === key("Email"))?.value).toBe("jordan.reyes@example.org");
    // A field that names no kind is not withheld for it either: the kept-out value is no cut window.
    expect(p.fields.find((f) => f.key === key("Locker"))?.value).toBe("L12");
    // A field of its kind still withholds: a date the chat holds was kept out.
    expect(p.fields.find((f) => f.key === key("Meeting date"))?.withheld).toBe("sourceCut");
  });
});

describe("the recheck before a write", () => {
  it("refuses a value whose other line changed since it was judged: the warning edited away", () => {
    const m = desk(["Booking ref: QX7-4410", ...SEATS, WARNING]);
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [fieldTerms(["Booking ref"])] }).candidates.find((x) => x.text === "QX7-4410")!;
    const pr = candidateProvenance(m, c);
    expect(provenanceStale(m, pr)).toBeNull();
    m.apply(snap(["Booking ref: QX7-4410", ...SEATS, "Use this booking ref: QX7-4410"].map((l, i) => text(`n${i}`, l)), { at: 4000, windowId: "src-1", title: "Trip", app: NOTES }));
    expect(provenanceStale(m, pr)).not.toBeNull();
  });

  it("refuses a value a new line of its window holds since it was judged", () => {
    const m = desk(["Booking ref: QX7-4410", ...SEATS]);
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [fieldTerms(["Booking ref"])] }).candidates.find((x) => x.text === "QX7-4410")!;
    const pr = candidateProvenance(m, c);
    m.apply(snap(["Booking ref: QX7-4410", ...SEATS, WARNING].map((l, i) => text(`n${i}`, l)), { at: 4000, windowId: "src-1", title: "Trip", app: NOTES }));
    expect(provenanceStale(m, pr)).not.toBeNull();
  });
});
