import * as z from "zod";
import { frozenRequest, sealRequest, type AskJev, type JevRequest, type JevResult } from "../src/fill/jev.ts";
import { assertNoExcludedValue } from "../src/privacy.ts";
import { appendStoredLine, sealedBody } from "../src/privacy/send.ts";
import { checkFixture, refuseShipped, type FixtureSources } from "../src/engines/decide/cache.ts";

export const DECISIONS_MODEL = "gpt-6-luna";
const INPUT_RATE = 0.10 / 1_000_000;

export function decisionsBody(req: JevRequest) {
  const choices = Object.entries(req.questions).map(([name, q]) => ({
    type: "choice" as const, name, instructions: q.instructions,
    choices: Object.entries(q.criteria).map(([value, description]) => ({ value, ...(description === null ? {} : { description }) })),
  }));
  const predicates = Object.entries(req.nouls ?? {}).map(([name, q]) => ({
    type: "predicate" as const, name,
    instructions: q.criteria === undefined ? q.instructions : `${q.instructions}\nYes: ${q.criteria.true}\nNo: ${q.criteria.false}`,
  }));
  return { model: DECISIONS_MODEL, input: JSON.stringify(req.state), questions: [...choices, ...predicates] };
}

/** Reservations never shrink, including after transport failures that might have reached the provider. */
export class RequestBudget {
  private reserved = 0;
  readonly limit: number;
  constructor(limit: number) {
    if (!Number.isFinite(limit) || limit < 0) throw new Error("--spend-limit must be a finite nonnegative dollar amount");
    this.limit = limit;
  }
  estimate(body: string, rate: number): number {
    // Use one token per UTF-8 byte, plus 4,096 for framing. The framing allowance has no live measurement yet.
    const tokens = Buffer.byteLength(body, "utf8") + 4096;
    return tokens * rate * (tokens > 272_000 ? 2 : 1);
  }
  reserve(body: string, rate: number): void {
    const cost = this.estimate(body, rate);
    if (this.reserved + cost > this.limit) throw new Error(`spend limit $${this.limit} would be exceeded; request not sent`);
    this.reserved += cost;
  }
}

const Probability = z.number().finite().min(0).max(1);
const ResponseBody = z.object({
  model: z.literal(DECISIONS_MODEL),
  answers: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("choice"), name: z.string(), choice: z.string(), confidence: Probability, probabilities: z.record(z.string(), Probability) }),
    z.object({ type: z.literal("predicate"), name: z.string(), probability: Probability }),
    z.object({ type: z.literal("refusal"), name: z.string() }),
  ])),
  usage: z.object({ input_tokens: z.number().int().nonnegative() }),
});

interface DecisionsOptions {
  budget: RequestBudget;
  fixture: FixtureSources;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  logRequests?: string;
}

export function decisionsAsk(o: DecisionsOptions): AskJev {
  const env = o.env ?? process.env;
  const f = o.fetchImpl ?? fetch;
  return async (req) => {
    refuseShipped(process.env);
    refuseShipped(env);
    checkFixture(req, o.fixture);
    assertNoExcludedValue(req);
    const sent = sealRequest(req);
    const body = sealedBody(sent.sealed, (wire) => decisionsBody(frozenRequest(req, wire)));
    // This CLI isn't launched by ServiceLauncher, so its key stays out of the production host-env inventory.
    const key = env.OPENAI_API_KEY;
    if (key === undefined || key === "") throw new Error("Decisions key missing: set OPENAI_API_KEY in this script's environment");
    o.budget.reserve(body, INPUT_RATE);
    const started = performance.now();
    let response: unknown;
    try {
      const res = await f("https://api.openai.com/v1/decisions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: sealedBody(sent.sealed, (wire) => decisionsBody(frozenRequest(req, wire))),
      });
      if (!res.ok) throw new Error(`Decisions HTTP ${res.status}`);
      response = await res.json();
      const parsed = ResponseBody.safeParse(response);
      if (!parsed.success) throw new Error("Decisions response has an invalid shape");
      const r = parsed.data;
      const offered = decisionsBody(sent.asked).questions;
      if (r.answers.length !== offered.length) throw new Error("Decisions response has the wrong answer count");
      const answers: JevResult["answers"] = {};
      const nouls: Record<string, number> = {};
      const probabilities: Record<string, Record<string, number>> = {};
      for (const [i, q] of offered.entries()) {
        const a = r.answers[i]!;
        if (a.name !== q.name || a.type !== q.type) throw new Error(`Decisions answer failed for ${q.name}: refusal, type or order`);
        if (a.type === "choice" && q.type === "choice") {
          const options = new Set(q.choices.map((c) => c.value));
          if (!options.has(a.choice) || Object.keys(a.probabilities).some((value) => !options.has(value))) throw new Error(`Decisions answer failed for ${q.name}: unoffered option`);
          answers[q.name] = { choice: a.choice, confidence: a.confidence };
          probabilities[q.name] = a.probabilities;
        } else if (a.type === "predicate") nouls[q.name] = a.probability;
      }
      const latencyMs = performance.now() - started;
      const result = { model: r.model, answers, nouls, probabilities, inputTokens: r.usage.input_tokens, latencyMs, costUsd: r.usage.input_tokens * INPUT_RATE * (r.usage.input_tokens > 272_000 ? 2 : 1) };
      if (o.logRequests !== undefined) appendStoredLine(o.logRequests, sent.sealed, (wire) => ({ body: decisionsBody(frozenRequest(req, wire)), response: r, latencyMs, costUsd: result.costUsd }), { mode: 0o600 });
      return result;
    } catch (e) {
      if (o.logRequests !== undefined) appendStoredLine(o.logRequests, sent.sealed, (wire) => ({ body: decisionsBody(frozenRequest(req, wire)), response, latencyMs: performance.now() - started, error: "Decisions request failed" }), { mode: 0o600 });
      throw e;
    }
  };
}
