// P3: a page goal over the whole form or a section carries across the user's own Next (plans/fast-browser.md "Authority
// contract"): for CARRY_MS the goal waits, and a new document in its tab gets a fresh preview of that page, segment
// reason nextPage, under the same instruction and scope. Values never carry: each is chosen again from the sources as
// they read now and goes through every gate again. A list of fields does not carry. Every name and value is invented.
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type PageControl } from "../src/protocol.ts";
import { CARRY_MS } from "../src/goals/runs.ts";
import { c, chrome, mixedControls, NOTE, PICKS, WIN } from "./fake-page.ts";
import { closeRigs, goalMessages, presses, rig, type Finished, type Rig, type Segment, type Stopped } from "./page-rig.ts";

afterEach(closeRigs);

/** The wizard's second page: two text fields the note has values for, one of them labelled as on the first page. */
function page2(): PageControl[] {
  return [c("q1", "text", "Email", { value: "" }), c("q2", "text", "Full name", { value: "" }), c("q3", "button", "Next")];
}

const segments = (r: Rig): Segment[] => goalMessages(r).filter((m): m is Segment => m.event === "segment");
const finished = (r: Rig): Finished[] => goalMessages(r).filter((m): m is Finished => m.event === "finished");
const settle = async (r: Rig): Promise<void> => {
  await r.helper.goals.idle();
  await new Promise((x) => setTimeout(x, 0));
  await r.helper.goals.idle();
};

/** Ask about page one, accept its preview, and wait for the goal's end (final walk and reveal check included). */
async function fillFirst(r: Rig, instruction = "fill out this form from my note"): Promise<Segment> {
  const s = (await r.ask(instruction)) as Segment;
  expect(s.event).toBe("segment");
  await r.accept(s);
  await settle(r);
  expect(finished(r).length).toBeGreaterThan(0);
  return s;
}

describe("a whole-form goal carries across the user's Next (P3)", () => {
  it("offers the next page as a fresh preview with reason nextPage, which one more Tab fills", async () => {
    const r = await rig();
    const first = await fillFirst(r);
    expect(r.helper.goals.carrying(WIN, null)).toBe(true);
    await r.next(page2, "Apply: step 2", "/two");
    await settle(r);
    const next = segments(r).at(-1) as Segment;
    expect(next.reason).toBe("nextPage");
    expect(next.replaces).toBe(first.goalId);
    expect(next.goalId).not.toBe(first.goalId);
    expect(next.requestId).toBeNull();
    expect(next.steps.map((s) => s.says)).toEqual(["Email: robin@example.test", "Full name: Robin Vale", "You press Next"]);
    await r.accept(next);
    await settle(r);
    expect(r.page.shown("q1")).toBe("robin@example.test");
    expect(r.page.shown("q2")).toBe("Robin Vale");
    expect(presses(r)).toBe(0);
  });

  it("chooses every value on the new page again, from the sources as they read now", async () => {
    // Canned Jev picks by label from this table, which the test changes along with the note.
    const picks = { ...PICKS };
    const r = await rig({ picks });
    await fillFirst(r);
    const before = r.asked.length;
    // The note changed while the user was on page one: the carried goal must not reuse what page one read.
    await r.setNote(NOTE.replace("robin@example.test", "robin.vale@example.test"));
    picks.Email = "robin.vale@example.test";
    await r.next(page2, "Apply: step 2", "/two");
    await settle(r);
    const next = segments(r).at(-1) as Segment;
    expect(next.reason).toBe("nextPage");
    expect(next.steps.map((s) => s.says)).toContain("Email: robin.vale@example.test");
    // Fill asked Jev about the new page's fields: values were chosen again, not carried.
    const fresh = r.asked.slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.some((q) => JSON.stringify(q.questions).includes("Email"))).toBe(true);
  });

  it("carries what page one left to the user, so the last page's end is not done", async () => {
    const r = await rig();
    await fillFirst(r);
    // Page one left "Are you over 18?" to the user (fill would not tick it from "Age: 34").
    expect(finished(r)[0]?.left.some((l) => /Are you over 18\?/.test(l))).toBe(true);
    await r.next(page2, "Apply: step 2", "/two");
    await settle(r);
    await r.accept(segments(r).at(-1) as Segment);
    await settle(r);
    const end = finished(r).at(-1) as Finished;
    expect(end.outcome).toBe("partial");
    expect(end.left.some((l) => /^On an earlier page, .*Are you over 18\?/.test(l))).toBe(true);
  });

  it("stops a preview of the old page still waiting for its Tab when the next page loads", async () => {
    const r = await rig();
    await fillFirst(r);
    // The user clears page one and asks again, never accepts, then presses Next themselves.
    r.page.controls = mixedControls();
    expect((await r.host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN })).outcome).toBe("ok");
    const waiting = (await r.ask("fill out this form from my note")) as Segment;
    expect(waiting.event).toBe("segment");
    await r.next(page2, "Apply: step 2", "/two");
    await settle(r);
    const stops = goalMessages(r).filter((m): m is Stopped => m.event === "stopped" && m.goalId === waiting.goalId);
    expect(stops.map((m) => m.reason)).toEqual(["reload"]);
    // Its Tab now runs nothing (handleGoalAccept answers a refusal with null), and the new page is untouched.
    const writes = r.page.verbs.length;
    expect(await r.accept(waiting)).toBeNull();
    expect(r.page.verbs.slice(writes).filter((v) => v.kind !== "pageWalk")).toEqual([]);
  });
});

describe("what does not carry (P3)", () => {
  it("a goal over a list of fields", async () => {
    const r = await rig({ intent: { scope: "list", fields: ["f1", "f2"] } });
    const s = (await r.ask("fill in my name and email from my note")) as Segment;
    expect(s.event).toBe("segment");
    await r.accept(s);
    await settle(r);
    expect(finished(r).length).toBe(1);
    // Nothing waits for this tab's next page.
    expect(r.helper.goals.carrying(WIN, null)).toBe(false);
    const count = segments(r).length;
    await r.next(page2, "Apply: step 2", "/two");
    await settle(r);
    expect(segments(r).length).toBe(count);
    expect(segments(r).some((m) => m.reason === "nextPage")).toBe(false);
  });

  it("a goal whose carry waited longer than CARRY_MS", async () => {
    let offset = 0;
    const r = await rig({ now: () => Date.now() + offset });
    await fillFirst(r);
    offset = CARRY_MS + 1000;
    r.helper.tick();
    await r.next(page2, "Apply: step 2", "/two");
    await settle(r);
    expect(segments(r).some((m) => m.reason === "nextPage")).toBe(false);
  });

  it("a goal that never ran (no Tab): the user's Next is not a carry of a preview they never accepted", async () => {
    const r = await rig();
    const s = (await r.ask("fill out this form from my note")) as Segment;
    expect(s.event).toBe("segment");
    await r.next(page2, "Apply: step 2", "/two");
    await settle(r);
    expect(segments(r).some((m) => m.reason === "nextPage")).toBe(false);
  });
});

describe("the P3 review's carry findings", () => {
  /** A page with nothing the sources fill: a question Caret has no value for. */
  const nothing = (): PageControl[] => [c("z1", "text", "Favorite robot", { value: "" }), c("z2", "button", "Next")];

  it("goes on to the page after one it found nothing for", async () => {
    const r = await rig();
    await fillFirst(r);
    await r.next(nothing, "Apply: step 2", "/two");
    await settle(r);
    expect(segments(r).some((m) => m.reason === "nextPage")).toBe(false);
    await r.next(page2, "Apply: step 3", "/three");
    await settle(r);
    expect((segments(r).at(-1) as Segment).reason).toBe("nextPage");
  });

  it("leaves a page it found nothing for to the ambient offer", async () => {
    const r = await rig();
    await fillFirst(r);
    await r.next(nothing, "Apply: step 2", "/two");
    await settle(r);
    const doc = r.host.registry.documentOf(WIN);
    expect(r.helper.goals.carrying(WIN, doc)).toBe(false);
    // Still waiting for the page after it.
    expect(r.helper.goals.carrying(WIN, null)).toBe(true);
  });

  it("offers nothing a fresh plan finished planning for after its host left", async () => {
    let gate: Promise<void> | null = null;
    let open = (): void => {};
    const r = await rig({ jev: (inner) => async (req) => ((gate !== null && (await gate)), inner(req)) });
    const host = "consumer-9";
    r.helper.hostConnected(host);
    const s = (await r.helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "h1", at: Date.now(), instruction: "fill out this form from my note", windowId: WIN }, host, true, true)) as Segment;
    await r.helper.handleGoalAccept({ type: "goalAccept", v: PROTOCOL_VERSION, goalId: s.goalId, segment: s.segment, digest: s.digest, at: Date.now() }, host);
    await settle(r);
    gate = new Promise<void>((x) => (open = x));
    await r.next(page2, "Apply: step 2", "/two");
    // The next page's plan waits on Jev while the host leaves.
    r.helper.hostDisconnected(host);
    open();
    await settle(r);
    expect(segments(r).some((m) => m.reason === "nextPage")).toBe(false);
  });
});

describe("the P3 fix-check's carry finding", () => {
  it("gives the page back to the ambient offer when its carried preview expires untaken", async () => {
    let offset = 0;
    const r = await rig({ now: () => Date.now() + offset });
    await fillFirst(r);
    await r.next(page2, "Apply: step 2", "/two");
    await settle(r);
    expect((segments(r).at(-1) as Segment).reason).toBe("nextPage");
    const doc = r.host.registry.documentOf(WIN);
    expect(r.helper.goals.carrying(WIN, doc)).toBe(true);
    offset = 121_000;
    r.helper.tick();
    expect(r.helper.goals.carrying(WIN, doc)).toBe(false);
  });
});
