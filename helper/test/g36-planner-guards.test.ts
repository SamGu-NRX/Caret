// Planner and guard rules for whose details an Ask means, which values it spells out, and which phone a field wants.
// All names, numbers and addresses are invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { proposeFill, PAGE_WINDOW_KIND } from "../src/fill/fill.ts";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { checkIntent, intentSnapshot, type AskIntent } from "../src/planner/intent.ts";
import { headsRequest, readHeads, scopeId, tieLiterals } from "../src/planner/intent-heads.ts";
import type { JevResult } from "../src/fill/jev.ts";
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

  it("reads a sender's whole name typed in lower case as the source", () => {
    const s = snapFor("do the contact part w the things marta quill sent");
    expect(readWhose(s, s.others, s.memoryValues).kind).toBe("user");
    expect(snapFor("fill my contact details, not what marta quill sent")).toMatchObject({ named: [], excluded: ["mail"] });
  });

  it("reads no relation as a sender's name", () => {
    expect(onlyInSources("my wife sent it, put her down as the contact", "my wife")).toBe(false);
  });
});

describe("a value the instruction gives a company field is not a person (b31-21 shape)", () => {
  const snapOf = (instruction: string, labels: readonly string[]) => {
    const m = new ScreenModel();
    return intentSnapshot(instruction, m, pageForm(m, labels), []);
  };
  const refOf = (s: ReturnType<typeof snapOf>, name: string): string | undefined => s.fields.find((f) => f.name === name)?.ref;
  const result = (answers: JevResult["answers"]): JevResult => ({ model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 });
  /** The heads with `whose`, and both scope wordings choosing every field. */
  const read = (s: ReturnType<typeof snapOf>, whose: string) => {
    const dflt: Record<string, string> = { route: "some", why: "nothingToFill", source: "any", whose };
    const heads = result(Object.fromEntries(Object.keys(headsRequest(s).questions).map((id) => [id, { choice: dflt[id] ?? "none", confidence: 0.9 }])));
    const scope = result(Object.fromEntries(s.fields.map((f) => [scopeId(f.ref), { choice: "asks", confidence: 0.95 }])));
    return readHeads(s, heads, [scope, scope]);
  };
  const COMPANY = "my name + company, its Ferrant Pottery Studio";
  const FORM = ["First Name", "Last Name", "Company name"];

  it("ties the company the instruction spells out to the company field, and reads no person in it", () => {
    const s = snapOf(COMPANY, FORM);
    expect(s.literals).toEqual(["Ferrant Pottery Studio"]);
    expect(tieLiterals(s, s.fields)).toEqual([{ field: refOf(s, "Company name"), text: "Ferrant Pottery Studio" }]);
    expect(read(s, "user")).toMatchObject({ route: "fill", whose: "user", literals: [{ field: refOf(s, "Company name"), text: "Ferrant Pottery Studio" }] });
  });

  it("leaves whose details unresolved where the heads left them", () => {
    expect(read(snapOf(COMPANY, FORM), "unclear")).toMatchObject({ route: "ask", open: ["person"] });
  });

  it("keeps a name the instruction gives any other field a person", () => {
    const s = snapOf("set contact name to Dana Lab and fill phone", ["Contact name", "Phone"]);
    expect(s.persons.map((p) => p.span)).toEqual(["Dana Lab"]);
    expect(read(s, "unclear")).toMatchObject({ whose: "p1" });
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

describe("one of several phones: a lead-in to the user's own note is not the phone's purpose (b31-13 shape)", () => {
  const SIG = "\n\nThanks,\nPriya Raman\nFront Desk, Alder Dental\n(303) 555-0199";
  const fill = async (body: string, labels: readonly string[] = ["Mobile phone"]) => {
    const m = new ScreenModel();
    m.apply(snap([field("src/body", body, { role: "AXTextArea" })], { at: 900, windowId: "src", title: "Re: your visit", app: MAIL_APP, focused: true }));
    pageForm(m, labels);
    const p = await proposeFill(m, jevPickingText(() => "(303) 555-0112", 0.93), "form", key(labels[0] as string), 2000);
    return Object.fromEntries(labels.map((l) => [l, p.fields.find((f) => f.key === key(l))]));
  };
  const mobile = async (body: string) => (await fill(body))["Mobile phone"];

  it.each(["From your earlier note: visit at 9:00, best number for you is", "Per your last message: best number for you is"])(
    "fills the user's phone after \"%s\", beside the sender's own phone",
    async (lead) => {
      expect(await mobile(`Hi Sam,\n\n${lead} (303) 555-0112.${SIG}`)).toMatchObject({ value: "(303) 555-0112", withheld: null });
    },
  );

  it.each([
    "Home phone: (303) 555-0112",
    "Recruiter: Odile Marsh, (303) 555-0112",
    "From the recruiter: Dana's cell (303) 555-0112",
    "From my backup: (303) 555-0112",
    "From your notes: Dana's cell (303) 555-0112",
    "From your notes: work phone (303) 555-0112",
  ])("still withholds %s beside another phone, and only then", async (line) => {
    expect(await mobile(`Hi Sam,\n\n${line}${SIG}`)).toMatchObject({ value: null, withheld: "ambiguous" });
    expect(await mobile(`Hi Sam,\n\n${line}`)).toMatchObject({ value: "(303) 555-0112", withheld: null });
  });

  it("keeps the phone out of a field that takes no phone", async () => {
    const f = await fill(`Hi Sam,\n\nFrom your earlier note: best number for you is (303) 555-0112.${SIG}`, ["Mobile phone", "Delivery instructions"]);
    expect(f["Mobile phone"]).toMatchObject({ value: "(303) 555-0112" });
    expect(f["Delivery instructions"]).toMatchObject({ value: null });
  });
});
