// B28: the sentences code reads as asking for the whole form or for one section. Each has one right answer per
// instruction, so the grammar is tested alone here, every sentence it makes; test/ask.test.ts runs it through planAsk.
import { describe, expect, it } from "vitest";
import { BY_WORD, REVIEWED } from "./b28-reviewed.ts";
import { asksForWholeForm, EXCLUSION_WORDS, exclusionsIn, isContactField, namedSection, normalizeInstruction, parseSentence, SECTION, SECTION_OBJECTS, SECTION_WORDS, WHOLE_FORM, type FieldWords, type Slot } from "../src/planner/scope-words.ts";

/** Every sentence a grammar makes, an optional slot skipped or filled. */
function sentences(grammar: readonly Slot[]): string[] {
  return grammar.reduce<string[]>((acc, slot) => acc.flatMap((a) => [...(slot.optional ? [a] : []), ...slot.phrases.map((p) => (a === "" ? p : `${a} ${p}`))]), [""]);
}


describe("normalizeInstruction", () => {
  it("applies NFKC, lower case, one space per whitespace run, a trim and one trailing . ! or ?, and nothing else", () => {
    expect(normalizeInstruction("  Fill\tOUT\n the FORM.  ")).toBe("fill out the form");
    expect(normalizeInstruction("ﬁll ｏｕｔ the form!")).toBe("fill out the form");
    expect(normalizeInstruction("can you do everything?")).toBe("can you do everything");
    expect(normalizeInstruction("fill out the form..")).toBe("fill out the form.");
    expect(normalizeInstruction("fill out the form?!")).toBe("fill out the form?");
    expect(normalizeInstruction("fill out the form .")).toBe("fill out the form ");
    expect(normalizeInstruction("fill.in ＂everything＂")).toBe('fill.in "everything"');
    expect(normalizeInstruction("fill in 〝everything〞")).toBe("fill in 〝everything〞");
    expect(normalizeInstruction("fill in every​thing")).toBe("fill in every​thing");
  });
});

describe("the whole-form grammar", () => {
  it("is the lead decision's lists, word for word", () => {
    expect(Object.fromEntries(WHOLE_FORM.map((s) => [s.name, [s.optional, s.phrases.length]]))).toEqual({ opener: [true, 2], verb: [false, 5], object: [false, 12], "for me": [true, 1], source: [true, 24] });
    expect(WHOLE_FORM.find((s) => s.name === "opener")?.phrases).toEqual(["please", "can you"]);
    expect(WHOLE_FORM.find((s) => s.name === "verb")?.phrases).toEqual(["fill out", "fill in", "fill", "complete", "do"]);
    expect(WHOLE_FORM.find((s) => s.name === "object")?.phrases).toEqual(["this form", "the form", "this application", "the application", "this page", "the whole form", "the entire form", "everything", "everything you can", "all of it", "the rest", "what you can"]);
    expect(WHOLE_FORM.find((s) => s.name === "source")?.phrases).toContain("using the doc");
  });

  it("trusts every sentence it makes", () => {
    const all = sentences(WHOLE_FORM);
    expect(all.length).toBe(3 * 5 * 12 * 2 * 25);
    expect(all.filter((s) => !asksForWholeForm(s))).toEqual([]);
  });

  it.each(["please fill the entire form", "fill out the form from my note", "fill in everything you can", "Can you fill out this application for me?", "Do the rest using the doc."])("trusts %j", (s) => {
    expect(asksForWholeForm(s)).toBe(true);
  });

  it.each(REVIEWED.map(([s]) => s))("does not trust %j", (s) => {
    expect(asksForWholeForm(s)).toBe(false);
  });

  it.each([
    // The earlier recognizer's form titles: no longer read.
    "fill out the rental application from my note",
    "fill out the Northgate application",
    // Words the grammar does not list, anywhere.
    "fill out the form please",
    "fill out the form, please",
    "please can you fill out the form",
    "fill it out",
    "fill out from my note",
    "everything",
    "just do everything for me",
    "finish this application",
    "fill out the form from Dana's note",
    "fill out the form from my note and email",
    "fill out the form for my landlord",
    "fill out my email",
    "fill in everything you can't",
    "do the rest of it",
    // A trailing mark is dropped once; any other mark stays.
    "fill out the form!!",
    "fill out the form .",
    "fill out the form;",
    "(fill out the form)",
  ])("does not trust %j", (s) => {
    expect(asksForWholeForm(s)).toBe(false);
  });

  it("does not trust any sentence with a word, a quote or a mark put inside it", () => {
    const inserts = ["not", "only", "except", "but", "bea", "email", "phone", '"', "＂", "〝", "'", "«", "`", ",", ";", ".", "-", "​"];
    const bad: string[] = [];
    for (const s of sentences(WHOLE_FORM.filter((x) => x.name !== "opener" && x.name !== "for me"))) {
      const words = s.split(" ");
      for (let i = 1; i < words.length; i++) {
        for (const w of inserts) {
          for (const joined of [[...words.slice(0, i), w, ...words.slice(i)].join(" "), `${words.slice(0, i).join(" ")}${w}${words.slice(i).join(" ")}`]) if (asksForWholeForm(joined)) bad.push(joined);
        }
      }
      if (asksForWholeForm(`${s} please`) || asksForWholeForm(`"${s}"`)) bad.push(s);
    }
    expect(bad).toEqual([]);
  });

  it("parses each slot's phrase, and none for a skipped optional slot", () => {
    expect(parseSentence("fill in everything you can", WHOLE_FORM)).toEqual(["", "fill in", "everything you can", "", ""]);
    expect(parseSentence("please do the rest for me from the notes", WHOLE_FORM)).toEqual(["please", "do", "the rest", "for me", "from the notes"]);
    expect(parseSentence("fill in everything you", WHOLE_FORM)).toBeNull();
  });
});

describe("the section grammar", () => {
  const SECTIONS = ["Contact information", "Education", "Links"];

  it("pins its slots and objects", () => {
    expect(SECTION.map((s) => [s.name, s.optional])).toEqual([["opener", true], ["verb", false], ["object", false], ["only", true], ["for me", true], ["source", true]]);
    expect(SECTION.find((s) => s.name === "opener")?.phrases).toEqual(["please", "can you", "just"]);
    expect([...SECTION_OBJECTS.keys()]).toEqual([
      "my contact info", "my contact information", "my contact details", "the contact info", "the contact information", "the contact details",
      "my contact info up top", "my contact information up top", "my contact details up top", "the contact info up top", "the contact information up top", "the contact details up top",
      "my details", "up top",
    ]);
    expect(SECTION_WORDS.map((p) => p.says)).toEqual(["contact info", "up top", "my details"]);
  });

  it("maps every sentence it makes to the one section its object means", () => {
    const all = sentences(SECTION);
    expect(all.length).toBe(4 * 5 * 14 * 2 * 2 * 25);
    const wrong = all.filter((s) => {
      const details = s.includes("my details");
      const got = namedSection(s, details ? ["Your details", "Education"] : SECTIONS, details ? "Your details" : "Contact information");
      return got.section !== (details ? "Your details" : "Contact information") || got.why !== null;
    });
    expect(wrong).toEqual([]);
  });

  it("maps 'contact info' to the one section named for contact, and asks when there is none or two", () => {
    expect(namedSection("just do my contact info", SECTIONS, "Contact information")).toMatchObject({ phrases: ["contact info"], section: "Contact information", why: null });
    expect(namedSection("do my contact details please", SECTIONS, null).section).toBeNull();
    expect(namedSection("please do my contact details", SECTIONS, null).section).toBe("Contact information");
    expect(namedSection("fill in my contact information", ["Contact", "Contact details"], "Contact").section).toBeNull();
    expect(namedSection("just do my contact info up top", [], null)).toMatchObject({ phrases: ["contact info", "up top"], section: null, why: "no one section of this form means that" });
  });

  it("maps a contact or details phrase only to a heading that is the user's own, word for word (B28 review 6)", () => {
    for (const h of ["Contact", "Contact info", "Contact Information", "contact details", "Your contact information", "My Contact Details"]) expect(namedSection("do my contact info", [h, "Education"], h).section).toBe(h);
    for (const h of ["Emergency contact", "Emergency contact information", "Reference contact details", "Contact preferences", "Contact your manager"]) expect(namedSection("do my contact info", ["About you", h], "About you").section).toBeNull();
    for (const h of ["Your details", "My details", "Details", "Personal details", "Personal information", "Personal info", "About you"]) expect(namedSection("fill in my details", [h, "Education"], h).section).toBe(h);
    for (const h of ["Reference details", "Emergency contact details", "Spouse personal details", "Personal links", "Payment details"]) expect(namedSection("fill in my details", ["Education", h], "Education").section).toBeNull();
  });

  it("maps 'up top' to the first field's section, and asks when the first field has none", () => {
    expect(namedSection("just fill in up top", SECTIONS, "Contact information").section).toBe("Contact information");
    expect(namedSection("just fill in up top", SECTIONS, null)).toMatchObject({ phrases: ["up top"], section: null, why: "no one section of this form means that" });
  });

  it("maps 'my details' to the one details section", () => {
    expect(namedSection("fill in my details", ["Your details", "Education"], "Your details").section).toBe("Your details");
    expect(namedSection("fill in my details", ["Your details", "Personal details"], "Your details").section).toBeNull();
    expect(namedSection("fill in my details", SECTIONS, "Contact information").section).toBeNull();
  });

  it("asks when two phrases mean different sections, and takes them when they agree", () => {
    expect(namedSection("do my contact info up top", ["About you", "Contact information"], "About you").section).toBeNull();
    expect(namedSection("do my contact info up top", SECTIONS, "Contact information").section).toBe("Contact information");
  });

  it.each(REVIEWED.map(([s]) => s))("does not map %j to a section", (s) => {
    for (const [sections, first] of [[SECTIONS, "Contact information"], [["Your details", "Education"], "Your details"]] as const) {
      expect(namedSection(s, sections, first).section).toBeNull();
    }
  });

  it("asks, rather than map, for a section phrase in any other sentence", () => {
    expect(namedSection("skip my contact info, do the rest", SECTIONS, "Contact information")).toMatchObject({ phrases: ["contact info"], section: null, why: "it says more than which part of the form" });
    expect(namedSection("fill in everything in my contact info", SECTIONS, "Contact information").section).toBeNull();
    expect(namedSection("my contact info only", SECTIONS, "Contact information").section).toBeNull();
    expect(namedSection("do my contact info only", SECTIONS, "Contact information").section).toBe("Contact information");
  });

  it("reads no section phrase where there is none", () => {
    expect(namedSection("emergency contact is ines", SECTIONS, null)).toMatchObject({ phrases: [], section: null, why: null });
    expect(namedSection("fill out the form", SECTIONS, null).phrases).toEqual([]);
  });
});

// B28b lead decision 1: an exclusion word voids the trust naming gives. One right answer per string.
describe("the exclusion words", () => {
  it("open with the lead decision's twelve, in its order", () => {
    expect(EXCLUSION_WORDS.slice(0, 12)).toEqual(["not", "n't", "except", "but", "without", "skip", "leave", "besides", "other than", "no", "don't", "instead"]);
    expect(new Set(EXCLUSION_WORDS).size).toBe(EXCLUSION_WORDS.length);
  });

  it.each(BY_WORD)("finds %j in %j", (word, s) => {
    expect(exclusionsIn(s)).toContain(word);
  });

  it.each(EXCLUSION_WORDS)("finds %j standing alone, in capitals and beside punctuation", (word) => {
    for (const s of [`email ${word} phone`, `EMAIL ${word.toUpperCase()} PHONE`, `email,${word},phone`, `(${word})`]) {
      // "n't" closes a word: it stands after a letter.
      const t = word === "n't" ? s.replace("n't", "isn't").replace("N'T", "ISN'T") : s;
      expect(exclusionsIn(t), t).toContain(word);
    }
  });

  it("reads apostrophe look-alikes, accents and invisible characters before looking", () => {
    for (const s of ["email, don’t do phone", "email, donʼt do phone", "email, don＇t do phone", "email and nót phone", "email and n\u200bot phone", "email\u200bnot phone", "email and n\u00adot phone", "ｅｍａｉｌ ｎｏｔ ｐｈｏｎｅ", "email  NOT\tphone"]) {
      expect(exclusionsIn(s), JSON.stringify(s)).not.toEqual([]);
    }
  });

  it("counts a letter outside a-z, and a sign that rules a word out", () => {
    expect(exclusionsIn("email and nоt phone")).toContain("a letter outside a-z"); // a Cyrillic о
    expect(exclusionsIn("email, -phone")).toContain("an exclusion sign");
    expect(exclusionsIn("email ❌ phone")).toContain("an exclusion sign");
    expect(exclusionsIn("fill in my e-mail")).toEqual([]);
  });

  it("finds 'n't' typed apart from its verb", () => {
    for (const s of ["phone is n't needed", "do n’t fill phone", "do n 't fill phone"]) expect(exclusionsIn(s), s).toContain("n't");
  });

  it("finds none in words that only hold one", () => {
    for (const s of ["fill out the form from my note", "fill in my notes", "do the button and the phone number", "fill in my contact info", "complete this form", "fill in what you can", "known phone", "notice", "butter", "skipper's email"]) {
      expect(exclusionsIn(s), s).toEqual([]);
    }
  });

  // Loaded full-suite runs took 7,449 ms in P1 and 14,994 ms in F2 against a 5,000 ms timeout.
  // Keep the exhaustive grammar check; only this test gets more time, not a product budget.
  it("is in no sentence of either grammar, so a trusted whole form or section never holds one", () => {
    const bad = [...sentences(WHOLE_FORM), ...sentences(SECTION)].filter((s) => exclusionsIn(s).length > 0);
    expect(bad).toEqual([]);
  }, 30_000);
});

// B28b lead decision 2: "contact info" trusts the contact fields of its section, read by fill's kinds and parts.
describe("what a section phrase asks for by its meaning", () => {
  const f = (label: string, typed = true): FieldWords => ({ labelWords: [label, null, null], name: label, typed });

  it("reads name parts, email, phone, links and address parts as contact information", () => {
    for (const l of ["First Name", "Last Name", "Full name", "Email", "E-mail address", "Phone", "Mobile", "Your phone number", "Website", "Street address", "City", "ZIP code", "State", "Apt / Suite", "Email or phone"]) expect(isContactField(f(l)), l).toBe(true);
  });

  it("reads anything else, a field fill knows no kind for, and a non-text control as not", () => {
    for (const l of ["Graduation Date (MM/YYYY)", "LinkedIn Profile", "Date of birth", "School name", "Company name", "Job title", "Salary", "Notes", "Last day", "Portfolio URL", "Work email", "Emergency contact phone", "Family size", "Reference email", "Name of your mobile phone"]) expect(isContactField(f(l)), l).toBe(false);
    expect(isContactField(f("Email", false))).toBe(false);
  });

  it("gives 'contact info' its contact fields, and 'up top' and 'my details' none", () => {
    expect(namedSection("do my contact info", ["Contact information"], "Contact information").fits(f("Email"))).toBe(true);
    expect(namedSection("do my contact info", ["Contact information"], "Contact information").fits(f("Graduation Date (MM/YYYY)"))).toBe(false);
    expect(namedSection("do my contact info up top", ["Contact information"], "Contact information").fits(f("Phone"))).toBe(true);
    expect(namedSection("just fill in up top", ["About you"], "About you").fits(f("Email"))).toBe(false);
    expect(namedSection("fill in my details", ["Your details"], "Your details").fits(f("Email"))).toBe(false);
    // No section: nothing fits.
    expect(namedSection("do my contact info", ["Education"], "Education").fits(f("Email"))).toBe(false);
  });
});
