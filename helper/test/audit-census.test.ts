// The structure census counts control buttons, indicators and text-marker hits by place, with no window text.
import { describe, expect, it } from "vitest";
import { Census, classifyButton, zoneOf } from "../src/audit-census.ts";
import { ScreenModel } from "../src/model.ts";
import { field, node, snap, text } from "./builders.ts";
import { renderCensus } from "../src/audit-report.ts";

describe("census", () => {
  it("classifies button labels by their first word and qualifier", () => {
    expect(classifyButton("Stop generating")).toEqual({ word: "stop", qualifier: "generating", words: "2" });
    expect(classifyButton("Stop")).toEqual({ word: "stop", qualifier: "(none)", words: "1" });
    expect(classifyButton("Send message to Priya")).toEqual({ word: "send", qualifier: "message", words: "3+" });
    expect(classifyButton("Stopwatch")).toBeNull();
    expect(classifyButton(undefined)).toBeNull();
  });

  it("puts a node in the sidebar, the bottom band or the main area", () => {
    const win: [number, number, number, number] = [0, 0, 1000, 800];
    expect(zoneOf([10, 100, 200, 20], win)).toBe("left");
    expect(zoneOf([400, 700, 200, 40], win)).toBe("bottom");
    expect(zoneOf([400, 100, 200, 20], win)).toBe("main");
    expect(zoneOf(undefined, win)).toBe("noFrame");
  });

  it("counts a stop button by the composer and a sidebar status word, and times them", () => {
    const model = new ScreenModel();
    const census = new Census();
    const K = (s: string): string => `dev.caret.agent/standard/${s}`;
    const nodes = (stop: boolean) => [
      node(K("row~0"), "AXRow", { label: "Thread one", frame: [0, 100, 250, 30] }),
      text(K("statictext:working~0"), "Working", [180, 105, 60, 20], K("row~0")),
      field(K("textarea~0"), "", { role: "AXTextArea", frame: [300, 650, 600, 80] }),
      node(K(stop ? "button:stop~0" : "button:send~0"), "AXButton", { label: stop ? "Stop" : "Send", frame: [860, 690, 30, 30] }),
    ];
    for (const [at, stop] of [[1000, true], [20_000, true], [40_000, false]] as const) {
      model.apply(snap(nodes(stop), { at, windowId: "9-1", app: { pid: 9, bundleId: "dev.caret.agent", name: "Agent" } }));
      census.observe(model.windows.get("9-1")!, at);
    }
    // The window frame from the builder is [0, 0, 800, 600]; the composer at y 650 is below 60% of it.
    const a = census.summary()["dev.caret.agent"]!;
    expect(a).toMatchObject({ snapshots: 3, windows: 1, withComposer: 3 });
    expect(a.buttons.stop).toMatchObject({ snapshots: 2, buttons: 2, nearComposer: 2, spans: { under30s: 1 } });
    expect(a.buttons.send).toMatchObject({ snapshots: 1, nearComposer: 1, spans: { once: 1 } });
    expect(a.textHits.statusWord).toMatchObject({ lines: 3, snapshots: 3, byWord: { working: 3 }, byParentRole: { AXRow: 3 }, zone: { left: 3 }, inControlOrRow: 3, spans: { under2m: 1 } });
    expect(a.stopVsStatusWord).toEqual({ both: 2, stopOnly: 0, statusWordOnly: 1, neither: 0 });
    const json = JSON.stringify(census.summary());
    for (const t of ["Thread one", "Working"]) expect(json).not.toContain(t);
    const md = renderCensus({ startedAt: 0, updatedAt: 60_000, census: census.summary() });
    expect(md).toContain("| dev.caret.agent | stop | 2 of 3 | 2 | 2 | 0 | 0 | (none) 2 | 0 of 1 |");
    expect(md).toContain("| dev.caret.agent | statusWord | 3 | 3 | 3 | 0 | AXRow 3 | working 3 | 0 of 1 |");
    for (const t of ["Thread one", "Working"]) expect(md).not.toContain(t);
  });
});
