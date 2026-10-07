// W1: the dispatch every evaluation's canned engine answers through (page-loop-eval, tab-source-journey, realfill-asks).
// A canned engine stands in for Jev with a rule per kind of question. Before this each engine matched question ids and
// option shapes itself and answered anything it did not recognise with "none": when A1 added the Ask heads' `reading`
// question, page-loop-eval's canned engine answered it "none" (its option "fill no field"), every page goal asked back
// "Which fields should Caret fill?", and the canned browser sets wrote nothing (evidence/screen/w1 chain-w1b). Now a
// question's kind is read from its request's purpose (JevRequest.purpose, set by each builder) and its id, and a kind
// with no rule, a request with no purpose, an id its purpose does not ask, or a rule's answer that is not one of the
// question's options throws, naming the kind and the request.
import type { JevPurpose, JevRequest, JevResult } from "../../fill/jev.ts";

type Question = JevRequest["questions"][string];

/** Ids each purpose asks, by the part of its kind they are: `${purpose}:${part}`. A purpose not listed has one kind per id. */
const GRAMMAR: Partial<Record<JevPurpose, readonly (readonly [RegExp, string])[]>> = {
  "fill.whose": [[/^f\d+_whose$/u, "whose"], [/^[cv]\d+_owner$/u, "owner"]],
  "fill.values": [[/^f\d+$/u, "value"], [/^f\d+_whose$/u, "whose"], [/^[cv]\d+_owner$/u, "owner"], [/^f\d+_answer$/u, "answer"]],
  "ask.heads": [[/^(?:scope|why|source|whose|section|reading)$/u, "$&"], [/^n_.+$/u, "field"]],
  "ask.confirm": [[/^all$/u, "all"], [/^f\d+$/u, "field"]],
  "intent.route": [[/^(?:route|why|scope|source|whose)$/u, "$&"], [/^lit\d+$/u, "literal"]],
  "intent.fields": [[/^n_.+$/u, "field"], [/^t\d+$/u, "tie"]],
  "plan.verify": [[/^c\d+$/u, "value"], [/^f\d+$/u, "whose"], [/^v\d+$/u, "owner"]],
  "codeplan.asksAbout": [[/^f\d+$/u, "field"]],
  "planner.window": [[/^window$/u, "window"]],
  "planner.fields": [[/^f\d+$/u, "field"], [/^press$/u, "press"]],
};

/** A canned engine's question with no rule, or a request it cannot read: loud, with the kind and the request. */
export class CannedGap extends Error {}

/** The kind of question `id` is in `req` (`${purpose}:${part}`), or a CannedGap when the request says no purpose or does not ask that id. */
export function questionKind(req: JevRequest, id: string): string {
  const ids = [...Object.keys(req.questions), ...Object.keys(req.nouls ?? {})].join(", ");
  if (req.purpose === undefined) throw new CannedGap(`a request with no purpose (questions ${ids}) reached a canned engine; its builder must set JevRequest.purpose`);
  const grammar = GRAMMAR[req.purpose];
  if (grammar === undefined) return `${req.purpose}:${id}`;
  for (const [re, part] of grammar) if (re.test(id)) return `${req.purpose}:${id.replace(re, part)}`;
  throw new CannedGap(`a ${req.purpose} request asks '${id}', which no ${req.purpose} question is called (questions ${ids})`);
}

export type CannedAnswer = string | { choice: string; confidence: number };
/** A canned engine's rules: for a choice question its option id, for a yes/no (noul) question its probability of yes. */
export interface CannedRules {
  choice: Readonly<Record<string, (q: Question, id: string, req: JevRequest) => CannedAnswer | Promise<CannedAnswer>>>;
  noul: Readonly<Record<string, (id: string, req: JevRequest) => number>>;
  /** Confidence for a rule that returns an option id alone. */
  confidence: number;
  model?: string;
}

/** Answers every question of `req` by the rule for its kind (questionKind), or throws a CannedGap. */
export async function cannedReply(req: JevRequest, rules: CannedRules): Promise<JevResult> {
  const answers: JevResult["answers"] = {};
  for (const [id, q] of Object.entries(req.questions)) {
    const kind = questionKind(req, id);
    const rule = rules.choice[kind];
    if (rule === undefined) throw new CannedGap(`the canned engine has no rule for question kind '${kind}' (id '${id}': "${String(q.instructions).slice(0, 120)}") in a ${req.purpose ?? "?"} request asking ${Object.keys(req.questions).join(", ")}`);
    const a = await rule(q, id, req);
    const answer = typeof a === "string" ? { choice: a, confidence: rules.confidence } : a;
    if (!(answer.choice in q.criteria)) throw new CannedGap(`the canned rule for '${kind}' (id '${id}') answered '${answer.choice}', which is not one of its options (${Object.keys(q.criteria).join(", ")})`);
    answers[id] = answer;
  }
  const nouls: Record<string, number> = {};
  for (const id of Object.keys(req.nouls ?? {})) {
    const kind = questionKind(req, id);
    const rule = rules.noul[kind];
    if (rule === undefined) throw new CannedGap(`the canned engine has no rule for yes/no kind '${kind}' (id '${id}') in a ${req.purpose ?? "?"} request`);
    nouls[id] = rule(id, req);
  }
  return { model: rules.model ?? "canned", answers, ...(req.nouls === undefined ? {} : { nouls }), inputTokens: 0, latencyMs: 0, costUsd: 0 };
}
