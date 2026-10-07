// C1: fill reads values inside lines. A note line over 80 characters offered nothing, and a short line was offered only
// whole, so "Mobile 555-0164 (no landline anymore)." gave a phone field nothing (evidence/screen/p2 tasks-dev4). Jev is
// a fake that answers by rule; every name, number and address is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { collectCandidates, describeCandidate } from "../src/fill/candidates.ts";
import { proposeFill } from "../src/fill/fill.ts";
import type { JevRequest } from "../src/fill/jev.ts";
import { datePart, splitAddress, splitDate } from "../src/fill/derive.ts";
import { holds } from "./recheck.ts";
import type { Node } from "../src/protocol.ts";
import { field, jevPickingText, snap, text } from "./builders.ts";

const NOTE_APP = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const NOTE_KEY = "com.apple.TextEdit/standard/textarea:~0";
const F = (s: string): string => `dev.caret.fixture/standard/${s}`;
const FORM = "5150-7";

/** A model with a TextEdit note (the window the user just left) and a form whose fields are labelled as given. */
function scene(note: string, labels: string[]): ScreenModel {
  const m = new ScreenModel();
  const noteNode: Node = { key: NOTE_KEY, parent: null, role: "AXTextArea", value: note, editable: true };
  m.apply(snap([noteNode], { at: 1000, windowId: "7001-1", title: "Notes.txt", app: NOTE_APP, focused: true }));
  const fields = labels.map((l, i) => field(F(`field:${i}`), "", { label: l, frame: [100, 100 + i * 40, 200, 24] }));
  m.apply(snap(fields, { at: 2000, windowId: FORM, title: "Application", focused: true }));
  return m;
}

/** Fill's proposed text value for each field, by label, with Jev picking the text `want` maps the field's label to. */
async function fill(note: string, want: Record<string, string>): Promise<{ values: Record<string, string | null>; requests: JevRequest[] }> {
  const labels = Object.keys(want);
  const m = scene(note, labels);
  const requests: JevRequest[] = [];
  const pick = jevPickingText((_id, ins) => {
    const label = labels.find((l) => ins.includes(`'${l}'`));
    return label === undefined ? null : (want[label] ?? null);
  });
  const p = await proposeFill(m, async (req) => (requests.push(req), pick(req)), FORM, F("field:0"), 3000);
  const values = Object.fromEntries(labels.map((l, i) => [l, p.fields.find((f) => f.key === F(`field:${i}`))?.value ?? null]));
  return { values, requests };
}

describe("values inside a note's lines", () => {
  it("fills a phone from a short sentence line, and an email and a date from long lines", async () => {
    const note = [
      "Volunteer signup",
      "Mobile 555-0164 (no landline anymore).",
      "I graduate from UT Austin in May 2027 with a BS in Computer Science, and I could start the week after that.",
      "Reach me at jo.cole@example.org any time after five; weekdays and weekends are both fine with me for calls.",
    ].join("\n");
    const { values } = await fill(note, { "Mobile phone": "555-0164", "Graduation date": "May 2027", Email: "jo.cole@example.org" });
    // HA2: the phone and the email are admitted only by owner questions that showed the whole note; this note's prose
    // lines go to them under the owner-note allotment (privacy.ts OWNER_NOTE_CHARS).
    expect(values).toEqual({ "Mobile phone": "555-0164", "Graduation date": "May 2027", Email: "jo.cole@example.org" });
  });

  it("takes a date's month and year for fields that ask for only that", async () => {
    // A note is held to under half of its long lines' text (privacy.ts prose share), so this one has more of them than the
    // School line, whose spans alone are over half of it.
    const note = [
      "Kestrel Robotics: Embedded Firmware Engineer",
      "Phone: 555-0126",
      "The recruiter said the team is fully remote and that the first round of interviews starts in two weeks.",
      "School: Lakeshore Polytechnic Institute, B.S. Electrical Engineering, September 2016 to May 2020.",
      "Two resumes on the laptop: general.pdf and firmware.pdf.",
    ].join("\n");
    const { values } = await fill(note, { "Start date month": "September", "Start date year": "2016", "End date month": "May", "End date year": "2020", School: "Lakeshore Polytechnic Institute" });
    expect(values).toEqual({ "Start date month": "September", "Start date year": "2016", "End date month": "May", "End date year": "2020", School: "Lakeshore Polytechnic Institute" });
  });

  it("takes a value before its remark, and a place from a sentence", async () => {
    const note = "Preferred first name: Dima (legal name Dmitri Halvorsen).\nMoving to San Diego, California in November and will work from there. San Jose is only until the move.";
    const { values } = await fill(note, { "Preferred first name": "Dima", Location: "San Diego, California" });
    expect(values).toEqual({ "Preferred first name": "Dima", Location: "San Diego, California" });
  });
});

describe("what a value inside a line carries, and what it never offers", () => {
  const candidates = (note: string): ReturnType<typeof collectCandidates>["candidates"] => collectCandidates(scene(note, ["Phone"]), FORM, { now: 3000 }).candidates;

  it("labels only the value a label starts with, and quotes the clause of the other", () => {
    const cs = candidates("- Cell: 555-0147. Don't give out 555-0112, that's Mom and Dad's landline.");
    const cell = cs.find((c) => c.text === "555-0147");
    const landline = cs.find((c) => c.text === "555-0112");
    expect([cell?.context, cell?.labelled, cell?.line ?? null]).toEqual(["Cell", true, null]);
    // The landline's sentence warns, so it goes with that sentence; the cell's own sentence warns of nothing.
    expect([landline?.context, landline?.labelled, landline?.line]).toEqual([null, false, "Don't give out 555-0112, that's Mom and Dad's landline."]);
    expect(describeCandidate(landline as NonNullable<typeof landline>)).toContain("in the line 'Don't give out 555-0112, that's Mom and Dad's landline.'");
  });

  it("offers nothing from a line that shows a card number or is labelled as a secret, however long", () => {
    const cs = candidates(
      "Card on file 4111 1111 1111 1111, and the billing phone for it is 555-0199, which the bank texts each month.\nAPI key: sk-live-abcdefghijklmnopqrstu 555-0123 2026-01-01",
    ).map((c) => c.text);
    expect(cs.filter((t) => /555-01(99|23)|2026-01-01|4111/.test(t))).toEqual([]);
  });

  it("never breaks a list into items", () => {
    const cs = candidates("Languages: English, Spanish").map((c) => c.text);
    expect(cs).toContain("English, Spanish");
    expect(cs).not.toContain("English");
    expect(cs).not.toContain("Spanish");
  });
});

describe("the recheck reads a line the way fill read it", () => {
  const src = (t: string): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap([text("dev.caret.notes/standard/statictext:a~0", t)], { at: 1, windowId: "8-1" }));
    return m;
  };
  const at = { windowId: "8-1", nodeKey: "dev.caret.notes/standard/statictext:a~0" };
  // I1: the recheck is the write contract's (fill/contract.ts provenanceStale): `span` read from `was` beside `context`.
  const held = (was: string, now: string, span: string, context: string | null = null): boolean => holds(src, at, was, now, span, context);
  const SCHOOL = "School: Lakeshore Polytechnic Institute, B.S. Electrical Engineering, September 2016 to May 2020.";
  const GRADUATED = "Graduated in May 2020 from Lakeshore, and the transcript is at home with my parents somewhere.";

  it("holds a date from a long line, unchanged", () => {
    expect(held(SCHOOL, SCHOOL, "May 2020")).toBe(true);
    expect(held(GRADUATED, GRADUATED, "May 2020")).toBe(true);
  });

  it("refuses a line that now has a label naming the value", () => {
    expect(held("May 2020", "Do not use: May 2020", "May 2020")).toBe(false);
    // C1 review: a value code found in a line (not the reader's typed value) is checked by the line as it reads now.
    expect(held("Graduating in May 2027.", "Do not use: May 2027", "May 2027")).toBe(false);
    expect(held("555-0147", "Do not use: 555-0147", "555-0147")).toBe(false);
    expect(held("Oakland, California, United States", "Do not use: Oakland, California, United States", "Oakland, California, United States")).toBe(false);
  });

  it("checks a value from a long labelled line by its label", () => {
    expect(held(SCHOOL, SCHOOL, "Lakeshore Polytechnic Institute", "School")).toBe(true);
    // Its lines read as recorded, so the label is what refuses it.
    const relabelled = SCHOOL.replace("School:", "Not my school:");
    expect(held(relabelled, relabelled, "Lakeshore Polytechnic Institute", "School")).toBe(false);
  });
});

describe("the parts code derives for C1", () => {
  it("splits a Canadian address as a US one", () => {
    expect(splitAddress("48 Larchmere Avenue, Toronto, Ontario")).toEqual({ street: "48 Larchmere Avenue", city: "Toronto", state: "Ontario" });
  });

  it("reads which part of a date a field asks for from its whole label", () => {
    const table: [string, string | null][] = [
      ["Graduation date month", "month"],
      ["Start date year", "year"],
      ["Year of graduation", "year"],
      ["End date month", "month"],
      ["Month", null],
      ["Years of experience", null],
      ["Date (month and year)", null],
      ["Start date", null],
    ];
    expect(table.map(([l]) => [l, datePart(l)])).toEqual(table);
  });

  it("splits a date's month name and year as written, and nothing else", () => {
    expect(splitDate("May 2021")).toEqual({ month: "May", year: "2021" });
    expect(splitDate("October 18, 2026")).toEqual({ month: "October", year: "2026" });
    expect(splitDate("Sept 2016")).toEqual({ month: "Sept", year: "2016" });
    expect(splitDate("2026-11-01")).toEqual({ month: null, year: "2026" });
    expect(splitDate("graduated May 2021")).toBeNull();
    expect(splitDate("2021-2022")).toBeNull();
  });
});

describe("a menu takes the part of a whole value it asks for", () => {
  const F = (s: string): string => `dev.caret.fixture/standard/${s}`;
  const menu = (key: string, label: string, options: string[], y: number): Node[] => [
    { key: F(key), parent: null, role: "AXPopUpButton", label, value: "Select...", editable: true, frame: [100, y, 200, 24] },
    ...options.map((o, i): Node => ({ key: F(`${key}/item${i}`), parent: F(key), role: "AXMenuItem", label: o })),
  ];
  it("writes May for a month menu and Oregon for a state menu when Jev picks the whole date and address", async () => {
    const m = new ScreenModel();
    const note = "Signup\nAddress: 2210 Willow Bend Drive, Apt 5B, Portland, Oregon 97214\nGraduated in May 2021 from Northfield, after four long years of night classes and weekend shifts.";
    m.apply(snap([{ key: NOTE_KEY, parent: null, role: "AXTextArea", value: note, editable: true }], { at: 1000, windowId: "7001-1", title: "Notes.txt", app: NOTE_APP, focused: true }));
    const nodes: Node[] = [
      field(F("city"), "", { label: "City", frame: [100, 60, 200, 24] }),
      ...menu("month", "Graduation date month", ["January", "February", "March", "April", "May", "June"], 100),
      ...menu("state", "State", ["Ohio", "Oregon", "Texas"], 140),
    ];
    m.apply(snap(nodes, { at: 2000, windowId: FORM, title: "Application", focused: true }));
    const jev = jevPickingText((_id, ins) => (ins.includes("'Graduation date month'") ? "May 2021" : ins.includes("'State'") ? "2210 Willow Bend Drive, Apt 5B, Portland, Oregon 97214" : null));
    const p = await proposeFill(m, jev, FORM, F("city"), 3000);
    const got = Object.fromEntries(p.fields.map((f) => [f.key.split("/").pop(), f.handoff === null ? null : [f.handoff.value, f.handoff.writes ?? false]]));
    // Through Accessibility a menu is the user's to set (writes false); the value is the part, an option's exact name.
    expect(got).toEqual({ city: null, month: ["May", false], state: ["Oregon", false] });
  });
});

describe("a second address is named by any word for second", () => {
  it("fills Alternate email from a note's Backup email beside other emails, and not from a Work email", async () => {
    const note = "Signup\nBackup email: jab.cole@example.org\nWork email: jo.cole@work.example\nMy husband Marcus is marcus.cole@example.net.";
    const { values } = await fill(note, { "Alternate email": "jab.cole@example.org" });
    expect(values).toEqual({ "Alternate email": "jab.cole@example.org" });
    const other = await fill(note, { "Alternate email": "jo.cole@work.example" });
    expect(other.values).toEqual({ "Alternate email": null });
  });
});

describe("a value its line warns about, under a tight budget", () => {
  it("is not offered without its warning", async () => {
    // A note held to half its long lines, where the warning's clause cannot fit beside everything else.
    const long = "Phone: 555-0101 (my old number, no longer works; please use the new mobile number on my current application instead).";
    const m = new ScreenModel();
    m.apply(snap([{ key: NOTE_KEY, parent: null, role: "AXTextArea", value: `Contact\n${long}`, editable: true }], { at: 1000, windowId: "7001-1", title: "Notes.txt", app: NOTE_APP, focused: true }));
    m.apply(snap([field(F("field:0"), "", { label: "Phone" })], { at: 2000, windowId: FORM, focused: true }));
    const { SnippetLedger } = await import("../src/privacy.ts");
    const cs = collectCandidates(m, FORM, { now: 3000, ledger: new SnippetLedger(m.windows.values()) }).candidates;
    const c = cs.find((x) => x.text === "555-0101");
    expect(c === undefined || (c.line ?? "").includes("no longer works")).toBe(true);
  });
});

describe("a labelled value its line warns about", () => {
  it("carries the warning as its clause", () => {
    const m = new ScreenModel();
    m.apply(snap([{ key: NOTE_KEY, parent: null, role: "AXTextArea", value: "Contact\nPhone: 555-0101 (my old number, no longer works)\nEmail: jo@example.org", editable: true }], { at: 1000, windowId: "7001-1", title: "Notes.txt", app: NOTE_APP, focused: true }));
    m.apply(snap([field(F("field:0"), "", { label: "Phone" })], { at: 2000, windowId: FORM, focused: true }));
    const c = collectCandidates(m, FORM, { now: 3000 }).candidates.find((x) => x.text === "555-0101");
    expect([c?.context, c?.line]).toEqual(["Phone", "Phone: 555-0101 (my old number, no longer works)"]);
    m.apply(snap([{ key: NOTE_KEY, parent: null, role: "AXTextArea", value: "Contact\nPhone: 555-0101; do not use this old number.\nEmail: jo@example.org", editable: true }], { at: 1500, windowId: "7001-1", title: "Notes.txt", app: NOTE_APP, focused: true }));
    m.apply(snap([field(F("field:0"), "", { label: "Phone" })], { at: 2500, windowId: FORM, focused: true }));
    const d = collectCandidates(m, FORM, { now: 3000 }).candidates.find((x) => x.text === "555-0101");
    expect(d?.line).toBe("Phone: 555-0101; do not use this old number.");
  });
});

describe("a warned value that does not fit", () => {
  it("keeps a later bare copy of it out too, and the cut rules count its kind", async () => {
    const { SnippetLedger } = await import("../src/privacy.ts");
    const { cutKinds } = await import("../src/fill/candidates.ts");
    const pad = "The building manager said the lobby will be repainted next week and the elevator inspection is on Friday morning. ".repeat(10);
    const m = new ScreenModel();
    m.apply(snap([{ key: NOTE_KEY, parent: null, role: "AXTextArea", value: `Phone: 555-0101; do not use this old number belonging to Dana Whitfield because ${pad}\\nPhone: 555-0101`, editable: true }], { at: 1000, windowId: "7001-1", title: "Notes.txt", app: NOTE_APP, focused: true }));
    m.apply(snap([field(F("field:0"), "", { label: "Phone" })], { at: 2000, windowId: FORM, focused: true }));
    const r = collectCandidates(m, FORM, { now: 3000, ledger: new SnippetLedger(m.windows.values()) });
    const c = r.candidates.find((x) => x.text === "555-0101");
    expect(c === undefined || (c.line ?? "").includes("do not use")).toBe(true);
    if (c === undefined) expect([...cutKinds(m, r.cut, r.candidates)]).toContain("phone");
  });

  it("keeps out a later span that holds it, and the cut rules still count its kind", async () => {
    const { SnippetLedger } = await import("../src/privacy.ts");
    const { cutKinds } = await import("../src/fill/candidates.ts");
    const pad = "the records were incorrect and await review ".repeat(40);
    const m = new ScreenModel();
    m.apply(snap([{ key: NOTE_KEY, parent: null, role: "AXTextArea", value: `Phone: 555-0101; do not use this old number because ${pad}\nPhone: 555-0101 ext 42`, editable: true }], { at: 1000, windowId: "7001-1", title: "Notes.txt", app: NOTE_APP, focused: true }));
    m.apply(snap([field(F("field:0"), "", { label: "Phone" })], { at: 2000, windowId: FORM, focused: true }));
    const r = collectCandidates(m, FORM, { now: 3000, ledger: new SnippetLedger(m.windows.values()) });
    const bare = r.candidates.filter((x) => x.text.includes("555-0101") && !(x.line ?? "").includes("do not use"));
    expect(bare.map((x) => x.text)).toEqual([]);
    expect([...cutKinds(m, r.cut, r.candidates)]).toContain("phone");
  });
});

describe("a warning sentence a line break cut", () => {
  it("goes with the value on the line before it", () => {
    const m = new ScreenModel();
    m.apply(snap([{ key: NOTE_KEY, parent: null, role: "AXTextArea", value: "Contact\nPhone: 555-0101\nand must not be used because the records require review before any contact is attempted\nEmail: jo@example.org", editable: true }], { at: 1000, windowId: "7001-1", title: "Notes.txt", app: NOTE_APP, focused: true }));
    m.apply(snap([field(F("field:0"), "", { label: "Phone" })], { at: 2000, windowId: FORM, focused: true }));
    const c = collectCandidates(m, FORM, { now: 3000 }).candidates.find((x) => x.text === "555-0101");
    expect(c === undefined || (c.line ?? "").includes("must not be used")).toBe(true);
  });
});
