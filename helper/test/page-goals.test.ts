// P2: an Ask about a page, from a host that runs goal plans, is planned by the page planner (goals/page-planner.ts):
// fill's one round picks every value, the picks become one segment in document order with gate "fill", one acceptance
// runs it, one undo restores it, and controls the writes reveal are offered as a second segment (afterReveal). Caret
// presses nothing on the page. Driven through the Helper and the page engine of fill-transaction.test.ts. Every name and
// value is invented.
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type GoalProgress, type PageControl } from "../src/protocol.ts";
import { MAX_FIELDS } from "../src/fill/fill.ts";
import { field, jevPickingText, snap } from "./builders.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { byLabel, c, chrome, FakePage, mixedControls, NOTE, PICKS, TEXTEDIT, WIN } from "./fake-page.ts";
import { closeRigs, goalMessages, presses, rig, type Finished, type Rig, type Segment } from "./page-rig.ts";

afterEach(() => {
  closeRigs();
});

/** The question a goal's value gate asks (planner/codeplan.ts verifyWrites): a page plan's fill picks must not be asked it. */
const VERIFY_TASK = "Caret checks each value a drafted plan would write before offering the plan.";

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
      // I6: the form's one forward button, by its own label; never pressed.
      "You press Submit Application",
    ]);
    // "34" ticks no box, so value settlement never offers it for "Are you over 18?" (fill.ts optionsOf), and no step ticks it.
    expect(preview.steps.some((st) => /Are you over 18\?/.test(st.says))).toBe(false);
    // Fill's own two wordings chose every value: the goal value gate's question was never asked.
    expect(r.asked.some((q) => typeof q.state !== "string" && (q.state as { task?: unknown }).task === VERIFY_TASK)).toBe(false);
  });

  it("previews the alternate-value veto reason and leaves that field blank on acceptance", async () => {
    const r = await rig({
      controls: () => [c("e1", "email", "Email", { value: "" }), c("e2", "email", "Alternate email", { value: "" })],
      note: "Email: robin@example.test",
      picks: { Email: "robin@example.test", "Alternate email": "robin@example.test" },
    });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.warnings).toContain("Caret left Alternate email: it would repeat your Email.");
    expect(preview.steps.some((s) => s.says.startsWith("Alternate email:"))).toBe(false);
    await r.accept(preview);
    await r.helper.goals.idle();
    expect(r.page.shown("e1")).toBe("robin@example.test");
    expect(r.page.shown("e2")).toBe("");
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
    expect(preview.steps.map((s) => s.says)).toEqual(["Email: robin@work.test", "You press Submit Application"]);
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
  // I2 lead ruling B: an Ask's scope is settled once, by the scope question, and changes only for a new document or a new
  // Ask. A field the writes revealed on the same page was never asked about, so an Ask's goal leaves it to the user.
  it("leaves the fields an Ask's writes revealed to the user: no second preview writes them (I2 ruling B)", async () => {
    const r = await rig({ note: `${NOTE}\nProvince: Ontario`, picks: { ...PICKS, Province: "Ontario" } });
    revealing(r.page);
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.steps.some((s) => s.says.startsWith("Province"))).toBe(false);
    const t0 = Date.now();
    await r.accept(preview);
    await r.helper.goals.idle();
    const next = goalMessages(r).find((m): m is Segment => m.event === "segment" && m.goalId !== preview.goalId);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(next?.steps.some((s) => s.says.startsWith("Province")) ?? false).toBe(false);
    expect(r.page.shown("e20")).toBe("");
    expect(presses(r)).toBe(0);
  });

  it("offers nothing more for an Ask that named its fields", async () => {
    const r = await rig({ note: `${NOTE}\nProvince: Ontario`, picks: { ...PICKS, Province: "Ontario" }, intent: { scope: "list", fields: ["f3"] } });
    revealing(r.page);
    const preview = (await r.ask("fill in the Country from my note")) as Segment;
    expect(preview.steps.map((s) => s.says)).toEqual(["Country: Canada", "You press Submit Application"]);
    await r.accept(preview);
    await r.helper.goals.idle();
    // The first preview was the Ask's reply; nothing more is published.
    expect(goalMessages(r).filter((m) => m.event === "segment")).toHaveLength(0);
    expect(r.page.verbs.filter((v) => v.kind !== "pageWalk").map((v) => v.id)).toEqual(["e3"]);
  });
});

describe("the size hand-off (P2), in parts since C2", () => {
  const forty = (): PageControl[] => Array.from({ length: 40 }, (_, i) => c(`t${i + 1}`, "text", `Answer ${i + 1}`, { value: "" }));
  const note = Array.from({ length: 40 }, (_, i) => `Answer ${i + 1}: value ${i + 1}`).join("\n");
  const picks = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Answer ${i + 1}`, `value ${i + 1}`]));

  it("fills a 40-field form in two parts, each previewed and accepted with its own Tab (C2 decision 3)", async () => {
    const r = await rig({ controls: forty, note, picks });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    // The first part: MAX_FIELDS writes, nothing of the second part, and no hand-off row before the last part.
    expect(preview).toMatchObject({ segment: 0, segments: 2, reason: "start" });
    expect(preview.steps).toHaveLength(MAX_FIELDS);
    expect(preview.steps[0]?.says).toBe("Answer 1: value 1");
    expect(preview.steps.at(-1)?.says).toBe("Answer 20: value 20");
    expect(preview.warnings).toContain("Caret fills this form in 2 parts of up to 20 fields, each with its own preview and Tab.");
    expect(preview.warnings.some((w) => /more are yours/.test(w))).toBe(false);
    await r.accept(preview);
    await r.helper.goals.idle();
    expect(r.page.shown("t20")).toBe("value 20");
    expect(r.page.shown("t21")).toBe("");
    // The second part waits for its own Tab: nothing of it is written yet, and no goal has finished.
    const second = goalMessages(r).find((m): m is Segment => m.event === "segment" && m.goalId === preview.goalId && m.segment === 1);
    expect(second).toMatchObject({ segment: 1, segments: 2, reason: "moreFields", requestId: null });
    expect(second?.steps.map((s) => s.says)).toEqual([...Array.from({ length: 20 }, (_, i) => `Answer ${i + 21}: value ${i + 21}`), "The rest is yours"]);
    expect(goalMessages(r).filter((m) => m.event === "finished")).toEqual([]);
    // The first part's acceptance cannot run the second: it names segment 0.
    expect(await r.accept(preview)).toBeNull();
    expect(r.page.shown("t21")).toBe("");
    await r.accept(second as Segment);
    await r.helper.goals.idle();
    expect(r.page.shown("t40")).toBe("value 40");
    expect(goalMessages(r).find((m): m is Finished => m.event === "finished")).toMatchObject({ outcome: "done", verified: 40 });
    // One undo per part, the second first: each restores only its own fields.
    expect((await r.helper.executor.undo(`${preview.goalId}:s1`)).notRestored).toEqual([]);
    expect([r.page.shown("t20"), r.page.shown("t21"), r.page.shown("t40")]).toEqual(["value 20", "", ""]);
    expect((await r.helper.executor.undo(`${preview.goalId}:s0`)).notRestored).toEqual([]);
    expect(r.page.shown("t1")).toBe("");
  });

  it("names the fields past four parts as the user's before Tab", async () => {
    const many = (): PageControl[] => Array.from({ length: 85 }, (_, i) => c(`t${i + 1}`, "text", `Q${i + 1}`, { value: "" }));
    const firsts = [1, 21, 41, 61, 81];
    const r = await rig({ controls: many, note: firsts.map((i) => `Q${i}: a${i}`).join("\n"), picks: Object.fromEntries(firsts.map((i) => [`Q${i}`, `a${i}`])) });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    // I2 ruling: the Ask's scope is the fields its own question saw (the intent snapshot holds the first ones a request
    // may carry), so Q41 and Q61 past it are the user's, said as such, and the plan has two parts, not four.
    expect(preview).toMatchObject({ segments: 2 });
    expect(preview.warnings.some((w) => /Caret fills 80 fields of a form, 20 at a time, so 5 more are yours: 'Q81'/.test(w))).toBe(true);
    expect(preview.warnings).toContain("'Q41' is yours: your request didn't ask Caret to fill it.");
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

  it("refuses a value from what the user told Caret once its entry is relabelled before Tab (P2 review)", async () => {
    const r = await rig({ note: NOTE.replace("Email: robin@example.test\n", ""), picks: { ...PICKS, Email: "robin@mem.test" } });
    const added = r.helper.handleMemory({ type: "memoryRequest", v: 1, requestId: "m1", op: "add", kind: "about", fields: { label: "Email", value: "robin@mem.test", source: "typed" } });
    const id = added.entries?.[0]?.id as string;
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.steps.map((x) => x.says)).toContain("Email: robin@mem.test");
    r.helper.handleMemory({ type: "memoryRequest", v: 1, requestId: "m2", op: "edit", id, fields: { label: "Former email", value: "robin@mem.test" } });
    expect(await r.accept(preview)).toBeNull();
    await r.helper.goals.idle();
    expect(goalMessages(r).find((m) => m.event === "stopped")).toMatchObject({ reason: "sourceChanged" });
    expect(r.page.shown("e2")).toBe("");
  });

  it("is not done when the page changes a written value after its last write (P2 review: the final walk is read)", async () => {
    const two = (): PageControl[] => [c("e1", "text", "Full name", { value: "" }), c("e2", "email", "Email", { value: "" })];
    const r = await rig({ controls: two });
    r.page.onAct = (v, p) => {
      // Caret's write is read back as written; then the page's own script changes the field before the next walk.
      if (v.kind !== "pageWrite" || v.id !== "e2" || v.sameAs !== undefined) return null;
      p.find("e2").value = "robin@";
      return { outcome: "ok", detail: null, readings: { before: "", afterInput: v.value, afterBlur: v.value, invalid: false, error: null } };
    };
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect((await r.accept(preview))?.outcome).toBe("done");
    await r.helper.goals.idle();
    const finished = goalMessages(r).find((m): m is Finished => m.event === "finished");
    expect(finished).toMatchObject({ outcome: "partial" });
    expect(finished?.left[0]).toMatch(/'Email' no longer holds what Caret wrote/);
  });

  it("drops a fill pick for a subject line, as every goal write is held to (code gates still run)", async () => {
    const withSubject = (): PageControl[] => [...mixedControls().slice(0, 2), c("e30", "text", "Subject", { value: "" })];
    const r = await rig({ controls: withSubject, note: `${NOTE}\nSubject: Hello there`, picks: { ...PICKS, Subject: "Hello there" } });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.steps.map((x) => x.says)).toEqual(["Full name: Robin Vale", "Email: robin@example.test", "The rest is yours"]);
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
    expect(plan.segments[0]?.steps.filter((s) => s.row !== true).every((s) => s.gate === "fill")).toBe(true);
    // W2: a copy carries no write-contract mint (fill/contract.ts isChecked), so it is refused as unchecked.
    expect(() => r.helper.goals.propose(structuredClone(plan), undefined, null)).toThrow(/without passing the value gates|has no check from the write contract/);
  });
});
