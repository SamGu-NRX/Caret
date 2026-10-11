// C2 (lead decision 4): more About kinds, from explicit About entries only, each read by code from the entry's label: a
// date of birth, a job title, a T-shirt size, dietary needs, a salary expectation, and how the user heard about a job.
// Each is offered only to a field that asks for exactly it; a field that only resembles one ("Salary range", "Title",
// "Child's date of birth") never sees it. Jev is a fake that answers by rule; every name and value is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { aboutKind, aboutValues, fieldAsksFor, type AboutKind, type AboutValue } from "../src/fill/about.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PROTOCOL_VERSION, type PageControl, type PageSnapshot } from "../src/protocol.ts";
import { field, jevPickingText, snap } from "./builders.ts";

describe("which entries are the new kinds", () => {
  const table: [string, string, AboutKind | null][] = [
    ["Date of birth", "March 14, 1990", "birthDate"],
    ["date of birth", "1990-03-14", "birthDate"],
    ["Birthday", "14 March 1990", "birthDate"],
    ["DOB", "March 14, 1990", "birthDate"],
    ["Current job title", "Field Service Technician", "jobTitle"],
    ["Job title", "Senior Platform Engineer", "jobTitle"],
    ["T-shirt size", "M", "shirtSize"],
    ["Shirt size", "Medium", "shirtSize"],
    ["diet", "vegetarian", "diet"],
    ["Dietary needs", "gluten-free", "diet"],
    ["salary expectation", "$185,000", "salary"],
    ["Expected salary", "$120k-$140k", "salary"],
    ["how I heard about Kestrel Robotics", "Recruiter outreach", "heard"],
    ["How I heard about you", "A friend", "heard"],
    // A label about someone else, or a shape that is not the kind's.
    ["Spouse's date of birth", "June 2, 1988", null],
    ["Date of birth", "spring", null],
    ["Title", "Mr", null],
    ["Job title", "ask me later, I'm between roles right now and the title depends on the offer", null],
    ["T-shirt size", "blue", null],
    ["Diet", "I eat almost anything but please no mushrooms, thanks", null],
    ["Salary range", "$100,000", null],
    ["Salary expectation", "negotiable", null],
    ["Current salary", "$90,000", null],
    ["how I heard about Kestrel Robotics", "https://example.com/jobs", null],
  ];
  it("reads each kind from the entry's label and checks the value's shape", () => {
    expect(table.map(([l, v]) => [l, v, aboutKind(l, v)])).toEqual(table);
  });
});

describe("which fields a new kind is offered to", () => {
  const entry = (label: string, value: string): AboutValue => {
    const v = aboutValues([{ id: "e", fields: { label, value, source: "typed" } }])[0];
    if (v === undefined) throw new Error(`${label} is no kind`);
    return v;
  };
  const table: [string, string, string, boolean][] = [
    ["Date of birth", "March 14, 1990", "Date of birth", true],
    ["Date of birth", "March 14, 1990", "Birthday", true],
    ["Date of birth", "March 14, 1990", "DOB", true],
    ["Date of birth", "March 14, 1990", "Child's date of birth", false],
    ["Date of birth", "March 14, 1990", "Spouse date of birth", false],
    ["Date of birth", "March 14, 1990", "Birth year", false],
    ["Date of birth", "March 14, 1990", "Place of birth", false],
    ["Current job title", "Field Service Technician", "Job title", true],
    ["Current job title", "Field Service Technician", "Current job title", true],
    ["Current job title", "Field Service Technician", "Title", false],
    ["Current job title", "Field Service Technician", "Reference 1 job title", false],
    ["Current job title", "Field Service Technician", "Job title at previous employer", false],
    ["T-shirt size", "M", "T-shirt size", true],
    ["T-shirt size", "M", "Shirt size", true],
    ["T-shirt size", "M", "Size", false],
    ["T-shirt size", "M", "Child's T-shirt size", false],
    ["diet", "vegetarian", "Dietary needs", true],
    ["diet", "vegetarian", "Dietary restrictions", true],
    ["diet", "vegetarian", "Guest dietary needs", false],
    ["diet", "vegetarian", "Allergies", false],
    ["salary expectation", "$185,000", "What are your salary expectations?", true],
    ["salary expectation", "$185,000", "Desired salary", true],
    ["salary expectation", "$185,000", "Expected salary", true],
    ["salary expectation", "$185,000", "Salary range", false],
    ["salary expectation", "$185,000", "Current salary", false],
    ["salary expectation", "$185,000", "Salary range for this role", false],
    ["how I heard about Kestrel Robotics", "Recruiter outreach", "How did you hear about Kestrel Robotics?", true],
    ["how I heard about Kestrel Robotics", "Recruiter outreach", "Who referred you?", false],
    ["how I heard about Kestrel Robotics", "Recruiter outreach", "Referrer's name", false],
  ];
  it("offers an entry only to a field that asks for exactly its kind", () => {
    expect(table.map(([l, v, f]) => [l, v, f, fieldAsksFor(entry(l, v), f)])).toEqual(table);
  });

  it("offers how the user heard about one company only on that company's form", () => {
    const e = entry("how I heard about Kestrel Robotics", "Recruiter outreach");
    expect(fieldAsksFor(e, "How did you hear about this job?", "Kestrel Robotics: Embedded Firmware Engineer")).toBe(true);
    expect(fieldAsksFor(e, "How did you hear about this job?", "Juniper Freight: Platform Security Engineer")).toBe(false);
    expect(fieldAsksFor(e, "How did you hear about this job?")).toBe(false);
    // An entry that names no company answers any form's question.
    expect(fieldAsksFor(entry("How I heard about you", "A friend"), "How did you hear about us?", "Riverside Food Bank")).toBe(true);
  });
});

const ORIGIN = "http://127.0.0.1:4310";
const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
const WIN = "page:eng1:7";
const control = (id: string, kind: PageControl["kind"], name: string, extra: Partial<PageControl> = {}): PageControl => ({ id, key: `form[f]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: kind, name, form: "form#f", rect: [0, 0, 100, 20], ...extra });
const select = (id: string, name: string, options: string[]): PageControl =>
  control(id, "select", name, { options: [{ value: "", label: "Select...", selected: true }, ...options.map((o) => ({ value: o.toLowerCase(), label: o, selected: false }))] });

describe("a page form filled from the new kinds", () => {
  it("writes a birth date in the date input's format, an option named as the entry, and text as typed", async () => {
    const page: PageSnapshot = {
      type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Volunteer onboarding",
      frames: [{
        frameId: 0, parentFrameId: -1, documentId: "D0", origin: ORIGIN, path: "/onboard", navGen: 1, title: "Volunteer onboarding", headings: [], iframes: [], excluded: {}, truncated: false,
        controls: [
          control("e1", "text", "First name", { value: "" }),
          control("e2", "date", "Date of birth", { value: "" }),
          control("e3", "text", "Job title", { value: "" }),
          select("e4", "T-shirt size", ["XS", "S", "M", "L", "XL"]),
          select("e5", "Dietary needs", ["None", "Vegetarian", "Vegan"]),
          control("e6", "text", "What are your salary expectations?", { value: "" }),
          control("e7", "text", "Salary range", { value: "" }),
        ],
      }],
      missing: [],
      focused: { frameId: 0, id: "e1", selection: [0, 0] },
    };
    const m = new ScreenModel();
    m.apply(snap([field("te/note", "Signup\nFirst name: Jo", { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
    m.apply(toWindowSnapshot(page, session, 1));
    const about = aboutValues(
      [["date of birth", "March 14, 1990"], ["current job title", "Field Service Technician"], ["t-shirt size", "M"], ["diet", "vegetarian"], ["salary expectation", "$185,000"]].map(([label, value], i) => ({
        id: `about-${i}`,
        fields: { label: label as string, value: value as string, source: "typed" as const },
      })),
    );
    // Jev picks the entry whose value is quoted, for any field it is offered to (a fake that agrees with itself).
    const want: Record<string, string> = { "'First name'": "Jo", "'Date of birth'": "March 14, 1990", "'Job title'": "Field Service Technician", "'T-shirt size'": "M", "'Dietary needs'": "vegetarian", "salary expectations": "$185,000", "'Salary range'": "$185,000" };
    const p = await proposeFill(m, jevPickingText((_id, ins) => Object.entries(want).find(([k]) => ins.includes(k))?.[1] ?? null), WIN, "f0/form[f]/text:first name~0", 2000, { about });
    const got = Object.fromEntries(p.fields.map((f) => [f.descriptor.match(/Label: '([^']+)'/u)?.[1] ?? f.key, f.value ?? (f.handoff === null ? null : [f.handoff.value, f.handoff.writes === true, f.handoff.memory?.id ?? null])]));
    expect(got).toEqual({
      "First name": "Jo",
      "Date of birth": ["1990-03-14", true, "about-0"],
      "Job title": "Field Service Technician",
      "T-shirt size": ["M", true, "about-2"],
      "Dietary needs": ["Vegetarian", true, "about-3"],
      "What are your salary expectations?": "$185,000",
      "Salary range": null,
    });
  });
});
