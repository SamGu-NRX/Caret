// H13: typing in the focused field is reported, so the helper walks it and the host's inline text follows the text
// around the caret (content/own-acts.ts). One report per short burst; none while Caret's own act writes the field, and
// one once it ends.
import { describe, expect, it } from "vitest";
import { FOCUS_EVERY_MS, FocusReporter, TYPED_EVERY_MS } from "../src/content/own-acts.ts";

function rig(front = true) {
  const timers: { f: () => void; ms: number }[] = [];
  let reports = 0;
  const r = new FocusReporter({ inFront: () => front, later: (f, ms) => void timers.push({ f, ms }), report: () => void reports++ });
  const tick = (): void => {
    for (const t of timers.splice(0)) t.f();
  };
  return { r, tick, reports: () => reports, timers, setFront: (v: boolean) => void (front = v) };
}

describe("typing reports", () => {
  it("reports a burst of typing once, TYPED_EVERY_MS after it starts, sooner than a focus report", () => {
    const { r, tick, reports, timers } = rig();
    r.typed();
    r.typed();
    r.typed();
    expect(timers.map((t) => t.ms)).toEqual([TYPED_EVERY_MS]);
    expect(TYPED_EVERY_MS).toBeLessThan(FOCUS_EVERY_MS);
    tick();
    expect(reports()).toBe(1);
    r.typed();
    tick();
    expect(reports()).toBe(2);
  });

  it("holds a report while Caret's act writes the field, and sends one when it ends", () => {
    const { r, tick, reports, timers } = rig();
    r.actStarted();
    r.typed();
    expect(timers).toEqual([]);
    r.actEnded();
    tick();
    expect(reports()).toBe(1);
  });

  it("reports nothing for a page in the background", () => {
    const { r, tick, reports, setFront } = rig(false);
    r.typed();
    tick();
    expect(reports()).toBe(0);
    setFront(true);
    r.typed();
    setFront(false);
    tick();
    expect(reports()).toBe(0);
  });
});
