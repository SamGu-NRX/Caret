// Count repeated ledger work directly; elapsed time depends on the runner's other workloads.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { Disclosure, LedgerRefused } from "../src/privacy/disclosure.ts";
import { UnitIndex } from "../src/privacy/ledger/measure.ts";
import { ledgerNormalizeV1 } from "../src/privacy/ledger/normalize.ts";
import { sourcePieces } from "../src/privacy/ledger/source.ts";
import { snap, text } from "./builders.ts";

// The verifier setup imports Disclosure before this file; reload it so its source reader uses the counter.
vi.hoisted(() => vi.resetModules());
vi.mock("../src/privacy/ledger/source.ts", async (original) => {
  const source = await original<typeof import("../src/privacy/ledger/source.ts")>();
  return { ...source, sourcePieces: vi.fn(source.sourcePieces) };
});

afterEach(() => vi.restoreAllMocks());

describe("repeated immutable ledger inputs", () => {
  it.each([10, 100])("finds the same note's fallback spans once across %i fields", (count) => {
    const note = Array.from({ length: count }, (_, i) => `Q${i + 1}: a${i + 1}`).join("\n");
    const model = new ScreenModel();
    model.apply(snap([text("note", note)], { at: 1, windowId: "note", title: "Notes" }));
    const raw = model.windows.get("note");
    if (raw === undefined) throw new Error("missing note fixture");
    const view = redactWindow(raw);
    const disclosure = new Disclosure(model);
    vi.mocked(sourcePieces).mockClear();
    for (let i = 0; i < count; i++) expect(disclosure.candidate(view, note)).toBe(note);
    // Each mint still checks membership; fallback span lookup and placement each read the note just once.
    expect(sourcePieces).toHaveBeenCalledTimes(count + 2);
    expect(disclosure.charges()).toEqual({ note: note.replaceAll("\n", "").length });
  });

  it("rechecks a cached source against windows that opened after it was minted", () => {
    const phrase = "private phrase";
    const model = new ScreenModel();
    model.apply(snap([text("note", phrase)], { at: 1, windowId: "note", title: "Notes" }));
    const raw = model.windows.get("note");
    if (raw === undefined) throw new Error("missing note fixture");
    const view = redactWindow(raw);
    const disclosure = new Disclosure(model);
    expect(disclosure.candidate(view, phrase)).toBe(phrase);
    model.apply(snap([text("message", phrase), text("other", "x")], { at: 2, windowId: "chat", title: "Dana", app: { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" } }));
    expect(disclosure.candidate(view, phrase)).toBe(phrase);
    // Reusing source spans must not reuse a seal's verdict: the new chat reveals more than half its inventory.
    expect(() => disclosure.measureSent("route.task", [phrase])).toThrow(LedgerRefused);
    expect(disclosure.charges()).toEqual({ note: phrase.length });
  });

  it("finds fallback spans again for a new snapshot of the same window", () => {
    const phrase = "silver lake";
    const model = new ScreenModel();
    model.apply(snap([text("note", phrase)], { at: 1, windowId: "note", title: "Notes" }));
    const disclosure = new Disclosure(model);
    const mint = (): Record<string, number> => {
      const raw = model.windows.get("note");
      if (raw === undefined) throw new Error("missing note fixture");
      expect(disclosure.candidate(redactWindow(raw), phrase)).toBe(phrase);
      return disclosure.measureSent("route.task", [phrase]).charged;
    };
    expect(mint()).toEqual({ note: phrase.length });
    const changed = `prefix ${phrase} suffix`;
    model.apply(snap([text("note", changed)], { at: 2, windowId: "note", title: "Notes" }));
    expect(mint()).toEqual({ note: changed.length, "note@1": phrase.length });
  });

  it("indexes identical normalized units once, including differently spelled copies", () => {
    // SAFETY: UnitIndex defines add(c: number) on its prototype. Expose that private method only to count its real
    // calls, without replacing it or adding a production test seam. Repeated criteria must not create more states.
    const add = vi.spyOn(UnitIndex.prototype as unknown as { add(c: number): void }, "add");
    const one = new UnitIndex([ledgerNormalizeV1("A long common criterion: exact")]);
    const once = add.mock.calls.length;
    add.mockClear();
    const repeated = new UnitIndex(Array.from({ length: 100 }, (_, i) => ledgerNormalizeV1(i % 2 === 0 ? "A long common criterion: exact" : "Ａ LONG COMMON CRITERION: EXACT")));
    expect(add).toHaveBeenCalledTimes(once);
    for (const line of ["exact", "long common criterion", "exacta long", "not in a criterion"]) {
      const scalars = ledgerNormalizeV1(line).cps;
      expect(repeated.scanLine(scalars)).toEqual(one.scanLine(scalars));
    }
  });
});
