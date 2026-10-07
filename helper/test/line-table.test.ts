// The ledger's line table follows each window id from snapshot to snapshot, changing only the lines of
// nodes that differ (privacy.ts LineTable). Whatever the order of snapshots, a ledger must charge exactly
// what it charges over the same states read from scratch. All text is synthetic.
import { Disclosure } from "../src/privacy/disclosure.ts";
import { describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import type { AppRef, Node } from "../src/protocol.ts";
import { forgetWindow, readWindow, windowBudget } from "../src/privacy.ts";
import { rng } from "./large-scene.ts";
import { snap } from "./builders.ts";

const MESSAGES: AppRef = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
const NOTES: AppRef = { pid: 6161, bundleId: "dev.caret.notes", name: "Notes" };
const POOL = ["Dana Whitfield", "dana.whitfield@example.com", "Lumen Labs", "see you at 3:41 PM", "Dana Whitfield, see you at 3:41 PM", "ok", "bring the deck", "Lumen", "  spaced   out  ", "two\nlines here", "Room 4B"];

/**
 * A copy of a state under another window id, so its budget is worked out again and its table is read
 * from scratch, while the original ids' tables keep following their windows.
 */
const scratchId = (id: string): string => `${id}#scratch`;
const copy = (w: WindowState): WindowState => ({ ...w, window: { ...w.window, windowId: scratchId(w.window.windowId) }, nodes: new Map(w.nodes) });
const unscratch = (rec: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(rec).map(([k, v]) => [k.replace("#scratch", ""), v]));

interface Outcome {
  budgets: Record<string, number>;
  takes: boolean[];
  charges: Record<string, number>;
}

function priceAll(states: readonly WindowState[], texts: readonly { from: number; t: string }[]): Outcome {
  const ledger = new Disclosure(states);
  const takes = texts.map(({ from, t }) => ledger.take(states[from] as WindowState, "candidate", [t]));
  return { budgets: Object.fromEntries(states.map((w) => [w.window.windowId, windowBudget(w)])), takes, charges: ledger.charges() };
}

describe("the ledger's line table", () => {
  it("charges what a table read from scratch charges, over random full and partial snapshots", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
      const m = new ScreenModel();
      let at = 1;
      const windows = ["lt-chat", "lt-notes"];
      const nodes = new Map<string, Node[]>(windows.map((id) => [id, []]));
      for (let step = 0; step < 40; step++) {
        const id = pick(windows);
        const app = id === "lt-chat" ? MESSAGES : NOTES;
        const ns = nodes.get(id) as Node[];
        const roll = r();
        if (roll < 0.5 || ns.length === 0) {
          // A full walk: some nodes added, removed or relabelled, every node a new object.
          const next = ns.filter(() => r() > 0.2).map((n) => ({ ...n, ...(r() < 0.3 ? { label: pick(POOL) } : {}), ...(r() < 0.2 ? { value: pick(POOL) } : {}) }));
          for (let k = 0; k < 3; k++) next.push({ key: `${id}/t~${step}-${k}`, parent: null, role: "AXStaticText", label: pick(POOL), ...(r() < 0.2 ? { placeholder: pick(POOL) } : {}) });
          nodes.set(id, next);
          m.apply(snap(next, { at: at++, windowId: id, app, title: r() < 0.2 ? pick(POOL) : id }));
        } else {
          // A partial snapshot of one node, the rest kept as the same objects.
          const target = pick(ns);
          const changed: Node = { ...target, label: pick(POOL) };
          nodes.set(id, ns.map((n) => (n.key === target.key ? changed : n)));
          m.apply(snap([changed], { at: at++, windowId: id, app, root: target.key, title: (m.windows.get(id)?.window.title ?? id) }));
        }
        const w = m.windows.get(id) as WindowState;
        if (r() < 0.7) readWindow(w);
        const states = [...m.windows.values()];
        const texts = Array.from({ length: 6 }, () => ({ from: Math.floor(r() * states.length), t: pick(POOL).replace(/\s+/g, " ").trim() }));
        const incremental = priceAll(states, texts);
        for (const s of states) forgetWindow(scratchId(s.window.windowId));
        const scratch = priceAll(states.map(copy), texts);
        expect(incremental, `seed ${seed} step ${step}`).toEqual({ ...scratch, budgets: unscratch(scratch.budgets), charges: unscratch(scratch.charges) });
      }
    }
  });

  it("answers about an earlier state of a window after a later one, as a task's kept source asks", () => {
    const m = new ScreenModel();
    m.apply(snap([{ key: "a", parent: null, role: "AXStaticText", label: "Dana Whitfield" }], { at: 1, windowId: "lt-kept", app: NOTES }));
    const early = m.windows.get("lt-kept") as WindowState;
    m.apply(snap([{ key: "b", parent: null, role: "AXStaticText", label: "Lumen Labs" }], { at: 2, windowId: "lt-kept", app: NOTES }));
    const late = m.windows.get("lt-kept") as WindowState;
    const other = new ScreenModel();
    other.apply(snap([{ key: "c", parent: null, role: "AXStaticText", label: "Dana Whitfield" }], { at: 3, windowId: "lt-card", app: NOTES }));
    const card = other.windows.get("lt-card") as WindowState;
    // The late state does not show the name; the early one does, and is charged for it.
    const onLate = new Disclosure([late, card]);
    expect(onLate.take(card, "candidate", ["Dana Whitfield"])).toBe(true);
    expect(onLate.charges()).toEqual({ "lt-card": 14 });
    const onEarly = new Disclosure([early, card]);
    expect(onEarly.take(card, "candidate", ["Dana Whitfield"])).toBe(true);
    expect(onEarly.charges()).toEqual({ "lt-card": 14, "lt-kept": 14 });
    // And back again.
    const again = new Disclosure([late, card]);
    expect(again.take(card, "candidate", ["Dana Whitfield"])).toBe(true);
    expect(again.charges()).toEqual({ "lt-card": 14 });
  });
});
