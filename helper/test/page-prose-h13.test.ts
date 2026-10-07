// H13 (lead addendum): a page field that takes a written answer ("Why do you want to work here?") is the user's to
// write. Caret doesn't write answers, so a preview never says Caret "wasn't sure what goes there" about one; that sentence
// is for a field Caret could have filled. A saved answer matched to the field but held back keeps its own reason.
// Every name and value is invented.
import { afterEach, describe, expect, it } from "vitest";
import type { GoalProgress } from "../src/protocol.ts";
import { c, mixedControls } from "./fake-page.ts";
import { closeRigs, rig } from "./page-rig.ts";

type Segment = Extract<GoalProgress, { event: "segment" }>;

afterEach(() => closeRigs());

const QUESTION = "Why do you want to work here?";
const withQuestion = () => [...mixedControls().slice(0, 2), c("e20", "textarea", QUESTION, { value: "" }), ...mixedControls().slice(2)];

describe("a prose question on a page goal's form (H13)", () => {
  it("is left to the user as theirs to write, not as a field Caret was unsure of", async () => {
    // Jev is asked about the question and is unsure: an over-eager pick at low confidence.
    const r = await rig({
      controls: withQuestion,
      jev: (inner) => async (req) => {
        const a = await inner(req);
        // The scope question (I2) asks for the question too; only fill's value questions are unsure.
        if (req.purpose === "ask.scope") return a;
        for (const [id, q] of Object.entries(req.questions)) {
          const ins = typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
          if (ins.includes(QUESTION)) a.answers[id] = { choice: Object.keys(q.criteria).find((k) => k !== "none") ?? "none", confidence: 0.3 };
        }
        return a;
      },
    });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.event).toBe("segment");
    const said = JSON.stringify(preview);
    expect(said).not.toContain("wasn't sure what goes there");
    expect(said).toContain(`'${QUESTION}' is yours to write: Caret doesn't write answers.`);
  });
});
