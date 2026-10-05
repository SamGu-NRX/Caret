// B28: the words code reads as asking for the whole form or for a section. Each list entry has one right answer
// per instruction, so each is tested alone here; test/ask.test.ts runs them through planAsk.
import { describe, expect, it } from "vitest";
import { namesShortLabel, relevance } from "../src/planner/planner.ts";
import { namedSection, namesTheForm, SECTION_WORDS, WHOLE_FORM_WORDS, wholeFormPhrase, type NamesField } from "../src/planner/scope-words.ts";

const TITLE = "Rental Application | Cedar Court Apartments";
/** A form's fields as ask.ts reads them by the instruction's words (relevance, namesShortLabel). */
const namesOf = (fields: readonly string[]): NamesField => (t) => fields.some((f) => relevance(t, f) > 0 || namesShortLabel(t, f));
const NAMES = namesOf(["First name", "Email", "Phone", "Street address", "Notes", "LinkedIn Profile"]);

describe("wholeFormPhrase", () => {
  it.each([
    ["fill out", "fill out"],
    ["fill out", "fill it out from my note"],
    ["fill out", "Fill this out, thanks"],
    ["fill out", "fill out the form using what I jotted down"],
    ["fill out", "fill out this application"],
    ["fill in everything", "fill in everything"],
    ["everything", "everything's in my notes.txt"],
    ["the whole form", "do the whole form"],
    ["all of it", "all of it please"],
    ["the rest", "do the rest from my note"],
    ["the rest", "do the rest of this form"],
    ["what you can", "put in what you can"],
    ["what you can", "fill whatever you can"],
    ["this form", "please handle this form"],
    ["this application", "help me with this application"],
    ["fill out the <form name>", "fill out the rental application from my note"],
    ["fill out the <form name>", "fill out the Cedar Court application, please"],
  ])("reads '%s' in %j", (phrase, instruction) => {
    expect(wholeFormPhrase(instruction, TITLE, NAMES)).toBe(phrase);
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
    "put my details in",
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
    // A whole-form phrase beside a field the instruction names asks for that field (B28 review).
    "fill the rest of the address",
    "just fill my email on this form",
    "put everything from my note in Notes",
    "fill in everything, the phone is (512) 555-0147",
    "Write ‘everything’ in Notes",
  ])("reads no whole-form phrase in %j", (instruction) => {
    expect(wholeFormPhrase(instruction, TITLE, NAMES)).toBeNull();
  });

  it("lets the form's own name share a word with a field ('the pizza order', 'Pizza Size')", () => {
    const pizza = namesOf(["Customer name", "Pizza Size", "Delivery instructions"]);
    expect(wholeFormPhrase("fill out the pizza order from my note", "Pizza order", pizza)).toBe("fill out the <form name>");
    expect(wholeFormPhrase("fill out the pizza order, large size", "Pizza order", pizza)).toBeNull();
  });
});

describe("namesTheForm", () => {
  it("needs every word of the object but 'form' and 'application' in the title", () => {
    expect(namesTheForm("rental application", TITLE)).toBe(true);
    expect(namesTheForm("Cedar Court form", TITLE)).toBe(true);
    expect(namesTheForm("Northgate application", "Northgate Analytics - Data Analyst")).toBe(true);
    expect(namesTheForm("pizza order", "httpbin.org/forms/post")).toBe(false);
    expect(namesTheForm("landlord application", TITLE)).toBe(false);
    expect(namesTheForm("application", TITLE)).toBe(false);
  });
});

describe("namedSection", () => {
  const SECTIONS = ["Contact information", "Education", "Links"];
  it("has a case below for every phrase on the list", () => {
    expect(SECTION_WORDS.map((p) => p.says)).toEqual(["contact info", "up top", "my details"]);
  });

  it("maps 'contact info' to the one section named for contact, and asks when there is none or two", () => {
    expect(namedSection("just do my contact info", SECTIONS, "Contact information", NAMES)).toEqual({ phrases: ["contact info"], section: "Contact information", why: null });
    expect(namedSection("my contact details please", SECTIONS, null, NAMES).section).toBe("Contact information");
    expect(namedSection("my contact information", ["Contact", "Emergency contact"], "Contact", NAMES).section).toBeNull();
    expect(namedSection("just do my contact info up top", [], null, NAMES)).toEqual({ phrases: ["contact info", "up top"], section: null, why: "no one section of this form means that" });
  });

  it("maps 'up top' to the first field's section, and asks when the first field has none", () => {
    expect(namedSection("do the bit up top", SECTIONS, "Contact information", NAMES).section).toBe("Contact information");
    expect(namedSection("do the bit up top", SECTIONS, null, NAMES)).toEqual({ phrases: ["up top"], section: null, why: "no one section of this form means that" });
  });

  it("maps 'my details' to the one details section", () => {
    expect(namedSection("put my details in", ["Your details", "Education"], "Your details", NAMES).section).toBe("Your details");
    expect(namedSection("put my details in", ["Your details", "Personal links"], "Your details", NAMES).section).toBeNull();
    expect(namedSection("put my details in", SECTIONS, "Contact information", NAMES).section).toBeNull();
  });

  it("asks when two phrases mean different sections, and takes them when they agree", () => {
    expect(namedSection("my contact info up top", ["About you", "Contact information"], "About you", NAMES).section).toBeNull();
    expect(namedSection("my contact info up top", SECTIONS, "Contact information", NAMES).section).toBe("Contact information");
  });

  it("asks, rather than map, when the instruction rules the part out or names a field besides it (B28 review)", () => {
    expect(namedSection("skip my contact info, do the rest", SECTIONS, "Contact information", NAMES)).toMatchObject({ section: null, why: "it also rules something out" });
    expect(namedSection("my contact info, but not the phone", SECTIONS, "Contact information", NAMES).section).toBeNull();
    expect(namedSection("only my email in contact info", SECTIONS, "Contact information", NAMES)).toMatchObject({ section: null, why: "it names a field besides" });
    // "only" alone does not rule the section out.
    expect(namedSection("my contact info only", SECTIONS, "Contact information", NAMES).section).toBe("Contact information");
  });

  it("reads no section phrase where there is none", () => {
    expect(namedSection("emergency contact is ines", SECTIONS, null, NAMES)).toEqual({ phrases: [], section: null, why: null });
    expect(namedSection("fill out the form", SECTIONS, null, NAMES).phrases).toEqual([]);
  });
});
