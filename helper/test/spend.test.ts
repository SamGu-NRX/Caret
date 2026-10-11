// The evaluation scripts' Jev cap (scripts/spend.ts) refuses a request once the spend reached the cap.
import { describe, expect, it } from "vitest";
import { capJev } from "../scripts/spend.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";

const req = {} as JevRequest;

describe("capJev", () => {
  it("sends until the spend reaches the cap, then refuses before sending, and counts only what was sent", async () => {
    let sent = 0;
    const ask: AskJev = async () => (sent++, { model: "m", answers: {}, inputTokens: 1, latencyMs: 1, costUsd: 0.04 });
    const jev = capJev(ask, 0.1);
    for (let i = 0; i < 3; i++) await jev.ask(req);
    await expect(jev.ask(req)).rejects.toThrow("stopped: the live pass reached its $0.1 budget ($0.12000 spent)");
    expect(sent).toBe(3);
    expect(jev.calls()).toBe(3);
    expect(jev.usd()).toBeCloseTo(0.12, 10);
  });

  it("counts nothing for a request that failed", async () => {
    const jev = capJev(async () => {
      throw new Error("HTTP 500");
    }, 0.1);
    await expect(jev.ask(req)).rejects.toThrow("HTTP 500");
    expect([jev.calls(), jev.usd()]).toEqual([0, 0]);
  });
});
