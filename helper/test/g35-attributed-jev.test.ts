// The Ask scoreboard's request attribution (scripts/attributed-jev.ts): a request belongs to the Ask that sent it, however
// late its answer, and any HTTP 503 makes that Ask not run, continuations included.
import { describe, expect, it } from "vitest";
import { JevHttpError, type JevRequest, type JevResult } from "../src/fill/jev.ts";
import { attributedJev, httpStatus, type DispatchLine } from "../scripts/attributed-jev.ts";

const req = (purpose: JevRequest["purpose"]): JevRequest => ({ purpose, questions: {} }) as unknown as JevRequest;
const answer: JevResult = { model: "t", answers: {}, inputTokens: 0, latencyMs: 0, costUsd: 0 };

describe("attributedJev", () => {
  it("logs a late answer under the Ask that sent it, not the one the scorer moved to", async () => {
    let current = "b31-07";
    let release: () => void = () => {};
    const lines: DispatchLine[] = [];
    const j = attributedJev(() => new Promise((ok) => (release = () => ok(answer))), () => current, (l) => lines.push(l));
    const pending = j.ask(req("ask.scope"));
    current = "b31-08";
    release();
    await pending;
    expect(lines.map((l) => [l.request, l.ask, l.event])).toEqual([[1, "b31-07", "dispatch"], [1, "b31-07", "answer"]]);
  });

  it("marks an Ask not run on a 503 anywhere, a continuation's or a wrapped one's included, and on nothing else", async () => {
    let current = "b31-03";
    const fail = new Map<string, unknown>([
      ["b31-03", new Error("verify failed", { cause: new JevHttpError(503, "busy") })],
      ["b31-16+pick", new JevHttpError(503, "busy")],
      ["b31-17", new JevHttpError(500, "boom")],
      ["b31-18", new Error("timeout")],
    ]);
    const lines: DispatchLine[] = [];
    const j = attributedJev(async (_, ask) => {
      const e = fail.get(ask);
      if (e !== undefined) throw e;
      return answer;
    }, () => current, (l) => lines.push(l));
    for (const id of ["b31-03", "b31-16", "b31-16+pick", "b31-17", "b31-18", "b31-19"]) {
      current = id;
      await j.ask(req("fill.verify")).catch(() => undefined);
    }
    expect([...j.unavailable].sort()).toEqual(["b31-03", "b31-16"]);
    expect(lines.filter((l) => l.event === "error").map((l) => [l.ask, l.event === "error" ? l.error : ""])).toEqual([["b31-03", "HTTP 503"], ["b31-16+pick", "HTTP 503"], ["b31-17", "HTTP 500"], ["b31-18", "Error"]]);
  });

  it("reads no status from an error with no HTTP answer", () => {
    expect(httpStatus(new Error("x"))).toBeNull();
    expect(httpStatus(new JevHttpError(429, "slow"))).toBe(429);
  });
});
