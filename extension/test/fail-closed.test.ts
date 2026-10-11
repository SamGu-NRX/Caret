// Review round 4: the extension fails closed. A shadow root's type history is never known, ancestry follows slots, a
// text input that may replace a removed password is withheld, and an act on a withheld control returns no readings.
// Plain objects stand in for nodes; walker.ts, secret-dom.ts and password-watch.ts apply the same rules to the DOM.
import { describe, expect, it } from "vitest";
import { flatParent, type FlatReader } from "../src/content/shadow.ts";
import { secretWithin, type UpTree } from "../src/content/secret.ts";
import { REPLACE_MS, Replacements, historyKnownFor } from "../src/content/password-watch.ts";
import { receiptFor } from "../src/content/actions.ts";

describe("a root's type history (#1)", () => {
  it("is known only for a document watched from document_start, never for a shadow root", () => {
    expect(historyKnownFor({ shadow: false, fromStart: true })).toBe(true);
    expect(historyKnownFor({ shadow: false, fromStart: false })).toBe(false);
    expect(historyKnownFor({ shadow: true, fromStart: true })).toBe(false);
    expect(historyKnownFor({ shadow: true, fromStart: false })).toBe(false);
  });
});

/** A node of a plain flat tree: an element, a slot or a shadow root. */
interface N {
  name: string;
  parent: N | null;
  host?: N;
  shadow?: N;
  slots?: N[];
  assigned?: N[];
  secret?: boolean;
}
const reader: FlatReader<N> = {
  parentNode: (n) => n.parent,
  hostOf: (n) => n.host ?? null,
  isElement: (n) => n.host === undefined,
  shadowRootOf: (n) => n.shadow ?? null,
  slotsIn: (r) => r.slots ?? [],
  assigned: (s) => s.assigned ?? [],
};
const up: UpTree<N> = {
  parent: (n) => {
    for (let p = flatParent(n, reader); p !== null; p = flatParent(p, reader)) if (reader.isElement(p)) return p;
    return null;
  },
  secret: (n) => n.secret === true,
  field: (n) => n.secret === true,
};

describe("ancestry through slots (#2)", () => {
  it("makes a slotted light-DOM 'Digit 1' input secret inside a shadow textbox 'Verification code'", () => {
    // <otp-box><input name="Digit 1"></otp-box>, whose shadow root holds <div role=textbox aria-label="Verification code"><slot></div>.
    const body: N = { name: "body", parent: null };
    const host: N = { name: "otp-box", parent: body };
    const root: N = { name: "#shadow", parent: null, host };
    const textbox: N = { name: "textbox", parent: root, secret: true };
    const slot: N = { name: "slot", parent: textbox };
    const digit: N = { name: "Digit 1", parent: host };
    host.shadow = root;
    root.slots = [slot];
    slot.assigned = [digit];
    expect(flatParent(digit, reader)).toBe(slot);
    expect(secretWithin(digit, up)).toBe(true);
    // Not assigned to any slot: its parent is the host, as in the light tree, and nothing secret is above it.
    const loose: N = { name: "loose", parent: host };
    expect(secretWithin(loose, up)).toBe(false);
  });
});

describe("a text input that may replace a removed password (#3)", () => {
  it("withholds any text input added in the same root within the window, anonymous or not, before or after the removal", () => {
    let now = 1_000;
    const r = new Replacements<object, object>(() => now);
    const doc = {};
    const other = {};
    const early = {};
    r.added(early, doc);
    now += 100;
    r.removedPassword(doc);
    now += 100;
    const anonymous = {};
    r.added(anonymous, doc);
    const elsewhere = {};
    r.added(elsewhere, other);
    expect(r.ambiguous(early)).toBe(true);
    expect(r.ambiguous(anonymous)).toBe(true);
    expect(r.ambiguous(elsewhere)).toBe(false);
    now += REPLACE_MS + 1;
    const later = {};
    r.added(later, doc);
    expect(r.ambiguous(later)).toBe(false);
    // Once withheld, always withheld: the value it holds may still be the password.
    expect(r.ambiguous(anonymous)).toBe(true);
  });
});

describe("an act's receipt for a withheld control", () => {
  it("carries no readings, and keeps them for a control Caret may read", () => {
    const a = { outcome: "failed" as const, detail: "x", readings: { before: "", afterInput: "swordfish", afterBlur: "swordfish", invalid: false, error: null } };
    expect(receiptFor(a, true)).toEqual({ outcome: "failed", detail: "x" });
    expect(receiptFor(a, false)).toEqual(a);
  });
});
