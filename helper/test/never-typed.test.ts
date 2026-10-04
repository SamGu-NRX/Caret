// B25 lead decision 2: Caret never types a Social Security number, a full card number, a password or a
// one-time code, from any source. The label and shape rules have one right answer each and are tested alone;
// then fill, the planner's field list and validatePlan must all leave the same fields and values to the user.
// All numbers are invented; the card numbers are standard test numbers.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { luhn, neverTypedField, neverTypedValue } from "../src/fill/never-typed.ts";
import { collectCandidates } from "../src/fill/candidates.ts";
import { writableFields } from "../src/planner/planner.ts";
import { PlannerError, validatePlan } from "../src/planner/validate.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { SnippetLedger } from "../src/privacy.ts";
import { field, jevPickingText, snap, value } from "./builders.ts";

describe("neverTypedField", () => {
  it.each([
    ["Social Security number", "ssn"],
    ["SSN (last 4 is fine)", "ssn"],
    ["Card number", "card"],
    ["Credit card", "card"],
    ["CVV", "card"],
    ["Card security code", "card"],
    ["Password", "password"],
    ["Confirm password", "password"],
    ["PIN", "password"],
    ["One-time code", "code"],
    ["Verification code", "code"],
    ["Enter the 6-digit 2FA code", "code"],
  ])("reads %s as %s", (label, kind) => {
    expect(neverTypedField([label])).toBe(kind);
  });

  it.each(["Email address", "Phone", "ZIP code", "Confirmation code", "Promo code", "Mileage Plan number", "Known Traveler Number", "Student ID", "Pinterest profile"])("leaves %s to fill", (label) => {
    expect(neverTypedField([label])).toBeNull();
  });
});

describe("neverTypedValue", () => {
  it("reads an SSN and a card number by their shape, and a password or a code only by the label beside it", () => {
    expect(neverTypedValue("123-45-6789")).toBe("ssn");
    expect(neverTypedValue("4242 4242 4242 4242")).toBe("card");
    expect(neverTypedValue("4111-1111-1111-1111")).toBe("card");
    expect(neverTypedValue("hunter2", "Password")).toBe("password");
    expect(neverTypedValue("482913", "Your verification code")).toBe("code");
    expect(neverTypedValue("123456789", "SSN")).toBe("ssn");
    // Inside a longer line too: offering the line would hand the number over.
    expect(neverTypedValue("card 4242 4242 4242 4242")).toBe("card");
    expect(neverTypedValue("my ssn is 123-45-6789, thanks")).toBe("ssn");
  });

  it.each(["(512) 555-0147", "512-555-0147", "ORD-2026-48213", "4242 4242 4242 4241", "123456789", "98103", "1,450", "call (512) 555-0147 or 512-555-0148", "Order 2026-10-17 #48213"])("does not read %s as one", (v) => {
    expect(neverTypedValue(v)).toBeNull();
  });

  it("checks Luhn", () => {
    expect(luhn("4242424242424242")).toBe(true);
    expect(luhn("4242424242424241")).toBe(false);
  });
});

const NOTE = ["Rental app", "Name: Elena Vance", "SSN: 123-45-6789", "card 4242 4242 4242 4242", "Password: hunter2", "Phone: (737) 555-0112"].join("\n");
const F = "dev.caret.chrome/standard";
const formNodes = () => [
  field(`${F}/textfield:name~0`, "", { label: "Full name", frame: [100, 100, 200, 20] }),
  field(`${F}/textfield:ssn~0`, "", { label: "Social Security number", frame: [100, 130, 200, 20] }),
  field(`${F}/textfield:card~0`, "", { label: "Card number", frame: [100, 160, 200, 20] }),
  field(`${F}/textfield:phone~0`, "", { label: "Phone", frame: [100, 190, 200, 20] }),
];

function desk(): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("te/note", NOTE, { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Rental notes.txt", focused: true, values: [value("phone", "(737) 555-0112", "te/note")] }));
  m.apply(snap(formNodes(), { at: 1000, windowId: "form", title: "Application", focused: true, focusedKey: `${F}/textfield:name~0` }));
  return m;
}

describe("fill and the planner agree on what is never typed", () => {
  it("leaves the SSN and card fields out of a fill and never offers those values to Jev", async () => {
    const asked: JevRequest[] = [];
    const inner = jevPickingText((_, ins) => (ins.includes("'Full name'") ? "Elena Vance" : ins.includes("'Phone'") ? "(737) 555-0112" : "123-45-6789"));
    const jev: AskJev = async (r) => (asked.push(r), inner(r));
    const p = await proposeFill(desk(), jev, "form", `${F}/textfield:name~0`, 2000);
    expect(p.fields.map((f) => f.key).sort()).toEqual([`${F}/textfield:name~0`, `${F}/textfield:phone~0`]);
    const sent = JSON.stringify(asked.map((r) => [r.state, r.questions]));
    for (const secret of ["123-45-6789", "4242 4242 4242 4242", "hunter2"]) expect(sent).not.toContain(secret);
    expect(p.fields.find((f) => f.key.includes("phone"))?.value).toBe("(737) 555-0112");
  });

  it("leaves a never-typed trigger out too", async () => {
    const p = await proposeFill(desk(), jevPickingText(() => null), "form", `${F}/textfield:ssn~0`, 2000);
    expect(p.fields.some((f) => f.key.includes("ssn"))).toBe(false);
  });

  it("never offers such a value as a candidate", () => {
    const m = desk();
    const c = collectCandidates(m, "form", { now: 2000, ledger: new SnippetLedger(m.windows.values()) }).candidates.map((x) => x.text);
    expect(c).toContain("(737) 555-0112");
    for (const secret of ["123-45-6789", "card 4242 4242 4242 4242", "4242 4242 4242 4242", "hunter2"]) expect(c).not.toContain(secret);
  });

  it("keeps the planner's fields to the same ones, and validatePlan refuses either kind as notEditable", () => {
    const m = desk();
    const w = m.windows.get("form");
    if (w === undefined) throw new Error("no form");
    expect(writableFields(w).map((f) => f.label)).toEqual(["Full name", "Phone"]);
    const step = (key: string, v: string) => ({ id: "p", title: "t", slots: {}, steps: [{ says: "x", end: { kind: "valueEquals", window: { bundleId: w.app.bundleId, title: w.window.title }, target: { key, describe: "f" }, value: v } }] });
    const ctx = { model: m, memory: [], instruction: "my ssn is 123-45-6789" };
    const code = (f: () => unknown): string | null => {
      try {
        f();
        return null;
      } catch (e) {
        return e instanceof PlannerError ? e.code : String(e);
      }
    };
    expect(code(() => validatePlan(step(`${F}/textfield:ssn~0`, "Elena Vance"), {}, ctx))).toBe("notEditable");
    // An SSN typed in the instruction does not go into another field either.
    expect(code(() => validatePlan(step(`${F}/textfield:name~0`, "123-45-6789"), {}, ctx))).toBe("notEditable");
    expect(code(() => validatePlan(step(`${F}/textfield:name~0`, "Elena Vance"), {}, ctx))).toBeNull();
  });
});
