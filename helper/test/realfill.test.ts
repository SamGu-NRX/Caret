// B24: fill on real forms. The deterministic parts (name and address parts, dates and times, the form
// controls, required markers) have one right answer each and are tested in isolation; then proposeFill with a
// stand-in Jev for the anchor, the derived values, the controls and the owner veto. All text is synthetic.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { describeInput, emptyInput, memoryRefOf, memoryValue, parseMemoryRef, proposeFill } from "../src/fill/fill.ts";
import { fieldPart, joinName, partFits, splitAddress, splitName } from "../src/fill/derive.ts";
import { clockTime, readDate } from "../src/fill/when.ts";
import { consentLike, formControls, matchOption, optionInText } from "../src/fill/controls.ts";
import { describeField, fieldLabelText } from "../src/fill/descriptor.ts";
import type { FillProposal, Node } from "../src/protocol.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { field, jevPickingText, MAIL_APP, node, snap, text, value } from "./builders.ts";
import { MESSAGES } from "./desks.ts";
import { collectCandidates, setGeneratorClock } from "../src/fill/candidates.ts";
import { SnippetLedger } from "../src/privacy.ts";
import { fieldTerms, misfit } from "../src/fill/kinds.ts";

// The generator's time budget reads a fixed clock here, so a loaded machine cannot stop it partway and change an
// answer these tests check (candidates.ts setGeneratorClock); B25's full suite failed two of them under load.
beforeAll(() => setGeneratorClock(() => 0));
afterAll(() => setGeneratorClock(null));

describe("splitName", () => {
  it.each([
    ["Jordan Reyes", "Jordan", null, "Reyes"],
    ["Riley Ade Okafor", "Riley", "Ade", "Okafor"],
    ["Ana de la Cruz", "Ana", null, "de la Cruz"],
    ["Ludwig van der Rohe", "Ludwig", null, "van der Rohe"],
    ["Dr. Simone Achebe", "Simone", null, "Achebe"],
    ["Martin Luther King Jr.", "Martin", "Luther", "King"],
    ["Okafor, Riley Ade", "Riley", "Ade", "Okafor"],
    ["Daniel James Okonkwo-Reyes", "Daniel", "James", "Okonkwo-Reyes"],
  ])("splits %s", (full, first, middle, last) => {
    expect(splitName(full)).toEqual({ kind: "split", first, middle, last });
  });

  it.each(["Cher", "Ana María López García", "Dr. Cher", "Okafor, my manager", "Jordan Reyes <jordan@example.org>", "Room 4B", "Ana de"])("asks rather than guessing for %s", (full) => {
    expect(splitName(full).kind).toBe("ask");
  });

  it("keeps every part a substring of the name as written, and joins first and last", () => {
    for (const n of ["Riley Ade Okafor", "Ana de la Cruz", "Okafor, Riley Ade"]) {
      const s = splitName(n);
      if (s.kind !== "split") throw new Error(n);
      for (const p of [s.first, s.middle, s.last]) if (p !== null) expect(n).toContain(p);
    }
    expect(joinName(" Kenji ", "Watanabe")).toBe("Kenji Watanabe");
  });
});

describe("splitAddress", () => {
  it.each([
    ["4410 Speedway Apt 2, Austin, Texas 78751", { street: "4410 Speedway", unit: "Apt 2", city: "Austin", state: "Texas", zip: "78751" }],
    ["27 Linden Terrace, Unit 3, Somerville, Massachusetts 02143", { street: "27 Linden Terrace", unit: "Unit 3", city: "Somerville", state: "Massachusetts", zip: "02143" }],
    ["88 Birch Hollow Rd, Asheville, NC 28801", { street: "88 Birch Hollow Rd", city: "Asheville", state: "NC", zip: "28801" }],
    ["1 Main St, Springfield, IL", { street: "1 Main St", city: "Springfield", state: "IL" }],
  ])("splits %s", (a, parts) => {
    expect(splitAddress(a)).toEqual(parts);
  });

  it.each(["Room 4B, 3rd floor", "4410 Speedway", "Austin, TX 78701", "12 Elm St, Apt 1, Unit 2, Austin, TX", "5 Oak Ave, Austin Downtown West, Texas 78701, USA"])("does not guess the parts of %s", (a) => {
    expect(splitAddress(a)).toBeNull();
  });
});

describe("fieldPart and partFits", () => {
  it.each([
    ["First name / Given name", "first"],
    ["Middle name (optional)", "middle"],
    ["Last name / Surname", "last"],
    ["Your full name", "full"],
    ["Reference name", "full"],
    ["Company name", null],
    ["Email address", null],
    ["Apt / Unit (optional)", "unit"],
    ["ZIP code", "zip"],
    ["State", "state"],
    ["Street address", "street"],
  ])("reads %s as %s", (label, part) => {
    expect(fieldPart(label)).toBe(part);
  });

  it("reads a bare Address as the street line only beside a City field", () => {
    expect(fieldPart("Address", true)).toBe("street");
    expect(fieldPart("Address", false)).toBeNull();
  });

  it("refuses a sentence in a name field and a non-ZIP in a ZIP field", () => {
    expect(partFits("full", "Dr. Simone Achebe")).toBe(true);
    expect(partFits("full", "Dr. Simone Achebe, my manager at Ridgeline")).toBe(false);
    expect(partFits("first", "Riley")).toBe(true);
    expect(partFits("first", "riley.okafor@example.net")).toBe(false);
    expect(partFits("zip", "78751")).toBe(true);
    expect(partFits("zip", "Austin, TX 78751")).toBe(false);
  });
});

describe("dates and times for date and time fields", () => {
  const ctx = { locale: "en-US", timeZone: "America/Chicago", referenceInstant: null };
  it.each([
    ["March 3, 1991", "1991-03-03"],
    ["Aug 9, 1987", "1987-08-09"],
    ["14 June 2002", "2002-06-14"],
    ["1991-03-03", "1991-03-03"],
  ])("reads %s as %s", (t, iso) => {
    expect(readDate(t, ctx)?.value).toBe(iso);
  });

  it("asks rather than guessing a numeric date with no known source locale, or a weekday with no reference day", () => {
    expect(readDate("04/12/1990", ctx)).toBeNull();
    expect(readDate("Friday", ctx)).toBeNull();
  });

  it.each([
    ["7:30 pm", "19:30"],
    ["Deliver around 7:45 pm", "19:45"],
    ["Saturday, October 17 at 8:45am", "08:45"],
    ["19:30", "19:30"],
    ["12 am", "00:00"],
  ])("reads %s as %s", (t, hhmm) => {
    expect(clockTime(t)?.value).toBe(hhmm);
  });

  it.each(["7:30", "at 3", "9:00 AM-12:30 PM", "no time here"])("does not read %s, which is no one clock time or has no am/pm", (t) => {
    expect(clockTime(t)).toBeNull();
  });
});

describe("required markers in labels (Q1 bug 16)", () => {
  it.each([
    ["Email *", "Email"],
    ["First Name*", "First Name"],
    ["Customer name:", "Customer name"],
    ["Phone (required)", "Phone"],
    ["Name: *", "Name"],
    ["Middle name (optional)", "Middle name (optional)"],
    ["*", "*"],
  ])("reads %s as %s", (raw, label) => {
    expect(fieldLabelText(raw)).toBe(label);
  });

  it("names the field without its marker in a descriptor", () => {
    const m = new ScreenModel();
    m.apply(snap([field("f/email", "", { label: "Email *" })], { at: 1, windowId: "w" }));
    const w = m.windows.get("w");
    if (w === undefined) throw new Error("no window");
    expect(describeField(w, w.nodes.get("f/email") as Node).text).toBe("Text field. Label: 'Email'.");
  });
});

describe("options and boxes", () => {
  it("matches an option exactly, once, and names one only when the text names exactly one", () => {
    expect(matchOption(["Small", "Medium", "Large"], " large ")).toBe("Large");
    expect(matchOption(["TX", "Texas"], "Tex")).toBeNull();
    expect(optionInText(["Small", "Medium", "Large"], "Large, mushroom and onion")).toBe("Large");
    expect(optionInText(["Yes", "No"], "no pets")).toBe("No");
    expect(optionInText(["Small", "Large"], "small or large, either")).toBeNull();
    expect(optionInText(["Text message", "Phone call"], "pick text")).toBeNull();
  });

  it("never ticks a consent or sign-up box", () => {
    for (const l of ["I agree to the Terms", "Send me news about future events", "I certify that the information is true", "Text me updates about the day", "Save this information for next time"]) expect(consentLike(l)).toBe(true);
    for (const l of ["Mushroom", "Tire rotation", "This is my first class at Lakeside"]) expect(consentLike(l)).toBe(false);
  });
});

// A Chrome-shaped page: a web area holding a radio group, two boxes, a select with no options shown, a date
// field with its picker button, and a react-select style combobox; the browser's own tab strip outside it.
const P = "com.google.Chrome/standard";
const page = (): Node[] => [
  node(`${P}/group:~0`, "AXGroup"),
  node(`${P}/radiobutton:tab~0`, "AXRadioButton", { parent: `${P}/group:~0`, subrole: "AXTabButton", label: "Order - Memory usage", states: ["selected", "checked"] }),
  node(`${P}/webarea:~0`, "AXWebArea", { parent: `${P}/group:~0`, label: "Order" }),
  field(`${P}/textfield:customer name~0`, "", { parent: `${P}/webarea:~0`, label: "Customer name:", frame: [100, 100, 200, 20] }),
  node(`${P}/group:pizza size~0`, "AXGroup", { parent: `${P}/webarea:~0`, subrole: "AXFieldset", label: "Pizza Size" }),
  node(`${P}/group:pizza size/radiobutton:small~0`, "AXRadioButton", { parent: `${P}/group:pizza size~0`, label: "Small", frame: [100, 140, 20, 20] }),
  node(`${P}/group:pizza size/radiobutton:large~0`, "AXRadioButton", { parent: `${P}/group:pizza size~0`, label: "Large", frame: [100, 160, 20, 20] }),
  node(`${P}/checkbox:mushroom~0`, "AXCheckBox", { parent: `${P}/webarea:~0`, label: "Mushroom", frame: [100, 200, 20, 20] }),
  node(`${P}/checkbox:send me deals~0`, "AXCheckBox", { parent: `${P}/webarea:~0`, label: "Send me deals by email", frame: [100, 220, 20, 20] }),
  node(`${P}/popupbutton:degree *~0`, "AXPopUpButton", { parent: `${P}/webarea:~0`, label: "Degree *", value: "Select...", frame: [100, 240, 200, 20] }),
  node(`${P}/datefield:date of birth *~0`, "AXDateField", { parent: `${P}/webarea:~0`, label: "Date of birth *", frame: [100, 280, 200, 20] }),
  node(`${P}/datefield:date of birth */popupbutton:show date picker~0`, "AXPopUpButton", { parent: `${P}/datefield:date of birth *~0`, label: "Show date picker Date of birth *" }),
  node(`${P}/timefield:delivery time~0`, "AXTimeField", { parent: `${P}/webarea:~0`, label: "Delivery time:", frame: [100, 300, 200, 20] }),
  field(`${P}/combobox:school *~0`, "", { parent: `${P}/webarea:~0`, role: "AXComboBox", label: "School *", frame: [100, 320, 200, 20] }),
  // A page's terms text: real pages hold far more text than their labels, so a question may carry every field's
  // descriptor (privacy.ts gives a window of 2,400 characters or more its full 1,200).
  ...Array.from({ length: 30 }, (_, i) => text(`${P}/statictext:terms ${i}~0`, `Terms paragraph ${i}: orders are baked fresh and delivered within the area shown at checkout.`, undefined, `${P}/webarea:~0`)),
];

describe("formControls", () => {
  it("reads the page's controls in document order, never the browser's own, and only empty ones", () => {
    const m = new ScreenModel();
    m.apply(snap(page(), { at: 1, windowId: "form" }));
    const w = m.windows.get("form");
    if (w === undefined) throw new Error("no window");
    const cs = formControls(w);
    // The sign-up box is left out: Caret never ticks one (consentLike).
    expect(cs.map((c) => [c.control, c.label, c.options])).toEqual([
      ["radio", "Pizza Size", ["Small", "Large"]],
      ["checkbox", "Mushroom", null],
      ["select", "Degree", null],
      ["date", "Date of birth", null],
      ["time", "Delivery time", null],
    ]);
    // A ticked box, a picked radio and a set date are not offered again.
    m.apply(snap(page().map((n) => (n.role === "AXCheckBox" || n.label === "Large" ? { ...n, states: ["checked" as const] } : n.role === "AXDateField" ? { ...n, value: "03/03/1991" } : n)), { at: 2, windowId: "form" }));
    expect(formControls(m.windows.get("form") as never).map((c) => c.control)).toEqual(["select", "time"]);
  });
});

/** A note the user just left, an unrelated draft too long for its budget, and the page, focused on Customer name. */
function desk(noteText: string, extra: Node[] = [], draftExtra: readonly string[] = []): ScreenModel {
  const m = new ScreenModel();
  const draft = [
    "Notes for Thursday",
    "Could we go over the intro and examples before the review? The examples feel a bit thin in section two, and we still owe Priya a reply.",
    "Also, let's set up a call with Priya Thursday 3pm PT to go over the budget.",
    "Dana said the venue deposit is due next week.",
    ...draftExtra,
  ].join("\n");
  m.apply(snap([field("te/draft", draft, { role: "AXTextArea" })], { at: 100, windowId: "draft", title: "Draft.txt", app: { pid: 7000, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, values: [value("time", "3pm", "te/draft")] }));
  m.apply(snap([field("te/note", noteText, { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Order note.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, values: [value("phone", "(512) 555-0147", "te/note")] }));
  m.apply(snap([...page(), ...extra], { at: 1000, windowId: "form", title: "Order", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: `${P}/textfield:customer name~0` }));
  return m;
}
const NOTE = ["Pizza order", "Name: Jordan Reyes", "Phone: (512) 555-0147", "Large, mushroom and onion", "Deliver around 7:30 pm"].join("\n");
const fieldOf = (p: FillProposal, keyPart: string) => p.fields.find((f) => f.key.includes(keyPart));

describe("proposeFill on a real-shaped form (B24)", () => {
  it("offers the note's labelled name although an unrelated draft did not fit its budget (Q1 bug 1)", async () => {
    const pick = (_: string, ins: string): string | null => (ins.includes("'Customer name'") ? "Jordan Reyes" : null);
    const p = await proposeFill(desk(NOTE), jevPickingText(pick), "form", `${P}/textfield:customer name~0`, 2000);
    expect(fieldOf(p, "customer name")).toMatchObject({ value: "Jordan Reyes", withheld: null, source: { windowId: "note" } });
  });

  it("reads what a cut window that is no conversation left out, instead of treating all of it as unread", () => {
    // B13 set cutAll for any such window, which withheld every name and every field whose label names no kind.
    // Since B25 a mixed note's short lines all fit its budget, so this draft runs past WINDOW_CHARS with agenda lines.
    const m = desk(NOTE, [], Array.from({ length: 30 }, (_, i) => `Agenda item ${i + 1}: slide ${i + 3} and the open questions from week ${i + 1}`));
    const g = collectCandidates(m, "form", { now: 2000, ledger: new SnippetLedger(m.windows.values()), fields: [fieldTerms(["Customer name"]), fieldTerms(["Delivery instructions"])] });
    expect(g.cut).toContain("draft");
    expect(g.cutAll).toBe(false);
    // The draft's left-out sentence names Priya beside a time: a sentence, not a contact line, so no name counts as kept out.
    expect(g.namesCut).toBe(false);
  });

  it("sets a radio group by the option the chosen line names, ticks a box the line names, reads the time, and leaves the rest to the user", async () => {
    const m = desk(NOTE);
    const pick = (_: string, ins: string): string | null =>
      ins.includes("'Pizza Size'") || ins.includes("'Mushroom'") || ins.includes("'Send me deals") ? "Large, mushroom and onion" : ins.includes("'Delivery time'") ? "Deliver around 7:30 pm" : null;
    const p = await proposeFill(m, jevPickingText(pick), "form", `${P}/textfield:customer name~0`, 2000);
    expect(fieldOf(p, "group:pizza size~0")).toMatchObject({ control: "radio", value: null, handoff: { value: "Large", source: { windowId: "note" } } });
    expect(fieldOf(p, "checkbox:mushroom")).toMatchObject({ control: "checkbox", value: null, handoff: { value: "checked" } });
    expect(fieldOf(p, "timefield")).toMatchObject({ control: "time", handoff: { value: "19:30", display: "7:30 PM" } });
    // A sign-up box is never ticked, so it is not even asked about.
    expect(fieldOf(p, "send me deals")).toBeUndefined();
    // No options shown: the select is named and left; the combobox too, with no value and no question.
    expect(fieldOf(p, "popupbutton:degree")).toMatchObject({ control: "select", handoff: null, value: null, asks: [] });
    expect(fieldOf(p, "combobox:school")).toMatchObject({ control: "combobox", handoff: null, value: null, asks: [] });
  });

  it("splits a full name for First and Last, and asks rather than splitting a single name", async () => {
    const first = field(`${P}/textfield:first name~0`, "", { parent: `${P}/webarea:~0`, label: "First Name *", frame: [100, 400, 200, 20] });
    const last = field(`${P}/textfield:last name~0`, "", { parent: `${P}/webarea:~0`, label: "Last Name *", frame: [100, 420, 200, 20] });
    const pick = (_: string, ins: string): string | null => (ins.includes("'First Name'") ? "Jordan" : ins.includes("'Last Name'") ? "Reyes" : null);
    const p = await proposeFill(desk(NOTE, [first, last]), jevPickingText(pick), "form", `${P}/textfield:customer name~0`, 2000);
    expect(fieldOf(p, "first name")).toMatchObject({ value: "Jordan", source: { windowId: "note" } });
    expect(fieldOf(p, "last name")).toMatchObject({ value: "Reyes", source: { windowId: "note" } });
    const single = await proposeFill(desk(NOTE.replace("Jordan Reyes", "Cher"), [first, last]), jevPickingText(pick), "form", `${P}/textfield:customer name~0`, 2000);
    expect(fieldOf(single, "first name")?.value ?? null).toBeNull();
    expect(fieldOf(single, "last name")?.value ?? null).toBeNull();
  });

  it("withholds a value both asks say is someone else's from a field that wants the user's (the owner veto)", async () => {
    const m = desk(NOTE);
    const mail = snap([text("mail/sig", "Dana Whitfield"), text("mail/phone", "(415) 555-0162")], { at: 950, windowId: "mail", title: "Venue deposit", app: MAIL_APP, focused: true, values: [value("phone", "(415) 555-0162", "mail/phone")] });
    m.apply(mail);
    m.apply(snap([...page(), field(`${P}/textfield:phone~0`, "", { parent: `${P}/webarea:~0`, label: "Phone", frame: [100, 440, 200, 20] })], { at: 1000, windowId: "form", title: "Order", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: `${P}/textfield:customer name~0` }));
    const pick = (_: string, ins: string): string | null => (ins.includes("'Phone'") ? "(415) 555-0162" : null);
    const owner = (ins: string): "user" | "other" => (ins.includes("(415)") ? "other" : "user");
    const requests: JevRequest[] = [];
    const recorded: AskJev = async (req) => (requests.push(req), jevPickingText(pick, 0.9, () => "user", owner)(req));
    const vetoed = await proposeFill(m, recorded, "form", `${P}/textfield:customer name~0`, 2000);
    // Both stage-one asks put the field on the user and the value on someone else, so the value stage never offers it.
    expect(fieldOf(vetoed, "textfield:phone")).toMatchObject({ value: null, withheld: null });
    const phoneQuestions = requests.flatMap((r) => Object.entries(r.questions).filter(([, q]) => String(q.instructions).includes("'Phone'") && !Object.keys(q.criteria).includes("user")));
    expect(phoneQuestions).toHaveLength(2);
    for (const [, q] of phoneQuestions) expect(Object.values(q.criteria).join(" ")).not.toContain("(415) 555-0162");
    // An unsettled owner vetoes nothing when memory holds no value of the kind: Jev cannot know who the user is.
    const unclear = await proposeFill(m, jevPickingText(pick, 0.9, () => "user", () => "unclear"), "form", `${P}/textfield:customer name~0`, 2000);
    expect(fieldOf(unclear, "textfield:phone")).toMatchObject({ value: "(415) 555-0162", withheld: null });
  });

  it("holds a window's email of unsettled owner from a field that wants the user's, when the user's own email is in memory", async () => {
    const m = desk(NOTE);
    m.apply(snap([text("mail/sig", "dana.whitfield@lumenlabs.example.com")], { at: 950, windowId: "mail", title: "Venue deposit", app: MAIL_APP, focused: true, values: [value("email", "dana.whitfield@lumenlabs.example.com", "mail/sig")] }));
    m.apply(snap([...page(), field(`${P}/textfield:work email~0`, "", { parent: `${P}/webarea:~0`, label: "Work email", frame: [100, 440, 200, 20] })], { at: 1000, windowId: "form", title: "Order", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: `${P}/textfield:customer name~0` }));
    const about = [{ id: "about-2", label: "Email", value: "riley.okafor@example.net", kind: "email" as const }];
    const pick = (_: string, ins: string): string | null => (ins.includes("'Work email'") ? "dana.whitfield@lumenlabs.example.com" : null);
    const unsettled = await proposeFill(m, jevPickingText(pick, 0.9, () => "user", () => "unclear"), "form", `${P}/textfield:customer name~0`, 2000, { about });
    expect(fieldOf(unsettled, "work email")).toMatchObject({ value: null, withheld: "otherPerson" });
    const own = await proposeFill(m, jevPickingText(pick, 0.9, () => "user", () => "user"), "form", `${P}/textfield:customer name~0`, 2000, { about });
    expect(fieldOf(own, "work email")).toMatchObject({ value: "dana.whitfield@lumenlabs.example.com", withheld: null });
  });

  it("refuses a whole address in a Street field and offers its street line instead", async () => {
    const street = field(`${P}/textfield:street address~0`, "", { parent: `${P}/webarea:~0`, label: "Street address", frame: [100, 460, 200, 20] });
    const city = field(`${P}/textfield:city~0`, "", { parent: `${P}/webarea:~0`, label: "City", frame: [100, 480, 200, 20] });
    const note = `${NOTE}\nAddress: 4410 Speedway Apt 2, Austin, Texas 78751`;
    const whole = await proposeFill(desk(note, [street, city]), jevPickingText((_, ins) => (ins.includes("'Street address'") ? "4410 Speedway Apt 2, Austin, Texas 78751" : null)), "form", `${P}/textfield:customer name~0`, 2000);
    expect(fieldOf(whole, "street address")).toMatchObject({ value: null, withheld: "wrongKind" });
    const parts = await proposeFill(desk(note, [street, city]), jevPickingText((_, ins) => (ins.includes("'Street address'") ? "4410 Speedway" : ins.includes("'City'") ? "Austin" : null)), "form", `${P}/textfield:customer name~0`, 2000);
    expect(fieldOf(parts, "street address")).toMatchObject({ value: "4410 Speedway", source: { windowId: "note" } });
    expect(fieldOf(parts, "textfield:city")).toMatchObject({ value: "Austin", source: { windowId: "note" } });
  });
});

describe("B24 review fixes", () => {
  it("never joins a first and a last name from two blocks, which can be two people", async () => {
    const m = new ScreenModel();
    m.apply(snap([field("te/a", "Your details\nFirst name: Jordan", { role: "AXTextArea" }), field("te/b", "Landlord\nLast name: Singh", { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Notes", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
    m.apply(snap([...page(), field(`${P}/textfield:full name~0`, "", { parent: `${P}/webarea:~0`, label: "Full name", frame: [100, 500, 200, 20] })], { at: 1000, windowId: "form", title: "Order", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: `${P}/textfield:customer name~0` }));
    const requests: JevRequest[] = [];
    const ask: AskJev = async (req) => (requests.push(req), jevPickingText(() => null)(req));
    await proposeFill(m, ask, "form", `${P}/textfield:customer name~0`, 2000);
    const offered = requests.flatMap((r) => Object.values(r.questions).flatMap((q) => Object.values(q.criteria)));
    expect(offered.some((d) => d?.includes("Jordan Singh"))).toBe(false);
  });

  it("keeps the name cut on a pick from the window just left: a kept name may not be the one the form wants", () => {
    const m = desk(NOTE);
    // More contacts than the chat's budget holds as a group, so names are kept out (candidates.ts namesCut).
    const chat = Array.from({ length: 30 }, (_, i) => `Person ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}lvarez-Quintero Delacroix <p${i}@example.org>`);
    m.apply(snap(chat.map((l, i) => text(`chat/m${i}`, l)), { at: 850, windowId: "chat", title: "Team chat", app: MESSAGES, values: chat.map((_, i) => value("email", `p${i}@example.org`, `chat/m${i}`)) }));
    const g = collectCandidates(m, "form", { now: 2000, ledger: new SnippetLedger(m.windows.values()), fields: [fieldTerms(["Customer name"])] });
    expect(g.namesCut).toBe(true);
    return proposeFill(m, jevPickingText((_, ins) => (ins.includes("'Customer name'") ? "Jordan Reyes" : null)), "form", `${P}/textfield:customer name~0`, 2000).then((p) => {
      expect(fieldOf(p, "customer name")).toMatchObject({ value: null, withheld: "sourceCut" });
    });
  });

  it("reads every proposed input back the way it proposed it, so the helper's revalidation keeps controls", async () => {
    const m = desk(NOTE);
    const p = await proposeFill(m, jevPickingText(() => null), "form", `${P}/textfield:customer name~0`, 2000);
    const w = m.windows.get("form");
    if (w === undefined) throw new Error("no form");
    for (const f of p.fields) {
      const x = emptyInput(w, f.key);
      expect(x?.control).toBe(f.control);
      expect(x === null ? null : describeInput(w, x)).toBe(f.descriptor);
    }
    expect(p.fields.some((f) => f.control === "checkbox") && p.fields.some((f) => f.control === "radio")).toBe(true);
  });

  it("gives a remembered name's part back by the same split, and nothing else", () => {
    expect(memoryValue("Riley Ade Okafor", "first")).toBe("Riley");
    expect(memoryValue("Riley Ade Okafor", "middle")).toBe("Ade");
    expect(memoryValue("Riley Ade Okafor", undefined)).toBe("Riley Ade Okafor");
    expect(memoryValue("Cher", "first")).toBeNull();
  });

  it("checks organization names and dates without refusing real ones", () => {
    expect(misfit("3M", ["Employer"])).toBeNull();
    expect(misfit("jo@acme.example", ["Company email"])).toBeNull();
    expect(misfit("Junior Analyst at Ridgeline Outdoor Co (since 2024)", ["Current company"])).not.toBeNull();
    // A list after a comma is not a name (B25), a legal suffix is.
    expect(misfit("Brightline Dental Labs, lab technician, $5,200/mo gross", ["Current employer"])).not.toBeNull();
    expect(misfit("Brightline Dental Labs, lab technician", ["Current employer"])).not.toBeNull();
    for (const v of ["Acme, Inc.", "Ridgeline Outdoor, LLC", "Brightline Dental Labs", "Studio 54"]) expect(misfit(v, ["Current employer"])).toBeNull();
    for (const v of ["at", "9999-99-99", "13/13/2026"]) expect(misfit(v, ["Date"])).not.toBeNull();
    for (const v of ["11/12/2026", "05/2027", "12", "March 3, 1991", "October 8, 2026 at 3:00 PM"]) expect(misfit(v, ["Date"])).toBeNull();
    expect(misfit("23pm", ["Time"])).not.toBeNull();
    // A field for one part of a date takes only that part (the corpus's Day under Date of birth took a whole date).
    expect(misfit("04/12/1990", ["Day"])).not.toBeNull();
    expect(misfit("12", ["Day"])).toBeNull();
    expect(misfit("1990", ["Year"])).toBeNull();
    expect(misfit("April", ["Month"])).toBeNull();
    expect(misfit("3:00 PM", ["Time"])).toBeNull();
  });
});

describe("B24 review fixes: the owner questions' cap", () => {
  it("does not offer a person's value past the owner questions' cap to a field that wants a person's details", async () => {
    const m = new ScreenModel();
    for (let w = 0; w < 3; w++) {
      const lines = Array.from({ length: 15 }, (_, i) => `p${w * 15 + i}@example.org`);
      m.apply(snap(lines.map((l, i) => text(`src${w}/l${i}`, l)), { at: 100 + w, windowId: `src${w}`, title: `List ${w}`, app: MAIL_APP, values: lines.map((l, i) => value("email", l, `src${w}/l${i}`)) }));
    }
    m.apply(snap([...page(), field(`${P}/textfield:email~0`, "", { parent: `${P}/webarea:~0`, label: "Email", frame: [100, 520, 200, 20] })], { at: 1000, windowId: "form", title: "Order", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: `${P}/textfield:customer name~0` }));
    const all = collectCandidates(m, "form", { now: 2000, ledger: new SnippetLedger(m.windows.values()), fields: [fieldTerms(["Email"])] }).candidates.filter((c) => c.text.includes("@"));
    expect(all.length).toBeGreaterThan(40);
    const past = (all[all.length - 1] as { text: string }).text;
    const requests: JevRequest[] = [];
    const ask: AskJev = async (req) => (requests.push(req), jevPickingText((_, ins) => (ins.includes("'Email'") ? past : null))(req));
    const p = await proposeFill(m, ask, "form", `${P}/textfield:customer name~0`, 2000);
    expect(fieldOf(p, "textfield:email")?.value ?? null).toBeNull();
    // Never offered to Email in the value stage.
    const emailQuestions = requests.flatMap((r) => Object.values(r.questions).filter((q) => String(q.instructions).includes("'Email'") && !("user" in q.criteria)));
    expect(emailQuestions.length).toBe(2);
    for (const q of emailQuestions) expect(Object.values(q.criteria).join(" ")).not.toContain(past);
  });
});

describe("B24 fix-check review", () => {
  const formWith = (m: ScreenModel): void => {
    m.apply(snap([...page(), field(`${P}/textfield:full name~0`, "", { parent: `${P}/webarea:~0`, label: "Full name", frame: [100, 500, 200, 20] })], { at: 1000, windowId: "form", title: "Order", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: `${P}/textfield:customer name~0` }));
  };
  const joinsOffered = async (noteText: string): Promise<boolean> => {
    const m = new ScreenModel();
    m.apply(snap([field("te/a", noteText, { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Notes", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
    formWith(m);
    const requests: JevRequest[] = [];
    await proposeFill(m, async (req) => (requests.push(req), jevPickingText(() => null)(req)), "form", `${P}/textfield:customer name~0`, 2000);
    return requests.some((r) => Object.values(r.questions).some((q) => Object.values(q.criteria).some((d) => d?.includes("joined"))));
  };

  it("joins a first and a last name only from lines next to each other, even in one text area", async () => {
    expect(await joinsOffered("Your details\nFirst name: Jordan\n\nLandlord\nLast name: Singh")).toBe(false);
    expect(await joinsOffered("Guest\nFirst name: Kenji\nLast name: Watanabe")).toBe(true);
  });

  it("names a remembered name's part in a step's memory reference, and reads it back", () => {
    expect(memoryRefOf({ id: "about-1", part: "first" })).toBe("about-1#first");
    expect(memoryRefOf({ id: "about-1" })).toBe("about-1");
    expect(parseMemoryRef("about-1#last")).toEqual({ id: "about-1", part: "last" });
    expect(parseMemoryRef("about#odd")).toEqual({ id: "about#odd", part: undefined });
    // A changed name gives its own parts, not any part that happens to match.
    expect(memoryValue("Morgan Riley", "first")).toBe("Morgan");
  });

  it("refuses impossible dates and reads a date part from the field's own label", () => {
    for (const v of ["2026-02-31", "99 May 2026", "May 3 2026 at 99:99 PM", "2025-02-29"]) expect(misfit(v, ["Date"])).not.toBeNull();
    for (const v of ["2024-02-29", "May 3 2026 at 3:30 PM", "31/12/2026"]) expect(misfit(v, ["Date"])).toBeNull();
    expect(misfit("04/12/1990", ["Day", null, "DD"])).not.toBeNull();
    expect(misfit("Monday", ["Day"])).toBeNull();
    expect(misfit("abc", ["Constructor"])).toBeNull();
  });
});

describe("B24: a message header's sender", () => {
  it("is not the user's details when the owner question splits", async () => {
    const m = desk(NOTE);
    m.apply(snap([text("mail/from", "From: bea.sutherland@example.com")], { at: 950, windowId: "mail", title: "Re: plus-one", app: MAIL_APP, focused: true, values: [value("email", "bea.sutherland@example.com", "mail/from")] }));
    m.apply(snap([...page(), field(`${P}/textfield:email~0`, "", { parent: `${P}/webarea:~0`, label: "Email", frame: [100, 440, 200, 20] })], { at: 1000, windowId: "form", title: "RSVP", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: `${P}/textfield:customer name~0` }));
    const pick = (_: string, ins: string): string | null => (ins.includes("'Email'") ? "bea.sutherland@example.com" : null);
    const p = await proposeFill(m, jevPickingText(pick, 0.9, () => "user", () => "unclear"), "form", `${P}/textfield:customer name~0`, 2000);
    expect(fieldOf(p, "textfield:email")).toMatchObject({ value: null, withheld: "otherPerson" });
  });
});
