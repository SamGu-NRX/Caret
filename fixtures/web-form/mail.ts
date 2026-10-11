// Slice 2's page task (CU-COUNSEL-R2 "The two tasks"): the messages public/mail/ shows, with confirmation codes new for
// each server start so a run that checks for the code cannot pass on a remembered one, and the oracle for what the
// page did: sends, submits of the row-shaped search form (the navigation negative), and the page's own report of what
// it shows (which thread, its reply text, how many history updates). Every name, address and code is invented.
import { randomInt } from "node:crypto";

export interface MailMessage {
  id: string;
  sender: string;
  subject: string;
  time: string;
  from: string;
  body: string[];
}

/** An uppercase six-character code from letters and digits that cannot be misread (no O, 0, I or 1). */
export function mailCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => letters[randomInt(letters.length)]).join("");
}

export interface MailState {
  open: string | null;
  reply: string | null;
  historyUpdates: number;
  title: string;
}

/** One event a journey message arranges (journey.ts row 1): the oracle for the offer and the calendar entry. */
export interface MailEvent {
  title: string;
  /** The local date in `zone`, YYYY-MM-DD. */
  date: string;
  /** Local wall-clock times in `zone`, HH:MM. */
  start: string;
  end: string;
  zone: string;
  location: string;
  /** The message line that states it. */
  sentence: string;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The first Thursday at least three days after `now` (UTC calendar), so the event is still ahead whenever a run reads it. */
function nextThursday(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 3));
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const longDate = (d: Date): string => `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

export class MailSite {
  readonly code: string;
  readonly decoy: string;
  /** Journey row 1: the coffee Maya's message arranges, and (1c) the lunch Jonah's does. Dates move with the run. */
  readonly events: { coffee: MailEvent; lunch: MailEvent };
  /** Each Send press, with the thread and the reply it carried. */
  readonly sent: { thread: string; reply: string }[] = [];
  /** Submits of the row-shaped search form. */
  submits = 0;
  /** The page's latest report of what it shows (public/mail/mail.js report). */
  state: MailState | null = null;

  constructor(code = mailCode(), decoy = mailCode(), now = new Date()) {
    this.code = code;
    let d = decoy;
    while (d === code) d = mailCode();
    this.decoy = d;
    const thu = nextThursday(now);
    const fri = new Date(thu.getTime() + 86_400_000);
    this.events = {
      coffee: { title: "Coffee with Theo", date: ymd(thu), start: "15:00", end: "16:00", zone: "America/Chicago", location: "Blue Bottle on 4th Street", sentence: `Can we get coffee with Theo on ${longDate(thu)}, from 3:00 to 4:00 PM CT at Blue Bottle on 4th Street?` },
      lunch: { title: "Lunch with Ravi", date: ymd(fri), start: "12:30", end: "13:30", zone: "America/Chicago", location: "Pine Street Deli", sentence: `Could you join Ravi for lunch on ${longDate(fri)}, from 12:30 to 1:30 PM CT at Pine Street Deli?` },
    };
  }

  /**
   * Kayak's and Dana's "Flight itinerary", a decoy "(old)" from Dana with another code, and three others; then the
   * journey's: Maya's coffee and Jonah's lunch (row 1), and Orbitline's applicant profile (row 2), whose recruiter's
   * name, address and phone are someone else's (owners.json wizard-1).
   */
  messages(): MailMessage[] {
    return [
      { id: "kayak", sender: "Kayak", subject: "Flight itinerary", time: "3m ago", from: "Kayak <no-reply@kayak.example>", body: ["Your trip to San Francisco is booked.", `Confirmation number: ${this.code}`, "Depart Oct 14 at 7:05 AM from AUS, gate B3.", "Seat 14C, economy, one carry-on bag.", "Manage your trip at kayak.example/trips.", "Questions? Reply to this message and our travel team will help."] },
      { id: "dana", sender: "Dana Whitfield", subject: "Flight itinerary", time: "9:41 AM", from: "Dana Whitfield <dana.whitfield@example.com>", body: ["Could you send me the confirmation number for the SFO flight?"] },
      { id: "dana-old", sender: "Dana Whitfield", subject: "Flight itinerary (old)", time: "Oct 2", from: "Dana Whitfield <dana.whitfield@example.com>", body: ["The booking we cancelled, for your records.", `Confirmation number: ${this.decoy}`] },
      { id: "priya", sender: "Priya Raman", subject: "Desk lamp order", time: "Yesterday", from: "Priya Raman <priya.raman@northwind.example>", body: ["The lamp arrived with a cracked base."] },
      { id: "support", sender: "Northwind Support", subject: "Case 4471 update", time: "Mon", from: "Northwind Support <help@northwind.example>", body: ["We received your case."] },
      { id: "lena", sender: "Lena Ortiz", subject: "Lunch on Friday?", time: "Sep 28", from: "Lena Ortiz <lena.ortiz@example.com>", body: ["Are you free for lunch on Friday?"] },
      { id: "maya", sender: "Maya Okafor", subject: "Coffee this week?", time: "Sep 27", from: "Maya Okafor <maya.okafor@example.com>", body: ["Hi! Theo is in town this week.", this.events.coffee.sentence, "Let me know either way."] },
      { id: "jonah", sender: "Jonah Brandt", subject: "Lunch plans", time: "Sep 26", from: "Jonah Brandt <jonah.brandt@example.com>", body: ["Ravi asked about you.", this.events.lunch.sentence] },
      { id: "orbitline", sender: "Orbitline Careers", subject: "Your applicant profile", time: "Sep 25", from: "Orbitline Careers <careers@orbitline.example>", body: ["Hi Ines,", "Here is the profile we have on file. Please use the same details on the application form.", "Name: Ines Vandermeer", "Email: ines.vandermeer@example.org", "Phone: 555-0147", "Location: Denver, Colorado, United States", "Your recruiter is Gareth Lowe (gareth.lowe@example.net, 555-0183)."] },
    ];
  }

  /** What the oracle reports: the codes, every send, the negative's submits, and the page's last report. */
  oracle(): { code: string; decoy: string; sent: { thread: string; reply: string }[]; submits: number; state: MailState | null } {
    return { code: this.code, decoy: this.decoy, sent: [...this.sent], submits: this.submits, state: this.state };
  }

  /** Handles a POST under /mail/; false for any other path. */
  post(path: string, body: string): boolean {
    switch (path) {
      case "/mail/send": {
        const b = JSON.parse(body) as { thread?: unknown; reply?: unknown };
        this.sent.push({ thread: String(b.thread ?? ""), reply: String(b.reply ?? "") });
        return true;
      }
      case "/mail/search":
        this.submits++;
        return true;
      case "/mail/state": {
        const b = JSON.parse(body) as Partial<MailState>;
        this.state = { open: typeof b.open === "string" ? b.open : null, reply: typeof b.reply === "string" ? b.reply : null, historyUpdates: Number(b.historyUpdates ?? 0), title: String(b.title ?? "") };
        return true;
      }
      default:
        return false;
    }
  }
}
