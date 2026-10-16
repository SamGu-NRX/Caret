// B28: the worker's judgement of a Yes/No press after the page may have left. One right answer per case, so each is
// tested alone; the content script's half (beforeunload, pagehide, submit) runs in a real browser in
// fixtures/web-form/accept.ts ("B28 2").
import { describe, expect, it } from "vitest";
import type { ActAnswer } from "../src/shared/messages.ts";
import { judgeActivation, judgePress } from "../src/worker/press-guard.ts";

const still = { navGen: 3, starts: 5 };
const choice = { flavor: "pressGroup" as const, matches: ["Yes"], expanded: null, hiddenInput: "none" as const };
const ok: ActAnswer = { outcome: "ok", detail: null, readings: { sameAsBefore: false, landed: true, equivalent: true, empty: false, typedBetween: false, rev: null }, choice };

describe("judgePress", () => {
  it("lets a press stand when the frame neither moved nor began a navigation, and the page fired nothing", () => {
    expect(judgePress(ok, still, still)).toBe(ok);
  });

  it("fails a press the page showed as taken when the frame's navigation generation moved after it", () => {
    expect(judgePress(ok, still, { ...still, navGen: 4 })).toEqual({ outcome: "failed", detail: "the page changed after the press (navigated), so Caret stopped", choice, pageChanged: ["navigated"] });
  });

  it("fails it when a navigation only began (form.submit() and a location change, before they commit)", () => {
    const r = judgePress(ok, still, { ...still, starts: 6 });
    expect(r.outcome).toBe("failed");
    expect(r.pageChanged).toEqual(["navigationStarted"]);
    // No readings: the helper reads a failed press without them as "may have landed".
    expect(r.readings).toBeUndefined();
  });

  it("fails it when the document went before answering, and keeps what the content script saw", () => {
    expect(judgePress(null, still, still).pageChanged).toEqual(["documentGone"]);
    const seen: ActAnswer = { outcome: "failed", detail: "the page changed after the press (beforeunload)", choice, pageChanged: ["beforeunload", "submit"] };
    expect(judgePress(seen, still, { navGen: 4, starts: 6 }).pageChanged).toEqual(["navigated", "navigationStarted", "beforeunload", "submit"]);
  });

  it("fails an error or a failed press whose frame then moved, since either may have clicked", () => {
    expect(judgePress({ outcome: "error", detail: "the frame gave no answer" }, still, { ...still, starts: 6 }).outcome).toBe("failed");
    expect(judgePress({ outcome: "failed", detail: "the page did not take the press" }, still, { ...still, navGen: 4 }).pageChanged).toEqual(["navigated"]);
  });

  it.each(["alreadyTrue", "stale", "unsupported", "notAllowed", "noElement", "notSameElement", "excluded", "siteOff", "handoff"] as const)("leaves %s alone: the content script answers it before any press", (outcome) => {
    const a: ActAnswer = { outcome, detail: "before the press" };
    expect(judgePress(a, still, { navGen: 4, starts: 6 })).toBe(a);
  });
});

describe("judgeActivation (slice 2)", () => {
  const ok: ActAnswer = { outcome: "ok", detail: null };
  const still = { navGen: 3, starts: 5 };

  it("answers the open as ok when only a history update moved the frame — a fragment jump or pushState is the open's own shape", () => {
    expect(judgeActivation(ok, still, { ...still, navGen: 4 })).toBe(ok);
  });

  it("reports a change when a navigation began, and when the document went away before it answered", () => {
    expect(judgeActivation(ok, still, { ...still, starts: 6 }).pageChanged).toEqual(["navigationStarted"]);
    expect(judgeActivation(null, still, still).pageChanged).toEqual(["documentGone"]);
  });

  it("lets the walk's own standing answers stand, and stops the run on a change like the press does", () => {
    const stale: ActAnswer = { outcome: "stale", detail: "the row left the document" };
    expect(judgeActivation(stale, still, { ...still, starts: 6 })).toBe(stale);
    const judged = judgeActivation(ok, still, { ...still, starts: 6 });
    expect(judged.outcome).toBe("failed");
    expect(judged.detail).toContain("the row was opened");
  });
});
