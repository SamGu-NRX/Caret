// The reader types a bare digit run as a phone; on a line that names a loyalty or membership number it is an ID
// (fill/kinds.ts readerValue), so a budget cut of a mail's phones no longer takes a Mileage Plan number with them.
// B25 held-13's mail line, synthetic.
import { describe, expect, it } from "vitest";
import { readerValue } from "../src/fill/kinds.ts";
import { ScreenModel } from "../src/model.ts";
import type { TypedValue } from "../src/protocol.ts";
import { MAIL_APP, snap, text } from "./builders.ts";

const phone = (t: string): TypedValue => ({ kind: "phone", text: t, nodeKey: "n" });

describe("readerValue", () => {
  it("reads a bare digit run on a loyalty or membership line as an ID", () => {
    expect(readerValue(phone("123456789"), ["Mileage Plan: 123456789"]).kind).toBe("id");
    expect(readerValue(phone("40221877"), [null, "Frequent flyer #40221877"]).kind).toBe("id");
    expect(readerValue(phone("5523019"), ["Your Rewards membership number is 5523019."]).kind).toBe("id");
  });

  it("keeps a phone where the line says phone, the number has separators, or no membership word comes before it", () => {
    expect(readerValue(phone("123456789"), ["Member phone: 123456789"]).kind).toBe("phone");
    expect(readerValue(phone("123456789"), ["Rewards member\nMobile: 123456789"]).kind).toBe("phone");
    expect(readerValue(phone("(206) 555-0134"), ["Loyalty desk: (206) 555-0134"]).kind).toBe("phone");
    expect(readerValue(phone("+14155550162"), ["Mileage Plan help line +14155550162"]).kind).toBe("phone");
    expect(readerValue(phone("123456789"), ["123456789 is my Mileage Plan"]).kind).toBe("phone");
    expect(readerValue(phone("123456789"), ["Call 123456789"]).kind).toBe("phone");
  });

  it("leaves every other kind as it is", () => {
    const v: TypedValue = { kind: "date", text: "04/12/1990", nodeKey: "n" };
    expect(readerValue(v, ["Mileage Plan since 04/12/1990"])).toBe(v);
  });
});

describe("the screen model", () => {
  it("keeps the reader's phone for the mail's mobile and an ID for its Mileage Plan number", () => {
    const m = new ScreenModel();
    const s = snap([text("mail/miles", "Mileage Plan: 123456789"), text("mail/mobile", "Mobile: (206) 555-0134")], { at: 1, windowId: "mail", title: "Trip details", app: MAIL_APP });
    s.values = [
      { kind: "phone", text: "123456789", nodeKey: "mail/miles" },
      { kind: "phone", text: "(206) 555-0134", nodeKey: "mail/mobile" },
    ];
    m.apply(s);
    expect(m.windows.get("mail")?.values.map((v) => `${v.kind}=${v.text}`)).toEqual(["id=123456789", "phone=(206) 555-0134"]);
  });
});
