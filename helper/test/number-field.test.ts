// G3 (lead decision 2): a field that names a number or code ("Order number", "Invoice no.", "Ticket #") never takes a
// value of a clearly different kind (an email, a web link, a phone number, a date), in Ask's fill as in a goal's
// gates, by one rule (fill/kinds.ts numberFieldMisfit, inside misfit). Before G3 only goals had it, so Ask's fill put an
// email in Order number whenever Jev chose it. Every name and number is invented.
import { describe, expect, it } from "vitest";
import { proposeFill } from "../src/fill/fill.ts";
import { misfit, numberFieldMisfit } from "../src/fill/kinds.ts";
import { ScreenModel } from "../src/model.ts";
import { field, jevPickingText, MAIL_APP, snap, text, value } from "./builders.ts";

describe("numberFieldMisfit", () => {
  const refused: [string, string][] = [
    ["Order number", "priya.raman@northwind.example"],
    ["Order number", "https://northwind.example/orders/48213"],
    ["Invoice no.", "dana@example.com"],
    ["Ticket #", "www.example.com/t/9"],
    ["Confirmation code", "+1 512 555 0142"],
    ["Order number", "(512) 555-0142"],
    ["Order number", "512.555.0142 ext. 9"],
    ["Order number", "2026-10-08"],
    ["Order number", "10/08/2026"],
    ["Order number", "October 8, 2026"],
    ["Booking reference number", "Thu Oct 8"],
  ];
  const allowed: [string, string][] = [
    ["Order number", "ORD-2026-48213"],
    ["Order number", "48213"],
    // A run of digits with no phone punctuation is an order number as often as a phone number.
    ["Order number", "5125550142"],
    ["Order number", "112-4455667-1234567"],
    ["Invoice no.", "INV 2026-0412"],
    ["Promo code", "MAY"],
    ["Promo code", "MAY2026"],
    ["Ticket #", "4821"],
    // Review of G3 (theo-astra-reviewer aa7209c305829aaa7): punctuation alone is no phone, and a date needs its year.
    ["Order number", "512-555-0142"],
    ["Version number", "1.2.3"],
    ["HS code", "10.06.30"],
    // Reference alone names no number (B16 and B17 put links and order numbers in one Reference field).
    ["Reference", "https://northwind.example/orders/48213"],
    // Fields that name another shape are misfit's own, and a field with no ID word is not one of these.
    ["Phone number", "(512) 555-0142"],
    ["Notes #", "dana@example.com"],
    ["Is this a gift? (yes/no)", "dana@example.com"],
  ];
  it("refuses a clearly different kind in a field that names a number or code", () => {
    for (const [label, v] of refused) expect(numberFieldMisfit(v, [label]), `${label} <- ${v}`).not.toBeNull();
  });
  it("leaves numbers, codes and every other field alone", () => {
    for (const [label, v] of allowed) expect(numberFieldMisfit(v, [label]), `${label} <- ${v}`).toBeNull();
  });
  it("is part of misfit, which every fill and goal gate reads", () => {
    expect(misfit("priya.raman@northwind.example", ["Order number"])).toBe("'priya.raman@northwind.example' is an email address, and the field takes a number or code");
    expect(misfit("(512) 555-0142", ["Order number"])).toBe("'(512) 555-0142' is a phone number, and the field takes a number or code");
    expect(misfit("October 8, 2026", ["Order number"])).toBe("'October 8, 2026' is a date, and the field takes a number or code");
    expect(misfit("ORD-2026-48213", ["Order number"])).toBeNull();
  });
});

describe("Ask's fill and an Order number field", () => {
  const FORM = "5150-1";
  const SRC = "6160-1";
  const k = (s: string) => `dev.caret.fixture/standard/${s}`;
  const ORDER = k("textfield:order number~0");
  const model = (): ScreenModel => {
    const m = new ScreenModel();
    m.apply(
      snap(
        [
          text("m/statictext:from~0", "From: Priya Raman <priya.raman@northwind.example>", [20, 10, 300, 18]),
          text("m/statictext:phone~0", "Call me at (512) 555-0142", [20, 40, 300, 18]),
          text("m/statictext:when~0", "Delivered October 8, 2026", [20, 70, 300, 18]),
          text("m/statictext:order~0", "Order number: ORD-2026-48213", [20, 100, 300, 18]),
        ],
        {
          at: 1000,
          windowId: SRC,
          title: "Order arrived damaged",
          app: MAIL_APP,
          values: [
            value("email", "priya.raman@northwind.example", "m/statictext:from~0"),
            value("phone", "(512) 555-0142", "m/statictext:phone~0"),
            value("date", "October 8, 2026", "m/statictext:when~0"),
            value("id", "ORD-2026-48213", "m/statictext:order~0"),
          ],
        },
      ),
    );
    m.apply(snap([field(ORDER, "", { label: "Order number", frame: [120, 40, 240, 22] })], { at: 2000, windowId: FORM, title: "New case", focused: true }));
    return m;
  };
  const ask = (want: string) => proposeFill(model(), jevPickingText(() => want, 0.95), FORM, ORDER, 5000, { scope: { fields: [ORDER], windows: null, memory: false, instruction: "put the order number from Priya's email in the case", person: null, literals: new Map() } });

  for (const wrong of ["priya.raman@northwind.example", "(512) 555-0142", "October 8, 2026"]) {
    it(`does not fill '${wrong}' when Jev chooses it`, async () => {
      const p = await ask(wrong);
      expect(p.fields[0]).toMatchObject({ key: ORDER, value: null });
    });
  }

  it("fills the order number Jev chooses", async () => {
    const p = await ask("ORD-2026-48213");
    expect(p.fields[0]).toMatchObject({ key: ORDER, value: "ORD-2026-48213" });
  });
});
