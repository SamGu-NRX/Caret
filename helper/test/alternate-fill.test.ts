import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import type { AboutValue } from "../src/fill/about.ts";
import { alternateReason } from "../src/fill/alternate.ts";
import { setCheckObserver } from "../src/fill/contract.ts";
import { field, jevPickingText, snap, text, value } from "./builders.ts";

const FORM = "5150-1";
const EMAIL = "person@example.com";
const PHONE = "(512) 555-0147";

async function propose(label: string, primary: string | null, chosen = EMAIL, present = "", own?: AboutValue) {
  const model = new ScreenModel();
  const kind = chosen.includes("@") ? "email" : chosen.includes("Oak") ? "address" : "phone";
  model.apply(snap([text("source", chosen, [0, 0, 300, 20])], {
    at: 1000, windowId: "6160-1", values: [value(kind, chosen, "source")],
  }));
  model.apply(snap([
    field("alternate", "", { label, frame: [100, 40, 200, 24] }),
    ...(primary === null ? [] : [field("primary", present, { label: primary, frame: [100, 80, 200, 24] })]),
  ], { at: 2000, windowId: FORM, focused: true }));
  return proposeFill(model, jevPickingText(() => chosen), FORM, "alternate", 3000, {
    derive: false, ...(own === undefined ? {} : { about: [own] }),
  });
}

describe("alternate values cannot repeat primary values", () => {
  it.each(["Alternate email", "Alternative email", "Other email", "Backup email", "Additional email", "Second email", "Email 2nd", "Email (alternate)", "Email [backup]"])("withholds %s equal to the primary proposal", async (label) => {
    const p = await propose(label, "Email");
    expect(p.fields.find((f) => f.key === "alternate")?.value).toBeNull();
    expect(p.fields.find((f) => f.key === "primary")?.value).toBe(EMAIL);
  });

  it("explains the veto and never sends the alternate pick to the verifier", async () => {
    const checked: string[] = [];
    setCheckObserver((p) => checked.push(p.field.key));
    try {
      const p = await propose("Alternate email", "Email");
      expect(alternateReason(p.fields[0]!)).toBe("Caret left Alternate email: it would repeat your Email.");
      expect(checked).toEqual(["primary"]);
    } finally {
      setCheckObserver(null);
    }
  });

  it("compares against an already present primary email without case sensitivity", async () => {
    const p = await propose("Alternate email", "Email", EMAIL, " PERSON@EXAMPLE.COM ");
    expect(p.fields[0]?.value).toBeNull();
  });

  it.each(["Alternate phone", "Secondary phone"])("withholds %s equal to the user's phone even when the primary is different", async (label) => {
    const p = await propose(label, "Phone", PHONE, "(512) 555-0199", { id: "own-phone", label: "Phone", kind: "phone", value: "5125550147" });
    expect(p.fields[0]?.value).toBeNull();
  });

  it("normalizes punctuation in phone numbers", async () => {
    const p = await propose("Backup phone", "Phone", PHONE, "512.555.0147");
    expect(p.fields[0]?.value).toBeNull();
  });

  it("normalizes case and whitespace in addresses", async () => {
    const p = await propose("Secondary address", "Address", "12 Oak Street", "12  OAK street");
    expect(p.fields[0]?.value).toBeNull();
  });

  it("withholds the user's address when the primary is different", async () => {
    const p = await propose("Alternate address", "Address", "12 Oak Street", "14 Pine Street", { id: "own-address", label: "Address", kind: "address", value: "12 Oak Street" });
    expect(p.fields[0]?.value).toBeNull();
  });

  it("keeps a distinct alternate value", async () => {
    expect((await propose("Alternate email", "Email", "other@example.com", EMAIL)).fields[0]?.value).toBe("other@example.com");
  });

  it("does not veto the only email field even when labelled alternate", async () => {
    expect((await propose("Alternate email", null)).fields[0]?.value).toBe(EMAIL);
  });

  it("does not treat explanatory text as an alternate marker", async () => {
    expect((await propose("Email (other people can see this)", "Email")).fields[0]?.value).toBe(EMAIL);
  });

  it.each(["Confirm email", "Re-enter email", "Verify email", "Email again", "Second email confirmation"])("allows repetition in %s", async (label) => {
    expect((await propose(label, "Email")).fields[0]?.value).toBe(EMAIL);
  });

  it.each([
    ["备用邮箱", "邮箱"], ["其他电话", "电话"], ["第二地址", "地址"],
    ["البريد الإلكتروني البديل", "البريد الإلكتروني"], ["الهاتف الثانوي", "الهاتف"],
    ["वैकल्पिक ईमेल", "ईमेल"], ["दूसरा फोन", "फोन"],
    ["Correo electrónico alternativo", "Correo electrónico"], ["Teléfono secundario", "Teléfono"],
    ["Adresse e-mail secondaire", "Adresse e-mail"], ["Téléphone de secours", "Téléphone"],
    ["Alternative E-Mail", "E-Mail"], ["Zweite Telefonnummer", "Telefonnummer"],
    ["予備メール", "メール"], ["第二電話", "電話"],
    ["보조 이메일", "이메일"], ["다른 전화", "전화"],
  ])("withholds repeated values for %s", async (label, primary) => {
    const chosen = /地址/u.test(label) ? "12 Oak Street" : /电话|هاتف|फोन|tel[eé]f|télé|telefon|電話|전화/iu.test(label) ? PHONE : EMAIL;
    expect((await propose(label, primary, chosen)).fields[0]?.value).toBeNull();
  });

  it.each([
    ["确认邮箱", "邮箱"], ["تأكيد البريد الإلكتروني", "البريد الإلكتروني"],
    ["ईमेल की पुष्टि", "ईमेल"], ["Confirmar correo electrónico", "Correo electrónico"],
    ["Confirmer e-mail", "E-mail"], ["E-Mail bestätigen", "E-Mail"],
    ["メール再入力", "メール"], ["이메일 확인", "이메일"],
  ])("allows confirmation field %s", async (label, primary) => {
    expect((await propose(label, primary)).fields[0]?.value).toBe(EMAIL);
  });
});
