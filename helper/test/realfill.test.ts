// B24: fill on real forms. The deterministic parts (name and address parts, dates and times, the form
// controls, required markers) have one right answer each and are tested in isolation; then proposeFill with a
// stand-in Jev for the anchor, the derived values, the controls and the owner veto. All text is synthetic.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { fieldPart, joinName, partFits, splitAddress, splitName } from "../src/fill/derive.ts";
import { clockTime, readDate } from "../src/fill/when.ts";
import { consentLike, formControls, matchOption, optionInText } from "../src/fill/controls.ts";
import { describeField, fieldLabelText } from "../src/fill/descriptor.ts";
import type { FillProposal, Node } from "../src/protocol.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { field, jevPickingText, MAIL_APP, node, snap, text, value } from "./builders.ts";
import { collectCandidates } from "../src/fill/candidates.ts";
import { SnippetLedger } from "../src/privacy.ts";
import { fieldTerms } from "../src/fill/kinds.ts";

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
    expect(cs.map((c) => [c.control, c.label, c.options])).toEqual([
      ["radio", "Pizza Size", ["Small", "Large"]],
      ["checkbox", "Mushroom", null],
      ["checkbox", "Send me deals by email", null],
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
function desk(noteText: string, extra: Node[] = []): ScreenModel {
  const m = new ScreenModel();
  const draft = [
    "Notes for Thursday",
    "Could we go over the intro and examples before the review? The examples feel a bit thin in section two, and we still owe Priya a reply.",
    "Also, let's set up a call with Priya Thursday 3pm PT to go over the budget.",
    "Dana said the venue deposit is due next week.",
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
    const m = desk(NOTE);
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
    // A sign-up box is a control like any other, but "Large, mushroom and onion" does not name it.
    expect(fieldOf(p, "send me deals")).toMatchObject({ handoff: null, withheld: "ambiguous" });
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
    // For a field that wants the user's details, an unsettled owner is not enough; the user's own is.
    const unclear = await proposeFill(m, jevPickingText(pick, 0.9, () => "user", () => "unclear"), "form", `${P}/textfield:customer name~0`, 2000);
    expect(fieldOf(unclear, "textfield:phone")).toMatchObject({ value: null, withheld: "otherPerson" });
    const own = await proposeFill(m, jevPickingText(pick, 0.9, () => "user", () => "user"), "form", `${P}/textfield:customer name~0`, 2000);
    expect(fieldOf(own, "textfield:phone")).toMatchObject({ value: "(415) 555-0162", withheld: null });
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
