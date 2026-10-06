// J1 part B: the llama.cpp engine's prompt layout, label reading and confidence, against a stand-in llama-server.
import { describe, expect, it } from "vitest";
import { labelsFor, layout, llamaEngine } from "../src/engines/decide/llama.ts";
import { calibrate, choiceConfidence, noulWithTemperature, withTemperature } from "../src/engines/decide/confidence.ts";
import type { JevRequest } from "../src/fill/jev.ts";

/** A stand-in llama-server: /apply-template wraps the user turn; /completion answers from `dist(prompt)`, by token. */
function server(dist: (prompt: string) => Record<string, number>) {
  const completions: { prompt: string; grammar: string }[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages?: { content: string }[]; prompt?: string; grammar?: string };
    if (url.endsWith("/apply-template")) return new Response(JSON.stringify({ prompt: `<user>${body.messages?.[1]?.content}</user><assistant>` }));
    completions.push({ prompt: body.prompt as string, grammar: body.grammar as string });
    const d = dist(body.prompt as string);
    return new Response(JSON.stringify({ completion_probabilities: [{ top_logprobs: Object.entries(d).map(([token, p]) => ({ token, logprob: Math.log(p) })) }], tokens_evaluated: 10, tokens_cached: 4 }));
  }) as unknown as typeof fetch;
  return { fetchImpl, completions };
}

const REQ: JevRequest = {
  state: { task: "fill" },
  questions: {
    f1: { type: "choice", instructions: "Name?", criteria: { c1: '"Ada"', c2: '"ada@x.com"', none: "No candidate fits." } },
    f2: { type: "choice", instructions: "Email?", criteria: { c1: '"Ada"', c2: '"ada@x.com"', none: "No candidate fits." } },
  },
  nouls: { n1: { type: "noul", instructions: "Is it a form?", criteria: { true: "it is", false: "it is not" } } },
  snippets: [],
  charged: {},
};

describe("the llama.cpp engine", () => {
  it("labels options A to Z, then by fixed-width numbers", () => {
    expect(labelsFor(3)).toEqual(["A", "B", "C"]);
    expect(labelsFor(26).at(-1)).toBe("Z");
    expect(labelsFor(27)[0]).toBe("01");
    expect(labelsFor(27).at(-1)).toBe("27");
    expect(labelsFor(120)[0]).toBe("001");
  });

  it("lists each option once in the prompt prefix, shared by every question", () => {
    const l = layout(REQ);
    expect(l.table.map((o) => o.label)).toEqual(["A", "B", "C"]);
    expect(l.prefix.match(/ada@x\.com/g)).toHaveLength(1);
    expect([...(l.choice.get("f2") ?? new Map())]).toEqual([["A", "c1"], ["B", "c2"], ["C", "none"]]);
  });

  it("reads the split over the allowed labels, normalized, as the answer and Jev's confidence", async () => {
    const s = server((p): Record<string, number> => (p.includes("Name?") ? { A: 0.6, B: 0.2, C: 0.1, The: 0.1 } : p.includes("Email?") ? { B: 0.9, A: 0.05, C: 0.05 } : { A: 0.8, B: 0.2 }));
    const r = await llamaEngine({ url: "http://x", model: "m", prompt: "chat", fetchImpl: s.fetchImpl }).ask(REQ);
    expect(r.answers.f1?.choice).toBe("c1");
    expect(r.probabilities?.f1?.c1).toBeCloseTo(0.6 / 0.9, 9);
    expect(r.answers.f1?.confidence).toBeCloseTo((0.6 / 0.9 - 1 / 3) / (2 / 3), 9);
    expect(r.answers.f2?.choice).toBe("c2");
    expect(r.nouls?.n1).toBeCloseTo(0.8, 9);
    expect(s.completions.every((c) => c.grammar.startsWith("root ::= "))).toBe(true);
    expect(s.completions[0]?.grammar).toBe('root ::= "A" | "B" | "C"');
    expect(r.costUsd).toBe(0);
  });

  it("gives an even split when the labels hold under half of the position's probability", async () => {
    const s = server(() => ({ The: 0.7, A: 0.2, B: 0.1 }));
    const r = await llamaEngine({ url: "http://x", model: "m", prompt: "chat", fetchImpl: s.fetchImpl }).ask({ ...REQ, nouls: undefined });
    expect(r.answers.f1?.confidence).toBe(0);
  });

  it("reads two-digit labels digit by digit", async () => {
    const criteria: Record<string, string> = {};
    for (let i = 1; i <= 30; i++) criteria[`c${i}`] = `"value ${i}"`;
    const req: JevRequest = { state: "s", questions: { f1: { type: "choice", instructions: "Which?", criteria } }, snippets: [], charged: {} };
    // First digit: 1 (0.9) or 2 (0.1); after 1, 2 is 0.5 and 7 is 0.5; 2's branch (0.1) reads on too, as 0.1 >= 0.01.
    const s = server((p): Record<string, number> => (p.endsWith("<assistant>") ? { "1": 0.9, "2": 0.1 } : p.endsWith("<assistant>1") ? { "2": 0.5, "7": 0.5 } : { "0": 1 }));
    const r = await llamaEngine({ url: "http://x", model: "m", prompt: "chat", fetchImpl: s.fetchImpl }).ask(req);
    expect(r.probabilities?.f1?.c12).toBeCloseTo(0.45, 9);
    expect(r.probabilities?.f1?.c17).toBeCloseTo(0.45, 9);
    expect(r.probabilities?.f1?.c20).toBeCloseTo(0.1, 9);
    expect(Object.values(r.probabilities?.f1 ?? {}).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(s.completions[0]?.grammar).toBe('root ::= "0" | "1" | "2" | "3"');
    // 3's branch holds no probability and only "30", so it is not read further; 0's is under EXPAND and shared evenly.
    expect(s.completions).toHaveLength(3);
  });

  it("answers one request at a time, so requests do not push each other's prefix out of the cache", async () => {
    let inFlight = 0;
    let most = 0;
    const base = server(() => ({ A: 1 }));
    const slow = (async (url: string, init: { body: string }) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return base.fetchImpl(url, init as RequestInit);
    }) as unknown as typeof fetch;
    const e = llamaEngine({ url: "http://x", model: "m", prompt: "chat", fetchImpl: slow });
    await Promise.all([e.ask(REQ), e.ask(REQ)]);
    expect(most).toBe(1);
  });
});

describe("confidence as Jev computes it", () => {
  it("is (p_max - 1/n) / (1 - 1/n)", () => {
    expect(choiceConfidence([1, 0, 0])).toBe(1);
    expect(choiceConfidence([1 / 3, 1 / 3, 1 / 3])).toBeCloseTo(0, 12);
    expect(choiceConfidence([0.74, 0.26])).toBeCloseTo(0.48, 12);
    expect(choiceConfidence([0.6, 0.3, 0.1])).toBeCloseTo(0.4, 12);
    expect(choiceConfidence([0.6, 0.2, 0.2])).toBeCloseTo(0.4, 12);
  });

  it("flattens with a temperature above 1 and keeps the order", () => {
    const d = withTemperature({ a: 0.9, b: 0.1 }, 2);
    expect(d.a).toBeCloseTo(0.75, 12);
    expect(noulWithTemperature(0.9, 2)).toBeCloseTo(0.75, 12);
    expect(withTemperature({ a: 0.9, b: 0.1 }, 1).a).toBeCloseTo(0.9, 12);
  });

  it("recomputes every answer from its probabilities, and refuses an answer without them", () => {
    const r = calibrate({ model: "m", answers: { q: { choice: "a", confidence: 0.8 } }, probabilities: { q: { a: 0.9, b: 0.1 } }, nouls: { y: 0.9 }, inputTokens: 0, latencyMs: 0, costUsd: 0 }, { choiceT: 2, noulT: 2 });
    expect(r.answers.q?.confidence).toBeCloseTo(0.5, 12);
    expect(r.nouls?.y).toBeCloseTo(0.75, 12);
    expect(() => calibrate({ model: "m", answers: { q: { choice: "a", confidence: 1 } }, inputTokens: 0, latencyMs: 0, costUsd: 0 }, { choiceT: 1, noulT: 1 })).toThrow(/without the probabilities/);
  });
});
