// Values the user typed in their instruction, found by code so Jev can choose among them: quoted
// text, typed values (emails, links, phones, amounts, times, IDs), and the object of "set X to Y" or
// "put Y in X". Each is a whole-word span of the instruction, so it traces to it (trace.ts). A phrase
// that opens with a determiner ("the tracking number", "my email") describes a value rather than
// quoting one, so it is not offered as text to write.

/** Typed values the reader would also detect (TypedValues.swift), written apart from it since the instruction never reaches the reader. */
const TYPED: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\bhttps?:\/\/[^\s"'<>]+[^\s"'<>.,;:!?)]/g,
  // A phone stands alone: digits inside an ID ("ORD-2026-48213") are not one.
  /(?<![\w-])\+?\d[\d ().-]{7,}\d(?![\w-])/g,
  /[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?/g,
  /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[AaPp]\.?[Mm]\.?)?(?![\w:])/g,
  /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g,
];

/** Clauses of an instruction: split at semicolons, sentence ends, and commas or "and" that open a new instruction. */
const CLAUSE = /\s*(?:;|\.(?=\s|$)|,\s*(?:and\s+)?|\s+and\s+(?=(?:the|set|put|write|enter|type|change|make|fill|add|my)\b))\s*/i;
/** "… to A and B to C": a clause that holds a second "X to Y" splits before its "and". */
const AND_NEXT = /\s+and\s+(?=(?:\S+\s+){0,4}(?:to|as)\s)/i;
const TO_TAIL = /\b(?:to|as)\s+(.+)$/i;
const PUT_HEAD = /^(?:put|write|enter|type|add|paste|insert)\s+(.+?)\s+(?:in|into)\s+\S/i;
const DESCRIBES = /^(?:the|my|his|her|their|our|your|its|a|an|this|that|these|those)\b/i;
const QUOTED = /(?:^|[\s(])(?:"([^"]+)"|“([^”]+)”|'([^']+)')(?=$|[\s.,;:!?)])/g;
const EDGE = /^[\s"'“”‘’.,;:!?()]+|[\s"'“”‘’.,;:!?()]+$/g;

/** Instruction spans in order of first appearance, each once. */
export function instructionValues(instruction: string): string[] {
  const out: string[] = [];
  const add = (raw: string | undefined): void => {
    const t = (raw ?? "").replace(EDGE, "").replace(/\s+/g, " ");
    if (t === "" || DESCRIBES.test(t) || out.includes(t)) return;
    out.push(t);
  };
  for (const m of instruction.matchAll(QUOTED)) add(m[1] ?? m[2] ?? m[3]);
  // Quoted text is taken whole; what it holds is not split into clauses.
  const unquoted = instruction.replace(QUOTED, (s) => s.replace(/[^\s]/g, " "));
  for (const re of TYPED) for (const m of unquoted.matchAll(re)) add(m[0]);
  for (const clause of unquoted.split(CLAUSE).flatMap((c) => c.split(AND_NEXT))) {
    add(TO_TAIL.exec(clause)?.[1]);
    add(PUT_HEAD.exec(clause)?.[1]);
  }
  return out;
}
