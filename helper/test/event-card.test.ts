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
import { DEFAULT_MINUTES, resolveEventTime } from "../src/offers/event-time.ts";
import { eventTitle, personIn, sentences } from "../src/offers/event-card.ts";
import { snap, text } from "./builders.ts";

interface Golden {
  now: string;
  sentences: { id: string; sentence: string; spans: { kind: "date" | "time"; text: string }[]; attend: "yes" | "no" | null; expect: { title: string; start: string; end: string } | null }[];
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

describe("event times", () => {
  const at = (spans: string[]) => resolveEventTime(spans, new Date(NOW));
  it("reads weekdays, relative days, month days and numeric dates against now", () => {
    expect(at(["Thu 3:00"])).toEqual({ start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00", says: "Thu 3:00 to 3:30 PM" });
    expect(at(["tomorrow at noon"])?.start).toBe("2026-10-06T12:00:00-05:00");
    expect(at(["Oct 16 at 6pm"])?.start).toBe("2026-10-16T18:00:00-05:00");
    expect(at(["Oct 16 at 6pm"])?.says).toBe("Oct 16 6:00 to 6:30 PM");
    expect(at(["10/12 at 2:30 PM"])?.start).toBe("2026-10-12T14:30:00-05:00");
    expect(at(["16 Oct 9am"])?.start).toBe("2026-10-16T09:00:00-05:00");
    expect(at(["Sep 3 at 9am"])?.start).toBe("2027-09-03T09:00:00-05:00");
  });

  it("reads hours without AM or PM by the stated rule, and tonight as evening", () => {
    expect(at(["Friday at 3"])?.start).toBe("2026-10-09T15:00:00-05:00");
    expect(at(["tomorrow at 10:30"])?.start).toBe("2026-10-06T10:30:00-05:00");
    expect(at(["tonight at 8"])?.start).toBe("2026-10-05T20:00:00-05:00");
    expect(at(["Sunday at 12"])?.start).toBe("2026-10-11T12:00:00-05:00");
    expect(at(["Friday at 15:00"])?.start).toBe("2026-10-09T15:00:00-05:00");
  });

  it("keeps a weekday or time still ahead today, and moves one already past on", () => {
    expect(at(["Monday at 3pm"])?.start).toBe("2026-10-05T15:00:00-05:00");
    expect(at(["Monday at 9am"])?.start).toBe("2026-10-12T09:00:00-05:00");
    expect(at(["4:30 PM"])?.start).toBe("2026-10-05T16:30:00-05:00");
    expect(at(["9:30 AM"])?.start).toBe("2026-10-06T09:30:00-05:00");
  });

  it("takes an end from a range, and lasts the default otherwise", () => {
    expect(at(["Thu 3:00 to 3:45"])?.end).toBe("2026-10-08T15:45:00-05:00");
    expect(at(["Friday 3-4pm"])).toMatchObject({ start: "2026-10-09T15:00:00-05:00", end: "2026-10-09T16:00:00-05:00" });
    expect(at(["Friday 11 to 12:30"])?.end).toBe("2026-10-09T12:30:00-05:00");
    expect(DEFAULT_MINUTES).toBe(30);
  });

  it("makes no event from a day alone, a bare number, the past, or a time that cannot be", () => {
    for (const spans of [["Friday"], ["Oct 16"], ["3"], ["yesterday at 3"], ["6pm last Friday"], ["today at 9am"], ["25:00"], ["13pm"], ["Feb 30 at 3pm"], []]) expect(at(spans)).toBeNull();
  });

  it("writes the offset of the event's own date across a daylight-saving change", () => {
    expect(at(["Nov 2 at 10am"])?.start).toBe("2026-11-02T10:00:00-06:00");
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
    const s = (req.state as { sentence: string }).sentence;
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

  it("offers exactly the 20 events, asks only where code found a person and a time ahead, and offers none of the 20 distractors", async () => {
    const results: { id: string; got: { title: string; start: string; end: string } | null }[] = [];
    const asked: string[] = [];
    for (const s of GOLDEN.sentences) {
      close();
      await fresh();
      await type(s.sentence, spansOf(s));
      const o = offers();
      expect(o.length, s.id).toBeLessThanOrEqual(1);
      const shown = helper.events.shown().find((e) => e.offerKey === o[0]?.offerKey);
      results.push({ id: s.id, got: shown === undefined ? null : { title: shown.title, start: shown.start, end: shown.end } });
      asked.push(...jev.asked);
    }
    expect(results).toEqual(GOLDEN.sentences.map((s) => ({ id: s.id, got: s.expect })));
    expect(asked.sort()).toEqual(GOLDEN.sentences.filter((s) => s.attend !== null).flatMap((s) => [s.sentence, s.sentence]).sort());
    expect(results.filter((r) => r.id.startsWith("s") && r.got !== null)).toHaveLength(20);
    expect(results.filter((r) => r.id.startsWith("d") && r.got !== null)).toHaveLength(0);
  });

  it("shows the offer as a Calendar line with the card behind it, and adds the event when taken", async () => {
    const s = GOLDEN.sentences[0] as Golden["sentences"][number];
    await type(s.sentence, spansOf(s));
    const o = offers()[0] as OfferAction;
    expect(o.endState.text).toBe("Coffee with Dana, Thu 3:00 to 3:30 PM");
    expect(o.field).toMatchObject({ windowId: COMPOSE, key: BODY });
    expect(o.variants?.blocks.map((b) => b.type)).toEqual(["header", "facts", "source", "actions"]);
    expect(o.endState.ref).toEqual({ rule: "eventCard", derived: [{ node: `${COMPOSE}/${BODY}`, quote: s.sentence }] });
    const r = await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: o.offerKey, actionId: "add", overrides: {}, at: clock });
    expect(r).toMatchObject({ outcome: "done", acted: 1 });
    expect([...calendar.events.values()]).toEqual([expect.objectContaining({ calendar: "Caret", title: "Coffee with Dana", start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00" })]);
    const undone = await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: o.offerKey, action: "undo" });
    expect(undone).toMatchObject({ restored: 1 });
    expect(calendar.events.size).toBe(0);
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
      snap([...history, text(line, "Lunch with Kofi tomorrow at noon?")], {
        at: clock,
        windowId: chat,
        app: { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" },
        title: "Kofi",
        values: [{ kind: "date", text: "tomorrow at noon", nodeKey: line }],
      }),
    );
    await helper.eventsSettled;
    const o = offers();
    expect(o).toHaveLength(1);
    expect(o[0]?.field).toMatchObject({ windowId: COMPOSE, key: BODY });
    expect(o[0]?.endState.text).toBe("Lunch with Kofi, Tue 12:00 to 12:30 PM");
    clock += 10 * 60 * 1000;
    helper.tick(clock);
    expect(published.some((m) => m.type === "offerWithdrawn" && m.id === o[0]?.offerKey && m.reason === "expired")).toBe(true);
  });

  it("finds an event card in a first look and adds it when taken", async () => {
    const s = GOLDEN.sentences[5] as Golden["sentences"][number];
    jev = attendJev(() => "no");
    await type(s.sentence, spansOf(s));
    jev = attendJev(() => "yes");
    helper.events.readerRestarted();
    const reply = await helper.handleFirstLook({ type: "firstLook", v: PROTOCOL_VERSION, requestId: "look-1", at: clock, families: ["event"], level: "balanced", deadlineMs: 4000 });
    expect(reply).toMatchObject({ outcome: "found", found: { kind: "action", family: "event", offerKey: "look-1.0", window: { windowId: COMPOSE } } });
    expect(reply.found?.spec.blocks[0]).toMatchObject({ type: "header", title: { text: "Drinks with Keiko" } });
    expect(await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: "look-1.0", actionId: "add", overrides: {}, at: clock })).toMatchObject({ outcome: "done" });
    expect([...calendar.events.values()][0]).toMatchObject({ title: "Drinks with Keiko", start: "2026-10-16T18:00:00-05:00" });
  });
});
