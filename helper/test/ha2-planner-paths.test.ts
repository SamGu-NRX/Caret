// HA2 (lead decision 3): the native planner's and the code writer's whose questions meet fill's rule. A value read from
// a window, for a field both asks say wants the user's details, counts only when both owner questions showed the whole
// note it was read from; otherwise it is dropped. Fresh synthetic fixtures, the same as ha2-owner-evidence.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setTestVerifier } from "../src/fill/contract.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { ScreenModel } from "../src/model.ts";
import { planWithCode } from "../src/planner/codeplan.ts";
import { planTask } from "../src/planner/planner.ts";
import type { WriterPort } from "../src/writer/port.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import { field, node, snap } from "./builders.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { buildInventory } from "../src/goals/inventory.ts";
import { GoalError, lowerGoal } from "../src/goals/lower.ts";
import type { GoalInventory, GoalPlan } from "../src/goals/plan.ts";
import type { DraftPlan } from "../src/codemode/types.ts";
import { macClock } from "../src/offers/event-time.ts";

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
/** A note line over 80 characters, so the note has prose; LONG_PROSE is enough of them to pass the 2,000-character owner-note allotment (privacy.ts OWNER_NOTE_CHARS). */
const PROSE = "Reminder to myself: bring the receipt from last term, because the front desk asked about it twice already.";
const LONG_PROSE = Array.from({ length: 20 }, (_, i) => `${PROSE} (${i + 1})`).join("\n");
const TOO_LONG = [...OPENING, LONG_PROSE, ...CONTACTS].join("\n");
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

describe("HA2 through a writer goal (lowerGoal and its value gate, goals/gates.ts jevGate)", () => {
  /** A writer's plan that copies the note's phone and email into the form, lowered against the inventory frozen now. */
  async function goal(note: string, ask: AskJev, change?: (inv: GoalInventory) => GoalInventory): Promise<GoalPlan | GoalError> {
    const model = desk(note);
    const inv = buildInventory(model, { instruction: INSTRUCTION, windows: ["form"], memory: [], calendar: null, clock: macClock(new Date(2000)), now: 2000, readerSession: 1 });
    const target = (label: string): string => [...inv.inventory.targets.values()].find((t) => t.label === label)?.ref ?? "";
    const value = (text: string): string => [...inv.inventory.values.values()].find((v) => v.text === text)?.ref ?? "";
    const steps: DraftPlan["steps"] = [{ ref: "a", kind: "fill", target: target("Phone"), value: value(PHONE) }, { ref: "b", kind: "fill", target: target("Email"), value: value(EMAIL) }];
    expect(steps.every((x) => x.kind === "fill" && x.target !== "" && x.value !== "")).toBe(true);
    const draft: DraftPlan = { basedOn: inv.inventory.revisions.get("form") ?? "", window: "form", steps, choices: [], drafts: [], programDigest: "b".repeat(64) };
    return lowerGoal("ha2-goal", INSTRUCTION, draft, change === undefined ? inv.inventory : change(inv.inventory), { askJev: ask, ledger: inv.ledger }).catch((e: unknown) => {
      if (e instanceof GoalError) return e;
      throw e;
    });
  }
  const writes = (g: GoalPlan | GoalError): string[] => (g instanceof GoalError ? [] : g.segments.flatMap((x) => x.steps.flatMap((y) => (y.kind === "write" && y.writes !== null ? [y.writes] : []))));

  it("writes neither the card's phone nor its email when the note disclaims them", async () => {
    const got = writes(await goal(DISCLAIMED, jev()));
    expect(got).not.toContain(PHONE);
    expect(got).not.toContain(EMAIL);
  });

  it("writes neither from a note too long to show whole, even with 'user' and 'exact' at confidence 1", async () => {
    const got = writes(await goal(TOO_LONG, jev(() => "user")));
    expect(got).not.toContain(PHONE);
    expect(got).not.toContain(EMAIL);
  });

  it("writes neither when the inventory froze no note for them, even with 'user' and 'exact' at confidence 1", async () => {
    const fits = [...OPENING, `Phone: ${PHONE}`, `Email: ${EMAIL}`].join("\n");
    const got = writes(await goal(fits, jev(() => "user"), (inv) => ({ ...inv, notes: new Map() })));
    expect(got).toEqual([]);
  });

  it("writes them from a note that fits, once Jev saw it and said 'user', and counts the gate's two requests", async () => {
    const g = await goal([...OPENING, `Phone: ${PHONE}`, `Email: ${EMAIL}`].join("\n"), jev());
    expect(writes(g).sort()).toEqual([EMAIL, PHONE].sort());
    expect(g instanceof GoalError ? null : g.jev?.calls).toBe(2);
  });
});

describe("HA2: the owner checks count toward the draft's Jev use", () => {
  it("adds the planner's two owner-check requests to its calls", async () => {
    const purposes: string[] = [];
    const counted: AskJev = async (req) => {
      purposes.push(req.purpose ?? "");
      return jev()(req);
    };
    const d = await planTask(INSTRUCTION, desk([...OPENING, `Phone: ${PHONE}`, `Email: ${EMAIL}`].join("\n")), { values: () => [] }, { askJev: counted, offerKey: "ha2-plan", windowId: "form", now: 2000 });
    expect(purposes.filter((p) => p === "plan.verify")).toHaveLength(2);
    // The write contract's verifier (fill.verify) is counted by its own use record (fill/contract.ts VerifyUse), not here.
    expect(d.jev.calls).toBe(purposes.filter((p) => p !== "fill.verify").length);
  });
});
