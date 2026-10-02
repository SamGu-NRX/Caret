// The executor's means of acting, each behind an interface so tests and fixture runs never touch a
// real account: reader verbs over the socket, a calendar, and a URL opener.
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type ReaderCommand, type ReaderVerb, type VerbResult } from "../protocol.ts";

/** The reader's verbs. Each resolves with the reader's answer, after any snapshot the verb produced has been applied. */
export interface ReaderLink {
  run(verb: ReaderVerb): Promise<VerbResult>;
}

/**
 * Sends readerCommands through `send` and matches verbResults by id. A verb with no answer within
 * `timeoutMs` resolves as an axError, so a hung app or a dropped reader stops the run instead of
 * hanging it. The command carries the same deadline, and the reader refuses to act after it, so a
 * write cannot land after the run has already reported the step as failed.
 */
export class SocketReaderLink implements ReaderLink {
  private readonly pending = new Map<string, (r: VerbResult) => void>();
  private readonly send: (cmd: ReaderCommand) => boolean;
  private readonly timeoutMs: number;
  constructor(send: (cmd: ReaderCommand) => boolean, timeoutMs = 5000) {
    this.send = send;
    this.timeoutMs = timeoutMs;
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
 * EventKit, seen from the executor. The only implementation in this repository is FakeCalendar:
 * a real adapter must write only to a calendar it created for the purpose, never to a synced account.
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

/** Opens a URL. The only implementation here is a recording fake; a real one belongs in the host. */
export interface UrlOpener {
  open(url: string): Promise<void>;
}
