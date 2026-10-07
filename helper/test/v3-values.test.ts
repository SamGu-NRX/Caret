// V3: values fill could not place (B24 ask-04, ask-17, ask-19; ~/.caret-run/briefs/BRIEF-V3-values-code-cant-place.md).
// A numeric date gives its month and day only when evidence settles their order; a date with a time gives each part
// on its own; a select or radio option is offered when one word of the request or a source names it. Every ambiguous
// case gives nothing. Jev is a fake that answers by rule; every name, date and place is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { mintOf, proposeFill, type FillScope } from "../src/fill/fill.ts";
import { makeFieldContract, mintExempt, provenanceStale, setTestVerifier, type Provenance } from "../src/fill/contract.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { dateOrderHint, datePart, dateParts, partFits } from "../src/fill/derive.ts";
import { datedBySent, readClock, readDate, sentLineFor, splitMoment } from "../src/fill/when.ts";
import type { ResolveContext } from "../src/values/resolve.ts";
import { optionNamedBy } from "../src/fill/controls.ts";
import type { AskJev } from "../src/fill/jev.ts";
import type { Node } from "../src/protocol.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PROTOCOL_VERSION, type PageControl, type PageSnapshot } from "../src/protocol.ts";
import { field, jevPickingText, snap, value } from "./builders.ts";

const DENVER: ResolveContext = { locale: "en-US", timeZone: "America/Denver", referenceInstant: null };
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

  it("finds the send line of the one message a span sits in, and assumes a year from it only when a day either side agrees", () => {
    const nodes = (lines: string[]) => lines.map((text, i) => ({ key: `n${i}`, text }));
    const mail = ["From: Chris Delgado <cdelgado@example.com>", "To: Jamie Torres", "Date: Thu, Oct 15, 2026, 10:22 AM", "I have Saturday, October 17 at 8:45am open."];
    const span = "Saturday, October 17 at 8:45am";
    const sent = sentLineFor(nodes(mail), "n3", span);
    expect(sent).toMatchObject({ nodeKey: "n2", day: "2026-10-15" });
    expect(sentLineFor(nodes(mail.filter((l) => !l.startsWith("From:"))), "n2", span)).toBeNull();
    expect(sentLineFor(nodes([...mail.slice(0, 3), "On Oct 1, Chris wrote:", mail[3] as string]), "n4", span)).toBeNull();
    expect(sentLineFor(nodes([...mail, "Date: Fri, Oct 16, 2026, 9:00 AM"]), "n3", span)).toBeNull();
    expect(datedBySent(span, sent!, DENVER)).toMatchObject({ value: "2026-10-17", says: expect.stringContaining("the year 2026 is assumed") });
    expect(datedBySent("tomorrow at 9am", sent!, DENVER)).toBeNull();
    expect(datedBySent("October 17, 2027", sent!, DENVER)).toBeNull();
  });
});

describe("an option named by a word", () => {
  const SECTIONS = ["Mon/Wed 6:00-8:30 PM", "Tue/Thu 9:00-11:30 AM", "Sat 9:00 AM-12:30 PM"];
  it("names the one option a word of the text names, and no option when the word names several", () => {
    const table: [readonly string[], string, ReturnType<typeof optionNamedBy>][] = [
      [SECTIONS, "sign me up for the saturday section", { option: "Sat 9:00 AM-12:30 PM", word: "saturday" }],
      [SECTIONS, "Saturday mornings - weeknights I'm at work", { option: "Sat 9:00 AM-12:30 PM", word: "Saturday" }],
      [["Saturday 9–11am", "Sunday 1–3pm"], "saturday", { option: "Saturday 9–11am", word: "saturday" }],
      [SECTIONS, "tuesday or saturday works", null],
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
  // V3 review round 2: a year code assumes is offered as its own candidate ("2026-10-17", its choice said), which the value
  // asks must pick; the raw span reads no year.
  const run = async (lines: string[], date = "2026-10-17", time = "08:45") => {
    const p = await proposeFill(scene(lines), jevPickingText((_id, ins) => (ins.includes("'Preferred date'") ? date : ins.includes("'Preferred time'") ? time : null)), WIN, "f0/form[svc]/text:mileage~0", Date.UTC(2026, 9, 15, 18), { resolve: DENVER });
    const at = (k: string) => p.fields.find((f) => f.key.includes(k)) as (typeof p.fields)[number];
    return { date: at("date:preferred date"), time: at("time:preferred time") };
  };

  it("writes the date, its year from when the message was sent, and the time, each checked by the verifier with that choice said", async () => {
    const { date, time } = await run(MAIL);
    expect([date.handoff?.value, date.handoff?.writes, time.handoff?.value, time.handoff?.writes]).toEqual(["2026-10-17", true, "08:45", true]);
    for (const [f, how] of [[date, "datePart"], [time, "timePart"]] as const) {
      expect(mintOf(f)).toMatchObject({ verdict: { by: "verifier" }, provenance: { kind: "derived", how, base: { kind: "window", span: "Saturday, October 17 at 8:45am" }, also: { kind: "window", span: "Thu, Oct 15, 2026, 10:22 AM" } } });
      expect((mintOf(f)?.provenance as { says?: string }).says).toContain("the year 2026 is assumed");
    }
  });

  it("withholds the date when nothing on screen says the year, and a time with no am or pm", async () => {
    const noHeader = await run(MAIL.filter((l) => !l.startsWith("Date:")));
    expect(noHeader.date.handoff).toBeNull();
    // The raw span, picked instead, reads no year either.
    expect((await run(MAIL.filter((l) => !l.startsWith("Date:")), "Saturday, October 17 at 8:45am")).date.handoff).toBeNull();
    const bare = await run(MAIL.map((l) => l.replace("8:45am", "8:45")));
    expect(bare.date.handoff?.value).toBe("2026-10-17");
    expect(bare.time.handoff).toBeNull();
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

  it("offers the Saturday section the request names, and never maps a line Jev picks to an option (review A4)", async () => {
    const asked = await section(["Lakeside CC signup", "Class: Intro to Web Development"], "sign me up for the saturday section");
    expect(asked.field?.handoff?.value).toBe("Sat 9:00 AM-12:30 PM");
    expect(asked.offered.some((o) => o.includes("the word 'saturday' in the user's instruction"))).toBe(true);
    const noted = await section(["Lakeside CC signup", "Saturday mornings - weeknights I'm at work"], null, "Saturday mornings - weeknights I'm at work");
    expect(noted.field?.handoff ?? null).toBeNull();
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

// ---- review round 1 (theo-sol-auditor on 1052cc3): each finding's input, as a test that failed on that head ----------

describe("review round 1: code that chose a value", () => {
  const SECTIONS = ["Mon/Wed 6:00-8:30 PM", "Tue/Thu 9:00-11:30 AM", "Sat 9:00 AM-12:30 PM"];
  const sectionForm = (): Node[] => [
    web,
    { key: F("name"), parent: web.key, role: "AXTextField", label: "Full name", editable: true, frame: [100, 20, 200, 24] },
    { key: F("sec"), parent: web.key, role: "AXGroup", subrole: "AXFieldset", label: "Section" },
    ...SECTIONS.map((o, i): Node => ({ key: F(`sec/r${i}`), parent: F("sec"), role: "AXRadioButton", label: o, frame: [100, 60 + 30 * i, 200, 20] })),
  ];
  const sectionScope = (instruction: string): FillScope => ({ fields: [F("sec")], windows: null, memory: false, instruction, person: null, literals: new Map() });
  const sectionOf = async (note: string[], instruction: string, picks = "Sat 9:00 AM-12:30 PM") => {
    const p = await proposeFill(desk(note, sectionForm()), jevPickingText((_id, ins) => (ins.includes("'Section'") ? picks : null)), "5150-7", F("name"), 3000, { scope: sectionScope(instruction) });
    return p.fields.find((f) => f.key === F("sec"));
  };

  it("A1: offers no option an excluded or conditional word names", async () => {
    for (const ins of ["Choose any section except Saturday", "Choose Saturday section only if it is online", "sign me up for the saturday section unless it is full"]) {
      expect([ins, (await sectionOf(["Class: Web development"], ins))?.handoff ?? null]).toEqual([ins, null]);
    }
  });

  it("A2: a weekday a compound label also holds competes with the one that opens a label", async () => {
    expect(optionNamedBy(SECTIONS, "Thursday or Saturday works for the section")).toBeNull();
    expect(optionNamedBy(["Sat 9:00 AM-12:30 PM", "Thu/Sat 6:00-8:00 PM"], "the saturday one")).toBe("several");
    expect((await sectionOf(["Class: Web development"], "Thursday or Saturday works for the section"))?.handoff ?? null).toBeNull();
  });

  it("A3: a request names a field only by a word that means that field, not 'this' or 'application'", async () => {
    const hear: Node[] = [
      web,
      { key: F("name"), parent: web.key, role: "AXTextField", label: "Full name", editable: true, frame: [100, 20, 200, 24] },
      ...menu("hear", "How did you hear about this role?", ["Job board", "Employee referral"], web.key, 60),
    ];
    const { jev, offered } = recording((ins) => (ins.includes("hear about") ? "Job board" : null));
    const p = await proposeFill(desk(["Applicant: Riley Okafor"], hear, "Notes.txt"), jev, "5150-7", F("name"), 3000, { scope: { ...sectionScope("fill out this job application"), fields: [F("name"), F("hear")] } });
    expect(p.fields.find((f) => f.key === F("hear"))?.handoff ?? null).toBeNull();
    expect(offered.filter((o) => o.includes("the option"))).toEqual([]);
  });

  it("A4: a line Jev picks is never turned into an option by a word of it", async () => {
    expect((await sectionOf(["Days I cannot attend: Saturday mornings"], "fill the section", "Saturday mornings"))?.handoff ?? null).toBeNull();
  });

  it("A5: a format hint that is negated, or names both orders, orders nothing", () => {
    expect(dateOrderHint("DOB (DD/MM/YYYY, not MM/DD/YYYY)")).toBeNull();
    expect(dateOrderHint("DOB (DD/MM/YYYY or MM/DD/YYYY)")).toBeNull();
    expect(dateOrderHint("DOB (DD/MM/YYYY)")).toBe("dm");
  });

  it("B9: a dotted or slashed date is read whole only in the order evidence gives", () => {
    expect(readDate("04.12.1990", DENVER)).toBeNull();
    expect(readDate("04.12.1990 at 8:45am", DENVER)).toBeNull();
    // An order from a locale or a stated format is read, and said as an assumption; the numbers alone assume nothing.
    expect(readDate("04/12/1990", { ...DENVER, sourceLocale: "en-US" })).toMatchObject({ value: "1990-04-12", assumptions: [expect.stringContaining("locale")] });
    expect(readDate("04.12.1990", DENVER, "md")).toMatchObject({ value: "1990-04-12", assumptions: [expect.stringContaining("format")] });
    expect(readDate("22.04.1990", DENVER, "dm")).toMatchObject({ value: "1990-04-22", assumptions: [] });
    expect(readDate("04.22.1990", DENVER, "dm")).toBeNull();
    expect(readDate("04/12/1990", { ...DENVER, sourceLocale: "en-US" }, "dm")).toBeNull();
  });

  it("a month menu's option settled by a format hint goes to the verifier, which reads how it was chosen", async () => {
    const asked: string[] = [];
    setTestVerifier(async (req) => {
      for (const q of Object.values(req.questions)) asked.push(String(q.instructions));
      return STAND_IN(req);
    });
    try {
      const form: Node[] = [
        web,
        { key: F("first"), parent: web.key, role: "AXTextField", label: "First name", editable: true, frame: [100, 20, 200, 24] },
        { key: F("dob"), parent: web.key, role: "AXGroup", subrole: "AXFieldset", label: "Date of birth" },
        ...menu("dobm", "Month", MONTHS, F("dob"), 60),
      ];
      const p = await proposeFill(desk(["DOB (MM/DD/YYYY): 04/12/1990"], form), jevPickingText((_id, ins) => (ins.includes("'Month'") ? "April" : null)), "5150-7", F("first"), 3000);
      const month = p.fields.find((f) => f.key === F("dobm")) as (typeof p.fields)[number];
      expect(month.handoff?.value).toBe("April");
      expect(asked.some((q) => q.includes("April") && /month first/u.test(q))).toBe(true);
    } finally {
      setTestVerifier(STAND_IN);
    }
  });
});

describe("review round 1: a year read from when a message was sent", () => {
  const ORIGIN = "http://127.0.0.1:4310";
  const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
  const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
  const control = (id: string, kind: PageControl["kind"], name: string): PageControl => ({ id, key: `form[svc]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: kind, name, form: "form#svc", rect: [0, 0, 100, 20], value: "" });
  const WIN = "page:eng1:7";
  /** A mail as separate header and body nodes; the reader types `span` in the body as a date. */
  const scene = (header: string[], body: string[], span: string, label = "Preferred date"): ScreenModel => {
    const m = new ScreenModel();
    const nodes: Node[] = [
      ...header.map((h, i): Node => ({ key: `mail/h${i}`, parent: null, role: "AXStaticText", value: h })),
      field("mail/body", body.join("\n"), { role: "AXTextArea" }),
    ];
    m.apply(snap(nodes, { at: 900, windowId: "mail", title: "Appointment", app: { pid: 7002, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, values: [value("date", span, "mail/body")] }));
    m.apply(toWindowSnapshot({ type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Book", frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: ORIGIN, path: "/b", navGen: 1, title: "Book", headings: [], iframes: [], excluded: {}, truncated: false, controls: [control("e1", "text", "Mileage"), control("e2", "date", label)] }], missing: [], focused: { frameId: 0, id: "e1", selection: [0, 0] } }, session, 1));
    return m;
  };
  const dateOf = async (m: ScreenModel, pick: string, field = "Preferred date", resolve = DENVER) => {
    const p = await proposeFill(m, jevPickingText((_id, ins) => (ins.includes(`'${field}'`) ? pick : null)), WIN, "f0/form[svc]/text:mileage~0", Date.UTC(2026, 9, 18, 18), { resolve });
    return p.fields.find((f) => f.key.includes(`date:${field.toLowerCase()}`)) as (typeof p.fields)[number];
  };
  const SPAN = "October 17 at 8:45am";

  it("A6: the send line is part of the value's provenance, so a changed send line stops the write", async () => {
    const m = scene(["From: Chris", "Sent: October 15, 2026, 10:22 AM"], [`Appointment: ${SPAN}`], SPAN);
    const f = await dateOf(m, "2026-10-17");
    expect(f.handoff?.value).toBe("2026-10-17");
    const mint = mintOf(f);
    expect(mint?.verdict.by).toBe("verifier");
    expect(provenanceStale(m, mint!.provenance)).toBeNull();
    m.apply(snap([{ key: "mail/h0", parent: null, role: "AXStaticText", value: "From: Chris" }, { key: "mail/h1", parent: null, role: "AXStaticText", value: "Sent: October 15, 2027, 10:22 AM" }, field("mail/body", `Appointment: ${SPAN}`, { role: "AXTextArea" })], { at: 1100, windowId: "mail", title: "Appointment", app: { pid: 7002, bundleId: "com.apple.TextEdit", name: "TextEdit" }, values: [value("date", SPAN, "mail/body")] }));
    expect(provenanceStale(m, mint!.provenance)).not.toBeNull();
  });

  it("A7: no year from a send line the span cannot be shown to sit under", async () => {
    const m = scene(["From: Chris", "Sent: October 15, 2026, 10:22 AM"], ["Original message from 2025", `Appointment: ${SPAN}`], SPAN);
    expect((await dateOf(m, "2026-10-17")).handoff).toBeNull();
    expect((await dateOf(m, SPAN)).handoff).toBeNull();
  });

  it("A8: no year when the source's zone could move the send day across it", async () => {
    const span = "December 31 at 11:45pm";
    const m = scene(["From: Chris", "Sent: December 31, 2026, 11:30 PM"], [`Appointment: ${span}`], span);
    for (const pick of ["2026-12-31", "2027-12-31", span]) expect((await dateOf(m, pick, "Preferred date", { ...DENVER, sourceTimeZone: "Asia/Tokyo" })).handoff).toBeNull();
    expect((await dateOf(scene(["From: Chris", "Sent: October 15, 2026, 10:22 AM"], [`Appointment: ${SPAN}`], SPAN), "2026-10-17", "Preferred date", { ...DENVER, sourceTimeZone: null })).handoff).toBeNull();
  });

  it("B10: the verifier is told the year was assumed, and its refusal withholds the date", async () => {
    const asked: string[] = [];
    setTestVerifier(async (req) => {
      for (const q of Object.values(req.questions)) asked.push(String(q.instructions));
      return { model: "verify-other", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "other", confidence: 0.95 }])), inputTokens: 0, latencyMs: 0, costUsd: 0 };
    });
    try {
      // Sent three days after October 17, so a day's doubt about the zone gives the same assumed year, 2027.
      const m = scene(["From: Chris", "Sent: October 20, 2026, 10:22 AM"], [`Service completed: ${SPAN}`], SPAN, "Last service date");
      const f = await dateOf(m, "2027-10-17", "Last service date");
      expect([f.handoff, f.withheld]).toEqual([null, "notExact"]);
      expect(asked.some((q) => q.includes("2027") && /year/u.test(q) && /sent/u.test(q))).toBe(true);
      // The reviewer's own input, sent the day after: a day's doubt about the zone gives 2026 or 2027, so no year at all.
      const next = scene(["From: Chris", "Sent: October 18, 2026, 10:22 AM"], [`Service completed: ${SPAN}`], SPAN, "Last service date");
      for (const pick of ["2026-10-17", "2027-10-17", SPAN]) expect((await dateOf(next, pick, "Last service date")).handoff).toBeNull();
    } finally {
      setTestVerifier(STAND_IN);
    }
  });
});

describe("lead conditions on the contract change", () => {
  const ORIGIN = "http://127.0.0.1:4310";
  const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
  const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
  const control = (id: string, kind: PageControl["kind"], name: string): PageControl => ({ id, key: `form[svc]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: kind, name, form: "form#svc", rect: [0, 0, 100, 20], value: "" });
  const fill = async (lines: string[], span: string, date = "2026-10-17", time = "08:45") => {
    const m = new ScreenModel();
    m.apply(snap([field("mail/body", lines.join("\n"), { role: "AXTextArea" })], { at: 900, windowId: "mail", title: "Re", app: { pid: 7002, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, values: [value("date", span, "mail/body")] }));
    m.apply(toWindowSnapshot({ type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Book", frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: ORIGIN, path: "/b", navGen: 1, title: "Book", headings: [], iframes: [], excluded: {}, truncated: false, controls: [control("e1", "text", "Mileage"), control("e2", "date", "Preferred date"), control("e3", "time", "Preferred time")] }], missing: [], focused: { frameId: 0, id: "e1", selection: [0, 0] } }, session, 1));
    const p = await proposeFill(m, jevPickingText((_id, ins) => (ins.includes("'Preferred date'") ? date : ins.includes("'Preferred time'") ? time : null)), "page:eng1:7", "f0/form[svc]/text:mileage~0", Date.UTC(2026, 9, 15, 18), { resolve: DENVER });
    const at = (k: string) => p.fields.find((f) => f.key.includes(k)) as (typeof p.fields)[number];
    return { date: at("date:preferred date"), time: at("time:preferred time") };
  };
  const MAIL = (span: string) => ["From: Chris Delgado <cdelgado@example.com>", "Date: Thu, Oct 15, 2026, 10:22 AM", "", `I have ${span} open.`];

  it("never mints a value whose provenance states a choice under an exemption", async () => {
    const { date } = await fill(MAIL("Saturday, October 17 at 8:45am"), "Saturday, October 17 at 8:45am");
    const m = mintOf(date)!;
    const proposed = { field: m.field, text: m.text, display: m.display, provenance: m.provenance, owner: m.owner };
    expect(() => mintExempt(proposed, "resolverFormat", 4000)).toThrow(expect.objectContaining({ name: "ContractError", code: "chosen" }));
  });

  it("names a time taken from a date and time as the time, and a whole date written in its format as resolved", async () => {
    const parts = await fill(MAIL("Saturday, October 17 at 8:45am"), "Saturday, October 17 at 8:45am");
    expect([(mintOf(parts.date)?.provenance as { how?: string }).how, (mintOf(parts.time)?.provenance as { how?: string }).how]).toEqual(["datePart", "timePart"]);
    // A whole date with its year: a plain conversion, minted under resolverFormat as "resolved".
    const whole = await fill(MAIL("October 17, 2026"), "October 17, 2026", "October 17, 2026");
    expect(mintOf(whole.date)).toMatchObject({ verdict: { by: "exempt", rule: "resolverFormat" }, provenance: { kind: "derived", how: "resolved" } });
  });
});

// ---- review round 2 (re-review of f43a813): a choice that escaped the marker, each the reviewer's input -------------

describe("review round 2: every assumption is a choice", () => {
  const ORIGIN = "http://127.0.0.1:4310";
  const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
  const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
  const control = (id: string, kind: PageControl["kind"], name: string, extra: Partial<PageControl> = {}): PageControl => ({ id, key: `form[a]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: kind, name, form: "form#a", rect: [0, 0, 100, 20], value: "", ...extra });
  const page = (controls: PageControl[]): PageSnapshot => ({
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Form",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: ORIGIN, path: "/f", navGen: 1, title: "Form", headings: [], iframes: [], excluded: {}, truncated: false, controls }],
    missing: [], focused: { frameId: 0, id: "e1", selection: [0, 0] },
  });
  /** A note (separate nodes, so a line can be put in between) and a page form; the reader types `typed` as dates. */
  const desk2 = (lines: string[], typed: string[], controls: PageControl[]): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap(lines.map((l, i): Node => ({ key: `n/${i}`, parent: null, role: "AXStaticText", value: l })), { at: 900, windowId: "src", title: "Source", app: { pid: 7002, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, values: typed.map((t) => value("date", t, `n/${lines.findIndex((l) => l.includes(t))}`)) }));
    m.apply(toWindowSnapshot(page([control("e1", "text", "Notes"), ...controls]), session, 1));
    return m;
  };
  const fillDesk = async (m: ScreenModel, picks: Record<string, string>, resolve: ResolveContext = DENVER) => {
    const p = await proposeFill(m, jevPickingText((_id, ins) => Object.entries(picks).find(([k]) => ins.includes(`'${k}'`))?.[1] ?? null), "page:eng1:7", "f0/form[a]/text:notes~0", Date.UTC(2026, 9, 20, 18), { resolve });
    return (name: string) => p.fields.find((f) => f.descriptor.includes(`'${name}'`)) as (typeof p.fields)[number];
  };
  const refusing = <T,>(run: (asked: string[]) => Promise<T>): Promise<T> => {
    const asked: string[] = [];
    setTestVerifier(async (req) => {
      for (const q of Object.values(req.questions)) asked.push(String(q.instructions));
      return { model: "verify-other", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "other", confidence: 0.95 }])), inputTokens: 0, latencyMs: 0, costUsd: 0 };
    });
    return run(asked).finally(() => setTestVerifier(STAND_IN));
  };

  it("a dotted date inside a longer span is read only on evidence, and a hinted one is the value asks' and the verifier's", async () => {
    const plain = desk2(["Appointment: 04.12.1990 at 8:45am"], ["04.12.1990 at 8:45am"], [control("e2", "date", "Appointment date")]);
    expect((await fillDesk(plain, { "Appointment date": "04.12.1990 at 8:45am" }))("Appointment date").handoff).toBeNull();
    const hinted = desk2(["Appointment (MM/DD/YYYY): on 04.12.1990"], ["on 04.12.1990"], [control("e2", "date", "Appointment date")]);
    expect((await fillDesk(hinted, { "Appointment date": "on 04.12.1990" }))("Appointment date").handoff).toBeNull();
    const f = (await fillDesk(hinted, { "Appointment date": "1990-04-12" }))("Appointment date");
    expect([f.handoff?.value, mintOf(f)?.verdict.by]).toEqual(["1990-04-12", "verifier"]);
  });

  it("a date and time input meets the same order evidence: a stated format the locale contradicts reads nothing", async () => {
    const m = desk2(["Appointment (DD/MM/YYYY): 04/12/1990 at 8:45am"], ["04/12/1990 at 8:45am"], [control("e2", "datetime", "Appointment")]);
    const at = await fillDesk(m, { Appointment: "04/12/1990 at 8:45am" }, { ...DENVER, sourceLocale: "en-US" });
    expect(at("Appointment").handoff).toBeNull();
  });

  it("a year counted from a known reference is an assumption the verifier judges, not an exemption", async () => {
    const m = desk2(["Service completed: October 17 at 8:45am"], ["October 17 at 8:45am"], [control("e2", "date", "Last service date")]);
    const ref = { ...DENVER, referenceInstant: "2026-10-20T16:22:00Z" };
    const ok = (await fillDesk(m, { "Last service date": "October 17 at 8:45am" }, ref))("Last service date");
    expect([ok.handoff?.value, mintOf(ok)?.verdict.by]).toEqual(["2027-10-17", "verifier"]);
    await refusing(async (asked) => {
      const no = (await fillDesk(m, { "Last service date": "October 17 at 8:45am" }, ref))("Last service date");
      expect([no.handoff, no.withheld]).toEqual([null, "notExact"]);
      expect(asked.some((q) => /year 2027/u.test(q))).toBe(true);
    });
  });

  it("a century read from a two-digit year is a choice, for a month input and for a year menu", async () => {
    const m = desk2(["Started: Aug '30"], ["Aug '30"], [control("e2", "month", "Start month"), control("e3", "select", "Start date year", { options: [{ value: "", label: "Select...", selected: true }, { value: "1930", label: "1930", selected: false }, { value: "2030", label: "2030", selected: false }] })]);
    await refusing(async () => {
      const at = await fillDesk(m, { "Start month": "Aug '30", "Start date year": "Aug '30" });
      expect([at("Start month").handoff, at("Start date year").handoff]).toEqual([null, null]);
    });
    const at = await fillDesk(m, { "Start month": "Aug '30", "Start date year": "Aug '30" });
    expect([mintOf(at("Start month"))?.verdict.by, mintOf(at("Start date year"))?.verdict.by]).toEqual(["verifier", "verifier"]);
  });

  it("an option a picked span names among other words: vetoed by a negating line, else the verifier's", async () => {
    const opts = { options: [{ value: "", label: "Select...", selected: true }, { value: "sat", label: "Saturday", selected: false }, { value: "sun", label: "Sunday", selected: false }] };
    const no = desk2(["Days I cannot attend: Saturday mornings"], [], [control("e2", "select", "Section", opts)]);
    expect((await fillDesk(no, { Section: "Saturday mornings" }))("Section").handoff).toBeNull();
    const yes = desk2(["Best days: Saturday mornings"], [], [control("e2", "select", "Section", opts)]);
    await refusing(async (asked) => {
      expect((await fillDesk(yes, { Section: "Saturday mornings" }))("Section").handoff).toBeNull();
      expect(asked.some((q) => q.includes("to name the option 'Saturday'"))).toBe(true);
    });
  });

  it("offers a send-line year to the value asks, and pairs the send line with its message again at the recheck", async () => {
    const lines = ["From: Chris", "Sent: October 15, 2026, 10:22 AM", "Appointment: October 17 at 8:45am"];
    const m = desk2(lines, ["October 17 at 8:45am"], [control("e2", "date", "Preferred date")]);
    const { jev, offered } = recording((ins) => (ins.includes("'Preferred date'") ? "2026-10-17" : null));
    const p = await proposeFill(m, jev, "page:eng1:7", "f0/form[a]/text:notes~0", Date.UTC(2026, 9, 15, 18), { resolve: DENVER });
    expect(offered.some((o) => o.startsWith('Preferred date <- "2026-10-17"') && o.includes("the year 2026 is assumed"))).toBe(true);
    const f = p.fields.find((x) => x.descriptor.includes("'Preferred date'")) as (typeof p.fields)[number];
    const mint = mintOf(f)!;
    expect(provenanceStale(m, mint.provenance)).toBeNull();
    // A quoted older message put in between, as its own node, unpairs them.
    m.apply(snap([...[lines[0], lines[1], "Original message from 2025", lines[2]].map((l, i): Node => ({ key: i < 2 ? `n/${i}` : i === 2 ? "n/q" : "n/2", parent: null, role: "AXStaticText", value: l as string }))], { at: 1100, windowId: "src", title: "Source", app: { pid: 7002, bundleId: "com.apple.TextEdit", name: "TextEdit" }, values: [value("date", "October 17 at 8:45am", "n/2")] }));
    expect(provenanceStale(m, mint.provenance)).not.toBeNull();
  });

  it("refuses an exemption for a date that only reads with an assumption, stated or not", () => {
    const contract = makeFieldContract({ windowId: "w", node: { key: "d", parent: null, role: "AXDateField" }, descriptor: "Date field. Label: 'Date'.", name: "Date", labelWords: ["Date"], control: "date", kinds: new Set(["date"]), part: null });
    const window = (span: string): Provenance => ({ kind: "window", windowId: "src", nodeKey: "n", app: "TextEdit", title: "t", span, label: null, line: null, partOf: null, context: null, lines: [], sentences: [] });
    const p = (span: string, text: string) => ({ field: contract, text, display: text, provenance: window(span), owner: null });
    expect(() => mintExempt(p("October 17", "2026-10-17"), "resolverFormat", 1)).toThrow(expect.objectContaining({ code: "chosen" }));
    expect(() => mintExempt(p("04/12/1990", "1990-04-12"), "resolverFormat", 1)).toThrow(expect.objectContaining({ code: "chosen" }));
    expect(mintExempt(p("October 17, 2026", "2026-10-17"), "resolverFormat", 1).verdict).toEqual({ by: "exempt", rule: "resolverFormat" });
  });
});
