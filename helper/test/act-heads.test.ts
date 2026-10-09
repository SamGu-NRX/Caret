// Slice 1, "stop refusing" (design CU-COUNSEL-20261009): the route head read as settled, between two readings or unsure
// (readHead); a route between refusing and anything else refuses; a route between a fill and a larger task asks which,
// as a task question, only where both readings run; the firstGate record planAsk keeps for the scoreboard; the task
// question and the goal step's tier on the wire. Every name and value is synthetic.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { ASK_CHOICES_CAPABILITY, ASK_TASK_CAPABILITY, AskQuestion, ConsumerMessage, GoalStepView, HelperMessage, MAX_TASK_LABEL } from "../src/protocol.ts";
import type { AskJev, JevResult } from "../src/fill/jev.ts";
import { HEAD_FLOOR, headsIntentMaker, readHead, readHeads, scopeId } from "../src/planner/intent-heads.ts";
import { intentSnapshot } from "../src/planner/intent.ts";
import { answerQuestion, AskAsks, AskRefused, planAsk, type Gate } from "../src/planner/ask.ts";
import { taskChoices } from "../src/planner/choices.ts";
import { TASK_PLAN_LABEL, taskFillLabel } from "../src/planner/says.ts";
import { tierOf } from "../src/goals/runs.ts";
import type { WriterPort } from "../src/writer/port.ts";
import { GROQ_QWEN_3_8_27B as FAKE_ROUTE } from "../src/writer/config.ts";
import { field, node, scopeLabel, snap } from "./builders.ts";

describe("readHead", () => {
  it("settles an answer whose confidence clears the floor alone", () => {
    expect(readHead({ choice: "some", confidence: HEAD_FLOOR, probabilities: { some: 0.82, all: 0.1, plan: 0.05, refuse: 0.03 } })).toEqual({ kind: "settled", choice: "some", confidence: HEAD_FLOOR });
  });

  it("reads the top two as between when, merged, they clear the floor", () => {
    // Merged: 0.88 over three options, (0.88 - 1/3) / (2/3) = 0.82.
    const r = readHead({ choice: "all", confidence: 0.4, probabilities: { all: 0.45, some: 0.43, plan: 0.07, refuse: 0.05 } });
    expect(r.kind).toBe("between");
    if (r.kind !== "between") return;
    expect([r.a, r.b]).toEqual(["all", "some"]);
    expect(r.mass).toBeCloseTo(0.82, 5);
  });

  it("is unsure when the top two together stay under the floor", () => {
    // Merged: 0.70 over three options, (0.70 - 1/3) / (2/3) = 0.55.
    expect(readHead({ choice: "all", confidence: 0.2, probabilities: { all: 0.4, some: 0.3, plan: 0.2, refuse: 0.1 } })).toEqual({ kind: "unsure", top: "all", confidence: 0.2 });
  });

  it("is unsure without per-option probabilities, and never between two options only", () => {
    expect(readHead({ choice: "plan", confidence: 0.5 })).toEqual({ kind: "unsure", top: "plan", confidence: 0.5 });
    expect(readHead({ choice: "yes", confidence: 0.1, probabilities: { yes: 0.55, no: 0.45 } }).kind).toBe("unsure");
  });

  it("holds the floor it is given", () => {
    expect(readHead({ choice: "some", confidence: 0.6 }, 0.5).kind).toBe("settled");
  });
});

// A native form (no page window): Chrome's Accessibility tree as the reader records a web area, beside a note.
const NOTE_APP = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const FORM_APP = { pid: 7002, bundleId: "com.example.Forms", name: "Forms" };
const P = "com.example.Forms/standard";
function desk(): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("te/note", ["Trip notes", "Name: Harper Quinlan", "Email: harper.quinlan@example.com"].join("\n"), { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Trip notes.txt", app: NOTE_APP }));
  const fields = ["Full name", "Email"].map((l, i) => field(`${P}/textfield:${l.toLowerCase()}~0`, "", { parent: `${P}/group:~0`, label: l, frame: [100, 100 + 30 * i, 200, 20] }));
  m.apply(snap([node(`${P}/group:~0`, "AXGroup", { label: "Booking" }), ...fields], { at: 1000, windowId: "form", title: "Booking", app: FORM_APP, focused: true }));
  return m;
}

/** Jev: the route with `route`'s probabilities, why noSuchField, the scope ask choosing Full name, every value none. */
function jev(route: Record<string, number>, why = "noSuchField"): AskJev {
  const top = Object.entries(route).sort(([, x], [, y]) => y - x)[0] as [string, number];
  return async (req) => {
    const r: JevResult = { model: "t", inputTokens: 1, latencyMs: 1, costUsd: 0, answers: {} };
    if (req.purpose === "ask.heads") {
      r.answers = { route: { choice: top[0], confidence: 0.3 }, why: { choice: why, confidence: 0.95 }, source: { choice: "any", confidence: 0.95 }, whose: { choice: "user", confidence: 0.95 } };
      r.probabilities = { route };
      return r;
    }
    for (const [id, q] of Object.entries(req.questions)) {
      if (req.purpose === "ask.scope") r.answers[id] = id === "section" ? { choice: "fields", confidence: 0.99 } : { choice: scopeLabel(String(q.instructions)) === "Full name" ? "asks" : "not", confidence: 0.95 };
      else r.answers[id] = { choice: "none" in q.criteria ? "none" : (Object.keys(q.criteria)[0] ?? "none"), confidence: 0.95 };
    }
    return r;
  };
}

const writer: WriterPort = {
  route: FAKE_ROUTE,
  async write() {
    throw new Error("no write expected");
  },
};
const memory = { values: () => [] };
const BETWEEN_FILL_PLAN = { some: 0.5, plan: 0.42, all: 0.05, refuse: 0.03 };

describe("readHeads: between a refusal and anything else", () => {
  it("refuses for the why head's reason, and records the route head", () => {
    const m = desk();
    const s = intentSnapshot("pick my gender too", m, m.windows.get("form")!, []);
    const heads: JevResult = { model: "t", inputTokens: 1, latencyMs: 1, costUsd: 0, answers: { route: { choice: "some", confidence: 0.2 }, why: { choice: "noSuchField", confidence: 0.9 }, source: { choice: "any", confidence: 0.9 }, whose: { choice: "user", confidence: 0.9 } }, probabilities: { route: { some: 0.5, refuse: 0.45, all: 0.03, plan: 0.02 } } };
    const scope: JevResult = { model: "t", inputTokens: 1, latencyMs: 1, costUsd: 0, answers: { ...Object.fromEntries(s.fields.map((f) => [scopeId(f.ref), { choice: f.name === "Full name" ? "asks" : "not", confidence: 0.9 }])), section: { choice: "fields", confidence: 0.99 } } };
    const i = readHeads(s, heads, [scope, scope]);
    expect(i).toMatchObject({ route: "refuse", why: "noSuchField" });
    expect(i.routeHead?.kind).toBe("between");
  });
});

describe("the task question", () => {
  const ask = (route: Record<string, number>, o: { tasks?: boolean; writer?: WriterPort | null; goals?: boolean; gate?: (g: Gate) => void } = {}) => {
    const j = jev(route);
    return planAsk("book it for me", desk(), memory, [], { askJev: j, maker: headsIntentMaker(j), writer: o.writer === undefined ? writer : o.writer, offerKey: "k", windowId: "form", now: 2000, tasks: o.tasks ?? true, ...(o.goals === undefined ? {} : { goals: o.goals }), ...(o.gate === undefined ? {} : { gate: o.gate }) });
  };

  it("asks which reading, fill first, when the route is between a fill and a plan and both run", async () => {
    const gates: Gate[] = [];
    const e = await ask(BETWEEN_FILL_PLAN, { gate: (g) => gates.push(g) }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    const q = (e as AskAsks).question;
    expect(q.part).toBe("task");
    expect(q.pick).toBe("one");
    expect(q.options.map((c) => c.option)).toEqual([
      { kind: "task", id: "o1", label: "Only fill Full name", says: "Fills them in and stops there. Pressing and sending stay yours." },
      { kind: "task", id: "o2", label: TASK_PLAN_LABEL, says: "Shows every step before anything runs. Sending stays yours." },
    ]);
    expect(gates.map((g) => g.gate)).toEqual(["routeBetween"]);
  });

  it("with the task question off, a route that names plan beside a chosen field does not count as a plan blocker", async () => {
    // The Ask goes on as the fill it reads as (firstGate in ask.ts): "plan" can block only through the task question.
    for (const route of [BETWEEN_FILL_PLAN, { plan: 0.4, some: 0.25, all: 0.2, refuse: 0.15 }]) {
      const gates: Gate[] = [];
      await ask(route, { tasks: false, gate: (g) => gates.push(g) }).catch((x: unknown) => x);
      const head = gates.filter((g) => g.gate === "routeBetween" || g.gate === "routeFloor");
      expect(head).toHaveLength(1);
      expect(head[0]?.blocking).toBe(false);
    }
  });

  it("continues as the fill on the fill pick, and asks no task question again", async () => {
    const e = (await ask(BETWEEN_FILL_PLAN).catch((x: unknown) => x)) as AskAsks;
    const resume = answerQuestion(e.question, ["o1"]);
    if (typeof resume === "string") throw new Error(resume);
    expect(resume.fixed.task).toBe("fill");
    const j = jev(BETWEEN_FILL_PLAN);
    const after = await planAsk("book it for me", desk(), memory, [], { askJev: j, maker: headsIntentMaker(j), writer, offerKey: "k", windowId: "form", now: 2000, tasks: true, resume }).catch((x: unknown) => x);
    // Jev answers every value "none": the fill finds nothing, and says so rather than asking about the task again.
    expect(after).toBeInstanceOf(AskRefused);
    expect(after).not.toBeInstanceOf(AskAsks);
    expect((after as AskRefused).intent?.route).toBe("fill");
  });

  it("continues as the plan on the plan pick: a goal for a host that runs goals", async () => {
    const e = (await ask(BETWEEN_FILL_PLAN, { goals: true }).catch((x: unknown) => x)) as AskAsks;
    expect(e.question.part).toBe("task");
    const resume = answerQuestion(e.question, ["o2"]);
    if (typeof resume === "string") throw new Error(resume);
    const j = jev(BETWEEN_FILL_PLAN);
    const g = await planAsk("book it for me", desk(), memory, [], { askJev: j, maker: headsIntentMaker(j), writer, offerKey: "k", windowId: "form", now: 2000, tasks: true, goals: true, resume });
    expect(g.route).toBe("goal");
  });

  it("is not asked without the capability, without a writer, or when the route is between two fills", async () => {
    for (const o of [{ tasks: false }, { writer: null }]) {
      const e = await ask(BETWEEN_FILL_PLAN, o).catch((x: unknown) => x);
      expect(e instanceof AskAsks && e.question.part === "task").toBe(false);
    }
    const e = await ask({ some: 0.5, all: 0.42, plan: 0.05, refuse: 0.03 }).catch((x: unknown) => x);
    expect(e instanceof AskAsks && e.question.part === "task").toBe(false);
  });

  it("labels the fill by its fields while they fit, else by their count", () => {
    expect(taskFillLabel([], MAX_TASK_LABEL)).toBe("Fill some fields");
    expect(taskFillLabel(["Name", "Email"], MAX_TASK_LABEL)).toBe("Only fill Name and Email");
    expect(taskFillLabel(["A very long field label for the first", "Another very long field label too"], 40)).toBe("Only fill 2 fields");
    expect(taskChoices(["Name"]).options.map((c) => c.fixes.task)).toEqual(["fill", "plan"]);
  });
});

describe("firstGate", () => {
  it("records a refusal of a kind Caret never types before anything else", async () => {
    const gates: Gate[] = [];
    const j = jev({ some: 0.9, all: 0.05, plan: 0.03, refuse: 0.02 });
    await planAsk("put my social security number in", desk(), memory, [], { askJev: j, maker: headsIntentMaker(j), writer: null, offerKey: "k", windowId: "form", now: 2000, gate: (g) => gates.push(g) }).catch(() => null);
    expect(gates).toEqual([{ gate: "refuse:neverTyped", blocking: true, detail: "the instruction only asks for a kind Caret never types" }]);
  });
});

describe("the task question and the step tier on the wire", () => {
  const base = { type: "askQuestion", v: 1, requestId: "ask-1", at: 1, questionId: "q1", part: "task", text: "Which should Caret do?", pick: "one", window: { pid: 1, windowId: "w", appName: "Forms", title: "Booking" }, expires: 2 };
  const fill = { kind: "task", id: "o1", label: "Only fill Full name", says: "Fills them in and stops there." };
  const plan = { kind: "task", id: "o2", label: "Do the whole task", says: "Shows every step before anything runs." };

  it("takes two or more task readings, one picked", () => {
    expect(AskQuestion.safeParse({ ...base, options: [fill, plan] }).success).toBe(true);
  });

  it("refuses one reading, a long label, many picks, a filling list, and a task in another part", () => {
    expect(AskQuestion.safeParse({ ...base, options: [fill] }).success).toBe(false);
    expect(AskQuestion.safeParse({ ...base, options: [{ ...fill, label: "x".repeat(MAX_TASK_LABEL + 1) }, plan] }).success).toBe(false);
    expect(AskQuestion.safeParse({ ...base, pick: "many", options: [fill, plan] }).success).toBe(false);
    expect(AskQuestion.safeParse({ ...base, options: [fill, plan], filling: ["Full name"] }).success).toBe(false);
    expect(AskQuestion.safeParse({ ...base, part: "fields", pick: "many", options: [fill, plan] }).success).toBe(false);
  });

  it("carries a step's tier, and tiers a press handed to the user apart from a field handed over", () => {
    expect(GoalStepView.safeParse({ index: 0, kind: "handoff", says: "you press Send", tier: "yours" }).success).toBe(true);
    expect(GoalStepView.safeParse({ index: 0, kind: "handoff", says: "you press Send", tier: "pay" }).success).toBe(false);
    const target = (control: string) => ({ control }) as never;
    expect(tierOf({ kind: "handoff", target: target("button") })).toBe("yours");
    expect(tierOf({ kind: "handoff", target: target("select") })).toBe("write");
    expect(tierOf({ kind: "press", target: target("button") })).toBe("navigate");
    expect(tierOf({ kind: "calendar", target: target("calendar") })).toBe("write");
    expect(tierOf({ kind: "attach", target: target("file") })).toBe("attach");
  });
});

describe("the ask-task golden lines (fixtures/golden/ask-task.ndjson, copied into the host's fixtures)", () => {
  const lines = readFileSync(new URL("../fixtures/golden/ask-task.ndjson", import.meta.url), "utf8").trim().split("\n");
  const CONSUMER = new Set(["hello", "planRequest", "askAnswer", "goalEdit", "goalAccept"]);

  it("parses every line and writes it back byte for byte", () => {
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(["hello", "planRequest", "askQuestion", "askAnswer", "goalProgress", "goalEdit", "goalProgress", "goalAccept", "goalProgress"]);
    for (const l of lines) {
      const m = JSON.parse(l) as { type: string };
      expect(JSON.stringify((CONSUMER.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), m.type).toBe(l);
    }
  });

  it("declares askTask beside askChoices, and ends the window segment with the user's press", () => {
    expect((JSON.parse(lines[0] as string) as { capabilities: string[] }).capabilities).toEqual(expect.arrayContaining([ASK_CHOICES_CAPABILITY, ASK_TASK_CAPABILITY]));
    const seg = JSON.parse(lines[4] as string) as { steps: { tier: string }[] };
    expect(seg.steps.map((s) => s.tier)).toEqual(["write", "write", "yours"]);
  });
});
