// Planner and guard rules, each on a synthetic desk shaped like the B31 Ask its describe names. All names, numbers and
// addresses are invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { proposeFill, PAGE_WINDOW_KIND } from "../src/fill/fill.ts";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { checkIntent, intentSnapshot, personSpans, type AskIntent } from "../src/planner/intent.ts";
import { tieLiterals } from "../src/planner/intent-heads.ts";
import { pointsAtOther, readWhose } from "../src/planner/people.ts";
import { onlyInSources } from "../src/planner/sources.ts";
import { field, jevPickingText, MAIL_APP, node, snap, text } from "./builders.ts";

beforeAll(() => setGeneratorClock(() => 0));
afterAll(() => setGeneratorClock(null));

const W = "dev.caret.page/g36";
const CHROME = { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" };
const key = (label: string): string => `${W}/textfield:${label}~0`;

/** A page form of text fields with these labels, the first focused, in front of whatever `m` already shows. */
function pageForm(m: ScreenModel, labels: readonly string[]): WindowState {
  const inputs = labels.map((l, i) => field(key(l), "", { parent: `${W}/webarea:~0`, label: l, frame: [100, 60 + 40 * i, 200, 20] }));
  m.apply(snap([node(`${W}/webarea:~0`, "AXWebArea", { label: "Form" }), ...inputs], { at: 1000, windowId: "form", kind: PAGE_WINDOW_KIND, title: "Form", app: CHROME, focused: true, focusedKey: key(labels[0] as string) }));
  const form = m.windows.get("form");
  if (form === undefined) throw new Error("the form window was not applied");
  return form;
}

describe("a person named only as who sent the source is not whose details go in (b31-08 shape)", () => {
  // A mail from the user's partner to the user, holding the user's details; the form asks for the user's contact details.
  function snapFor(instruction: string) {
    const m = new ScreenModel();
    m.apply(snap([text("h1", "From: Marta Quill <marta.quill@example.org>"), text("h2", "To: Sam Rivera <sam.rivera@example.org>"), text("b", "Your new address: 14 Orchard Row, Unit 2")], { at: 900, windowId: "mail", title: "Dentist form", app: { pid: 9002, bundleId: "com.apple.mail", name: "Mail" }, focused: true }));
    return intentSnapshot(instruction, m, pageForm(m, ["Email", "Street address"]), []);
  }
  const intent = (whose: string): AskIntent => ({ route: "fill", why: "none", scope: "all", section: "none", fields: [], sources: [], whose, literals: [] });

  it.each(["do the contact part w the things marta sent", "do the contact part w the things Marta sent"])("reads %s as the user's own details", (instruction) => {
    const s = snapFor(instruction);
    expect(s.persons.map((p) => p.span)).toEqual([instruction.includes("Marta") ? "Marta" : "marta"]);
    expect(readWhose(s, s.others, s.memoryValues).kind).toBe("user");
    expect(pointsAtOther(s)).toBe(false);
    // A maker that took the sender for the subject does not set it either.
    const checked = checkIntent(intent("p1"), s);
    expect(checked.route === "fill" ? checked.scope.person : "not a fill").toBeNull();
  });

  it("still reads a sender named as the person as whose details go in", () => {
    const s = snapFor("put marta down as the contact");
    expect(readWhose(s, s.others, s.memoryValues)).toMatchObject({ kind: "person", ref: "p1" });
  });

  it("rules out the mail a lower-case name sent when the instruction says not to use it", () => {
    for (const instruction of ["fill my contact details, not what marta sent", "fill my contact details, not what Marta sent"]) {
      expect(snapFor(instruction), instruction).toMatchObject({ named: [], excluded: ["mail"] });
    }
  });

  it("rules out a mail named by a sender's full name or a lower-case possessive", () => {
    expect(snapFor("fill my contact details, not what Marta Quill sent")).toMatchObject({ named: [], excluded: ["mail"] });
    expect(snapFor("fill my contact details, not from marta's email")).toMatchObject({ named: [], excluded: ["mail"] });
  });

  it("reads no relation as a sender's name", () => {
    expect(onlyInSources("my wife sent it, put her down as the contact", "my wife")).toBe(false);
  });
});

describe("a company the instruction gives as a value is not a person (b31-21 shape)", () => {
  it.each([
    ["my name + company, its Ferrant Pottery Studio", []],
    ["my name and employer, it's Vale Copper Labs", []],
    // People stay people: a surname that is a street word, or a company word the instruction gives as no value.
    ["put Jimin Park down as my guest", ["Jimin Park", "my guest"]],
    ["put Ken Co down as the contact", ["Ken Co"]],
    ["put Ken Co in contact name and fill contact phone", ["Ken Co"]],
    ["my name + company, its Acme LLC", []],
    ["use Gary's info for the landlord part", ["Gary"]],
  ])("finds the people in %s", (instruction, people) => {
    expect(personSpans(instruction)).toEqual(people);
  });

  const snapOf = (instruction: string, labels: readonly string[]) => {
    const m = new ScreenModel();
    return intentSnapshot(instruction, m, pageForm(m, labels), []);
  };
  const refOf = (s: ReturnType<typeof snapOf>, name: string): string | undefined => s.fields.find((f) => f.name === name)?.ref;

  it("ties the company the instruction spells out to the company field", () => {
    const s = snapOf("my name + company, its Ferrant Pottery Studio", ["First Name", "Last Name", "Company name"]);
    expect(s.literals).toEqual(["Ferrant Pottery Studio"]);
    expect(tieLiterals(s, s.fields)).toEqual([{ field: refOf(s, "Company name"), text: "Ferrant Pottery Studio" }]);
  });

  it("ties a quoted company after \"It's\"", () => {
    const s = snapOf('my name and company, It\'s "Acme Studio"', ["First Name", "Company name"]);
    expect(tieLiterals(s, s.fields)).toEqual([{ field: refOf(s, "Company name"), text: "Acme Studio" }]);
  });

  it("keeps a possessive 'its' a clause of its own", () => {
    const s = snapOf("set work email to primary@example.org, its backup email is secondary@example.org", ["Work email", "Backup email"]);
    expect(tieLiterals(s, s.fields)).toEqual([
      { field: refOf(s, "Work email"), text: "primary@example.org" },
      { field: refOf(s, "Backup email"), text: "secondary@example.org" },
    ]);
  });
});

describe("one of several phones: a sentence's lead-in is not the phone's purpose (b31-13 shape)", () => {
  const SIG = "\n\nThanks,\nPriya Raman\nFront Desk, Alder Dental\n(303) 555-0199";
  const fillMobile = async (body: string) => {
    const m = new ScreenModel();
    m.apply(snap([field("src/body", body, { role: "AXTextArea" })], { at: 900, windowId: "src", title: "Re: your visit", app: MAIL_APP, focused: true }));
    pageForm(m, ["Mobile phone"]);
    const p = await proposeFill(m, jevPickingText(() => "(303) 555-0112", 0.93), "form", key("Mobile phone"), 2000);
    return p.fields.find((f) => f.key === key("Mobile phone"));
  };

  it.each(["As you asked: the visit is at 9:00, best number for you is", "From your earlier email: best number for you is", "As requested, here it is:"])(
    "fills the user's phone after \"%s\", beside the sender's own phone",
    async (lead) => {
      expect(await fillMobile(`Hi Sam,\n\n${lead} (303) 555-0112.${SIG}`)).toMatchObject({ value: "(303) 555-0112", withheld: null });
    },
  );

  it.each(["Home phone: (303) 555-0112", "Recruiter: Odile Marsh, (303) 555-0112", "From recruiter: (303) 555-0112", "From my work phone: (303) 555-0112", "As my backup: (303) 555-0112"])(
    "still withholds %s beside another phone, and only then",
    async (line) => {
      expect(await fillMobile(`Hi Sam,\n\n${line}${SIG}`)).toMatchObject({ value: null, withheld: "ambiguous" });
      expect(await fillMobile(`Hi Sam,\n\n${line}`)).toMatchObject({ value: "(303) 555-0112", withheld: null });
    },
  );
});
