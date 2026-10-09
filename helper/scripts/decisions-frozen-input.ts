import { canonicalRequest } from "../src/engines/decide/cache.ts";
import type { ChoiceQuestion, JevRequest, NoulQuestion } from "../src/fill/jev.ts";
import { minted } from "../test/minted.ts";

export interface FrozenEntry {
  engine: string;
  canonical: { exact: boolean; state: JsonValue; questions: { id?: string; type: "choice" | "noul"; instructions: string; criteria: [string, string | null][] | { true: string; false: string } | null }[] };
  answers: Record<string, { choice: string; confidence: number }>;
  probabilities: Record<string, Record<string, number>>;
  recordedAt: string;
}
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type PlainChoice = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
type PlainNoul = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
interface Wire { state: JsonValue; questions: Record<string, PlainChoice | PlainNoul> }
function fromWire(w: Wire): JevRequest {
  const questions: Record<string, PlainChoice> = {};
  const nouls: Record<string, PlainNoul> = {};
  for (const [id, q] of Object.entries(w.questions)) {
    if (q.type === "choice") questions[id] = q;
    else if (q.type === "noul") nouls[id] = q;
    else throw new Error(`original Jev wire has an unsupported question type at ${id}`);
  }
  return minted({ state: w.state, questions, ...(Object.keys(nouls).length === 0 ? {} : { nouls }), snippets: [], charged: {} });
}
const identity = (req: JevRequest): string => canonicalRequest(req, "jev", "frozen-original-wire").key;
/** Index only full request bodies, never answer-only logs or canonical cache records. */
export function originalRequests(text: string): Map<string, JevRequest> {
  const found = new Map<string, JevRequest>();
  for (const line of text.split("\n").filter((l) => l.trim() !== "")) {
    const row = JSON.parse(line) as { body?: Wire };
    if (row.body === undefined || row.body.questions === undefined || !Object.hasOwn(row.body, "state")) throw new Error("--jev-requests needs an order-preserving harness request log with body.state and body.questions");
    const req = fromWire(row.body);
    const key = identity(req);
    const before = found.get(key);
    // The canonical key cannot distinguish differently ordered sends. Do not guess which one earned the cached answer.
    if (before !== undefined && JSON.stringify({ questions: before.questions, nouls: before.nouls }) !== JSON.stringify({ questions: req.questions, nouls: req.nouls })) throw new Error(`ambiguous original Jev wire order for ${key}; supply the recording's own request log`);
    found.set(key, req);
  }
  return found;
}
/** Canonical order is used only to find the original send, never to construct a comparison request. */
export function frozenRequestOf(e: FrozenEntry, originals: ReadonlyMap<string, JevRequest>): JevRequest {
  const questions: Record<string, PlainChoice> = {};
  const nouls: Record<string, PlainNoul> = {};
  for (const q of e.canonical.questions) {
    if (q.id === undefined) throw new Error("an exact cache entry has a question without its id");
    if (q.type === "choice") questions[q.id] = { type: "choice", instructions: q.instructions, criteria: Object.fromEntries(q.criteria as [string, string | null][]) };
    else nouls[q.id] = { type: "noul", instructions: q.instructions, ...(q.criteria === null ? {} : { criteria: q.criteria as { true: string; false: string } }) };
  }
  const key = identity(minted({ state: e.canonical.state, questions, ...(Object.keys(nouls).length === 0 ? {} : { nouls }), snippets: [], charged: {} }));
  const original = originals.get(key);
  if (original === undefined) throw new Error(`no original Jev wire for ${key}, recorded ${e.recordedAt}; canonical cache order cannot recover the original send`);
  return original;
}
