// C1: what code reads inside one line (fill/line-values.ts). Each value must be a span of the line exactly as written,
// so these tests pin the exact spans, and what is never offered. Every name, number and address is invented.
import { describe, expect, it } from "vitest";
import { bareLine, clauseAround, lineTexts, lineValues } from "../src/fill/line-values.ts";

const values = (line: string): [string, string][] => lineValues(line).map((v) => [v.kind, v.text]);
const texts = (line: string): [string, string | null][] => lineTexts(line).map((t) => [t.text, t.label]);

describe("typed values inside a line", () => {
  it("finds a phone inside a short sentence and a date inside a long one", () => {
    expect(values("Mobile 555-0164 (no landline anymore).")).toEqual([["phone", "555-0164"]]);
    expect(values("I graduate from UT Austin in May 2027 with a BS in Computer Science")).toEqual([["date", "May 2027"]]);
  });

  it("finds every value of a line, in order, each a span of it", () => {
    const line = "Emergency contact: my husband Marcus Cole, 555-0171, marcus.cole@example.net";
    expect(values(line)).toEqual([
      ["phone", "555-0171"],
      ["email", "marcus.cole@example.net"],
    ]);
    for (const v of lineValues(line)) expect(line.slice(v.at, v.at + v.text.length)).toBe(v.text);
  });

  it("reads the date forms a note uses, and no bare year or month", () => {
    expect(values("Sunday, October 18, 2026 is the earliest you could start.")).toEqual([["date", "October 18, 2026"]]);
    expect(values("born 14 March 1990, moved 2026-11-01, renewed 11/01/2026")).toEqual([
      ["date", "14 March 1990"],
      ["date", "2026-11-01"],
      ["date", "11/01/2026"],
    ]);
    expect(values("Copperline Fabrication, assembly tech, 2021-2022. Since 2020. In May.")).toEqual([]);
  });

  it("reads phones in their usual groups and nothing inside longer digit runs", () => {
    expect(values("call (512) 555-0147 or +1 415 555 0142 or 512.555.0199")).toEqual([
      ["phone", "(512) 555-0147"],
      ["phone", "+1 415 555 0142"],
      ["phone", "512.555.0199"],
    ]);
    expect(values("ZIP+4 97214-1234, order 20261-0042, range 2021-2022")).toEqual([]);
  });

  it("reads web addresses and emails without their closing punctuation, an email never as a link", () => {
    expect(values("See https://www.linkedin.com/in/example-jo, or mail jo@example.org.")).toEqual([
      ["url", "https://www.linkedin.com/in/example-jo"],
      ["email", "jo@example.org"],
    ]);
  });

  it("reads a postal code only where the line shows it as one", () => {
    expect(values("Address: 2210 Willow Bend Drive, Apt 5B, Portland, Oregon 97214")).toEqual([["address", "97214"]]);
    expect(values("112 Birchmount Road, Hamilton, L8P 2K4.")).toEqual([["address", "L8P 2K4"]]);
    expect(values("Invoice 97214 is paid")).toEqual([]);
  });

  it("gives nothing from a line that shows or is labelled as a value Caret never types", () => {
    expect(values("Card 4111 1111 1111 1111, billing phone 555-0199")).toEqual([]);
    expect(values("SSN 123-45-6789 on file since 2026-01-01")).toEqual([]);
    expect(values("Password: 555-0199 since May 2021")).toEqual([]);
    expect(texts("Passport number: Lakeshore Polytechnic Institute, Oakland, California")).toEqual([]);
  });
});

describe("free text a line bounds", () => {
  it("takes a labelled value before its remark in parentheses, quoting the remark, and none before a warning", () => {
    expect(lineTexts("Preferred first name: Dima (legal name Dmitri Halvorsen).")).toEqual([{ text: "Dima", label: "Preferred first name", with: "Dima (legal name Dmitri Halvorsen)." }]);
    // C1 review: a remark that warns against the value keeps it whole.
    expect(texts("Preferred first name: Alex (do not use this old name; use Robin instead for all future applications).")).toEqual([]);
    expect(texts("Phone: 555-0101 (my old number, no longer works)")).toEqual([]);
  });

  it("takes no first part that the next part may continue", () => {
    // C1 review: "University of California" is not the school "University of California, Berkeley".
    expect(texts("School: University of California, Berkeley, Bachelor of Science in Electrical Engineering, graduating May 2027")).toEqual([]);
    expect(texts("School: Stanford University, Palo Alto, California")).toEqual([["Palo Alto, California", null]]);
  });

  it("takes a labelled value's first part when it is a whole name", () => {
    expect(texts("School: Lakeshore Polytechnic Institute, B.S. Electrical Engineering, September 2016 to May 2020.")).toEqual([["Lakeshore Polytechnic Institute", "School"]]);
    expect(texts("Name: Josephine Abernathy-Cole, but everyone calls me Jo. Pronouns she/her.")).toEqual([["Josephine Abernathy-Cole", "Name"]]);
  });

  it("takes the one name that ends a person label's first part, and no other part", () => {
    expect(texts("Emergency contact: my husband Marcus Cole, 555-0171, marcus.cole@example.net")).toEqual([["Marcus Cole", "Emergency contact"]]);
    // Not a person's label: a subject's capitalized words are not offered as a name.
    expect(texts("Subject: Field Robotics Technician: next steps")).toEqual([]);
    expect(texts("Reference: Dr. Simone Achebe at Ridgeline, Ridgeline Outdoor Co")).toEqual([]);
  });

  it("never breaks a list into items", () => {
    expect(texts("Languages: English, Spanish")).toEqual([]);
    expect(texts("Address: 2210 Willow Bend Drive, Apt 5B, Portland, Oregon 97214")).toEqual([["Portland, Oregon", null]]);
  });

  it("takes a US place written City, State from a sentence, after the words a sentence capitalizes", () => {
    expect(texts("Moving to San Diego, California in November and will work from there. San Jose is only until the move.")).toEqual([["San Diego, California", null]]);
    expect(texts("I live in Portland, Maine, not Oregon.")).toEqual([["Portland, Maine", null]]);
    expect(texts("In Austin, Texas for now")).toEqual([["Austin, Texas", null]]);
    // A state's two-letter code is no place's: "Jo, OK" is a greeting.
    expect(texts("Hi Jo, OK so we meet Tuesday")).toEqual([]);
  });
});

describe("the clause a value's description quotes", () => {
  it("is the sentence around the value, cut at its end", () => {
    const line = "Cell: 555-0147. Don't give out 555-0112, that's Mom and Dad's landline.";
    expect(clauseAround(line, line.indexOf("555-0112"), "555-0112")).toBe("Don't give out 555-0112, that's Mom and Dad's landline.");
    expect(clauseAround(line, line.indexOf("555-0147"), "555-0147")).toBe("Cell: 555-0147.");
  });

  it("is cut to whole words around the value in a long sentence", () => {
    const line = "Also, the coordinator there told me orientation for new volunteers is Sunday, October 18, 2026, so that's the earliest you could start.";
    const c = clauseAround(line, line.indexOf("October 18, 2026"), "October 18, 2026") as string;
    expect(c.length).toBeLessThanOrEqual(90);
    expect(c).toContain("October 18, 2026");
    expect(line).toContain(c);
    expect(c).toBe("for new volunteers is Sunday, October 18, 2026, so that's the earliest you could");
  });

  it("is null when the clause is the value", () => {
    expect(clauseAround("555-0147", 0, "555-0147")).toBeNull();
  });
});

describe("a note's line", () => {
  it("loses its list mark and extra space", () => {
    expect(bareLine("  -   Cell:  555-0147. ")).toBe("Cell: 555-0147.");
    expect(bareLine("• Phone: 555-0101")).toBe("Phone: 555-0101");
    expect(bareLine("-5 degrees")).toBe("-5 degrees");
  });
});

describe("the clause of a value with a remark", () => {
  it("takes the remark in brackets right after the value", () => {
    const line = "Phone: 555-0101 (my old number, no longer works)";
    expect(clauseAround(line, line.indexOf("555-0101"), "555-0101")).toBe("Phone: 555-0101 (my old number, no longer works)");
  });
});
