import { expect, it } from "vitest";
import { collectCandidates } from "../src/fill/candidates.ts";
import { ScreenModel } from "../src/model.ts";
import { snap } from "./builders.ts";

it("cuts the same partial window after 600 visits on every run without a clock", () => {
  const model = new ScreenModel();
  model.apply(snap([
    { key: "source/start", parent: null, role: "AXStaticText", label: "Name: Ines Okafor" },
    ...Array.from({ length: 600 }, (_, i) => ({ key: `source/group${i}`, parent: null, role: "AXGroup" })),
    { key: "source/end", parent: null, role: "AXStaticText", label: "School: Lakeside College" },
  ], { at: 1000, windowId: "source", focused: true }));
  model.apply(snap([], { at: 2000, windowId: "form", focused: true }));

  const read = () => collectCandidates(model, "form", { now: 3000 });
  const first = read();
  expect(first.stats.overBudget).toBe(true);
  expect(first.stats.nodes).toBe(599);
  expect(first.candidates.map((c) => c.text)).toEqual(["Ines Okafor"]);
  expect(first.cut).toEqual(["source"]);
  expect(first.namesCut).toBe(false);
  for (let run = 0; run < 30; run++) {
    const next = read();
    expect({ ...next, stats: { ...next.stats, ms: 0 } }).toEqual({ ...first, stats: { ...first.stats, ms: 0 } });
  }
});
