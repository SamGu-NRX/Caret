export type Question = {
  type: "choice" | "score" | "noul";
  instructions: unknown;
  criteria?: unknown;
};

export type Answer = {
  type?: string;
  choice?: string;
  score?: number;
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
  legend?: Record<string, string>;
};

export type JevResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  mock?: boolean;
};

export type Message = { id: string; from: string; to: string[]; cc: string[]; date: string; subject: string; body: string };
export type EmailThread = { source: string; user_email: string; subject: string; messages: Message[] };

export type CalendarEvent = { title: string; start: string; end: string };
export type HistoryEntry = { ts: string; app: string; window_title: string; kind: string; url?: string; text?: string; events?: CalendarEvent[] };
export type ComputerHistory = { source: string; captured_for: string; timezone: string; entries: HistoryEntry[] };

export type Connection = { date: string; from: string; to: string; depart: string; arrive: string; service: string; platform?: string; changes: number };
export type Coverage = { from: string; to: string; date: string; departures_from: string; departures_to: string };
export type Timetable = {
  corridor: string; operator: string; source: { name: string; url: string; fetched_at: string; method: string };
  timezone: string; utc_offset: string; coverage: Coverage[]; connections: Connection[];
  holidays: { source: string; finding: string; dates: string[] };
};

export type Leg = Connection & { source: string; verified: true };

export type Candidate = {
  id: string;
  date: string;
  weekday: string;
  timezone: string;
  meeting: { start: string; end: string };
  hold: { start: string; end: string };
  venue: { name: string; address: string; source: string };
  outbound: Leg;
  return: Leg;
  evidence: string[];
};

export type Dropped = { date: string; start?: string; reason: string };

export type Skill = {
  name: string; version: string; model: string; summary: string; rules: string[];
  defaults: {
    candidate_starts: string[]; arrival_buffer_minutes: number; last_mile_minutes: number; station_access_minutes: number;
    exclude_weekends: boolean; user: { name: string; email: string; base: string; station: string };
    counterparty_station: string; windows: Record<string, { from: string; to: string }>;
  };
  passes: {
    extract: { description: string; questions: Record<string, Question> };
    rank: { description: string; questions: { best_option: Question; option_acceptable: Question } };
  };
};
