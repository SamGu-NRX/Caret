// HA2 (lead decision 3): the native planner's and the code writer's whose questions meet fill's rule. A value read from
// a window, for a field both asks say wants the user's details, counts only when both owner questions showed the whole
// note it was read from; otherwise it is dropped. Fresh synthetic fixtures, the same as ha2-owner-evidence.test.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { ScreenModel } from "../src/model.ts";
import { planWithCode } from "../src/planner/codeplan.ts";
import { planTask } from "../src/planner/planner.ts";
import type { WriterPort } from "../src/writer/port.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import { field, node, snap } from "./builders.ts";
import { STAND_IN } from "./setup/verifier.ts";

// As codeplan.test.ts: the sandbox's per-run limits are widened so a loaded machine does not time a program out.
vi.mock("../src/codemode/sandbox.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/codemode/sandbox.ts")>();
  return {
    ...original,
    runCodePlan: (...[source, snapshots, choose, opts = {}]: Parameters<typeof original.runCodePlan>) =>
      original.runCodePlan(source, snapshots, choose, { ...opts, limits: { ...opts.limits, guestCpuMs: 10_000, watchdogMs: 10_000 } }),
  };
});

const PHONE = "555-0388";
const EMAIL = "bram.k@example.org";
const OPENING = ["Signing up for the Thursday pottery class.", "I'm Odile Ferrant, second term."];
const CONTACTS = ["Copied from the visitor card:", `Phone: ${PHONE}`, `Email: ${EMAIL}`];
const DISCLAIMED = [...OPENING, ...CONTACTS, "Neither of those lines is mine."].join("\n");
const PROSE = "Reminder to myself: bring the receipt from last term, because the front desk asked about it twice already.";
const TOO_LONG = [...OPENING, PROSE, ...CONTACTS].join("\n");
const P = "com.google.Chrome/standard";
const INSTRUCTION = "fill in my phone and email from my note";

function desk(note: string): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("te/note", note, { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Class signup.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
  const fields = ["Phone", "Email"].map((l, i) => field(`${P}/textfield:${l.toLowerCase()}~0`, "", { parent: `${P}/webarea:~0`, label: l, frame: [100, 100 + 30 * i, 200, 20] }));
  m.apply(snap([node(`${P}/webarea:~0`, "AXWebArea", { label: "Register" }), ...fields], { at: 1000, windowId: "form", title: "Studio registration", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
  return m;
}

/** Every note a request's state carries (source_notes), joined: what an owner question there could show. */
const notesIn = (req: JevRequest): string => Object.values((req.state as { source_notes?: Record<string, string> }).source_notes ?? {}).join("\n");

/**
 * A Jev at confidence 1 that picks the card's phone and email, says every field wants the user's details, calls every
 * value exact, and answers an owner question "other" only when it, or a note it names in source_notes, disclaims the
 * lines; `owner` overrides that.
 */
function jev(owner?: () => "user" | "other"): AskJev {
  return async (req) => {
    const answers: Record<string, { choice: string; confidence: number }> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const ins = String(q.instructions);
      const crit = Object.keys(q.criteria);
      const shown = `${ins}\n${/in source_notes/u.test(ins) ? notesIn(req) : ""}`;
      if (req.purpose === "fill.verify") answers[id] = { choice: "exact", confidence: 1 };
      else if ("yes" in q.criteria) answers[id] = { choice: "yes", confidence: 1 };
      else if (crit.includes("user") && /Whose details is (?:it|this value)/u.test(ins)) answers[id] = { choice: owner?.() ?? (/\bneither\b[^.\n]*\bmine\b/iu.test(shown) ? "other" : "user"), confidence: 1 };
      else if (crit.includes("user")) answers[id] = { choice: "user", confidence: 1 };
      else {
        const want = /\bPhone\b/u.test(ins) ? PHONE : /\bEmail\b/u.test(ins) ? EMAIL : null;
        const hit = want === null ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`))?.[0];
        answers[id] = { choice: hit ?? (crit.includes("keep") ? "keep" : (crit.find((c) => c === "none") ?? crit[0] ?? "none")), confidence: 1 };
      }
    }
    return { model: "jev-ha2", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
}

/** The values a plan writes, or none when the planner refused it. */
const written = (run: Promise<{ checked: { writes: readonly { value: string }[] } }>): Promise<string[]> => run.then((d) => d.checked.writes.map((w) => w.value), () => []);

const writer: WriterPort = {
  route: FAKE_WRITER_ROUTE,
  async write() {
    const program = `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const form = await caret.readWindow();
  const all = [form, await caret.readWindow("w2" as WindowRef)];
  const steps: StepRef[] = [];
  for (const [label, text] of ${JSON.stringify([["Phone", PHONE], ["Email", EMAIL]])}) {
    const t = form.targets.find((x) => x.label === label);
    let v = null;
    for (const w of all) for (const x of w.values) if (v === null && x.display.startsWith('"' + text + '"')) v = x;
    if (t !== undefined && v !== null) steps.push(caret.fill(t.ref, v.ref));
  }
  return caret.plan({ basedOn: form.snapshot, steps });
}`;
    return { model: "fake", provider: "groq", output: { program, reply: program }, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, latencyMs: 1, costUsd: 0 };
  },
};

const viaPlanner = (note: string, ask: AskJev) => written(planTask(INSTRUCTION, desk(note), { values: () => [] }, { askJev: ask, offerKey: "ha2-plan", windowId: "form", now: 2000 }));
const viaWriter = (note: string, ask: AskJev) => written(planWithCode(INSTRUCTION, desk(note), { values: () => [] }, { writer, askJev: ask, offerKey: "ha2-code", windowId: "form", now: 2000 }));

beforeEach(() => setGeneratorClock(() => 0));
afterEach(() => setGeneratorClock(null));
beforeAll(() => setTestVerifier(null));
afterAll(() => setTestVerifier(STAND_IN));

describe.each([
  ["the native planner (planTask)", viaPlanner],
  ["the code writer (planWithCode)", viaWriter],
])("HA2 through %s", (_, via) => {
  it("writes neither the card's phone nor its email when the note disclaims them", async () => {
    const got = await via(DISCLAIMED, jev());
    expect(got).not.toContain(PHONE);
    expect(got).not.toContain(EMAIL);
  });

  it("writes neither from a note too long to show whole, even with 'user' and 'exact' at confidence 1", async () => {
    const got = await via(TOO_LONG, jev(() => "user"));
    expect(got).not.toContain(PHONE);
    expect(got).not.toContain(EMAIL);
  });

  it("still writes them from a note that fits, once Jev saw it and said 'user'", async () => {
    const got = await via([...OPENING, `Phone: ${PHONE}`, `Email: ${EMAIL}`].join("\n"), jev());
    expect(got.sort()).toEqual([EMAIL, PHONE].sort());
  });
});
