import type { Answer, JevResponse, Question } from "./types.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

export type JevRequest = { model: string; state: unknown; questions: Record<string, Question> };

export function jevMode(): "live" | "mock" {
  if (process.env.JEV_MOCK === "1") return "mock";
  return process.env.TYPESAFE_API_KEY ? "live" : "mock";
}

export async function askJev(request: JevRequest): Promise<JevResponse> {
  if (jevMode() === "mock") return mockJev(request);
  const key = process.env.TYPESAFE_API_KEY!;
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if ((response.status === 429 || response.status === 529 || response.status === 503) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    last = await response.text();
    if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}: ${last.slice(0, 300)}`);
    const parsed = JSON.parse(last) as JevResponse;
    validate(parsed, request.questions);
    return parsed;
  }
  throw new Error(`Jev unavailable: ${last.slice(0, 300)}`);
}

export function validate(response: JevResponse, questions: Record<string, Question>) {
  if (!response || typeof response.answers !== "object") throw new Error("Invalid Jev response: no answers");
  for (const [id, question] of Object.entries(questions)) {
    const answer = response.answers[id];
    if (!answer) throw new Error(`Jev response missing answer for ${id}`);
    if (question.type === "choice") {
      const ids = Object.keys(question.criteria as Record<string, unknown>);
      const probabilities = answer.probabilities ?? {};
      const ok = typeof answer.choice === "string" && ids.includes(answer.choice)
        && ids.every((k) => typeof probabilities[k] === "number")
        && Math.abs(ids.reduce((s, k) => s + probabilities[k], 0) - 1) < 0.02;
      if (!ok) throw new Error(`Invalid choice answer for ${id}`);
    } else if (question.type === "noul") {
      if (typeof answer.noul !== "number" || answer.noul < 0 || answer.noul > 1) throw new Error(`Invalid noul answer for ${id}`);
    }
  }
}

/** Deterministic stand-in used when no TYPESAFE_API_KEY is configured. Clearly labeled in the output. */
function mockJev(request: JevRequest): JevResponse {
  const fixed: Record<string, string | number> = {
    intent: "schedule_meeting", agreement_in_principle: 0.94, who_travels: "user", venue: "counterparty_office",
    date_window: "early_october", monday_excluded: 0.04, tuesday_excluded: 0.03, wednesday_excluded: 0.03,
    thursday_excluded: 0.04, friday_excluded: 0.96, duration_minutes: "90", legal_should_attend: 0.08,
    travel_mode: "rail", same_day_return: 0.9, register: "first_name_informal", language: "en",
  };
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === "noul") {
      const value = typeof fixed[id] === "number" ? (fixed[id] as number) : id.endsWith("_acceptable") ? 0.9 : 0.5;
      answers[id] = { type: "noul", noul: value };
      continue;
    }
    const ids = Object.keys(question.criteria as Record<string, unknown>);
    const pick = typeof fixed[id] === "string" && ids.includes(fixed[id] as string) ? (fixed[id] as string) : ids[0];
    const probabilities: Record<string, number> = {};
    const rest = ids.length > 1 ? 0.12 / (ids.length - 1) : 0;
    for (const k of ids) probabilities[k] = k === pick ? (ids.length > 1 ? 0.88 : 1) : rest;
    answers[id] = { type: "choice", choice: pick, probabilities, confidence: 0.8 };
  }
  return { model: "mock (no TYPESAFE_API_KEY)", answers, mock: true };
}
