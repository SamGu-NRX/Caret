// The event card (Fable plan section 2, pop-up A). A sentence that names a time and a person, finished
// in the field the user is typing in or arriving in a conversation window, becomes an offer to add the
// event to a calendar: "Calendar  Coffee with Dana, Thu 3:00 to 3:30 PM  Tab", and the down arrow opens
// the card. A time the text leaves open (no AM or PM, no end) makes a card that asks: its picker lists the
// possible times and Tab adds only the one the user highlighted. Code finds the sentence, its time (the
// reader's typed values, read by the value resolver through event-time.ts), the
// person and the title, all copied from the sentence; Jev answers one yes/no question, whether the
// writer is arranging something they will attend, asked twice with different wording. Only two yeses
// make an offer. Taking it runs a one-step plan whose end state is the event in the calendar, through
// the executor's calendar port.
import { nodeText, type Change, type ScreenModel, type WindowState } from "../model.ts";
import { PROTOCOL_VERSION, type HelperMessage, type OfferAction, type OfferField, type OfferWithdrawn } from "../protocol.ts";
import type { AskJev, JevRequest } from "../fill/jev.ts";
import { isConversation } from "../conversation.ts";
import { SnippetLedger } from "../privacy.ts";
import type { PopupBlock, PopupSpecT } from "../popup.ts";
import type { Plan } from "../executor/schema.ts";
import type { TaskResult } from "../executor/executor.ts";
import type { MemoryValue } from "../planner/trace.ts";
import { occursBounded } from "../planner/trace.ts";
import { macClock, resolveEventTime, type EventClock, type EventTime, type EventWhen, type TimeSource } from "./event-time.ts";
import { ZONE_SOURCE, zoneToken } from "../values/zones.ts";
import type { AcceptHandler, AcceptResult } from "./registry.ts";
import { offerField } from "./field.ts";
import { expired } from "./lifetimes.ts";
import type { OfferGate } from "./settings.ts";

/** Sentences a first look asks about, most recent windows first; each costs two Jev asks. Assumed. */
export const MAX_EVENT_LOOKS = 3;
/** Sentences being asked about at once; one more found meanwhile is left unjudged. Assumed, not measured. */
export const MAX_PENDING_EVENT_ASKS = 2;
/** New conversation lines one snapshot may send to be judged, the latest first. Assumed. */
const MAX_NEW_LINES = 3;
/** Words that name the kind of event, in the order they are looked for; the first found titles it. */
const EVENT_WORDS = ["coffee", "lunch", "dinner", "breakfast", "brunch", "drinks", "interview", "meeting", "review", "sync", "call", "chat", "walk", "catch up"];
/** Capitalised words that are never a person's name in "with X". */
const NOT_NAMES = new Set([
  "I", "Me", "You", "Us", "Them", "Him", "Her", "Everyone", "Team", "The", "My", "Our", "Your",
  "Mon", "Monday", "Tue", "Tues", "Tuesday", "Wed", "Wednesday", "Thu", "Thur", "Thurs", "Thursday", "Fri", "Friday", "Sat", "Saturday", "Sun", "Sunday",
  "Jan", "January", "Feb", "February", "Mar", "March", "Apr", "April", "May", "Jun", "June", "Jul", "July", "Aug", "August", "Sep", "Sept", "September", "Oct", "October", "Nov", "November", "Dec", "December",
  "Today", "Tomorrow", "Tonight", "Noon", "Midnight",
]);
const NAME_WORD = "[A-Z][a-z]+(?:-[A-Z][a-z]+)?";
const AFTER_VERB = new RegExp(`\\b(?:[Ww]ith|[Mm]eet|[Ss]ee|[Cc]all|[Jj]oin)\\s+(${NAME_WORD}(?:\\s+${NAME_WORD})?)(?:\\s+and\\s+(${NAME_WORD}))?`, "g");
const AND_I = new RegExp(`(?:^|[.!?]\\s+)(${NAME_WORD}(?:\\s+${NAME_WORD})?)\\s+and\\s+I\\b`);

export interface EventCandidate {
  sentence: string;
  title: string;
  person: string;
  time: EventWhen;
}

/** The time a card adds: the one it states, or the picker row the user highlighted. A string says why there is none. */
export function chosenTime(c: EventCandidate, row: number | undefined): EventTime | string {
  if (c.time.kind === "resolved") return c.time.time;
  if (row === undefined) return "the card asks which time; pick one in it first. Nothing was added";
  return c.time.choices[row] ?? `the card has no time ${row}`;
}

/** The start the offer line and its lifetime go by: the stated one, or the latest of the choices. */
function lastStart(c: EventCandidate): number {
  return c.time.kind === "resolved" ? Date.parse(c.time.time.start) : Math.max(...c.time.choices.map((t) => Date.parse(t.start)));
}

const ZONE_ANYWHERE = new RegExp(`(?<![A-Za-z0-9])(?:${ZONE_SOURCE})`, "g");
/**
 * Words shaped like a zone abbreviation (capitals ending in T, as AWST or SGT, and a few others such as
 * MSK). One the resolver does not know cannot be read, and must not be dropped either: the time would be
 * read in the wrong zone. "IT" and "AT" are words, not zones.
 */
const ZONE_LIKE = /(?<![A-Za-z0-9])(?:[A-Z]{1,4}T|MSK|WIB|WITA)(?![A-Za-z])/g;
const NOT_ZONES = new Set(["IT", "AT"]);

/** Whether the text before `at` ends in a time ("3pm", "16:00", "noon"), allowing spaces and an open parenthesis. */
function afterTime(sentence: string, at: number): boolean {
  return /(?:\d|[ap]\.?m\.?|noon|midnight)$/i.test(sentence.slice(0, at).replace(/[\s(]+$/, ""));
}

/**
 * The spans with any zone the sentence names right after them ("3pm UTC", "4:00 PM (PT)"), which the
 * reader's span may leave out. Null when a zone is named anywhere else in the sentence: it might belong to
 * the time, so the time is not read without it.
 */
export function withZones(sentence: string, spans: readonly string[]): string[] | null {
  const joined = spans.join(" ");
  // An unknown zone-shaped word right after a time ("16:00 AWST") is refused; elsewhere ("at MIT") it is a word.
  for (const m of sentence.matchAll(ZONE_LIKE)) if (!NOT_ZONES.has(m[0]) && zoneToken(m[0]) === null && afterTime(sentence, m.index)) return null;
  const extra: string[] = [];
  for (const m of sentence.matchAll(ZONE_ANYWHERE)) {
    if (joined.includes(m[0])) continue;
    if (!afterTime(sentence, m.index)) return null;
    extra.push(m[0]);
  }
  return extra.length === 0 ? [...spans] : [`${joined} ${extra.join(" ")}`];
}

/** The sentences of a text, each trimmed; a final one without an end mark is left out unless `whole`. */
export function sentences(text: string, whole: boolean): string[] {
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s !== "");
  if (!whole && parts.length > 0 && !/[.!?]$/.test(text.trimEnd()) && !/\n\s*$/.test(text)) parts.pop();
  return parts;
}

/** The first word of a name that is not a day, month or pronoun, keeping a second name word only if it also is one. */
function cleanName(raw: string): string | null {
  const words = raw.split(/\s+/);
  const kept: string[] = [];
  for (const w of words) {
    if (NOT_NAMES.has(w)) break;
    kept.push(w);
  }
  return kept.length === 0 ? null : kept.join(" ");
}

/** The person the sentence arranges something with: a memory name it contains, or a name after "with", "meet", "see", "call" or "join", or before "and I". */
export function personIn(sentence: string, people: readonly MemoryValue[]): string | null {
  for (const p of people) for (const t of [p.text, p.label]) if (t !== "" && occursBounded(sentence, t)) return t;
  for (const m of sentence.matchAll(AFTER_VERB)) {
    const first = cleanName(m[1] ?? "");
    if (first === null) continue;
    const second = m[2] === undefined ? null : cleanName(m[2]);
    return second === null ? first : `${first} and ${second}`;
  }
  const a = AND_I.exec(sentence);
  return a?.[1] === undefined ? null : cleanName(a[1]);
}

/** "Coffee with Dana": the sentence's event word and person, or "Meet Dana" when it names no kind of event. */
export function eventTitle(sentence: string, person: string): string {
  const lower = sentence.toLowerCase();
  const word = EVENT_WORDS.find((w) => new RegExp(`\\b${w}\\b`).test(lower));
  if (word === undefined) return `Meet ${person}`;
  return `${word[0]?.toUpperCase()}${word.slice(1)} with ${person}`;
}

/**
 * The event a sentence describes, from its date and time spans; null when it names no person, no time
 * ahead, or a time with more possibilities than a card can offer. `source` decides what the time is
 * counted from (time-source rules in event-time.ts).
 */
export function eventCandidate(sentence: string, spans: readonly string[], people: readonly MemoryValue[], clockNow: EventClock, source: TimeSource = "typed"): EventCandidate | null {
  if (spans.length === 0) return null;
  const zoned = withZones(sentence, spans);
  if (zoned === null) return null;
  const person = personIn(sentence, people);
  if (person === null) return null;
  const time = resolveEventTime(zoned, clockNow, source);
  if (time === null) return null;
  return { sentence, title: eventTitle(sentence, person), person, time };
}

/**
 * Where a sentence came from. `typed`: the user is writing it in a field, so its writer is the user.
 * `conversation`: a line in a conversation the user is reading, whose writer may be someone else, so the
 * question asks about the user, not the writer.
 */
export type SentenceSource = "typed" | "conversation";

const WORDINGS: Record<SentenceSource, readonly [string, string]> = {
  typed: [
    "The user is writing this sentence. Is the user arranging something that they will attend at the time it names? Answer no for something already over, cancelled, declined, only wondered about, or planned by other people without the user.",
    "This sentence is being typed by the user. Does it set up a future meeting or appointment that the user is going to? Choose no if it is past, called off, turned down, hypothetical, or about other people only.",
  ],
  conversation: [
    "This line is from a conversation the user is reading; the user may or may not have written it. Does it arrange something that the user of this computer will attend at the time it names? Answer no if it is over, cancelled, declined, only wondered about, or for other people without the user.",
    "A message in a conversation the user is reading, perhaps written by someone else. Is the user themselves going to a future meeting or appointment it sets up? Choose no if it is past, called off, turned down, hypothetical, or not something the user attends.",
  ],
};

/** One of the two asks. `declared` is the sentence as its window's ledger took it. */
export function buildAttendRequest(sentence: string, wording: 0 | 1, declared: { snippets: JevRequest["snippets"]; charged: JevRequest["charged"] }, source: SentenceSource = "typed"): JevRequest {
  return {
    state: { sentence, task: source === "typed" ? "The user is typing this sentence. Caret is deciding whether to offer adding an event to the user's calendar." : "The user is reading this line in a conversation. Caret is deciding whether to offer adding an event to the user's calendar." },
    questions: { attend: { type: "choice", instructions: WORDINGS[source][wording], criteria: { yes: "Yes: a future event the user will attend.", no: "No." } } },
    snippets: declared.snippets,
    charged: declared.charged,
  };
}

export interface AttendAnswer {
  yes: boolean;
  asks: [{ choice: string; confidence: number }, { choice: string; confidence: number }];
  costUsd: number;
}

/** Both asks; `yes` only when both answered yes. Null when the sentence does not fit its window's budget, so nothing was asked. */
export async function askAttend(ask: AskJev, model: ScreenModel, w: WindowState, sentence: string, source: SentenceSource = "typed"): Promise<AttendAnswer | null> {
  const ledger = new SnippetLedger(model.windows.values());
  if (!ledger.take(w, "candidate", [sentence])) return null;
  const declared = ledger.declared();
  const [r1, r2] = await Promise.all([ask(buildAttendRequest(sentence, 0, declared, source)), ask(buildAttendRequest(sentence, 1, declared, source))]);
  const a1 = r1.answers.attend;
  const a2 = r2.answers.attend;
  if (a1 === undefined || a2 === undefined) throw new Error("Jev gave no answer to the attend question");
  return { yes: a1.choice === "yes" && a2.choice === "yes", asks: [a1, a2], costUsd: r1.costUsd + r2.costUsd };
}

/** Text between two spans that joins them into one time: a range's dash or "to". */
const CONNECTOR = /^\s*(?:-|–|to|until|till)\s*$/i;

/**
 * The node's date and time spans in the sentence, as one text in sentence order. Text between two spans
 * is kept only when it is a range's connector ("3:00 to 4:00 PM"); anything else between them (a room
 * number) is left out, so it is never read as a time. Empty when there are none.
 *
 * The reader's values are found in the whole node, so a span from elsewhere in it can match inside this sentence too:
 * "Thursday" from a heading above lands where "Thursday 3pm PT" starts (D2-02 corpus m06). The longest span at a place
 * wins and any span overlapping one kept is dropped, so a shorter echo never hides the time.
 */
export function spansIn(w: WindowState, key: string, sentence: string): string[] {
  const all: { at: number; text: string }[] = [];
  for (const v of w.values) {
    if (v.nodeKey !== key || (v.kind !== "date" && v.kind !== "time")) continue;
    const at = sentence.indexOf(v.text);
    if (at >= 0) all.push({ at, text: v.text });
  }
  all.sort((a, b) => b.text.length - a.text.length || a.at - b.at);
  const found: { at: number; text: string }[] = [];
  for (const f of all) if (!found.some((k) => f.at < k.at + k.text.length && k.at < f.at + f.text.length)) found.push(f);
  if (found.length === 0) return [];
  found.sort((a, b) => a.at - b.at);
  let out = (found[0] as { text: string }).text;
  for (let i = 1; i < found.length; i++) {
    const prev = found[i - 1] as { at: number; text: string };
    const cur = found[i] as { at: number; text: string };
    const between = sentence.slice(prev.at + prev.text.length, cur.at);
    out += CONNECTOR.test(between) ? between : " ";
    out += cur.text;
  }
  return [out];
}

/**
 * The card the down arrow opens: what, when (with the source and destination zones and offsets), which
 * calendar, and the sentence it came from. A card that asks lists the possible times as its picker
 * instead of one When, and shows Caret waiting on the user.
 */
export function eventCardSpec(offerKey: string, c: EventCandidate, calendar: string, windowId: string, key: string): PopupSpecT {
  const from = { node: `${windowId}/${key}`, quote: c.sentence };
  const derived = (rule: string) => ({ rule, derived: [from] });
  const header: PopupBlock = { type: "header", title: { text: c.title, ref: derived("eventTitle") } };
  const calendarRow = { label: "Calendar", value: { text: calendar, ref: derived("eventCalendar") } };
  const tail: PopupBlock[] = [
    { type: "source", value: { text: c.sentence, ref: from } },
    { type: "actions", items: [{ id: "add", label: "Add", key: "tab" }] },
  ];
  if (c.time.kind === "resolved") {
    const t = c.time.time;
    const rows = [
      { label: "When", value: { text: t.says, ref: derived("eventTime") } },
      { label: "Time zones", value: { text: t.zones, ref: derived("eventTime") }, secondary: true },
      calendarRow,
    ];
    return { v: 1, id: offerKey, figure: "offering", blocks: [header, { type: "facts", rows }, ...tail] };
  }
  const blocks: PopupBlock[] = [
    header,
    { type: "facts", rows: [{ label: "Which time?", value: { text: c.time.question, ref: derived("eventTimeQuestion") } }, calendarRow] },
    { type: "choices", rows: c.time.choices.map((t) => ({ label: { text: t.says, ref: derived("eventTime") }, hint: { text: t.zones, ref: derived("eventTime") } })), selected: 0 },
    ...tail,
  ];
  return { v: 1, id: offerKey, figure: "needsYou", blocks };
}

/** The plan an accepted card runs: one end state, the event at `time` in the calendar. */
export function eventPlan(offerKey: string, c: EventCandidate, calendar: string, time: EventTime): { plan: Plan; slots: Record<string, string> } {
  return {
    plan: {
      id: offerKey,
      title: `Add ${c.title} to ${calendar}`,
      slots: { title: "the event's title, from the sentence", calendar: "the calendar Caret adds events to" },
      steps: [{ says: `{{title}} is on {{calendar}}, ${time.says}`, end: { kind: "calendarEvent", calendar: "{{calendar}}", title: "{{title}}", start: time.start, end: time.end } }],
    },
    slots: { title: c.title, calendar },
  };
}

/** The offer line's end state: the time, or that the card asks which. */
function lineText(c: EventCandidate): string {
  return c.time.kind === "resolved" ? `${c.title}, ${c.time.time.says}` : `${c.title}, pick a time (${c.time.choices.length} possible)`;
}

interface Entry {
  offerKey: string;
  windowId: string;
  /** The node the sentence is in. */
  key: string;
  candidate: EventCandidate;
  /** The field the offer belongs to, kept so a card that asks can be offered again. */
  field: OfferField;
  /** When it was shown, for its lifetime (lifetimes.ts). */
  at: number;
}

export interface EventCardDeps {
  model: ScreenModel;
  askJev: AskJev | null;
  publish: (m: HelperMessage, accept?: AcceptHandler) => boolean;
  /** Runs an accepted card's plan as the task `taskId`, under an act grant. */
  run: (taskId: string, plan: Plan, slots: Record<string, string>) => Promise<TaskResult>;
  gate: OfferGate;
  /** People in memory, whose names count as persons. */
  people: () => readonly MemoryValue[];
  /** The calendar events are added to. */
  calendar: string;
  /** The Mac's clock, zone and locale for reading times; the process's own by default. */
  clock?: (now: number) => EventClock;
  live: () => boolean;
  now: () => number;
  count?: (name: string) => void;
  /** Whether a task id is in use already (a run a crash interrupted keeps its id); a new card skips it (B23). */
  taken?: (id: string) => boolean;
  /** Whether a window is a conversation (conversation.ts); a test passes a counting one. */
  isConversation?: (w: WindowState) => boolean;
  /**
   * Routing is on (routing/coordinator.ts): no sentence is judged on its own. A sentence the user finishes is listed by
   * the router from the field, and a conversation's new lines are kept as heard lines, with `heard` called, until a
   * decision takes or drops them. A chosen sentence is judged through `judge`, as before.
   */
  routed?: { heard: () => void };
  /** Sees each routed judgment's work, so the helper's eventsSettled covers it for tests and evaluations. */
  onJudged?: (work: Promise<void>) => void;
}

/** A conversation line kept for the router: a sentence, its node, and the field an offer would go in. */
export interface HeardLine {
  w: WindowState;
  key: string;
  sentence: string;
  field: OfferField;
}

export class EventCards {
  /** Sentences already judged, by window and text, so nothing is offered or asked about twice. */
  private readonly judged = new Set<string>();
  private readonly entries = new Map<string, Entry>();
  private seq = 0;
  /** Bumped when a new reader connects: an answer to a question asked before then is about other windows. */
  private gen = 0;
  /** Sentences being asked about now. */
  private pending = 0;
  /** A first look's scan is under way. */
  private looking = false;
  /** Conversation lines heard while routing is on, newest last, until the router takes or drops them. */
  private readonly heardLines: HeardLine[] = [];
  private readonly deps: EventCardDeps;

  constructor(deps: EventCardDeps) {
    this.deps = deps;
  }

  /** Offers shown now, for tests: a stated time, or the choices a card asks between. */
  shown(): { offerKey: string; title: string; when: { start: string; end: string } | { choices: { start: string; end: string }[] } }[] {
    return [...this.entries.values()].map((e) => {
      const t = e.candidate.time;
      return { offerKey: e.offerKey, title: e.candidate.title, when: t.kind === "resolved" ? { start: t.time.start, end: t.time.end } : { choices: t.choices.map((x) => ({ start: x.start, end: x.end })) } };
    });
  }

  private clockAt(now: number): EventClock {
    return this.deps.clock?.(now) ?? macClock(new Date(now));
  }

  /**
   * A snapshot's changes. A sentence finished in the field the user is typing in, or a new line in a
   * conversation window, is judged; an offer whose sentence left its node is withdrawn as stale.
   */
  onChanges(changes: readonly Change[]): Promise<void> {
    const work: Promise<void>[] = [];
    const lines: { w: WindowState; key: string; text: string; field: OfferField }[] = [];
    const model = this.deps.model;
    // Once per window state in a batch: for a window that is no conversation the check reads every node, so
    // asking it for every changed node made a snapshot that adds N nodes cost about N² node visits (CodeRabbit
    // on PR #5). The model gives every snapshot a new state, so a state's answer cannot change within a batch.
    const chat = new Map<WindowState, boolean>();
    const isChat = (w: WindowState): boolean => {
      let r = chat.get(w);
      if (r === undefined) chat.set(w, (r = (this.deps.isConversation ?? isConversation)(w)));
      return r;
    };
    for (const c of changes) {
      const w = model.windows.get(c.windowId);
      if (w === undefined || c.key === null || c.after === null || (c.kind !== "value" && c.kind !== "added")) continue;
      const typing = c.editable && c.kind === "value" && model.focusedWindowId === w.window.windowId && w.focusedKey === c.key && model.frontmostPid === w.app.pid;
      if (typing) {
        // Routed, the router lists the field's last finished sentence itself (routing/context.ts breakpoint "sentence").
        const last = this.deps.routed === undefined ? sentences(c.after, false).at(-1) : undefined;
        if (last !== undefined) work.push(this.consider(w, c.key, last, offerField(w, c.key), "typed"));
      } else if (!c.editable && isChat(w)) {
        const field = this.typingField();
        if (field !== null) lines.push({ w, key: c.key, text: c.after, field });
      }
    }
    // A conversation that loads its history arrives as many new lines at once; only the latest few are
    // judged, newest first, so the newest line is not the one left waiting for a free ask.
    const routed = this.deps.routed;
    if (routed !== undefined) {
      const before = this.heardLines.length;
      for (const l of lines.slice(-MAX_NEW_LINES)) for (const s of sentences(l.text, true)) if (!this.judged.has(`${l.w.window.windowId}\u0000${s}`)) this.heardLines.push({ w: l.w, key: l.key, sentence: s, field: l.field });
      this.heardLines.splice(0, Math.max(0, this.heardLines.length - MAX_NEW_LINES));
      if (this.heardLines.length !== before || lines.length > 0) routed.heard();
    } else for (const l of lines.slice(-MAX_NEW_LINES).reverse()) for (const s of sentences(l.text, true)) work.push(this.consider(l.w, l.key, s, l.field, "conversation"));
    for (const e of [...this.entries.values()]) {
      const node = model.windows.get(e.windowId)?.nodes.get(e.key);
      if (node === undefined || !nodeText(node).includes(e.candidate.sentence) || this.started(e.candidate)) this.withdraw(e.offerKey, "stale");
    }
    return Promise.all(work).then(() => undefined);
  }

  /** The editable field the user is in now, in the frontmost app; null when there is none. */
  private typingField(): OfferField | null {
    const model = this.deps.model;
    const id = model.focusedWindowId;
    const w = id === null ? undefined : model.windows.get(id);
    const key = w?.focusedKey ?? null;
    if (w === undefined || key === null || w.nodes.get(key)?.editable !== true || model.frontmostPid !== w.app.pid) return null;
    return offerField(w, key);
  }

  /** The event's start has come (for a card that asks, every possible start): too late to offer or add it. */
  private started(c: EventCandidate): boolean {
    return lastStart(c) <= this.deps.now();
  }

  /** Conversation lines heard while routing is on, newest last. */
  heard(): readonly HeardLine[] {
    return this.heardLines;
  }

  /** The router decided about a heard line: it no longer waits. */
  forgetHeard(line: HeardLine): void {
    const i = this.heardLines.indexOf(line);
    if (i >= 0) this.heardLines.splice(i, 1);
  }

  /** The event a sentence in this node describes, read as `consider` reads it; null when it names no person or time ahead. */
  candidate(w: WindowState, key: string, sentence: string, source: SentenceSource): EventCandidate | null {
    return eventCandidate(sentence, spansIn(w, key, sentence), this.deps.people(), this.clockAt(this.deps.now()), source);
  }

  /** Whether this sentence in this window was judged already (asked about, or found to be no event). */
  isJudged(windowId: string, sentence: string): boolean {
    return this.judged.has(`${windowId}\u0000${sentence}`);
  }

  /** The router chose this sentence: judge it as an unrouted card would be (two asks, then the card or nothing). */
  judge(w: WindowState, key: string, sentence: string, field: OfferField, source: SentenceSource): Promise<void> {
    const p = this.consider(w, key, sentence, field, source);
    this.deps.onJudged?.(p);
    return p;
  }

  private async consider(w: WindowState, key: string, sentence: string, field: OfferField, source: SentenceSource): Promise<void> {
    const deps = this.deps;
    const id = `${w.window.windowId}\u0000${sentence}`;
    if (this.judged.has(id) || !deps.live() || deps.askJev === null) return;
    const now = deps.now();
    if (deps.gate.holds("event", now).length > 0) return;
    const c = eventCandidate(sentence, spansIn(w, key, sentence), deps.people(), this.clockAt(now), source);
    if (c === null) {
      this.judged.add(id);
      return;
    }
    // Asks are bounded, not queued: a sentence found while others are being asked about is left unjudged.
    if (this.pending >= MAX_PENDING_EVENT_ASKS) return deps.count?.("event.held_busy");
    this.judged.add(id);
    deps.count?.("event.asked");
    const gen = this.gen;
    let a: AttendAnswer | null;
    this.pending++;
    try {
      a = await askAttend(deps.askJev, deps.model, w, sentence, source);
    } catch {
      deps.count?.("event.jev_error");
      return;
    } finally {
      this.pending--;
    }
    if (a === null) return deps.count?.("event.held_privacy");
    if (!a.yes) return deps.count?.(a.asks[0].choice === a.asks[1].choice ? "event.no" : "event.disagree");
    // The reader, the screen, the clock and the settings may all have moved while Jev answered.
    if (gen !== this.gen || this.started(c)) return;
    const node = deps.model.windows.get(w.window.windowId)?.nodes.get(key);
    if (node === undefined || !nodeText(node).includes(sentence) || !deps.live() || deps.gate.holds("event", deps.now()).length > 0) return;
    this.show(w, key, c, field);
  }

  /**
   * Publishes the card. `replaces`: the key of a card that asks which was taken without a pick; the same
   * card comes back under a new key (the host marks an offer used once taken), without spending the
   * hourly offer budget again, and the old one is withdrawn as replaced by it.
   */
  private show(w: WindowState, key: string, c: EventCandidate, field: OfferField, replaces?: string): void {
    let offerKey = `event-${++this.seq}`;
    while (this.deps.taken?.(offerKey) === true) offerKey = `event-${++this.seq}`;
    const from = { node: `${w.window.windowId}/${key}`, quote: c.sentence };
    const msg: OfferAction = {
      type: "action",
      v: PROTOCOL_VERSION,
      offerKey,
      at: this.deps.now(),
      field,
      app: "Calendar",
      endState: { text: lineText(c), ref: { rule: "eventCard", derived: [from] } },
      actions: [{ id: "add", label: "Add", key: "tab" }],
      variants: eventCardSpec(offerKey, c, this.deps.calendar, w.window.windowId, key),
    };
    const entry: Entry = { offerKey, windowId: w.window.windowId, key, candidate: c, field, at: msg.at };
    if (!this.deps.publish(msg, (m) => this.accept(offerKey, m.overrides.variants))) return;
    this.entries.set(offerKey, entry);
    if (replaces !== undefined) {
      this.entries.delete(replaces);
      this.deps.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.deps.now(), id: replaces, reason: "reoffered", replacedBy: offerKey });
      this.deps.count?.("event.reoffered");
      return;
    }
    this.deps.gate.spoke(this.deps.now());
    this.deps.count?.("event.offered");
  }

  /**
   * Adds the event as the task `offerKey`, once the sentence is still where it was. `row` is the picker row
   * the user highlighted; a card that asks adds nothing without one.
   */
  private async accept(offerKey: string, row: number | undefined): Promise<AcceptResult> {
    const e = this.entries.get(offerKey);
    if (e === undefined) return { refused: "the offer was withdrawn" };
    const node = this.deps.model.windows.get(e.windowId)?.nodes.get(e.key);
    if (node === undefined || !nodeText(node).includes(e.candidate.sentence)) {
      this.withdraw(offerKey, "stale");
      return { refused: "the sentence is no longer on screen; nothing was added" };
    }
    if (this.started(e.candidate)) {
      this.withdraw(offerKey, "stale");
      return { refused: "the event's time has come; nothing was added" };
    }
    const time = chosenTime(e.candidate, row);
    if (typeof time === "string") {
      const w = this.deps.model.windows.get(e.windowId);
      if (row === undefined && w !== undefined) this.show(w, e.key, e.candidate, e.field, offerKey);
      return { refused: time };
    }
    if (Date.parse(time.start) <= this.deps.now()) {
      this.withdraw(offerKey, "stale");
      return { refused: "that time has come; nothing was added" };
    }
    this.withdraw(offerKey, "taken");
    const { plan, slots } = eventPlan(offerKey, e.candidate, this.deps.calendar, time);
    try {
      return await this.deps.run(offerKey, plan, slots);
    } catch (err) {
      return { refused: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * For the first look: sentences with a person and a time ahead in the open windows (fields' text and
   * conversation lines), from the most recently used windows, at most MAX_EVENT_LOOKS of them, each asked
   * about twice. The yeses, each with its window and node.
   */
  async firstLook(exclude: ReadonlySet<string>): Promise<{ w: WindowState; key: string; candidate: EventCandidate }[]> {
    const deps = this.deps;
    // One look at a time, so looks asked for together cannot multiply the asks in flight.
    if (deps.askJev === null || this.looking) return [];
    this.looking = true;
    try {
      return await this.look(exclude);
    } finally {
      this.looking = false;
    }
  }

  private async look(exclude: ReadonlySet<string>): Promise<{ w: WindowState; key: string; candidate: EventCandidate }[]> {
    const deps = this.deps;
    const gen = this.gen;
    const clockNow = this.clockAt(deps.now());
    const found: { w: WindowState; key: string; candidate: EventCandidate; source: SentenceSource }[] = [];
    const windows = [...deps.model.windows.values()]
      .filter((w) => !exclude.has(w.window.windowId))
      .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt || b.updatedAt - a.updatedAt);
    for (const w of windows) {
      const chat = isConversation(w);
      for (const n of w.nodes.values()) {
        if (found.length >= MAX_EVENT_LOOKS) break;
        if (n.states?.includes("secure") || (n.editable !== true && !chat)) continue;
        for (const s of sentences(nodeText(n), true)) {
          const source: SentenceSource = n.editable === true ? "typed" : "conversation";
          const c = eventCandidate(s, spansIn(w, n.key, s), deps.people(), clockNow, source);
          // A first look's card is taken without a picker row, so only a card with one stated time is offered.
          if (c !== null && c.time.kind === "resolved" && !found.some((f) => f.candidate.sentence === s)) found.push({ w, key: n.key, candidate: c, source });
        }
      }
    }
    const asked = await Promise.all(found.slice(0, MAX_EVENT_LOOKS).map(async (f) => ({ f, a: await askAttend(deps.askJev as AskJev, deps.model, f.w, f.candidate.sentence, f.source) })));
    // Answers about windows of a reader session that has since ended describe windows that are gone.
    if (gen !== this.gen) return [];
    return asked.filter((x) => x.a?.yes === true).map((x) => x.f);
  }

  /** Runs a first look's event card as the task `offerKey`, once the sentence is still where it was. */
  async acceptFound(offerKey: string, windowId: string, key: string, c: EventCandidate, run: (taskId: string, plan: Plan, slots: Record<string, string>) => Promise<TaskResult>): Promise<AcceptResult> {
    const node = this.deps.model.windows.get(windowId)?.nodes.get(key);
    if (node === undefined || !nodeText(node).includes(c.sentence)) return { refused: "the sentence is no longer on screen; nothing was added" };
    if (this.started(c)) return { refused: "the event's time has come; nothing was added" };
    if (c.time.kind !== "resolved") return { refused: "the card asks which time; nothing was added" };
    const { plan, slots } = eventPlan(offerKey, c, this.deps.calendar, c.time.time);
    return run(offerKey, plan, slots);
  }

  get calendar(): string {
    return this.deps.calendar;
  }

  /** Withdraws every offer whose lifetime has ended at `now`, and any whose event has started. */
  tick(now: number): void {
    for (const e of [...this.entries.values()]) {
      if (expired("event", e.at, now)) this.withdraw(e.offerKey, "expired");
      else if (this.started(e.candidate)) this.withdraw(e.offerKey, "stale");
    }
  }

  withdrawAll(reason: "settings" | "stale"): void {
    for (const k of [...this.entries.keys()]) this.withdraw(k, reason);
  }

  /** Window ids start over with a new reader; the helper withdraws every recorded offer itself. */
  readerRestarted(): void {
    this.gen++;
    this.entries.clear();
    this.judged.clear();
    this.heardLines.length = 0;
  }

  private withdraw(offerKey: string, reason: Exclude<OfferWithdrawn["reason"], "reoffered">): void {
    if (!this.entries.delete(offerKey)) return;
    this.deps.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.deps.now(), id: offerKey, reason });
  }
}
