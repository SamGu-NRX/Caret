// A1: Ask acts on plain requests. Code reads which fields an instruction means (planner/scope-reading.ts) and whose
// details go in (planner/people.ts); the model only confirms the reading as one option among alternatives
// (intent-heads.ts), and a reading it does not confirm is asked about with the reading's fields among the choices.
// Each reading has one right answer on a given form, so they are tested alone on the real-form corpus's replayed
// desks; then planAsk end to end with a stand-in Jev. The instructions are written for these tests, not taken from
// the held-out Ask sets (B25, B26, B31).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Snapshot } from "../src/protocol.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { intentSnapshot, type IntentSnapshot } from "../src/planner/intent.ts";
import { headsIntentMaker, headsRequest, readHeads } from "../src/planner/intent-heads.ts";
import { AskAsks, AskRefused, planAsk } from "../src/planner/ask.ts";
import { SAYS } from "../src/planner/says.ts";
import type { MemoryValue } from "../src/planner/trace.ts";
import { buildDesk, loadCorpus, T0, type Desk } from "../scripts/realfill-corpus.ts";
import { field, snap } from "./builders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const deskOf = (form: string): Desk => buildDesk(corpus, snaps, corpus.forms.find((f) => f.id === form) ?? (() => { throw new Error(`no form ${form}`); })());
const snapOn = (form: string, instruction: string, memory: readonly MemoryValue[] = []): IntentSnapshot => {
  const d = deskOf(form);
  return intentSnapshot(instruction, d.model, d.form, [...d.memory, ...memory]);
};
/**
 * What the heads maker settles when the model chooses code's reading and leaves its own scope head unclear: the names
 * of the fields, "all" for the whole form, or null when nothing is settled (no reading, so the unclear head asks).
 */
const reads = (form: string, instruction: string): string[] | "all" | null => {
  const s = snapOn(form, instruction);
  const i = readHeads(s, cannedHeads(s, { reading: "code", scope: "unclear", source: "any", whose: "user" }));
  if (i.route !== "fill") return null;
  return i.scope === "all" ? "all" : i.fields.map((r) => s.fields.find((f) => f.ref === r)?.name ?? r);
};
const literalsOf = (form: string, instruction: string): { field: string; text: string }[] => {
  const s = snapOn(form, instruction);
  return readHeads(s, cannedHeads(s, { reading: "code", scope: "unclear", source: "any", whose: "user" })).literals.map((l) => ({ field: s.fields.find((f) => f.ref === l.field)?.name ?? l.field, text: l.text }));
};

describe("the field-kind lexicon", () => {
  it.each([
    ["conference-registration", "my name and email please", ["First name", "Last name", "Email address"]],
    ["clinic-intake", "put in my cell", ["Mobile phone"]],
    ["rental-application", "add my phone number", ["Mobile phone"]],
    ["b2b-demo-request", "my work email pls", ["Work email"]],
    ["job-application", "fill in my name, email and phone", ["Full name ✱", "Email ✱", "Phone ✱"]],
    ["checkout-shipping", "fill out the shipping address", ["Address", "Apartment, suite, etc. (optional)", "City", "State", "ZIP code"]],
    ["clinic-intake", "fill in my address", ["Street address", "Apartment or unit (optional)", "City", "State", "ZIP code"]],
    ["airline-passenger", "add my birthday", ["Month", "Day", "Year"]],
    ["greenhouse-apply", "put in my school and degree", ["School", "Degree"]],
    ["greenhouse-apply", "add my linkedin and when I graduate", ["Graduation Date (MM/YYYY)", "LinkedIn Profile"]],
    ["event-rsvp", "just my name", ["Your full name"]],
    ["hubspot-contact", "add the company name", ["Company name"]],
    ["car-service-booking", "put my number in", ["Mobile phone"]],
    ["car-service-booking", "grab the appointment slot", ["Preferred date", "Preferred time"]],
  ])("%s: '%s' names %j", (form, instruction, names) => {
    expect(reads(form, instruction)).toEqual(names);
  });

  it("reads a name's, a role's or a pronoun's possessive as someone else's fields, and never the user's", () => {
    expect(reads("job-application", "add Simone's email")).toEqual(["Reference email"]);
    expect(reads("rental-application", "fill in the landlord's phone")).toEqual(["Landlord phone"]);
    // The form has no one else's email: no reading, so the user's own Email address is never read for "his".
    expect(reads("conference-registration", "fill in his email")).toBeNull();
  });

  it("has no reading when a kind's fields cannot be told apart, or a word is one code does not read", () => {
    // Mobile phone and Home phone: "my phone" could be either.
    expect(reads("clinic-intake", "add my phone")).toBeNull();
    expect(reads("job-application", "fill in my name and favorite color")).toBeNull();
    expect(reads("hubspot-contact", "fill in my company stuff")).toBeNull();
  });

  it("has no reading for what Ask refuses or rules out: a never-typed kind, a press, new text, an exclusion", () => {
    expect(reads("rental-application", "put my social security number in")).toBeNull();
    expect(reads("checkout-shipping", "fill in my email and pay")).toBeNull();
    expect(reads("support-ticket", "write up a description of the bug")).toBeNull();
    expect(reads("rental-application", "fill out the email and not phone")).toBeNull();
    expect(reads("rental-application", "fill in everything but my phone")).toBeNull();
  });
});

describe("a part of the form by its heading, legend or label prefix", () => {
  it.each([
    ["rental-application", "do the landlord section", ["Landlord or property manager name", "Landlord phone"]],
    ["clinic-intake", "the emergency contact part please", ["Emergency contact name", "Relationship to patient", "Emergency contact phone"]],
    ["job-application", "fill in the reference stuff", ["Reference name", "Reference relationship", "Reference email", "Reference phone"]],
    ["job-application", "add the links", ["LinkedIn URL", "GitHub URL", "Portfolio or website"]],
    ["course-enrollment", "do the course selection", ["Course", "Term", "Section"]],
    ["checkout-shipping", "do the contact bit", ["Email"]],
    ["airline-passenger", "fill in the contact information", ["Email address", "Phone number", "Zip code"]],
  ])("%s: '%s' names %j", (form, instruction, names) => {
    expect(reads(form, instruction)).toEqual(names);
  });

  it("reads 'up top' as the first heading's fields, and the user's contact fields there", () => {
    expect(reads("course-enrollment", "do the stuff up top")).toEqual(["First name", "Middle name", "Last name", "Preferred name (optional)", "Date of birth", "Email", "Phone", "Student ID (returning students)"]);
    // A form with no headings has no top to tell apart; contact info still names its kind.
    expect(reads("greenhouse-apply", "just my contact info up top")).toEqual(["First Name", "Last Name", "Email", "Phone"]);
    expect(reads("greenhouse-apply", "do the stuff up top")).toBeNull();
  });
});

describe("whole-form phrases", () => {
  it.each([
    ["httpbin-pizza", "complete the pizza order"],
    ["rental-application", "get this rental application done"],
    ["support-ticket", "fill this out"],
    ["b2b-demo-request", "fill in whatever you can"],
    ["checkout-shipping", "do the checkout details from my note"],
    ["hubspot-contact", "fill out the contact form"],
  ])("%s: '%s' is the whole form", (form, instruction) => {
    expect(reads(form, instruction)).toBe("all");
  });

  it("is never the whole form when a field or part is named", () => {
    expect(reads("greenhouse-apply", "fill out the email")).toEqual(["Email"]);
    expect(reads("rental-application", "fill in my email on the application")).toEqual(["Email address"]);
  });
});

describe("values the instruction spells out", () => {
  it("ties a time to the form's one time field, and a weekday to its one date field", () => {
    expect(reads("httpbin-pizza", "make the delivery 8:15")).toEqual(["Preferred delivery time"]);
    expect(literalsOf("httpbin-pizza", "make the delivery 8:15")).toEqual([{ field: "Preferred delivery time", text: "8:15" }]);
    expect(reads("car-service-booking", "saturday works, at 9:30")).toEqual(["Preferred date", "Preferred time"]);
    expect(literalsOf("car-service-booking", "saturday works, at 9:30")).toEqual([{ field: "Preferred time", text: "9:30" }]);
    expect(reads("event-rsvp", "we'll arrive at 7:15 instead")).toEqual(["Approximate arrival time"]);
  });

  it("has no reading when a value fits no one field", () => {
    expect(reads("event-rsvp", "set it to Avery")).toBeNull();
  });
});

describe("whose details (people.ts)", () => {
  const whose = (form: string, instruction: string, memory: readonly MemoryValue[] = []) => {
    const s = snapOn(form, instruction, memory);
    return readHeads(s, cannedHeads(s, { reading: "code" }));
  };

  it("is the person the instruction names, beside a relation that only says who they are", () => {
    expect(whose("rental-application", "use Gary's info for the landlord part")).toMatchObject({ route: "fill", whose: "p1" });
    expect(whose("event-rsvp", "put Bea down as my guest with her meal")).toMatchObject({ route: "fill", whose: "p1" });
  });

  it("is each field's own when the user is named beside someone", () => {
    expect(whose("event-rsvp", "RSVP for me and Bea, everything's in her email")).toMatchObject({ route: "fill", scope: "all", whose: "user" });
  });

  it("asks which person for a pronoun when the sources hold more than one other person, the right one among the options", async () => {
    // The rental notes name the landlord (Gary Pruitt) and a roommate (Tomas Reed); the decoy mail is Dana's.
    const s = snapOn("rental-application", "add his phone");
    const i = readHeads(s, cannedHeads(s, { reading: "code" }));
    expect(i).toMatchObject({ route: "ask", why: "whichPerson", open: ["person"] });
    const d = deskOf("rental-application");
    const e = await planAsk("add his phone", d.model, { values: () => d.memory }, d.about, { askJev: cannedJev({ reading: "code" }).ask, maker: headsIntentMaker(cannedJev({ reading: "code" }).ask), writer: null, offerKey: "a1", windowId: d.form.window.windowId, now: 2000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    const names = (e as AskAsks).question.options.map((c) => (c.option.kind === "person" ? c.option.name : c.option.kind));
    expect(names).toEqual(expect.arrayContaining(["Gary Pruitt", "Tomas Reed"]));
  });

  it("is the memory entry for a relation, when exactly one has it", () => {
    const wife: MemoryValue = { id: "people-1", label: "my wife", text: "Ines Lindqvist", whose: "other" };
    expect(whose("clinic-intake", "put my wife down as the emergency contact", [wife])).toMatchObject({ route: "fill", person: "Ines Lindqvist", agreed: true });
  });

  it("is the user's own for 'my' with a person named only as the source", () => {
    expect(whose("clinic-intake", "put my date of birth in, from Ines's email")).toMatchObject({ route: "fill", whose: "user" });
  });
});

/** A stand-in heads answer: every head at 0.9, `heads` by id, the first option otherwise; nouls 0. */
function cannedHeads(s: IntentSnapshot, heads: Record<string, string>) {
  const req = headsRequest(s);
  const answers = Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: heads[id] ?? Object.keys(req.questions[id]?.criteria ?? {})[0] ?? "none", confidence: 0.9 }]));
  return { model: "jev-test", answers, nouls: Object.fromEntries(Object.keys(req.nouls ?? {}).map((id) => [id, 0])), inputTokens: 100, latencyMs: 1, costUsd: 0 };
}

/**
 * A stand-in Jev for whole Asks: the heads request answered with `heads` (the reading confirmed or not), value
 * questions by `values` (field label to the value whose option is chosen), whose and owner questions "user", and every
 * yes/no confirmation counted.
 */
function cannedJev(heads: Record<string, string>, values: Record<string, string> = {}): { ask: AskJev; seen: JevRequest[]; confirms: () => number } {
  const seen: JevRequest[] = [];
  const ask: AskJev = async (req) => {
    seen.push(req);
    if ("scope" in req.questions) {
      const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: heads[id] ?? (id === "scope" ? "fields" : id === "source" ? "any" : id === "whose" ? "user" : (Object.keys(q.criteria)[0] ?? "none")), confidence: 0.9 }]));
      return { model: "jev-test", answers, nouls: Object.fromEntries(Object.keys(req.nouls ?? {}).map((id) => [id, 0])), inputTokens: 100, latencyMs: 1, costUsd: 0 };
    }
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user" in q.criteria ? "user" : (Object.keys(q.criteria)[0] ?? "none"), confidence: 0.9 }];
        if ("yes" in q.criteria) return [id, { choice: "yes", confidence: 0.9 }];
        const want = Object.entries(values).find(([label]) => ins.includes(`'${label}'`))?.[1];
        const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`));
        return [id, { choice: hit?.[0] ?? "none", confidence: 0.9 }];
      }),
    );
    return { model: "jev-test", answers, inputTokens: 100, latencyMs: 1, costUsd: 0 };
  };
  return { ask, seen, confirms: () => seen.filter((r) => Object.values(r.questions).some((q) => "yes" in q.criteria)).length };
}

describe("agreement or ask", () => {
  const run = (form: string, instruction: string, jev: ReturnType<typeof cannedJev>) => {
    const d = deskOf(form);
    return planAsk(instruction, d.model, { values: () => d.memory }, d.about, { askJev: jev.ask, maker: headsIntentMaker(jev.ask), writer: null, offerKey: "a1", windowId: d.form.window.windowId, now: 2000 });
  };

  it("acts on code's reading when the model chooses it, with no further confirmation", async () => {
    const jev = cannedJev({ reading: "code" }, { "First name": "Kenji", "Last name": "Watanabe", "Email address": "kenji.watanabe@example.net" });
    const draft = await run("conference-registration", "my name and email please", jev);
    expect(draft.checked.writes.map((w) => w.value)).toEqual(["Kenji", "Watanabe", "kenji.watanabe@example.net"]);
    expect(draft.intent).toMatchObject({ route: "fill", scope: "list", agreed: true });
    expect(jev.confirms()).toBe(0);
    expect(jev.seen.filter((r) => "scope" in r.questions)).toHaveLength(1);
  });

  it("asks which fields when the model does not choose code's reading, with the reading's fields among the options", async () => {
    for (const other of ["other", "fewer", "all", "none"]) {
      const jev = cannedJev({ reading: other });
      const e = await run("job-application", "fill in the reference stuff", jev).catch((x: unknown) => x);
      expect(e, other).toBeInstanceOf(AskAsks);
      const q = (e as AskAsks).question;
      expect(q.part).toBe("fields");
      expect(q.options.map((c) => (c.option.kind === "field" ? c.option.label : ""))).toEqual(expect.arrayContaining(["Reference name", "Reference relationship", "Reference email", "Reference phone"]));
    }
  });

  it("still refuses what Ask refuses, with its sentence, whatever the model would choose", async () => {
    const jev = cannedJev({ reading: "code", scope: "refuse", why: "neverTyped" });
    const ssn = await run("rental-application", "put my social security number in", jev).catch((x: unknown) => x);
    expect(ssn).toBeInstanceOf(AskRefused);
    expect((ssn as AskRefused).message).toBe("Caret doesn't type Social Security numbers. Type it yourself.");
    const pay = await run("checkout-shipping", "ok now pay for it", cannedJev({ scope: "refuse", why: "payment" })).catch((x: unknown) => x);
    expect((pay as AskRefused).message).toBe(SAYS.payment);
    // A press has no reading, so the plan route takes it as before A1 (says.ts saysPress).
    expect(reads("job-application", "submit it for me")).toBeNull();
  });
});

// The A1 review's inputs, each one a field the user did not mean or a guess between two people before its fix.
describe("what the A1 review found", () => {
  it("reads any 'but' as ruling something out unless a time or a new value follows it", () => {
    expect(reads("rental-application", "fill all fields but my email")).toBeNull();
    expect(reads("rental-application", "fill everything in the form but my phone")).toBeNull();
    expect(reads("car-service-booking", "saturday works, but at 9:30")).toEqual(["Preferred date", "Preferred time"]);
  });

  it("reads a part said after 'in' as where the named fields are, never as the whole part", () => {
    expect(reads("rental-application", "fill only my email in the applicant section")).toEqual(["Email address"]);
    expect(reads("rental-application", "fill my phone in the landlord section")).toBeNull();
    expect(reads("rental-application", "just my email and the applicant section")).toBeNull();
    // A part and a field outside it are two requests.
    expect(reads("rental-application", "the landlord section and my email")).toEqual(["Email address", "Landlord or property manager name", "Landlord phone"]);
  });

  it("does not read one field as someone else's and the next as the user's by default", () => {
    expect(reads("job-application", "fill her email and phone")).toBeNull();
    expect(reads("job-application", "fill Simone's name and email")).toBeNull();
    // One Ask fills one person's details: the user's and someone else's together are not read either.
    expect(reads("job-application", "fill my name and Simone's email")).toBeNull();
  });

  it("keeps every window a person is in, so a named source with two people still asks", () => {
    const d = deskOf("rental-application");
    const plain = intentSnapshot("put his number in from the rental notes", d.model, d.form, d.memory);
    expect(readHeads(plain, cannedHeads(plain, { reading: "code" }))).toMatchObject({ route: "ask", open: ["person"] });
    // An older note that names Gary too, seen before the rental notes (the review's case): reopen the rental notes after it.
    const rental = snaps.find((x) => x.window.title === "Rental notes.txt");
    if (rental === undefined) throw new Error("no rental notes");
    d.model.close(rental.window.windowId, T0 - 40_000);
    d.model.apply(snap([field("te/old", "Landlord: Gary Pruitt\n(512) 555-0193", { role: "AXTextArea" })], { at: T0 - 35_000, windowId: "old-note", title: "Old lease.txt", app: { pid: 7999, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: false }));
    d.model.apply({ ...rental, at: T0 - 30_000, focused: true, focusedKey: null });
    const form = d.model.windows.get(d.form.window.windowId);
    if (form === undefined) throw new Error("form window gone");
    const s = intentSnapshot("put his number in from the rental notes", d.model, form, d.memory);
    expect(readHeads(s, cannedHeads(s, { reading: "code" }))).toMatchObject({ route: "ask", open: ["person"] });
  });
});

// Safety bugs the held-out runs exposed (reported with their first-run numbers; the inputs here are reworded).
describe("what the held-out runs exposed", () => {
  it("reads every word of a part's name as the part's, so none of them names a field", () => {
    expect(reads("rental-application", "do the current residence part")).toEqual(["Street address", "Apt / Unit (optional)", "City", "State", "ZIP code", "Moved in (MM/YYYY)", "Monthly rent ($)", "Reason for moving (optional)"]);
  });

  it("names a part by some of its words only beside a part noun", () => {
    expect(reads("job-application", "add the visa question")).toBeNull();
    expect(reads("rental-application", "do the employment bit")).toEqual(["Current employer", "Job title", "Gross monthly income ($)", "Vehicle make and model (optional)"]);
  });

  it("reads a label's words only in its own order", () => {
    expect(reads("hubspot-contact", "my name + company")).toBeNull();
    expect(reads("hubspot-contact", "my name and the company name")).toEqual(["First Name", "Last Name", "Company name"]);
  });

  it("never reads 'this' as a label word, and a form's own name as a person", () => {
    expect(reads("course-enrollment", "can you get this enrollment form done")).toBe("all");
    const s = snapOn("job-application", "fill out the Northgate application for me");
    expect(readHeads(s, cannedHeads(s, { reading: "code", scope: "unclear", source: "any", whose: "user" }))).toMatchObject({ route: "fill", scope: "all", whose: "user" });
    expect(readHeads(s, cannedHeads(s, { reading: "code", scope: "unclear", source: "any", whose: "user" })).person).toBeUndefined();
  });
});

// The A1 fix-check review's inputs.
describe("what the A1 fix-check found", () => {
  it("decides whether a part only says where the fields are after every field word is read", () => {
    expect(reads("rental-application", "fill only my city in the current residence section")).toEqual(["City"]);
    expect(reads("rental-application", "fill in what's in the landlord section")).toEqual(["Landlord or property manager name", "Landlord phone"]);
  });

  it("keeps a name that is a word of the form's title a person, unless a form noun follows it", () => {
    const either = snapOn("event-rsvp", "fill out the RSVP for Jun or Bea");
    expect(readHeads(either, cannedHeads(either, { reading: "code" }))).toMatchObject({ route: "ask", open: ["person"] });
    const jun = snapOn("event-rsvp", "fill in the RSVP for Jun");
    expect(readHeads(jun, cannedHeads(jun, { reading: "code" }))).toMatchObject({ whose: "p1" });
  });

  it("never takes a first name for one of two full names that start with it", () => {
    const d = deskOf("rental-application");
    d.model.apply(snap([field("te/jones", "Landlord: Gary Jones\n(512) 555-0111", { role: "AXTextArea" })], { at: T0 - 50_000, windowId: "jones-note", title: "Old lease.txt", app: { pid: 7998, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: false }));
    const form = d.model.windows.get(d.form.window.windowId);
    if (form === undefined) throw new Error("form window gone");
    const s = intentSnapshot("put his number in", d.model, form, [...d.memory, { id: "people-1", label: "landlord", text: "Gary", whose: "other" }]);
    const names = s.others.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["Gary", "Gary Pruitt", "Gary Jones"]));
  });
});
