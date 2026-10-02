import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { generateCandidates } from "../src/fill/candidates.ts";
import { describeField, nearestText } from "../src/fill/descriptor.ts";
import { buildFillRequest, FillError, formFields, proposeFill } from "../src/fill/fill.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { field, MAIL_APP, node, snap, text, value } from "./builders.ts";

const FORM = "5150-1";
const SRC = "6160-1";
const k = (s: string) => `dev.caret.fixture/standard/${s}`;

function buildModel(): ScreenModel {
  const m = new ScreenModel();
  m.apply(
    snap(
      [
        text("m/statictext:order~0", "Order number: ORD-2026-48213", [20, 40, 300, 18]),
        text("m/statictext:sig~0", "Dana Whitfield\nSenior Designer, Lumen Labs\ndana.whitfield@example.com", [20, 70, 300, 54]),
        text("m/statictext:when~0", "Thursday, October 8, 2026 at 3:00 PM", [20, 140, 300, 18]),
        node("m/button:reply~0", "AXButton", { label: "Reply" }),
        text("m/statictext:to~0", "To:", [20, 180, 30, 18]),
      ],
      {
        at: 1000,
        windowId: SRC,
        title: "Order confirmation",
        app: MAIL_APP,
        values: [
          value("id", "ORD-2026-48213", "m/statictext:order~0"),
          value("email", "dana.whitfield@example.com", "m/statictext:sig~0"),
          value("date", "Thursday, October 8, 2026 at 3:00 PM", "m/statictext:when~0"),
        ],
      },
    ),
  );
  m.apply(
    snap(
      [
        node(k("group:contact"), "AXGroup", { label: "Contact" }),
        text(k("group:contact/statictext:full name~0"), "Full name:", [20, 40, 90, 18], k("group:contact")),
        field(k("group:contact/textfield:~0"), "", { parent: k("group:contact"), frame: [120, 38, 240, 22] }),
        text(k("group:contact/statictext:work email~0"), "Work email", [120, 70, 120, 16], k("group:contact")),
        field(k("group:contact/textfield:~1"), "", { parent: k("group:contact"), frame: [120, 88, 240, 22] }),
        field(k("textfield:promo code~0"), "", { label: "Promo code", frame: [120, 300, 240, 22] }),
        field(k("textfield:city~0"), "", { placeholder: "City", frame: [120, 340, 240, 22] }),
        field(k("textfield:filled~0"), "already here", { label: "Filled", frame: [120, 380, 240, 22] }),
        field(k("textfield:password~0"), "", { label: "Password", states: ["secure"], frame: [120, 420, 240, 22] }),
        // Same text as a source span, but in the form's own window: never a candidate.
        text(k("statictext:ord~0"), "ORD-0000-11111", [400, 40, 100, 18]),
      ],
      { at: 2000, windowId: FORM, title: "Claim form", focused: true, values: [value("id", "ORD-0000-11111", k("statictext:ord~0"))] },
    ),
  );
  return m;
}

describe("field descriptors", () => {
  const m = buildModel();
  const w = m.windows.get(FORM)!;
  it("uses the static text to the left on the same row, without its colon", () => {
    expect(nearestText(w, w.nodes.get(k("group:contact/textfield:~0"))!)).toBe("Full name");
  });
  it("falls back to the static text directly above", () => {
    expect(nearestText(w, w.nodes.get(k("group:contact/textfield:~1"))!)).toBe("Work email");
  });
  it("prefers the field's own label and names its section", () => {
    expect(describeField(w, w.nodes.get(k("textfield:promo code~0"))!).text).toBe("Text field. Label: 'Promo code'.");
    expect(describeField(w, w.nodes.get(k("group:contact/textfield:~0"))!).text).toBe("Text field. Nearest label: 'Full name'. Section: 'Contact'.");
    expect(describeField(w, w.nodes.get(k("textfield:city~0"))!).text).toBe("Text field. Placeholder: 'City'.");
  });
});

describe("candidate generator", () => {
  const cands = generateCandidates(buildModel(), FORM);
  const texts = cands.map((c) => c.text);
  it("puts typed values first, then single lines, with Label: value lines split", () => {
    expect(texts.slice(0, 3)).toEqual(["ORD-2026-48213", "dana.whitfield@example.com", "Thursday, October 8, 2026 at 3:00 PM"]);
    expect(texts).toContain("Dana Whitfield");
    expect(texts).toContain("Senior Designer, Lumen Labs");
    expect(texts).not.toContain("Order number: ORD-2026-48213");
    expect(cands.find((c) => c.text === "ORD-2026-48213")?.context).toBe("Order number");
  });
  it("skips the form's own window, bare labels, buttons and duplicates", () => {
    expect(texts).not.toContain("ORD-0000-11111");
    expect(texts).not.toContain("To:");
    expect(texts).not.toContain("Reply");
    expect(new Set(texts).size).toBe(texts.length);
  });
  it("records where each candidate came from", () => {
    const c = cands.find((x) => x.text === "dana.whitfield@example.com")!;
    expect(c.source).toEqual({ windowId: SRC, bundleId: "dev.caret.mail", appName: "Mail Fixture", windowTitle: "Order confirmation", nodeKey: "m/statictext:sig~0", kind: "email" });
  });
  it("respects the cap", () => {
    expect(generateCandidates(buildModel(), FORM, 2)).toHaveLength(2);
  });
});

describe("form fields and the Jev request", () => {
  const m = buildModel();
  const w = m.windows.get(FORM)!;
  it("takes empty, non-secure fields, trigger first", () => {
    const keys = formFields(w, k("group:contact/textfield:~1")).map((n) => n.key);
    expect(keys[0]).toBe(k("group:contact/textfield:~1"));
    expect(keys).toHaveLength(4);
    expect(keys).not.toContain(k("textfield:filled~0"));
    expect(keys).not.toContain(k("textfield:password~0"));
  });
  it("refuses a trigger that is not an editable field of the window", () => {
    expect(() => formFields(w, k("statictext:ord~0"))).toThrow(FillError);
    expect(() => formFields(w, "nope")).toThrow(/not in window/);
  });
  it("asks one choice question per field, each with every candidate and none", () => {
    const cands = generateCandidates(m, FORM);
    const req = buildFillRequest(w, [{ id: "f1", descriptor: "Text field. Label: 'Email'." }, { id: "f2", descriptor: "Text field." }], cands);
    expect(Object.keys(req.questions)).toEqual(["f1", "f2"]);
    const q = req.questions.f1!;
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria)).toEqual([...cands.map((c) => c.id), "none"]);
    expect(q.criteria.c2).toBe(`"dana.whitfield@example.com" (email; in Mail Fixture window 'Order confirmation')`);
  });
});

describe("proposeFill", () => {
  const fakeJev = (pick: (req: JevRequest) => Record<string, string>): AskJev => async (req) => ({
    model: "jev-test",
    answers: Object.fromEntries(Object.entries(pick(req)).map(([id, choice]) => [id, { choice, confidence: 0.9 }])),
    inputTokens: 1000,
    latencyMs: 12,
    costUsd: 0.000042,
  });

  it("copies the chosen candidate's text verbatim and maps none to null", async () => {
    const m = buildModel();
    const p = await proposeFill(
      m,
      fakeJev((req) => Object.fromEntries(Object.keys(req.questions).map((id, i) => [id, i === 0 ? "c2" : "none"]))),
      FORM,
      k("group:contact/textfield:~1"),
      5000,
    );
    expect(p.fields[0]).toMatchObject({ key: k("group:contact/textfield:~1"), choice: "c2", value: "dana.whitfield@example.com" });
    expect(p.fields[0]?.source?.windowId).toBe(SRC);
    expect(p.fields.slice(1).every((f) => f.value === null && f.source === null)).toBe(true);
    expect(p).toMatchObject({ type: "fillProposal", windowId: FORM, at: 5000, jev: { model: "jev-test", inputTokens: 1000 } });
  });

  it("fails loudly when Jev answers with an id that is not a candidate", async () => {
    const m = buildModel();
    await expect(proposeFill(m, fakeJev((req) => Object.fromEntries(Object.keys(req.questions).map((id) => [id, "c999"]))), FORM, k("textfield:city~0"))).rejects.toThrow(/not a candidate/);
  });

  it("fails loudly when there is no other window to draw from", async () => {
    const m = new ScreenModel();
    m.apply(snap([field(k("textfield:a~0"), "", { label: "A" })], { at: 1, windowId: FORM }));
    await expect(proposeFill(m, fakeJev(() => ({})), FORM, k("textfield:a~0"))).rejects.toThrow(/no candidate values/);
  });
});
