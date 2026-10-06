// C1: memory beyond names and emails. An About entry fills a phone, an address or one of its parts, a school, a degree, a
// graduation date, LinkedIn, GitHub and website links, and a yes-or-no work authorization or sponsorship, each read from
// the entry's label; self-identification, consent and secrets never. Jev is a fake that answers by rule; every name,
// number and link is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { aboutKind, aboutValues, fieldAsksFor, type AboutKind, type AboutValue } from "../src/fill/about.ts";
import { proposeFill } from "../src/fill/fill.ts";
import type { Node } from "../src/protocol.ts";
import { field, jevPickingText, snap } from "./builders.ts";

describe("which entries are which kind", () => {
  const table: [string, string, AboutKind | null][] = [
    ["Phone", "555-0101", "phone"],
    ["Mobile", "(512) 555-0147", "phone"],
    ["Home address", "4410 Speedway, Austin, TX 78751", "address"],
    ["Street", "4410 Speedway", "street"],
    ["City", "Austin", "city"],
    ["State", "Texas", "state"],
    ["ZIP code", "78751", "zip"],
    ["Postal code", "L8P 2K4", "zip"],
    ["Country", "United States", "country"],
    ["School", "University of Texas at Austin", "school"],
    ["School name", "Lakeshore Polytechnic Institute", "school"],
    ["Degree", "Bachelor of Science", "degree"],
    ["Graduation date", "May 2027", "gradDate"],
    ["LinkedIn", "https://www.linkedin.com/in/example-sam", "linkedin"],
    ["GitHub", "github.com/example-sam", "github"],
    ["Portfolio", "https://sam.example.com", "website"],
    ["Work authorization", "Yes", "workAuth"],
    ["Authorized to work in the United States", "yes", "workAuth"],
    ["Needs visa sponsorship", "No", "sponsorship"],
    // Shapes that do not fit the label's kind.
    ["Phone", "call me after five", null],
    ["LinkedIn", "ask me", null],
    ["Website", "https://www.linkedin.com/in/example-sam", null],
    ["Graduation date", "next spring", null],
    ["ZIP code", "Austin", null],
    // A yes or no in prose is not said as yes or no: Caret never rewords it into one.
    ["Work authorization", "US citizen; authorized to work in the United States; never needs visa sponsorship", null],
    ["Sponsorship", "will not need it", null],
    // Self-identification, consent and secrets are never a kind.
    ["Gender", "Female", null],
    ["Race / ethnicity", "Asian", null],
    ["Veteran status", "No", null],
    ["Disability", "No", null],
    ["Pronouns", "she/her", null],
    ["Marketing consent", "Yes", null],
    ["Phone password", "555-0101", null],
    ["Card", "4111 1111 1111 1111", null],
    // Kinds C1 does not add.
    ["Current job title", "Field Service Technician", null],
    ["Date of birth", "March 14, 1990", null],
  ];
  it("reads each kind from the entry's label and checks the value's shape", () => {
    expect(table.map(([l, v]) => [l, v, aboutKind(l, v)])).toEqual(table);
  });

  it("keeps the B17 kinds as they were", () => {
    expect(aboutKind("Email for job applications", "ines.vandermeer@example.org")).toBe("email");
    expect(aboutKind("Legal name", "Aurelia Josephine Nakamura")).toBe("name");
  });
});

describe("which fields an entry is offered to", () => {
  const entry = (label: string, value: string): AboutValue => {
    const v = aboutValues([{ id: "e", fields: { label, value, source: "typed" } }])[0];
    if (v === undefined) throw new Error(`${label} is no kind`);
    return v;
  };
  const table: [string, string, string, boolean][] = [
    ["Phone", "555-0101", "Phone", true],
    ["Phone", "555-0101", "Mobile phone", true],
    ["Phone", "555-0101", "Phone number", true],
    ["Phone", "555-0101", "Emergency contact phone", false],
    ["Phone", "555-0101", "Home phone", false],
    ["Phone", "555-0101", "Work phone", false],
    ["Home address", "4410 Speedway, Austin, TX 78751", "Address", true],
    ["Home address", "4410 Speedway, Austin, TX 78751", "Billing address", false],
    ["Street", "4410 Speedway", "Street address", true],
    ["City", "Austin", "City", true],
    ["City", "Austin", "City of birth", false],
    ["ZIP code", "78751", "ZIP / Postal code", true],
    ["Country", "United States", "Country of residence", true],
    ["Country", "United States", "Country of citizenship", false],
    ["School", "University of Texas at Austin", "School", true],
    ["School", "University of Texas at Austin", "University", true],
    ["School", "University of Texas at Austin", "High school", false],
    ["Degree", "Bachelor of Science", "Degree", true],
    ["Graduation date", "May 2027", "Expected graduation date", true],
    ["LinkedIn", "https://www.linkedin.com/in/example-sam", "LinkedIn Profile", true],
    ["LinkedIn", "https://www.linkedin.com/in/example-sam", "Website", false],
    ["GitHub", "https://github.com/example-sam", "GitHub URL", true],
    ["Portfolio", "https://sam.example.com", "Portfolio URL", true],
    ["Portfolio", "https://sam.example.com", "Personal website", true],
    // A company's website on a sales form is not the user's.
    ["Portfolio", "https://sam.example.com", "Website URL", false],
    ["Portfolio", "https://sam.example.com", "Other Website", false],
    ["Work authorization", "Yes", "Are you authorized to work in your country of residence?", true],
    // A question that names a country is answered only by an entry that names it.
    ["Work authorization", "Yes", "Are you legally authorized to work in the United States?", false],
    ["Authorized to work in the United States", "Yes", "Are you legally authorized to work in the United States?", true],
    ["Work authorization", "Yes", "Will you now or in the future require sponsorship for employment visa status?", false],
    ["Needs visa sponsorship", "No", "Will you now or in the future require sponsorship for employment visa status?", true],
    // Self-identification and consent are never asked for, whatever the entry.
    ["Work authorization", "Yes", "Are you a protected veteran authorized to work?", false],
    ["City", "Austin", "Gender", false],
    ["Phone", "555-0101", "I consent to texts at this phone", false],
  ];
  it("offers an entry only to a field that asks for exactly its kind", () => {
    expect(table.map(([l, v, f]) => [l, v, f, fieldAsksFor(entry(l, v), f)])).toEqual(table);
  });
});

describe("a form filled from what the user told Caret", () => {
  it("fills a phone, a LinkedIn link, a school and a degree, and hands off a yes for a work question", async () => {
    const m = new ScreenModel();
    const F = (s: string): string => `dev.caret.fixture/standard/${s}`;
    const radio = (key: string, label: string, y: number): Node => ({ key: F(`radio:${key}`), parent: F("group:auth"), role: "AXRadioButton", label, editable: true, frame: [100, y, 40, 20] });
    const nodes: Node[] = [
      field(F("phone"), "", { label: "Phone", frame: [100, 100, 200, 24] }),
      field(F("linkedin"), "", { label: "LinkedIn Profile", frame: [100, 140, 200, 24] }),
      field(F("school"), "", { label: "School", frame: [100, 180, 200, 24] }),
      field(F("degree"), "", { label: "Degree", frame: [100, 220, 200, 24] }),
      field(F("gender"), "", { label: "Gender", frame: [100, 260, 200, 24] }),
      { key: F("group:auth"), parent: null, role: "AXGroup", label: "Are you authorized to work in your country of residence?", frame: [100, 300, 300, 60] },
      radio("yes", "Yes", 320),
      radio("no", "No", 340),
    ];
    m.apply(snap(nodes, { at: 2000, windowId: "5150-7", title: "Application", focused: true }));
    const about = aboutValues(
      (
        [
          ["Phone", "555-0101"],
          ["LinkedIn", "https://www.linkedin.com/in/example-sam"],
          ["School", "University of Texas at Austin"],
          ["Degree", "Bachelor of Science"],
          ["Work authorization", "Yes"],
          ["Gender", "Female"],
        ] as const
      ).map(([label, value], i) => ({ id: `about-${i}`, fields: { label, value, source: "typed" as const } })),
    );
    const want: Record<string, string> = { "'Phone'": "555-0101", "'LinkedIn Profile'": "https://www.linkedin.com/in/example-sam", "'School'": "University of Texas at Austin", "'Degree'": "Bachelor of Science", "country of residence": "Yes", "'Gender'": "Female" };
    const jev = jevPickingText((_id, ins) => Object.entries(want).find(([k]) => ins.includes(k))?.[1] ?? null);
    const p = await proposeFill(m, jev, "5150-7", F("phone"), 3000, { about });
    const got = Object.fromEntries(p.fields.map((f) => [f.key.split("/").pop(), f.value ?? f.handoff?.value ?? null]));
    expect(got).toEqual({ phone: "555-0101", linkedin: "https://www.linkedin.com/in/example-sam", school: "University of Texas at Austin", degree: "Bachelor of Science", gender: null, "group:auth": "Yes" });
    expect(p.fields.find((f) => f.key === F("phone"))?.memory).toEqual({ id: "about-0", label: "Phone", says: "what you told Caret" });
  });
});
