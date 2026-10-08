import type { LocalCompletion, LocalMemory, LocalRequest } from "../src/writer/local-model.ts";

export const memory = { residentMB: 1, footprintMB: 2, peakFootprintMB: 3, peakResidentMB: 4 } satisfies LocalMemory;
export const request = { id: "r1", prefix: "Synthetic prefix\n", prompt: "Synthetic prompt", grammar: 'root ::= "fixture"', maxTokens: 8 } satisfies LocalRequest & { id: string };
export const ready = { ready: true, model: "fixture.gguf", loadMs: 5, nCtx: 4096, memory };
export const notReady = { ready: false, error: "fixture model not found" };
export const completion = {
  id: "r1", ok: true, text: "fixture", stop: "eog", prefixTokens: 1, prefixCached: false, promptTokens: 2, outputTokens: 3,
  ms: { prefix: 1, prompt: 2, decode: 3, total: 6 }, memory,
} satisfies LocalCompletion;
export const failure = { id: "r1", ok: false, error: "fixture request refused" };
export const failureNull = { id: null, ok: false, error: "fixture invalid request" };
export const examples = { request, ready, notReady, completion, failure, "failure-null": failureNull };
