// A page goal's own verified write can show a field that was not on the page when the goal was planned: on the journey's
// wizard-1 (fixtures/web-form/public/tasks/wizard-1.html) State appears only once Country is set. After the goal's last
// verified write it reads the page again (the walk it already makes before it ends), plans the fields that appeared and,
// once it has finished, offers them as a follow-up goal that replaces it (reason afterReveal): the shape the host's page
// panel continues a page task from (apps/caret PageTask.preview). Driven through the Helper and the page engine of
// page-rig.ts. Every name and value is invented.
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type HelperError, type PageControl } from "../src/protocol.ts";
import { GOAL_NEW_CHOICES } from "../src/goals/replay.ts";
import { MAX_SEGMENTS } from "../src/goals/lower.ts";
import { GROQ_GPT_OSS_20B } from "../src/writer/config.ts";
import type { WriterPort } from "../src/writer/port.ts";
import { c, type FakePage } from "./fake-page.ts";
import { closeRigs, goalMessages, presses, rig, type Finished, type Rig, type RigOptions, type Segment, type Stopped } from "./page-rig.ts";

afterEach(() => {
  closeRigs();
});

const NOTE = ["First name: Ines", "Last name: Vandermeer", "Email: ines.vandermeer@example.org", "Phone: 555-0147", "Country: United States", "State: Colorado", "City: Denver"].join("\n");
const PICKS: Record<string, string> = { "First name": "Ines", "Last name": "Vandermeer", Email: "ines.vandermeer@example.org", Phone: "555-0147", Country: "United States", State: "Colorado", City: "Denver" };
const ASK = "fill this form from my note";

/** wizard-1's first page as the content script walks it before Country is set: State is hidden, so it is not walked. */
function wizard(): PageControl[] {
  return [
    c("w1", "text", "First name", { value: "" }),
    c("w2", "text", "Last name", { value: "" }),
    c("w3", "email", "Email", { value: "" }),
    c("w4", "tel", "Phone", { value: "" }),
    c("w5", "select", "Country", { options: [{ value: "", label: "Choose a country", selected: true }, { value: "us", label: "United States", selected: false }, { value: "ca", label: "Canada", selected: false }] }),
    c("w9", "button", "Next"),
  ];
}

const state = (): PageControl => c("w6", "select", "State", { options: [{ value: "", label: "Select...", selected: true }, { value: "CO", label: "Colorado", selected: false }, { value: "TX", label: "Texas", selected: false }] });

/**
 * wizard-1's script: setting Country shows State, empty, right after it (and `more` after State); clearing Country hides
 * them. A Country changed again empties State, as such forms do.
 */
function dependsOnCountry(page: FakePage, more: () => PageControl[] = () => []): void {
  page.onAct = (v, p) => {
    if (v.kind !== "pageSelect" || v.id !== "w5") return null;
    const shown = [state(), ...more()];
    p.controls = p.controls.filter((x) => !shown.some((s) => s.id === x.id));
    if (v.value !== "") p.controls.splice(p.controls.findIndex((x) => x.id === "w5") + 1, 0, ...shown);
    return null;
  };
}

const wizardRig = (o: RigOptions = {}): Promise<Rig> => rig({ controls: wizard, title: "Apply: Field Robotics Technician (step 1 of 3)", note: NOTE, picks: PICKS, ...o });

/** The Ask, its first segment accepted and run, and whatever the goal published once it settled. */
async function firstSegmentRun(r: Rig): Promise<{ first: Segment; asked: number }> {
  const first = (await r.ask(ASK)) as Segment;
  expect(first.steps.map((s) => s.says)).toEqual(["First name: Ines", "Last name: Vandermeer", "Email: ines.vandermeer@example.org", "Phone: 555-0147", "Country: United States", "You press Next"]);
  const asked = r.asked.length;
  await r.accept(first);
  await r.helper.goals.idle();
  return { first, asked };
}

const segmentsOf = (r: Rig, goalId: string): Segment[] => goalMessages(r).filter((m): m is Segment => m.event === "segment" && m.goalId === goalId);
/** The follow-ups offered for goal `goalId`: previews of goals that replace it because its writes revealed fields. */
const followUps = (r: Rig, goalId: string): Segment[] => goalMessages(r).filter((m): m is Segment => m.event === "segment" && m.reason === "afterReveal" && m.replaces === goalId);
const finishedOf = (r: Rig, goalId: string): Finished | undefined => goalMessages(r).find((m): m is Finished => m.event === "finished" && m.goalId === goalId);
/** Every write, pick or tick dispatched to control `id` (walks are reads). */
const actsOn = (r: Rig, id: string): number => r.page.verbs.filter((v) => v.kind !== "pageWalk" && v.id === id).length;
const undo = (r: Rig, taskId: string): ReturnType<Rig["helper"]["handleTask"]> => r.helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId, action: "undo" });

describe("a field the goal's own write revealed", () => {
  it("is offered as a follow-up right after the goal finishes, and its own Tab writes the source's exact value", async () => {
    const r = await wizardRig();
    dependsOnCountry(r.page);
    const { first, asked } = await firstSegmentRun(r);
    expect(finishedOf(r, first.goalId)).toMatchObject({ outcome: "done", verified: 5, left: [], says: "Done: 5 steps verified. You press Next." });
    const [second, ...more] = followUps(r, first.goalId);
    expect(more).toEqual([]);
    expect(second).toMatchObject({ segment: 0, segments: 1, reason: "afterReveal", replaces: first.goalId, requestId: null });
    // The host continues the page task only from a preview that comes after the goal it replaces finished.
    expect(r.published.indexOf(second as Segment)).toBeGreaterThan(r.published.indexOf(finishedOf(r, first.goalId) as Finished));
    expect(segmentsOf(r, first.goalId)).toEqual([]);
    expect(second?.steps.map((s) => s.says)).toEqual(["State: Colorado", "You press Next"]);
    expect(second?.page?.rows.map((x) => [x.label, x.value])).toEqual([["State", "Colorado"]]);
    expect(r.page.shown("w6")).toBe("");
    // The scope question was asked again about State alone, in each of its two wordings.
    const scope = r.asked.slice(asked).filter((q) => q.purpose === "ask.scope");
    expect(scope.map((q) => Object.keys(q.questions).filter((id) => id.startsWith("s_")).length)).toEqual([1, 1]);

    await r.accept(second as Segment);
    await r.helper.goals.idle();
    expect(r.page.shown("w6")).toBe("Colorado");
    expect(["w1", "w2", "w3", "w4", "w5"].map((id) => r.page.shown(id))).toEqual(["Ines", "Vandermeer", "ines.vandermeer@example.org", "555-0147", "United States"]);
    expect(finishedOf(r, (second as Segment).goalId)).toMatchObject({ outcome: "done", verified: 1, skipped: 0, left: [], says: "Done: 1 step verified. You press Next." });
    expect(presses(r)).toBe(0);
  });

  it("is left alone when the sources say nothing for it, and the goal names it and why", async () => {
    const r = await wizardRig();
    dependsOnCountry(r.page, () => [c("w7", "text", "County", { value: "" })]);
    const { first } = await firstSegmentRun(r);
    const [second] = followUps(r, first.goalId);
    expect(second?.steps.map((s) => s.says)).toEqual(["State: Colorado", "You press Next"]);
    await r.accept(second as Segment);
    await r.helper.goals.idle();
    expect(r.page.shown("w6")).toBe("Colorado");
    expect(r.page.shown("w7")).toBe("");
    expect(actsOn(r, "w7")).toBe(0);
    expect(finishedOf(r, (second as Segment).goalId)).toMatchObject({ outcome: "partial", verified: 1, left: ["'County' is yours: Caret found nothing on screen or in memory for it"] });
  });

  it("offers no segment when nothing revealed has a value in the sources, and names each field left", async () => {
    const r = await wizardRig();
    r.page.onAct = (v, p) => {
      if (v.kind === "pageSelect" && v.id === "w5" && !p.controls.some((x) => x.id === "w7")) p.controls.splice(p.controls.findIndex((x) => x.id === "w5") + 1, 0, c("w7", "text", "County", { value: "" }));
      return null;
    };
    const { first } = await firstSegmentRun(r);
    expect(followUps(r, first.goalId)).toEqual([]);
    expect(actsOn(r, "w7")).toBe(0);
    expect(finishedOf(r, first.goalId)).toMatchObject({ outcome: "partial", verified: 5, left: ["'County' is yours: Caret found nothing on screen or in memory for it"] });
  });

  it("is the user's when the request's scope question says the request does not cover it", async () => {
    let asks = 0;
    // The first scope ask (the Ask's own) takes every field; the one about the revealed field says the request excludes it.
    const r = await wizardRig({
      jev: (inner) => async (req) => {
        const out = await inner(req);
        if (req.purpose === "ask.scope" && ++asks > 2) for (const id of Object.keys(req.questions)) if (id.startsWith("s_")) out.answers[id] = { choice: "not", confidence: 0.95 };
        return out;
      },
    });
    dependsOnCountry(r.page);
    const { first } = await firstSegmentRun(r);
    expect(followUps(r, first.goalId)).toEqual([]);
    expect(actsOn(r, "w6")).toBe(0);
    expect(finishedOf(r, first.goalId)).toMatchObject({ outcome: "partial", left: ["'State' is yours: your request didn't ask Caret to fill it"] });
  });
});

describe("the follow-up stays within the goal's caps", () => {
  it("plans one follow-up per page: a field the follow-up's own write reveals is the user's, said, and calls no writer", async () => {
    let writes = 0;
    const writer: WriterPort = {
      route: GROQ_GPT_OSS_20B,
      write: async () => {
        writes++;
        throw new Error("a page goal's follow-up never calls the plan writer");
      },
    };
    const r = await wizardRig({ writer });
    const city = (): PageControl => c("w8", "text", "City", { value: "" });
    r.page.onAct = (v, p) => {
      if (v.kind !== "pageSelect") return null;
      if (v.id === "w5" && v.value !== "" && !p.controls.some((x) => x.id === "w6")) p.controls.splice(p.controls.findIndex((x) => x.id === "w5") + 1, 0, state());
      if (v.id === "w6" && v.value !== "" && !p.controls.some((x) => x.id === "w8")) p.controls.splice(p.controls.findIndex((x) => x.id === "w6") + 1, 0, city());
      return null;
    };
    const { first } = await firstSegmentRun(r);
    const [second] = followUps(r, first.goalId);
    await r.accept(second as Segment);
    await r.helper.goals.idle();
    expect(r.page.shown("w6")).toBe("Colorado");
    // City showed after State's write: no second follow-up, no write to it, and the follow-up says why.
    expect(followUps(r, (second as Segment).goalId)).toEqual([]);
    expect(actsOn(r, "w8")).toBe(0);
    expect(finishedOf(r, (second as Segment).goalId)).toMatchObject({ outcome: "partial", verified: 1, left: ["'City' is yours: it appeared after Caret's second round of writes, and Caret plans the fields its writes reveal once per page"] });
    expect(writes).toBe(0);
  });

  it(`asks about at most ${GOAL_NEW_CHOICES} revealed fields, the goal's limit on new Jev choices, and names the rest`, async () => {
    const extra = Array.from({ length: GOAL_NEW_CHOICES + 1 }, (_, i) => `Reference ${i + 1}`);
    const r = await wizardRig({ note: [NOTE, ...extra.map((x, i) => `${x}: ref-${i + 1}`)].join("\n"), picks: { ...PICKS, ...Object.fromEntries(extra.map((x, i) => [x, `ref-${i + 1}`])) } });
    dependsOnCountry(r.page, () => extra.map((x, i) => c(`x${i + 1}`, "text", x, { value: "" })));
    const { first } = await firstSegmentRun(r);
    // The fields past the limit are named when the goal that revealed them ends, before the follow-up is shown.
    expect(finishedOf(r, first.goalId)?.left).toEqual(extra.slice(GOAL_NEW_CHOICES - 1).map((x) => `'${x}' is yours: Caret asks about at most ${GOAL_NEW_CHOICES} fields its writes reveal`));
    const [second] = followUps(r, first.goalId);
    // State and the first seven references: the first GOAL_NEW_CHOICES revealed fields in document order.
    expect(second?.steps.map((s) => s.says)).toEqual(["State: Colorado", ...extra.slice(0, GOAL_NEW_CHOICES - 1).map((x, i) => `${x}: ref-${i + 1}`), "You press Next"]);
    await r.accept(second as Segment);
    await r.helper.goals.idle();
    expect(actsOn(r, `x${GOAL_NEW_CHOICES}`) + actsOn(r, `x${GOAL_NEW_CHOICES + 1}`)).toBe(0);
  });

  it("follows a form planned in parts, and asks about a field revealed past the scope question's 40 fields", async () => {
    // Country, then 40 answers: the Ask's scope question sees 40 fields (MAX_INTENT_FIELDS), so Answer 40 is the user's
    // and the goal has two parts. Country's write shows State at the end of the form, past 40 fields, filled ones counted.
    const answers = Array.from({ length: 40 }, (_, i) => `Answer ${i + 1}`);
    const controls = (): PageControl[] => [...wizard().filter((x) => x.id === "w5"), ...answers.map((x, i) => c(`t${i + 1}`, "text", x, { value: "" })), ...wizard().filter((x) => x.id === "w9")];
    const r = await rig({ controls, note: [...answers.map((x, i) => `${x}: value ${i + 1}`), "Country: United States", "State: Colorado"].join("\n"), picks: { ...Object.fromEntries(answers.map((x, i) => [x, `value ${i + 1}`])), Country: "United States", State: "Colorado" } });
    r.page.onAct = (v, p) => {
      if (v.kind === "pageSelect" && v.id === "w5" && v.value !== "" && !p.controls.some((x) => x.id === "w6")) p.controls.splice(p.controls.findIndex((x) => x.id === "w9"), 0, state());
      return null;
    };
    const first = (await r.ask(ASK)) as Segment;
    expect(first).toMatchObject({ segment: 0, segments: 2 });
    await r.accept(first);
    await r.helper.goals.idle();
    expect(r.page.shown("w5")).toBe("United States");
    expect(followUps(r, first.goalId)).toEqual([]);
    const part = segmentsOf(r, first.goalId).find((x) => x.segment === 1) as Segment;
    await r.accept(part);
    await r.helper.goals.idle();
    const [next] = followUps(r, first.goalId);
    expect(2 + (next?.segments ?? 0)).toBeLessThanOrEqual(MAX_SEGMENTS);
    expect(next?.steps.map((x) => x.says)).toEqual(["State: Colorado", "You press Next"]);
  });
});

describe("undo and stop across the two segments", () => {
  it("undoes the follow-up first: the first goal's undo is refused while the follow-up's write stands, then both restore", async () => {
    const r = await wizardRig();
    dependsOnCountry(r.page);
    const { first } = await firstSegmentRun(r);
    const second = followUps(r, first.goalId)[0] as Segment;
    await r.accept(second);
    await r.helper.goals.idle();
    expect(r.page.shown("w6")).toBe("Colorado");

    // Out of order: refused before anything is restored, since Country first would take State away under Caret's write.
    expect(await undo(r, `${first.goalId}:s0`)).toBeNull();
    const refused = r.published.filter((m): m is HelperError => m.type === "error").map((m) => m.message);
    expect(refused).toEqual([`task ${first.goalId}:s0: undo ${second.goalId}:s0 first: its writes came after this one's`]);
    expect([r.page.shown("w5"), r.page.shown("w6")]).toEqual(["United States", "Colorado"]);

    expect(await undo(r, `${second.goalId}:s0`)).toMatchObject({ restored: 1, notRestored: [] });
    expect(r.page.shown("w6")).toBe("");
    expect(await undo(r, `${first.goalId}:s0`)).toMatchObject({ restored: 5, notRestored: [] });
    expect(["w1", "w2", "w3", "w4", "w5"].map((id) => r.page.shown(id))).toEqual(["", "", "", "", ""]);
    expect(r.page.controls.some((x) => x.id === "w6")).toBe(false);
  });

  it("a Stop while the follow-up waits for its Tab ends the goal, and its Tab then runs nothing", async () => {
    const r = await wizardRig();
    dependsOnCountry(r.page);
    const { first } = await firstSegmentRun(r);
    const second = followUps(r, first.goalId)[0] as Segment;
    const acts = r.page.verbs.length;
    await r.helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: `${first.goalId}:s0`, action: "stop" });
    expect(goalMessages(r).find((m): m is Stopped => m.event === "stopped" && m.goalId === second.goalId)).toMatchObject({ reason: "you", says: "You stopped it." });
    expect(await r.accept(second)).toBeNull();
    expect(r.published.filter((m): m is HelperError => m.type === "error").map((m) => m.message)).toEqual([`goalAccept refused: goal ${second.goalId} is stopped, not waiting for an acceptance`]);
    await r.helper.goals.idle();
    expect(r.page.verbs.slice(acts).filter((v) => v.kind !== "pageWalk")).toEqual([]);
    expect(r.page.shown("w6")).toBe("");
  });

  it("a Stop while the goal plans what its writes revealed offers no follow-up and dispatches nothing more", async () => {
    // The follow-up's scope question waits until the user's Stop has arrived.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let scopeAsks = 0;
    const r = await wizardRig({
      jev: (inner) => async (req) => {
        if (req.purpose === "ask.scope" && ++scopeAsks > 2) await held;
        return inner(req);
      },
    });
    dependsOnCountry(r.page);
    const first = (await r.ask(ASK)) as Segment;
    await r.accept(first);
    for (let i = 0; i < 200 && scopeAsks <= 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(scopeAsks).toBeGreaterThan(2);
    const acts = r.page.verbs.length;
    await r.helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: `${first.goalId}:s0`, action: "stop" });
    release();
    await r.helper.goals.idle();
    expect(followUps(r, first.goalId)).toEqual([]);
    expect(goalMessages(r).find((m): m is Stopped => m.event === "stopped" && m.goalId === first.goalId)).toMatchObject({ reason: "you" });
    expect(finishedOf(r, first.goalId)).toBeUndefined();
    expect(r.page.verbs.slice(acts).filter((v) => v.kind !== "pageWalk")).toEqual([]);
    expect(r.page.shown("w6")).toBe("");
  });
});
