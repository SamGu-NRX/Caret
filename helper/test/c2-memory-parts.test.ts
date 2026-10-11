// C2 (lead decision 5): one About entry, several parts. FillMemory.part widens from a name's first, middle and last to an
// address's street, unit, city, state and ZIP code and a date's month, day and year, so one "Home address" entry fills
// Street, City, State and ZIP, and one "Date of birth" entry fills a month, day and year menu. Each part is a substring
// of the entry, split again by code whenever the entry is checked. Jev is a fake that answers by rule; every name,
// address and date is invented.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { aboutValues, fieldAsksForPart } from "../src/fill/about.ts";
import { memoryRefOf, memoryValue, memoryWrites, parseMemoryRef, proposeFill } from "../src/fill/fill.ts";
import { dateParts } from "../src/fill/derive.ts";
import { FillMemory, FillProposal } from "../src/protocol.ts";
import type { Node } from "../src/protocol.ts";
import { field, jevPickingText, snap } from "./builders.ts";

const ADDRESS = "2210 Willow Bend Drive, Apt 5B, Portland, Oregon 97214";
const BORN = "March 14, 1990";

describe("the parts of one entry", () => {
  it("splits an address and a date into the parts a field may ask for, each as the entry writes it", () => {
    expect(["street", "unit", "city", "state", "zip"].map((p) => memoryValue(ADDRESS, p as FillMemory["part"]))).toEqual(["2210 Willow Bend Drive", "Apt 5B", "Portland", "Oregon", "97214"]);
    expect(["month", "day", "year"].map((p) => memoryValue(BORN, p as FillMemory["part"]))).toEqual(["March", "14", "1990"]);
    expect(dateParts("14 March 1990")).toEqual({ month: "March", day: "14", year: "1990" });
    expect(dateParts("1990-03-14")).toEqual({ month: "03", day: "14", year: "1990" });
    expect(dateParts("March 1990")).toEqual({ month: "March", day: null, year: "1990" });
    expect(dateParts("next spring")).toBeNull();
    // A part the entry does not hold is none.
    expect(memoryValue("2210 Willow Bend Drive, Portland, Oregon 97214", "unit")).toBeNull();
  });

  it("names a part in a step's memory reference and reads it back", () => {
    for (const part of ["first", "street", "unit", "city", "state", "zip", "month", "day", "year"] as const) {
      expect(parseMemoryRef(memoryRefOf({ id: "about-3", part }))).toEqual({ id: "about-3", part, conv: "exact" });
    }
    expect(parseMemoryRef("about-3#country")).toEqual({ id: "about-3#country", part: undefined, conv: "exact" });
  });

  it("checks a part again by splitting the entry as it reads now", () => {
    expect(memoryWrites(ADDRESS, "zip", "97214")).toBe(true);
    expect(memoryWrites(ADDRESS.replace("97214", "97215"), "zip", "97214")).toBe(false);
    expect(memoryWrites(BORN, "month", "March")).toBe(true);
    // A month menu listing numbers took "03" for March.
    expect(memoryWrites(BORN, "month", "03", "option")).toBe(true);
    expect(memoryWrites("April 14, 1990", "month", "03", "option")).toBe(false);
    expect(memoryWrites(BORN, "month", "03")).toBe(false);
    expect(memoryWrites(BORN, "day", "14")).toBe(true);
    expect(memoryWrites(BORN, "year", "1991")).toBe(false);
  });

  it("is a protocol part, and only these", () => {
    for (const part of ["first", "middle", "last", "street", "unit", "city", "state", "zip", "month", "day", "year"]) expect(FillMemory.safeParse({ id: "a", label: "Home address", says: "what you told Caret", part }).success).toBe(true);
    expect(FillMemory.safeParse({ id: "a", label: "Home address", says: "what you told Caret", part: "country" }).success).toBe(false);
  });
});

describe("which fields a part is offered to", () => {
  const entry = (label: string, value: string) => {
    const v = aboutValues([{ id: "e", fields: { label, value, source: "typed" } }])[0];
    if (v === undefined) throw new Error(`${label} is no kind`);
    return v;
  };
  const table: [string, string, string, string, boolean][] = [
    ["Home address", ADDRESS, "Street address", "street", true],
    ["Home address", ADDRESS, "Address line 1", "street", true],
    ["Home address", ADDRESS, "Apartment, suite, etc.", "unit", true],
    ["Home address", ADDRESS, "City", "city", true],
    ["Home address", ADDRESS, "State / Province", "state", true],
    ["Home address", ADDRESS, "ZIP code", "zip", true],
    ["Home address", ADDRESS, "Postal code", "zip", true],
    ["Home address", ADDRESS, "Emergency contact city", "city", false],
    ["Home address", ADDRESS, "Billing ZIP code", "zip", false],
    ["Home address", ADDRESS, "Mailing city", "city", false],
    ["Mailing address", ADDRESS, "Mailing city", "city", true],
    ["Date of birth", BORN, "Date of birth month", "month", true],
    ["Date of birth", BORN, "Birth year", "year", true],
    ["Date of birth", BORN, "Date of birth day", "day", true],
    ["Date of birth", BORN, "Month", "month", false],
    ["Date of birth", BORN, "Child's birth year", "year", false],
    ["Graduation date", "May 2021", "Graduation date month", "month", true],
    ["Graduation date", "May 2021", "Start date month", "month", false],
  ];
  it("offers a part only to a field that asks for that part of exactly the entry's kind", () => {
    expect(table.map(([l, v, f, p]) => [l, v, f, p, fieldAsksForPart(entry(l, v), f, p as never)])).toEqual(table);
  });
});

describe("a form filled from one address entry and one date entry", () => {
  const F = (s: string): string => `dev.caret.fixture/standard/${s}`;
  const menu = (key: string, label: string, options: string[], y: number): Node[] => [
    { key: F(key), parent: null, role: "AXPopUpButton", label, value: "Select...", editable: true, frame: [100, y, 200, 24] },
    ...options.map((o, i): Node => ({ key: F(`${key}/item${i}`), parent: F(key), role: "AXMenuItem", label: o })),
  ];
  it("fills street, unit, city, state, ZIP and a birth month, day and year, each named as a part of its entry", async () => {
    const m = new ScreenModel();
    m.apply(snap([field("te/note", "Signup\nName: Jo Cole", { role: "AXTextArea" })], { at: 1000, windowId: "7001-1", title: "Notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
    const nodes: Node[] = [
      field(F("street"), "", { label: "Street address", frame: [100, 60, 200, 24] }),
      field(F("unit"), "", { label: "Apartment, suite, etc.", frame: [100, 100, 200, 24] }),
      field(F("city"), "", { label: "City", frame: [100, 140, 200, 24] }),
      ...menu("state", "State", ["Ohio", "Oregon", "Texas"], 180),
      field(F("zip"), "", { label: "ZIP code", frame: [100, 220, 200, 24] }),
      ...menu("month", "Date of birth month", ["January", "February", "March", "April"], 260),
      ...menu("day", "Date of birth day", ["12", "13", "14", "15"], 300),
      ...menu("year", "Date of birth year", ["1989", "1990", "1991"], 340),
      field(F("emcity"), "", { label: "Emergency contact city", frame: [100, 380, 200, 24] }),
    ];
    m.apply(snap(nodes, { at: 2000, windowId: "5150-7", title: "Volunteer signup", focused: true }));
    const about = aboutValues([
      { id: "about-1", fields: { label: "Home address", value: ADDRESS, source: "typed" } },
      { id: "about-2", fields: { label: "Date of birth", value: BORN, source: "typed" } },
    ]);
    const want: Record<string, string> = { "'Street address'": "2210 Willow Bend Drive", "'Apartment, suite, etc.'": "Apt 5B", "'City'": "Portland", "'State'": "Oregon", "'ZIP code'": "97214", "'Date of birth month'": "March", "'Date of birth day'": "14", "'Date of birth year'": "1990", "'Emergency contact city'": "Portland" };
    const p = await proposeFill(m, jevPickingText((_id, ins) => Object.entries(want).find(([k]) => ins.includes(k))?.[1] ?? null), "5150-7", F("street"), 3000, { about });
    const got = Object.fromEntries(p.fields.map((f) => [f.key.split("/").pop(), [f.value ?? f.handoff?.value ?? null, (f.memory ?? f.handoff?.memory)?.part ?? null]]));
    expect(got).toEqual({
      street: ["2210 Willow Bend Drive", "street"],
      unit: ["Apt 5B", "unit"],
      city: ["Portland", "city"],
      state: ["Oregon", "state"],
      zip: ["97214", "zip"],
      month: ["March", "month"],
      day: ["14", "day"],
      year: ["1990", "year"],
      emcity: [null, null],
    });
  });
});

describe("the golden lines the host copies", () => {
  it("parses fill-memory-parts.ndjson and writes it back byte for byte", () => {
    const lines = readFileSync(new URL("../fixtures/golden/fill-memory-parts.ndjson", import.meta.url), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const p = FillProposal.parse(JSON.parse(lines[0] as string));
    expect(JSON.stringify(p)).toBe(lines[0]);
    expect(p.fields.map((f) => (f.memory ?? f.handoff?.memory)?.part ?? null)).toEqual(["street", "zip", "month", "year"]);
  });
});
