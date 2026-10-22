// Journey row 1 (fixtures/web-form/journey.ts): a Gmail-shaped web thread should give the same calendar event offer the
// Apple Mail path gives for the same text. The thread is fixtures/web-form/public/mail's Maya message, its sentence
// from fixtures/web-form/mail.ts, and the page window comes from the page engine's walk (engines/page-link.ts
// toWindowSnapshot), as the journey's helper receives it. Every name and time is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MailSite } from "../../fixtures/web-form/mail.ts";
import { pageHost, type PageHost } from "../src/engines/host.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { FakeCalendar } from "../src/executor/means.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { conversationSign } from "../src/conversation.ts";
import { Helper } from "../src/helper.ts";
import { PROTOCOL_VERSION, type HelperMessage, type OfferAction, type PageSnapshot, type TypedValue } from "../src/protocol.ts";
import { Store } from "../src/store.ts";
import { field, snap, text } from "./builders.ts";
import { c, chrome, FakePage, hello, okReader, WIN } from "./fake-page.ts";

const ZONE = "America/Chicago";
/** A Monday; MailSite puts Maya's coffee on the first Thursday at least three days later (2026-10-15). */
const NOW = Date.parse("2026-10-12T09:00:00-05:00");
const site = new MailSite("AAAAAA", "BBBBBB", new Date(NOW));
const maya = site.messages().find((m) => m.id === "maya");
if (maya === undefined) throw new Error("the fixture inbox has no message from Maya");
const coffee = site.events.coffee;

let tz: string | undefined;
beforeAll(() => {
  tz = process.env.TZ;
  process.env.TZ = ZONE;
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

/** An instant as YYYY-MM-DD and HH:MM in the fixture's zone, as the journey reads the calendar. */
function local(iso: string): { date: string; time: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Jev says yes to both attend asks, as the journey's canned Jev does for the coffee. */
const yes: AskJev = async () => ({ model: "jev-test", answers: { attend: { choice: "yes", confidence: 0.9 } }, inputTokens: 50, latencyMs: 3, costUsd: 0 });

/**
 * Maya's thread as public/mail/mail.js renderThread draws it and the content script walks it today: its reply box and
 * Send, title and subject heading. Written by hand, since the extension's tests and these run without a DOM; the real
 * walker over the real page is the journey's row 1. A change that makes the walk carry message text must add that text
 * here as the walker would send it, and then turn the it.fails below into it.
 */
class ThreadPage extends FakePage {
  constructor() {
    super(() => [c("e1", "textarea", "Reply", { value: "" }), c("e2", "button", "Send")], `${maya?.subject ?? ""} - Mail`);
    this.path = "/mail/";
    this.focusedId = null;
  }

  override snapshot(id: string): PageSnapshot {
    const s = super.snapshot(id);
    for (const f of s.frames) f.headings = [maya?.subject ?? ""];
    return s;
  }
}

describe("journey row 1: an event offer from a web mail thread", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let host: PageHost;
  let page: ThreadPage;
  let calendar: FakeCalendar;
  let published: HelperMessage[];
  let clock: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-web-event-"));
    store = new Store(join(dir, "data"));
    calendar = new FakeCalendar();
    published = [];
    clock = NOW;
    page = new ThreadPage();
    host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: okReader, apply: (m) => void helper.handleReader(m), purge: (s) => helper.purgeWindow(s), warn: () => {} });
    helper = new Helper({ store, askJev: yes, shadow: false, allowBackgroundFocus: false, readerLink: host.link, calendar, now: () => clock, publish: (m) => void published.push(m), warn: () => {} });
    wirePageEngines({ host, helper, publish: () => {}, warn: () => {} });
    host.registry.add(page.session);
    page.session.receive(hello);
    await new Promise((r) => setTimeout(r, 0));
    // The browser is the app the user is in, as the journey's reader reports it.
    await helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock, from: null, to: chrome });
  });
  afterEach(() => {
    page.session.close();
    helper.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const walk = async (): Promise<void> => {
    clock += 1000;
    expect((await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN })).outcome).toBe("ok");
    await helper.eventsSettled;
  };
  const offers = (): OfferAction[] => published.filter((m): m is OfferAction => m.type === "action" && m.app === "Calendar");

  // Fails on beta: the walk carries the thread's controls, title and headings and none of its message text, so the window
  // has no line with the sentence, no typed date or time, and no sign of a conversation (conversation.ts conversationSign).
  it.fails("offers Maya's coffee once the user is in the reply box, and adds exactly its title, date, start and end", async () => {
    // The user opens the thread, clicks into the reply box and types, as the journey's eventOffer does.
    await walk();
    page.focusedId = "e1";
    page.find("e1").value = "Sounds good";
    await walk();
    const o = offers();
    expect(o).toHaveLength(1);
    const offer = o[0] as OfferAction;
    const shown = helper.events.shown().find((e) => e.offerKey === offer.offerKey);
    const when = shown !== undefined && "start" in shown.when ? shown.when : null;
    expect({ title: shown?.title, date: when === null ? null : local(when.start).date, start: when === null ? null : local(when.start).time, end: when === null ? null : local(when.end).time }).toEqual({
      title: coffee.title,
      date: coffee.date,
      start: coffee.start,
      end: coffee.end,
    });
    expect(await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: offer.offerKey, actionId: "add", overrides: {}, at: clock })).toMatchObject({ outcome: "done", acted: 1 });
    expect([...calendar.events.values()].map((e) => ({ title: e.title, date: local(e.start).date, start: local(e.start).time, end: local(e.end).time }))).toEqual([
      { title: coffee.title, date: coffee.date, start: coffee.start, end: coffee.end },
    ]);
    const undone = await helper.executor.undo(offer.offerKey);
    expect(undone.notRestored).toEqual([]);
    expect([...calendar.events.values()]).toEqual([]);
  });

  it("the walk of the thread brings none of its message text into the page window", async () => {
    await walk();
    page.focusedId = "e1";
    page.find("e1").value = "Sounds good";
    await walk();
    const w = helper.model.windows.get(WIN);
    if (w === undefined) throw new Error("the thread's page window is not in the model");
    const texts = [...w.nodes.values()].flatMap((n) => [n.label, n.value].filter((t): t is string => t !== undefined));
    expect(texts.some((t) => t.includes(coffee.sentence))).toBe(false);
    expect(w.values).toEqual([]);
    expect(conversationSign(w)).toBeNull();
    expect(offers()).toEqual([]);
  });
});

/**
 * The same sentence through the Apple Mail path, for comparison. The reader's typed values are its time pattern's spans
 * (apps/screen-reader CaretScreenCore/TypedValues.swift, the `.time` pattern) and a date span for the written date.
 */
describe("the same sentence in Apple Mail", () => {
  const MAIL = { pid: 6262, bundleId: "com.apple.mail", name: "Mail" };
  const THREAD = "6262-1";
  const COMPOSE = "6262-2";
  const REPLY = "com.apple.mail/standard/textarea:body~0";
  const shown = [`From: ${maya.from}`, `Subject: ${maya.subject}`, ...maya.body];
  const lines = shown.map((t, i) => text(`com.apple.mail/standard/statictext:m${i}~0`, t));
  const lineKey = lines[shown.indexOf(coffee.sentence)]?.key ?? "";
  const dateText = /on (\w+, \w+ \d+, \d{4}),/.exec(coffee.sentence)?.[1] ?? "";
  const values: TypedValue[] = [
    { kind: "date", text: dateText, nodeKey: lineKey },
    { kind: "time", text: "3:00", nodeKey: lineKey },
    { kind: "time", text: "4:00 PM", nodeKey: lineKey },
  ];

  let dir: string;
  let store: Store;
  let helper: Helper;
  let published: HelperMessage[];
  let calendar: FakeCalendar;
  let clock: number;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-mail-event-"));
    store = new Store(join(dir, "data"));
    published = [];
    calendar = new FakeCalendar();
    clock = NOW;
    helper = new Helper({ store, askJev: yes, shadow: false, allowBackgroundFocus: false, calendar, now: () => clock, publish: (m) => void published.push(m), readerLink: okReader });
    await helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock, from: null, to: MAIL });
  });
  afterEach(() => {
    helper.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const offers = (): OfferAction[] => published.filter((m): m is OfferAction => m.type === "action" && m.app === "Calendar");

  it("offers the coffee when its line arrives in an open thread while the user is in a reply, and adds its title, date, start and end", async () => {
    clock += 1000;
    await helper.handleReader(snap(lines.slice(0, 3), { at: clock, windowId: THREAD, app: MAIL, title: maya.subject }));
    clock += 1000;
    await helper.handleReader(snap([field(REPLY, "", { role: "AXTextArea" })], { at: clock, windowId: COMPOSE, app: MAIL, title: "Re: Coffee", focused: true, focusedKey: REPLY }));
    clock += 1000;
    await helper.handleReader(snap(lines, { at: clock, windowId: THREAD, app: MAIL, title: maya.subject, values }));
    await helper.eventsSettled;
    const o = offers();
    expect(o.map((x) => helper.events.shown().find((e) => e.offerKey === x.offerKey)?.title)).toEqual([coffee.title]);
    expect(await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: o[0]?.offerKey ?? "", actionId: "add", overrides: {}, at: clock })).toMatchObject({ outcome: "done", acted: 1 });
    expect([...calendar.events.values()].map((e) => ({ title: e.title, date: local(e.start).date, start: local(e.start).time, end: local(e.end).time }))).toEqual([
      { title: coffee.title, date: coffee.date, start: coffee.start, end: coffee.end },
    ]);
  });

  // The journey's row 1 order: the thread is opened first and then the user goes to the reply. Entering the reply judges
  // the thread's latest lines already on screen (#57, event-card.ts enteredConversation), so Apple Mail offers the coffee
  // in this order too; the web thread above still does not, since its walk carries no message text.
  it("offers the coffee from a line that was on screen before the user went to the reply, and adds its title, date, start and end", async () => {
    clock += 1000;
    await helper.handleReader(snap(lines, { at: clock, windowId: THREAD, app: MAIL, title: maya.subject, focused: true, values }));
    clock += 1000;
    await helper.handleReader(snap([...lines, field(REPLY, "Sounds good", { role: "AXTextArea" })], { at: clock, windowId: THREAD, app: MAIL, title: maya.subject, focused: true, focusedKey: REPLY, values }));
    await helper.eventsSettled;
    const o = offers();
    expect(o.map((x) => helper.events.shown().find((e) => e.offerKey === x.offerKey)?.title)).toEqual([coffee.title]);
    expect(o[0]?.field).toMatchObject({ windowId: THREAD, key: REPLY });
    expect(await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: o[0]?.offerKey ?? "", actionId: "add", overrides: {}, at: clock })).toMatchObject({ outcome: "done", acted: 1 });
    expect([...calendar.events.values()].map((e) => ({ title: e.title, date: local(e.start).date, start: local(e.start).time, end: local(e.end).time }))).toEqual([
      { title: coffee.title, date: coffee.date, start: coffee.start, end: coffee.end },
    ]);
  });
});
