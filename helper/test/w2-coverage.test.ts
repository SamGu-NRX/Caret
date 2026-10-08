// W2 (AC1 migration step 6): coverage the write contract makes safe. An organization that ends in a legal suffix is
// offered as a part; a part of a labelled value is an extra, which never spends the budget of a kind's group and is
// dropped without cutting its window when it does not fit (W1's regression: a canned Greenhouse goal went from 12/12
// to 6/6 when the parts of "School: …, September 2016 to May 2020." joined the note's names, evidence/screen/w1). All
// text is synthetic fixture text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { heldReason, proposeFill } from "../src/fill/fill.ts";
import type { FillField } from "../src/protocol.ts";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { lineTexts } from "../src/fill/line-values.ts";
import { field, jevPickingText, snap } from "./builders.ts";

beforeAll(() => setGeneratorClock(() => 0));
afterAll(() => setGeneratorClock(null));

describe("an organization with a legal suffix is a part (REVIEW-R2 round-1 item 4)", () => {
  it.each([
    ["Work: Junior Analyst at Ridgeline Outdoor Co, Inc.", ["Junior Analyst", "Ridgeline Outdoor Co, Inc."]],
    ["Work: Senior Engineer at Lumen Labs, LLC", ["Senior Engineer", "Lumen Labs, LLC"]],
    ["Currently: Junior Analyst at Ridgeline Outdoor Co (since 2024).", ["Junior Analyst at Ridgeline Outdoor Co", "Junior Analyst", "Ridgeline Outdoor Co"]],
  ] as const)("%s gives %j", (line, texts) => {
    expect(lineTexts(line).map((t) => t.text)).toEqual(texts);
    for (const t of lineTexts(line).filter((x) => x.partOf !== undefined)) expect(line.includes(t.text)).toBe(true);
  });
});

describe("a part never cuts its note (W1's Greenhouse regression)", () => {
  const T0 = 1_790_000_000_000;
  const note = (JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/web-form/tasks/expect/greenhouse.json"), "utf8")) as { sources: { note: string } }).sources.note;
  const LABELS = ["First Name", "Last Name", "Preferred First Name", "Phone", "School", "Start date month", "Start date year", "End date month", "End date year"];
  const WANT: Record<string, string> = { "First Name": "Dmitri", "Last Name": "Halvorsen", "Preferred First Name": "Dima", Phone: "555-0126", School: "Lakeshore Polytechnic Institute", "Start date month": "September", "Start date year": "2016", "End date month": "May", "End date year": "2020" };

  it("withholds no field as cut for the School line's parts, and writes the School line's dates", async () => {
    const m = new ScreenModel();
    m.apply(snap([field("note/text", note, { role: "AXTextArea" })], { at: T0 - 30_000, windowId: "note", title: "Kestrel notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
    m.apply(snap(LABELS.map((l, i) => field(`form/f${i}`, "", { label: l, frame: [100, 100 + 40 * i, 200, 24] })), { at: T0, windowId: "form", title: "Application", focused: true, focusedKey: "form/f0" }));
    const pick = jevPickingText((_id, ins) => WANT[LABELS.find((l) => ins.includes(`'${l}'`)) ?? ""] ?? null, 0.95);
    const p = await proposeFill(m, pick, "form", "form/f0", T0, { rand: () => 0 });
    const by = Object.fromEntries(LABELS.map((l, i) => [l, p.fields.find((f) => f.key === `form/f${i}`)]));
    expect(LABELS.filter((l) => by[l]?.withheld === "sourceCut")).toEqual([]);
    expect(Object.fromEntries(["Start date month", "Start date year", "End date month", "End date year"].map((l) => [l, by[l]?.value ?? null]))).toEqual({ "Start date month": "September", "Start date year": "2016", "End date month": "May", "End date year": "2020" });
  });

  it("withholds no field as cut for the School line's parts, and writes the note's name and dates", async () => {
    const m = new ScreenModel();
    m.apply(snap([field("note/text", note, { role: "AXTextArea" })], { at: T0 - 30_000, windowId: "note", title: "Kestrel notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
    m.apply(snap(LABELS.map((l, i) => field(`form/f${i}`, "", { label: l, frame: [100, 100 + 40 * i, 200, 24] })), { at: T0, windowId: "form", title: "Application", focused: true, focusedKey: "form/f0" }));
    const pick = jevPickingText((_id, ins) => WANT[LABELS.find((l) => ins.includes(`'${l}'`)) ?? ""] ?? null, 0.95);
    const p = await proposeFill(m, pick, "form", "form/f0", T0, { rand: () => 0 });
    const by = Object.fromEntries(LABELS.map((l, i) => [l, p.fields.find((f) => f.key === `form/f${i}`)]));
    expect(LABELS.filter((l) => by[l]?.withheld === "sourceCut")).toEqual([]);
    // The note's name, the School line's dates and its school are written (the note gives no first or last name of its
    // own: those come from the task's mail and memory). HA2: the name and phone's owner questions show the whole note.
    expect(["Preferred First Name", "Phone"].map((l) => heldReason(by[l] as FillField))).toEqual([null, null]);
    expect(Object.fromEntries(LABELS.map((l) => [l, by[l]?.value ?? null]))).toEqual({ "First Name": null, "Last Name": null, "Preferred First Name": "Dima", Phone: "555-0126", School: "Lakeshore Polytechnic Institute", "Start date month": "September", "Start date year": "2016", "End date month": "May", "End date year": "2020" });
  });
});
