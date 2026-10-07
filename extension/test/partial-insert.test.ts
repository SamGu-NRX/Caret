// S2: a page insert whose read-back did not confirm it, judged by S1's ruling (content/partial-insert.ts). The DOM side
// (insert.ts domField) needs a browser; here the field is a string, so every branch and the property run exactly.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ActAnswer } from "../src/shared/messages.ts";
import { classifyInsert, type InsertedField, type InsertIntent, type InsertState, recoverInsert, textControlField } from "../src/content/partial-insert.ts";

interface Row {
  name: string;
  before: string;
  start: number;
  end: number;
  replacement: string;
  held: string;
  state: "original" | "whole" | "partial" | "unrecognized";
  inserted?: number;
}
const table = JSON.parse(readFileSync(new URL("../../apps/caret/Tests/CaretHostCoreTests/Fixtures/unconfirmed-inserts.json", import.meta.url), "utf8")) as { cases: Row[] };

const expected = (r: Row): InsertState => (r.state === "partial" ? { kind: "partial", inserted: r.inserted ?? -1 } : { kind: r.state });

/**
 * A field as a string with a selection; counts every edit, so a test can say nothing was written. It selects as the
 * editor adapter does (insert.ts domField): a range only by extending from a caret collapsed at its end, so a collapsed
 * "selection" of anything but the current caret fails.
 */
class Field implements InsertedField {
  sel: [number, number];
  deletes = 0;
  unreadable = false;
  block: string | null = null;
  refuseSelect = false;
  /** Runs inside the gate, as page script or the user's typing would while the act awaits the worker. */
  duringGate: (() => void) | null = null;
  /** The page's reaction to the delete (a handler that adds text back). */
  afterDelete: ((f: Field) => void) | null = null;

  text: string;

  constructor(text: string, caret = text.length) {
    this.text = text;
    this.sel = [caret, caret];
  }
  read(): string | null {
    return this.unreadable ? null : this.text;
  }
  blocked(): string | null {
    return this.block;
  }
  select(start: number, end: number): boolean {
    if (this.refuseSelect || start < 0 || end > this.text.length) return false;
    if (this.sel[0] !== this.sel[1] || this.sel[1] !== end) return false;
    this.sel = [start, end];
    return true;
  }
  saveSelection(): () => void {
    const saved: [number, number] = [this.sel[0], this.sel[1]];
    return () => void (this.sel = saved);
  }
  selected(): string | null {
    return this.text.slice(this.sel[0], this.sel[1]);
  }
  deleteSelection(): void {
    this.deletes++;
    this.text = this.text.slice(0, this.sel[0]) + this.text.slice(this.sel[1]);
    this.sel = [this.sel[0], this.sel[0]];
    this.afterDelete?.(this);
  }
  async settle(): Promise<void> {}
}

const open = (f: Field) => async (): Promise<ActAnswer | null> => {
  f.duringGate?.();
  return null;
};

describe("S1's ruling for a page insert", () => {
  it("classifies the shared table as the host does", () => {
    expect(table.cases.length).toBeGreaterThan(15);
    for (const r of table.cases) {
      expect(classifyInsert({ before: r.before, start: r.start, end: r.end, text: r.replacement }, r.held), r.name).toEqual(expected(r));
    }
  });

  it("runs the shared table through recovery: only a partial row is edited, and it goes back to exactly the original", async () => {
    for (const r of table.cases) {
      // The caret where an insert at the caret leaves it: after the characters that went in.
      const f = new Field(r.held, r.start + (r.inserted ?? 0));
      const a = await recoverInsert(f, { before: r.before, start: r.start, end: r.end, text: r.replacement }, open(f));
      expect(a.outcome, r.name).toBe("failed");
      // A page insert goes in at a caret; a partial over a replaced range is left (the host's ⌘Z puts such text back).
      if (r.state === "partial" && r.start === r.end) {
        expect(f.text, r.name).toBe(r.before);
        expect(f.deletes, r.name).toBe(1);
        expect(a.insert, r.name).toBe("unchanged");
      } else {
        expect(f.text, r.name).toBe(r.held);
        expect(f.deletes, r.name).toBe(0);
        expect(a.insert, r.name).toBe(r.state === "original" ? "unchanged" : "unverified");
      }
    }
    expect(table.cases.some((r) => r.state === "partial" && r.start !== r.end)).toBe(true);
  });
});

describe("a partial insert at the caret", () => {
  const intent: InsertIntent = { before: "Dear Sam, see you", start: 9, end: 9, text: " thanks" };

  it("is taken out for every k a maxlength or page handler could have cut it at, and the answer records the part", async () => {
    for (let k = 1; k < intent.text.length; k++) {
      const held = `Dear Sam,${intent.text.slice(0, k)} see you`;
      const f = new Field(held, 9 + k);
      const a = await recoverInsert(f, intent, open(f));
      expect(f.text).toBe(intent.before);
      expect(a).toEqual({ outcome: "failed", detail: `only ${k} of 7 characters of the insert went in, so Caret took them out; the field reads as it did before the insert`, insert: "unchanged" });
    }
  });

  it("is left, and the page's Undo named, when the grant ended before Caret could take it out", async () => {
    const f = new Field("Dear Sam, th see you", 12);
    const a = await recoverInsert(f, intent, async () => ({ outcome: "notAllowed", detail: "the task's grant ended (before Caret took out the part of its text that went in)" }));
    expect(f.text).toBe("Dear Sam, th see you");
    expect(f.deletes).toBe(0);
    expect(a.insert).toBe("unverified");
    expect(a.detail).toBe("only 3 of 7 characters of the insert went in, and Caret could not take them out: the task's grant ended (before Caret took out the part of its text that went in); the page's Undo takes them back");
  });

  it("is left when focus went or an input method started composing", async () => {
    const f = new Field("Dear Sam, th see you", 12);
    f.block = "the field no longer has focus";
    const a = await recoverInsert(f, intent, open(f));
    expect(f.deletes).toBe(0);
    expect(a.detail).toContain("the field no longer has focus");
  });

  it("is left when the user typed while Caret checked its grant", async () => {
    const f = new Field("Dear Sam, th see you", 12);
    f.duringGate = () => void (f.text = "Dear Sam, thx see you");
    const a = await recoverInsert(f, intent, open(f));
    expect(f.text).toBe("Dear Sam, thx see you");
    expect(f.deletes).toBe(0);
    expect(a.detail).toBe("only 3 of 7 characters of the insert went in, and the field changed while Caret checked its grant; Caret left it as it is");
  });

  it("is left, with the caret back after it, when only Caret's characters cannot be selected", async () => {
    const f = new Field("Dear Sam, th see you", 12);
    f.refuseSelect = true;
    const a = await recoverInsert(f, intent, open(f));
    expect(f.deletes).toBe(0);
    expect(a.insert).toBe("unverified");
    expect(f.sel).toEqual([12, 12]);
    // The first, non-empty selection takes one character too many (the user's ","): refused, and the caret goes back
    // exactly where the insert left it, collapsed (S2 review).
    const g = new Field("Dear Sam, th see you", 12);
    const select = g.select.bind(g);
    let first = true;
    g.select = (s, e) => {
      if (!first || s === e) return select(s, e);
      first = false;
      g.sel = [s - 1, e];
      return true;
    };
    const b = await recoverInsert(g, intent, open(g));
    expect(g.deletes).toBe(0);
    expect(g.text).toBe("Dear Sam, th see you");
    expect(b.insert).toBe("unverified");
    expect(g.sel).toEqual([12, 12]);
  });

  it("restores a text control's own caret through the real adapter when it cannot select", async () => {
    // textControlField is what insert.ts uses for an input or a textarea; this control throws on its first selection
    // request (an input type with no selection API) and must end with the caret where the insert left it.
    const control = {
      value: "Dear Sam, th see you",
      selectionStart: 12 as number | null,
      selectionEnd: 12 as number | null,
      calls: 0,
      setSelectionRange(start: number, end: number): void {
        this.calls++;
        if (this.calls === 1) {
          this.selectionStart = start;
          throw new Error("InvalidStateError");
        }
        this.selectionStart = start;
        this.selectionEnd = end;
      },
    };
    let deletes = 0;
    const field = textControlField(control, { blocked: () => null, deleteSelection: () => void deletes++, settle: async () => {} });
    const a = await recoverInsert(field, intent, async () => null);
    expect(deletes).toBe(0);
    expect(a.insert).toBe("unverified");
    expect([control.selectionStart, control.selectionEnd]).toEqual([12, 12]);
  });

  it("takes the characters out through the real text control adapter", async () => {
    const control = {
      value: "Dear Sam, th see you",
      selectionStart: 12 as number | null,
      selectionEnd: 12 as number | null,
      setSelectionRange(start: number, end: number): void {
        this.selectionStart = start;
        this.selectionEnd = end;
      },
    };
    const field = textControlField(control, {
      blocked: () => null,
      deleteSelection: () => {
        const s = control.selectionStart ?? 0;
        control.value = control.value.slice(0, s) + control.value.slice(control.selectionEnd ?? s);
        control.selectionEnd = s;
      },
      settle: async () => {},
    });
    const a = await recoverInsert(field, intent, async () => null);
    expect(a.insert).toBe("unchanged");
    expect(control.value).toBe(intent.before);
    expect([control.selectionStart, control.selectionEnd]).toEqual([9, 9]);
  });

  it("says so when the page changed the field again after Caret took its characters out", async () => {
    const f = new Field("Dear Sam, th see you", 12);
    f.afterDelete = (x) => void (x.text += "!");
    const a = await recoverInsert(f, intent, open(f));
    expect(a).toEqual({ outcome: "failed", detail: "only 3 of 7 characters of the insert went in; Caret took them out, but the field then read otherwise, so Caret left it as it is", insert: "unverified" });
  });

  it("names an unreadable field and the whole insert without touching either", async () => {
    const f = new Field("x");
    f.unreadable = true;
    expect((await recoverInsert(f, intent, open(f))).detail).toBe("Caret could not read the field after the insert, so it left it as it is");
    const whole = new Field("Dear Sam, thanks see you", 0);
    const a = await recoverInsert(whole, intent, open(whole));
    expect(a).toEqual({ outcome: "failed", detail: "the text went in whole, but the caret is not right after it; the page's Undo takes it back", insert: "unverified" });
    expect(whole.deletes).toBe(0);
  });
});

describe("property: no unrecognized field is ever changed", () => {
  /** mulberry32, seeded, so a failure names a reproducible case. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The ruling by brute force over every prefix length. */
  function oracle(i: InsertIntent, held: string): InsertState["kind"] {
    if (held === i.before) return "original";
    const head = i.before.slice(0, i.start);
    const tail = i.before.slice(i.end);
    if (held === head + i.text + tail) return "whole";
    for (let k = 1; k < i.text.length; k++) if (held === head + i.text.slice(0, k) + tail) return "partial";
    return "unrecognized";
  }

  it("agrees with the oracle and edits only recognized partial inserts, back to the original", async () => {
    const r = rng(20261007);
    const alphabet = ["a", "b", " ", "é", "\n", " ", "ab"];
    const pick = (): string => alphabet[Math.floor(r() * alphabet.length)] ?? "a";
    const text = (max: number): string => Array.from({ length: Math.floor(r() * (max + 1)) }, pick).join("");
    const mutate = (s: string): string => {
      const at = Math.floor(r() * (s.length + 1));
      const op = Math.floor(r() * 3);
      if (op === 0) return s.slice(0, at) + pick() + s.slice(at);
      if (op === 1 && s.length > 0) return s.slice(0, Math.min(at, s.length - 1)) + s.slice(Math.min(at, s.length - 1) + 1);
      return s.length === 0 ? "z" : `${s.slice(0, Math.min(at, s.length - 1))}z${s.slice(Math.min(at, s.length - 1) + 1)}`;
    };
    const counts: Record<string, number> = {};
    for (let n = 0; n < 4000; n++) {
      const before = text(6);
      const start = Math.floor(r() * (before.length + 1));
      const intent: InsertIntent = { before, start, end: start, text: text(5) };
      const k = Math.floor(r() * (intent.text.length + 1));
      const recognized = before.slice(0, start) + intent.text.slice(0, k) + before.slice(start);
      for (const held of [recognized, mutate(recognized), mutate(before), text(8), before]) {
        const state = classifyInsert(intent, held);
        expect(state.kind, JSON.stringify({ intent, held })).toBe(oracle(intent, held));
        counts[state.kind] = (counts[state.kind] ?? 0) + 1;
        const f = new Field(held, start + (state.kind === "partial" ? state.inserted : 0));
        await recoverInsert(f, intent, open(f));
        if (state.kind === "partial") {
          expect(f.text, JSON.stringify({ intent, held })).toBe(before);
        } else {
          expect(f.deletes, JSON.stringify({ intent, held })).toBe(0);
          expect(f.text).toBe(held);
        }
      }
    }
    for (const kind of ["original", "whole", "partial", "unrecognized"]) expect(counts[kind] ?? 0, kind).toBeGreaterThan(100);
  });
});
