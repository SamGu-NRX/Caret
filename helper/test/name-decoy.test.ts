// A conversation's budget can cut a plain line that is a name, with nothing typed about it, while a
// plain decoy name sits in another window. B13 left this open: a field whose label names no kind was
// asked unless the cut conversation left out a line sharing its label words, and "Dana Whitfield" shares
// none with "Name". The Jev here picks the right name when it is offered and any other name when it is
// not, as live Jev picked another window's name for Name in B13's review. All text is synthetic.
import { Disclosure } from "../src/privacy/disclosure.ts";
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { collectCandidates } from "../src/fill/candidates.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { fieldTerms, isNameLike, namesIn } from "../src/fill/kinds.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { field, snap, text, value } from "./builders.ts";
import { FORM_KEY, MESSAGES, SCHEDULE_FORM as FORM, scheduleForm } from "./desks.ts";

const CHAT = "8181-9";
const NOTES = "6161-9";
const RIGHT = "Dana Whitfield";
const DECOY = "Priya Raman";

/** The right name when offered, else any other two-word name offered, else none; both asks alike. */
const nameProneJev = (asked: JevRequest[] = []): AskJev => async (req) => {
  asked.push(req);
  const answers: Record<string, { choice: string; confidence: number }> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    const offered = Object.entries(q.criteria).filter(([, d]) => d !== null);
    const hit = offered.find(([, d]) => d?.startsWith(`"${RIGHT}"`)) ?? offered.find(([, d]) => /^"\p{Lu}\p{Ll}+ \p{Lu}\p{Ll}+"/u.test(String(d)));
    answers[id] = { choice: hit?.[0] ?? "none", confidence: 0.9 };
  }
  return { model: "jev-test", answers, inputTokens: 1000, latencyMs: 5, costUsd: 0.000042 };
};

/**
 * A Messages thread longer than its budget holds, whose one name comes after twenty lines of chatter;
 * a notes window that is not a conversation with a decoy name; and a form asking for a Name.
 * `names` more name lines go in the thread too.
 */
function screen(labels: readonly string[], names: readonly string[] = []): ScreenModel {
  const chatter = Array.from({ length: 20 }, (_, i) => `the venue deposit is still pending, item ${i}`);
  const lines = [...chatter, RIGHT, ...names, "see you all there"];
  const m = new ScreenModel();
  m.apply(snap([text("notes/0", DECOY), text("notes/1", "pick up the badges")], { at: 500, windowId: NOTES, title: "Notes", app: { pid: 6161, bundleId: "dev.caret.notes", name: "Notes" } }));
  m.apply(snap(lines.map((l, i) => text(`chat/${i}`, l)), { at: 1000, windowId: CHAT, title: "Kofi", app: MESSAGES, focused: true }));
  m.apply(scheduleForm(2000, labels));
  return m;
}

describe("a cut conversation's plain name never leaves a decoy name", () => {
  it("B13's rule fills Name with the decoy: the chat's name is cut and the notes' name offered", async () => {
    const p = await proposeFill(screen(["Name"]), nameProneJev(), FORM, FORM_KEY("Name"), 3000, { nameGroup: false });
    expect(p.fields[0]?.value).toBe(DECOY);
  });

  it("offers the conversation's names whole, so Jev can pick the right one", async () => {
    const m = screen(["Name"]);
    const ledger = new Disclosure(m);
    const { candidates } = collectCandidates(m, FORM, { now: 3000, ledger, fields: [fieldTerms(["Name"])] });
    expect(candidates.map((c) => c.text)).toContain(RIGHT);
    const p = await proposeFill(screen(["Name"]), nameProneJev(), FORM, FORM_KEY("Name"), 3000);
    expect(p.fields[0]).toMatchObject({ value: RIGHT, withheld: null });
  });

  it("withholds Name when the conversation's names do not all fit, and asks nothing about it", async () => {
    // Forty names cannot all fit the chat's budget, so none goes in, and Name is not asked.
    const many = Array.from({ length: 40 }, (_, i) => `Guest Number${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} Okafor`);
    const asked: JevRequest[] = [];
    const m = screen(["Name", "Notes"], many);
    const p = await proposeFill(m, nameProneJev(asked), FORM, FORM_KEY("Name"), 3000);
    const name = p.fields.find((f) => f.key === FORM_KEY("Name"));
    expect(name).toMatchObject({ value: null, withheld: "sourceCut", asks: [] });
    for (const r of asked) for (const q of Object.values(r.questions)) expect(String(q.instructions)).not.toContain("'Name'");
    // None of the chat's names was offered, and the decoy was not filled anywhere.
    expect(p.fields.some((f) => f.value === DECOY)).toBe(false);
  });

  it("leaves a field that wants no name to the rules it had", async () => {
    // The chat's names are cut; a Notes field shares no word with them and wants no name.
    const many = Array.from({ length: 40 }, (_, i) => `Guest Number${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} Okafor`);
    const p = await proposeFill(screen(["Notes"], many), nameProneJev(), FORM, FORM_KEY("Notes"), 3000);
    expect(p.fields[0]?.withheld).not.toBe("sourceCut");
  });
});

describe("a name the shape test misses is still a name when it is cut (B14 review)", () => {
  const notes = (m: ScreenModel, lines: readonly string[]): void => {
    m.apply(snap(lines.map((l, i) => text(`notes/${i}`, l)), { at: 500, windowId: NOTES, title: "Notes", app: { pid: 6161, bundleId: "dev.caret.notes", name: "Notes" } }));
  };
  const chatter = Array.from({ length: 20 }, (_, i) => `the venue deposit is still pending, item ${i}`);

  it("counts a source field labelled Name as a name, so it goes in with the names", async () => {
    const m = new ScreenModel();
    notes(m, [DECOY, "pick up the badges"]);
    m.apply(snap([...chatter.map((l, i) => text(`chat/${i}`, l)), field("chat/name", "dana w.", { label: "Name" })], { at: 1000, windowId: CHAT, title: "Kofi", app: MESSAGES, focused: true }));
    m.apply(scheduleForm(2000, ["Name"]));
    // This Jev takes "dana w." when offered, and the decoy otherwise.
    const jev: AskJev = async (req) => {
      const answers: Record<string, { choice: string; confidence: number }> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        const offered = Object.entries(q.criteria);
        const hit = offered.find(([, d]) => d?.startsWith('"dana w."')) ?? offered.find(([, d]) => d?.startsWith(`"${DECOY}"`));
        answers[id] = { choice: hit?.[0] ?? "none", confidence: 0.9 };
      }
      return { model: "jev-test", answers, inputTokens: 1000, latencyMs: 5, costUsd: 0 };
    };
    const p = await proposeFill(m, jev, FORM, FORM_KEY("Name"), 3000);
    expect(p.fields[0]?.value).not.toBe(DECOY);
    expect(p.fields[0]?.value).toBe("dana w.");
  });

  it("withholds Name when cut chat lines hold names beside typed values", async () => {
    const m = new ScreenModel();
    notes(m, [DECOY, "pick up the badges"]);
    // Each line holds a name and a typed email; no line is a name alone, so none is in the names' group.
    const people = Array.from({ length: 30 }, (_, i) => `Guest Number${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} Okafor`);
    const lines = [...chatter, ...people.map((p, i) => `${p} <guest${i}@example.com>`)];
    const values = people.map((_, i) => value("email", `guest${i}@example.com`, `chat/${chatter.length + i}`));
    m.apply(snap(lines.map((l, i) => text(`chat/${i}`, l)), { at: 1000, windowId: CHAT, title: "Kofi", app: MESSAGES, focused: true, values }));
    m.apply(scheduleForm(2000, ["Name"]));
    const p = await proposeFill(m, nameProneJev(), FORM, FORM_KEY("Name"), 3000);
    expect(p.fields[0]).toMatchObject({ value: null, withheld: "sourceCut" });
  });

  it("withholds Name when the cap stops partway through a window, before its names", async () => {
    // Not a conversation. Lines over 80 characters offer nothing but raise its budget, so the
    // 80-candidate cap, not the budget, stops the generator before the right name.
    const m = new ScreenModel();
    const long = Array.from({ length: 12 }, (_, i) => `${"the printer queue log for the badge desk ".repeat(5)}${i}`);
    notes(m, [...long, DECOY, ...Array.from({ length: 90 }, (_, i) => `row ${i}`), RIGHT]);
    m.apply(scheduleForm(2000, ["Name"]));
    const ledger = new Disclosure(m);
    const { candidates, cut, cutAll } = collectCandidates(m, FORM, { now: 3000, ledger, fields: [fieldTerms(["Name"])] });
    expect({ n: candidates.length, cut, cutAll }).toEqual({ n: 80, cut: [NOTES], cutAll: false });
    const p = await proposeFill(m, nameProneJev(), FORM, FORM_KEY("Name"), 3000);
    expect(p.fields[0]?.value).not.toBe(DECOY);
  });
});

describe("name-like lines and fields", () => {
  it.each([
    ["Dana Whitfield", true],
    ["Mary-Jane O'Neil", true],
    ["Lumen Labs", true],
    ["Acme & Sons Ltd.", true],
    ["Senior Product Designer", true],
    ["Head of Operations", true],
    ["Design review", false],
    ["see you all there", false],
    ["Thanks", false],
    ["Room 4B", false],
    ["Dana Whitfield, see you at 3:41 PM", false],
    ["ORD-2026-48213", false],
  ])("%s is name-like: %s", (line, want) => {
    expect(isNameLike(line, null)).toBe(want);
  });

  it.each([
    ["Dana Whitfield <dana@example.com>", ["Dana Whitfield"]],
    ["Design review with Priya Raman", ["Priya Raman"]],
    ["(Head of Operations), from Monday", ["Head of Operations"]],
    ["Kofi Mensah, table 4 is set for Ana de la Cruz", ["Kofi Mensah", "Ana de la Cruz"]],
    ["Thanks Dana", ["Thanks Dana"]],
    ["see you all there", []],
    ["Dana", []],
    ["Room 4B Floor 2", []],
    ["Order ORD-2026-48213 Shipped", []],
    ["the venue deposit is still pending", []],
  ])("%s holds the names %j", (line, want) => {
    expect(namesIn(line)).toEqual(want);
  });

  it("counts a span labelled as a name, whatever its shape", () => {
    expect(isNameLike("dana w.", "Name")).toBe(true);
    expect(isNameLike("VP, people ops", "Job title")).toBe(true);
    expect(isNameLike("pending", "Status")).toBe(false);
  });

  it.each([
    ["Name", true],
    ["Full name", true],
    ["Company", true],
    ["Attendee job title", true],
    ["Organization", true],
    ["Notes", false],
    ["Email", false],
    ["Meeting date", false],
  ])("the field %s wants a name: %s", (label, want) => {
    expect(fieldTerms([label]).has("#name")).toBe(want);
  });
});
