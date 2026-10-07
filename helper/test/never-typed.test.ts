// B25 lead decision 2: Caret never types a password, a card or account number, a government ID number (an SSN), a
// one-time code or an API key, from any source. The kinds are memory's (memory/sensitive.ts, M1's classifier), so
// fill, the planner and Ask refuse exactly what memory refuses to keep; its label and shape rules are tested with
// memory. Here: that every path agrees with it, and secretIn's reading of the instruction around a value. All numbers
// are invented; the card numbers are standard test numbers.
import { TEST_AUTHORITY } from "./mint.ts";
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { heldReason, NOTE_PRIVATE, proposeFill } from "../src/fill/fill.ts";
import { collectCandidates } from "../src/fill/candidates.ts";
import { writableFields } from "../src/planner/planner.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { validateMinted } from "./mint.ts";
import { secretIn } from "../src/planner/trace.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { SnippetLedger } from "../src/privacy.ts";
import { field, jevPickingText, snap, value } from "./builders.ts";

describe("secretIn", () => {
  it.each([
    ["123-45-6789", "my ssn is 123-45-6789", "governmentId"],
    ["4242 4242 4242 4242", "use 4242 4242 4242 4242", "cardNumber"],
    ["hunter2", "Put my password hunter2 in Notes", "password"],
    ["hunter2", "hunter2 is my password", "password"],
    ["482913", "my login code 482913 please", "oneTimeCode"],
  ])("reads %s in '%s' as %s", (v, instruction, kind) => {
    expect(secretIn(v, instruction)).toBe(kind);
  });

  it.each([
    ["Dana Whitfield", "put Dana Whitfield in Name"],
    ["(512) 555-0147", "my phone is (512) 555-0147"],
    ["8:15", "make the delivery 8:15"],
    ["ORD-2026-48213", "Reference ORD-2026-48213 and pay it"],
  ])("leaves %s in '%s' alone", (v, instruction) => {
    expect(secretIn(v, instruction)).toBeNull();
  });
});

const NOTE = ["Rental app", "Name: Elena Vance", "SSN: 123-45-6789", "card 4242 4242 4242 4242", "Password: hunter2", "Phone: (737) 555-0112"].join("\n");
const F = "dev.caret.chrome/standard";
const formNodes = () => [
  field(`${F}/textfield:name~0`, "", { label: "Full name", frame: [100, 100, 200, 20] }),
  field(`${F}/textfield:ssn~0`, "", { label: "Social Security number", frame: [100, 130, 200, 20] }),
  field(`${F}/textfield:card~0`, "", { label: "Card number", frame: [100, 160, 200, 20] }),
  field(`${F}/textfield:phone~0`, "", { label: "Phone", frame: [100, 190, 200, 20] }),
  field(`${F}/textfield:notes~0`, "", { label: "Notes", frame: [100, 220, 200, 20] }),
];

function desk(): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("te/note", NOTE, { role: "AXTextArea" })], { at: 800, windowId: "note", title: "Rental notes.txt", focused: true, values: [value("phone", "(737) 555-0112", "te/note")] }));
  // A settings page that shows a password in an ordinary field: its own label says what it is (B25 review).
  m.apply(snap([field("st/pw", "hunter2", { label: "Password" }), field("st/user", "elena.v", { label: "Username" })], { at: 900, windowId: "settings", title: "Account settings", focused: true }));
  m.apply(snap(formNodes(), { at: 1000, windowId: "form", title: "Application", focused: true, focusedKey: `${F}/textfield:name~0` }));
  return m;
}
const SECRETS = ["123-45-6789", "4242 4242 4242 4242", "hunter2"];

describe("fill and the planner agree on what is never typed", () => {
  it("leaves the SSN and card fields out of a fill and never offers those values to Jev", async () => {
    const asked: JevRequest[] = [];
    const inner = jevPickingText((_, ins) => (ins.includes("'Full name'") ? "Elena Vance" : ins.includes("'Phone'") ? "(737) 555-0112" : ins.includes("'Notes'") ? "hunter2" : null));
    const jev: AskJev = async (r) => (asked.push(r), inner(r));
    const p = await proposeFill(desk(), jev, "form", `${F}/textfield:name~0`, 2000);
    expect(p.fields.map((f) => f.key).sort()).toEqual([`${F}/textfield:name~0`, `${F}/textfield:notes~0`, `${F}/textfield:phone~0`]);
    const sent = JSON.stringify(asked.map((r) => [r.state, r.questions]));
    for (const secret of SECRETS) expect(sent).not.toContain(secret);
    // HA2 review (b): the note's SSN and card lines are cut from the view, so the note is incomplete and its phone, a value
    // only an owner judgement admits, is withheld; nothing cut is shown or named.
    const phone = p.fields.find((f) => f.key.includes("phone"));
    expect(phone?.value).toBeNull();
    expect(phone === undefined ? null : heldReason(phone)).toBe(`Caret left Phone: ${NOTE_PRIVATE}.`);
    expect(p.fields.find((f) => f.key.includes("notes"))?.value).toBeNull();
  });

  it("leaves a never-typed trigger out too", async () => {
    const p = await proposeFill(desk(), jevPickingText(() => null), "form", `${F}/textfield:ssn~0`, 2000);
    expect(p.fields.some((f) => f.key.includes("ssn"))).toBe(false);
  });

  it("never offers such a value as a candidate, from a line or from a field labelled as one", () => {
    const m = desk();
    const c = collectCandidates(m, "form", { now: 2000, ledger: new SnippetLedger(m.windows.values()) }).candidates.map((x) => x.text);
    expect(c).toContain("(737) 555-0112");
    expect(c).toContain("elena.v");
    for (const secret of [...SECRETS, "card 4242 4242 4242 4242"]) expect(c).not.toContain(secret);
  });

  it("keeps the planner's fields to the same ones, and validatePlan refuses a secret by its field, its shape or the instruction's words", async () => {
    const m = desk();
    const w = m.windows.get("form");
    if (w === undefined) throw new Error("no form");
    expect(writableFields(w).map((f) => f.label)).toEqual(["Full name", "Phone", "Notes"]);
    const step = (key: string, v: string) => ({ id: "p", title: "t", slots: {}, steps: [{ says: "x", end: { kind: "valueEquals", window: { bundleId: w.app.bundleId, title: w.window.title }, target: { key, describe: "f" }, value: v } }] });
    const code = async (instruction: string, key: string, v: string): Promise<string | null> => {
      try {
        await validateMinted(step(key, v), {}, { model: m, memory: [], instruction });
        return null;
      } catch (e) {
        return e instanceof PlannerError ? e.code : String(e);
      }
    };
    expect(await code("x", `${F}/textfield:ssn~0`, "Elena Vance")).toBe("notEditable");
    expect(await code("my ssn is 123-45-6789", `${F}/textfield:name~0`, "123-45-6789")).toBe("notEditable");
    // A word in the instruction says what it is: no shape needed.
    expect(await code("Put my password sw0rdfish in Notes", `${F}/textfield:notes~0`, "sw0rdfish")).toBe("notEditable");
    expect(await code("Put sw0rdfish in Notes", `${F}/textfield:notes~0`, "sw0rdfish")).toBeNull();
    expect(await code("x", `${F}/textfield:name~0`, "Elena Vance")).toBeNull();
  });
});
