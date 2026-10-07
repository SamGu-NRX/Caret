import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { mintOf, proposeFill } from "../src/fill/fill.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import type { AskJev } from "../src/fill/jev.ts";
import type { Node } from "../src/protocol.ts";
import { field, jevPickingText, snap } from "./builders.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { validatePlan } from "../src/planner/validate.ts";
import { formatForField } from "../src/fill/field-format.ts";

const WIN = "5150-7";
const KEY = "com.google.Chrome/standard/target";
function desk(source: string, label: string, extra: Partial<Node> = {}): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("source", source, { role: "AXTextArea" })], { at: 1000, windowId: "7001-1", title: "Notes", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
  m.apply(snap([
    { key: "web", parent: null, role: "AXWebArea", label: "Form" },
    { key: "group", parent: "web", role: "AXGroup", subrole: "AXFieldset", label: "Date of birth" },
    field(KEY, "", { parent: "group", label, frame: [10, 10, 120, 20], ...extra }),
  ], { at: 2000, windowId: WIN, app: { pid: 5150, bundleId: "com.google.Chrome", name: "Google Chrome" }, title: "Form", focused: true }));
  return m;
}
const fill = (source: string, label: string, pick: string, extra: Partial<Node> = {}) => proposeFill(desk(source, label, extra), jevPickingText(() => pick), WIN, KEY, 3000);
afterEach(() => setTestVerifier(STAND_IN));

describe("F1 field-format values", () => {
  it.each(["B24 ask-07", "B31 b31-07"])("%s offers the source's named month and four-digit year as MM/YYYY", async () => {
    const p = await fill("Moved in: Aug 2022", "Moved in (MM/YYYY)", "08/2022");
    expect(p.fields[0]?.value).toBe("08/2022");
    const checked = mintOf(p.fields[0]!);
    expect(checked?.verdict.by).toBe("verifier");
    expect(checked?.provenance).toMatchObject({ kind: "derived", how: "fieldFormat", says: expect.stringContaining("Aug 2022"), base: { kind: "window", span: "Aug 2022" } });
  });

  it("B25 held-09 offers a known GitHub host and path with HTTPS, preserving the source", async () => {
    const p = await fill("GitHub: github.com/harperq-data", "GitHub URL", "https://github.com/harperq-data", { inputKind: "url" });
    expect(p.fields[0]?.value).toBe("https://github.com/harperq-data");
    expect(mintOf(p.fields[0]!)?.provenance).toMatchObject({ kind: "derived", how: "fieldFormat", says: expect.stringContaining("https://"), base: { kind: "window", span: "github.com/harperq-data" } });
  });

  it.each(["B24 ask-04", "B31 b31-02"])("%s withholds Day from 04/12/1990 without source order evidence", async () => {
    const p = await fill("Date of birth: 04/12/1990", "Day", "04/12/1990");
    expect(p.fields[0]?.value).toBeNull();
    expect(mintOf(p.fields[0]!)).toBeUndefined();
  });

  it.each([
    ["Date of birth: 04/12/90", "Day", "04/12/90"],
    ["Moved in: Aug '22", "Moved in (MM/YYYY)", "08/2022"],
    ["Moved in: 2022", "Moved in (MM/YYYY)", "08/2022"],
    ["GitHub: harperq-data", "GitHub URL", "https://github.com/harperq-data"],
    ["GitHub: github.com.evil.example/harperq-data", "GitHub URL", "https://github.com.evil.example/harperq-data"],
    ["Notes: github.com/harperq-data", "Notes", "https://github.com/harperq-data"],
  ])("withholds an unsupported conversion of %s", async (source, label, pick) => {
    const p = await fill(source, label, pick);
    expect(p.fields[0]?.value).toBeNull();
  });

  it.each([
    ["Moved in: Aug 2022", "Moved in (MM/YYYY)", "08/2022"],
    ["GitHub: github.com/harperq-data", "GitHub URL", "https://github.com/harperq-data"],
  ])("the planner traces %s through its verified original source and rejects a stale source", async (source, label, text) => {
    const model = desk(source, label);
    const p = await proposeFill(model, jevPickingText(() => text), WIN, KEY, 3000);
    const checked = mintOf(p.fields[0]!);
    if (checked === undefined) throw new Error("fixture has no checked field-format value");
    const plan = { id: "format-plan", title: "Fill", slots: { v1: "value" }, steps: [{ says: "Field holds {{v1}}", end: { kind: "valueEquals", window: { bundleId: "com.google.Chrome", title: "Form" }, target: { key: KEY, describe: "field" }, value: "{{v1}}" } }] };
    const context = { model, memory: [], instruction: "fill the field", origin: checked.authority };
    const mints = new Map([["v1", checked]]);
    const result = validatePlan(plan, { v1: text }, context, mints);
    expect(result.writes[0]?.trace).toEqual({ from: "window", windowId: "7001-1", nodeKey: "source" });
    expect(result.writes[0]?.checked).toBe(checked);
    expect(() => validatePlan(plan, { v1: text }, context, new Map())).toThrow();
    expect(() => validatePlan(plan, { v1: text }, context, new Map([["v1", structuredClone(checked)]]))).toThrow();
    expect(() => validatePlan(plan, { v1: "another value" }, context, mints)).toThrow();
    model.apply(snap([field("source", "The source changed", { role: "AXTextArea" })], { at: 4000, windowId: "7001-1", title: "Notes", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" } }));
    expect(() => validatePlan(plan, { v1: text }, context, mints)).toThrow();
  });

  it.each([
    ["Aug '22", "Moved in (MM/YYYY)"],
    ["08/22", "Moved in (MM/YYYY)"],
    ["summer 2022", "Moved in (MM/YYYY)"],
    ["August 2022 to May 2023", "Moved in (MM/YYYY)"],
    ["harperq-data", "GitHub URL"],
    ["github.com", "GitHub URL"],
    ["github.com.evil.example/harperq-data", "GitHub URL"],
    ["github.com@evil.example/harperq-data", "GitHub URL"],
    ["//github.com/harperq-data", "GitHub URL"],
    ["github.com/harperq-data extra", "GitHub URL"],
    ["github.com/harperq-data", "Notes"],
  ])("does not format an ambiguous or unsupported value %s", (text, label) => {
    expect(formatForField(text, [label], undefined)).toBeNull();
  });

  it("uses the input's URL kind as evidence but never changes an existing scheme", () => {
    expect(formatForField("github.com/harperq-data", ["Profile"], "url")?.value).toBe("https://github.com/harperq-data");
    expect(formatForField("http://github.com/harperq-data", ["GitHub URL"], "url")).toBeNull();
  });

  it.each([
    ["Moved in: Aug 2022", "Moved in (MM/YYYY)", "08/2022", "the source's month and year"],
    ["GitHub: github.com/harperq-data", "GitHub URL", "https://github.com/harperq-data", "Caret chose HTTPS"],
  ])("does not bypass either verifier wording and carries the transformation of %s into both requests", async (source, label, text, description) => {
    const requests: string[] = [];
    const refuse: AskJev = async (req) => {
      requests.push(JSON.stringify(req));
      return { model: "refuse", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "more", confidence: 0.99 }])), inputTokens: 0, latencyMs: 0, costUsd: 0 };
    };
    setTestVerifier(refuse);
    const p = await fill(source, label, text);
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      expect(req).toContain(text);
      expect(req).toContain(description);
      expect(req).toContain("Caret assumed:");
    }
    expect(p.fields[0]?.value).toBeNull();
    expect(p.fields[0]?.withheld).toBe("notExact");
  });
});
