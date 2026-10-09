// The event card (brief B16). The time parser, the person and the title each have one right answer and
// are tested alone. Then the 40 sentences of fixtures/golden/event-sentences.json (20 that should make
// an offer, 20 that should not) go through the helper as text typed into a field, with the reader's
// spans as typed values and a fake Jev that answers as the fixture says; an offer taken adds the event
// to the fake calendar. Everything is invented; times are read in America/Chicago.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { FakeCalendar } from "../src/executor/means.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import { HelperMessage, PROTOCOL_VERSION, type AppRef, type OfferAction, type ReaderMessage, type TypedValue } from "../src/protocol.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { DURATION_CHOICES, resolveEventTime } from "../src/offers/event-time.ts";
import { EventCards, eventCandidate, eventTitle, MAX_PENDING_EVENT_ASKS, personIn, sentences, spansIn, withZones } from "../src/offers/event-card.ts";
import { ScreenModel } from "../src/model.ts";
import { DEFAULT_SETTINGS, OfferGate } from "../src/offers/settings.ts";
import type { WindowState } from "../src/model.ts";
import { snap, text } from "./builders.ts";
import { everyCaseSelected } from "./case-selection.ts";

interface Golden {
  now: string;
  sentences: { id: string; sentence: string; spans: { kind: "date" | "time"; text: string }[]; attend: "yes" | "no" | null; expect: { title: string; start: string; end: string } | { title: string; choices: { start: string; end: string }[] } | null }[];
}
const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/golden/event-sentences.json", import.meta.url)), "utf8")) as Golden;
const NOW = Date.parse(GOLDEN.now);

let zone: string | undefined;
beforeAll(() => {
  zone = process.env.TZ;
  process.env.TZ = "America/Chicago";
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

const CLOCK = { now: new Date(NOW), timeZone: "America/Chicago", locale: "en-US" };
const at = (spans: string[], source: "typed" | "conversation" = "typed") => resolveEventTime(spans, CLOCK, source);
/** A card's stated time, or null when it asks or makes no card. */
const stated = (spans: string[]) => {
  const w = at(spans);
  return w?.kind === "resolved" ? w.time : null;
};
const choices = (spans: string[], source: "typed" | "conversation" = "typed") => {
  const w = at(spans, source);
  return w?.kind === "ask" ? w.choices.map((c) => `${c.start}/${c.end}`) : null;
};

describe("event times", () => {
  it("states a time only when the text gives its start, end, and half of the day", () => {
    expect(stated(["Thu 3:00 to 3:45 PM"])).toMatchObject({ start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:45:00-05:00", says: "Thu 3:00 to 3:45 PM" });
    expect(stated(["Friday 3-4pm"])).toMatchObject({ start: "2026-10-09T15:00:00-05:00", end: "2026-10-09T16:00:00-05:00" });
    expect(stated(["Oct 16 6pm to 7pm"])).toMatchObject({ start: "2026-10-16T18:00:00-05:00", says: "Oct 16 6:00 to 7:00 PM" });
    expect(stated(["10/12 at 2:30 PM to 3:30 PM"])?.start).toBe("2026-10-12T14:30:00-05:00");
    expect(stated(["Friday 15:00 to 16:00"])?.start).toBe("2026-10-09T15:00:00-05:00");
    expect(stated(["Oct 16 2027 6pm to 7pm"])?.start).toBe("2027-10-16T18:00:00-05:00");
  });

  it("asks how long when the text gives no end, offering both lengths and adding neither on its own", () => {
    expect(DURATION_CHOICES).toEqual([30, 60]);
    expect(choices(["tomorrow at noon"])).toEqual(["2026-10-06T12:00:00-05:00/2026-10-06T12:30:00-05:00", "2026-10-06T12:00:00-05:00/2026-10-06T13:00:00-05:00"]);
    expect(at(["tomorrow at noon"])).toMatchObject({ kind: "ask", question: expect.stringMatching(/How long/) });
  });

  it("asks AM or PM instead of guessing, and drops a choice already past", () => {
    expect(choices(["Friday 10am to 2"])).toEqual(["2026-10-09T10:00:00-05:00/2026-10-09T14:00:00-05:00", "2026-10-09T10:00:00-05:00/2026-10-10T02:00:00-05:00"]);
    expect(choices(["at 4 today"])).toEqual(["2026-10-05T16:00:00-05:00/2026-10-05T16:30:00-05:00", "2026-10-05T16:00:00-05:00/2026-10-05T17:00:00-05:00"]);
    // Two halves of the day times two lengths is four, more than the card's picker holds: no card.
    expect(at(["Thu 3:00"])).toBeNull();
    expect(at(["Friday at 3"])).toBeNull();
    expect(at(["Friday 3 to 4"])).toBeNull();
  });

  it("makes no card from a day alone, a bare number, the past, or a time that cannot be", () => {
    for (const spans of [["Friday"], ["Oct 16"], ["3"], ["yesterday at 3pm"], ["6pm last Friday"], ["today at 9am"], ["25:00"], ["13pm"], ["Feb 30 at 3pm"], [], ["Oct 16, 2025 at 6pm"]]) expect(at(spans), spans[0]).toBeNull();
  });

  it("reads a stated zone and shows the source zone, the destination zone and both offsets", () => {
    const pt = stated(["Oct 20 3:00 to 4:00 PM PT"]);
    expect(pt).toMatchObject({ start: "2026-10-20T17:00:00-05:00", end: "2026-10-20T18:00:00-05:00", says: "Oct 20 5:00 to 6:00 PM" });
    expect(pt?.zones).toBe("Oct 20, 3:00 to 4:00 PM PT (America/Los_Angeles, UTC-07:00) / 5:00 to 6:00 PM America/Chicago (UTC-05:00)");
    const plus2 = stated(["Oct 21 15:00 to 16:00 UTC+2"]);
    expect(plus2).toMatchObject({ start: "2026-10-21T08:00:00-05:00", end: "2026-10-21T09:00:00-05:00" });
    expect(plus2?.zones).toBe("Oct 21, 3:00 to 4:00 PM UTC+2 (UTC+02:00) / 8:00 to 9:00 AM America/Chicago (UTC-05:00)");
    expect(stated(["Thu 3:00 to 3:45 PM"])?.zones).toBe("Oct 8, 3:00 to 3:45 PM America/Chicago (UTC-05:00), your time zone");
  });

  it("asks with the real instants for a time the clocks skip or repeat, and for an ambiguous abbreviation", () => {
    expect(choices(["Nov 1 1:30 to 2:30 AM PT"])?.length).toBeGreaterThanOrEqual(2);
    expect(at(["Mar 14 2027 at 2:30am to 3:30am"])?.kind).toBe("ask");
    // IST is India, Ireland or Israel; Israel is on IDT on Oct 9, so two remain, each with both ends in one zone.
    expect(choices(["Friday 3pm to 4pm IST"])).toEqual(["2026-10-09T04:30:00-05:00/2026-10-09T05:30:00-05:00", "2026-10-09T09:00:00-05:00/2026-10-09T10:00:00-05:00"]);
  });

  it("tells apart choices that read the same because the clocks repeat an hour", () => {
    const w = resolveEventTime(["2026-11-01 00:30 to 01:30 PT"], { ...CLOCK, timeZone: "America/Los_Angeles" });
    expect(w?.kind).toBe("ask");
    const says = w?.kind === "ask" ? w.choices.map((c) => c.says) : [];
    expect(says).toEqual(["Nov 1 12:30 to 1:30 AM (UTC-07:00 to UTC-07:00)", "Nov 1 12:30 to 1:30 AM (UTC-07:00 to UTC-08:00)"]);
    // Two readings that end on the same offset still differ in the offset they start on.
    const both = resolveEventTime(["2026-11-01 01:15 to 02:15 PT"], { ...CLOCK, timeZone: "America/Los_Angeles" });
    const labels = both?.kind === "ask" ? both.choices.map((c) => c.says) : [];
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names each end's own zone when a range starts and ends in different zones", () => {
    expect(stated(["2026-10-21 09:00 PT to 13:00 ET"])?.zones).toBe("Oct 21, 9:00 AM PT (America/Los_Angeles, UTC-07:00) to 1:00 PM ET (America/New_York, UTC-04:00) / 11:00 AM to 12:00 PM America/Chicago (UTC-05:00)");
  });

  it("shows seconds when the time has them, as it will be added", () => {
    expect(stated(["2026-10-21T15:01:37Z to 2026-10-21T15:01:58Z"])).toMatchObject({ start: "2026-10-21T10:01:37-05:00", end: "2026-10-21T10:01:58-05:00", says: "Oct 21 10:01:37 to 10:01:58 AM" });
  });

  it("counts nothing from now in a conversation line: relative days make no card, and an unzoned time asks", () => {
    expect(at(["tomorrow at 3pm to 4pm"], "conversation")).toBeNull();
    expect(at(["Oct 16 6pm to 7pm"], "conversation")).toBeNull();
    expect(choices(["Oct 16, 2026 6pm to 7pm"], "conversation")).toEqual(["2026-10-16T18:00:00-05:00/2026-10-16T19:00:00-05:00"]);
    expect(stated(["Oct 16, 2026 6pm to 7pm"])).not.toBeNull();
    expect(at(["Oct 16, 2026 6pm to 7pm PT"], "conversation")?.kind).toBe("resolved");
  });

  it("takes a zone named right after the reader's span, and makes no card when a zone is named elsewhere", () => {
    expect(withZones("Coffee with Dana tomorrow at 3pm UTC.", ["tomorrow at 3pm"])).toEqual(["tomorrow at 3pm UTC"]);
    expect(withZones("Call with Dana 3pm (PT) Friday.", ["3pm"])).toEqual(["3pm PT"]);
    expect(withZones("Coffee at 3pm with Dana Best tomorrow.", ["3pm", "tomorrow"])).toEqual(["3pm", "tomorrow"]);
    expect(withZones("UTC: coffee with Dana tomorrow at 3pm.", ["tomorrow at 3pm"])).toBeNull();
    expect(eventCandidate("Coffee with Dana tomorrow from 3pm to 4pm UTC.", ["tomorrow", "3pm to 4pm"], [], CLOCK)?.time).toMatchObject({ kind: "resolved", time: { start: "2026-10-06T10:00:00-05:00" } });
    expect(eventCandidate("UTC: coffee with Dana tomorrow at 3pm.", ["tomorrow at 3pm"], [], CLOCK)).toBeNull();
    // A zone the resolver does not know, left out of the span, must not let the time be read as local.
    expect(withZones("Coffee with Dana on Oct 20, 2026 from 15:00 to 16:00 AWST.", ["Oct 20, 2026", "15:00 to 16:00"])).toBeNull();
    expect(eventCandidate("Coffee with Dana on Oct 20, 2026 from 15:00 to 16:00 AWST.", ["Oct 20, 2026", "15:00 to 16:00"], [], CLOCK)).toBeNull();
    expect(withZones("Sync with IT and Dana at 3pm to 4pm.", ["3pm to 4pm"])).toEqual(["3pm to 4pm"]);
    // A capitalized word away from the time is a word, not a zone.
    expect(eventCandidate("Meet Dana at MIT tomorrow from 3pm to 4pm.", ["tomorrow", "3pm to 4pm"], [], CLOCK)?.time.kind).toBe("resolved");
    expect(withZones("Coffee with Dana, JUST NOT before GPT demo, tomorrow 3pm to 4pm.", ["tomorrow 3pm to 4pm"])).toEqual(["tomorrow 3pm to 4pm"]);
  });
});

describe("person, title and sentences", () => {
  it("finds the person after with, meet, see, call or join, before 'and I', or from memory", () => {
    expect(personIn("Coffee with Dana Thu 3:00?", [])).toBe("Dana");
    expect(personIn("Interview with Priya Raman on Thursday at 11am.", [])).toBe("Priya Raman");
    expect(personIn("Dinner with Dana and Priya Fri 7pm.", [])).toBe("Dana and Priya");
    expect(personIn("Dana and I are grabbing coffee Friday at 3.", [])).toBe("Dana");
    expect(personIn("Meet Tomas at 9am on Wednesday.", [])).toBe("Tomas");
    expect(personIn("Lunch with the team Friday at noon.", [])).toBeNull();
    expect(personIn("Call me when you land.", [])).toBeNull();
    expect(personIn("Dana's flight lands at 3:45 PM.", [])).toBeNull();
    expect(personIn("Ping kofi about Friday at 3.", [{ id: "people-1", label: "kofi", text: "Kofi Mensah" }])).toBe("kofi");
  });

  it("titles the event by its word and person", () => {
    expect(eventTitle("Lunch with Priya tomorrow at noon.", "Priya")).toBe("Lunch with Priya");
    expect(eventTitle("Dana and I are grabbing coffee Friday at 3.", "Dana")).toBe("Coffee with Dana");
    expect(eventTitle("See Priya at 6:30 PM Friday.", "Priya")).toBe("Meet Priya");
  });

  it("reads the reader's spans as the stretch of the sentence they cover, so a range keeps its 'to'", () => {
    const w = { values: [{ kind: "date", text: "tomorrow", nodeKey: "k" }, { kind: "time", text: "3:00", nodeKey: "k" }, { kind: "time", text: "4:00pm", nodeKey: "k" }, { kind: "time", text: "9:00", nodeKey: "other" }] } as unknown as WindowState;
    const s = "Lunch with Dana tomorrow 3:00 to 4:00pm.";
    expect(spansIn(w, "k", s)).toEqual(["tomorrow 3:00 to 4:00pm"]);
    expect(stated(spansIn(w, "k", s))).toMatchObject({ start: "2026-10-06T15:00:00-05:00", end: "2026-10-06T16:00:00-05:00" });
    expect(spansIn(w, "none", s)).toEqual([]);
    // Words between two spans that are not a range's connector are left out: a room number is not a time.
    const room = { values: [{ kind: "date", text: "Friday", nodeKey: "k" }, { kind: "time", text: "3pm", nodeKey: "k" }] } as unknown as WindowState;
    const r = "Meeting with Dana Friday in room 2 at 3pm.";
    expect(spansIn(room, "k", r)).toEqual(["Friday 3pm"]);
    expect(choices(spansIn(room, "k", r))?.[0]).toBe("2026-10-09T15:00:00-05:00/2026-10-09T15:30:00-05:00");
  });

  it("prefers the longest span at a place: an earlier day word in the field never hides the time (D2-02 m06)", () => {
    const note = "Notes for Thursday\nAlso, let's set up a call with Priya Thursday 3pm PT to go over the budget.";
    const w = { values: [{ kind: "date", text: "Thursday", nodeKey: "k" }, { kind: "date", text: "Thursday 3pm PT", nodeKey: "k" }, { kind: "time", text: "3pm", nodeKey: "k" }] } as unknown as WindowState;
    const s = sentences(note, false).at(-1) as string;
    expect(spansIn(w, "k", s)).toEqual(["Thursday 3pm PT"]);
    // Order of the reader's values does not matter, and separate spans still join as before.
    const rev = { values: [...(w.values as TypedValue[])].reverse() } as unknown as WindowState;
    expect(spansIn(rev, "k", s)).toEqual(["Thursday 3pm PT"]);
    const range = { values: [{ kind: "time", text: "3:00", nodeKey: "k" }, { kind: "time", text: "4:00 PM", nodeKey: "k" }, { kind: "date", text: "Thu", nodeKey: "k" }] } as unknown as WindowState;
    expect(spansIn(range, "k", "Review with Dana Thu 3:00 to 4:00 PM.")).toEqual(["Thu 3:00 to 4:00 PM"]);
  });

  it("leaves out a last sentence still being typed", () => {
    expect(sentences("Hi Dana. Coffee with Dana Thu 3:00? Also", false)).toEqual(["Hi Dana.", "Coffee with Dana Thu 3:00?"]);
    expect(sentences("Coffee with Dana Thu 3:00?", false)).toEqual(["Coffee with Dana Thu 3:00?"]);
    expect(sentences("Coffee with Dana Thu 3:00\n", false)).toEqual(["Coffee with Dana Thu 3:00"]);
    expect(sentences("Coffee with Dana Thu 3:00", true)).toEqual(["Coffee with Dana Thu 3:00"]);
  });
});

// MARK: - the helper

const MAIL: AppRef = { pid: 6160, bundleId: "dev.caret.mail", name: "Mail Fixture" };
const COMPOSE = "6160-4";
const BODY = "dev.caret.mail/standard/textarea:body~0";

/** Answers the attend question as the fixture says, by sentence. */
function attendJev(answer: (sentence: string) => "yes" | "no"): AskJev & { asked: string[] } {
  const asked: string[] = [];
  const fn = async (req: JevRequest) => {
    const s = (req.state as unknown as { sentence: string }).sentence;
    asked.push(s);
    return { model: "jev-test", answers: { attend: { choice: answer(s), confidence: 0.9 } }, inputTokens: 50, latencyMs: 3, costUsd: 0.0000021 };
  };
  return Object.assign(fn, { asked });
}

describe("event cards through the helper", () => {
  let dir: string;
  let store: Store;
  let memory: MemoryStore;
  let helper: Helper;
  let published: HelperMessage[];
  let calendar: FakeCalendar;
  let jev: ReturnType<typeof attendJev>;
  let clock: number;

  const offers = (): OfferAction[] => published.filter((m): m is OfferAction => m.type === "action" && m.app === "Calendar");
  const send = (m: ReaderMessage) => void helper.handleReader(m);
  /** The user types `body` into the compose window's body field, which has focus in the frontmost app. */
  const type = async (body: string, values: TypedValue[] = []) => {
    clock += 1000;
    send(snap([{ key: BODY, parent: null, role: "AXTextArea", label: "Body", editable: true, ...(body === "" ? {} : { value: body }) }], { at: clock, windowId: COMPOSE, app: MAIL, title: "New message", focused: true, focusedKey: BODY, values }));
    await helper.eventsSettled;
  };

  /** A helper with a fresh store, so the hourly offer budget (4 at Balanced) starts empty. */
  const fresh = async (): Promise<void> => {
    dir = mkdtempSync(join(tmpdir(), "caret-event-"));
    store = new Store(join(dir, "data"));
    memory = new MemoryStore(join(dir, "data"));
    published = [];
    calendar = new FakeCalendar();
    clock = NOW;
    jev = attendJev((s) => GOLDEN.sentences.find((x) => x.sentence === s)?.attend ?? "no");
    helper = new Helper({ store, memory, askJev: (r) => jev(r), shadow: false, allowBackgroundFocus: false, publish: (m) => published.push(m), calendar, now: () => clock, readerLink: { run: async () => ({ type: "verbResult", v: PROTOCOL_VERSION, id: "x", at: clock, outcome: "ok", detail: null }) } });
    send({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock, from: null, to: MAIL });
    await type("");
  };
  const close = (): void => {
    for (const m of published) HelperMessage.parse(m);
    memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  beforeEach(fresh);
  afterEach(close);

  const spansOf = (s: Golden["sentences"][number]): TypedValue[] => s.spans.map((x) => ({ kind: x.kind, text: x.text, nodeKey: BODY }));

  // The 40 independent scenes took 5.424 s under full-suite CPU stress when batched in one 5 s test.
  // Each scene gets its own test and the existing fresh-store hooks; the aggregate checks still cover every scene.
  describe("the golden event sentences", () => {
    const results: { id: string; got: Record<string, unknown> | null }[] = [];
    const asked: string[] = [];

    it.each(GOLDEN.sentences)("$id: $sentence", async (s) => {
      await type(s.sentence, spansOf(s));
      const o = offers();
      expect(o.length, s.id).toBeLessThanOrEqual(1);
      const shown = helper.events.shown().find((e) => e.offerKey === o[0]?.offerKey);
      const got = shown === undefined ? null : { title: shown.title, ...shown.when };
      expect(got, s.id).toEqual(s.expect);
      results.push({ id: s.id, got });
      asked.push(...jev.asked);
    });

    afterAll(({}, suite) => {
      if (!everyCaseSelected(suite)) return;
      // Shuffled tests finish in a different order; compare the same complete set in fixture order.
      const order = GOLDEN.sentences.map((s) => s.id);
      results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      expect(results).toEqual(GOLDEN.sentences.map((s) => ({ id: s.id, got: s.expect })));
      expect(asked.sort()).toEqual(GOLDEN.sentences.filter((s) => s.attend !== null).flatMap((s) => [s.sentence, s.sentence]).sort());
      // s01, s07, s13, s15 and s19 give no AM or PM and no end: four possible times, more than the card's picker holds.
      expect(results.filter((r) => r.id.startsWith("s") && r.got !== null)).toHaveLength(15);
      expect(results.filter((r) => r.id.startsWith("d") && r.got !== null)).toHaveLength(0);
    });
  });

  it("shows the offer as a Calendar line with the card behind it, and adds the event when taken", async () => {
    jev = attendJev(() => "yes");
    const sentence = "Coffee with Dana Thu 3:00 to 3:30 PM.";
    await type(sentence, [{ kind: "date", text: "Thu 3:00 to 3:30 PM", nodeKey: BODY }]);
    const o = offers()[0] as OfferAction;
    expect(o.endState.text).toBe("Coffee with Dana, Thu 3:00 to 3:30 PM");
    expect(o.field).toMatchObject({ windowId: COMPOSE, key: BODY });
    expect(o.variants?.figure).toBe("offering");
    expect(o.variants?.blocks.map((b) => b.type)).toEqual(["header", "facts", "source", "actions"]);
    expect(o.variants?.blocks[1]).toMatchObject({ rows: [{ label: "When" }, { label: "Time zones", value: { text: "Oct 8, 3:00 to 3:30 PM America/Chicago (UTC-05:00), your time zone" } }, { label: "Calendar" }] });
    expect(o.endState.ref).toEqual({ rule: "eventCard", derived: [{ node: `${COMPOSE}/${BODY}`, quote: sentence }] });
    const r = await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: o.offerKey, actionId: "add", overrides: {}, at: clock });
    expect(r).toMatchObject({ outcome: "done", acted: 1 });
    expect([...calendar.events.values()]).toEqual([expect.objectContaining({ calendar: "Caret", title: "Coffee with Dana", start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00" })]);
    const undone = await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: o.offerKey, action: "undo" });
    expect(undone).toMatchObject({ restored: 1 });
    expect(calendar.events.size).toBe(0);
  });

  it("makes a card that asks when the text gives no end, and adds only the length the user picked", async () => {
    const s = GOLDEN.sentences[1] as Golden["sentences"][number];
    await type(s.sentence, spansOf(s));
    const o = offers()[0] as OfferAction;
    expect(o.endState.text).toBe("Lunch with Priya, pick a time (2 possible)");
    expect(o.variants?.figure).toBe("needsYou");
    expect(o.variants?.blocks.map((b) => b.type)).toEqual(["header", "facts", "choices", "source", "actions"]);
    expect(o.variants?.blocks[2]).toMatchObject({ type: "choices", rows: [{ label: { text: "Tue 12:00 to 12:30 PM" } }, { label: { text: "Tue 12:00 to 1:00 PM" } }] });
    const r = await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: o.offerKey, actionId: "add", overrides: { variants: 1 }, at: clock });
    expect(r).toMatchObject({ outcome: "done", acted: 1 });
    expect([...calendar.events.values()]).toEqual([expect.objectContaining({ title: "Lunch with Priya", start: "2026-10-06T12:00:00-05:00", end: "2026-10-06T13:00:00-05:00" })]);
  });

  it("adds nothing when a card that asks is taken without a picked time, and offers it again so a pick can follow", async () => {
    const s = GOLDEN.sentences[1] as Golden["sentences"][number];
    await type(s.sentence, spansOf(s));
    const o = offers()[0] as OfferAction;
    expect(await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: o.offerKey, actionId: "add", overrides: {}, at: clock })).toBeNull();
    expect(calendar.events.size).toBe(0);
    expect(calendar.calls).toEqual([]);
    const again = offers()[1] as OfferAction;
    expect(again.offerKey).not.toBe(o.offerKey);
    expect(again.variants?.blocks[2]).toEqual(o.variants?.blocks[2]);
    expect(published.some((m) => m.type === "offerWithdrawn" && m.id === o.offerKey && m.reason === "reoffered" && m.replacedBy === again.offerKey)).toBe(true);
    expect(await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: again.offerKey, actionId: "add", overrides: { variants: 0 }, at: clock })).toMatchObject({ outcome: "done" });
    expect([...calendar.events.values()]).toEqual([expect.objectContaining({ start: "2026-10-06T12:00:00-05:00", end: "2026-10-06T12:30:00-05:00" })]);
  });

  it("asks about a sentence once, withdraws the offer when the sentence is edited away, and refuses a stale accept", async () => {
    const s = GOLDEN.sentences[1] as Golden["sentences"][number];
    await type(s.sentence, spansOf(s));
    await type(s.sentence, spansOf(s));
    expect(jev.asked).toHaveLength(2);
    const o = offers()[0] as OfferAction;
    await type("Lunch with Priya", []);
    expect(published.some((m) => m.type === "offerWithdrawn" && m.id === o.offerKey && m.reason === "stale")).toBe(true);
    expect(await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: o.offerKey, actionId: "add", overrides: {}, at: clock })).toBeNull();
    expect(calendar.events.size).toBe(0);
  });

  it("makes no offer when one ask says no, when the calendar role is off, or when the window is not the one the user is typing in", async () => {
    const s = GOLDEN.sentences[2] as Golden["sentences"][number];
    let n = 0;
    jev = attendJev(() => (n++ % 2 === 0 ? "yes" : "no"));
    await type(s.sentence, spansOf(s));
    expect(offers()).toHaveLength(0);
    jev = attendJev(() => "yes");
    helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: clock, roles: ["fill", "repeat", "watch", "words"], level: "balanced", paused: false });
    const t = GOLDEN.sentences[3] as Golden["sentences"][number];
    await type(t.sentence, spansOf(t));
    expect(offers()).toHaveLength(0);
    expect(jev.asked).toHaveLength(0);
    helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: clock, roles: ["fill", "calendar"], level: "balanced", paused: false });
    send({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock, from: MAIL, to: { pid: 9, bundleId: "other", name: "Other" } });
    const u = GOLDEN.sentences[4] as Golden["sentences"][number];
    await type(u.sentence, spansOf(u));
    expect(offers()).toHaveLength(0);
  });

  it("offers from a new line in a conversation, in the field the user is in, and withdraws it after its lifetime", async () => {
    const chat = "7373-2";
    const line = "dev.caret.chat/standard/statictext:m1~0";
    jev = attendJev(() => "yes");
    // A conversation always keeps more than half its text back (privacy.ts), so the chat has some history.
    const history = ["Kofi: did the deck go out?", "Me: yes, this morning", "Kofi: great, thanks for pushing it", "Me: no problem, it was mostly done", "Kofi: are you around later this week?"].map((t, i) =>
      text(`dev.caret.chat/standard/statictext:h${i}~0`, t),
    );
    send(snap(history, { at: clock, windowId: chat, app: { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" }, title: "Kofi" }));
    clock += 1000;
    send(
      snap([...history, text(line, "Lunch with Kofi Oct 6, 2026 at noon CT?")], {
        at: clock,
        windowId: chat,
        app: { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" },
        title: "Kofi",
        values: [{ kind: "date", text: "Oct 6, 2026 at noon CT", nodeKey: line }],
      }),
    );
    await helper.eventsSettled;
    const o = offers();
    expect(o).toHaveLength(1);
    expect(o[0]?.field).toMatchObject({ windowId: COMPOSE, key: BODY });
    // A conversation line's send time is not on screen, so it names its date and zone; it gives no end, so the card asks how long.
    expect(o[0]?.endState.text).toBe("Lunch with Kofi, pick a time (2 possible)");
    clock += 10 * 60 * 1000;
    helper.tick(clock);
    expect(published.some((m) => m.type === "offerWithdrawn" && m.id === o[0]?.offerKey && m.reason === "expired")).toBe(true);
  });

  it("drops an answer to a question asked before the reader restarted", async () => {
    const s = GOLDEN.sentences[1] as Golden["sentences"][number];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const inner = jev;
    jev = Object.assign(async (r: JevRequest) => (await gate, inner(r)), { asked: inner.asked });
    const typed = type(s.sentence, spansOf(s));
    send({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 1, version: "t" });
    send({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock, from: null, to: MAIL });
    clock += 1000;
    send(snap([{ key: BODY, parent: null, role: "AXTextArea", label: "Body", editable: true, value: s.sentence }], { at: clock, windowId: COMPOSE, app: MAIL, title: "New message", focused: true, focusedKey: BODY, values: spansOf(s) }));
    release();
    await typed;
    await helper.eventsSettled;
    expect(offers()).toHaveLength(0);
  });

  it("asks about at most a few sentences at once, and leaves the rest unjudged", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const inner = attendJev(() => "yes");
    jev = Object.assign(async (r: JevRequest) => (await gate, inner(r)), { asked: inner.asked });
    const chat = "7373-3";
    const app = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
    const history = Array.from({ length: 30 }, (_, i) => text(`dev.caret.chat/standard/statictext:h${i}~0`, `Kofi: an earlier message about the deck, number ${i}`));
    send(snap(history, { at: clock, windowId: chat, app, title: "Kofi" }));
    clock += 1000;
    const lines = ["Lunch with Kofi Oct 6, 2026 at noon CT?", "Coffee with Priya Oct 9, 2026 at 3pm CT?", "Dinner with Marcus Oct 10, 2026 at 7pm CT?", "Breakfast with Ines Oct 11, 2026 at 9am CT?"];
    const keys = lines.map((_, i) => `dev.caret.chat/standard/statictext:n${i}~0`);
    const spans = ["Oct 6, 2026 at noon CT", "Oct 9, 2026 at 3pm CT", "Oct 10, 2026 at 7pm CT", "Oct 11, 2026 at 9am CT"];
    send(snap([...history, ...lines.map((t, i) => text(keys[i] as string, t))], { at: clock, windowId: chat, app, title: "Kofi", values: spans.map((t, i) => ({ kind: "date" as const, text: t, nodeKey: keys[i] as string })) }));
    const settled = helper.eventsSettled;
    release();
    await settled;
    // Three new lines at most are judged, and of those only two are asked about while others wait.
    expect(new Set(inner.asked).size).toBe(MAX_PENDING_EVENT_ASKS);
  });

  it("refuses to add an event whose time has come, and withdraws its offer", async () => {
    const s = GOLDEN.sentences[3] as Golden["sentences"][number];
    await type(s.sentence, spansOf(s));
    const o = offers()[0] as OfferAction;
    clock = Date.parse("2026-10-05T16:31:00-05:00");
    expect(await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: o.offerKey, actionId: "add", overrides: {}, at: clock })).toBeNull();
    expect(published.some((m) => m.type === "offerWithdrawn" && m.id === o.offerKey && m.reason === "stale")).toBe(true);
    expect(calendar.events.size).toBe(0);
  });

  it("finds an event card in a first look and adds it when taken, and leaves out a card that would ask", async () => {
    jev = attendJev(() => "no");
    const sentence = "Drinks with Keiko on Oct 16 from 6pm to 8pm.";
    await type(sentence, [{ kind: "date", text: "Oct 16", nodeKey: BODY }, { kind: "time", text: "6pm to 8pm", nodeKey: BODY }]);
    jev = attendJev(() => "yes");
    helper.events.readerRestarted();
    const reply = await helper.handleFirstLook({ type: "firstLook", v: PROTOCOL_VERSION, requestId: "look-1", at: clock, families: ["event"], level: "balanced", deadlineMs: 4000 });
    expect(reply).toMatchObject({ outcome: "found", found: { kind: "action", family: "event", offerKey: "look-1.0", window: { windowId: COMPOSE } } });
    expect(reply.found?.spec.blocks[0]).toMatchObject({ type: "header", title: { text: "Drinks with Keiko" } });
    expect(await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: "look-1.0", actionId: "add", overrides: {}, at: clock })).toMatchObject({ outcome: "done" });
    expect([...calendar.events.values()][0]).toMatchObject({ title: "Drinks with Keiko", start: "2026-10-16T18:00:00-05:00", end: "2026-10-16T20:00:00-05:00" });

    // A first look's card is taken without a picker row, so a sentence whose card would ask is not offered.
    close();
    await fresh();
    const s = GOLDEN.sentences[5] as Golden["sentences"][number];
    jev = attendJev(() => "no");
    await type(s.sentence, spansOf(s));
    jev = attendJev(() => "yes");
    helper.events.readerRestarted();
    const none = await helper.handleFirstLook({ type: "firstLook", v: PROTOCOL_VERSION, requestId: "look-2", at: clock, families: ["event"], level: "balanced", deadlineMs: 4000 });
    expect(none.found ?? null).toBeNull();
    expect(jev.asked).toHaveLength(0);
  });

  it("reads a mail's PT and UTC+2 times into the Mac's zone, shows both zones and offsets, and adds each to the fake calendar", async () => {
    // Synthetic mail lines; expected instants worked out by hand: Oct 20 3:00 PM PDT (UTC-7) is 22:00Z, 5:00 PM in
    // Chicago (CDT, UTC-5); Oct 21 15:00 at UTC+2 is 13:00Z, 8:00 AM in Chicago.
    jev = attendJev(() => "yes");
    const mail = "6161-1";
    const app = { pid: 6161, bundleId: "com.apple.mail", name: "Mail" };
    const history = ["From: Dana Whitfield", "To: me", "Subject: two calls this month", "Hi, a couple of things to put in the diary.", "Thanks!"].map((t, i) => text(`com.apple.mail/standard/statictext:h${i}~0`, t));
    send(snap(history, { at: clock, windowId: mail, app, title: "two calls this month" }));
    const lines = [
      { key: "com.apple.mail/standard/statictext:m1~0", sentence: "Call with Dana on Oct 20, 2026 from 3:00 to 4:00 PM PT.", values: ["Oct 20, 2026", "3:00 to 4:00 PM PT"] },
      { key: "com.apple.mail/standard/statictext:m2~0", sentence: "Sync with Priya on Oct 21, 2026 from 15:00 to 16:00 UTC+2.", values: ["Oct 21, 2026", "15:00 to 16:00"] },
    ];
    clock += 1000;
    send(
      snap([...history, ...lines.map((l) => text(l.key, l.sentence))], {
        at: clock,
        windowId: mail,
        app,
        title: "two calls this month",
        values: lines.flatMap((l) => l.values.map((v, i) => ({ kind: i === 0 ? ("date" as const) : ("time" as const), text: v, nodeKey: l.key }))),
      }),
    );
    await helper.eventsSettled;
    const o = offers();
    expect(o.map((x) => x.endState.text).sort()).toEqual(["Call with Dana, Oct 20 5:00 to 6:00 PM", "Sync with Priya, Oct 21 8:00 to 9:00 AM"]);
    const card = (title: string) => o.find((x) => x.endState.text.startsWith(title)) as OfferAction;
    const zones = (x: OfferAction) => (x.variants?.blocks[1] as { rows: { label?: string; value: { text: string } }[] }).rows.find((r) => r.label === "Time zones")?.value.text;
    expect(zones(card("Call with Dana"))).toBe("Oct 20, 3:00 to 4:00 PM PT (America/Los_Angeles, UTC-07:00) / 5:00 to 6:00 PM America/Chicago (UTC-05:00)");
    expect(zones(card("Sync with Priya"))).toBe("Oct 21, 3:00 to 4:00 PM UTC+2 (UTC+02:00) / 8:00 to 9:00 AM America/Chicago (UTC-05:00)");
    for (const x of o) expect(await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: x.offerKey, actionId: "add", overrides: {}, at: clock })).toMatchObject({ outcome: "done", acted: 1 });
    const added = [...calendar.events.values()].map((e) => ({ title: e.title, start: e.start, end: e.end, startUtc: new Date(e.start).toISOString(), endUtc: new Date(e.end).toISOString() }));
    expect(added.sort((a, b) => a.start.localeCompare(b.start))).toEqual([
      { title: "Call with Dana", start: "2026-10-20T17:00:00-05:00", end: "2026-10-20T18:00:00-05:00", startUtc: "2026-10-20T22:00:00.000Z", endUtc: "2026-10-20T23:00:00.000Z" },
      { title: "Sync with Priya", start: "2026-10-21T08:00:00-05:00", end: "2026-10-21T09:00:00-05:00", startUtc: "2026-10-21T13:00:00.000Z", endUtc: "2026-10-21T14:00:00.000Z" },
    ]);
  });
});

describe("judging a batch of changes (CodeRabbit on PR #5)", () => {
  it("asks whether a window is a conversation once per window per batch, however many of its nodes changed", async () => {
    const model = new ScreenModel();
    const nodes = Array.from({ length: 200 }, (_, i) => text(`notes/line${i}`, `Line ${i} of a long note`));
    model.apply(snap([], { at: 1000, windowId: "notes", title: "Notes" }));
    const changes = model.apply(snap(nodes, { at: 2000, windowId: "notes", title: "Notes" }));
    expect(changes.filter((c) => c.kind === "added")).toHaveLength(200);
    let calls = 0;
    const cards = new EventCards({
      model,
      askJev: null,
      publish: () => true,
      run: () => Promise.reject(new Error("nothing runs")),
      gate: new OfferGate(DEFAULT_SETTINGS),
      people: () => [],
      calendar: "Caret",
      live: () => true,
      now: () => 2000,
      isConversation: () => (calls++, false),
    });
    await cards.onChanges(changes);
    expect(calls).toBe(1);
  });
});

describe("Q1 bug 9: the dogfood's sentence with PT", () => {
  it("makes a card that shows the time in PT and in the Mac's zone, and asks how long since the text gives no end", () => {
    const sentence = "Also, let's set up a call with Priya Thursday 3pm PT to go over the budget.";
    const clock = { now: new Date("2026-10-04T16:00:00Z"), timeZone: "America/Chicago", locale: "en-US" };
    // The reader typed the whole span in the capture (evidence/screen/b24/capture-2); the zone is found either way.
    for (const spans of [["Thursday 3pm PT"], ["Thursday", "3pm"]]) {
      const c = eventCandidate(sentence, spans, [{ id: "p1", label: "Priya", text: "Priya Raman" }], clock, "typed");
      expect(c?.title).toBe("Call with Priya");
      if (c?.time.kind !== "ask") throw new Error("expected a card that asks how long");
      expect(c.time.choices.map((t) => t.zones)).toEqual([
        "Oct 8, 3:00 to 3:30 PM PT (America/Los_Angeles, UTC-07:00) / 5:00 to 5:30 PM America/Chicago (UTC-05:00)",
        "Oct 8, 3:00 to 4:00 PM PT (America/Los_Angeles, UTC-07:00) / 5:00 to 6:00 PM America/Chicago (UTC-05:00)",
      ]);
    }
  });
});
