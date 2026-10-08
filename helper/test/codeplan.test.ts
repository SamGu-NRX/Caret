// B24: Ask with natural phrasing through the code-mode writer (planner/codeplan.ts). A fake writer returns a
// fixed program; the sandbox runs it for real; a stand-in Jev answers the checks. The plan must be the planner's
// own shape, checked by validatePlan, and every write the writer chose must pass code's and Jev's checks.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { planWithCode } from "../src/planner/codeplan.ts";
import { PlannerError } from "../src/planner/validate.ts";
import type { WriterPort, WriterRequest } from "../src/writer/port.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { field, node, scopeLabel, snap, text } from "./builders.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { askScope, fieldFingerprint } from "../src/fill/ask-scope.ts";
import type { WindowState } from "../src/model.ts";
import { planAsk } from "../src/planner/ask.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";

// F2's memory-value check got "guest compute passed 250 ms" rather than its expected refusal.
// The worker charges wall time inside QuickJS slices, including time it is descheduled.
// Use the existing per-run limits seam only here; the real worker and validation still run.
// Sandbox boundary tests retain the product's 250 ms compute and 1,000 ms watchdog limits.
vi.mock("../src/codemode/sandbox.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/codemode/sandbox.ts")>();
  return {
    ...original,
    runCodePlan: (...[source, snapshots, choose, opts = {}]: Parameters<typeof original.runCodePlan>) =>
      original.runCodePlan(source, snapshots, choose, { ...opts, limits: { ...opts.limits, guestCpuMs: 10_000, watchdogMs: 10_000 } }),
  };
});

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
    route: FAKE_WRITER_ROUTE,
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
      // W2: the write contract's verifier (fill/contract.ts) is asked what `yes` says of the value: exact, or another's.
      if (req.purpose === "fill.verify") answers[id] = { choice: (o.yes ?? (() => true))(ins) ? "exact" : "other", confidence: 0.9 };
      else if ("yes" in q.criteria) answers[id] = { choice: (o.yes ?? (() => true))(ins) ? "yes" : "no", confidence: 0.9 };
      else if (id.startsWith("v")) answers[id] = { choice: (o.others ?? ["labelled 'Reference"]).some((x) => ins.includes(x)) ? "other" : "user", confidence: 0.9 };
      else answers[id] = { choice: ins.includes("Reference") ? "other" : "user", confidence: 0.9 };
    }
    return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  };
  return { ask, seen };
}

const memory = { values: () => [] };
const run = (program: string, instruction: string, j = jev(), seen: WriterRequest[] = []) => planWithCode(instruction, desk(), memory, { writer: writer(program, seen), askJev: j.ask, offerKey: "plan-1", windowId: "form", now: 2000 });

// W2: the write contract's verifier asks this file's stand-in Jev (jev below), not the suite's stand-in.
beforeAll(() => setTestVerifier(null));
afterAll(() => setTestVerifier(STAND_IN));

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

  it("drops a value from a window that the write contract's verifier does not call the field's", async () => {
    await expect(run(fillByText([["Reference name", "Simone Achebe"]]), "do the reference section from my notes", jev({ yes: () => false }))).rejects.toThrow(/isn't this field's value/);
  });
});

describe("planWithCode, review fixes (B24)", () => {
  it("never writes a field the instruction rules out by naming another section's field of the same label", async () => {
    const m = desk();
    const groups = ["Billing", "Shipping"].flatMap((sec, i) => [
      node(`${P}/group:${sec.toLowerCase()}~0`, "AXGroup", { parent: `${P}/webarea:~0`, label: sec }),
      field(`${P}/group:${sec.toLowerCase()}/textfield:city~0`, "", { parent: `${P}/group:${sec.toLowerCase()}~0`, label: "City", frame: [100, 300 + 30 * i, 200, 20] }),
    ]);
    const form = m.windows.get("form");
    if (form === undefined) throw new Error("no form");
    m.apply(snap([...form.nodes.values(), ...groups], { at: 1100, windowId: "form", title: "Apply", app: FORM_APP, focused: true }));
    m.apply(snap([field("te/note", "City: Austin", { role: "AXTextArea" })], { at: 1050, windowId: "note2", title: "City.txt", app: NOTE_APP }));
    const program = `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const form = await caret.readWindow();
  // The note the user just left is w2; the city's note is w3.
  const src = await caret.readWindow("w3" as WindowRef);
  const v = src.values.find((x) => x.display.startsWith('"Austin"'));
  const steps: StepRef[] = [];
  for (const t of form.targets) if (t.label.endsWith("City") && v !== undefined) steps.push(caret.fill(t.ref, v.ref));
  return caret.plan({ basedOn: form.snapshot, steps });
}`;
    const d = await planWithCode("fill billing city", m, memory, { writer: writer(program), askJev: jev().ask, offerKey: "plan-1", windowId: "form", now: 2000 });
    expect(d.checked.writes.map((w) => w.node.key)).toEqual([`${P}/group:billing/textfield:city~0`]);
  });

  it("checks a value from memory as it checks one from a window, and keeps a person from memory out of the user's field", async () => {
    const remembered = { values: () => [{ id: "about-1", label: "Personal email", text: "private@example.org", whose: "user" as const }, { id: "person-1", label: "Simone", text: "Simone Achebe", whose: "other" as const }] };
    const program = (label: string, text: string) => fillByText([[label, text]]);
    // The verifier says the personal address is not the value Email asks for: the write is dropped (W2).
    await expect(planWithCode("fill in my email", desk(), remembered, { writer: writer(program("Email", "private@example.org")), askJev: jev({ yes: (q) => !q.includes("private@example.org") }).ask, offerKey: "plan-1", windowId: "form", now: 2000 })).rejects.toThrow(/isn't this field's value/);
    // A remembered person in the user's Full name: the field wants the user's, the entry is someone else's.
    await expect(planWithCode("put the name in", desk(), remembered, { writer: writer(program("Full name", "Simone Achebe")), askJev: jev().ask, offerKey: "plan-1", windowId: "form", now: 2000 })).rejects.toThrow(/another person's/);
  });

  it("records what the writer request disclosed, and its checks declare only what they send", async () => {
    const j = jev();
    const seen: WriterRequest[] = [];
    const d = await run(fillByText([["Reference name", "Simone Achebe"]]), "do the reference section from my notes", j, seen);
    const input = JSON.stringify(seen[0]?.input);
    // Every disclosed text is in the prompt's inventory, and the note's values are among them.
    for (const x of d.writer.disclosed) expect(input).toContain(JSON.stringify(x.text).slice(1, -1));
    expect(d.writer.disclosed.some((x) => x.windowId === "note")).toBe(true);
    for (const r of j.seen) {
      const body = JSON.stringify([r.state, r.questions]);
      for (const x of r.snippets) expect(body).toContain(JSON.stringify(x.text).slice(1, -1));
    }
  });
});

describe("planWithCode, fix-check (B24)", () => {
  it("declares the title as the writer sees it when it is cut to 200 characters", async () => {
    const m = desk();
    const form = m.windows.get("form");
    if (form === undefined) throw new Error("no form");
    const long = `Private form ${"X".repeat(210)}`;
    // A title over 80 characters is prose, of which a request covers under half (privacy.ts, B25): the page's
    // terms paragraphs make room for the 200 characters the writer sees.
    const terms = [0, 1].map((i) => text(`terms-${i}`, `Terms ${i}: ${"These terms describe how the page handles what you enter, in plain words for everyone. ".repeat(2)}`));
    m.apply(snap([...form.nodes.values(), ...terms], { at: 1100, windowId: "form", title: long, app: FORM_APP, focused: true }));
    const seen: WriterRequest[] = [];
    const r = await planWithCode("do the reference section from my notes", m, memory, { writer: writer(fillByText([["Reference name", "Simone Achebe"]]), seen), askJev: jev().ask, offerKey: "plan-2", windowId: "form", now: 2000 });
    const sent = (seen.at(-1)?.input as unknown as { snapshots: { title: string }[] }).snapshots[0]?.title;
    expect(sent).toBe(long.slice(0, 200));
    expect(r.writer.disclosed.some((x) => x.text === long.slice(0, 200))).toBe(true);
    expect(seen.at(-1)?.disclosed).toEqual(r.writer.disclosed);
  });
});

// I2: the code-mode writer under an Ask's settled scope (fill/ask-scope.ts), directly and as planAsk's fallback.
describe("planWithCode under an Ask's scope (I2)", () => {
  const NAME = `${P}/textfield:full name~0`;
  const EMAIL = `${P}/textfield:email~0`;
  const scopeOn = (m: ScreenModel, keys: readonly string[]) => {
    const w = m.windows.get("form") as WindowState;
    return askScope("form", null, keys, Object.fromEntries(keys.map((k) => [k, fieldFingerprint(w, k)])), null, "ask-test");
  };

  it("mints only the scope's field when the program fills two, told nothing of the scope", async () => {
    const m = desk();
    const scope = scopeOn(m, [NAME]);
    const d = await planWithCode("fill in my name and email", m, memory, { writer: writer(fillByText([["Full name", "Harper Quinlan"], ["Email", "harper.quinlan@example.com"]])), askJev: jev().ask, offerKey: "plan-1", windowId: "form", now: 2000, authority: { kind: "ask", scope } });
    expect(d.checked.writes.map((w) => w.node.key)).toEqual([NAME]);
    expect(d.checked.origin).toEqual({ kind: "ask", scope });
  });

  it("as planAsk's fallback after the planner finds nothing: writes only the field Jev's scope ask chose", async () => {
    const values = jev();
    // Heads route plan; the scope ask chooses Full name alone; the planner's value questions keep every field, so it
    // finds nothing and the code-mode writer, whose program fills Full name and Email, plans instead.
    const ask: AskJev = async (req) => {
      if (req.purpose === "ask.heads") return { model: "t", inputTokens: 1, latencyMs: 1, costUsd: 0, answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: { route: "plan", why: "nothingToFill", source: "any", whose: "user" }[id] ?? "none", confidence: 0.95 }])) };
      if (req.purpose === "ask.scope") return { model: "t", inputTokens: 1, latencyMs: 1, costUsd: 0, answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: scopeLabel(String(q.instructions)) === "Full name" ? "asks" : "not", confidence: 0.95 }])) };
      if (req.purpose === "planner.fields") return { model: "t", inputTokens: 1, latencyMs: 1, costUsd: 0, answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: "keep" in q.criteria ? "keep" : "none", confidence: 0.95 }])) };
      return values.ask(req);
    };
    const d = await planAsk("fill in my name and email", desk(), memory, [], { askJev: ask, maker: headsIntentMaker(ask), writer: writer(fillByText([["Full name", "Harper Quinlan"], ["Email", "harper.quinlan@example.com"]])), offerKey: "plan-2", windowId: "form", now: 2000 });
    expect("checked" in d && d.checked.writes.map((w) => [w.node.key, w.value])).toEqual([[NAME, "Harper Quinlan"]]);
    expect("checked" in d && d.checked.origin.kind === "ask" && d.checked.origin.scope.fields).toEqual(new Set([NAME]));
    expect(EMAIL).toBeTruthy();
  });
});
