// The early-capped candidate generator: the same output as the generator before B6, a cost that
// follows the cap rather than the screen, and a time budget that stops it.
import { describe, expect, it } from "vitest";
import { collectCandidates, countSpans, generateCandidates, MAX_CANDIDATES } from "../src/fill/candidates.ts";
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

  it.each([1, 20, MAX_CANDIDATES, 300, 1000, Number.POSITIVE_INFINITY])("gives exactly the old generator's first %s candidates", (max) => {
    const got = collectCandidates(scene.model, scene.formWindowId, { max, now: NOW, budgetMs: Number.POSITIVE_INFINITY }).candidates;
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
        expect(collectCandidates(model, "w0", { max, now: 5000, budgetMs: Number.POSITIVE_INFINITY }).candidates, `seed ${seed} max ${max}`).toEqual(
          legacyGenerateCandidates(model, "w0", max, 5000),
        );
      }
    }
  });

  it("stops reading once it has the cap, so it never builds every span", () => {
    const { candidates, stats } = collectCandidates(scene.model, scene.formWindowId, { now: NOW, budgetMs: Number.POSITIVE_INFINITY });
    expect(candidates).toHaveLength(MAX_CANDIDATES);
    const values = [...scene.model.windows.values()].reduce((k, w) => k + w.values.length, 0);
    // The scene's most recent window alone holds enough typed values: no node is read for lines.
    expect(stats.values).toBeLessThanOrEqual(MAX_CANDIDATES + 5);
    expect(stats.values).toBeLessThan(values);
    expect(stats.nodes).toBe(0);
    expect(stats.overBudget).toBe(false);
  });

  describe("time budget", () => {
    /** A clock that moves 0.5 ms each time it is read. */
    const slowClock = (): (() => number) => {
      let t = 0;
      return () => (t += 0.5);
    };

    it("stops when the budget runs out and returns the head of the full ranking", () => {
      const full = legacyGenerateCandidates(scene.model, scene.formWindowId, 1000, NOW);
      const { candidates, stats } = collectCandidates(scene.model, scene.formWindowId, { max: 1000, now: NOW, budgetMs: 5, clock: slowClock() });
      expect(stats.overBudget).toBe(true);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.length).toBeLessThan(1000);
      expect(candidates).toEqual(full.slice(0, candidates.length));
      // The clock is read every 64 nodes or values: ten reads past the start is 5 ms.
      expect(stats.values + stats.nodes).toBeLessThanOrEqual(64 * 11);
    });

    it("does not stop a pass that fits in the budget", () => {
      const { stats } = collectCandidates(scene.model, scene.formWindowId, { now: NOW, budgetMs: 15, clock: slowClock() });
      expect(stats.overBudget).toBe(false);
    });

    it("stops on the budget while reading lines as well as typed values", () => {
      const noValues = new ScreenModel();
      for (const s of scene.snapshots) noValues.apply({ ...s, values: [] });
      const { candidates, stats } = collectCandidates(noValues, scene.formWindowId, { max: 1000, now: NOW, budgetMs: 2, clock: slowClock() });
      expect(stats.overBudget).toBe(true);
      expect(stats.nodes).toBeGreaterThan(0);
      expect(candidates).toEqual(legacyGenerateCandidates(noValues, scene.formWindowId, 1000, NOW).slice(0, candidates.length));
    });
  });

  it("keeps generateCandidates' signature and default cap", () => {
    expect(generateCandidates(scene.model, scene.formWindowId, undefined, NOW)).toEqual(legacyGenerateCandidates(scene.model, scene.formWindowId, MAX_CANDIDATES, NOW));
  });
});
