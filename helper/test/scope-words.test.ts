// B28: the words code reads as asking for the whole form or for a section. Each list entry has one right answer
// per instruction, so each is tested alone here; test/ask.test.ts runs them through planAsk.
import { describe, expect, it } from "vitest";
import { FILLER, namedSection, namesTheForm, SECTION_FILLER, SECTION_WORDS, WHOLE_FORM_WORDS, wholeFormPhrase } from "../src/planner/scope-words.ts";

const TITLE = "Rental Application | Cedar Court Apartments";

describe("wholeFormPhrase", () => {
  it.each([
    ["fill out", "fill out"],
    ["fill out", "fill it out from my note"],
    ["fill out", "Fill this out, thanks"],
    ["fill out", "fill out the form from what I jotted down"],
    ["fill out", "fill out this application"],
    ["fill in everything", "fill in everything"],
    ["everything", "just do everything for me"],
    ["the whole form", "do the whole form"],
    ["all of it", "all of it please"],
    ["the rest", "do the rest from my note"],
    ["the rest", "do the rest of this form"],
    ["what you can", "fill in what you can"],
    ["what you can", "fill whatever you can"],
    ["this form", "please handle this form"],
    ["this application", "help me with this application"],
    ["fill out the <form name>", "fill out the rental application from my note"],
    ["fill out the <form name>", "fill out the Cedar Court application, please"],
  ])("reads '%s' in %j", (phrase, instruction) => {
    expect(wholeFormPhrase(instruction, TITLE)).toBe(phrase);
  });

  it("lets only its filler words stand beside a phrase, and pins both filler lists", () => {
    expect([...FILLER].sort()).toEqual(["a", "ahead", "all", "and", "application", "can", "complete", "could", "do", "everything", "fill", "finish", "for", "form", "go", "handle", "help", "hey", "in", "just", "me", "my", "now", "of", "ok", "okay", "on", "out", "please", "pls", "plz", "thank", "thanks", "the", "then", "this", "up", "with", "would", "you"]);
    expect([...SECTION_FILLER].filter((w) => !FILLER.has(w)).sort()).toEqual(["only"]);
    expect(wholeFormPhrase("hey can you just do this form for me now, thanks", TITLE)).toBe("this form");
    expect(wholeFormPhrase("hey can you just do this form for my landlord", TITLE)).toBeNull();
  });

  it("has a case above for every phrase on the list", () => {
    expect(WHOLE_FORM_WORDS.map((p) => p.says)).toEqual(["fill out", "fill in everything", "everything", "the whole form", "all of it", "the rest", "what you can", "this form", "this application"]);
  });

  it.each([
    // "fill out" with a field as its object names that field, not the form.
    "fill out my email",
    "fill out the phone from my note",
    // "fill out the X" where X is not the form's title.
    "fill out the pizza order",
    // Section phrases name a part of the form, never the whole.
    "just do my contact info up top",
    "fill in my details",
    "fill in everything in my contact info",
    // A word that narrows or negates turns the phrase over to Jev.
    "just my email, leave the rest",
    "everything but the phone",
    "fill out everything except LinkedIn",
    "don't do the whole form",
    "only the rest of the address",
    // Quoted text is a value, and a source phrase is where values come from.
    "Write 'fill in everything' in Notes",
    "my email from the 'everything' note",
    // Naming no field is not asking for the form.
    "sort this out for me please",
    "name + email only pls",
    // A whole-form phrase beside any word that is not filler may ask for less: here, a field (B28 reviews; the form's
    // label may read "E-mail address", so the word need not match a label).
    "fill the rest of the address",
    "just fill my email on this form",
    "put everything from my note in Notes",
    "fill in everything, the phone is (512) 555-0147",
    "Write ‘everything’ in Notes",
    // A quoted field, and part of a field.
    'fill "Email" on this form',
    "do the rest of the address",
    // A source phrase that holds more than a source, a section inside one, and words that point at one value (B28
    // third review).
    "do everything from my note except email",
    "do everything in my details except email",
    "put that in this form",
    "do it on this form",
  ])("reads no whole-form phrase in %j", (instruction) => {
    expect(wholeFormPhrase(instruction, TITLE)).toBeNull();
  });

  it("lets a source phrase stand beside the phrase when it holds only source words", () => {
    expect(wholeFormPhrase("fill out the form from Dana's latest note", TITLE)).toBe("fill out");
    expect(wholeFormPhrase("do everything from what Dana sent me", TITLE)).toBe("everything");
  });

  it("lets the form's own name share a word with a field ('the pizza order', 'Pizza Size')", () => {
    expect(wholeFormPhrase("fill out the pizza order from my note", "Pizza order")).toBe("fill out the <form name>");
    expect(wholeFormPhrase("fill out the pizza order, large size", "Pizza order")).toBeNull();
  });
});

describe("namesTheForm", () => {
  it("needs a run of the title's words ending in 'form' or 'application', or a whole part of the title", () => {
    expect(namesTheForm("rental application", TITLE)).toBe(true);
    expect(namesTheForm("Cedar Court form", TITLE)).toBe(true);
    expect(namesTheForm("Northgate application", "Northgate Analytics - Data Analyst")).toBe(true);
    expect(namesTheForm("pizza order", "Pizza order")).toBe(true);
    expect(namesTheForm("data analyst", "Northgate Analytics - Data Analyst")).toBe(true);
    expect(namesTheForm("pizza order", "httpbin.org/forms/post")).toBe(false);
    expect(namesTheForm("landlord application", TITLE)).toBe(false);
    expect(namesTheForm("application", TITLE)).toBe(false);
    // Words scattered through the title, or a part of one of its parts, do not name the form (B28 third review).
    expect(namesTheForm("email only", "Email signup | Members only")).toBe(false);
    expect(namesTheForm("email", "Email signup | Members only")).toBe(false);
    expect(namesTheForm("court", TITLE)).toBe(false);
  });
});

describe("namedSection", () => {
  const SECTIONS = ["Contact information", "Education", "Links"];
  it("has a case below for every phrase on the list", () => {
    expect(SECTION_WORDS.map((p) => p.says)).toEqual(["contact info", "up top", "my details"]);
  });

  it("maps 'contact info' to the one section named for contact, and asks when there is none or two", () => {
    expect(namedSection("just do my contact info", SECTIONS, "Contact information")).toEqual({ phrases: ["contact info"], section: "Contact information", why: null });
    expect(namedSection("my contact details please", SECTIONS, null).section).toBe("Contact information");
    expect(namedSection("my contact information", ["Contact", "Emergency contact"], "Contact").section).toBeNull();
    expect(namedSection("just do my contact info up top", [], null)).toEqual({ phrases: ["contact info", "up top"], section: null, why: "no one section of this form means that" });
  });

  it("maps 'up top' to the first field's section, and asks when the first field has none", () => {
    expect(namedSection("just fill in up top", SECTIONS, "Contact information").section).toBe("Contact information");
    expect(namedSection("just fill in up top", SECTIONS, null)).toEqual({ phrases: ["up top"], section: null, why: "no one section of this form means that" });
  });

  it("maps 'my details' to the one details section", () => {
    expect(namedSection("fill in my details", ["Your details", "Education"], "Your details").section).toBe("Your details");
    expect(namedSection("fill in my details", ["Your details", "Personal links"], "Your details").section).toBeNull();
    expect(namedSection("fill in my details", SECTIONS, "Contact information").section).toBeNull();
  });

  it("asks when two phrases mean different sections, and takes them when they agree", () => {
    expect(namedSection("my contact info up top", ["About you", "Contact information"], "About you").section).toBeNull();
    expect(namedSection("my contact info up top", SECTIONS, "Contact information").section).toBe("Contact information");
  });

  it("asks, rather than map, when the instruction says more than the section (B28 reviews)", () => {
    expect(namedSection("skip my contact info, do the rest", SECTIONS, "Contact information")).toMatchObject({ section: null, why: "it also says 'skip rest'" });
    expect(namedSection("avoid my contact info, do the rest", SECTIONS, "Contact information")).toMatchObject({ section: null, why: "it also says 'avoid rest'" });
    expect(namedSection("my contact info, but not the phone", SECTIONS, "Contact information").section).toBeNull();
    expect(namedSection("only my email in contact info", SECTIONS, "Contact information")).toMatchObject({ section: null, why: "it also says 'email'" });
    expect(namedSection("only the second box in contact info", SECTIONS, "Contact information")).toMatchObject({ section: null, why: "it also says 'second box'" });
    expect(namedSection("fill only part of my contact info", SECTIONS, "Contact information")).toMatchObject({ section: null, why: "it also says 'part'" });
    expect(namedSection("fill a bit of my details", ["Your details", "Education"], "Your details")).toMatchObject({ section: null, why: "it also says 'bit'" });
    expect(namedSection("do everything in my details except email", ["Your details", "Education"], "Your details")).toMatchObject({ section: null, why: "where it says to copy from also says 'details except'" });
    expect(namedSection('only my "Email" in contact info', SECTIONS, "Contact information")).toMatchObject({ section: null, why: "it quotes something" });
    // "only" alone does not rule the section out.
    expect(namedSection("my contact info only", SECTIONS, "Contact information").section).toBe("Contact information");
  });

  it("reads no section phrase where there is none", () => {
    expect(namedSection("emergency contact is ines", SECTIONS, null)).toEqual({ phrases: [], section: null, why: null });
    expect(namedSection("fill out the form", SECTIONS, null).phrases).toEqual([]);
  });
});
