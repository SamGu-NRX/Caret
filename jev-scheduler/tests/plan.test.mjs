import test from "node:test";
import assert from "node:assert/strict";
import { loadInputs } from "../lib/inputs.ts";
import { plan, pickOutbound, readExtraction } from "../lib/plan.ts";
import { runPipeline } from "../lib/pipeline.ts";
import { validate } from "../lib/jev.ts";

process.env.JEV_MOCK = "1";
const { skill, thread, history, timetable } = loadInputs();
const extraction = readExtraction({
  intent: { choice: "schedule_meeting" }, agreement_in_principle: { noul: 0.9 }, who_travels: { choice: "user" }, venue: { choice: "counterparty_office" },
  date_window: { choice: "early_october" }, friday_excluded: { noul: 0.95 }, duration_minutes: { choice: "90" }, legal_should_attend: { noul: 0.1 },
  travel_mode: { choice: "rail" }, same_day_return: { noul: 0.9 }, register: { choice: "first_name_informal" }, language: { choice: "en" },
});

test("fridays and uncovered days are dropped, verified days become options", () => {
  const { candidates, dropped } = plan(extraction, skill, thread, history, timetable);
  assert.deepEqual(candidates.map((c) => c.date), ["2026-10-06", "2026-10-08"]);
  assert.ok(dropped.some((d) => d.date === "2026-10-02" && d.reason.includes("friday")));
  assert.ok(dropped.some((d) => d.date === "2026-10-07" && d.reason.includes("no verified return")));
  for (const c of candidates) { assert.equal(c.outbound.verified, true); assert.equal(c.return.verified, true); }
});

test("a calendar event inside the door-to-door block removes the slot", () => {
  const blocked = structuredClone(history);
  blocked.entries[0].events.push({ title: "Blocker", start: "2026-10-06T15:00:00+02:00", end: "2026-10-06T15:30:00+02:00" });
  const { candidates, dropped } = plan(extraction, skill, thread, blocked, timetable);
  assert.ok(!candidates.some((c) => c.date === "2026-10-06"));
  assert.ok(dropped.some((d) => d.date === "2026-10-06" && d.reason.includes("Blocker")));
});

test("a failed timetable source drops the day instead of guessing", () => {
  const partial = structuredClone(timetable);
  partial.coverage = partial.coverage.filter((c) => c.date !== "2026-10-08");
  const { candidates, dropped } = plan(extraction, skill, thread, history, partial);
  assert.deepEqual(candidates.map((c) => c.date), ["2026-10-06"]);
  assert.ok(dropped.some((d) => d.date === "2026-10-08" && d.reason.includes("no verified")));
});

test("outbound prefers the faster train when both make the deadline", () => {
  const pick = pickOutbound(timetable.connections.filter((c) => c.date === "2026-10-08" && c.from === "Basel SBB"), 8 * 60 + 50);
  assert.equal(pick.service, "IC 3");
  assert.equal(pick.arrive, "08:26");
});

test("jev responses are validated before use", () => {
  const questions = { intent: { type: "choice", instructions: "x", criteria: { a: null, b: null } } };
  assert.throws(() => validate({ model: "m", answers: { intent: { choice: "c", probabilities: { a: 0.5, b: 0.5 } } } }, questions), /Invalid choice/);
  assert.throws(() => validate({ model: "m", answers: {} }, questions), /missing answer/);
});

test("mock pipeline schedules tentative holds and never sends", async () => {
  const result = await runPipeline();
  assert.equal(result.status, "scheduled");
  assert.equal(result.mode, "mock");
  assert.ok(result.holds.length >= 2 && result.holds.every((h) => h.status === "tentative"));
  assert.ok(result.ics.includes("STATUS:TENTATIVE"));
  assert.match(result.draft_reply.body, /Hi Anna,/);
});


test("fixture holds never call a configured external webhook", async () => {
  const originalFetch = globalThis.fetch;
  const originalURL = process.env.SCHEDULE_WEBHOOK_URL;
  let calls = 0;
  process.env.SCHEDULE_WEBHOOK_URL = "https://example.invalid/calendar";
  globalThis.fetch = async () => { calls += 1; throw new Error("Unexpected network call"); };
  try {
    const result = await runPipeline();
    assert.equal(result.status, "scheduled");
    assert.equal(result.webhook, null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalURL === undefined) delete process.env.SCHEDULE_WEBHOOK_URL;
    else process.env.SCHEDULE_WEBHOOK_URL = originalURL;
  }
});
