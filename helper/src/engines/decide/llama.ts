import { assertNoExcludedValue } from "../../privacy.ts";
import { UnmintedText } from "../../privacy/disclosure.ts";
import { seal, sealedBody, type Sealed } from "../../privacy/send.ts";
// A decision engine on this Mac: an open instruct model in llama-server (llama.cpp), J1 part B.
//
// Each request becomes one prompt prefix, the state and every option once with a label, and then one short question
// per choice or yes/no question, so llama-server's prompt cache evaluates the prefix once per request. The answer is
// the label the model would write first; its probability for every allowed label is read from the completion's token
// probabilities and normalized over those labels (confidence.ts turns them into Jev's confidence). A grammar allows
// only the question's labels. Labels are A to Z for up to 26 options, else fixed-width numbers ("01" to "47"), read
// digit by digit, since the tokenizers of the models screened here split numbers into digits.
//
// A yes/no question is a choice of two labels, A for yes and B for no; its answer is the probability of A.
import { frozenRequest, wireBody, type AskJev, type ChoiceQuestion, type JevRequest, type JevResult, type NoulQuestion } from "../../fill/jev.ts";
import type { DecideEngine } from "./port.ts";

export interface LlamaOptions {
  /** llama-server's address, such as http://127.0.0.1:8091. */
  url: string;
  /** The model's name for reports and cache keys. */
  model: string;
  /**
   * How the prompt is framed: `chat` through the model's chat template (llama-server /apply-template); `document` for a
   * base model with no instruction tuning, such as Cotypist's Gemma E2B, as a plain document ending in "Answer:".
   */
  prompt: "chat" | "document";
  /** Variables for the chat template, such as { enable_thinking: false } for a model that thinks unless told not to. */
  templateKwargs?: Record<string, unknown>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Token probabilities read per position; a label's token past these is counted as having none. */
const N_PROBS = 100;
/**
 * The least share of the model's probability its labels together must hold for their split to be read. Below it the
 * model wanted to write something else, so its split over the labels says little, and the answer is an even split
 * (confidence 0). Assumed, not measured; 0.5 until the review, which showed a yes of 0.5 against a no of 0.001
 * passing a 0.95 floor.
 */
const MIN_LABEL_MASS = 0.9;
/** How this file reads probabilities: part of the replay cache's key, so answers read the old way are not replayed. */
export const LLAMA_READING = "joint-v2";
/** A first digit at least this likely is read further; the rest share their probability evenly. Assumed. */
const EXPAND = 0.01;

const SYSTEM =
  "You make one decision at a time for software that helps a person on their computer. The state below is what the software sees. " +
  "Each question lists the labels of the options it allows; answer with exactly one of them. Follow the question's own rules, such as choosing none when no option fits.";

interface Option {
  label: string;
  text: string;
}

/** Labels for n options: A to Z, else zero-padded numbers from 1. */
export function labelsFor(n: number): string[] {
  if (n <= 26) return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
  const w = String(n).length;
  return Array.from({ length: n }, (_, i) => String(i + 1).padStart(w, "0"));
}

const text = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v, null, 1));
const gbnf = (xs: readonly string[]): string => `root ::= ${[...new Set(xs)].map((x) => JSON.stringify(x)).join(" | ")}`;

/** The labelled option table of a request and each question's options under it (see the file's header). */
export function layout(req: JevRequest): { table: Option[]; choice: Map<string, Map<string, string>>; prefix: string } {
  const key = (id: string, d: string | null): string => `${id}\u0000${d ?? ""}`;
  const order: { id: string; d: string | null }[] = [];
  const seen = new Set<string>();
  for (const q of Object.values(req.questions)) {
    for (const [id, d] of Object.entries(q.criteria)) {
      if (!seen.has(key(id, d))) order.push({ id, d });
      seen.add(key(id, d));
    }
  }
  const labels = labelsFor(order.length);
  const byKey = new Map(order.map((o, i) => [key(o.id, o.d), labels[i] as string]));
  const table = order.map((o, i) => ({ label: labels[i] as string, text: o.d === null ? o.id : `${o.id}: ${o.d}` }));
  const choice = new Map<string, Map<string, string>>();
  for (const [qid, q] of Object.entries(req.questions)) choice.set(qid, new Map(Object.entries(q.criteria).map(([id, d]) => [byKey.get(key(id, d)) as string, id])));
  const prefix = `State:\n${text(req.state)}${table.length === 0 ? "" : `\n\nOptions, by label:\n${table.map((o) => `${o.label}. ${o.text}`).join("\n")}`}`;
  return { table, choice, prefix };
}

function questionText(q: ChoiceQuestion, labels: readonly string[]): string {
  return `\n\nQuestion: ${text(q.instructions)}\nAnswer with one of these labels: ${labels.join(", ")}.`;
}

function noulText(q: NoulQuestion): string {
  const yes = q.criteria?.true === undefined ? "" : ` (${q.criteria.true})`;
  const no = q.criteria?.false === undefined ? "" : ` (${q.criteria.false})`;
  return `\n\nQuestion: ${text(q.instructions)}\nA. Yes${yes}\nB. No${no}\nAnswer with one of these labels: A, B.`;
}

interface Completion {
  /** Each listed token's probability at the one position predicted. */
  probs: Map<string, number>;
  evaluated: number;
}

class LlamaUnavailable extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "LlamaUnavailable";
  }
}

export function llamaEngine(opts: LlamaOptions): DecideEngine {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const post = async (path: string, body: unknown, out: Sealed): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      // Rendered from the sealed copy (answer reads only frozenRequest's), checked as it leaves.
      res = await f(`${opts.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: sealedBody(out, () => body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // A request the boundary refused is that refusal, not an engine that did not answer.
      if (e instanceof UnmintedText) throw e;
      throw new LlamaUnavailable(`llama-server at ${opts.url} did not answer ${path}: ${e instanceof Error ? e.message : String(e)}`, e);
    }
    if (!res.ok) throw new LlamaUnavailable(`llama-server ${path} answered HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    return (await res.json()) as Record<string, unknown>;
  };

  const frame = async (content: string, out: Sealed): Promise<string> => {
    if (opts.prompt === "document") return `${SYSTEM}\n\n${content}\nAnswer:`;
    const r = await post("/apply-template", { messages: [{ role: "system", content: SYSTEM }, { role: "user", content }], ...(opts.templateKwargs === undefined ? {} : { chat_template_kwargs: opts.templateKwargs }) }, out);
    if (typeof r.prompt !== "string") throw new LlamaUnavailable("llama-server /apply-template returned no prompt");
    return r.prompt;
  };

  const complete = async (prompt: string, allowed: readonly string[], out: Sealed): Promise<Completion> => {
    // Temperature below 0 is greedy, and the probabilities are then the plain softmax of the logits over the whole
    // vocabulary (llama-server README, n_probs), which is what the labels' split is read from.
    const r = await post("/completion", { prompt, n_predict: 1, n_probs: N_PROBS, temperature: -1, cache_prompt: true, grammar: gbnf(allowed) }, out);
    const list = (r.completion_probabilities ?? r.probs) as { top_logprobs?: { token: string; logprob: number }[] }[] | undefined;
    const top = list?.[0]?.top_logprobs;
    if (top === undefined) throw new LlamaUnavailable("llama-server returned no token probabilities");
    const probs = new Map<string, number>();
    for (const t of top) probs.set(t.token, (probs.get(t.token) ?? 0) + Math.exp(t.logprob));
    // timings.prompt_n is the prompt tokens this completion evaluated, the cached prefix not counted.
    return { probs, evaluated: Number((r.timings as { prompt_n?: number } | undefined)?.prompt_n ?? 0) };
  };

  /**
   * Every label's probability, read position by position: a label's raw probability is the product of its characters'
   * probabilities, each given the ones before it, a forced character included. The labels' total is the share of the
   * model's probability that went to some label; under MIN_LABEL_MASS the split is even (confidence 0), else it is
   * normalized over the labels (review: renormalizing per position counted a forced digit as certain, and read a yes of
   * 0.5 against a no of 0.001 as 0.998).
   */
  const split = async (prompt: string, labels: readonly string[], out: Sealed): Promise<{ p: Map<string, number>; evaluated: number }> => {
    const width = labels[0]?.length ?? 1;
    let evaluated = 0;
    const raw = new Map<string, number>();
    const walk = async (prefix: string, mass: number, under: readonly string[]): Promise<void> => {
      if (prefix.length === width) {
        raw.set(prefix, (raw.get(prefix) ?? 0) + mass);
        return;
      }
      const next = [...new Set(under.map((l) => l[prefix.length] as string))];
      const c = await complete(prompt + prefix, next, out);
      evaluated += c.evaluated;
      for (const ch of next) {
        const q = (c.probs.get(ch) ?? 0) * mass;
        const branch = under.filter((l) => l[prefix.length] === ch);
        // A branch this unlikely is not read further: its labels share what it holds evenly.
        if (prefix.length + 1 < width && q < EXPAND) {
          for (const l of branch) raw.set(l, (raw.get(l) ?? 0) + q / branch.length);
        } else await walk(prefix + ch, q, branch);
      }
    };
    await walk("", 1, labels);
    const held = [...raw.values()].reduce((a, b) => a + b, 0);
    const p = new Map(labels.map((l) => [l, held < MIN_LABEL_MASS ? 1 / labels.length : (raw.get(l) ?? 0) / held]));
    return { p, evaluated };
  };

  let queue: Promise<unknown> = Promise.resolve();
  const answer = async (out: Sealed, req: JevRequest): Promise<JevResult> => {
    const t0 = performance.now();
    // `req` is the sealed copy read back (frozenRequest): every prompt is rendered from it, and every call to llama-server,
    // when it is dequeued and each one after, is checked as it leaves.
    const { choice, prefix } = layout(req);
    const answers: JevResult["answers"] = {};
    const probabilities: Record<string, Record<string, number>> = {};
    let evaluated = 0;
    for (const [qid, q] of Object.entries(req.questions)) {
      const byLabel = choice.get(qid) as Map<string, string>;
      const labels = [...byLabel.keys()];
      const prompt = await frame(prefix + questionText(q, labels), out);
      const s = await split(prompt, labels, out);
      evaluated += s.evaluated;
      const p = Object.fromEntries(labels.map((l) => [byLabel.get(l) as string, s.p.get(l) ?? 0]));
      const best = Object.entries(p).sort(([, x], [, y]) => y - x)[0];
      if (best === undefined) throw new Error(`question ${qid} lists no options`);
      probabilities[qid] = p;
      const n = labels.length;
      answers[qid] = { choice: best[0], confidence: n < 2 ? 1 : Math.max(0, (best[1] - 1 / n) / (1 - 1 / n)) };
    }
    const nouls: Record<string, number> = {};
    for (const [qid, q] of Object.entries(req.nouls ?? {})) {
      const s = await split(await frame(prefix + noulText(q), out), ["A", "B"], out);
      evaluated += s.evaluated;
      nouls[qid] = s.p.get("A") ?? 0;
    }
    return { model: opts.model, answers, ...(req.nouls === undefined ? {} : { nouls }), probabilities, inputTokens: evaluated, latencyMs: performance.now() - t0, costUsd: 0 };
  };
  // One request at a time: two requests in flight would take turns in llama-server's one slot and push each other's
  // prompt prefix out of its cache, evaluating each prefix again for every question.
  const ask: AskJev = (asked) => {
    // The request waits in the queue, so it is sealed now (privacy/send.ts): one frozen copy, verified, that every prompt
    // is rendered from; a caller that changes its request afterwards changes nothing that is sent (PV2 review).
    assertNoExcludedValue(asked);
    const out = seal({ req: asked, wire: wireBody(asked, opts.model) });
    const req = frozenRequest(asked, out.wire, out.charged);
    const run = queue.then(() => answer(out, req));
    queue = run.catch(() => undefined);
    return run;
  };
  return { name: "llama", model: opts.model, reach: "mac", ask };
}
