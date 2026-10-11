// S1: the saved-answer lines in fixtures/golden/answers.ndjson are the contract the host decodes byte for byte: its
// hello with the capability, an offer to save an answer and the user's yes, a "remember this answer" and its refusals,
// a fill proposal with an offered and a withheld answer, the pop-up that writes one, and answers.md in the memory list.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnyMessage, ConsumerMessage, FillProposal, HelperMessage } from "../src/protocol.ts";

const lines = readFileSync(new URL("../fixtures/golden/answers.ndjson", import.meta.url), "utf8").trim().split("\n");
const CONSUMER = new Set(["hello", "answerSave"]);
const at = (i: number): Record<string, unknown> => JSON.parse(lines[i] as string) as Record<string, unknown>;

describe("the saved-answer protocol lines", () => {
  it("parses every golden line and writes it back byte for byte", () => {
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      "hello",
      "answerSaveOffer",
      "answerSave",
      "answerSaveReply",
      "answerSave",
      "answerSaveReply",
      "answerSaveReply",
      "fillProposal",
      "popup",
      "memoryDocumentReply",
    ]);
    for (const l of lines) {
      const m = JSON.parse(l) as { type: string };
      expect(JSON.stringify((CONSUMER.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), m.type).toBe(l);
    }
  });

  it("carries an offered answer whole as memory, and a withheld one with its sentence and no value", () => {
    const p = FillProposal.parse(at(7));
    const [offered, held] = p.fields;
    expect(offered?.value).toBe(offered?.answer === undefined ? null : (at(1).answer as string));
    expect(offered?.memory?.id).toBe(offered?.answer?.id);
    expect([held?.value, held?.withheld, held?.answer?.withheld]).toEqual([null, "otherPerson", { why: "otherOrganization", says: "This answer was written for Northwind Robotics; this page is for Ramp." }]);
    const rows = (at(8).spec as { blocks: { type: string; rows?: { value: { text: string; ref: { rule?: string } } }[] }[] }).blocks.find((b) => b.type === "fields")?.rows ?? [];
    expect(rows.find((r) => r.value.ref.rule === "savedAnswer")?.value.text).toBe(at(1).answer);
  });

  it("refuses the shapes the contract rules out", () => {
    const bad = (m: unknown): boolean => !AnyMessage.safeParse(m).success;
    // A saved reply names the answer and no refusal; a refused one, the reverse.
    expect(bad({ ...at(3), why: "pasted" })).toBe(true);
    expect(bad({ ...at(5), answerId: "answer-1a2b3c4d" })).toBe(true);
    expect(bad({ ...at(5), why: "because" })).toBe(true);
    // A consent names an offer or a field, nothing else.
    expect(bad({ ...at(2), from: { kind: "everything" } })).toBe(true);
    // A question is one line; an answer is never blank or over 4,000 characters.
    expect(bad({ ...at(1), question: "Line one\nline two" })).toBe(true);
    expect(bad({ ...at(1), answer: "   " })).toBe(true);
    expect(bad({ ...at(1), answer: "x".repeat(4001) })).toBe(true);
    // An offered answer is its memory entry's value; a withheld one has no value.
    const p = at(7) as { fields: Record<string, unknown>[] };
    const [offered, held] = p.fields as [Record<string, unknown>, Record<string, unknown>];
    expect(bad({ ...p, fields: [{ ...offered, memory: { ...(offered.memory as object), id: "about-1" } }] })).toBe(true);
    expect(bad({ ...p, fields: [{ ...held, value: "x", memory: offered.memory }] })).toBe(true);
  });
});
