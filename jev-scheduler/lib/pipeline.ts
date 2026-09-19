import { randomUUID } from "node:crypto";
import { loadInputs } from "./inputs.ts";
import { askJev, jevMode, type JevRequest } from "./jev.ts";
import { plan, readExtraction } from "./plan.ts";
import { draftReply, holdsFor, icsFor, rankCandidates } from "./schedule.ts";
import type { Candidate, Question } from "./types.ts";

export function extractRequest(): JevRequest {
  const { skill, thread, history } = loadInputs();
  return {
    model: process.env.TYPESAFE_MODEL || skill.model,
    state: { skill: { name: skill.name, rules: skill.rules }, email_thread: thread, computer_history: history },
    questions: skill.passes.extract.questions,
  };
}

export function rankRequest(candidates: Candidate[]): JevRequest {
  const { skill, thread, history } = loadInputs();
  const template = skill.passes.rank.questions;
  const criteria: Record<string, unknown> = {};
  for (const c of candidates) {
    criteria[c.id] = { date: `${c.weekday} ${c.date}`, meeting: `${c.meeting.start.slice(11, 16)}-${c.meeting.end.slice(11, 16)}`, venue: c.venue.name,
      outbound: `${c.outbound.service} ${c.outbound.depart}->${c.outbound.arrive}`, return: `${c.return.service} ${c.return.depart}->${c.return.arrive}`, door_to_door: `${c.hold.start.slice(11, 16)}-${c.hold.end.slice(11, 16)}` };
  }
  const questions: Record<string, Question> = { best_option: { ...template.best_option, criteria } };
  for (const c of candidates) {
    questions[`option_${c.id}_acceptable`] = { ...template.option_acceptable, instructions: String(template.option_acceptable.instructions).replace("__ID__", c.id) };
  }
  return {
    model: process.env.TYPESAFE_MODEL || skill.model,
    state: { skill: { name: skill.name, rules: skill.rules }, email_thread: thread, computer_history: history, candidates: criteria },
    questions,
  };
}

export async function runPipeline() {
  const runId = randomUUID();
  const { skill, thread, timetable, history } = loadInputs();
  const mode = jevMode();
  const extract = extractRequest();
  const extractAnswers = await askJev(extract);
  const extraction = readExtraction(extractAnswers.answers);
  const base = { run_id: runId, mode, model: extractAnswers.model, skill: skill.name, extraction, extract_answers: extractAnswers.answers };
  if (extraction.intent !== "schedule_meeting" || extraction.agreementInPrinciple < 0.5) {
    return { ...base, status: "stopped", reason: `Jev intent=${extraction.intent}, agreement_in_principle=${extraction.agreementInPrinciple.toFixed(2)}; no logistics proposal.` };
  }
  const planned = plan(extraction, skill, thread, history, timetable);
  if (planned.candidates.length === 0) {
    return { ...base, status: "no_options", window: planned.window, dropped: planned.dropped, reason: "No candidate survived the verified timetable and calendar checks." };
  }
  const rank = rankRequest(planned.candidates);
  const rankAnswers = await askJev(rank);
  const ranked = rankCandidates(planned.candidates, rankAnswers.answers);
  if (ranked.kept.length === 0) {
    return { ...base, status: "no_options", rejected: ranked.rejected, reason: "No option survived ranking." };
  }
  const holds = holdsFor(ranked.kept, ranked.best);
  const reply = draftReply(ranked.kept, extraction, thread, skill);
  const ics = icsFor(ranked.kept, thread, runId);
  // Fixture holds stay local, even when a webhook exists in the environment.
  const webhook = null;
  return {
    ...base, status: "scheduled",
    summary: `Propose ${thread.subject} with ${ranked.kept[0].venue.name} in ${ranked.kept[0].venue.address.split(" ").pop()}, ${planned.window?.from} to ${planned.window?.to}, ${ranked.kept.length} option(s), ${extraction.travelMode}; best first: ${ranked.best}`,
    window: planned.window, candidates: planned.candidates, dropped: planned.dropped,
    rank_answers: rankAnswers.answers, rejected: ranked.rejected, holds, draft_reply: reply, ics, webhook,
    notice: mode === "mock" ? "Jev answers are a deterministic MOCK because TYPESAFE_API_KEY is not set. Timetable and thread facts are real inputs; computer history is synthetic." : "Live Jev answers. Computer history is synthetic. Holds are tentative and local; nothing was sent.",
    requests: { extract, rank },
  };
}
