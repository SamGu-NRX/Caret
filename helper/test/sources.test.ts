// B26: where an instruction says to copy from (planner/sources.ts). The phrases, the field words and the named
// windows each have one right answer, so they are tested alone, on synthetic desks and on the corpus's replayed ones.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { Snapshot } from "../src/protocol.ts";
import { fieldWords, namedSources, onlyInSources, restrictsSources, senderNames, sourcePhrases } from "../src/planner/sources.ts";
import { personSpans } from "../src/planner/intent.ts";
import { buildDesk, loadCorpus } from "../scripts/realfill-corpus.ts";
import { field, snap, text } from "./builders.ts";

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

describe("fieldWords", () => {
  it.each([
    ["do the checkout details from my note", "do the checkout details"],
    ["can you get this enrollment form done from what I jotted down", "can you get this enrollment form done"],
    ["go with the Saturday Chris mentioned, but at 9:30", "go with the Saturday , but at 9:30"],
    ["grab my company and title off my LinkedIn", "grab my company and title"],
    ["fill in my birthday from Morgan's email", "fill in my birthday"],
    ["use Chris's last message for the date", "use for the date"],
    ["fill the rest of this from my note", "fill the rest of this"],
    ["the address in her latest email goes in shipping", "the address goes in shipping"],
  ])("leaves the field words of %s", (instruction, words) => {
    expect(squash(fieldWords(instruction))).toBe(words);
  });

  it.each([
    "put Bea down as my guest with her meal",
    "add my phone and company name",
    "write 'call me' in the notes",
    "put this in the Notes field",
    "add the gift note",
    "put Bea's email in the guest email field",
    "my email please",
    "fill in my email",
    "put in my phone number",
    "put it in my notes",
    "write the summary in my notes field",
    "Fill out the Northgate application",
    "use the address I gave you",
    "Copy Dana's email address from her signature into Email",
    "the date we mentioned",
  ])("names no source in %s", (instruction) => {
    expect(sourcePhrases(instruction)).toEqual([]);
    expect(fieldWords(instruction)).toBe(instruction);
  });

  it("knows an instruction that keeps Caret to its own words", () => {
    expect(restrictsSources("fill my email using only this instruction; do not read other windows")).toBe(true);
    expect(restrictsSources("just use what I typed here")).toBe(true);
    expect(restrictsSources("make my wife the emergency contact")).toBe(false);
    expect(restrictsSources("fill out the whole form")).toBe(false);
  });

  it("knows a person named only where to copy from from one whose details go in", () => {
    expect(onlyInSources("fill in my birthday from Morgan's email", "Morgan")).toBe(true);
    expect(onlyInSources("go with the Saturday Chris mentioned", "Chris")).toBe(true);
    expect(onlyInSources("put Bea down as my guest", "Bea")).toBe(false);
    expect(onlyInSources("use Gary's info from Gary's note", "Gary")).toBe(false);
  });
});

// Synthetic desk: a form, two notes and two mails.
const TEXTEDIT = (pid: number) => ({ pid, bundleId: "com.apple.TextEdit", name: "TextEdit" });
const CHROME = { pid: 9000, bundleId: "com.google.Chrome", name: "Google Chrome" };
function desk(): { m: ScreenModel; form: WindowState } {
  const m = new ScreenModel();
  m.apply(snap([field("d", "Notes for Thursday", { role: "AXTextArea" })], { at: 100, windowId: "draft", title: "Draft.txt", app: TEXTEDIT(9001), focused: true }));
  m.apply(snap([text("h1", "From: Dana Whitfield <dana@example.com>"), text("h2", "To: Avery Kim"), text("b", "Thursday works")], { at: 200, windowId: "mail-dana", title: "Venue deposit", app: { pid: 9002, bundleId: "com.apple.mail", name: "Mail" }, focused: true }));
  m.apply(snap([text("h1", "From: Beatrice Sutherland <bea@example.com>"), text("h2", "To: Avery Kim"), text("b", "Put me down as Beatrice")], { at: 300, windowId: "mail-bea", title: "Re: plus-one", app: { pid: 9003, bundleId: "com.apple.mail", name: "Mail" }, focused: true }));
  m.apply(snap([field("c", "Ship to: 1907 Alameda", { role: "AXTextArea" })], { at: 400, windowId: "checkout-note", title: "Checkout notes.txt", app: TEXTEDIT(9004), focused: true }));
  m.apply(snap([field("f", "", { label: "Email" })], { at: 500, windowId: "form", title: "Checkout", app: CHROME, focused: true }));
  return { m, form: m.windows.get("form") as WindowState };
}
const named = (instruction: string): string[] => {
  const { m, form } = desk();
  return namedSources(instruction, m, form, personSpans(instruction)).named.map((n) => n.windowId);
};

describe("namedSources", () => {
  it.each([
    ["do the checkout details from my note", ["checkout-note"]],
    ["fill this from Dana's message", ["mail-dana"]],
    ["put Bea down as my guest with her meal", ["mail-bea"]],
    ["use the date Dana mentioned", ["mail-dana"]],
    ["make my wife the emergency contact", []],
    ["fill this out", []],
    // Two notes, and the instruction's words pick neither: the note the user just left.
    ["fill it from my note", ["checkout-note"]],
  ])("resolves %s", (instruction, ids) => {
    expect(named(instruction)).toEqual(ids);
  });

  it("names a mail by a short name only when no sender has that name as a word and one sender starts with it (B26 review)", () => {
    const { m, form } = desk();
    m.apply(snap([text("h1", "From: Dan Wilson <dan@example.com>"), text("h2", "To: Avery Kim"), text("b", "Saturday is fine")], { at: 450, windowId: "mail-dan", title: "Saturday", app: { pid: 9005, bundleId: "com.apple.mail", name: "Mail" }, focused: true }));
    m.apply(snap([field("f", "", { label: "Email" })], { at: 600, windowId: "form", title: "Checkout", app: CHROME, focused: true }));
    expect(namedSources("fill this from Dan's message", m, form, ["Dan"]).named.map((n) => n.windowId)).toEqual(["mail-dan"]);
    expect(namedSources("use what Dana sent", m, form, ["Dana"]).named.map((n) => n.windowId)).toEqual(["mail-dana"]);
  });

  it("never names a window by a capitalized field word, and names a note by a name only in a source phrase (B26 review)", () => {
    const { m, form } = desk();
    m.apply(snap([field("e", "old receipts", { role: "AXTextArea" })], { at: 450, windowId: "archive", title: "Email archive", app: TEXTEDIT(9006), focused: true }));
    m.apply(snap([field("f", "", { label: "Email" })], { at: 600, windowId: "form", title: "Checkout", app: CHROME, focused: true }));
    expect(namedSources("fill the Email field", m, form, personSpans("fill the Email field")).named).toEqual([]);
  });

  it("excludes a source the instruction rules out instead of naming it (B26 review)", () => {
    const { m, form } = desk();
    expect(namedSources("fill this without using Dana's message", m, form, ["Dana"])).toEqual({ named: [], excluded: ["mail-dana"], missing: false });
    expect(namedSources("not from Dana's message, from my note", m, form, ["Dana"])).toEqual({ named: [{ windowId: "checkout-note", names: [] }], excluded: ["mail-dana"], missing: false });
  });

  it.each([
    ["rsvp for me and Bea, everything's in her email", ["Bea"]],
    // In lower case only a whole word of a sender's name counts: "bea" is not "Beatrice", nor "can" "Candace".
    ["rsvp for me and bea, everything's in her email", []],
    ["use what dana sent", ["dana"]],
    ["Dana's numbers please", ["Dana"]],
    ["will you fill this out", []],
    ["fill the rest from my note", []],
  ])("finds the senders %s names, however typed (B26 held-out-2)", (instruction, names) => {
    const { m, form } = desk();
    expect(senderNames(instruction, m, form)).toEqual(names);
  });

  it.each([
    ["grab my title off my LinkedIn", true],
    ["paste the error from my terminal", true],
    // Not apps: their content can sit inside another window, so they are never missing (B26 planner sets).
    ["fill this from Zed's message", false],
    ["Put the order number from the order confirmation in Reference", false],
    ["Email box: Priya's address from the vendor review thread", false],
    ["put the room and building from my calendar into notes", false],
    ["fill it from my note", false],
    ["use what Dana mentioned", false],
    ["fill this, without using my LinkedIn", false],
    ["fill this out", false],
    ["use what Draft wrote", false],
  ])("knows whether %s names a source no open window could be", (instruction, missing) => {
    const { m, form } = desk();
    expect(namedSources(instruction, m, form, personSpans(instruction)).missing).toBe(missing);
  });

  it("names nothing for a kind of source that is not open", () => {
    expect(named("grab my title off my LinkedIn")).toEqual([]);
  });

  it("puts the resolving name and the sender's name first in the window", () => {
    const { m, form } = desk();
    expect(namedSources("put Bea down as my guest", m, form, ["Bea"]).named).toEqual([{ windowId: "mail-bea", names: ["Bea", "Beatrice Sutherland"] }]);
  });
});

describe("namedSources on the corpus's replayed desks", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
  const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
  const resolve = (formId: string, instruction: string): string[] => {
    const form = corpus.forms.find((f) => f.id === formId);
    if (form === undefined) throw new Error(formId);
    const d = buildDesk(corpus, snaps, form);
    return namedSources(instruction, d.model, d.form, personSpans(instruction)).named.map((n) => d.model.windows.get(n.windowId)?.window.title ?? n.windowId);
  };

  it.each([
    ["checkout-shipping", "do the checkout details from my note", ["Checkout notes.txt"]],
    ["course-enrollment", "can you get this enrollment form done from what I jotted down", ["Enrollment notes.txt"]],
    ["event-rsvp", "put Bea down as my guest with her meal", ["Re: plus-one for Jun & Priscilla's party? - Google Chrome"]],
    ["car-service-booking", "go with the Saturday Chris mentioned, but at 9:30", ["Re: 60k service for your Outback - Google Chrome"]],
    ["clinic-intake", "make my wife the emergency contact", []],
    ["b2b-demo-request", "grab my company and title off my LinkedIn", []],
  ])("on %s, %s names %j", (formId, instruction, titles) => {
    expect(resolve(formId, instruction)).toEqual(titles);
  });
});
