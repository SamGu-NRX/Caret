// nearestText reads only a band of rows from a per-window index sorted by top edge (B8). It must give
// exactly what the scan of every static text before B8 gave, ties included; the old scan is kept here.
import { describe, expect, it } from "vitest";
import { nearestText, isLabelLike } from "../src/fill/descriptor.ts";
import { ScreenModel, type WindowState } from "../src/model.ts";
import type { Node } from "../src/protocol.ts";
import { snap } from "./builders.ts";
import { rng } from "./large-scene.ts";

/** nearestText as it was at 6546966: a scan of every static text in document order. */
function scanNearest(w: WindowState, target: Node, labelOnly: boolean): string | null {
  const f = target.frame;
  if (f === undefined) return null;
  const [fx, fy, , fh] = f;
  const cy = fy + fh / 2;
  let left: { d: number; t: string } | null = null;
  let above: { d: number; t: string } | null = null;
  for (const n of w.nodes.values()) {
    if (n.role !== "AXStaticText" || n.frame === undefined) continue;
    const raw = n.label ?? n.value;
    if (raw === undefined || raw === null) continue;
    const t = raw.replace(/\s+/g, " ").trim();
    if (t.length === 0 || t.length > 60) continue;
    if (n.key === target.key || (labelOnly && !isLabelLike(t))) continue;
    const [x, y, wd, h] = n.frame;
    const right = x + wd;
    const textCy = y + h / 2;
    if (Math.abs(textCy - cy) <= Math.max(fh, h) / 2 && right <= fx + 4) {
      const d = fx - right;
      if (d <= 260 && (left === null || d < left.d)) left = { d, t };
      continue;
    }
    const bottom = y + h;
    if (bottom <= fy + 4 && x < f[0] + f[2] && f[0] < x + wd) {
      const d = fy - bottom;
      if (d <= 48 && (above === null || d < above.d)) above = { d, t };
    }
  }
  const out = (left ?? above)?.t ?? null;
  return out === null ? null : out.replace(/\s*:\s*$/, "");
}

describe("nearestText", () => {
  it("matches the scan of every static text on random windows", () => {
    const texts = ["Name:", "Email", "  Phone  number ", "Total due\n$41.50", "Ref\tcode", "Ship to", "", "x".repeat(70), `${" ".repeat(30)}Short${" ".repeat(40)}`, "Dana W", "ORD-48213", "Billing address:"];
    let compared = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
      const nodes: Node[] = [];
      for (let i = 0; i < 60; i++) {
        const role = r() < 0.75 ? "AXStaticText" : pick(["AXTextField", "AXButton", "AXGroup"]);
        // Coarse coordinates so ties in distance are common; a few tall and a few negative heights.
        const h = r() < 0.05 ? 300 + Math.floor(r() * 400) : r() < 0.02 ? -10 : 10 + 4 * Math.floor(r() * 5);
        const frame: [number, number, number, number] = [20 * Math.floor(r() * 20), 10 * Math.floor(r() * 40), 20 + 20 * Math.floor(r() * 10), h];
        const label = pick(texts);
        nodes.push({ key: `n${i}`, parent: null, role, ...(r() < 0.9 ? { frame } : {}), ...(role === "AXTextField" ? { editable: true } : r() < 0.2 ? { value: label } : { label }) });
      }
      const model = new ScreenModel();
      model.apply(snap(nodes, { at: 1000 + seed, windowId: "w" }));
      const w = model.windows.get("w") as WindowState;
      for (const target of w.nodes.values()) {
        for (const labelOnly of [false, true]) {
          expect(nearestText(w, target, labelOnly), `seed ${seed} ${target.key} ${labelOnly}`).toBe(scanNearest(w, target, labelOnly));
          compared++;
        }
      }
    }
    expect(compared).toBe(300 * 60 * 2);
  });

  it("finds a text whose gap is exactly the limit though its fractional top rounds past the band's edge", () => {
    const model = new ScreenModel();
    model.apply(snap([
      { key: "label", parent: null, role: "AXStaticText", label: "Name:", frame: [100, 0.6, 80, 1.4] },
      { key: "field", parent: null, role: "AXTextField", editable: true, frame: [100, 50, 100, 20] },
    ], { at: 1, windowId: "w" }));
    const w = model.windows.get("w") as WindowState;
    const field = w.nodes.get("field") as Node;
    expect(scanNearest(w, field, false)).toBe("Name");
    expect(nearestText(w, field)).toBe("Name");
  });

  it("matches the scan on fractional coordinates", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 7919);
      const nodes: Node[] = [];
      for (let i = 0; i < 40; i++) {
        const frac = (n: number): number => Math.round(r() * n * 10) / 10;
        const frame: [number, number, number, number] = [frac(400), frac(300), 1 + frac(200), r() < 0.05 ? 250 : 0.2 + frac(30)];
        nodes.push(i % 4 === 0 ? { key: `n${i}`, parent: null, role: "AXTextField", editable: true, frame } : { key: `n${i}`, parent: null, role: "AXStaticText", label: `Label ${i % 7}:`, frame });
      }
      const model = new ScreenModel();
      model.apply(snap(nodes, { at: 1, windowId: "w" }));
      const w = model.windows.get("w") as WindowState;
      for (const target of w.nodes.values()) expect(nearestText(w, target), `seed ${seed} ${target.key}`).toBe(scanNearest(w, target, false));
    }
  });
});
