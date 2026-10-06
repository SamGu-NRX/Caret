// C1: fill reads values inside lines. A note line over 80 characters offered nothing, and a short line was offered only
// whole, so "Mobile 555-0164 (no landline anymore)." gave a phone field nothing (evidence/screen/p2 tasks-dev4). Jev is
// a fake that answers by rule; every name, number and address is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { collectCandidates, describeCandidate } from "../src/fill/candidates.ts";
import { proposeFill } from "../src/fill/fill.ts";
import type { JevRequest } from "../src/fill/jev.ts";
import { datePart, splitAddress, splitDate } from "../src/fill/derive.ts";
import { sourceHolds } from "../src/offers/fill-popup.ts";
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
  const src = (t: string) => {
    const m = new ScreenModel();
    m.apply(snap([text("dev.caret.notes/standard/statictext:a~0", t)], { at: 1, windowId: "8-1" }));
    return m.windows.get("8-1") as NonNullable<ReturnType<ScreenModel["windows"]["get"]>>;
  };
  const key = "dev.caret.notes/standard/statictext:a~0";

  it("holds a date's month from a labelled line whose label does not name the date", () => {
    expect(sourceHolds(src("School: Lakeshore Polytechnic Institute, B.S. Electrical Engineering, September 2016 to May 2020."), key, "May", null, "select")).toBe(true);
    expect(sourceHolds(src("Graduated in May 2020 from Lakeshore, and the transcript is at home with my parents somewhere."), key, "2020", null, "select")).toBe(true);
  });

  it("refuses a line that now has a label naming the value", () => {
    expect(sourceHolds(src("Do not use: May 2020"), key, "May", null, "select")).toBe(false);
    expect(sourceHolds(src("Do not use: Oakland, California, United States"), key, "Oakland, California, United States", null, "combobox")).toBe(false);
  });

  it("checks a value from a long labelled line by its label", () => {
    const line = "School: Lakeshore Polytechnic Institute, B.S. Electrical Engineering, September 2016 to May 2020.";
    expect(sourceHolds(src(line), key, "Lakeshore Polytechnic Institute", "School", "combobox")).toBe(true);
    expect(sourceHolds(src(line.replace("School:", "Not my school:")), key, "Lakeshore Polytechnic Institute", "School", "combobox")).toBe(false);
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
