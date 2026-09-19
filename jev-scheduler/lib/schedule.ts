import type { Answer, Candidate, EmailThread, Skill } from "./types.ts";
import type { Extraction } from "./plan.ts";

export type Hold = { option_id: string; start: string; end: string; status: "tentative"; proposed_first: boolean; summary: string };

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hhmm = (isoLocal: string) => isoLocal.slice(11, 16);
function dayLabel(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

export function rankCandidates(candidates: Candidate[], answers: Record<string, Answer>) {
  const best = answers.best_option?.choice ?? candidates[0]?.id;
  const acceptable = (c: Candidate) => (answers[`option_${c.id}_acceptable`]?.noul ?? 1) >= 0.5;
  const kept = candidates.filter(acceptable);
  const rejected = candidates.filter((c) => !acceptable(c)).map((c) => ({ id: c.id, reason: `Jev option_${c.id}_acceptable below 0.5` }));
  kept.sort((a, b) => (a.id === best ? -1 : b.id === best ? 1 : a.date.localeCompare(b.date)));
  return { best, kept, rejected };
}

export function holdsFor(candidates: Candidate[], best: string): Hold[] {
  return candidates.map((c) => ({
    option_id: c.id, start: c.hold.start, end: c.hold.end, status: "tentative",
    proposed_first: c.id === best,
    summary: `Option ${c.id}: ${dayLabel(c.date)} ${hhmm(c.meeting.start)}-${hhmm(c.meeting.end)} at ${c.venue.name}; ${c.outbound.service} ${c.outbound.depart} out, ${c.return.service} ${c.return.depart} back`,
  }));
}

export function icsFor(candidates: Candidate[], thread: EmailThread, runId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const toUtc = (isoLocal: string) => new Date(isoLocal).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\;");
  const events = candidates.map((c) => [
    "BEGIN:VEVENT",
    `UID:${runId}-${c.id}@jev-scheduler`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${toUtc(c.hold.start)}`,
    `DTEND:${toUtc(c.hold.end)}`,
    "STATUS:TENTATIVE",
    `SUMMARY:${esc(`HOLD ${c.id}: ${thread.subject} with ${c.venue.name} (door to door)`)}`,
    `LOCATION:${esc(c.venue.address || c.venue.name)}`,
    `DESCRIPTION:${esc(`Meeting ${hhmm(c.meeting.start)}-${hhmm(c.meeting.end)} ${c.timezone}.\nOut: ${c.outbound.service} ${c.outbound.depart} ${c.outbound.from} -> ${c.outbound.arrive} ${c.outbound.to}, platform ${c.outbound.platform ?? "?"}.\nBack: ${c.return.service} ${c.return.depart} ${c.return.from} -> ${c.return.arrive} ${c.return.to}.\nSource: ${c.outbound.source}`)}`,
    "END:VEVENT",
  ].join("\r\n"));
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Caret//jev-scheduler//EN", "METHOD:PUBLISH", ...events, "END:VCALENDAR"].join("\r\n") + "\r\n";
}

/** Reply assembled from fixed sentences and sourced facts only; Jev picks nothing here except what it already answered. */
export function draftReply(candidates: Candidate[], extraction: Extraction, thread: EmailThread, skill: Skill): { to: string[]; subject: string; body: string } {
  const last = thread.messages[thread.messages.length - 1];
  const counterpartName = last.from.split("<")[0].trim().split(" ")[0] || "there";
  const informal = extraction.register !== "formal";
  const greeting = informal ? `Hi ${counterpartName},` : `Dear ${last.from.split("<")[0].trim()},`;
  const legal = extraction.legalShouldAttend >= 0.5
    ? "Yes, let's have legal in the room; I'll bring ours."
    : "I'd keep the first session to the two of us and loop legal in on the redline afterwards; ours can dial in for a few minutes if the pricing clauses move.";
  const lines = candidates.map((c) => {
    const lunch = hhmm(c.meeting.end) <= "12:30" && c.return.depart >= "14:00" ? " Happy to continue over lunch if you have time." : "";
    return `${c.id} - ${dayLabel(c.date)}, ${hhmm(c.meeting.start)}-${hhmm(c.meeting.end)} at your office. I'd take the ${c.outbound.depart} from ${skill.defaults.user.base}, arriving ${c.outbound.to} at ${c.outbound.arrive}, so ${hhmm(c.meeting.start)} is comfortable.${lunch}`;
  });
  const body = [
    greeting, "",
    "Thanks, hosting at your office suits me well. " + legal, "",
    candidates.length > 1 ? `${["Two", "Three"][candidates.length - 2] ?? candidates.length} possibilities:` : "One possibility that works on my side:", "",
    ...lines.flatMap((l) => [l, ""]),
    "If none of these fit, send me two dates that do and I'll make one work.", "",
    informal ? `Best,\n${skill.defaults.user.name}` : `Kind regards,\n${skill.defaults.user.name}`,
  ].join("\n");
  return { to: [last.from], subject: last.subject.startsWith("RE:") ? last.subject : `RE: ${last.subject}`, body };
}
