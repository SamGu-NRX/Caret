// Value settlement's admission rule, pinned at its boundaries: an Ask's value is admitted only when both value wordings
// choose the same option at its cutoff (FILL_CUTOFF on the implied top probability for a screen value, VALUE_P below;
// MEMORY_CUTOFF on Jev's confidence for the user's own, with
// both whose answers saying the user's at WHOSE_CUTOFF), and a window value for a field that wants the user's details
// only when both owner answers say the user's at WHOSE_CUTOFF. None, a remapped or invalid id, a missing answer and a
// failed call admit nothing, and nothing but an admitted value is minted. Synthetic desk: every value is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { FILL_CUTOFF, FillError, MEMORY_CUTOFF, mintOf, proposeFill, valueSettlementOf, WHOSE_CUTOFF, type FillScope } from "../src/fill/fill.ts";
import { aboutValues } from "../src/fill/about.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import type { FillField } from "../src/protocol.ts";
import { field, snap } from "./builders.ts";
import { isSettlement, optionOutput, splitFirst } from "./vs1-kit.ts";

const T0 = 2_000_000;
const NOTE = ["Signup details for the pottery class", "Name: Odile Ferrant", "Email: odile.f@example.com"].join("\n");
const LABELS = ["Name", "Email", "Phone"] as const;
const ABOUT = aboutValues([{ id: "about-phone", fields: { label: "Phone", value: "555-0412", source: "typed" } }]);

function desk(): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("note/body", NOTE, { role: "AXTextArea" })], { at: T0 - 20_000, windowId: "note", title: "Class signup.txt", focused: true }));
  m.apply(snap(LABELS.map((l, i) => field(`form/${i}`, "", { label: l, frame: [100, 40 + 40 * i, 200, 24] })), { at: T0, windowId: "form", title: "Studio registration", focused: true, focusedKey: "form/0" }));
  return m;
}
const SCOPE: FillScope = { fields: ["form/0", "form/1", "form/2"], windows: null, memory: true, instruction: "fill my name, email and phone from my notes", person: null, literals: new Map() };
const WANT: Record<string, string> = { Name: "Odile Ferrant", Email: "odile.f@example.com", Phone: "555-0412" };

type A = { choice: string; confidence: number };
/** One cell: each wording's value answer for `label` (an output to pick, null for none), and the whose and owner answers. */
interface Cell {
  label: (typeof LABELS)[number];
  /** Each wording's answer: an output (null for none) and a confidence, or with `p`, the implied top probability. */
  values: [[string | null, number], [string | null, number]];
  p?: boolean;
  whose?: [number, number];
  owner?: [number, number];
  /** Rewrites one wording's answer after it is chosen (a remapped, invalid or missing id). */
  tamper?: (wording: 0 | 1, a: A, req: JevRequest) => A | undefined;
  fail?: boolean;
  /** A pick's fresh pair (its request names the picked value): each wording's answer, as `values` gives the first pair's. */
  fresh?: [[string | null, number], [string | null, number]];
}

function jev(c: Cell): AskJev {
  let valueWording = 0;
  return async (req) => {
    if (c.fail === true && req.purpose === "fill.values") throw new Error("HTTP 503 from the provider");
    const w = req.purpose === "fill.values" ? valueWording++ % 2 : 0;
    const answers: Record<string, A> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const ins = String(q.instructions);
      // The whose wordings differ in how they open (fill.ts WHOSE_WORDINGS); the second's owner ids are v1, v2...
      if (id.endsWith("_whose")) answers[id] = { choice: "user", confidence: (c.whose ?? [0.9, 0.9])[ins.startsWith("Field:") ? 1 : 0] ?? 0.9 };
      else if (id.endsWith("_owner")) answers[id] = { choice: "user", confidence: (c.owner ?? [0.9, 0.9])[id.startsWith("v") ? 1 : 0] ?? 0.9 };
      // The base question first: every field goes on to value settlement, where the rule under test runs (splitFirst).
      else if (!isSettlement(q.criteria)) answers[id] = { choice: splitFirst(q.criteria, w as 0 | 1), confidence: 0.99 };
      else {
        const label = LABELS.find((l) => ins.includes(`'${l}'`)) ?? "";
        const pair = c.fresh !== undefined && /Explicit user selections: [^.]*the value "/u.test(ins) ? c.fresh : c.values;
        const [want, given] = label === c.label ? pair[w as 0 | 1] : [WANT[label] ?? null, 0.99];
        const n = Object.keys(q.criteria).length;
        const confidence = label === c.label && c.p === true ? (given - 1 / n) / (1 - 1 / n) : given;
        const hit = Object.entries(q.criteria).find(([, d]) => want !== null && optionOutput(d) === want)?.[0] ?? "none";
        const a = { choice: hit, confidence };
        const t = label === c.label && c.tamper !== undefined ? c.tamper(w as 0 | 1, a, req) : a;
        if (t !== undefined) answers[id] = t;
      }
    }
    return { model: "jev-vs1", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
}

async function settle(c: Cell): Promise<FillField> {
  const p = await proposeFill(desk(), jev(c), "form", "form/0", T0, { about: ABOUT, rand: () => 0, scope: SCOPE });
  const f = p.fields[LABELS.indexOf(c.label)] as FillField;
  // Nothing but an admitted value is minted: a mint exists exactly when the field holds a value.
  expect(mintOf(f) !== undefined, `${c.label}: mint iff value`).toBe(f.value !== null);
  return f;
}
const admitted = async (c: Cell): Promise<boolean> => (await settle(c)).value !== null;

/**
 * Jev's confidence is (p - 1/n)/(1 - 1/n) over the n options it saw, so an Ask's short value questions read lower for
 * the same top probability p; a screen value is admitted on p, both wordings at FILL_CUTOFF. A hundredth either side.
 */
describe("a screen value: both wordings, the same option, each with p at FILL_CUTOFF", () => {
  const v = WANT.Name as string;
  const lo = FILL_CUTOFF - 0.01;
  const hi = FILL_CUTOFF + 0.01;
  it.each([
    [[v, lo], [v, hi], false],
    [[v, hi], [v, lo], false],
    [[v, hi], [v, hi], true],
    [[v, 0.99], [null, 0.99], false],
    [[null, 0.99], [v, 0.99], false],
    [[null, 0.99], [null, 0.99], false],
  ] as const)("p %j / %j -> admitted %s", async (a, b, want) => {
    expect(await admitted({ label: "Name", p: true, values: [a as [string | null, number], b as [string | null, number]] })).toBe(want);
  });

  // Sol review P3: the cutoff itself admits, in both wordings; a hair under it in either does not.
  const under = FILL_CUTOFF - 1e-6;
  it.each([
    [[v, FILL_CUTOFF], [v, FILL_CUTOFF], true],
    [[v, FILL_CUTOFF], [v, under], false],
    [[v, under], [v, FILL_CUTOFF], false],
  ] as const)("at the cutoff: p %j / %j -> admitted %s", async (a, b, want) => {
    expect(await admitted({ label: "Name", p: true, values: [a as [string | null, number], b as [string | null, number]] })).toBe(want);
  });

  // The same boundary for a pick's fresh pair: the first pair splits, the user picks the value, and the fresh pair decides.
  it.each([
    [[v, FILL_CUTOFF], [v, FILL_CUTOFF], true],
    [[v, FILL_CUTOFF], [v, under], false],
    [[v, under], [v, FILL_CUTOFF], false],
  ] as const)("a picked fresh pair at the cutoff: p %j / %j -> admitted %s", async (a, b, want) => {
    const c: Cell = { label: "Name", p: true, values: [[v, 0.99], [null, 0.99]], fresh: [a as [string | null, number], b as [string | null, number]] };
    const m = desk();
    const p = await proposeFill(m, jev(c), "form", "form/0", T0, { about: ABOUT, rand: () => 0, scope: SCOPE });
    const s = valueSettlementOf(p);
    const u = s?.unresolved.find((x) => x.key === "form/0");
    const option = u?.options.find((o) => o.value === v);
    if (s === undefined || option === undefined) throw new Error("Name was not left to a value question");
    const f = await s.settle("form/0", option.id, { model: m, askJev: jev(c) });
    expect(mintOf(f) !== undefined, "mint iff value").toBe(f.value !== null);
    expect(f.value !== null).toBe(want);
  });

  it("admits on p where Jev's confidence alone reads under the cutoff", async () => {
    let confidence = 1;
    const f = await settle({ label: "Name", p: true, values: [[v, hi], [v, hi]], tamper: (_w, a) => ((confidence = Math.min(confidence, a.confidence)), a) });
    expect(confidence).toBeLessThan(FILL_CUTOFF);
    expect(f.value).toBe(v);
  });

  it("two different options disagree at any confidence", async () => {
    const f = await settle({ label: "Name", values: [[v, 0.99], ["Studio registration", 0.99]] });
    expect(f.value).toBeNull();
  });
});

describe("the user's own value: MEMORY_CUTOFF on the value, WHOSE_CUTOFF on both whose answers", () => {
  const v = WANT.Phone as string;
  it.each([
    [MEMORY_CUTOFF - 0.01, MEMORY_CUTOFF, [0.9, 0.9], false],
    [MEMORY_CUTOFF, MEMORY_CUTOFF, [0.9, 0.9], true],
    [MEMORY_CUTOFF, MEMORY_CUTOFF, [WHOSE_CUTOFF - 0.01, WHOSE_CUTOFF], false],
    [MEMORY_CUTOFF, MEMORY_CUTOFF, [WHOSE_CUTOFF, WHOSE_CUTOFF], true],
  ] as const)("values %s / %s, whose %j -> admitted %s", async (a, b, whose, want) => {
    expect(await admitted({ label: "Phone", values: [[v, a], [v, b]], whose: [...whose] as [number, number] })).toBe(want);
  });
});

describe("a window value for a field that wants the user's details: both owner answers the user's at WHOSE_CUTOFF", () => {
  const v = WANT.Email as string;
  it.each([
    [[WHOSE_CUTOFF - 0.01, WHOSE_CUTOFF], false],
    [[WHOSE_CUTOFF, WHOSE_CUTOFF - 0.01], false],
    [[WHOSE_CUTOFF, WHOSE_CUTOFF], true],
  ] as const)("owner %j -> admitted %s", async (owner, want) => {
    expect(await admitted({ label: "Email", values: [[v, 0.99], [v, 0.99]], owner: [...owner] as [number, number] })).toBe(want);
  });
});

describe("no single vote or skipped answer mints", () => {
  const v = WANT.Name as string;
  it("the second wording answering with the first wording's id is not that option", async () => {
    await expect(settle({ label: "Name", values: [[v, 0.99], [v, 0.99]], tamper: (w, a) => (w === 1 ? { ...a, choice: "c1" } : a) })).rejects.toBeInstanceOf(FillError);
  });
  it("an id no option has is refused", async () => {
    await expect(settle({ label: "Name", values: [[v, 0.99], [v, 0.99]], tamper: (w, a) => (w === 0 ? { ...a, choice: "c999" } : a) })).rejects.toBeInstanceOf(FillError);
  });
  it("a missing answer is refused, not read as none", async () => {
    await expect(settle({ label: "Name", values: [[v, 0.99], [v, 0.99]], tamper: (w, a) => (w === 1 ? undefined : a) })).rejects.toBeInstanceOf(FillError);
  });
  it("a failed call proposes nothing", async () => {
    await expect(settle({ label: "Name", values: [[v, 0.99], [v, 0.99]], fail: true })).rejects.toThrow(/503/u);
  });
});
