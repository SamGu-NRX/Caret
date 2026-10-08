// A long conversation is listed newest first, within its share of the generator's visits, and what was listed is ranked;
// the older part left unlisted is read for what it may hold, as any unread text is (candidates.ts unreadRest), so it cuts
// the words, kinds and names it holds. Listing the whole of a 300-message chat ran past the visit cap before anything was
// ranked, and every field was withheld. Every name and value is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { collectCandidates } from "../src/fill/candidates.ts";
import { fieldTerms } from "../src/fill/kinds.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";
import { proposeFill } from "../src/fill/fill.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { field, snap, text } from "./builders.ts";

const MESSAGES = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
const FORM_APP = { pid: 5150, bundleId: "dev.caret.fixture", name: "Fixture" };
const FORM = "5150-7";
const key = (label: string): string => `dev.caret.fixture/standard/textfield:${label.toLowerCase().replace(/ /g, "-")}~0`;
const CHATTER = ["haha yes", "ok sounds good", "on my way", "can't make it tonight sorry", "let me check and get back to you", "who's bringing snacks", "great, see you then"];

/** A chat of `n` messages, `answer` placed `at` (counted from the oldest), then a form with `labels`. */
function desk(n: number, answer: string[], at: number, labels: string[]): ScreenModel {
  const lines = Array.from({ length: n - answer.length }, (_, i) => CHATTER[i % CHATTER.length]!);
  lines.splice(at, 0, ...answer);
  const m = new ScreenModel();
  m.apply(snap(lines.map((l, i) => text(`m${i}`, l)), { at: 1000, windowId: "chat-1", title: "Sam Ortiz", app: MESSAGES }));
  m.apply(snap(labels.map((l, i) => field(key(l), "", { label: l, frame: [100, 40 + i * 40, 300, 24] })), { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
  return m;
}
/** Picks the option whose description starts with the value `want` names for the field. */
const picking = (want: Record<string, string>): AskJev => async (req) => ({
  model: "jev-test",
  answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => {
    if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user", confidence: 0.95 }];
    const label = Object.keys(want).find((l) => String(q.instructions).includes(`'${l}'`));
    const hit = label === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want[label]}"`))?.[0];
    return [id, { choice: hit ?? "none", confidence: 0.95 }];
  })),
  inputTokens: 1, latencyMs: 1, costUsd: 0,
});

describe("a long conversation, listed newest first", () => {
  it("offers a 300-message chat's recent answer, and reads its older part as unread, not as unknown", () => {
    const m = desk(300, ["Booking ref: QX7-4410"], 294, ["Booking ref"]);
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [fieldTerms(["Booking ref"])] });
    expect(c.candidates.map((x) => x.text)).toContain("QX7-4410");
    expect(c.cutAll, "the older part was read for what it holds").toBe(false);
    expect(c.cut, "the chat was not listed whole").toContain("chat-1");
    expect(c.stats.overBudget).toBe(false);
  });

  it("fills a field from a 300-message chat's recent part", async () => {
    const m = desk(300, ["Booking ref: QX7-4410"], 294, ["Booking ref"]);
    const p = await proposeFill(m, picking({ "Booking ref": "QX7-4410" }), FORM, key("Booking ref"), 3000, { whose: false });
    expect(p.fields.find((f) => f.key === key("Booking ref"))?.value).toBe("QX7-4410");
  });

  it("withholds a field whose label words the unlisted older part holds: an old 'Booking ref' line is a cut", async () => {
    // The answer is in the old part, so it is not listed; its line's words are cut, and Booking ref is withheld.
    const m = desk(1000, ["Booking ref: QX7-4410"], 5, ["Booking ref"]);
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [fieldTerms(["Booking ref"])] });
    expect(c.candidates.map((x) => x.text)).not.toContain("QX7-4410");
    expect(c.cutAll).toBe(false);
    expect([...c.cutTerms]).toEqual(expect.arrayContaining(["booking", "ref"]));
    const p = await proposeFill(m, picking({ "Booking ref": "QX7-4410" }), FORM, key("Booking ref"), 3000, { whose: false });
    const f = p.fields.find((x) => x.key === key("Booking ref"))!;
    expect([f.value, f.withheld]).toEqual([null, "sourceCut"]);
  });
});
