// W3's pure pieces: which events count as the user's own, the grant table's per-frame view the worker arms and
// disarms frames from, and an undo's `rebind: false` surviving the worker's wire check. The DOM halves run in a real
// browser in fixtures/web-form/accept.ts.
import { describe, expect, it } from "vitest";
import { isUsersOwn } from "../src/shared/input.ts";
import { GrantTable } from "../src/shared/grants.ts";
import { parseFromHelper } from "../src/worker/wire.ts";
import { SELF_IDENTIFICATION } from "../src/content/walker.ts";

describe("the user's own input", () => {
  it("counts only trusted pointer and key presses", () => {
    expect(isUsersOwn({ isTrusted: true, type: "pointerdown" })).toBe(true);
    expect(isUsersOwn({ isTrusted: true, type: "keydown" })).toBe(true);
    // A script's event, Caret's own synthetic presses included, is never trusted.
    expect(isUsersOwn({ isTrusted: false, type: "pointerdown" })).toBe(false);
    expect(isUsersOwn({ isTrusted: false, type: "keydown" })).toBe(false);
    // Focus moves (which el.focus() makes trusted) and releases are not presses.
    for (const type of ["focus", "focusin", "pointerup", "keyup", "click", "input"]) expect(isUsersOwn({ isTrusted: true, type }), type).toBe(false);
  });
});

describe("grants per frame", () => {
  const scope = (tabId: number, frameId: number) => ({ kind: "page", engine: "e", tabId, frameId, origin: "http://127.0.0.1:1", navGen: 1 });

  it("says which tasks cover a frame, and a revoke names the frames it ended", () => {
    let now = 1000;
    const g = new GrantTable({ wall: () => now, mono: () => now });
    expect(g.grant("t1", scope(7, 0), 60_000, "e")).toBeNull();
    expect(g.grant("t1", scope(7, 3), 60_000, "e")).toBeNull();
    expect(g.grant("t2", scope(7, 0), 60_000, "e")).toBeNull();
    expect(g.tasksIn(7, 0).sort()).toEqual(["t1", "t2"]);
    expect(g.covers(7, 3)).toBe(true);
    expect(g.covers(8, 0)).toBe(false);
    expect(g.revoke("t1").sort()).toEqual(["7:0", "7:3"]);
    expect(g.covers(7, 3)).toBe(false);
    expect(g.covers(7, 0)).toBe(true);
    expect(g.revoke("t-none")).toEqual([]);
    // Armed until the last covering grant ends, not the shortest.
    expect(g.grant("t3", scope(7, 0), 30_000, "e")).toBeNull();
    expect(g.coverUntil(7, 0)).toBe(60_000);
    expect(g.coverUntil(9, 9)).toBe(0);
    // An expired grant covers nothing.
    now = 70_000;
    expect(g.covers(7, 0)).toBe(false);
  });
});

describe("an undo's verb on the wire", () => {
  it("keeps rebind: false through the worker's check", () => {
    const verb = { kind: "pageWrite", tabId: 7, frameId: 0, documentId: "D", id: "e1", control: "text", name: "First name", taskId: "t", rebind: false, expect: "Ada", value: "" };
    const m = parseFromHelper({ type: "pageCommand", v: 1, id: "c", expires: 5, verb });
    expect(m?.type === "pageCommand" && m.verb.kind === "pageWrite" && m.verb.rebind).toBe(false);
  });
});

describe("self-identification names (W3 real-site pass)", () => {
  it("leaves out Greenhouse's EEO questions, the LGBTQ+ one included, and keeps ordinary application questions", () => {
    for (const n of ["I consider myself a member of the LGBTQ+ community. (optional)", "Gender*", "Race and Ethnicity*", "Veteran Status*", "Disability Status*", "Are you Hispanic/Latino?*", "Gender Identity (optional)", "Are you non-binary?"]) expect(SELF_IDENTIFICATION.test(n), n).toBe(true);
    for (const n of ["Country*", "Location (City)*", "Are you legally authorized to work in the United States for our Company?*", "LinkedIn Profile", "How did you hear about this job?"]) expect(SELF_IDENTIFICATION.test(n), n).toBe(false);
  });
});
