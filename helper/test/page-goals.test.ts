// P2: an Ask about a page, from a host that runs goal plans, is planned by the page planner (goals/page-planner.ts):
// fill's one round picks every value, the picks become one segment in document order with gate "fill", one acceptance
// runs it, one undo restores it, and controls the writes reveal are offered as a second segment (afterReveal). Caret
// presses nothing on the page. Driven through the Helper and the page engine of fill-transaction.test.ts. Every name and
// value is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type GoalProgress, type HelperMessage, type PageControl } from "../src/protocol.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { pageHost, type PageHost } from "../src/engines/host.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import type { WriterPort } from "../src/writer/port.ts";
import { MAX_FIELDS } from "../src/fill/fill.ts";
import { field, jevPickingText, snap } from "./builders.ts";
import { byLabel, c, chrome, FakePage, hello, mixedControls, NOTE, okReader, PICKS, TEXTEDIT, WIN } from "./fake-page.ts";

type Segment = Extract<GoalProgress, { event: "segment" }>;
type Finished = Extract<GoalProgress, { event: "finished" }>;

/** The question a goal's value gate asks (planner/codeplan.ts verifyWrites): a page plan's fill picks must not be asked it. */
const VERIFY_TASK = "Caret checks each value a drafted plan would write before offering the plan.";

/** The intent a writer maker gives: `scope` all, or a list of field refs. */
function intentWriter(intent: { scope: "all" | "list"; fields?: string[]; literals?: { field: string; text: string }[] }): WriterPort {
  return {
    route: FAKE_WRITER_ROUTE,
    async write(req) {
      const base = { model: "canned", provider: "canned", inputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, costUsd: 0 };
      if (req.kind !== "intent") throw new Error(`asked to write a ${req.kind}`);
      const json = { route: "fill", why: "none", scope: intent.scope, section: "none", fields: intent.fields ?? [], sources: ["any"], whose: "user", literals: intent.literals ?? [] };
      return { ...base, output: { program: null, reply: JSON.stringify(json), json } };
    },
  };
}

interface Rig {
  page: FakePage;
  helper: Helper;
  host: PageHost;
  published: HelperMessage[];
  asked: JevRequest[];
  ask(instruction: string): Promise<GoalProgress>;
  accept(s: Segment): ReturnType<Helper["handleGoalAccept"]>;
  close(): void;
}

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.close();
});

/** A Helper over one page tab and the note the user just left, with canned picks by field label (fake-page.ts PICKS). */
async function rig(o: { controls?: () => PageControl[]; note?: string; picks?: Record<string, string>; intent?: { scope: "all" | "list"; fields?: string[]; literals?: { field: string; text: string }[] } } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "caret-p2-"));
  const store = new Store(join(dir, "data"));
  const page = new FakePage(o.controls ?? mixedControls, "Apply: Mixed controls");
  const published: HelperMessage[] = [];
  const asked: JevRequest[] = [];
  const picks = o.picks ?? PICKS;
  const pick = jevPickingText((_, ins) => picks[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? (o.picks === undefined ? byLabel(_, ins) : null), 0.95);
  // Confirmation questions (planner/ask.ts confirmScope) answer yes; everything else is fill's.
  const jev: AskJev = async (req) => {
    asked.push(req);
    const r = await pick(req);
    for (const [id, q] of Object.entries(req.questions)) if ("yes" in q.criteria) r.answers[id] = { choice: "yes", confidence: 0.95 };
    return r;
  };
  let helper: Helper;
  const host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: okReader, apply: (m) => void helper.handleReader(m), warn: () => {} });
  helper = new Helper({ store, askJev: jev, shadow: false, allowBackgroundFocus: false, readerLink: host.link, calendar: null, publish: (m) => void published.push(m), warn: () => {}, ask: { maker: "writer", writer: intentWriter(o.intent ?? { scope: "all" }) }, pageDocument: (id) => host.registry.documentOf(id) });
  wirePageEngines({ host, helper, publish: () => {}, warn: () => {} });
  host.registry.add(page.session);
  page.session.receive(hello);
  await new Promise((r) => setTimeout(r, 0));
  await helper.handleReader(snap([field("te/note", o.note ?? NOTE, { role: "AXTextArea" })], { at: Date.now() - 5000, windowId: "note", title: "Robin's details.txt", app: TEXTEDIT, focused: true }));
  expect((await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN })).outcome).toBe("ok");
  const r: Rig = {
    page,
    helper,
    host,
    published,
    asked,
    ask: (instruction) => helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "a1", at: Date.now(), instruction, windowId: WIN }, undefined, true, true) as Promise<GoalProgress>,
    accept: (s) => helper.handleGoalAccept({ type: "goalAccept", v: PROTOCOL_VERSION, goalId: s.goalId, segment: s.segment, digest: s.digest, at: Date.now() }),
    close: () => {
      helper.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  rigs.push(r);
  return r;
}

const goalMessages = (r: Rig): GoalProgress[] => r.published.filter((m): m is GoalProgress => m.type === "goalProgress");
const presses = (r: Rig): number => r.page.verbs.filter((v) => v.kind === "pagePress").length;

describe("an Ask about a page is planned by the page planner (P2)", () => {
  it("previews one segment of every value fill agreed on, in document order, with no plan writer configured", async () => {
    const r = await rig();
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview).toMatchObject({ type: "goalProgress", event: "segment", segment: 0, segments: 1, reason: "start" });
    expect(preview.steps.map((s) => s.says)).toEqual([
      "Full name: Robin Vale",
      "Email: robin@example.test",
      "Country: Canada",
      "Shift: Night",
      "Tick 'Do you have a valid driving license?'",
      "Start date: 2026-10-20",
      "Interview time: 15:30",
      "Available from: 2026-10-19T09:00",
      "Country of residence: United States",
    ]);
    // The box whose value fill would not write ("34" for "Are you over 18?") is named as the user's before Tab.
    expect(preview.warnings.some((w) => /Are you over 18\?/.test(w))).toBe(true);
    // Fill's own two wordings chose every value: the goal value gate's question was never asked.
    expect(r.asked.some((q) => typeof q.state !== "string" && q.state.task === VERIFY_TASK)).toBe(false);
  });

  it("fills them all on one acceptance, presses nothing, and one undo restores the page", async () => {
    const r = await rig();
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    const result = await r.accept(preview);
    expect(result?.outcome).toBe("done");
    await r.helper.goals.idle();
    expect([r.page.shown("e1"), r.page.shown("e2"), r.page.shown("e3"), r.page.shown("e5"), r.page.shown("e6"), r.page.shown("e9"), r.page.shown("e10"), r.page.shown("e11"), r.page.shown("e12")]).toEqual(["Robin Vale", "robin@example.test", "Canada", true, true, "2026-10-20", "15:30", "2026-10-19T09:00", "United States"]);
    expect([r.page.shown("e7"), r.page.shown("e8")]).toEqual([false, false]);
    expect(presses(r)).toBe(0);
    const finished = goalMessages(r).find((m): m is Finished => m.event === "finished");
    expect(finished?.verified).toBe(9);
    const u = await r.helper.executor.undo(`${preview.goalId}:s0`);
    expect(u.notRestored).toEqual([]);
    expect([r.page.shown("e1"), r.page.shown("e3"), r.page.shown("e5"), r.page.shown("e6"), r.page.shown("e9"), r.page.shown("e12")]).toEqual(["", "", false, false, "", ""]);
  });

  it("writes a value the instruction spells out for a field it names, which has no source window", async () => {
    const r = await rig({ picks: { ...PICKS, Email: "robin@work.test" }, intent: { scope: "list", fields: ["f2"], literals: [{ field: "f2", text: "robin@work.test" }] } });
    const preview = (await r.ask("put robin@work.test in Email")) as Segment;
    expect(preview.steps.map((s) => s.says)).toEqual(["Email: robin@work.test"]);
    await r.accept(preview);
    expect(r.page.shown("e2")).toBe("robin@work.test");
  });

  it("keeps today's single-window fill for a consumer that does not run goals", async () => {
    const r = await rig();
    const reply = await r.helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "a1", at: Date.now(), instruction: "fill out this form from my note", windowId: WIN }, undefined, true, false);
    expect(reply.type).toBe("planProposal");
  });
});

/** The mixed form, where choosing Canada shows a Province menu, as a dependent form does. */
function revealing(page: FakePage): void {
  page.onAct = (v, p) => {
    if (v.kind === "pageSelect" && v.id === "e3" && !p.controls.some((x) => x.id === "e20")) {
      p.controls.splice(p.controls.findIndex((x) => x.id === "e3") + 1, 0, c("e20", "select", "Province", { options: [{ value: "", label: "Choose a province", selected: true }, { value: "on", label: "Ontario", selected: false }, { value: "qc", label: "Quebec", selected: false }] }));
    }
    return null;
  };
}

describe("the reveal continuation (P2)", () => {
  it("offers the fields the writes revealed as a second preview, which one more acceptance fills", async () => {
    const r = await rig({ note: `${NOTE}\nProvince: Ontario`, picks: { ...PICKS, Province: "Ontario" } });
    revealing(r.page);
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.steps.some((s) => s.says.startsWith("Province"))).toBe(false);
    const t0 = Date.now();
    await r.accept(preview);
    await r.helper.goals.idle();
    const next = goalMessages(r).find((m): m is Segment => m.event === "segment" && m.goalId !== preview.goalId);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(next).toMatchObject({ reason: "afterReveal", replaces: preview.goalId, segment: 0 });
    expect(next?.steps.map((s) => s.says)).toEqual(["Province: Ontario"]);
    expect(r.page.shown("e20")).toBe("");
    await r.accept(next as Segment);
    await r.helper.goals.idle();
    expect(r.page.shown("e20")).toBe("Ontario");
    expect(presses(r)).toBe(0);
  });

  it("offers nothing more for an Ask that named its fields", async () => {
    const r = await rig({ note: `${NOTE}\nProvince: Ontario`, picks: { ...PICKS, Province: "Ontario" }, intent: { scope: "list", fields: ["f3"] } });
    revealing(r.page);
    const preview = (await r.ask("fill in the Country from my note")) as Segment;
    expect(preview.steps.map((s) => s.says)).toEqual(["Country: Canada"]);
    await r.accept(preview);
    await r.helper.goals.idle();
    // The first preview was the Ask's reply; nothing more is published.
    expect(goalMessages(r).filter((m) => m.event === "segment")).toHaveLength(0);
    expect(r.page.verbs.filter((v) => v.kind !== "pageWalk").map((v) => v.id)).toEqual(["e3"]);
  });
});

describe("the size hand-off (P2)", () => {
  const forty = (): PageControl[] => Array.from({ length: 40 }, (_, i) => c(`t${i + 1}`, "text", `Answer ${i + 1}`, { value: "" }));
  const note = Array.from({ length: 40 }, (_, i) => `Answer ${i + 1}: value ${i + 1}`).join("\n");
  const picks = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Answer ${i + 1}`, `value ${i + 1}`]));

  it("fills the first fields one fill asks about, and names the rest as the user's before Tab", async () => {
    const r = await rig({ controls: forty, note, picks });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.steps).toHaveLength(MAX_FIELDS);
    expect(preview.steps[0]?.says).toBe("Answer 1: value 1");
    expect(preview.warnings.some((w) => /Caret fills 20 fields of a form at once, so 20 more are yours: 'Answer 21'/.test(w))).toBe(true);
    await r.accept(preview);
    await r.helper.goals.idle();
    const finished = goalMessages(r).find((m): m is Finished => m.event === "finished");
    expect(finished?.outcome).toBe("partial");
    expect(r.page.shown("t20")).toBe("value 20");
    expect(r.page.shown("t21")).toBe("");
  });
});

describe("a page goal's checks before and while it writes (P2)", () => {
  it("stops when a field is typed into between the preview and Tab, and offers a fresh plan without it", async () => {
    const r = await rig();
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    r.page.find("e1").value = "Robin V.";
    await r.host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN });
    expect(await r.accept(preview)).toBeNull();
    await r.helper.goals.idle();
    const stopped = goalMessages(r).find((m) => m.event === "stopped");
    expect(stopped).toMatchObject({ reason: "targetChanged" });
    const fresh = goalMessages(r).find((m): m is Segment => m.event === "segment");
    expect(fresh?.steps.some((x) => x.says.startsWith("Full name"))).toBe(false);
    expect(r.page.shown("e1")).toBe("Robin V.");
    expect(r.page.verbs.filter((v) => v.kind !== "pageWalk")).toEqual([]);
  });

  it("drops a fill pick for a subject line, as every goal write is held to (code gates still run)", async () => {
    const withSubject = (): PageControl[] => [...mixedControls().slice(0, 2), c("e30", "text", "Subject", { value: "" })];
    const r = await rig({ controls: withSubject, note: `${NOTE}\nSubject: Hello there`, picks: { ...PICKS, Subject: "Hello there" } });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.steps.map((x) => x.says)).toEqual(["Full name: Robin Vale", "Email: robin@example.test"]);
    expect(preview.warnings).toContain("Caret left 'Subject' empty: Caret doesn't write subject lines.");
  });
});

describe("the fill gate cannot be borrowed (P2)", () => {
  it("refuses a page plan whose fill step is a copy, not the step lowering marked", async () => {
    const r = await rig();
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.event).toBe("segment");
    const { planPage } = await import("../src/goals/page-planner.ts");
    const { macClock } = await import("../src/offers/event-time.ts");
    const ask: AskJev = jevPickingText(byLabel, 0.95);
    const plan = await planPage(r.helper.model, { goalId: "g-copy", instruction: "fill out this form", windowId: WIN, scope: null, kind: "all", section: null, about: [], askJev: ask, now: Date.now(), clock: macClock(new Date()), readerSession: 0, pageDocument: (id) => r.host.registry.documentOf(id) });
    expect(plan.segments[0]?.steps.every((s) => s.gate === "fill")).toBe(true);
    expect(() => r.helper.goals.propose(structuredClone(plan), undefined, null)).toThrow(/without passing the value gates/);
  });
});
