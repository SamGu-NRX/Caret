// The executor's means of acting, each behind an interface so tests and fixture runs never touch a
// real account: reader verbs over the socket, a calendar, and a URL opener.
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type ActGrant, type ActRevoke, type CalendarBlock, type HelperToReader, type ReaderVerb, type VerbResult } from "../protocol.ts";

/** The reader's verbs. Each resolves with the reader's answer, after any snapshot the verb produced has been applied. */
export interface ReaderLink {
  run(verb: ReaderVerb): Promise<VerbResult>;
  /**
   * Hands the reader an act grant or revoke. The reader answers neither: a grant that does not arrive
   * shows up as the next act's notAllowed. A link without it (read-only tests) grants nothing.
   */
  grant?(m: ActGrant | ActRevoke): void;
}

/**
 * Sends readerCommands through `send` and matches verbResults by id. A verb with no answer within
 * `timeoutMs` resolves as an axError, so a hung app or a dropped reader stops the run instead of
 * hanging it. The command carries the same deadline, and the reader refuses to act after it, so a
 * write cannot land after the run has already reported the step as failed.
 */
export class SocketReaderLink implements ReaderLink {
  private readonly pending = new Map<string, (r: VerbResult) => void>();
  private readonly send: (m: HelperToReader) => boolean;
  private readonly timeoutMs: number;
  constructor(send: (m: HelperToReader) => boolean, timeoutMs = 5000) {
    this.send = send;
    this.timeoutMs = timeoutMs;
  }

  grant(m: ActGrant | ActRevoke): void {
    this.send(m);
  }

  run(verb: ReaderVerb): Promise<VerbResult> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const fail = (detail: string): void => resolve({ type: "verbResult", v: PROTOCOL_VERSION, id, at: Date.now(), outcome: "axError", detail });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(`no answer from the reader within ${this.timeoutMs} ms`);
      }, this.timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      if (!this.send({ type: "readerCommand", v: PROTOCOL_VERSION, id, expires: Date.now() + this.timeoutMs, verb })) {
        clearTimeout(timer);
        this.pending.delete(id);
        fail("no reader is connected");
      }
    });
  }

  /** Called for every verbResult the reader sends. */
  answer(r: VerbResult): void {
    const done = this.pending.get(r.id);
    if (done === undefined) return;
    this.pending.delete(r.id);
    done(r);
  }
}

export interface CalendarEvent {
  id: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
}

/**
 * EventKit, seen from the executor. FakeCalendar keeps events in memory; ReaderCalendar asks the reader,
 * whose EventKit adapter writes only to a calendar it created on a local source, never to a synced
 * account. A call the calendar may not carry out throws CalendarBlocked.
 */
export interface CalendarPort {
  find(calendar: string, title: string, start: string, end: string): Promise<CalendarEvent | null>;
  add(calendar: string, title: string, start: string, end: string): Promise<CalendarEvent>;
  get(id: string): Promise<CalendarEvent | null>;
  remove(id: string): Promise<void>;
}

/** An in-memory calendar store. It records every call so a test can show what was asked of it. */
export class FakeCalendar implements CalendarPort {
  readonly events = new Map<string, CalendarEvent>();
  readonly calls: string[] = [];

  async find(calendar: string, title: string, start: string, end: string): Promise<CalendarEvent | null> {
    this.calls.push(`find ${calendar}`);
    const s = Date.parse(start);
    const e = Date.parse(end);
    for (const ev of this.events.values()) {
      if (ev.calendar === calendar && ev.title === title && Date.parse(ev.start) === s && Date.parse(ev.end) === e) return { ...ev };
    }
    return null;
  }

  async add(calendar: string, title: string, start: string, end: string): Promise<CalendarEvent> {
    this.calls.push(`add ${calendar}`);
    const ev = { id: randomUUID(), calendar, title, start, end };
    this.events.set(ev.id, ev);
    return { ...ev };
  }

  async get(id: string): Promise<CalendarEvent | null> {
    this.calls.push("get");
    const ev = this.events.get(id);
    return ev === undefined ? null : { ...ev };
  }

  async remove(id: string): Promise<void> {
    this.calls.push("remove");
    this.events.delete(id);
  }
}

/** The calendar refused for a reason only the user can change: no Calendar access, or no local calendar account. */
export class CalendarBlocked extends Error {
  readonly reason: CalendarBlock;
  constructor(reason: CalendarBlock, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The reader answered a calendar verb with a refusal other than blocked: the run stops as a reader refusal. */
export class CalendarRefused extends Error {}

/** What the user is told for each reason, as a hand-off's detail. */
export const BLOCKED_SAYS: Record<CalendarBlock, string> = {
  tcc: "blocked: tcc. Caret has no Calendar access, and never asks for it on its own; grant it in System Settings, Privacy & Security, Calendars",
  noLocalSource: "blocked: noLocalSource. There is no On My Mac calendar account, and Caret adds events only to a calendar of its own there, never to a synced one",
};

/**
 * The reader's EventKit adapter over the reader link (protocol.ts calendar verbs). Every call is one
 * verb; a `blocked` answer throws CalendarBlocked, any other refusal CalendarRefused naming the outcome.
 */
export class ReaderCalendar implements CalendarPort {
  private readonly reader: ReaderLink;
  constructor(reader: ReaderLink) {
    this.reader = reader;
  }

  private async call(verb: ReaderVerb): Promise<CalendarEvent | null> {
    const r = await this.reader.run(verb);
    if (r.outcome === "blocked") throw new CalendarBlocked(r.blocked ?? "tcc", BLOCKED_SAYS[r.blocked ?? "tcc"]);
    if (r.outcome !== "ok") throw new CalendarRefused(`the reader's calendar refused ${verb.kind}: ${r.outcome}${r.detail === null ? "" : ` (${r.detail})`}`);
    return r.event ?? null;
  }

  find(calendar: string, title: string, start: string, end: string): Promise<CalendarEvent | null> {
    return this.call({ kind: "calendarFind", calendar, title, start, end });
  }

  async add(calendar: string, title: string, start: string, end: string): Promise<CalendarEvent> {
    const ev = await this.call({ kind: "calendarAdd", calendar, title, start, end });
    if (ev === null) throw new Error("the reader added the event but did not return it");
    return ev;
  }

  get(id: string): Promise<CalendarEvent | null> {
    return this.call({ kind: "calendarGet", id });
  }

  async remove(id: string): Promise<void> {
    await this.call({ kind: "calendarRemove", id });
  }

  /** Deletes the calendar of this name the reader created, with its events. For tests and evaluations. */
  async dispose(calendar: string): Promise<void> {
    await this.call({ kind: "calendarDispose", calendar });
  }
}

/** Opens a URL. The only implementation here is a recording fake; a real one belongs in the host. */
export interface UrlOpener {
  open(url: string): Promise<void>;
}
