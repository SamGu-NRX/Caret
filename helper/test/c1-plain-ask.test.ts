// C1 item 6: an Ask for the whole form that narrows nothing asks each value as a Fill all does; any Ask that narrows its
// sources, names a person or spells out a value keeps B25's wording, which quotes the instruction. Every name is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill, type FillScope } from "../src/fill/fill.ts";
import type { JevRequest } from "../src/fill/jev.ts";
import { field, jevPickingText, snap } from "./builders.ts";

const NOTE_APP = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };

async function questions(scope: Partial<FillScope>): Promise<string[]> {
  const m = new ScreenModel();
  m.apply(snap([{ key: "n", parent: null, role: "AXTextArea", value: "Order\nPhone: 555-0126\nOrder number: ORD-2026-0042", editable: true }], { at: 1000, windowId: "7001-1", title: "Notes.txt", app: NOTE_APP, focused: true }));
  m.apply(snap([field("f0", "", { label: "Order number", frame: [1, 1, 2, 2] })], { at: 2000, windowId: "F", focused: true }));
  const asked: JevRequest[] = [];
  const pick = jevPickingText(() => "ORD-2026-0042");
  const full: FillScope = { fields: ["f0"], windows: null, memory: true, instruction: "fill out this form", person: null, literals: new Map(), wholeForm: true, ...scope };
  await proposeFill(m, async (r) => (asked.push(r), pick(r)), "F", "f0", 3000, { scope: full });
  return asked.flatMap((r) => Object.entries(r.questions).filter(([k]) => k === "f1").map(([, q]) => String(q.instructions)));
}

describe("how an Ask words its value questions", () => {
  it("asks a whole-form Ask that narrows nothing as Fill all asks, without the instruction", async () => {
    const qs = await questions({});
    expect(qs).toHaveLength(2);
    for (const q of qs) expect(q).not.toContain("fill out this form");
    expect(qs[0]).toMatch(/^A form in the .* has this field: .*Which candidate is the value the user should enter in this field\?/);
  });

  it("keeps the instruction for an Ask that names fields, a source, a person or a value", async () => {
    const cases: Partial<FillScope>[] = [{ wholeForm: false }, { windows: new Set(["7001-1"]) }, { person: "Gary" }, { literals: new Map([["f0", "ORD-1"]]) }, { memory: false }];
    for (const c of cases) {
      const qs = await questions(c);
      expect(qs.length, JSON.stringify(c)).toBeGreaterThan(0);
      for (const q of qs) expect(q, JSON.stringify(c)).toContain('"fill out this form"');
    }
  });
});
