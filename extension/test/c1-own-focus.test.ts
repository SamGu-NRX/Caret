// C1: a focus change Caret's own act makes is not reported, so the helper asks no Fill all on a form Caret is filling;
// the user's own focus still is (content/own-acts.ts).
import { describe, expect, it } from "vitest";
import { FOCUS_EVERY_MS, FocusReporter } from "../src/content/own-acts.ts";

function rig(front = true) {
  const timers: { f: () => void; ms: number }[] = [];
  let reports = 0;
  const r = new FocusReporter({ inFront: () => front, later: (f, ms) => void timers.push({ f, ms }), report: () => void reports++ });
  const tick = (): void => {
    for (const t of timers.splice(0)) t.f();
  };
  return { r, tick, reports: () => reports, timers, setFront: (v: boolean) => void (front = v) };
}

describe("focus reports", () => {
  it("reports the user's focus once per burst, after FOCUS_EVERY_MS", () => {
    const { r, tick, reports, timers } = rig();
    r.focusIn();
    r.focusIn();
    expect(timers.map((t) => t.ms)).toEqual([FOCUS_EVERY_MS]);
    tick();
    expect(reports()).toBe(1);
    r.focusIn();
    tick();
    expect(reports()).toBe(2);
  });

  it("reports nothing for a focus change made while Caret's act runs", () => {
    const { r, tick, reports, timers } = rig();
    r.actStarted();
    r.focusIn();
    r.focusIn();
    expect(timers).toEqual([]);
    r.actEnded();
    tick();
    expect(reports()).toBe(0);
  });

  it("still reports the user's focus right after an act, and one armed before an act started", () => {
    const { r, tick, reports } = rig();
    r.actStarted();
    r.actEnded();
    r.focusIn();
    tick();
    expect(reports()).toBe(1);
    r.focusIn();
    r.actStarted();
    tick();
    r.actEnded();
    expect(reports()).toBe(2);
  });

  it("counts overlapping acts, and reports nothing for a document not in front", () => {
    const { r, tick, reports, setFront } = rig();
    r.actStarted();
    r.actStarted();
    r.actEnded();
    r.focusIn();
    tick();
    expect(reports()).toBe(0);
    r.actEnded();
    setFront(false);
    r.focusIn();
    tick();
    expect(reports()).toBe(0);
  });
});
