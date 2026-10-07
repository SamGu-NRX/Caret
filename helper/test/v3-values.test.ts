// V3: values fill could not place (B24 ask-04, ask-17, ask-19; ~/.caret-run/briefs/BRIEF-V3-values-code-cant-place.md).
// A numeric date gives its month and day only when evidence settles their order; a date with a time gives each part
// on its own; a select or radio option is offered when one word of the request or a source names it. Every ambiguous
// case gives nothing. Jev is a fake that answers by rule; every name, date and place is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { mintOf, proposeFill, type FillScope } from "../src/fill/fill.ts";
import { dateOrderHint, datePart, dateParts, partFits } from "../src/fill/derive.ts";
import { readClock, readDate, sentInstant, splitMoment } from "../src/fill/when.ts";
import { optionNamedBy } from "../src/fill/controls.ts";
import type { AskJev } from "../src/fill/jev.ts";
import type { Node } from "../src/protocol.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PROTOCOL_VERSION, type PageControl, type PageSnapshot } from "../src/protocol.ts";
import { field, jevPickingText, snap, value } from "./builders.ts";

const DENVER = { locale: "en-US", timeZone: "America/Denver", referenceInstant: null };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

describe("a date's parts", () => {
  it("reads a bare Month, Day or Year label as a date part only inside a group headed by a date", () => {
    const table: [string, string | null, string | null][] = [
      ["Day", "Date of birth", "day"],
      ["Month", "Date of birth", "month"],
      ["Year", "Date of birth", "year"],
      ["Year", "Birthday", "year"],
      ["Day", null, null],
      ["Year", "Vehicle", null],
      ["Day", "Delivery to", null],
      ["Preferred day", "Services and time", null],
      ["Date of birth day", null, "day"],
    ];
    expect(table.map(([l, s]) => [l, s, datePart(l, s)])).toEqual(table);
  });

  it("orders a numeric date's month and day only on evidence, and keeps its year either way", () => {
    const table: [string, "md" | "dm" | null, ReturnType<typeof dateParts>][] = [
      ["04/22/1990", null, { month: "04", day: "22", year: "1990" }],
      ["22/04/1990", null, { month: "04", day: "22", year: "1990" }],
      ["22.04.1990", null, { month: "04", day: "22", year: "1990" }],
      ["05/05/1990", null, { month: "05", day: "05", year: "1990" }],
      // Both parts 12 or under and different: the order is a guess, so neither is given.
      ["04/12/1990", null, { month: null, day: null, year: "1990" }],
      ["4/2/1990", null, { month: null, day: null, year: "1990" }],
      ["04/12/1990", "md", { month: "04", day: "12", year: "1990" }],
      ["04/12/1990", "dm", { month: "12", day: "04", year: "1990" }],
      // Evidence that contradicts the date itself, or no day that exists: nothing.
      ["22/04/1990", "md", null],
      ["02/30/1990", null, null],
      ["13/13/1990", null, null],
      ["04/12/90", null, null],
      // Named and ISO dates are read as before.
      ["March 14, 1990", null, { month: "March", day: "14", year: "1990" }],
      ["1990-03-14", null, { month: "03", day: "14", year: "1990" }],
    ];
    expect(table.map(([t, o]) => [t, o, dateParts(t, o)])).toEqual(table);
  });

  it("reads a format the source states beside its date", () => {
    expect([dateOrderHint("DOB (MM/DD/YYYY)"), dateOrderHint("Born (dd.mm.yyyy)"), dateOrderHint("Date of birth"), dateOrderHint(null)]).toEqual(["md", "dm", null, null]);
  });

  it("lets a month field take a month's number", () => {
    expect([partFits("month", "04"), partFits("month", "4"), partFits("month", "13"), partFits("month", "April")]).toEqual([true, true, false, true]);
  });
});

describe("a date with a time", () => {
  it("splits each part as written, and reads each on its own", () => {
    expect(splitMoment("Saturday, October 17 at 8:45am")).toEqual({ date: "Saturday, October 17", time: "8:45am" });
    expect(splitMoment("October 17, 2026, 14:30")).toEqual({ date: "October 17, 2026", time: "14:30" });
    expect(splitMoment("Saturday, October 17")).toBeNull();
    const sent = { ...DENVER, referenceInstant: "2026-10-15T16:22:00Z" };
    expect(readDate("Saturday, October 17 at 8:45am", sent)?.value).toBe("2026-10-17");
    // No am or pm: the date still stands, the time stays the user's.
    expect(readDate("Saturday, October 17 at 8:45", sent)?.value).toBe("2026-10-17");
    expect(readClock("Saturday, October 17 at 8:45", sent)).toBeNull();
    // A time is read only once its day is known (D2-04: Daylight Saving), so with no year nothing is.
    expect(readClock("Saturday, October 17 at 8:45am", DENVER)).toBeNull();
    expect(readClock("Saturday, October 17 at 8:45am", sent)?.value).toBe("08:45");
    // A weekday that is not that date's: the date is not given.
    expect(readDate("Friday, October 17 at 8:45am", sent)).toBeNull();
  });

  it("reads when a message was sent from its one header line, in the user's zone", () => {
    const mail = ["From: Chris Delgado <cdelgado@example.com>", "To: Jamie Torres", "Date: Thu, Oct 15, 2026, 10:22 AM", "I have Saturday, October 17 at 8:45am open."];
    expect(sentInstant(mail, DENVER)).toBe("2026-10-15T16:22:00Z");
    expect(sentInstant(mail.filter((l) => !l.startsWith("From:")), DENVER)).toBeNull();
    expect(sentInstant([...mail, "Date: Fri, Oct 16, 2026, 9:00 AM"], DENVER)).toBeNull();
    expect(sentInstant(["From: Chris", "Date: Thu, Oct 15"], DENVER)).toBeNull();
  });
});

describe("an option named by a word", () => {
  const SECTIONS = ["Mon/Wed 6:00-8:30 PM", "Tue/Thu 9:00-11:30 AM", "Sat 9:00 AM-12:30 PM"];
  it("names the one option a word of the text names, and no option when the word names several", () => {
    const table: [readonly string[], string, ReturnType<typeof optionNamedBy>][] = [
      [SECTIONS, "sign me up for the saturday section", { option: "Sat 9:00 AM-12:30 PM", word: "saturday" }],
      [SECTIONS, "Saturday mornings - weeknights I'm at work", { option: "Sat 9:00 AM-12:30 PM", word: "Saturday" }],
      [["Saturday 9–11am", "Sunday 1–3pm"], "saturday", { option: "Saturday 9–11am", word: "saturday" }],
      [SECTIONS, "tuesday or saturday works", "several"],
      [["Saturday 9–11am", "Saturday 1–3pm", "Sunday 1–3pm"], "saturday", "several"],
      // A lowercase "sat" is the verb, an all-caps "SAT" the test; a word in every option says nothing.
      [SECTIONS, "I sat the placement test", null],
      [["SAT prep", "ACT prep"], "saturday", null],
      [["Section A", "Section B"], "the section", null],
      [SECTIONS, "not saturday, I work then", null],
      // Only an option's first word, and no place or "Last, First" name (C2).
      [["Jordan Lee", "Avery Park"], "Bruce Lee", null],
      [["Toronto, Ontario, Canada", "Dublin, Ireland"], "Toronto, ON", null],
    ];
    expect(table.map(([o, t]) => [o, t, optionNamedBy(o, t)])).toEqual(table);
    // A word of the field's own question names nothing.
    expect(optionNamedBy(["Job board", "Employee referral"], "Job search, robotics tech roles", ["How did you hear about this job?"])).toBeNull();
    expect(optionNamedBy(["Job board", "Employee referral"], "Job search, robotics tech roles")).toEqual({ option: "Job board", word: "Job" });
  });
});

// ---- fill, end to end -------------------------------------------------------------------------------------------

const F = (s: string): string => `com.google.Chrome/standard/${s}`;
const web: Node = { key: F("webarea"), parent: null, role: "AXWebArea", label: "Form" };
const menu = (key: string, label: string, options: string[], parent: string, y: number): Node[] => [
  { key: F(key), parent, role: "AXPopUpButton", label, editable: true, frame: [100, y, 200, 24] },
  ...options.map((o, i): Node => ({ key: F(`${key}/item${i}`), parent: F(key), role: "AXMenuItem", label: o })),
];

/** The note or mail the user just left, then a form in Chrome. */
function desk(source: string[], form: Node[], title = "Notes.txt"): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("te/note", source.join("\n"), { role: "AXTextArea" })], { at: 1000, windowId: "7001-1", title, app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
  m.apply(snap(form, { at: 2000, windowId: "5150-7", title: "Guest information", app: { pid: 5150, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
  return m;
}

/** A Jev that picks by rule and records every option it was offered, by question id. */
function recording(pick: (ins: string) => string | null): { jev: AskJev; offered: string[] } {
  const offered: string[] = [];
  const inner = jevPickingText((_id, ins) => pick(ins));
  return {
    offered,
    jev: async (req) => {
      for (const q of Object.values(req.questions)) for (const d of Object.values(q.criteria)) if (typeof d === "string") offered.push(`${typeof q.instructions === "string" ? (/Label: '([^']+)'/u.exec(q.instructions)?.[1] ?? "") : ""} <- ${d}`);
      return inner(req);
    },
  };
}

describe("a birthday split over Month, Day and Year (B24 ask-04)", () => {
  const form = (): Node[] => [
    web,
    { key: F("first"), parent: web.key, role: "AXTextField", label: "First name", editable: true, frame: [100, 20, 200, 24] },
    { key: F("dob"), parent: web.key, role: "AXGroup", subrole: "AXFieldset", label: "Date of birth" },
    ...menu("dobm", "Month", MONTHS, F("dob"), 60),
    { key: F("dobd"), parent: F("dob"), role: "AXTextField", label: "Day", editable: true, frame: [100, 100, 80, 24] },
    { key: F("doby"), parent: F("dob"), role: "AXTextField", label: "Year", editable: true, frame: [100, 140, 80, 24] },
  ];
  const want: Record<string, string> = { "'Month'": "April", "'Day'": "22", "'Year'": "1990" };
  const pick = (ins: string): string | null => Object.entries(want).find(([k]) => ins.includes(k))?.[1] ?? null;
  const got = (p: Awaited<ReturnType<typeof proposeFill>>): Record<string, string | null> => Object.fromEntries(p.fields.map((f) => [f.key.split("/").pop(), f.value ?? f.handoff?.value ?? null]));

  it("gives each part of a date whose order a part over 12 settles, each a derived part of the source's date", async () => {
    const m = desk(["Traveler: Riley Okafor", "Date of birth: 04/22/1990"], form());
    const p = await proposeFill(m, jevPickingText((_id, ins) => pick(ins)), "5150-7", F("first"), 3000);
    expect(got(p)).toMatchObject({ dobm: "April", dobd: "22", doby: "1990" });
    const day = mintOf(p.fields.find((f) => f.key === F("dobd")) as (typeof p.fields)[number]);
    expect(day?.provenance).toMatchObject({ kind: "derived", how: "datePart", base: { kind: "window", span: "04/22/1990" } });
    expect(day?.verdict.by).toBe("verifier");
  });

  it("gives only the year of 04/12/1990, and offers no month or day at all", async () => {
    const m = desk(["Traveler: Riley Okafor", "Date of birth: 04/12/1990"], form());
    const { jev, offered } = recording((ins) => (ins.includes("'Year'") ? "1990" : ins.includes("'Day'") ? "12" : ins.includes("'Month'") ? "April" : null));
    const p = await proposeFill(m, jev, "5150-7", F("first"), 3000);
    expect(got(p)).toMatchObject({ dobm: null, dobd: null, doby: "1990" });
    expect(offered.filter((o) => /^(?:Day|Month) <- "(?:12|04|April|December)"/u.test(o))).toEqual([]);
  });

  it("orders 04/12/1990 by the format the source states beside it", async () => {
    const m = desk(["Traveler: Riley Okafor", "DOB (MM/DD/YYYY): 04/12/1990"], form());
    const p = await proposeFill(m, jevPickingText((_id, ins) => (ins.includes("'Day'") ? "12" : pick(ins))), "5150-7", F("first"), 3000);
    expect(got(p)).toMatchObject({ dobm: "April", dobd: "12", doby: "1990" });
  });
});

describe("a slot offered as a date with a time (B24 ask-19)", () => {
  const ORIGIN = "http://127.0.0.1:4310";
  const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
  const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
  const control = (id: string, kind: PageControl["kind"], name: string): PageControl => ({ id, key: `form[svc]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: kind, name, form: "form#svc", rect: [0, 0, 100, 20], value: "" });
  const page = (controls: PageControl[]): PageSnapshot => ({
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Schedule Service",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: ORIGIN, path: "/book", navGen: 1, title: "Schedule Service", headings: ["Schedule Service"], iframes: [], excluded: {}, truncated: false, controls }],
    missing: [],
    focused: { frameId: 0, id: controls[0]?.id ?? "e1", selection: [0, 0] },
  });
  const WIN = "page:eng1:7";
  const scene = (lines: string[]): ScreenModel => {
    const m = new ScreenModel();
    // The reader types the slot as a date, as it did in B24's capture of Chris's mail.
    const slot = lines.map((l) => /(Saturday, October 17 at [\d:apm]+)/u.exec(l)?.[1]).find((x) => x !== undefined);
    const values = slot === undefined ? [] : [value("date", slot, "mail/body")];
    // A mail's header and body as a mail app shows them (a TextEdit window here, which reads the same lines).
    m.apply(snap([field("mail/body", lines.join("\n"), { role: "AXTextArea" })], { at: 900, windowId: "mail", title: "Re: 60k service", app: { pid: 7002, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, values }));
    m.apply(toWindowSnapshot(page([control("e1", "text", "Mileage"), control("e2", "date", "Preferred date"), control("e3", "time", "Preferred time")]), session, 1));
    return m;
  };
  const MAIL = ["From: Chris Delgado <cdelgado@example.com>", "To: Jamie Torres <jamie@example.net>", "Date: Thu, Oct 15, 2026, 10:22 AM", "", "I have Saturday, October 17 at 8:45am open."];
  const run = async (lines: string[], slot = "Saturday, October 17 at 8:45am") => {
    const p = await proposeFill(scene(lines), jevPickingText((_id, ins) => (ins.includes("'Preferred date'") || ins.includes("'Preferred time'") ? slot : null)), WIN, "f0/form[svc]/text:mileage~0", Date.UTC(2026, 9, 15, 18), { resolve: DENVER });
    const at = (k: string) => p.fields.find((f) => f.key.includes(k)) as (typeof p.fields)[number];
    return { date: at("date:preferred date"), time: at("time:preferred time") };
  };

  it("writes the date, its year from when the message was sent, and the time, each minted as a derived part", async () => {
    const { date, time } = await run(MAIL);
    expect([date.handoff?.value, date.handoff?.writes, time.handoff?.value, time.handoff?.writes]).toEqual(["2026-10-17", true, "08:45", true]);
    for (const f of [date, time]) expect(mintOf(f)).toMatchObject({ verdict: { by: "exempt", rule: "resolverFormat" }, provenance: { kind: "derived", how: "datePart", base: { kind: "window", span: "Saturday, October 17 at 8:45am" } } });
  });

  it("withholds the date when nothing on screen says the year, and a time with no am or pm", async () => {
    const noHeader = await run(MAIL.filter((l) => !l.startsWith("Date:")));
    expect([noHeader.date.handoff, noHeader.date.withheld]).toEqual([null, "ambiguous"]);
    const bare = await run(MAIL.map((l) => l.replace("8:45am", "8:45")), "Saturday, October 17 at 8:45");
    expect(bare.date.handoff?.value).toBe("2026-10-17");
    expect([bare.time.handoff, bare.time.withheld]).toEqual([null, "ambiguous"]);
  });
});

describe("a section named by a word (B24 ask-17)", () => {
  const form = (): Node[] => [
    web,
    { key: F("name"), parent: web.key, role: "AXTextField", label: "Full name", editable: true, frame: [100, 20, 200, 24] },
    { key: F("sec"), parent: web.key, role: "AXGroup", subrole: "AXFieldset", label: "Section" },
    ...["Mon/Wed 6:00-8:30 PM", "Tue/Thu 9:00-11:30 AM", "Sat 9:00 AM-12:30 PM"].map((o, i): Node => ({ key: F(`sec/r${i}`), parent: F("sec"), role: "AXRadioButton", label: o, frame: [100, 60 + 30 * i, 200, 20] })),
  ];
  const scope = (instruction: string): FillScope => ({ fields: [F("sec")], windows: null, memory: false, instruction, person: null, literals: new Map() });
  const section = async (note: string[], instruction: string | null, picks = "Sat 9:00 AM-12:30 PM") => {
    const { jev, offered } = recording((ins) => (ins.includes("'Section'") ? picks : null));
    const p = await proposeFill(desk(note, form()), jev, "5150-7", F("name"), 3000, instruction === null ? {} : { scope: scope(instruction) });
    return { field: p.fields.find((f) => f.key === F("sec")), offered: offered.filter((o) => o.startsWith("Section <- ")) };
  };

  it("offers the Saturday section the request names, and hands off the one a line Jev picks names", async () => {
    const asked = await section(["Lakeside CC signup", "Class: Intro to Web Development"], "sign me up for the saturday section");
    expect(asked.field?.handoff?.value).toBe("Sat 9:00 AM-12:30 PM");
    expect(asked.offered.some((o) => o.includes("the word 'saturday' in the user's instruction"))).toBe(true);
    const noted = await section(["Lakeside CC signup", "Saturday mornings - weeknights I'm at work"], null, "Saturday mornings - weeknights I'm at work");
    expect([noted.field?.handoff?.value, noted.field?.handoff?.writes ?? false]).toEqual(["Sat 9:00 AM-12:30 PM", false]);
    // No line is searched for such words: the option is offered from the request alone.
    expect(noted.offered.filter((o) => o.includes("the option the word"))).toEqual([]);
  });

  it("offers no option from a request that does not name the field", async () => {
    const hear: Node[] = [
      web,
      { key: F("name"), parent: web.key, role: "AXTextField", label: "Full name", editable: true, frame: [100, 20, 200, 24] },
      ...menu("hear", "How did you hear about this role?", ["Job board", "Employee referral"], web.key, 60),
    ];
    const { jev, offered } = recording(() => null);
    await proposeFill(desk(["Job search, robotics tech roles", "Name: Ines Vandermeer"], hear, "Job notes.txt"), jev, "5150-7", F("name"), 3000, { scope: { ...scope("fill out my job application"), fields: [F("name"), F("hear")] } });
    expect(offered.filter((o) => o.includes("the option the word"))).toEqual([]);
  });

  it("offers no section when the words name two", async () => {
    const two = await section(["Lakeside CC signup", "Class: Intro to Web Development"], "put me in the tuesday or saturday section");
    expect(two.field?.handoff ?? null).toBeNull();
    expect(two.offered.filter((o) => o.includes("the option the word"))).toEqual([]);
  });
});
