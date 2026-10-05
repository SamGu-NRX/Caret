// The independent corpus (corpus.json): cases written from action-engine plan section 4 by an agent that
// never saw the resolver, with expected instants and decimals computed outside it. Every exact case must
// resolve to exactly its value; every ambiguous case must ask or refuse as the case says.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ValueResolver, type Resolution, type ResolveContext } from "../../src/values/resolve.ts";
import type { Interval, Moment } from "../../src/values/date-time.ts";
import type { Decimal } from "../../src/values/decimal.ts";
import type { Quantity } from "../../src/values/units.ts";
import { decimalString } from "../../src/values/decimal.ts";

type Expect = { kind: "resolved"; value: unknown } | { kind: "ask"; alternatives?: unknown[] } | { kind: "unsupported" } | { kind: "ask_or_unsupported" };
interface Case {
  id: string;
  category: "date" | "zone" | "relative" | "number" | "unit";
  op: "date" | "moment" | "interval" | "number" | "identifier" | "convert";
  input: string;
  to?: string;
  precision?: number;
  context?: Partial<ResolveContext>;
  expect: Expect;
  why: string;
}
const CORPUS = JSON.parse(readFileSync(fileURLToPath(new URL("./corpus.json", import.meta.url)), "utf8")) as { defaults: { context: ResolveContext }; cases: Case[] };

const resolver = new ValueResolver();

function run(c: Case): Resolution<unknown> {
  const ctx = { ...CORPUS.defaults.context, ...c.context } as ResolveContext;
  switch (c.op) {
    case "date":
      return resolver.date(c.input, ctx);
    case "moment":
      return resolver.moment(c.input, ctx);
    case "interval":
      return resolver.interval(c.input, ctx);
    case "number":
      return resolver.number(c.input, ctx);
    case "identifier":
      return resolver.identifier(c.input);
    case "convert":
      return resolver.convert(c.input, c.to as string, ctx, c.precision);
  }
}

/** The resolver's value in the corpus's shape, keeping only the keys the expectation states. */
function shape(op: Case["op"], v: unknown, want: unknown): unknown {
  const keep = (o: Record<string, unknown>): Record<string, unknown> => (typeof want === "object" && want !== null ? Object.fromEntries(Object.keys(want).map((k) => [k, o[k]])) : o);
  switch (op) {
    case "date":
    case "identifier":
      return v;
    case "moment":
      return keep({ instant: (v as Moment).instant, zone: (v as Moment).zone });
    case "interval":
      return { start: (v as Interval).start.instant, end: (v as Interval).end?.instant ?? null };
    case "number":
      return { coefficient: (v as Decimal).coefficient.toString(), scale: (v as Decimal).scale };
    case "convert":
      return { value: decimalString((v as Quantity).value), unit: (v as Quantity).unit };
  }
}

/** Whether a case passed, and what the resolver said. */
function check(c: Case): { pass: boolean; got: unknown } {
  const r = run(c);
  const got = r.kind === "resolved" ? { kind: r.kind, value: shape(c.op, r.value, c.expect.kind === "resolved" ? c.expect.value : undefined) } : r.kind === "ask" ? { kind: r.kind, question: r.question, alternatives: r.alternatives.map((a) => shape(c.op, a, undefined)) } : r;
  const e = c.expect;
  switch (e.kind) {
    case "resolved":
      return { pass: r.kind === "resolved" && JSON.stringify(shape(c.op, r.value, e.value)) === JSON.stringify(e.value), got };
    case "unsupported":
      return { pass: r.kind === "unsupported", got };
    case "ask_or_unsupported":
      return { pass: r.kind === "ask" || r.kind === "unsupported", got };
    case "ask": {
      if (r.kind !== "ask") return { pass: false, got };
      if (e.alternatives === undefined) return { pass: true, got };
      const mine = r.alternatives.map((a, k) => JSON.stringify(shape(c.op, a, e.alternatives?.[k] ?? e.alternatives?.[0]))).sort();
      const theirs = e.alternatives.map((a) => JSON.stringify(a)).sort();
      return { pass: JSON.stringify(mine) === JSON.stringify(theirs), got };
    }
  }
}

describe("the independent value corpus", () => {
  it("has at least the cases section 4 asks for in each category", () => {
    const count = (cat: Case["category"]) => CORPUS.cases.filter((c) => c.category === cat).length;
    expect(count("date")).toBeGreaterThanOrEqual(20);
    expect(count("zone")).toBeGreaterThanOrEqual(20);
    expect(count("relative")).toBeGreaterThanOrEqual(12);
    expect(count("number")).toBeGreaterThanOrEqual(16);
    expect(count("unit")).toBeGreaterThanOrEqual(12);
    expect(new Set(CORPUS.cases.map((c) => c.id)).size).toBe(CORPUS.cases.length);
  });

  for (const c of CORPUS.cases) {
    it(`${c.id}: ${c.op} ${JSON.stringify(c.input)}${c.to === undefined ? "" : ` to ${c.to}`} (${c.why})`, () => {
      const { pass, got } = check(c);
      expect(pass, JSON.stringify({ expected: c.expect, got })).toBe(true);
    });
  }

  it("asks or refuses in every case the corpus marks ambiguous, and resolves every exact one", () => {
    const rows = new Map<string, { exact: number; exactPass: number; ambiguous: number; ambiguousPass: number }>();
    for (const c of CORPUS.cases) {
      const row = rows.get(c.category) ?? { exact: 0, exactPass: 0, ambiguous: 0, ambiguousPass: 0 };
      const { pass } = check(c);
      if (c.expect.kind === "resolved") {
        row.exact++;
        if (pass) row.exactPass++;
      } else {
        row.ambiguous++;
        if (pass) row.ambiguousPass++;
      }
      rows.set(c.category, row);
    }
    console.info(`corpus results by category:\n${[...rows].map(([k, r]) => `  ${k}: exact ${r.exactPass}/${r.exact}, ask or refuse ${r.ambiguousPass}/${r.ambiguous}`).join("\n")}`);
    for (const r of rows.values()) {
      expect(r.exactPass).toBe(r.exact);
      expect(r.ambiguousPass).toBe(r.ambiguous);
    }
  });
});
