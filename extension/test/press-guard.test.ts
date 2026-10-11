// B28: the worker's judgement of a Yes/No press after the page may have left. One right answer per case, so each is
// tested alone; the content script's half (beforeunload, pagehide, submit) runs in a real browser in
// fixtures/web-form/accept.ts ("B28 2").
import { describe, expect, it } from "vitest";
import type { ActAnswer } from "../src/shared/messages.ts";
import { judgePress } from "../src/worker/press-guard.ts";

const still = { navGen: 3, starts: 5 };
const choice = { flavor: "pressGroup" as const, matches: ["Yes"], expanded: null, hiddenInput: "none" as const };
const ok: ActAnswer = { outcome: "ok", detail: null, readings: { before: "", afterInput: "Yes", afterBlur: "Yes", invalid: false, error: null }, choice };

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
