// Deduplication merges a value's occurrences and never discards them: a candidate carries every other line of its window
// that holds its exact value, as evidence for the value questions and the verifier, each minted where it was read. When
// the ledger cannot admit them all, the candidate is withheld. Every name and value is invented.
import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { collectCandidates } from "../src/fill/candidates.ts";
import { fieldTerms } from "../src/fill/kinds.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
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
