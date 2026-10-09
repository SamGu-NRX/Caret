// Work a large form's preview repeated, removed without changing an answer: each test holds a shortcut to the answer of
// the work it replaced. Every text is invented.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";
import { FirstLookAllowList, withFirstLookAllowList } from "../src/privacy/first-look-allow-list.ts";
import { spansOf, type ViewSpan } from "../src/privacy.ts";
import { inventoryOf, reveal, spanKey, UnitIndex, UnitProbe } from "../src/privacy/ledger/measure.ts";
import { normalizedUnits } from "../src/privacy/ledger/account.ts";
import { ledgerNormalizeV1 } from "../src/privacy/ledger/normalize.ts";
import { windowProvenance, type DigestMemo } from "../src/fill/contract.ts";
import { snap, text } from "./builders.ts";

afterEach(() => vi.restoreAllMocks());

describe("normalizedUnits", () => {
  it("normalizes each distinct text once and gives repeats that same object", () => {
    const texts = ["Ｑ1: Answer", "Name: Dana", "Ｑ1: Answer", "", "Name: Dana"];
    const got = normalizedUnits(texts);
    if (got === null) throw new Error("refused measurable texts");
    expect(got).toEqual(texts.map(ledgerNormalizeV1));
    expect(got[2]).toBe(got[0]);
    expect(got[4]).toBe(got[1]);
  });

  it("still refuses when only a repeat of a text holds an unpaired surrogate", () => {
    expect(normalizedUnits(["ok", "bad \ud800", "ok", "bad \ud800"])).toBeNull();
  });
});

describe("UnitProbe over repeated units", () => {
  it("reveals what an index of every unit, repeats and all, reveals", () => {
    const lines = ["Ask about the long common criterion here", "short", "exact", "Name: Dana Whitfield", "unrelated text that stays"];
    const inv = inventoryOf(lines);
    const repeated = normalizedUnits(["the long common criterion", "exact", "the long common criterion", "Name: Dana Whitfield", "exact"]);
    if (repeated === null) throw new Error("refused measurable texts");
    expect(new Set(repeated).size).toBe(3);
    expect(new UnitProbe(repeated).reveal(inv)).toEqual(reveal(new UnitIndex(repeated), inv));
    expect(new UnitProbe(repeated).reveal(inv).charged).toBeGreaterThan(0);
  });
});

describe("spansOf", () => {
  it("keeps each view's spans once, by key, in first-seen order", () => {
    const model = new ScreenModel();
    model.apply(snap([text("a", "Name: Dana")], { at: 1, windowId: "a", title: "A" }));
    model.apply(snap([text("b", "Name: Dana")], { at: 1, windowId: "b", title: "B" }));
    const [a, b] = [model.windows.get("a")!, model.windows.get("b")!];
    const at = { part: "n:a:value", start: 0, end: 4 };
    const spans: ViewSpan[] = [{ view: a, text: "Name" }, { view: b, text: "Name" }, { view: a, at }, { view: a, text: "Name" }, { view: a, at: { ...at } }, { view: a, text: "Dana" }];
    const got = spansOf(spans);
    expect([...got.keys()]).toEqual([a, b]);
    expect(got.get(a)!.map(spanKey)).toEqual([spanKey({ text: "Name" }), spanKey({ at }), spanKey({ text: "Dana" })]);
    expect(got.get(b)!.map(spanKey)).toEqual([spanKey({ text: "Name" })]);
  });
});

describe("Disclosure.verify outside a first look", () => {
  const desk = (): { model: ScreenModel; d: Disclosure; body: unknown } => {
    const model = new ScreenModel();
    model.apply(snap([text("name", "Name: Dana"), text("city", "City: Lisbon")], { at: 1, windowId: "note", title: "About me" }));
    const d = new Disclosure(model);
    // Saved values carry no declared span, so a first look reads their Spans from the measured windows (planSpans).
    const name = d.memoryText(null, "Name: Dana")!;
    const city = d.memoryText(null, "City: Lisbon")!;
    const body = { questions: { q1: { instructions: d.t`Saved value: ${name}` }, q2: { instructions: d.t`Saved value: ${city}` } } };
    return { model, d, body };
  };

  it("builds no Spans, and still classifies the measured windows once", () => {
    const { d, body } = desk();
    const spans = vi.spyOn(d, "spansOfText");
    const windows = vi.spyOn(d, "measuredWindows");
    d.verify("fill.values", body);
    expect(spans).not.toHaveBeenCalled();
    // Each saved value's Spans would have measured the windows, which records their classes for the operation.
    expect(windows).toHaveBeenCalledTimes(1);
  });

  it("measures no windows for a body whose texts all have declared spans or none to read", () => {
    const { d } = desk();
    const windows = vi.spyOn(d, "measuredWindows");
    d.verify("fill.values", { questions: { q: { instructions: d.own("Which value goes here?") } } });
    expect(windows).not.toHaveBeenCalled();
  });

  it("builds every text's Spans during a first look", () => {
    const { d, body } = desk();
    const list = new FirstLookAllowList([{ windowId: "note", line: "Name: Dana", at: 0, len: 10 }, { windowId: "note", line: "City: Lisbon", at: 0, len: 12 }]);
    const spans = vi.spyOn(d, "spansOfText");
    withFirstLookAllowList(list, () => d.verify("fill.values", body));
    expect(spans).toHaveBeenCalledTimes(2);
  });
});

describe("windowProvenance with a digest memo", () => {
  const note = "Name: Dana\nCity: Lisbon. Moved there in May.\nNote: Dana prefers email";
  const at = (span: string) => ({ text: span, context: null, source: { windowId: "note", nodeKey: "te/note", appName: "TextEdit", windowTitle: "Notes" } });

  it("gives what it gives without one, taking each text and span's digests once", () => {
    const memo: DigestMemo = new Map();
    for (const span of ["Dana", "Lisbon", "Dana", "Lisbon", "Dana"]) expect(windowProvenance(undefined, at(span), note, memo)).toEqual(windowProvenance(undefined, at(span), note));
    expect(memo.size).toBe(2);
    // The same span in another text is another entry.
    windowProvenance(undefined, at("Dana"), "Name: Dana", memo);
    expect(memo.size).toBe(3);
  });

  it("gives each provenance its own digest lists", () => {
    const memo: DigestMemo = new Map();
    const [a, b] = [windowProvenance(undefined, at("Dana"), note, memo), windowProvenance(undefined, at("Dana"), note, memo)];
    if (a.kind !== "window" || b.kind !== "window") throw new Error("not a window provenance");
    expect(a.lines.length).toBeGreaterThan(0);
    expect(a.lines).not.toBe(b.lines);
    expect(a.sentences).not.toBe(b.sentences);
  });
});
