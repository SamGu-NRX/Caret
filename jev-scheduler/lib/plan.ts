import type { Answer, Candidate, ComputerHistory, Dropped, EmailThread, Leg, Skill, Timetable } from "./types.ts";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export type Extraction = {
  intent: string; agreementInPrinciple: number; whoTravels: string; venue: string; dateWindow: string;
  excludedWeekdays: string[]; durationMinutes: number; legalShouldAttend: number; travelMode: string;
  sameDayReturn: number; register: string; language: string;
};

export function readExtraction(answers: Record<string, Answer>): Extraction {
  const choice = (id: string) => answers[id]?.choice ?? "";
  const noul = (id: string) => answers[id]?.noul ?? 0;
  return {
    intent: choice("intent"),
    agreementInPrinciple: noul("agreement_in_principle"),
    whoTravels: choice("who_travels"),
    venue: choice("venue"),
    dateWindow: choice("date_window"),
    excludedWeekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"].filter((d) => noul(`${d}_excluded`) >= 0.5),
    durationMinutes: Number(choice("duration_minutes")) || 60,
    legalShouldAttend: noul("legal_should_attend"),
    travelMode: choice("travel_mode"),
    sameDayReturn: noul("same_day_return"),
    register: choice("register"),
    language: choice("language"),
  };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const iso = (date: string, hhmm: string, offset: string) => `${date}T${hhmm}:00${offset}`;

export function windowFor(extraction: Extraction, skill: Skill, thread: EmailThread): { from: string; to: string } | null {
  const template = skill.defaults.windows[extraction.dateWindow];
  if (!template) return null;
  const last = new Date(thread.messages[thread.messages.length - 1].date);
  let year = last.getUTCFullYear();
  const month = Number(template.from.slice(0, 2));
  if (month < last.getUTCMonth() + 1) year += 1;
  return { from: `${year}-${template.from}`, to: `${year}-${template.to}` };
}

export function busyFromHistory(history: ComputerHistory): { title: string; start: Date; end: Date; source: string }[] {
  const busy: { title: string; start: Date; end: Date; source: string }[] = [];
  for (const entry of history.entries) {
    for (const event of entry.events ?? []) {
      busy.push({ title: event.title, start: new Date(event.start), end: new Date(event.end), source: `${entry.app}: "${entry.window_title}" captured ${entry.ts}` });
    }
  }
  return busy;
}

export function venueFromThread(thread: EmailThread): { name: string; address: string; source: string } | null {
  for (const message of [...thread.messages].reverse()) {
    if (message.from.includes(thread.user_email)) continue;
    const lines = message.body.split("\n").map((l) => l.trim()).filter(Boolean);
    const address = lines.find((l) => /\b\d{4,5}\s+\S+/.test(l) && /\d/.test(l.split(",")[0]));
    const orgLine = lines.find((l) => l.includes("|"));
    if (address) {
      const org = orgLine ? orgLine.split("|").map((s) => s.trim()).pop() ?? "" : "";
      return { name: org ? `${org} office` : "Counterparty office", address, source: `Signature block of message ${message.id} (${message.from})` };
    }
  }
  return null;
}

export function plan(extraction: Extraction, skill: Skill, thread: EmailThread, history: ComputerHistory, timetable: Timetable) {
  const d = skill.defaults;
  const candidates: Candidate[] = [];
  const dropped: Dropped[] = [];
  const window = windowFor(extraction, skill, thread);
  if (!window) return { candidates, dropped: [{ date: "-", reason: `No usable date window (Jev answered "${extraction.dateWindow}")` }], window: null };
  const busy = busyFromHistory(history);
  const venue = venueFromThread(thread) ?? { name: "Counterparty office", address: "", source: "assumed" };
  const offset = timetable.utc_offset;
  const covered = (from: string, to: string, date: string) => timetable.coverage.some((c) => c.from === from && c.to === to && c.date === date);
  const legs = (from: string, to: string, date: string) => timetable.connections.filter((c) => c.from === from && c.to === to && c.date === date);
  const sourceRef = `${timetable.source.name}, fetched ${timetable.source.fetched_at}`;

  for (let day = new Date(`${window.from}T00:00:00Z`); day <= new Date(`${window.to}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    const weekday = WEEKDAYS[day.getUTCDay()];
    if (d.exclude_weekends && (weekday === "saturday" || weekday === "sunday")) continue;
    if (extraction.excludedWeekdays.includes(weekday)) { dropped.push({ date, reason: `${weekday} excluded in the thread` }); continue; }
    if (timetable.holidays.dates.includes(date)) { dropped.push({ date, reason: "public holiday" }); continue; }
    if (!covered(d.user.station, d.counterparty_station, date)) { dropped.push({ date, reason: `no verified outbound timetable for ${date}` }); continue; }
    if (!covered(d.counterparty_station, d.user.station, date)) { dropped.push({ date, reason: `no verified return timetable for ${date}` }); continue; }
    let picked = false;
    for (const start of d.candidate_starts) {
      const startMin = toMinutes(start);
      const endMin = startMin + extraction.durationMinutes;
      const arriveBy = startMin - d.last_mile_minutes - d.arrival_buffer_minutes;
      const outbound = pickOutbound(legs(d.user.station, d.counterparty_station, date), arriveBy);
      if (!outbound) { dropped.push({ date, start, reason: `no verified train arriving by ${fromMinutes(arriveBy)}` }); continue; }
      const back = pickReturn(legs(d.counterparty_station, d.user.station, date), endMin + d.last_mile_minutes);
      if (!back) { dropped.push({ date, start, reason: `no verified return train after ${fromMinutes(endMin + d.last_mile_minutes)}` }); continue; }
      const holdStart = new Date(iso(date, outbound.depart, offset)); holdStart.setMinutes(holdStart.getMinutes() - d.station_access_minutes);
      const holdEnd = new Date(iso(date, back.arrive, offset)); holdEnd.setMinutes(holdEnd.getMinutes() + d.station_access_minutes);
      const conflict = busy.find((b) => holdStart < b.end && b.start < holdEnd);
      if (conflict) { dropped.push({ date, start, reason: `door-to-door block ${fmt(holdStart, offset)}-${fmt(holdEnd, offset)} conflicts with "${conflict.title}" (${conflict.source})` }); continue; }
      const id = String.fromCharCode(65 + candidates.length);
      const mkLeg = (c: typeof outbound): Leg => ({ ...c, source: sourceRef, verified: true });
      candidates.push({
        id, date, weekday, timezone: timetable.timezone,
        meeting: { start: iso(date, start, offset), end: iso(date, fromMinutes(endMin), offset) },
        hold: { start: fmt(holdStart, offset), end: fmt(holdEnd, offset) },
        venue, outbound: mkLeg(outbound), return: mkLeg(back),
        evidence: [
          `Outbound ${outbound.service} ${outbound.depart} ${outbound.from} -> ${outbound.arrive} ${outbound.to} (${sourceRef})`,
          `Return ${back.service} ${back.depart} ${back.from} -> ${back.arrive} ${back.to} (${sourceRef})`,
          `Calendar events from computer history checked against ${fmt(holdStart, offset)}-${fmt(holdEnd, offset)}: no overlap`,
          `Venue: ${venue.address || venue.name} (${venue.source})`,
          `Last mile ${d.last_mile_minutes} min and arrival buffer ${d.arrival_buffer_minutes} min are skill defaults (assumed)`,
        ],
      });
      picked = true;
      break;
    }
    if (picked && candidates.length === 3) break;
  }
  return { candidates, dropped, window };
}

function fmt(date: Date, offset: string): string {
  const sign = offset.startsWith("-") ? -1 : 1;
  const shift = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const local = new Date(date.getTime() + shift * 60000);
  return local.toISOString().slice(0, 19) + offset;
}

const duration = (c: { depart: string; arrive: string }) => toMinutes(c.arrive) - toMinutes(c.depart);

/** Latest arrival that still makes the meeting; among arrivals within 45 min of the deadline prefer the shortest ride. */
export function pickOutbound<T extends { depart: string; arrive: string }>(connections: T[], arriveBy: number): T | undefined {
  const feasible = connections.filter((c) => toMinutes(c.arrive) <= arriveBy);
  if (feasible.length === 0) return undefined;
  const latest = Math.max(...feasible.map((c) => toMinutes(c.arrive)));
  return feasible.filter((c) => toMinutes(c.arrive) >= latest - 45).sort((a, b) => duration(a) - duration(b) || toMinutes(b.arrive) - toMinutes(a.arrive))[0];
}

/** Earliest departure after the meeting; among departures within 30 min of the first one prefer the shortest ride. */
export function pickReturn<T extends { depart: string; arrive: string }>(connections: T[], departAfter: number): T | undefined {
  const feasible = connections.filter((c) => toMinutes(c.depart) >= departAfter);
  if (feasible.length === 0) return undefined;
  const earliest = Math.min(...feasible.map((c) => toMinutes(c.depart)));
  return feasible.filter((c) => toMinutes(c.depart) <= earliest + 30).sort((a, b) => duration(a) - duration(b) || toMinutes(a.depart) - toMinutes(b.depart))[0];
}
