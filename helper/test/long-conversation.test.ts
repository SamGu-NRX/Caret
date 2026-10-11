// A long conversation is listed newest first, within its share of the generator's visits, and what was listed is ranked;
// the older part left unlisted is read for what it may hold, as any unread text is (candidates.ts unreadRest), so it cuts
// the words, kinds and names it holds. Listing the whole of a 300-message chat ran past the visit cap before anything was
// ranked, and every field was withheld. Every name and value is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { messageOrder } from "../src/conversation.ts";
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

describe("what an unlisted line holds, accounted before any value of it is deduplicated", () => {
  it("cuts the words of an unlisted 'Do not use this booking ref: QX7-4410', though QX7-4410 is offered from a newer line", async () => {
    const lines = Array.from({ length: 300 }, () => "haha yes");
    lines[149] = "Do not use this booking ref: QX7-4410";
    lines[294] = "Booking ref: QX7-4410";
    const m = new ScreenModel();
    m.apply(snap(lines.map((l, i) => text(`m${i}`, l)), { at: 1000, windowId: "chat-1", title: "Sam Ortiz", app: MESSAGES }));
    m.apply(snap([field(key("Booking ref"), "", { label: "Booking ref", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [fieldTerms(["Booking ref"])] });
    expect([...c.cutTerms]).toEqual(expect.arrayContaining(["booking", "ref"]));
    const p = await proposeFill(m, picking({ "Booking ref": "QX7-4410" }), FORM, key("Booking ref"), 3000, { whose: false });
    const f = p.fields.find((x) => x.key === key("Booking ref"))!;
    expect([f.value, f.withheld]).toEqual([null, "sourceCut"]);
  });

  it("cuts the kinds of an unlisted line past the typed-value scan: a cancelled Jan 5 withholds Meeting date", async () => {
    // One node of 601 padding lines that ends with the cancellation, then the meeting date.
    const long = [...Array.from({ length: 601 }, () => "lorem ipsum dolor sit amet"), "Jan 5, 2027 was cancelled; use Jan 4, 2027 instead."].join("\n");
    const m = new ScreenModel();
    m.apply(snap([text("m0", long), text("m1", "Meeting date: Jan 5, 2027")], { at: 1000, windowId: "chat-1", title: "Sam Ortiz", app: MESSAGES, values: [{ kind: "date", text: "Jan 5, 2027", nodeKey: "m1" }] }));
    m.apply(snap([field(key("Meeting date"), "", { label: "Meeting date", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [fieldTerms(["Meeting date"])] });
    expect([...c.cutKinds], "one set of cut kinds, which the field and pick checks read").toContain("date");
    const p = await proposeFill(m, picking({ "Meeting date": "Jan 5, 2027" }), FORM, key("Meeting date"), 3000, { whose: false });
    const f = p.fields.find((x) => x.key === key("Meeting date"))!;
    expect([f.value, f.handoff?.value ?? null, f.withheld]).toEqual([null, null, "sourceCut"]);
  });
});

describe("the order a conversation's messages run in (conversation.ts messageOrder)", () => {
  const OUTLOOK = { pid: 8282, bundleId: "com.microsoft.Outlook", name: "Microsoft Outlook" };
  const MAIL = { pid: 8383, bundleId: "com.apple.mail", name: "Mail" };
  const CHROME = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
  const day = (k: number): string => new Date(Date.UTC(2026, 6, 1 + k)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  /** A thread of `n` messages of six lines each, oldest first or newest first in the tree, `answer` in the newest. */
  const thread = (n: number, newestFirst: boolean, answer: string[], dated = true): string[] => {
    const messages = Array.from({ length: n }, (_, k) => [`From: Sam Ortiz <sam.ortiz@example.com>`, ...(dated ? [`Date: ${day(k)}`] : []), ...(k === n - 1 ? answer : []), ...Array.from({ length: 4 }, (_, i) => CHATTER[(k + i) % CHATTER.length]!)]);
    return (newestFirst ? messages.reverse() : messages).flat();
  };
  const window = (lines: string[], title: string, app: { pid: number; bundleId: string; name: string }, labels: string[]): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap(lines.map((l, i) => text(`m${i}`, l)), { at: 1000, windowId: "thread-1", title, app }));
    m.apply(snap(labels.map((l, i) => field(key(l), "", { label: l, frame: [100, 40 + i * 40, 300, 24] })), { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    return m;
  };

  it("reads the order from the thread's own dates first, then from the app, and says unknown otherwise", () => {
    const of = (m: ScreenModel): string => messageOrder(m.windows.get("thread-1")!);
    expect(of(window(thread(3, true, []), "Re: Booking - Outlook", OUTLOOK, []))).toBe("newestFirst");
    expect(of(window(thread(3, false, []), "Re: Booking - Mail - Google Chrome", CHROME, []))).toBe("oldestFirst");
    expect(of(window(["haha yes", "on my way"], "Sam Ortiz", MESSAGES, []))).toBe("oldestFirst");
    expect(of(window(thread(3, false, [], false), "Re: Booking", MAIL, [])), "Mail can show the newest message at the top").toBe("unknown");
    expect(of(window(["Inbox", "Sam Ortiz", "Re: Booking"], "Inbox (3) - jordan@example.org - Gmail", CHROME, [])), "a Gmail tab can be the inbox, newest first").toBe("unknown");
  });

  it("fills from the newest message of a thread drawn newest first, which is the top of its tree", async () => {
    const m = window(thread(60, true, ["Booking ref: QX7-4410"]), "Re: Booking - Outlook", OUTLOOK, ["Booking ref"]);
    const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [fieldTerms(["Booking ref"])] });
    expect(c.candidates.map((x) => x.text)).toContain("QX7-4410");
    expect(c.cut, "the thread was not listed whole").toContain("thread-1");
    const p = await proposeFill(m, picking({ "Booking ref": "QX7-4410" }), FORM, key("Booking ref"), 3000, { whose: false });
    expect(p.fields.find((f) => f.key === key("Booking ref"))?.value).toBe("QX7-4410");
  });

  it("lists both ends of a thread whose order is unknown, so its newest message is listed either way", () => {
    for (const newestFirst of [true, false]) {
      const m = window(thread(60, newestFirst, ["Booking ref: QX7-4410"], false), "Re: Booking", MAIL, ["Booking ref"]);
      const c = collectCandidates(m, FORM, { now: 3000, ledger: new Disclosure(m), fields: [fieldTerms(["Booking ref"])] });
      expect(c.candidates.map((x) => x.text), newestFirst ? "newest at the top" : "newest at the bottom").toContain("QX7-4410");
      expect(c.cutAll).toBe(false);
    }
  });
});
