// B24: Ask with natural phrasing through the code-mode writer (planner/codeplan.ts). A fake writer returns a
// fixed program; the sandbox runs it for real; a stand-in Jev answers the checks. The plan must be the planner's
// own shape, checked by validatePlan, and every write the writer chose must pass code's and Jev's checks.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { planWithCode } from "../src/planner/codeplan.ts";
import { PlannerError } from "../src/planner/validate.ts";
import type { WriterPort, WriterRequest } from "../src/writer/port.ts";
import { WRITER_ROUTE } from "../src/writer/config.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { field, node, snap, text } from "./builders.ts";

const NOTE_APP = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const FORM_APP = { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" };
const P = "com.google.Chrome/standard";

function desk(): ScreenModel {
  const m = new ScreenModel();
  const note = ["Job notes", "Name: Harper Quinlan", "Email: harper.quinlan@example.com", "Reference: Simone Achebe", "Reference email: simone.achebe@ridgeline.example.com", "Start: Jan 4, 2027"].join("\n");
  m.apply(snap([field("te/note", note, { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Job notes.txt", app: NOTE_APP, focused: true }));
  const fields = ["Full name", "Email", "Reference name", "Reference email", "Earliest start date"].map((l, i) => field(`${P}/textfield:${l.toLowerCase()}~0`, "", { parent: `${P}/webarea:~0`, label: l, frame: [100, 100 + 30 * i, 200, 20] }));
  m.apply(snap([node(`${P}/webarea:~0`, "AXWebArea", { label: "Apply" }), ...fields, ...Array.from({ length: 30 }, (_, i) => text(`${P}/statictext:t${i}~0`, `Terms paragraph ${i} about the role, its location and benefits.`, undefined, `${P}/webarea:~0`))], { at: 1000, windowId: "form", title: "Apply", app: FORM_APP, focused: true }));
  return m;
}

/** A writer that returns `program` and records what it was sent. */
function writer(program: string, seen: WriterRequest[] = []): WriterPort {
  return {
    route: WRITER_ROUTE,
    async write(req) {
      seen.push(req);
      return { model: "fake", provider: "groq", output: { program, reply: program }, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, latencyMs: 1, costUsd: 0 };
    },
  };
}

/** A program that fills target `label` with the value whose display starts with `"text"`. */
const fillByText = (pairs: [string, string][]): string => `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const form = await caret.readWindow();
  // The desk has one source window, the note; reading a window the inventory does not list is a violation.
  const all = [form, await caret.readWindow("w2" as WindowRef)];
  const steps: StepRef[] = [];
  const pairs = ${JSON.stringify(pairs)};
  for (const [label, text] of pairs) {
    const t = form.targets.find((x) => x.label === label);
    let v = null;
    for (const w of all) for (const x of w.values) if (v === null && x.display.startsWith('"' + text + '"')) v = x;
    if (t !== undefined && v !== null) steps.push(caret.fill(t.ref, v.ref));
  }
  return caret.plan({ basedOn: form.snapshot, steps });
}`;

/** Jev that answers yes to every yes/no check unless `yes` says otherwise, a Reference field as someone else's, and a value as the user's unless its description holds one of `others` (by default, a value labelled Reference). */
function jev(o: { yes?: (q: string) => boolean; others?: readonly string[] } = {}): { ask: AskJev; seen: JevRequest[] } {
  const seen: JevRequest[] = [];
  const ask: AskJev = async (req) => {
    seen.push(req);
    const answers: Record<string, { choice: string; confidence: number }> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const ins = String(q.instructions);
      if ("yes" in q.criteria) answers[id] = { choice: (o.yes ?? (() => true))(ins) ? "yes" : "no", confidence: 0.9 };
      else if (id.startsWith("v")) answers[id] = { choice: (o.others ?? ["labelled 'Reference"]).some((x) => ins.includes(x)) ? "other" : "user", confidence: 0.9 };
      else answers[id] = { choice: ins.includes("Reference") ? "other" : "user", confidence: 0.9 };
    }
    return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  };
  return { ask, seen };
}

const memory = { values: () => [] };
const run = (program: string, instruction: string, j = jev(), seen: WriterRequest[] = []) => planWithCode(instruction, desk(), memory, { writer: writer(program, seen), askJev: j.ask, offerKey: "plan-1", windowId: "form", now: 2000 });

describe("planWithCode", () => {
  it("turns the program's fills into the planner's checked plan, values traced to the note", async () => {
    const seen: WriterRequest[] = [];
    const d = await run(fillByText([["Reference name", "Simone Achebe"], ["Reference email", "simone.achebe@ridgeline.example.com"]]), "do the reference section from my notes", jev(), seen);
    expect(d.checked.writes.map((w) => [w.node.label, w.value, w.trace.from])).toEqual([
      ["Reference name", "Simone Achebe", "window"],
      ["Reference email", "simone.achebe@ridgeline.example.com", "window"],
    ]);
    expect(d.plan.steps.every((s) => s.end.kind === "valueEquals")).toBe(true);
    // The form is one snapshot with its fields; the note's values come as a window of their own.
    const input = seen[0]?.input as { snapshots: { targets: unknown[]; values: unknown[] }[] };
    expect(input.snapshots[0]?.targets.length).toBe(5);
    expect(input.snapshots.slice(1).flatMap((s) => s.values).length).toBeGreaterThan(0);
    expect(seen[0]?.disclosureId).toBe("plan-1");
  });

  it("drops a write to a field the instruction does not name unless Jev confirms the instruction asks for it", async () => {
    const program = fillByText([["Reference name", "Simone Achebe"], ["Email", "harper.quinlan@example.com"]]);
    // The instruction names the Reference fields by their words; Email it does not, and Jev says it does not ask for it.
    const asksAbout = (q: string): boolean => q.includes("fill or change") || q.includes("fill in or change");
    const d = await run(program, "do the reference section from my notes", jev({ yes: (q) => !(asksAbout(q) && !q.includes("Reference")) }));
    expect(d.checked.writes.map((w) => w.node.label)).toEqual(["Reference name"]);
  });

  it("drops a value both asks say is the user's from a field that wants someone else's", async () => {
    const program = fillByText([["Reference email", "harper.quinlan@example.com"], ["Reference name", "Simone Achebe"]]);
    const d = await run(program, "do the reference section from my notes", jev());
    expect(d.checked.writes.map((w) => w.node.label)).toEqual(["Reference name"]);
  });

  it("refuses a value of the wrong kind: a sentence in a date field", async () => {
    const bad = fillByText([["Earliest start date", "Harper Quinlan"]]);
    await expect(run(bad, "put my start date in")).rejects.toThrow(/takes a date/);
    const good = await run(fillByText([["Earliest start date", "Jan 4, 2027"]]), "put my start date in");
    expect(good.checked.writes.map((w) => w.value)).toEqual(["Jan 4, 2027"]);
  });

  it("refuses a program that presses, and one that fills nothing", async () => {
    const press = `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const form = await caret.readWindow();
  return caret.plan({ basedOn: form.snapshot, steps: [caret.ask("q1" as QuestionRef)] });
}`;
    await expect(run(press, "submit it")).rejects.toThrow(/refused|ask/);
    await expect(run(fillByText([]), "fill my name")).rejects.toThrow(PlannerError);
  });

  it("drops a value from a window that Jev does not confirm is the field's", async () => {
    await expect(run(fillByText([["Reference name", "Simone Achebe"]]), "do the reference section from my notes", jev({ yes: () => false }))).rejects.toThrow(/did not confirm/);
  });
});
