import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { generateCandidates } from "../src/fill/candidates.ts";
import { describeField, nearestText } from "../src/fill/descriptor.ts";
import { buildFillRequest, FillError, formFields, proposeFill, shuffledWithinWindows } from "../src/fill/fill.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { field, jevPickingText, MAIL_APP, node, snap, text, value } from "./builders.ts";

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
    expect(c.source).toEqual({ pid: 6160, windowId: SRC, bundleId: "dev.caret.mail", appName: "Mail Fixture", windowTitle: "Order confirmation", nodeKey: "m/statictext:sig~0", kind: "email" });
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
    const req = buildFillRequest(w, [{ id: "f1", descriptor: "Text field. Label: 'Email'.", name: "Email" }, { id: "f2", descriptor: "Text field.", name: "unnamed field" }], cands);
    expect(Object.keys(req.questions)).toEqual(["f1", "f2"]);
    const q = req.questions.f1!;
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria)).toEqual([...cands.map((c) => c.id), "none"]);
    expect(q.criteria.c2).toBe(
      `"dana.whitfield@example.com" (email; in a block that starts 'Dana Whitfield'; in Mail Fixture window 'Order confirmation', a window the user has not visited)`,
    );
    expect(req.state).toMatchObject({ form_fields: "Email; unnamed field" });
  });
});

describe("proposeFill", () => {
  const EMAIL = "dana.whitfield@example.com";
  /** Picks by candidate text in both asks, so agreement depends only on what `pick` returns per ask. */
  const twoAsks = (pick: (ask: 1 | 2, fieldId: string) => string | null, conf: [number, number] = [0.9, 0.9]): AskJev => {
    let call = 0;
    return async (req) => {
      const ask = (++call % 2 === 1 ? 1 : 2) as 1 | 2;
      return jevPickingText((id) => pick(ask, id), conf[ask - 1])(req);
    };
  };
  const trigger = k("group:contact/textfield:~1");

  it("copies the chosen candidate's text verbatim when both asks agree, and maps none to null", async () => {
    const p = await proposeFill(buildModel(), twoAsks((_, id) => (id === "f1" ? EMAIL : null)), FORM, trigger, 5000);
    expect(p.fields[0]).toMatchObject({ key: trigger, choice: "c2", value: EMAIL, withheld: null, confidence: 0.9 });
    expect(p.fields[0]?.asks.map((a) => a.value)).toEqual([EMAIL, EMAIL]);
    expect(p.fields[0]?.source?.windowId).toBe(SRC);
    expect(p.fields.slice(1).every((f) => f.value === null && f.source === null && f.withheld === null)).toBe(true);
    // Four requests of 1,000 tokens: since B24 a form with a field that takes a person's details is asked in two stages.
    expect(p).toMatchObject({ type: "fillProposal", pid: 5150, windowId: FORM, at: 5000, jev: { model: "jev-test", inputTokens: 4000 } });
  });

  it("withholds a value the two asks disagree on", async () => {
    const p = await proposeFill(buildModel(), twoAsks((ask, id) => (id !== "f1" ? null : ask === 1 ? EMAIL : "Dana Whitfield")), FORM, trigger, 5000);
    expect(p.fields[0]).toMatchObject({ choice: "none", value: null, withheld: "disagree", confidence: 0 });
    expect(p.fields[0]?.asks.map((a) => a.value)).toEqual([EMAIL, "Dana Whitfield"]);
  });

  it("withholds an agreed value whose lower confidence is under the cutoff", async () => {
    const p = await proposeFill(buildModel(), twoAsks((_, id) => (id === "f1" ? EMAIL : null), [0.95, 0.4]), FORM, trigger, 5000, { cutoff: 0.5 });
    expect(p.fields[0]).toMatchObject({ choice: "none", value: null, withheld: "lowConfidence", confidence: 0.4 });
    expect(p.cutoff).toBe(0.5);
  });

  it("shows the second ask the candidates in another order under other ids, and words the field differently", async () => {
    const seen: JevRequest[] = [];
    const ask: AskJev = async (req) => {
      seen.push(req);
      return jevPickingText(() => null)(req);
    };
    // A fixed "random" source that rotates each window's candidates.
    await proposeFill(buildModel(), ask, FORM, trigger, 5000, { rand: () => 0 });
    // The value stage's two asks (B24 asks whose details first, in two requests without value questions).
    const [q1, q2] = seen.filter((r) => r.questions.f1 !== undefined).map((r) => r.questions.f1!);
    const texts = (q: typeof q1) => Object.entries(q!.criteria).filter(([id]) => id !== "none").map(([, d]) => d);
    expect(texts(q2)).not.toEqual(texts(q1));
    expect([...texts(q2)].sort()).toEqual([...texts(q1)].sort());
    expect(Object.keys(q2!.criteria).every((id) => id === "none" || id.startsWith("v"))).toBe(true);
    expect(q1!.instructions).not.toBe(q2!.instructions);
  });

  it("shuffles the second ask only inside each source window", () => {
    const m = buildModel();
    m.apply(snap([text("m/statictext:x~0", "Other line"), text("m/statictext:z~0", "Third line")], { at: 4000, windowId: "7000-1", title: "Just left", focused: true }));
    const cands = generateCandidates(m, FORM, undefined, 4500);
    const out = shuffledWithinWindows(cands, () => 0);
    const windows = (cs: typeof cands) => [...new Set(cs.map((c) => c.source.windowId))];
    const inWindow = (cs: typeof cands, id: string) => cs.filter((c) => c.source.windowId === id).map((c) => c.text);
    expect(windows(out)).toEqual(windows(cands));
    // Each window's candidates are contiguous and reordered.
    expect(out.map((c) => c.source.windowId)).toEqual(windows(cands).flatMap((id) => inWindow(cands, id).map(() => id)));
    expect(inWindow(out, SRC)).not.toEqual(inWindow(cands, SRC));
    expect([...inWindow(out, SRC)].sort()).toEqual([...inWindow(cands, SRC)].sort());
    expect([...out].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...cands].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("names the window the user just left on its candidates", async () => {
    const m = buildModel();
    m.apply(snap([text("m/statictext:x~0", "Other line")], { at: 3000, windowId: "7000-1", title: "Older", focused: true }));
    m.apply(snap([text("m/statictext:y~0", "Fresh line")], { at: 4000, windowId: "7000-2", title: "Just left", focused: true }));
    m.apply(snap([field(k("textfield:a~0"), "", { label: "A" })], { at: 4100, windowId: FORM, title: "Claim form", focused: true }));
    const cands = generateCandidates(m, FORM, undefined, 4500);
    expect(cands.find((c) => c.text === "Fresh line")?.recency).toBe("justLeft");
    expect(cands.find((c) => c.text === "Other line")?.recency).toBe("recent");
    expect(cands.find((c) => c.text === EMAIL)?.recency).toBe("unseen");
  });

  it("keeps the window left before the form, even after the user moves on to a third window", () => {
    const m = buildModel();
    m.apply(snap([text("m/statictext:y~0", "Source line")], { at: 2500, windowId: "7000-2", title: "Source", focused: true }));
    m.apply(snap([field(k("textfield:a~0"), "", { label: "A" })], { at: 3000, windowId: FORM, title: "Claim form", focused: true }));
    m.apply(snap([text("m/statictext:x~0", "Other form")], { at: 4000, windowId: "7000-3", title: "Another form", focused: true }));
    expect(m.windowBefore(FORM)).toBe("7000-2");
    const cands = generateCandidates(m, FORM, undefined, 4500);
    expect(cands.find((c) => c.text === "Source line")?.recency).toBe("justLeft");
    expect(cands.find((c) => c.text === "Other form")?.recency).toBe("recent");
  });

  it("fails loudly when Jev answers with an id that is not a candidate", async () => {
    const m = buildModel();
    const bad: AskJev = async (req) => ({ model: "t", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "c999", confidence: 0.9 }])), inputTokens: 1, latencyMs: 1, costUsd: 0 });
    await expect(proposeFill(m, bad, FORM, k("textfield:city~0"))).rejects.toThrow(/not a candidate/);
  });

  it("fails loudly when there is no other window to draw from", async () => {
    const m = new ScreenModel();
    m.apply(snap([field(k("textfield:a~0"), "", { label: "A" })], { at: 1, windowId: FORM }));
    await expect(proposeFill(m, jevPickingText(() => null), FORM, k("textfield:a~0"))).rejects.toThrow(/no candidate values/);
  });
});
