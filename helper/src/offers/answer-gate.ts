// Which helper messages carry a saved answer (S1), so the server sends them only to a host that declared
// SAVED_ANSWERS_CAPABILITY: one that shows an answer whole before inserting it. A host before S1 would insert a fill
// value from a saved answer on Tab like any other, unseen, so it is sent the proposal without those fields.
import type { FillProposal, HelperMessage } from "../protocol.ts";

/** The ref rule of a pop-up row whose value is a saved answer; the server finds answers in a pop-up by it. */
export const SAVED_ANSWER_RULE = "savedAnswer";

function hasRule(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasRule);
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.rule === SAVED_ANSWER_RULE) return true;
  return Object.values(o).some(hasRule);
}

/** Whether a message holds a saved answer's text: an offer to save one, a fill field from one, or a pop-up row that writes one. */
export function carriesAnswer(m: HelperMessage): boolean {
  if (m.type === "answerSaveOffer") return true;
  if (m.type === "fillProposal") return m.fields.some((f) => f.answer !== undefined);
  if (m.type === "popup") return hasRule(m.spec);
  return false;
}

/** The proposal as a host without saved answers reads it: each field a saved answer matched, unasked and without a value. */
export function withoutAnswers(p: FillProposal): FillProposal {
  return {
    ...p,
    fields: p.fields.map((f) => {
      if (f.answer === undefined) return f;
      const { answer: _a, ...rest } = f;
      return { ...rest, choice: "none", confidence: 0, value: null, source: null, memory: null, withheld: null, asks: [] };
    }),
  };
}
