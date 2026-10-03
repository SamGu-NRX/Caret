// The planner (brief B16): instruction spans, value tracing and the plan check are each tested on
// their own, since each has one right answer; then planTask with a fake Jev on a synthetic desk, and the
// helper's planRequest, proposal and accept under an act grant. Everything here is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { ScreenModel } from "../src/model.ts";
import { HelperMessage, PlanProposal, PROTOCOL_VERSION, type Node, type PlanErrorCode, type TaskProgress } from "../src/protocol.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import type { Plan, Step } from "../src/executor/schema.ts";
import { instructionValues } from "../src/planner/spans.ts";
import { occursBounded, traceValue, type MemoryValue } from "../src/planner/trace.ts";
import { handoffWhy, PlannerError, validatePlan } from "../src/planner/validate.ts";
import { planTask, type PlanTaskOptions } from "../src/planner/planner.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import { MAIL_APP, snap, text } from "./builders.ts";
import { executorWindow, FakeApp, K, TITLE, WIN, wireButtons } from "./fake-app.ts";

const REF = "6160-2";
const REF_TITLE = "Mail Fixture — Order";
function referenceWindow(at = 500): ReturnType<typeof snap> {
  const M = (s: string): string => `dev.caret.mail/standard/${s}`;
  return snap(
    [
      text(M("statictext:order number: ord-#-#~0"), "Order number: ORD-2026-48213"),
      text(M("statictext:dana whitfield~0"), "Dana Whitfield"),
      text(M("statictext:dana.whitfield@lumenlabs.example~0"), "dana.whitfield@lumenlabs.example"),
    ],
    { at, windowId: REF, title: REF_TITLE, app: MAIL_APP, values: [{ kind: "id", text: "ORD-2026-48213", nodeKey: M("statictext:order number: ord-#-#~0") }, { kind: "email", text: "dana.whitfield@lumenlabs.example", nodeKey: M("statictext:dana.whitfield@lumenlabs.example~0") }] },
  );
}

/** A model holding the fake app's executor window and the reference window. */
function desk(nodes: Node[] = executorWindow()): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap(nodes, { at: 1000, windowId: WIN, title: TITLE }));
  m.apply(referenceWindow());
  return m;
}

const W = { bundleId: "dev.caret.fixture", title: TITLE };
const write = (key: string, value: string): Step => ({ says: `${key} holds ${value}`, end: { kind: "valueEquals", window: W, target: { key, describe: key }, value } });
const plan = (steps: Step[]): Plan => ({ id: "p", title: "p", slots: {}, steps });
const noMemory: MemoryValue[] = [];

function code(f: () => unknown): PlanErrorCode | "passed" {
  try {
    f();
    return "passed";
  } catch (e) {
    if (e instanceof PlannerError) return e.code;
    throw e;
  }
}

describe("instruction spans", () => {
  it("finds quoted text, typed values, and the object of 'to' and 'put … in'", () => {
    expect(instructionValues("Set Name to Priya Raman")).toEqual(["Priya Raman"]);
    expect(instructionValues("Write 'Running ten minutes late' in Message")).toEqual(["Running ten minutes late"]);
    expect(instructionValues("Set the shipping city to Austin and the shipping street to 1200 Barton Springs Rd")).toEqual(["Austin", "1200 Barton Springs Rd"]);
    expect(instructionValues("Put ORD-2026-48213 in Reference")).toEqual(["ORD-2026-48213"]);
    expect(instructionValues("Email dana@example.com about the $1,315.50 refund at 3:30 PM")).toEqual(["dana@example.com", "$1,315.50", "3:30 PM"]);
    expect(instructionValues('Write "Go to bed" in Notes')).toEqual(["Go to bed"]);
  });

  it("offers no description as a value, and nothing from Dana's apostrophe", () => {
    expect(instructionValues("Put the tracking number in Notes")).toEqual([]);
    expect(instructionValues("Copy Dana's email address from her signature into Email")).toEqual([]);
    expect(instructionValues("Set Email to my work email")).toEqual([]);
  });
});

describe("value tracing", () => {
  it("matches whole words only", () => {
    expect(occursBounded("Dana Whitfield", "Dana")).toBe(true);
    expect(occursBounded("Danae Whitfield", "Dana")).toBe(false);
    expect(occursBounded("Total: $1,315.50", "$1,315.50")).toBe(true);
    expect(occursBounded("ORD-2026-48213", "2026")).toBe(true);
    expect(occursBounded("x", "")).toBe(false);
  });

  it("traces to a window line or title first, then memory, then the instruction, and never to a secure field", () => {
    const m = desk([...executorWindow(), { key: K("securetextfield:pin~0"), parent: null, role: "AXTextField", editable: true, value: "4471", states: ["secure"] }]);
    const mem: MemoryValue[] = [{ id: "about-1", label: "Work email", text: "sam@example.com" }];
    expect(traceValue("ORD-2026-48213", m, mem, "")).toEqual({ from: "window", windowId: REF, nodeKey: "dev.caret.mail/standard/statictext:order number: ord-#-#~0" });
    expect(traceValue("Mail Fixture", m, mem, "")).toEqual({ from: "window", windowId: REF, nodeKey: null });
    expect(traceValue("sam@example.com", m, mem, "")).toEqual({ from: "memory", id: "about-1" });
    expect(traceValue("Lisbon", m, mem, "Set the billing city to Lisbon")).toEqual({ from: "instruction" });
    expect(traceValue("4471", m, mem, "")).toBeNull();
    expect(traceValue("Lisbo", m, mem, "Set the billing city to Lisbon")).toBeNull();
    expect(traceValue("", m, mem, "")).toBeNull();
    expect(traceValue("  Dana   Whitfield ", m, mem, "")).not.toBeNull();
  });
});

describe("the plan check", () => {
  const ctx = (instruction = "", memory = noMemory, model = desk()) => ({ model, memory, instruction });

  it("passes a plan of traced writes and a hand-off, and reports each write's source", () => {
    const p = plan([
      write(K("textfield:name~0"), "Dana Whitfield"),
      write(K("group:billing/textfield:city~0"), "Lisbon"),
      { says: "You press Send", end: { kind: "handoff", window: W, target: { key: K("button:send~0"), describe: "Send" }, why: "outbound" } },
    ]);
    const c = validatePlan(p, {}, ctx("Set the billing city to Lisbon"));
    expect(c.writes.map((w) => w.trace.from)).toEqual(["window", "instruction"]);
    expect(c.handoff).toMatchObject({ step: 2, label: "Send", why: "outbound" });
    expect(c.window.window.windowId).toBe(WIN);
  });

  it("refuses each broken rule with its own code", () => {
    const ok = write(K("textfield:name~0"), "Dana Whitfield");
    const handoff = (key: string, why: "outbound" | "unverifiable" | "money"): Step => ({ says: "press", end: { kind: "handoff", window: W, target: { key, describe: key }, why } });
    expect(code(() => validatePlan({ id: "p" }, {}, ctx()))).toBe("schema");
    expect(code(() => validatePlan({ ...plan([write(K("textfield:name~0"), "{{n}}")]), slots: { n: "name" } }, {}, ctx()))).toBe("schema");
    expect(code(() => validatePlan(plan([{ says: "event", end: { kind: "calendarEvent", calendar: "c", title: "Dana Whitfield", start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00" } }]), {}, ctx()))).toBe("unsupportedStep");
    expect(code(() => validatePlan(plan([{ ...ok, via: { kind: "press", target: { label: "Send", describe: "Send" } } }]), {}, ctx()))).toBe("unsupportedStep");
    expect(code(() => validatePlan(plan([{ says: "front", end: { kind: "windowFocused", window: W } }]), {}, ctx()))).toBe("unsupportedStep");
    expect(code(() => validatePlan(plan([ok, { ...ok, end: { ...ok.end, window: { title: REF_TITLE } } as Step["end"] }]), {}, ctx()))).toBe("multipleWindows");
    expect(code(() => validatePlan(plan([{ ...ok, end: { ...ok.end, window: { title: "Nowhere" } } as Step["end"] }]), {}, ctx()))).toBe("unknownWindow");
    const twice = desk();
    twice.apply(snap(executorWindow(), { at: 1000, windowId: "5150-8", title: TITLE }));
    expect(code(() => validatePlan(plan([ok]), {}, ctx("", noMemory, twice)))).toBe("ambiguousWindow");
    expect(code(() => validatePlan(plan([write(K("textfield:fax~0"), "Dana Whitfield")]), {}, ctx()))).toBe("unknownTarget");
    const byLabel: Step = { says: "city", end: { kind: "valueEquals", window: W, target: { role: "AXTextField", label: "City", describe: "a city" }, value: "Lisbon" } };
    expect(code(() => validatePlan(plan([byLabel]), {}, ctx("to Lisbon")))).toBe("ambiguousTarget");
    expect(code(() => validatePlan(plan([write(K("button:archive~0"), "Dana Whitfield")]), {}, ctx()))).toBe("notEditable");
    const secure = desk([...executorWindow(), { key: K("textfield:pin~0"), parent: null, role: "AXTextField", editable: true, states: ["secure"] }]);
    expect(code(() => validatePlan(plan([write(K("textfield:pin~0"), "Dana Whitfield")]), {}, ctx("", noMemory, secure)))).toBe("notEditable");
    expect(code(() => validatePlan(plan([write(K("textfield:name~0"), "Dana W.")]), {}, ctx()))).toBe("untracedValue");
    expect(code(() => validatePlan(plan([write(K("textfield:name~0"), "")]), {}, ctx()))).toBe("untracedValue");
    expect(code(() => validatePlan(plan([handoff(K("button:archive~0"), "unverifiable"), ok]), {}, ctx()))).toBe("stepAfterHandoff");
    expect(code(() => validatePlan(plan([handoff(K("button:send~0"), "unverifiable")]), {}, ctx()))).toBe("riskMismatch");
    expect(code(() => validatePlan(plan([handoff(K("button:archive~0"), "money")]), {}, ctx()))).toBe("riskMismatch");
    expect(code(() => validatePlan(plan([handoff(K("button:~0"), "unverifiable")]), {}, ctx()))).toBe("passed");
  });

  it("reads hand-off reasons from the risk table", () => {
    expect([handoffWhy("Send"), handoffWhy("Delete draft"), handoffWhy("Pay invoice"), handoffWhy("Archive"), handoffWhy("")]).toEqual(["outbound", "destructive", "money", "unverifiable", "unverifiable"]);
  });
});

// MARK: - planTask with a fake Jev

interface Oracle {
  window?: string;
  /** Field name (section and label) to the value it should get. */
  fields?: Record<string, string>;
  press?: string;
  conf?: number;
  /** A field the second ask answers differently, as keep. */
  flip?: string;
}

/** Answers planner questions by text, so the shuffled and renumbered second ask gets the same answer. */
function plannerJev(o: Oracle): AskJev & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  const fn = async (req: JevRequest) => {
    requests.push(req);
    const answers: Record<string, { choice: string; confidence: number }> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const ins = String(q.instructions);
      const second = ins.startsWith("Instruction:");
      const find = (pred: (describe: string) => boolean): string | undefined => Object.entries(q.criteria).find(([, d]) => d !== null && pred(String(d)))?.[0];
      let choice: string | undefined;
      if (id === "window") choice = o.window === undefined ? "none" : find((d) => d.endsWith(`'${o.window}'`));
      else if (id === "press") choice = o.press === undefined ? "none" : find((d) => d === `the '${o.press}' button`);
      else {
        const label = /Label: '([^']+)'/.exec(ins)?.[1];
        const section = /Section: '([^']+)'/.exec(ins)?.[1];
        const name = [section, label].filter((x) => x !== undefined).join(" ");
        const want = o.fields?.[name];
        choice = want === undefined || (second && o.flip === name) ? "keep" : find((d) => d.startsWith(`"${want}"`));
      }
      if (choice === undefined) throw new Error(`the fake Jev found no option for ${id}`);
      answers[id] = { choice, confidence: o.conf ?? 0.9 };
    }
    return { model: "jev-test", answers, inputTokens: 100, latencyMs: 5, costUsd: 0.0000042 };
  };
  return Object.assign(fn, { requests });
}

describe("planTask", () => {
  const opts = (askJev: AskJev, extra: Partial<PlanTaskOptions> = {}): PlanTaskOptions => ({ askJev, offerKey: "plan-1", now: 2000, rand: () => 0, ...extra });
  const mem = (values: MemoryValue[] = []) => ({ values: () => values });

  it("writes values from a window, the instruction and memory, keyed by element, with window sources recorded", async () => {
    const jev = plannerJev({ window: TITLE, fields: { Name: "Dana Whitfield", "Billing City": "Lisbon", Email: "sam@example.com" } });
    const d = await planTask("Name is Dana Whitfield, set the billing city to Lisbon and Email to my work email", desk(), mem([{ id: "about-1", label: "Work email", text: "sam@example.com" }]), opts(jev));
    expect(d.plan.steps.map((s) => s.end)).toEqual([
      { kind: "valueEquals", window: W, target: { key: K("textfield:name~0"), describe: "the Name field" }, value: "{{v1}}" },
      { kind: "valueEquals", window: W, target: { key: K("textfield:email~0"), describe: "the Email field" }, value: "{{v2}}" },
      { kind: "valueEquals", window: W, target: { key: K("group:billing/textfield:city~0"), describe: "the Billing City field" }, value: "{{v3}}" },
    ]);
    expect(d.slots).toEqual({ v1: "Dana Whitfield", v2: "sam@example.com", v3: "Lisbon" });
    expect(d.plan.sources).toEqual({ v1: REF });
    expect(d.checked.writes.map((w) => w.trace.from)).toEqual(["window", "memory", "instruction"]);
    // Two windows have fields or buttons? Only the executor window does, so no window question was asked.
    expect(jev.requests).toHaveLength(2);
    expect(d.jev.calls).toBe(2);
  });

  it("asks which window when several could carry the task, and skips the question when the host names one", async () => {
    const m = desk();
    m.apply(snap([{ key: "dev.caret.mail/standard/textfield:to~0", parent: null, role: "AXTextField", label: "To", editable: true }], { at: 1500, windowId: "6160-3", title: "Mail Fixture — Compose", app: MAIL_APP }));
    const jev = plannerJev({ window: TITLE, fields: { Name: "Dana Whitfield" } });
    const d = await planTask("Set Name to Dana Whitfield", m, mem(), opts(jev));
    expect(d.answers.window).toEqual([WIN, WIN]);
    expect(jev.requests).toHaveLength(4);
    const direct = plannerJev({ fields: { Name: "Dana Whitfield" } });
    await planTask("Set Name to Dana Whitfield", m, mem(), opts(direct, { windowId: WIN }));
    expect(direct.requests).toHaveLength(2);
    await expect(planTask("Set Name to Dana Whitfield", m, mem(), opts(plannerJev({}), {}))).rejects.toMatchObject({ code: "noWindow" });
  });

  it("hands a Send press back as outbound and a safe press as unverifiable, after the writes", async () => {
    const d = await planTask("Write 'See you at 3' in Name and send it", desk(), mem(), opts(plannerJev({ fields: { Name: "See you at 3" }, press: "Send" })));
    expect(d.plan.steps.at(-1)?.end).toEqual({ kind: "handoff", window: W, target: { key: K("button:send~0"), describe: "the Send button" }, why: "outbound" });
    expect(d.checked.handoff?.why).toBe("outbound");
    const a = await planTask("Archive the order", desk(), mem(), opts(plannerJev({ press: "Archive" })));
    expect(a.plan.steps).toHaveLength(1);
    expect(a.checked.handoff).toMatchObject({ label: "Archive", why: "unverifiable" });
  });

  it("refuses when the asks disagree, agree too weakly, find nothing, or the request fails", async () => {
    await expect(planTask("Set Name to Dana Whitfield", desk(), mem(), opts(plannerJev({ fields: { Name: "Dana Whitfield" }, flip: "Name" })))).rejects.toMatchObject({ code: "unsure" });
    await expect(planTask("Set Name to Dana Whitfield", desk(), mem(), opts(plannerJev({ fields: { Name: "Dana Whitfield" }, conf: 0.6 })))).rejects.toMatchObject({ code: "unsure" });
    await expect(planTask("Set the fax number to 555-0100", desk(), mem(), opts(plannerJev({})))).rejects.toMatchObject({ code: "nothingToDo" });
    const broken: AskJev = () => Promise.reject(new Error("HTTP 500"));
    await expect(planTask("Set Name to Dana Whitfield", desk(), mem(), opts(broken))).rejects.toMatchObject({ code: "jevFailed" });
  });

  it("checks the plan against the screen and memory as they are after Jev answered", async () => {
    const m = desk();
    const gone = planTask("Set Name to Dana Whitfield", m, mem(), opts(plannerJev({ fields: { Name: "Dana Whitfield" } }), {
      beforeCheck: async () => void m.apply(snap(executorWindow().filter((n) => n.key !== K("textfield:name~0")), { at: 3000, windowId: WIN, title: TITLE })),
    }));
    await expect(gone).rejects.toMatchObject({ code: "unknownTarget" });
    let values: MemoryValue[] = [{ id: "about-2", label: "Home city", text: "Porto" }];
    const forgotten = planTask("Put my home city in the billing city", desk(), { values: () => values }, opts(plannerJev({ fields: { "Billing City": "Porto" } }), {
      beforeCheck: async () => void (values = []),
    }));
    await expect(forgotten).rejects.toMatchObject({ code: "untracedValue" });
  });

  it("declares every piece of screen text it sends and offers no secure field", async () => {
    const jev = plannerJev({ fields: { Name: "Dana Whitfield" } });
    const m = desk([...executorWindow(), { key: K("textfield:pin~0"), parent: null, role: "AXTextField", label: "PIN", editable: true, states: ["secure"] }]);
    await planTask("Set Name to Dana Whitfield", m, mem(), opts(jev));
    const req = jev.requests[0] as JevRequest;
    expect(JSON.stringify(req.questions)).not.toContain("PIN");
    expect(req.snippets.some((s) => s.windowId === REF && s.text.includes("ORD-2026-48213"))).toBe(true);
    expect(req.snippets.some((s) => s.windowId === "plan" && s.text === "Set Name to Dana Whitfield")).toBe(true);
  });
});

// MARK: - the helper: planRequest, proposal, accept under a grant

describe("planRequest through the helper", () => {
  let dir: string;
  let store: Store;
  let app: FakeApp;
  let helper: Helper;
  let published: HelperMessage[];
  let jev: AskJev;
  let memory: MemoryStore;
  let clock: number;

  const progress = (taskId: string): TaskProgress[] => published.filter((m): m is TaskProgress => m.type === "taskProgress" && m.taskId === taskId);
  const request = (instruction: string, requestId = "r1") => helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId, at: clock, instruction });
  const accept = (offerId: string) => helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId, actionId: "run", overrides: {}, at: clock });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-plan-"));
    store = new Store(join(dir, "data"));
    memory = new MemoryStore(join(dir, "data"));
    app = new FakeApp(executorWindow());
    wireButtons(app);
    app.enforceGrants = true;
    published = [];
    clock = 10_000;
    jev = plannerJev({});
    helper = new Helper({ store, memory, askJev: (r) => jev(r), shadow: false, allowBackgroundFocus: false, publish: (m) => published.push(m), readerLink: app, now: () => clock });
    app.helper = helper;
    app.show();
    void helper.handleReader(referenceWindow());
  });
  afterEach(() => {
    for (const m of published) HelperMessage.parse(m);
    memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("proposes without acting, then runs the plan under a grant for its window when accepted", async () => {
    jev = plannerJev({ fields: { Name: "Dana Whitfield", "Shipping City": "Austin" } });
    const r = await request("Set Name to Dana Whitfield and the shipping city to Austin");
    expect(PlanProposal.parse(r)).toMatchObject({ outcome: "proposed", offerKey: "plan-1-r1", window: { windowId: WIN }, handoff: null, error: null });
    expect(r.spec?.blocks.map((b) => b.type)).toEqual(["header", "fields", "actions"]);
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(0);
    const res = await accept("plan-1-r1");
    expect(res).toMatchObject({ outcome: "done", acted: 2 });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana Whitfield");
    expect(app.node(K("group:shipping/textfield:city~0"))?.value).toBe("Austin");
    expect(app.grants.log.map((g) => g.type)).toEqual(["actGrant", "actRevoke"]);
    expect(published.some((m) => m.type === "offerWithdrawn" && m.id === "plan-1-r1" && m.reason === "taken")).toBe(true);
    // An offer runs once.
    expect(await accept("plan-1-r1")).toBeNull();
  });

  it("hands Send back without pressing it", async () => {
    jev = plannerJev({ fields: { Name: "Running late" }, press: "Send" });
    const r = await request("Write 'Running late' in Name and send it");
    expect(r.handoff).toEqual({ label: "Send", why: "outbound" });
    const res = await accept(r.offerKey ?? "");
    expect(res).toMatchObject({ outcome: "handoff", step: 1, acted: 1 });
    expect(app.verbs.some((v) => v.kind === "press")).toBe(false);
    expect(app.node(K("statictext:sent!~0"))).toBeUndefined();
    expect(progress(r.offerKey ?? "").at(-1)?.phase).toBe("handoff");
  });

  it("refuses an accept whose plan no longer passes the check, and writes nothing", async () => {
    jev = plannerJev({ fields: { Name: "Dana Whitfield" } });
    const r = await request("Set Name to Dana Whitfield");
    app.nodes = app.nodes.filter((n) => n.key !== K("textfield:name~0"));
    app.show();
    expect(await accept(r.offerKey ?? "")).toBeNull();
    expect(published.some((m) => m.type === "error" && m.message.includes("unknownTarget"))).toBe(true);
    expect(progress(r.offerKey ?? "").at(-1)).toMatchObject({ phase: "stopped", stopReason: "refused" });
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(0);
  });

  it("stops the run when the user types into a destination after the proposal", async () => {
    jev = plannerJev({ fields: { Name: "Dana Whitfield" } });
    const r = await request("Set Name to Dana Whitfield");
    app.setValue(K("textfield:name~0"), "Priya");
    app.show();
    expect(await accept(r.offerKey ?? "")).toMatchObject({ outcome: "stopped" });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Priya");
  });

  it("answers with a code when it cannot plan, and withdraws an untaken proposal after its lifetime", async () => {
    expect((await request("Set the fax number to 555-0100")).error?.code).toBe("nothingToDo");
    helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: clock, roles: ["fill"], level: "balanced", paused: true });
    expect((await request("Set Name to Dana Whitfield", "r2")).error?.code).toBe("unavailable");
    helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: clock, roles: ["fill"], level: "balanced", paused: false });
    jev = plannerJev({ fields: { Name: "Dana Whitfield" } });
    const r = await request("Set Name to Dana Whitfield", "r3");
    clock += 5 * 60 * 1000;
    helper.tick(clock);
    expect(published.some((m) => m.type === "offerWithdrawn" && m.id === r.offerKey && m.reason === "expired")).toBe(true);
    expect(await accept(r.offerKey ?? "")).toBeNull();
  });

  it("copies a memory value, and refuses it once the entry is forgotten", async () => {
    const id = memory.upsert("about", "about:work email", { label: "Work email", value: "sam@example.com", source: "typed" }, clock, null);
    jev = plannerJev({ fields: { Email: "sam@example.com" } });
    const r = await request("Put my work email in Email");
    expect(r.outcome).toBe("proposed");
    expect(r.spec?.blocks.find((b) => b.type === "fields")).toMatchObject({ rows: [{ value: { text: "sam@example.com", ref: { memory: id } } }] });
    memory.forget(id, clock);
    expect(await accept(r.offerKey ?? "")).toBeNull();
    expect(published.some((m) => m.type === "error" && m.message.includes("untracedValue"))).toBe(true);
  });
});
