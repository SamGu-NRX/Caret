import { describe, expect, it } from "vitest";
import { collectCandidates, countSpans, generateCandidates, MAX_CANDIDATES, MAX_GENERATOR_VISITS } from "../src/fill/candidates.ts";
import { ScreenModel } from "../src/model.ts";
import type { Node, TypedValue } from "../src/protocol.ts";
import { legacyGenerateCandidates } from "./legacy-candidates.ts";
import { largeScene, rng } from "./large-scene.ts";
import { snap } from "./builders.ts";

describe("candidate generator", () => {
  const scene = largeScene();
  const NOW = 2_000_000;

  it("works on a scene with 1,500 or more spans and a couple of hundred typed values", () => {
    const c = countSpans(scene.model, scene.formWindowId);
    expect(c.spans).toBeGreaterThanOrEqual(1500);
    expect(c.typed).toBeGreaterThanOrEqual(200);
    // countSpans agrees with the old generator run with no cap.
    const all = legacyGenerateCandidates(scene.model, scene.formWindowId, Number.POSITIVE_INFINITY, NOW);
    expect(c.spans).toBe(all.length);
    expect(c.typed).toBe(all.filter((x) => x.kind !== null).length);
  });

  it.each([1, 20, MAX_CANDIDATES])("gives exactly the old generator's first %s candidates", (max) => {
    const got = collectCandidates(scene.model, scene.formWindowId, { max, now: NOW }).candidates;
    expect(got).toEqual(legacyGenerateCandidates(scene.model, scene.formWindowId, max, NOW));
  });

  it("matches the old generator on random small screens", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const model = new ScreenModel();
      const roles = ["AXStaticText", "AXCell", "AXHeading", "AXLink", "AXButton", "AXGroup", "AXTextField"];
      for (let w = 0; w < 4; w++) {
        const nodes: Node[] = [];
        const values: TypedValue[] = [];
        for (let i = 0; i < 30; i++) {
          const role = roles[Math.floor(r() * roles.length)] as string;
          const parent = i > 0 && r() < 0.5 ? (nodes[Math.floor(r() * nodes.length)]?.key ?? null) : null;
          const words = ["Name: Ines Okafor", "Phone:", "ORD-48213", "a", "Total due\n$41.50", "Venue deposit", "x".repeat(90), "Dana W"];
          const label = words[Math.floor(r() * words.length)] as string;
          const key = `w${w}/n${i}`;
          const editable = role === "AXTextField";
          nodes.push({ key, parent, role, frame: [Math.floor(r() * 600), Math.floor(r() * 600), 120, 18], ...(editable ? { editable: true, value: label } : { label }) });
          if (r() < 0.2) values.push({ kind: "id", text: label.slice(0, 9), nodeKey: key });
        }
        model.apply(snap(nodes, { at: 1000 + w * 100 + seed, windowId: `w${w}`, focused: r() < 0.7, values }));
      }
      for (const max of [3, 10, MAX_CANDIDATES]) {
        expect(collectCandidates(model, "w0", { max, now: 5000 }).candidates, `seed ${seed} max ${max}`).toEqual(
          legacyGenerateCandidates(model, "w0", max, 5000),
        );
      }
    }
  });

  it("matches the old generator on long multi-line nodes, where labels and block heads are searched rather than split", () => {
    const pool = ["Order: ORD-1", "ORD-1 pending", "  Ref: ORD-1  ", "", "   ", "Name: Ines Okafor\r", "Total due", "ORD-1: the label holds it", "Ines", "Okafor: Ines", "Status: ORD-1 and ORD-2", "x".repeat(40)];
    const spans = ["ORD-1", "ORD-2", "Ines", "Okafor", "Total due", "pending"];
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
      const model = new ScreenModel();
      for (let w = 0; w < 3; w++) {
        const nodes: Node[] = [{ key: `w${w}/g`, parent: null, role: "AXGroup", label: pick(["Billing", "Order: ORD-1", "Ines"]) }];
        const values: TypedValue[] = [];
        for (let i = 0; i < 6; i++) {
          const lines = Array.from({ length: 1 + Math.floor(r() * 30) }, () => pick(pool));
          const text = lines.join(r() < 0.3 ? "\r\n" : "\n");
          const key = `w${w}/n${i}`;
          const role = pick(["AXStaticText", "AXTextArea", "AXCell"]);
          const editable = role === "AXTextArea";
          nodes.push({ key, parent: `w${w}/g`, role, frame: [10 * i, 20 * i, 200, 18], ...(editable ? { editable: true, value: text, label: "Notes" } : { label: text }) });
          for (let k = 0; k < 4; k++) if (r() < 0.6) values.push({ kind: "id", text: pick(spans), nodeKey: key });
        }
        model.apply(snap(nodes, { at: 1000 + w * 100 + seed, windowId: `w${w}`, focused: w === 0, values }));
      }
      for (const max of [5, MAX_CANDIDATES]) {
        expect(collectCandidates(model, "w0", { max, now: 5000 }).candidates, `seed ${seed} max ${max}`).toEqual(
          legacyGenerateCandidates(model, "w0", max, 5000),
        );
      }
    }
  });

  it("stops reading once it has the cap, so it never builds every span", () => {
    const { candidates, stats } = collectCandidates(scene.model, scene.formWindowId, { now: NOW });
    expect(candidates).toHaveLength(MAX_CANDIDATES);
    const values = [...scene.model.windows.values()].reduce((k, w) => k + w.values.length, 0);
    // The scene's most recent window alone holds enough typed values: no node is read for lines.
    expect(stats.values).toBeLessThanOrEqual(MAX_CANDIDATES + 5);
    expect(stats.values).toBeLessThan(values);
    expect(stats.nodes).toBe(0);
    expect(stats.overBudget).toBe(false);
  });

  it("counts duplicate typed values toward the visit cap", () => {
    const model = new ScreenModel();
    const node = { key: "source/phone", parent: null, role: "AXStaticText", label: "Phone: 555-0147" };
    const values: TypedValue[] = Array.from({ length: MAX_GENERATOR_VISITS + 1 }, () => ({ kind: "phone", text: "555-0147", nodeKey: node.key }));
    model.apply(snap([node], { at: 1000, windowId: "source", focused: true, values }));
    const result = collectCandidates(model, "form", { now: NOW });
    expect(result.stats.overBudget).toBe(true);
    expect(result.stats.values).toBe(MAX_GENERATOR_VISITS);
    expect(result.candidates.map((c) => c.text)).toEqual(["555-0147"]);
    expect(result.cut).toEqual(["source"]);
  });

  it("stops on the visit cap while reading lines", () => {
    const noValues = new ScreenModel();
    for (const s of scene.snapshots) noValues.apply({ ...s, values: [] });
    const result = collectCandidates(noValues, scene.formWindowId, { max: 1000, now: NOW });
    expect(result.stats.overBudget).toBe(true);
    expect(result.stats.nodes).toBeGreaterThan(0);
    expect(result.candidates).toEqual(legacyGenerateCandidates(noValues, scene.formWindowId, 1000, NOW).slice(0, result.candidates.length));
  });

  it("applies both caps inside one node's lines", () => {
    const model = new ScreenModel();
    const log = Array.from({ length: 20_000 }, (_, i) => `build step ${i} finished`).join("\n");
    model.apply(snap([{ key: "l/statictext~0", parent: null, role: "AXStaticText", label: log }], { at: 1000, windowId: "log", focused: true }));
    model.apply(snap([], { at: 2000, windowId: "form", focused: true }));
    const capped = collectCandidates(model, "form", { now: 3000 });
    expect(capped.candidates).toHaveLength(MAX_CANDIDATES);
    expect(capped.stats.overBudget).toBe(false);
    const visited = collectCandidates(model, "form", { max: 20_000, now: 3000 });
    expect(visited.stats.overBudget).toBe(true);
    expect(visited.candidates).toHaveLength(MAX_GENERATOR_VISITS - 1);
    expect(visited.cut).toEqual(["log"]);
  });

  it("keeps generateCandidates' signature and default cap", () => {
    expect(generateCandidates(scene.model, scene.formWindowId, undefined, NOW)).toEqual(legacyGenerateCandidates(scene.model, scene.formWindowId, MAX_CANDIDATES, NOW));
  });
});
