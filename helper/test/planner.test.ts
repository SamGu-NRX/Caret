// The planner (brief B16): instruction spans, value tracing and the plan check are each tested on
// their own, since each has one right answer; then planTask with a fake Jev on a synthetic desk, and the
// helper's planRequest, proposal and accept under an act grant. Everything here is invented.
import { TEST_AUTHORITY } from "./mint.ts";
import { answeringScope } from "./builders.ts";
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
import { addressParts, misfit, textKind, type TextKind } from "../src/fill/kinds.ts";
import { handoffWhy, PlannerError } from "../src/planner/validate.ts";
import { validateMinted } from "./mint.ts";
import { asksToFillForm, byRelevance, namesShortLabel, planTask, requestedWindow, type PlanTaskOptions } from "../src/planner/planner.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import type { WriterRequest } from "../src/writer/port.ts";
import { MAIL_APP, snap, text } from "./builders.ts";
import { executorWindow, FakeApp, K, TITLE, WIN, WIN_NUMBER, wireButtons } from "./fake-app.ts";

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

async function code(f: () => unknown): Promise<PlanErrorCode | "passed"> {
  try {
    await f();
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

  it("takes quoted text literally", () => {
    expect(instructionValues('Write "The meeting moved" in Message')).toEqual(["The meeting moved"]);
    expect(instructionValues('Write "Hello!" in Message')).toEqual(["Hello!"]);
    expect(instructionValues('Write "  indented" in Notes')).toEqual(["  indented"]);
  });

  it("reads the object of 'X is Y', unless it describes a value (B17)", () => {
    expect(instructionValues("Company is Lumen Labs")).toEqual(["Lumen Labs"]);
    expect(instructionValues("Title is Design review, and the room is 4B")).toEqual(["Design review", "4B"]);
    expect(instructionValues("Shipping city is my home town")).toEqual([]);
    expect(instructionValues("Name is Sam Rivera and Company is Lumen Labs")).toEqual(["Sam Rivera", "Lumen Labs"]);
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
  const ctx = (instruction = "", memory = noMemory, model = desk()) => ({ model, memory, instruction, origin: TEST_AUTHORITY });

  it("passes a plan of traced writes and a hand-off, and reports each write's source", async () => {
    const p = plan([
      write(K("textfield:name~0"), "Dana Whitfield"),
      write(K("group:billing/textfield:city~0"), "Lisbon"),
      { says: "You press Send", end: { kind: "handoff", window: W, target: { key: K("button:send~0"), describe: "Send" }, why: "outbound" } },
    ]);
    const c = await validateMinted(p, {}, ctx("Set the billing city to Lisbon"));
    expect(c.writes.map((w) => w.trace.from)).toEqual(["window", "instruction"]);
    expect(c.handoff).toMatchObject({ step: 2, label: "Send", why: "outbound" });
    expect(c.window.window.windowId).toBe(WIN);
  });

  it("refuses each broken rule with its own code", async () => {
    const ok = write(K("textfield:name~0"), "Dana Whitfield");
    const handoff = (key: string, why: "outbound" | "unverifiable" | "money"): Step => ({ says: "press", end: { kind: "handoff", window: W, target: { key, describe: key }, why } });
    expect(await code(() => validateMinted({ id: "p" }, {}, ctx()))).toBe("schema");
    expect(await code(() => validateMinted({ ...plan([write(K("textfield:name~0"), "{{n}}")]), slots: { n: "name" } }, {}, ctx()))).toBe("schema");
    expect(await code(() => validateMinted(plan([{ says: "event", end: { kind: "calendarEvent", calendar: "c", title: "Dana Whitfield", start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00" } }]), {}, ctx()))).toBe("unsupportedStep");
    expect(await code(() => validateMinted(plan([{ ...ok, via: { kind: "press", target: { label: "Send", describe: "Send" } } }]), {}, ctx()))).toBe("unsupportedStep");
    expect(await code(() => validateMinted(plan([{ says: "front", end: { kind: "windowFocused", window: W } }]), {}, ctx()))).toBe("unsupportedStep");
    expect(await code(() => validateMinted(plan([ok, { ...ok, end: { ...ok.end, window: { title: REF_TITLE } } as Step["end"] }]), {}, ctx()))).toBe("multipleWindows");
    expect(await code(() => validateMinted(plan([{ ...ok, end: { ...ok.end, window: { title: "Nowhere" } } as Step["end"] }]), {}, ctx()))).toBe("unknownWindow");
    const twice = desk();
    twice.apply(snap(executorWindow(), { at: 1000, windowId: "5150-8", title: TITLE }));
    expect(await code(() => validateMinted(plan([ok]), {}, ctx("", noMemory, twice)))).toBe("ambiguousWindow");
    expect(await code(() => validateMinted(plan([write(K("textfield:fax~0"), "Dana Whitfield")]), {}, ctx()))).toBe("unknownTarget");
    const byLabel: Step = { says: "city", end: { kind: "valueEquals", window: W, target: { role: "AXTextField", label: "City", describe: "a city" }, value: "Lisbon" } };
    expect(await code(() => validateMinted(plan([byLabel]), {}, ctx("to Lisbon")))).toBe("ambiguousTarget");
    expect(await code(() => validateMinted(plan([write(K("button:archive~0"), "Dana Whitfield")]), {}, ctx()))).toBe("notEditable");
    const secure = desk([...executorWindow(), { key: K("textfield:pin~0"), parent: null, role: "AXTextField", editable: true, states: ["secure"] }]);
    expect(await code(() => validateMinted(plan([write(K("textfield:pin~0"), "Dana Whitfield")]), {}, ctx("", noMemory, secure)))).toBe("notEditable");
    expect(await code(() => validateMinted(plan([write(K("textfield:name~0"), "Dana W.")]), {}, ctx()))).toBe("untracedValue");
    expect(await code(() => validateMinted(plan([write(K("textfield:name~0"), "")]), {}, ctx()))).toBe("untracedValue");
    // A value whose kind does not fit its field (B18): an email in Name, a whole address in City; a city in City passes.
    expect(await code(() => validateMinted(plan([write(K("textfield:name~0"), "dana.whitfield@lumenlabs.example")]), {}, ctx()))).toBe("wrongKind");
    expect(await code(() => validateMinted(plan([write(K("group:billing/textfield:city~0"), "455 Congress Ave, Austin, TX 78701")]), {}, ctx("ship to 455 Congress Ave, Austin, TX 78701")))).toBe("wrongKind");
    expect(await code(() => validateMinted(plan([write(K("group:billing/textfield:city~0"), "Austin")]), {}, ctx("ship to 455 Congress Ave, Austin, TX 78701")))).toBe("passed");
    expect(await code(() => validateMinted(plan([handoff(K("button:archive~0"), "unverifiable"), ok]), {}, ctx()))).toBe("stepAfterHandoff");
    expect(await code(() => validateMinted(plan([handoff(K("button:send~0"), "unverifiable")]), {}, ctx()))).toBe("riskMismatch");
    expect(await code(() => validateMinted(plan([handoff(K("button:archive~0"), "money")]), {}, ctx()))).toBe("riskMismatch");
    expect(await code(() => validateMinted(plan([handoff(K("button:~0"), "unverifiable")]), {}, ctx()))).toBe("passed");
  });

  it("reads hand-off reasons from the risk table", () => {
    expect([handoffWhy("Send"), handoffWhy("Delete draft"), handoffWhy("Pay invoice"), handoffWhy("Archive"), handoffWhy("")]).toEqual(["outbound", "destructive", "money", "unverifiable", "unverifiable"]);
  });
});

describe("whether a value's kind fits a field (B18, kinds.ts)", () => {
  const table: [string, string, TextKind, boolean][] = [
    ["455 Congress Ave, Austin, TX 78701", "City", "address", false],
    ["Austin, TX 78701", "City", "text", false],
    ["Austin", "City", "text", true],
    ["Porto", "Town", "text", true],
    ["455 Congress Ave", "Street", "street", true],
    ["455 Congress Ave, Austin, TX 78701", "Street", "address", false],
    ["455 Congress Ave, Austin, TX 78701", "Shipping address", "address", true],
    ["455 Congress Ave, Austin, TX 78701", "Address line 1", "address", false],
    ["sam.rivera@example.com", "Phone", "email", false],
    ["+1 (512) 555-0142", "Phone", "phone", true],
    ["+1 (512) 555-0142", "Email or phone", "phone", true],
    ["sam.rivera@example.com", "Email address", "email", true],
    ["Sam Rivera", "Email", "text", false],
    ["https://lumenlabs.example/dana", "Website", "url", true],
    ["Dana Whitfield", "Website", "text", false],
    ["dana@lumenlabs.example", "Name", "email", false],
    ["+1 (512) 555-0142", "Full name", "phone", false],
    ["Dana Whitfield", "Name", "text", true],
    ["$1,315.50", "Total", "amount", true],
    ["sam.rivera@example.com", "Amount", "email", false],
    ["2026-10-08", "Date", "text", true],
    ["10-08-2026", "Due date", "phone", true],
    ["https://meet.example.com/xqp-rtz-kfa", "Reference", "url", true],
    ["ORD-2026-48213", "Reference", "text", true],
    ["455 Congress Ave, Austin, TX 78701", "Notes", "address", true],
    ["Reach me at sam.rivera@example.com", "Phone", "text", false],
    ["Senior Product Designer", "Event title", "text", true],
    // Review B18: dates and times are not street lines, a phone keeps its extension, and a whole address
    // without commas is still a whole address.
    ["8 October 2026", "Date", "text", true],
    ["3 PM", "Start time", "text", true],
    ["+1 (512) 555-0142 ext. 9", "Phone", "phone", true],
    ["455 Congress Ave Austin TX 78701", "Street", "address", false],
    ["455 Congress Ave\nAustin, TX 78701", "Street", "address", false],
    // Fix check B18: a street named after a month is still a street.
    ["12 October St, Austin, TX 78701", "Street", "address", false],
    ["12 Janeway Dr, Austin, TX 78701", "Street", "address", false],
    ["8 Oct", "Date", "text", true],
  ];
  it("splits a whole address into its street line and city, verbatim", () => {
    expect(addressParts("455 Congress Ave, Austin, TX 78701")).toEqual({ street: "455 Congress Ave", city: "Austin" });
    expect(addressParts("12 Rue X, 75001 Paris")).toEqual({ street: "12 Rue X", city: null });
    expect(addressParts("455 Congress Ave")).toBeNull();
    expect(addressParts("Room 4B, Building C")).toBeNull();
    // The city is the part before the state or postal code, never a unit (review B18).
    expect(addressParts("455 Congress Ave, Suite B, Austin, TX 78701")).toEqual({ street: "455 Congress Ave", city: "Austin" });
    expect(addressParts("1 Main St, Springfield")).toEqual({ street: "1 Main St", city: "Springfield" });
    expect(addressParts("455 Congress Ave, Suite B, Austin")).toEqual({ street: "455 Congress Ave", city: null });
  });
  it.each(table)("'%s' in a field labelled %s reads as %s and fits: %s", (value, label, kind, fits) => {
    expect(textKind(value)).toBe(kind);
    expect(misfit(value, [label]) === null).toBe(fits);
  });

  it("says what the value is and what the field takes", () => {
    expect(misfit("455 Congress Ave, Austin, TX 78701", ["City"])).toBe("'455 Congress Ave, Austin, TX 78701' is a whole address, and the field takes a city");
    expect(misfit("sam.rivera@example.com", ["Phone"])).toBe("'sam.rivera@example.com' is an email address, and the field takes a phone number");
  });
});

describe("relevance order", () => {
  it("puts what the instruction names first and keeps document order among the rest", () => {
    const items = ["Name", "Email", "Send", "Delete draft", "Pay invoice"].map((name) => ({ name }));
    expect(byRelevance("Delete the draft", items).map((x) => x.name)).toEqual(["Delete draft", "Name", "Email", "Send", "Pay invoice"]);
    expect(byRelevance("Pay the invoice", items).map((x) => x.name)).toEqual(["Pay invoice", "Name", "Email", "Send", "Delete draft"]);
    expect(byRelevance("Set the shipping city to Austin", [{ name: "Billing City" }, { name: "Shipping City" }]).map((x) => x.name)).toEqual(["Shipping City", "Billing City"]);
    expect(byRelevance("Copy it", items).map((x) => x.name)).toEqual(["Name", "Email", "Send", "Delete draft", "Pay invoice"]);
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

  it("resolves the window a request names by number and process, refuses one the reader has not read, and falls back to the last focused window (B21)", () => {
    const m = new ScreenModel();
    m.apply(snap(executorWindow(), { at: 1000, windowId: WIN, title: TITLE, number: 4821 }));
    m.apply(referenceWindow());
    const MAIL_PID = MAIL_APP.pid;
    m.apply(snap([{ key: "dev.caret.mail/standard/textfield:to~0", parent: null, role: "AXTextField", label: "To", editable: true }], { at: 1500, windowId: "6160-3", title: "Mail Fixture — Compose", app: MAIL_APP, number: 4822 }));
    const named = (number: number, pid = 5150, title = "any title") => ({ window: { pid, number, title } });
    expect(requestedWindow(m, named(4821))).toBe(WIN);
    expect(requestedWindow(m, named(4822, MAIL_PID))).toBe("6160-3");
    // The title is the host's and may be stale; only the number and the process match.
    expect(requestedWindow(m, named(4821, 5150, "Some other title"))).toBe(WIN);
    const refused = (f: () => unknown): { code: string; message: string } => {
      try {
        f();
      } catch (e) {
        if (e instanceof PlannerError) return { code: e.code, message: e.message };
        throw e;
      }
      throw new Error("not refused");
    };
    expect(refused(() => requestedWindow(m, named(4999)))).toEqual({ code: "unseenWindow", message: "the reader has not read window 4999 of process 5150" });
    expect(refused(() => requestedWindow(m, named(4822)))).toEqual({ code: "unseenWindow", message: `window 4822 belongs to process ${MAIL_PID}, not 5150` });
    expect(refused(() => requestedWindow(m, { windowId: "5150-77" })).code).toBe("unseenWindow");
    expect(requestedWindow(m, { windowId: WIN })).toBe(WIN);
    // Neither: no window was ever focused, so Caret chooses.
    expect(requestedWindow(m, {})).toBeNull();
    // The window focused last in the frontmost app, not a background app's own focused window.
    m.apply(snap([{ key: "dev.caret.mail/standard/textfield:to~0", parent: null, role: "AXTextField", label: "To", editable: true }], { at: 2000, windowId: "6160-3", title: "Mail Fixture — Compose", app: MAIL_APP, number: 4822, focused: true }));
    m.apply(snap(executorWindow(), { at: 2500, windowId: WIN, title: TITLE, number: 4821, focused: true }));
    m.frontmostPid = MAIL_PID;
    expect(requestedWindow(m, {})).toBe("6160-3");
    m.frontmostPid = 5150;
    expect(requestedWindow(m, {})).toBe(WIN);
    // A last focused window with no field or button leaves the choice to Caret.
    m.apply(referenceWindow(3000));
    m.apply({ ...referenceWindow(3000), focused: true });
    m.frontmostPid = MAIL_PID;
    expect(requestedWindow(m, {})).toBeNull();
  });

  it("hands a Send press back as outbound and a safe press as unverifiable, after the writes", async () => {
    // W2: a value that is no name is refused in Name (fill/contract.ts shapeRefusal, derive.ts partFits), as fill refuses it.
    const d = await planTask("Write 'Dana Reyes' in Name and send it", desk(), mem(), opts(plannerJev({ fields: { Name: "Dana Reyes" }, press: "Send" })));
    expect(d.plan.steps.at(-1)?.end).toEqual({ kind: "handoff", window: W, target: { key: K("button:send~0"), describe: "the Send button" }, why: "outbound" });
    expect(d.checked.handoff?.why).toBe("outbound");
    const a = await planTask("Archive the order", desk(), mem(), opts(plannerJev({ press: "Archive" })));
    expect(a.plan.steps).toHaveLength(1);
    expect(a.checked.handoff).toMatchObject({ label: "Archive", why: "unverifiable" });
  });

  it("asks about a sectioned field only when its own section is named, once the instruction names a section (B17)", async () => {
    const sectionsAsked = (r: JevRequest): string[] =>
      Object.entries(r.questions)
        .filter(([q]) => q !== "press")
        .map(([, q]) => `${/Section: '([^']+)'/.exec(String(q.instructions))?.[1] ?? ""} ${/Label: '([^']+)'/.exec(String(q.instructions))?.[1] ?? ""}`.trim());
    const jev = plannerJev({ fields: { "Billing City": "Lisbon" } });
    const d = await planTask("Set the billing city to Lisbon", desk(), mem(), opts(jev));
    expect(sectionsAsked(jev.requests[0] as JevRequest)).toEqual(["Billing City"]);
    expect(d.slots).toEqual({ v1: "Lisbon" });
    // A label only another section has is still named by its own words (review B17 #11).
    const contact = desk([...executorWindow(), { key: K("group:contact~0"), parent: null, role: "AXGroup", label: "Contact details" }, { key: K("group:contact/textfield:phone~0"), parent: K("group:contact~0"), role: "AXTextField", label: "Phone", editable: true }]);
    const two = plannerJev({ fields: { "Billing City": "Lisbon", "Contact details Phone": "555-0100" } });
    await planTask("Set the billing city to Lisbon and the phone to 555-0100", contact, mem(), opts(two));
    expect(sectionsAsked(two.requests[0] as JevRequest).sort()).toEqual(["Billing City", "Contact details Phone"]);
    // Labels match whatever their case.
    const cased = desk(executorWindow().map((n) => (n.key === K("group:shipping/textfield:city~0") ? { ...n, label: "city" } : n)));
    const lower = plannerJev({ fields: { "Billing City": "Lisbon" } });
    await planTask("Set the billing city to Lisbon", cased, mem(), opts(lower));
    expect(sectionsAsked(lower.requests[0] as JevRequest)).toEqual(["Billing City"]);
    // A value copied from memory names its entry on the step, for the executor's check at the write.
    const fromMemory = plannerJev({ fields: { Email: "sam@work.example" } });
    const dm = await planTask("Put my work email in Email", desk(), mem([{ id: "about-w", label: "Work email", text: "sam@work.example" }]), opts(fromMemory));
    expect(dm.plan.steps.map((s) => s.memory)).toEqual(["about-w"]);
    // With no section named, a city is a city in either.
    const both = plannerJev({ fields: { "Shipping City": "Lisbon" } });
    await planTask("Set the city to Lisbon", desk(), mem(), opts(both));
    expect(sectionsAsked(both.requests[0] as JevRequest).sort()).toEqual(["Billing City", "Shipping City"]);
  });

  it("asks only about the fields an instruction names, or every field when it asks to fill the form (B18)", async () => {
    const jev = plannerJev({ fields: { Name: "Dana Whitfield", Email: "dana.whitfield@lumenlabs.example" } });
    const d = await planTask("Set Name to Dana Whitfield", desk(), mem(), opts(jev));
    expect(d.slots).toEqual({ v1: "Dana Whitfield" });
    expect(Object.keys((jev.requests[0] as JevRequest).questions).filter((q) => q !== "press")).toHaveLength(1);
    // Naming no field no longer asks about every field: only the buttons are asked about, and nothing is written.
    const none = plannerJev({ fields: { Name: "Dana Whitfield" } });
    await expect(planTask("Use Dana's signature here", desk(), mem(), opts(none))).rejects.toMatchObject({ code: "nothingToDo" });
    expect(Object.keys((none.requests[0] as JevRequest).questions)).toEqual(["press"]);
    const all = plannerJev({ fields: { Name: "Dana Whitfield", Email: "dana.whitfield@lumenlabs.example" } });
    const da = await planTask("Fill in the form with Dana's signature", desk(), mem(), opts(all));
    expect(Object.keys((all.requests[0] as JevRequest).questions).filter((q) => q !== "press").length).toBe(executorWindow().filter((n) => n.editable === true && n.role !== "AXButton").length);
    expect(Object.values(da.slots).sort()).toEqual(["Dana Whitfield", "dana.whitfield@lumenlabs.example"]);
  });

  it("names a field with a short label only as a destination or a heading (review B18)", () => {
    expect(namesShortLabel("Put dana@example.com in To", "To")).toBe(true);
    expect(namesShortLabel("put it into the Cc field", "Cc")).toBe(true);
    expect(namesShortLabel("cc: dana@example.com", "Cc")).toBe(true);
    expect(namesShortLabel("Set Name to Dana Whitfield", "To")).toBe(false);
    expect(namesShortLabel("Put dana@example.com in To", "Name")).toBe(false);
    expect(namesShortLabel("Set ID to AB123", "ID")).toBe(true);
    expect(namesShortLabel('Write "To: Dana" in Notes', "To")).toBe(false);
    expect(namesShortLabel("Put the order number in Reference", "To")).toBe(false);
  });

  it("keeps every other value when a screen shows many addresses: their parts have their own budget (review B18)", async () => {
    const m = desk();
    const M = (x: string): string => `dev.caret.mail/standard/${x}`;
    const cities = ["Austin", "Dallas", "Houston", "Waco", "Tyler", "Plano", "Frisco", "Allen", "Irving", "Temple", "Killeen", "Round Rock", "Midland", "Odessa", "Abilene", "Amarillo", "Lubbock", "Laredo", "Denton", "Conroe"];
    const lines = cities.map((c, i) => `${100 + i} Elm St, ${c}, TX 787${String(i).padStart(2, "0")}`);
    const nodes = [...lines.map((l, i) => text(M(`statictext:a${i}~0`), l)), text(M("statictext:mail~0"), "dana.whitfield@lumenlabs.example")];
    m.apply(snap(nodes, { at: 600, windowId: "6160-8", title: "Mail Fixture — Addresses", app: MAIL_APP, values: [...lines.map((l, i) => ({ kind: "address" as const, text: l, nodeKey: M(`statictext:a${i}~0`) })), { kind: "email", text: "dana.whitfield@lumenlabs.example", nodeKey: M("statictext:mail~0") }] }));
    const jev = plannerJev({ fields: { Email: "dana.whitfield@lumenlabs.example" } });
    const d = await planTask("Put Dana's email in Email", m, mem(), opts(jev));
    expect(d.slots).toEqual({ v1: "dana.whitfield@lumenlabs.example" });
  });

  it("offers each field only the values that fit it, so a whole address never reaches City, but its city does", async () => {
    const m = desk();
    const M = (x: string): string => `dev.caret.mail/standard/${x}`;
    m.apply(snap([text(M("statictext:ship to~0"), "Ship to: 455 Congress Ave, Austin, TX 78701")], { at: 600, windowId: "6160-9", title: "Mail Fixture — Earlier order", app: MAIL_APP, values: [{ kind: "address", text: "455 Congress Ave, Austin, TX 78701", nodeKey: M("statictext:ship to~0") }] }));
    const jev = plannerJev({ fields: { "Billing City": "Austin" } });
    // City is offered the address's city, described by the whole address, but never the whole address as a value.
    const d = await planTask("Billing city should be where my earlier order shipped", m, mem(), opts(jev));
    expect(d.slots).toEqual({ v1: "Austin" });
    expect(d.checked.writes[0]?.trace).toMatchObject({ from: "window", windowId: "6160-9" });
    const city = Object.entries((jev.requests[0] as JevRequest).questions).find(([id]) => id !== "press")?.[1];
    const offered = Object.values(city?.criteria ?? {}).filter((x) => x !== null);
    expect(offered.some((x) => x.startsWith('"455 Congress Ave, Austin, TX 78701"'))).toBe(false);
    expect(offered.some((x) => x.startsWith('"Austin" (the city of "455 Congress Ave, Austin, TX 78701"'))).toBe(true);
    expect(offered.some((x) => x.startsWith('"455 Congress Ave" '))).toBe(false);
    // Email takes neither the address nor its parts, so a question about Email alone carries none of them, and its requests declare none.
    const email = plannerJev({});
    await expect(planTask("Put where my earlier order shipped in the email", m, mem(), opts(email))).rejects.toMatchObject({ code: "nothingToDo" });
    for (const r of email.requests) {
      expect(JSON.stringify(r.questions)).not.toContain("455 Congress Ave");
      expect(r.snippets.some((x) => x.text.includes("455 Congress Ave"))).toBe(false);
    }
  });

  it.each([
    ["Fill in the form with Dana's details", true],
    ["fill out the rest of the fields from her signature", true],
    ["Complete this form for Priya", true],
    ["fill it all in from the order", true],
    ["Fill out everything from the confirmation", true],
    ["Fill Name and Email for Dana Whitfield from her signature", false],
    ["Set the billing city to Lisbon", false],
    ["Fill the billing city with Lisbon", false],
    // Review B18: one field of the form is not the form; "all fields" is; quoted text is a value, not a request.
    ["Fill in the form field Name with Dana's details", false],
    ["Fill all fields from the order", true],
    ["Complete all the fields", true],
    ['Write "fill in the form" in Notes', false],
  ])("reads '%s' as asking to fill the whole form: %s", (instruction, whole) => {
    expect(asksToFillForm(instruction)).toBe(whole);
  });

  it("withholds a field the asks split on or agree on weakly, and writes the rest", async () => {
    const d = await planTask("Set Name to Dana Whitfield and the billing city to Lisbon", desk(), mem(), opts(plannerJev({ fields: { Name: "Dana Whitfield", "Billing City": "Lisbon" }, flip: "Billing City" })));
    expect(d.slots).toEqual({ v1: "Dana Whitfield" });
    expect(d.withheld).toEqual([{ name: "Billing City", why: "disagree" }]);
    expect(d.answers["Billing City"]).toEqual(["Lisbon", "keep"]);
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

  it("asks nothing when the instruction quotes more of a window than a question may carry", async () => {
    const m = desk();
    // A conversation always keeps more than half its text back; quoting most of it in the instruction is refused.
    const chat = ["Kofi: are we still on for the vendor review", "Me: yes, I moved it to the big room", "Kofi: great, see you then"];
    m.apply(snap(chat.map((t, i) => text(`dev.caret.chat/standard/statictext:m${i}~0`, t)), { at: 900, windowId: "7373-1", title: "Kofi", app: { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" } }));
    const jev = plannerJev({ fields: { Notes: "x" } });
    await expect(planTask(`Put "${chat[0]} ${chat[1]}" in Name`, m, mem(), opts(jev))).rejects.toMatchObject({ code: "privacy" });
    expect(jev.requests).toHaveLength(0);
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

  it("sends an instruction the planner cannot ground to the code-mode writer, checks its plan, and runs it only when accepted (B24)", async () => {
    // The planner's Jev keeps every field, so the planner finds nothing to do; the writer's program fills Name.
    const base = plannerJev({});
    const checks: AskJev = async (req) => {
      const yesNo = Object.values(req.questions).some((q) => "yes" in q.criteria || "user" in q.criteria);
      if (!yesNo) return base(req);
      const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: "yes" in q.criteria ? "yes" : "user", confidence: 0.9 }]));
      return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    const program = `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const form = await caret.readWindow();
  const src = await caret.readWindow("w2" as WindowRef);
  const t = form.targets.find((x) => x.label === "Name");
  const v = src.values.find((x) => x.display.startsWith('"Dana Whitfield"'));
  const steps: StepRef[] = t !== undefined && v !== undefined ? [caret.fill(t.ref, v.ref)] : [];
  return caret.plan({ basedOn: form.snapshot, steps });
}`;
    const writes: string[] = [];
    const writer = { route: FAKE_WRITER_ROUTE, write: async (req: WriterRequest) => (writes.push(req.disclosureId), { model: "fake", provider: "groq", output: { program, reply: program }, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, latencyMs: 1, costUsd: 0 }) };
    const withWriter = new Helper({ store, memory, askJev: checks, shadow: false, allowBackgroundFocus: false, publish: (m) => published.push(m), readerLink: app, now: () => clock, writer });
    app.helper = withWriter;
    app.show();
    void withWriter.handleReader(referenceWindow());
    const r = await withWriter.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "w1", at: clock, instruction: "put the customer's name in" });
    expect(PlanProposal.parse(r)).toMatchObject({ outcome: "proposed", error: null });
    expect(writes).toEqual([r.offerKey]);
    // Proposed, not run: nothing is written until the host accepts.
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(0);
    const res = await withWriter.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: r.offerKey ?? "", actionId: "run", overrides: {}, at: clock });
    expect(res).toMatchObject({ outcome: "done", acted: 1 });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana Whitfield");
    // With no writer the same instruction fails as before.
    expect(await request("put the customer's name in")).toMatchObject({ outcome: "error", error: { code: "nothingToDo" } });
  });

  it("with an intent maker, Asks run as a scoped fill: the intent's fields only, proposed, and run only when accepted (B25)", async () => {
    // The writer names the Name field by its ref; Jev picks Dana's name for it and calls her the user.
    const intents: string[] = [];
    const intentWriter = {
      route: FAKE_WRITER_ROUTE,
      write: async (req: WriterRequest) => {
        intents.push(req.kind);
        const input = req.input as unknown as { fields: { ref: string; name: string }[] };
        const ref = input.fields.find((f) => f.name === "Name")?.ref ?? "none";
        const json = { route: "fill", why: "none", scope: "list", section: "none", fields: [ref], sources: ["any"], whose: "user", literals: [] };
        return { model: "fake", provider: "groq", output: { program: null, reply: JSON.stringify(json), json }, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, latencyMs: 1, costUsd: 0 };
      },
    };
    const fillJev: AskJev = async (req) => {
      const answers = Object.fromEntries(
        Object.entries(req.questions).map(([id, q]) => {
          if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user", confidence: 0.9 }];
          const hit = String(q.instructions).includes("'Name'") ? Object.entries(q.criteria).find(([, d]) => d?.startsWith('"Dana Whitfield"'))?.[0] : undefined;
          return [id, { choice: hit ?? "none", confidence: 0.9 }];
        }),
      );
      return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    const asking = new Helper({ store, memory, askJev: answeringScope(fillJev), shadow: false, allowBackgroundFocus: false, publish: (m) => published.push(m), readerLink: app, now: () => clock, ask: { maker: "writer", writer: intentWriter } });
    app.helper = asking;
    app.show();
    void asking.handleReader(referenceWindow());
    const r = await asking.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "a1", at: clock, instruction: "put the customer's name in" });
    expect(PlanProposal.parse(r)).toMatchObject({ outcome: "proposed", error: null });
    expect(intents).toEqual(["intent"]);
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(0);
    const res = await asking.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: r.offerKey ?? "", actionId: "run", overrides: {}, at: clock });
    expect(res).toMatchObject({ outcome: "done", acted: 1 });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana Whitfield");
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

  it("refuses an accept once the proposed window closed, even with a same-titled window in its place", async () => {
    jev = plannerJev({ fields: { Name: "Dana Whitfield" } });
    const r = await request("Set Name to Dana Whitfield");
    void helper.handleReader({ type: "windowClosed", v: PROTOCOL_VERSION, at: clock, windowId: WIN });
    void helper.handleReader(snap(executorWindow(), { at: clock + 1, windowId: "5150-9", title: TITLE }));
    expect(await accept(r.offerKey ?? "")).toBeNull();
    expect(published.some((m) => m.type === "error" && m.message.includes("unknownWindow"))).toBe(true);
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

  it("plans against the window a request names by number, and answers unseenWindow for a number the reader has not read (B21)", async () => {
    // A second window with a field, so without the number Caret would have to ask Jev which window.
    void helper.handleReader(snap([{ key: "dev.caret.mail/standard/textfield:to~0", parent: null, role: "AXTextField", label: "To", editable: true }], { at: 600, windowId: "6160-3", title: "Mail Fixture — Compose", app: MAIL_APP, number: 4822 }));
    const number = helper.model.windows.get(WIN)?.window.number;
    expect(number).toBeGreaterThan(0);
    jev = plannerJev({ fields: { Name: "Dana Whitfield" } });
    const asked: JevRequest[] = [];
    const inner = jev;
    jev = async (r) => (asked.push(r), inner(r));
    const named = (n: number, requestId: string) =>
      helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId, at: clock, instruction: "Set Name to Dana Whitfield", window: { pid: 5150, number: n, title: TITLE } });
    const r = await named(number ?? 0, "w1");
    expect(PlanProposal.parse(r)).toMatchObject({ outcome: "proposed", window: { windowId: WIN } });
    expect(asked.some((q) => q.questions.window !== undefined)).toBe(false);
    const miss = await named(999_999, "w2");
    expect(miss).toMatchObject({ outcome: "error", error: { code: "unseenWindow", detail: "the reader has not read window 999999 of process 5150" } });
    expect(PlanProposal.parse(miss).offerKey).toBeNull();
  });

  it("plans and runs in the numbered window when another window of the app has the same title (B21 review)", async () => {
    // Same app, same title, another number: by title alone the plan's window would be ambiguous.
    void helper.handleReader(snap(executorWindow(), { at: 700, windowId: "5150-9", title: TITLE, number: 4900 }));
    jev = plannerJev({ fields: { Name: "Dana Whitfield" } });
    const r = await helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "same", at: clock, instruction: "Set Name to Dana Whitfield", window: { pid: 5150, number: WIN_NUMBER, title: TITLE } });
    expect(PlanProposal.parse(r)).toMatchObject({ outcome: "proposed", window: { windowId: WIN } });
    expect(await accept(r.offerKey ?? "")).toMatchObject({ outcome: "done", acted: 1 });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana Whitfield");
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
