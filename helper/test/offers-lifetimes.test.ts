// B8 acceptance: each producer's offer lifetime (src/offers/lifetimes.ts) and partial withdrawal of
// alternatives, over the real socket as in offers-socket.test.ts. The helper's clock is the reader
// simulator's stream clock, and the test moves it and ticks the helper by hand, so every lifetime is
// crossed exactly: one millisecond before it nothing goes, at it the withdrawal does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type Activity, type OfferAction, type OfferAlternatives, type PatternOffer, type ReaderMessage, type TaskProgress } from "../src/protocol.ts";
import { OFFER_LIFETIMES } from "../src/offers/lifetimes.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { MAIL_APP, focus, jevPickingText, snap } from "./builders.ts";
import { Desk, PEOPLE, grid, roster, type GridWindow, type ListWindow } from "./scene.ts";
import { captureEdit } from "../src/patterns/preferences.ts";
import { EDIT_SETTLE_MS } from "../src/patterns/engine.ts";
import { FIXTURE_APP } from "./builders.ts";
import { LineClient, SocketReader, loadRecording, until } from "./socket-reader.ts";

const F = (s: string): string => `dev.caret.fixture/standard/${s}`;
const M = (s: string): string => `dev.caret.mail/standard/${s}`;
const D = (s: string): string => `dev.caret.directory/standard/${s}`;
const FORM = "5150-2";
const ORDER = "6160-1";
const SEATING = "6160-2";
const ROSTER = "5150-1";
const DIRECTORY = "7170-1";
const JOB = "5150-3";
const guest = (r: number): string => M(`textfield:guest~${r}`);
const person = (name: string): string => D(`group:people/statictext:${name.toLowerCase()}~0`);
const attendee = (name: string): string => F(`group:attendees/statictext:${name.toLowerCase()}~0`);
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const FILL_VALUES: Record<string, string> = { Name: "Dana Whitfield", Email: "dana.whitfield@example.com", Phone: "+1 (512) 555-0142" };
/** While set, fill questions wait on it, so a test can change the screen while Jev "answers". */
let jevGate: Promise<void> | null = null;
const askJev: AskJev = async (req) => {
  if (req.questions.finished !== undefined) {
    const done = /done|passed/i.test(String((req.state as Record<string, unknown>).now));
    return { model: "jev-test", answers: { finished: { choice: done ? "yes" : "no", confidence: 0.9 }, waiting: { choice: "no", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  }
  if (jevGate !== null) await jevGate;
  return jevPickingText((_, instructions) => FILL_VALUES[/Label: '([^']+)'/.exec(instructions)?.[1] ?? ""] ?? null)(req);
};

type Sent = { type: string; [k: string]: unknown };
const accept = (offerId: string, actionId: string): object => ({ type: "offerAccept", v: PROTOCOL_VERSION, offerId, actionId, overrides: {}, at: 1 });

/** What a Desk script would send a helper, as reader messages and ticks in order, so the session can go over the socket. */
type DeskEvent = { m: ReaderMessage } | { tick: number };
function recordDesk(script: (desk: Desk) => void): DeskEvent[] {
  const out: DeskEvent[] = [];
  const lastAt = new Map<string, number>();
  const sink = {
    handleReader: (m: ReaderMessage) => {
      const c = structuredClone(m);
      // The replay waits for each snapshot by its window and time, so two of one window never share a time.
      if (c.type === "snapshot") {
        const prev = lastAt.get(c.window.windowId) ?? -1;
        if (c.at <= prev) c.at = prev + 1;
        lastAt.set(c.window.windowId, c.at);
      }
      out.push({ m: c });
      return null;
    },
    tick: (at: number) => out.push({ tick: at }),
  };
  script(new Desk().attach(sink as unknown as Helper));
  return out;
}

describe("offer lifetimes over the socket", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let host: LineClient;
  let reader: SocketReader;

  const hooks = {
    applied: (windowId: string, at: number): boolean => helper.model.windows.get(windowId)?.updatedAt === at,
    tick: (at: number): void => helper.tick(at),
  };
  const withdrawals = (): [string, string][] => host.received.flatMap((m) => {
    const w = m as Sent;
    return w.type === "offerWithdrawn" ? [[String(w.id), String(w.reason)] as [string, string]] : [];
  });
  /** Moves the stream clock to `at` and ticks the helper there, as main.ts's 250 ms tick would on reaching it. */
  const tickAt = async (at: number): Promise<void> => {
    reader.clock = at;
    helper.tick(at);
    // Withdrawals cross the socket; give them a turn to arrive.
    await new Promise((r) => setTimeout(r, 30));
  };
  const replayDesk = async (events: readonly DeskEvent[]): Promise<void> => {
    for (const e of events) {
      if ("tick" in e) {
        reader.clock = Math.max(reader.clock, e.tick);
        helper.tick(e.tick);
        continue;
      }
      const m = e.m;
      reader.send(m);
      if (m.type === "snapshot") await until(() => hooks.applied(m.window.windowId, m.at));
      else if (m.type === "windowClosed") await until(() => !helper.model.windows.has(m.windowId));
    }
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-lifetimes-"));
    store = new Store(join(dir, "data"));
    let n = 0;
    helper = new Helper({
      store,
      askJev,
      shadow: false,
      allowBackgroundFocus: false,
      newId: () => `id-${++n}`,
      now: () => reader?.clock ?? 0,
      publish: (m) => server.publish(m),
      sendToReader: (cmd) => server.sendToReader(cmd),
    });
    server = new HelperServer(join(dir, "screen.sock"), () => helper, () => {});
    await server.listen();
    host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "host-test" });
    reader = await SocketReader.connect(join(dir, "screen.sock"));
  });

  afterEach(async () => {
    jevGate = null;
    host.close();
    reader.close();
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the lifetimes in one table", () => {
    expect(Object.fromEntries(Object.entries(OFFER_LIFETIMES).map(([k, v]) => [k, v.ms]))).toEqual({ fill: null, loopNext: 2 * MIN, loopFinish: 5 * MIN, routine: 10 * MIN, open: null });
  });

  describe("fill pop-up: until the field or the form changes", () => {
    it("outlives any timer, and moving among the form's own fields or to a source keeps it", async () => {
      await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
      await host.waitFor((m) => m.type === "popup");
      await tickAt(reader.clock + 24 * 60 * MIN);
      reader.send(focus(FORM, F("textfield:email~0"), reader.clock + 10));
      reader.send(focus(ORDER, M("statictext:dana whitfield~0"), reader.clock + 20, { editable: false, empty: false, app: MAIL_APP }));
      await tickAt(reader.clock + 30);
      expect(withdrawals()).toEqual([]);
      expect(helper.offers.get("id-1")?.kind).toBe("popup");
    });

    it("expires when focus lands in an editable field outside the form, and an accept is then refused", async () => {
      await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
      await host.waitFor((m) => m.type === "popup");
      const search = snap([{ key: M("textfield:search~0"), parent: null, role: "AXTextField", label: "Search", editable: true }], { at: reader.clock + 10, windowId: "6160-9", title: "Search", app: MAIL_APP, focused: true, reason: "focus" });
      reader.send(search);
      await until(() => hooks.applied("6160-9", search.at));
      reader.send(focus("6160-9", M("textfield:search~0"), reader.clock + 10, { app: MAIL_APP }));
      expect(await host.waitFor((m) => m.type === "offerWithdrawn")).toMatchObject({ id: "id-1", reason: "expired" });
      host.send(accept("id-1", "fillAll"));
      expect(await host.waitFor((m) => m.type === "error")).toMatchObject({ message: "offer id-1: no such offer, or it expired" });
      expect(reader.verbs.filter((v) => v.kind === "write")).toEqual([]);
    });

    it("is withdrawn as stale when a destination fills", async () => {
      await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
      await host.waitFor((m) => m.type === "popup");
      reader.setValue(FORM, F("textfield:phone~0"), "typed by hand");
      expect(await host.waitFor((m) => m.type === "offerWithdrawn")).toMatchObject({ id: "id-1", reason: "stale" });
      expect(helper.offers.size).toBe(0);
    });

    it("is not shown at all when focus left the form while Jev answered", async () => {
      let release = (): void => {};
      jevGate = new Promise((r) => (release = r));
      await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
      const search = snap([{ key: M("textfield:search~0"), parent: null, role: "AXTextField", label: "Search", editable: true }], { at: reader.clock + 10, windowId: "6160-9", title: "Search", app: MAIL_APP, focused: true, reason: "focus" });
      reader.send(search);
      await until(() => hooks.applied("6160-9", search.at));
      reader.send(focus("6160-9", M("textfield:search~0"), reader.clock + 10, { app: MAIL_APP }));
      await until(() => helper.model.frontmostPid === MAIL_APP.pid);
      release();
      await new Promise((r) => setTimeout(r, 100));
      expect(host.received.some((m) => (m as Sent).type === "popup")).toBe(false);
      expect(helper.offers.size).toBe(0);
      store.flush();
      expect(store.counts()["fill.popup_stale"]).toBe(1);
    });

    it("is not shown when focus left the form and came back while Jev answered", async () => {
      let release = (): void => {};
      jevGate = new Promise((r) => (release = r));
      await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
      const search = snap([{ key: M("textfield:search~0"), parent: null, role: "AXTextField", label: "Search", editable: true }], { at: reader.clock + 10, windowId: "6160-9", title: "Search", app: MAIL_APP, focused: true, reason: "focus" });
      reader.send(search);
      await until(() => hooks.applied("6160-9", search.at));
      reader.send(focus("6160-9", M("textfield:search~0"), reader.clock + 10, { app: MAIL_APP }));
      await until(() => helper.model.frontmostPid === MAIL_APP.pid);
      // More focuses inside the form than any fixed log would hold: the one that left must still count.
      for (let i = 0; i < 120; i++) reader.send(focus(FORM, F(i % 2 === 0 ? "textfield:name~0" : "textfield:email~0"), reader.clock + 20 + i, { empty: true }));
      await until(() => helper.model.frontmostPid === FIXTURE_APP.pid);
      await new Promise((r) => setTimeout(r, 50));
      release();
      await new Promise((r) => setTimeout(r, 100));
      expect(host.received.filter((m) => (m as Sent).type === "popup")).toEqual([]);
    });

    it("is withdrawn as stale when its source window closes", async () => {
      await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
      await host.waitFor((m) => m.type === "popup");
      reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: reader.clock + 10, windowId: ORDER });
      expect(await host.waitFor((m) => m.type === "offerWithdrawn")).toMatchObject({ id: "id-1", reason: "stale" });
    });
  });

  describe("loop offers", () => {
    it("loopNext expires two minutes after it was made", async () => {
      await reader.replay(loadRecording("offers-loop.ndjson"), hooks);
      const alt = await host.waitFor<OfferAlternatives>((m) => m.type === "alternatives");
      const made = alt.at;
      await tickAt(made + 2 * MIN - 1);
      expect(withdrawals()).toEqual([]);
      await tickAt(made + 2 * MIN);
      expect(withdrawals()).toEqual([
        ["offer-1.0", "expired"],
        ["offer-1", "expired"],
      ]);
      expect(helper.offers.size).toBe(0);
    });

    it("loopFinish expires after five minutes, though its loop's two-minute gap ran out long before; its ready task becomes undone by Caret, and an accept is refused", async () => {
      await reader.replay(loadRecording("offers-loop.ndjson"), hooks);
      await host.waitFor((m) => m.type === "alternatives");
      const typed = reader.setValue(SEATING, guest(2), "Lena Hartmann");
      await until(() => hooks.applied(SEATING, typed.at));
      helper.tick(typed.at + 2000);
      const action = await host.waitFor<{ at: number; offerKey: string }>((m) => m.type === "action");
      expect(action.offerKey).toBe("offer-2");
      await tickAt(action.at + 5 * MIN - 1);
      expect(withdrawals().filter(([id]) => id === "offer-2")).toEqual([]);
      await tickAt(action.at + 5 * MIN);
      expect(withdrawals().filter(([id]) => id === "offer-2")).toEqual([["offer-2", "expired"]]);
      const rows = host.received.filter((m): m is Activity => (m as Sent).type === "activity" && (m as Activity).task.id === "offer-2");
      expect(rows.at(-1)?.task).toMatchObject({ state: "undone", cause: "caret", detail: "withdrawn: expired" });
      host.send(accept("offer-2", "finish"));
      expect(await host.waitFor((m) => m.type === "error")).toMatchObject({ message: "offer offer-2: no such offer, or it expired" });
      expect(reader.verbs.filter((v) => v.kind === "write")).toEqual([]);
    });
  });

  it("loopFinish outliving its quiet loop is withdrawn once the user's own value in one of its rows settles", async () => {
    await reader.replay(loadRecording("offers-loop.ndjson"), hooks);
    await host.waitFor((m) => m.type === "alternatives");
    const typed = reader.setValue(SEATING, guest(2), "Lena Hartmann");
    await until(() => hooks.applied(SEATING, typed.at));
    helper.tick(typed.at + 2000);
    const action = await host.waitFor<{ at: number }>((m) => m.type === "action");
    await tickAt(action.at + 3 * MIN);
    expect(helper.patterns.loops.active).toBeNull();
    expect(withdrawals().filter(([id]) => id === "offer-2")).toEqual([]);
    reader.clock = action.at + 3 * MIN + 10;
    const own = reader.setValue(SEATING, guest(4), "Somebody Else");
    await until(() => hooks.applied(SEATING, own.at));
    // A value typed by hand is judged once it is still, as a re-offer is.
    await tickAt(own.at + EDIT_SETTLE_MS - 1);
    expect(withdrawals().filter(([id]) => id === "offer-2")).toEqual([]);
    await tickAt(own.at + EDIT_SETTLE_MS);
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === "offer-2")).toMatchObject({ reason: "stale" });
    expect(helper.offers.get("offer-2")).toBeUndefined();
  });

  it("loopFinish the user completes by hand is withdrawn as taken, and its task is done by the user", async () => {
    await reader.replay(loadRecording("offers-loop.ndjson"), hooks);
    await host.waitFor((m) => m.type === "alternatives");
    const typed = reader.setValue(SEATING, guest(2), "Lena Hartmann");
    await until(() => hooks.applied(SEATING, typed.at));
    helper.tick(typed.at + 2000);
    await host.waitFor((m) => m.type === "action");
    // All three remaining rows arrive in one snapshot, as a paste of the block would.
    const seating = reader.windows.get(SEATING)!;
    ["Oskar Lindqvist", "Yusuf Demir", "Mila Novak"].forEach((name, i) => (seating.nodes.find((n) => n.key === guest(3 + i))!.value = name));
    const shown = reader.show(SEATING);
    await until(() => hooks.applied(SEATING, shown.at));
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === "offer-2")).toMatchObject({ reason: "taken" });
    const rows = host.received.filter((m): m is Activity => (m as Sent).type === "activity" && (m as Activity).task.id === "offer-2");
    expect(rows.at(-1)?.task).toMatchObject({ state: "done", cause: "you", detail: "you entered the values yourself" });
    expect(reader.verbs.filter((v) => v.kind === "write")).toEqual([]);
  });

  it("loopNext is withdrawn at once when its source line changes, though its loop is live", async () => {
    await reader.replay(loadRecording("offers-loop.ndjson"), hooks);
    await host.waitFor((m) => m.type === "alternatives");
    const roster = reader.windows.get(ROSTER)!;
    roster.nodes.find((n) => n.key === attendee("Marcus Lowe"))!.label = "Marcus Lowe (left the team)";
    const shown = reader.show(ROSTER);
    await until(() => hooks.applied(ROSTER, shown.at));
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === "offer-1")).toMatchObject({ reason: "stale" });
    // The loop ended with its prediction: the old value typed now does not confirm it.
    expect(helper.patterns.loops.active).toBeNull();
    const typed = reader.setValue(SEATING, guest(2), "Marcus Lowe");
    await until(() => hooks.applied(SEATING, typed.at));
    helper.tick(typed.at + 2000);
    await new Promise((r) => setTimeout(r, 50));
    expect(host.received.some((m) => (m as Sent).type === "action")).toBe(false);
  });

  it("routine: expires ten minutes after its window opened", async () => {
    const calendar = (day: number): ListWindow => ({
      windowId: "5150-20",
      app: FIXTURE_APP,
      title: "Calendar",
      group: "Event",
      lines: [`Design review ${day}`, `priya.raman+${day}@northwind.example`, `https://meet.example.com/day-${day}`],
    });
    const compose = (day: number): GridWindow => ({ windowId: `6160-${100 + day}`, app: MAIL_APP, title: `New message ${day}`, columns: ["Subject", "To", "Link"], rows: 1, values: new Map() });
    // Three days of copying the same three values teach the routine and prove it silently; the fourth day's compose window gets the offer.
    const events = recordDesk((desk) => {
      for (let day = 1; day <= 4; day++) {
        desk.at += DAY;
        const cal = calendar(day);
        desk.showList(cal);
        desk.advance(1000);
        const c = compose(day);
        desk.showGrid(c);
        if (day === 4) return;
        for (let i = 0; i < 3; i++) desk.fill(c, 0, i, cal.lines[i] as string);
        desk.close(c.windowId);
      }
    });
    await replayDesk(events);
    const action = await host.waitFor<{ at: number; offerKey: string; actions: { id: string }[] }>((m) => m.type === "action");
    expect(action.actions.map((a) => a.id)).toEqual(["run"]);
    await tickAt(action.at + 10 * MIN - 1);
    expect(withdrawals()).toEqual([]);
    await tickAt(action.at + 10 * MIN);
    expect(withdrawals()).toEqual([[action.offerKey, "expired"]]);
  });

  it("open: outlives the old ten-minute hold and ends as taken when the user visits the window", async () => {
    await reader.replay(loadRecording("offers-pending.ndjson"), hooks);
    await helper.pending.whenIdle();
    const action = await host.waitFor<{ at: number; offerKey: string }>((m) => m.type === "action");
    await tickAt(action.at + 24 * 60 * MIN);
    expect(withdrawals()).toEqual([]);
    expect(helper.offers.get(action.offerKey)?.kind).toBe("action");
    reader.send(focus(JOB, null, reader.clock + 10, { editable: false, empty: false }));
    expect(await host.waitFor((m) => m.type === "offerWithdrawn")).toMatchObject({ id: action.offerKey, reason: "taken" });
  });

  it("open: closing the window of the field it is shown in withdraws that showing and offers it again in the next field", async () => {
    await reader.replay(loadRecording("offers-pending.ndjson"), hooks);
    await helper.pending.whenIdle();
    const action = await host.waitFor<{ offerKey: string; field: { windowId: string } }>((m) => m.type === "action");
    expect(action.field.windowId).toBe("6160-4");
    reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: reader.clock + 10, windowId: "6160-4" });
    expect(await host.waitFor((m) => m.type === "offerWithdrawn")).toMatchObject({ id: action.offerKey, reason: "stale" });
    const search = snap([{ key: M("textfield:search~0"), parent: null, role: "AXTextField", label: "Search", editable: true }], { at: reader.clock + 20, windowId: "6160-9", title: "Search", app: MAIL_APP, focused: true, reason: "focus" });
    reader.send(search);
    await until(() => hooks.applied("6160-9", search.at));
    reader.send(focus("6160-9", M("textfield:search~0"), reader.clock + 10, { app: MAIL_APP }));
    const again = await host.waitFor<{ offerKey: string; field: { windowId: string; key: string } }>((m) => m.type === "action" && m.offerKey !== action.offerKey);
    expect(again.offerKey).toBe("open-watch-id-1.2");
    expect(again.field).toMatchObject({ windowId: "6160-9", key: M("textfield:search~0") });
    expect(helper.offers.get(action.offerKey)).toBeUndefined();
  });

  it("open: a field focused just before its bound window closed gets the offer at once", async () => {
    await reader.replay(loadRecording("offers-pending.ndjson"), hooks);
    await helper.pending.whenIdle();
    const action = await host.waitFor<{ offerKey: string }>((m) => m.type === "action");
    const search = snap([{ key: M("textfield:search~0"), parent: null, role: "AXTextField", label: "Search", editable: true }], { at: reader.clock + 10, windowId: "6160-9", title: "Search", app: MAIL_APP, focused: true, reason: "focus" });
    reader.send(search);
    await until(() => hooks.applied("6160-9", search.at));
    reader.send(focus("6160-9", M("textfield:search~0"), reader.clock + 10, { app: MAIL_APP }));
    reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: reader.clock + 20, windowId: "6160-4" });
    const again = await host.waitFor<{ offerKey: string; field: { windowId: string } }>((m) => m.type === "action" && m.offerKey !== action.offerKey);
    expect(again).toMatchObject({ offerKey: "open-watch-id-1.2", field: { windowId: "6160-9" } });
  });

  it("open: does not rebind to a field that has since gone from its window", async () => {
    await reader.replay(loadRecording("offers-pending.ndjson"), hooks);
    await helper.pending.whenIdle();
    const action = await host.waitFor<{ offerKey: string }>((m) => m.type === "action");
    const search = snap([{ key: M("textfield:search~0"), parent: null, role: "AXTextField", label: "Search", editable: true }], { at: reader.clock + 10, windowId: "6160-9", title: "Search", app: MAIL_APP, focused: true, reason: "focus" });
    reader.send(search);
    await until(() => hooks.applied("6160-9", search.at));
    reader.send(focus("6160-9", M("textfield:search~0"), reader.clock + 10, { app: MAIL_APP }));
    const empty = snap([], { at: reader.clock + 20, windowId: "6160-9", title: "Search", app: MAIL_APP, focused: true });
    reader.send(empty);
    await until(() => hooks.applied("6160-9", empty.at));
    reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: reader.clock + 30, windowId: "6160-4" });
    await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === action.offerKey);
    await new Promise((r) => setTimeout(r, 50));
    expect(host.received.filter((m) => (m as Sent).type === "action")).toHaveLength(1);
    expect(helper.openApp.pending()).toEqual([{ offerKey: "open-watch-id-1.2", published: false }]);
  });

  describe("re-offer what the user left", () => {
    /** offer-2: the loopFinish for guest rows 3 to 5 (Oskar Lindqvist, Yusuf Demir, Mila Novak), after Lena Hartmann is typed in row 2. */
    const finishOffer = async (): Promise<OfferAction> => {
      await reader.replay(loadRecording("offers-loop.ndjson"), hooks);
      await host.waitFor((m) => m.type === "alternatives");
      const typed = reader.setValue(SEATING, guest(2), "Lena Hartmann");
      await until(() => hooks.applied(SEATING, typed.at));
      // The stream clock moves with the tick, so what the user types next comes after it.
      await tickAt(typed.at + 2000);
      return host.waitFor<OfferAction>((m) => m.type === "action" && m.offerKey === "offer-2");
    };
    /** Types `value` into a field one prefix at a time, 150 ms apart, as the reader sees a person type; returns the last snapshot's time. */
    const typeByHand = async (windowId: string, key: string, value: string): Promise<number> => {
      let at = 0;
      for (let i = 1; i <= value.length; i += 3) {
        reader.clock += 150;
        const s = reader.setValue(windowId, key, value.slice(0, Math.min(value.length, i + 2)));
        await until(() => hooks.applied(windowId, s.at));
        at = s.at;
      }
      return at;
    };
    const task = (id: string): Activity["task"] | undefined =>
      host.received.filter((m): m is Activity => (m as Sent).type === "activity" && (m as Activity).task.id === id).at(-1)?.task;
    const phases = async (taskId: string): Promise<string[]> => {
      await host.waitFor((m) => m.type === "taskProgress" && m.taskId === taskId && ["done", "failed"].includes(String(m.phase)));
      return host.received.filter((m): m is TaskProgress => (m as Sent).type === "taskProgress" && (m as TaskProgress).taskId === taskId).map((m) => m.phase);
    };

    it("loopFinish: one row typed by hand re-offers the other two under a new key once the typing settles, and taking it writes only those", async () => {
      await finishOffer();
      const last = await typeByHand(SEATING, guest(3), "Oskar Lindqvist");
      // Every prefix of the name passed through the field; none withdrew the offer.
      await tickAt(last + EDIT_SETTLE_MS - 1);
      expect(withdrawals().filter(([id]) => id === "offer-2")).toEqual([]);
      await tickAt(last + EDIT_SETTLE_MS);
      const gone = host.received.find((m) => (m as Sent).type === "offerWithdrawn" && (m as Sent).id === "offer-2");
      expect(gone).toMatchObject({ reason: "reoffered", replacedBy: "offer-3" });
      const again = await host.waitFor<OfferAction>((m) => m.type === "action" && m.offerKey === "offer-3");
      expect(again.field.key).toBe(guest(4));
      expect(again.endState).toEqual({
        text: "Finish the rest: 2 more values from Directory Fixture",
        ref: { rule: "loopFinish", derived: ["Yusuf Demir", "Mila Novak"].map((name) => ({ node: `${DIRECTORY}/${person(name)}`, quote: name })) },
      });
      const offer = host.received.find((m): m is PatternOffer => (m as Sent).type === "patternOffer" && (m as PatternOffer).id === "offer-3");
      expect(offer?.cells.map((c) => [c.key, c.value])).toEqual([
        [guest(4), "Yusuf Demir"],
        [guest(5), "Mila Novak"],
      ]);
      expect(task("offer-2")).toMatchObject({ state: "undone", cause: "you", detail: "you entered some values; the rest are offered as offer-3" });
      expect(task("offer-3")).toMatchObject({ state: "ready" });
      expect(helper.offers.get("offer-2")).toBeUndefined();

      host.send(accept("offer-3", "finish"));
      expect(await phases("offer-3")).toEqual(["started", "acting", "verified", "acting", "verified", "done"]);
      expect(reader.verbs.filter((v) => v.kind === "write" && v.attribute !== "focused").map((v) => (v as { key: string }).key)).toEqual([guest(4), guest(5)]);
      expect([2, 3, 4, 5].map((r) => reader.value(SEATING, guest(r)))).toEqual(["Lena Hartmann", "Oskar Lindqvist", "Yusuf Demir", "Mila Novak"]);
    });

    it("loopFinish: the re-offer's own five minutes start when it is made", async () => {
      await finishOffer();
      reader.clock += 60 * 1000;
      const typed = reader.setValue(SEATING, guest(3), "Oskar Lindqvist");
      await until(() => hooks.applied(SEATING, typed.at));
      await tickAt(typed.at + EDIT_SETTLE_MS);
      const again = await host.waitFor<OfferAction>((m) => m.type === "action" && m.offerKey === "offer-3");
      await tickAt(again.at + 5 * MIN - 1);
      expect(withdrawals().filter(([id]) => id === "offer-3")).toEqual([]);
      await tickAt(again.at + 5 * MIN);
      expect(withdrawals().filter(([id]) => id === "offer-3")).toEqual([["offer-3", "expired"]]);
    });

    it("loopFinish: a second row by hand re-offers the last one, and the last by hand ends it as taken by the user", async () => {
      await finishOffer();
      for (const [row, name, next] of [[3, "Oskar Lindqvist", "offer-3"], [4, "Yusuf Demir", "offer-4"]] as const) {
        const typed = reader.setValue(SEATING, guest(row), name);
        await until(() => hooks.applied(SEATING, typed.at));
        await tickAt(typed.at + EDIT_SETTLE_MS);
        await host.waitFor((m) => m.type === "action" && m.offerKey === next);
      }
      const last = host.received.find((m): m is PatternOffer => (m as Sent).type === "patternOffer" && (m as PatternOffer).id === "offer-4");
      expect(last?.says).toBe("Finish the rest: 1 more value from Directory Fixture");
      const typed = reader.setValue(SEATING, guest(5), "Mila Novak");
      await until(() => hooks.applied(SEATING, typed.at));
      expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === "offer-4")).toMatchObject({ reason: "taken" });
      expect(task("offer-4")).toMatchObject({ state: "done", cause: "you" });
      expect(withdrawals()).toContainEqual(["offer-2", "reoffered"]);
      expect(withdrawals()).toContainEqual(["offer-3", "reoffered"]);
      expect(reader.verbs.filter((v) => v.kind === "write")).toEqual([]);
    });

    it("routine: one end state reached by hand re-offers the other two", async () => {
      const calendar = (day: number): ListWindow => ({
        windowId: "5150-20",
        app: FIXTURE_APP,
        title: "Calendar",
        group: "Event",
        lines: [`Design review ${day}`, `priya.raman+${day}@northwind.example`, `https://meet.example.com/day-${day}`],
      });
      const compose = (day: number): GridWindow => ({ windowId: `6160-${100 + day}`, app: MAIL_APP, title: `New message ${day}`, columns: ["Subject", "To", "Link"], rows: 1, values: new Map() });
      const events = recordDesk((desk) => {
        for (let day = 1; day <= 4; day++) {
          desk.at += DAY;
          const cal = calendar(day);
          desk.showList(cal);
          desk.advance(1000);
          const c = compose(day);
          desk.showGrid(c);
          if (day === 4) return;
          for (let i = 0; i < 3; i++) desk.fill(c, 0, i, cal.lines[i] as string);
          desk.close(c.windowId);
        }
      });
      await replayDesk(events);
      const action = await host.waitFor<OfferAction>((m) => m.type === "action");
      const offer = host.received.find((m): m is PatternOffer => (m as Sent).type === "patternOffer" && (m as PatternOffer).id === action.offerKey);
      expect(offer?.cells).toHaveLength(3);
      const [first, ...rest] = offer?.cells ?? [];
      const last = await typeByHand(first!.windowId, first!.key, first!.value);
      await tickAt(last + EDIT_SETTLE_MS);
      const gone = host.received.find((m) => (m as Sent).type === "offerWithdrawn" && (m as Sent).id === action.offerKey) as { reason: string; replacedBy: string } | undefined;
      expect(gone?.reason).toBe("reoffered");
      const again = await host.waitFor<OfferAction>((m) => m.type === "action" && m.offerKey === gone?.replacedBy);
      expect(again.actions.map((a) => a.id)).toEqual(["run"]);
      expect(again.field.key).toBe(rest[0]?.key);
      const reoffer = host.received.find((m): m is PatternOffer => (m as Sent).type === "patternOffer" && (m as PatternOffer).id === again.offerKey);
      expect(reoffer).toMatchObject({ kind: "routine", patternId: offer?.patternId, says: "Fill 2 values from Caret Fixture" });
      expect(reoffer?.cells.map((c) => [c.key, c.value])).toEqual(rest.map((c) => [c.key, c.value]));
      host.send(accept(again.offerKey, "run"));
      expect((await phases(again.offerKey)).at(-1)).toBe("done");
      expect(rest.map((c) => reader.value(c.windowId, c.key))).toEqual(rest.map((c) => c.value));
    });

    it("loopFinish: a row the user fills with a value the offer did not predict, beside one it did, is stale, not re-offered", async () => {
      await finishOffer();
      const ok = reader.setValue(SEATING, guest(3), "Oskar Lindqvist");
      await until(() => hooks.applied(SEATING, ok.at));
      const own = reader.setValue(SEATING, guest(4), "Somebody Else");
      await until(() => hooks.applied(SEATING, own.at));
      await tickAt(own.at + EDIT_SETTLE_MS);
      expect(withdrawals().filter(([id]) => id === "offer-2")).toEqual([["offer-2", "stale"]]);
      expect(host.received.some((m) => (m as Sent).type === "action" && (m as Sent).offerKey === "offer-3")).toBe(false);
    });
  });

  describe("partial withdrawal of alternatives", () => {
    it("drops the other list's candidate when its window closes, and withdraws only when none remain", async () => {
      await reader.replay(loadRecording("offers-loop.ndjson"), hooks);
      await host.waitFor((m) => m.type === "alternatives");
      reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: reader.clock + 10, windowId: DIRECTORY });
      const again = await host.waitFor<OfferAlternatives>((m) => m.type === "alternatives" && host.received.filter((x) => (x as Sent).type === "alternatives").indexOf(m) === 1);
      expect({ ...again, at: 0 }).toEqual({
        type: "alternatives",
        v: 1,
        offerKey: "offer-1.0",
        at: 0,
        field: { pid: 6160, windowId: SEATING, key: guest(2), frame: [100, 100, 200, 24], window: { number: null, title: "Seating" } },
        candidates: [{ text: "Marcus Lowe", ref: { node: `${ROSTER}/${attendee("Marcus Lowe")}`, quote: "Marcus Lowe" } }],
        quoted: true,
      });
      expect(withdrawals()).toEqual([]);
      expect(helper.offers.get("offer-1.0")?.message).toEqual(again);

      reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: reader.clock + 20, windowId: ROSTER });
      await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === "offer-1");
      expect(withdrawals()).toEqual([
        ["offer-1.0", "stale"],
        ["offer-1", "stale"],
      ]);
      expect(helper.offers.size).toBe(0);
    });

    it("hands the loop to the other list when the main one closes, even when a memory rule made the main value the same name", async () => {
      const dstShape = store.hash(`dst\u0000${MAIL_APP.bundleId}\u0000standard\u0000${MAIL_APP.bundleId}/standard/textfield:guest`);
      captureEdit(helper.memory, (t) => store.hash(t), { source: "Marcus Lowe", written: "Marcus Lowe", edited: "Lena Hartmann", kind: null, dstShapeHash: dstShape, fieldLabel: "Guest", app: "Mail Fixture" }, 1);
      await reader.replay(loadRecording("offers-loop.ndjson"), hooks);
      const first = await host.waitFor<OfferAlternatives>((m) => m.type === "alternatives");
      expect(first.candidates.map((c) => c.text)).toEqual(["Lena Hartmann", "Lena Hartmann"]);
      reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: reader.clock + 10, windowId: ROSTER });
      const again = await host.waitFor<OfferAlternatives>((m) => m.type === "alternatives" && host.received.filter((x) => (x as Sent).type === "alternatives").indexOf(m) === 1);
      expect(again.candidates).toEqual([{ text: "Lena Hartmann", ref: { node: `${DIRECTORY}/${person("Lena Hartmann")}`, quote: "Lena Hartmann" } }]);
      const typed = reader.setValue(SEATING, guest(2), "Lena Hartmann");
      await until(() => hooks.applied(SEATING, typed.at));
      helper.tick(typed.at + 2000);
      const action = await host.waitFor<{ endState: { text: string } }>((m) => m.type === "action");
      expect(action.endState.text).toBe("Finish the rest: 3 more values from Directory Fixture");
    });

    it("keeps a value two lists both show when one of them closes, quoting the other", async () => {
      const copy = roster(PEOPLE, "5150-9");
      const events = recordDesk((desk) => {
        desk.showList(roster());
        desk.showList(copy);
        desk.advance(1000);
        const g = grid();
        desk.showGrid(g);
        desk.fill(g, 0, 0, PEOPLE[0] as string);
        desk.fill(g, 1, 0, PEOPLE[1] as string);
      });
      await replayDesk(events);
      const first = await host.waitFor<OfferAlternatives>((m) => m.type === "alternatives");
      expect(first.candidates.map((c) => c.text)).toEqual([PEOPLE[2]]);
      const quoted = (a: OfferAlternatives): string => String((a.candidates[0]?.ref as { node: string }).node.split("/")[0]);
      const gone = quoted(first);
      const other = gone === "5150-1" ? "5150-9" : "5150-1";
      reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: reader.clock + 10, windowId: gone });
      const again = await host.waitFor<OfferAlternatives>((m) => m.type === "alternatives" && host.received.filter((x) => (x as Sent).type === "alternatives").indexOf(m) === 1);
      expect(again.candidates.map((c) => c.text)).toEqual([PEOPLE[2]]);
      expect(quoted(again)).toBe(other);
      expect(again.quoted).toBe(true);
      expect(withdrawals()).toEqual([]);
    });

    it("does not re-point a value to a second list that no longer shows it", async () => {
      const copy = roster(PEOPLE, "5150-9");
      const events = recordDesk((desk) => {
        desk.showList(roster());
        desk.showList(copy);
        desk.advance(1000);
        const g = grid();
        desk.showGrid(g);
        desk.fill(g, 0, 0, PEOPLE[0] as string);
        desk.fill(g, 1, 0, PEOPLE[1] as string);
      });
      await replayDesk(events);
      const first = await host.waitFor<OfferAlternatives>((m) => m.type === "alternatives");
      const gone = String((first.candidates[0]?.ref as { node: string }).node.split("/")[0]);
      const other = gone === "5150-1" ? "5150-9" : "5150-1";
      // The other list's copy of the predicted name changes before the quoted list closes.
      const w = reader.windows.get(other)!;
      const n = w.nodes.find((x) => x.label === PEOPLE[2])!;
      n.label = `${PEOPLE[2]} (moved)`;
      const shown = reader.show(other);
      await until(() => hooks.applied(other, shown.at));
      reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: reader.clock + 10, windowId: gone });
      await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === "offer-1");
      expect(withdrawals()).toEqual([
        ["offer-1.0", "stale"],
        ["offer-1", "stale"],
      ]);
      expect(host.received.filter((m) => (m as Sent).type === "alternatives")).toHaveLength(1);
    });

    it("does not let a list whose value was never offered take the round when another window closes", async () => {
      const lists = [
        roster(PEOPLE, "5150-1"),
        roster([PEOPLE[0]!, PEOPLE[1]!, "Ines Okafor", ...PEOPLE.slice(3)], "5150-11"),
        roster([PEOPLE[0]!, PEOPLE[1]!, "Tomas Berg", ...PEOPLE.slice(3)], "5150-12"),
        roster([PEOPLE[0]!, PEOPLE[1]!, "Keiko Sato", ...PEOPLE.slice(3)], "5150-13"),
      ];
      const events = recordDesk((desk) => {
        for (const l of lists) desk.showList(l);
        desk.showList({ windowId: "5150-30", app: FIXTURE_APP, title: "Unrelated", group: "Notes", lines: ["nothing here"] });
        desk.advance(1000);
        const g = grid();
        desk.showGrid(g);
        desk.fill(g, 0, 0, PEOPLE[0] as string);
        desk.fill(g, 1, 0, PEOPLE[1] as string);
      });
      await replayDesk(events);
      const first = await host.waitFor<OfferAlternatives>((m) => m.type === "alternatives");
      expect(first.candidates.map((c) => c.text)).not.toContain("Keiko Sato");
      reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: reader.clock + 10, windowId: "5150-30" });
      await until(() => !helper.model.windows.has("5150-30"));
      const typed = reader.setValue("6160-2", M("textfield:guest~2"), "Keiko Sato");
      await until(() => hooks.applied("6160-2", typed.at));
      helper.tick(typed.at + 2000);
      await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === "offer-1");
      expect(withdrawals().filter(([id]) => id === "offer-1")).toEqual([["offer-1", "diverged"]]);
      expect(host.received.some((m) => (m as Sent).type === "action")).toBe(false);
    });

    it("does not take the closed list's value as the round once that list is gone", async () => {
      await reader.replay(loadRecording("offers-loop.ndjson"), hooks);
      await host.waitFor((m) => m.type === "alternatives");
      reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: reader.clock + 10, windowId: ROSTER });
      await until(() => !helper.model.windows.has(ROSTER));
      const typed = reader.setValue(SEATING, guest(2), "Marcus Lowe");
      await until(() => hooks.applied(SEATING, typed.at));
      helper.tick(typed.at + 2000);
      await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === "offer-1");
      expect(withdrawals().filter(([id]) => id === "offer-1")).toEqual([["offer-1", "diverged"]]);
      expect(host.received.some((m) => (m as Sent).type === "action")).toBe(false);
    });

    it("keeps the other list's candidate when the main list closes, and inserting it still switches the loop", async () => {
      await reader.replay(loadRecording("offers-loop.ndjson"), hooks);
      await host.waitFor((m) => m.type === "alternatives");
      reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: reader.clock + 10, windowId: ROSTER });
      const again = await host.waitFor<OfferAlternatives>((m) => m.type === "alternatives" && host.received.filter((x) => (x as Sent).type === "alternatives").indexOf(m) === 1);
      expect(again.offerKey).toBe("offer-1.0");
      expect(again.candidates).toEqual([{ text: "Lena Hartmann", ref: { node: `${DIRECTORY}/${person("Lena Hartmann")}`, quote: "Lena Hartmann" } }]);
      expect(again.quoted).toBe(true);
      expect(withdrawals()).toEqual([]);

      const typed = reader.setValue(SEATING, guest(2), "Lena Hartmann");
      await until(() => hooks.applied(SEATING, typed.at));
      helper.tick(typed.at + 2000);
      const action = await host.waitFor<{ offerKey: string; endState: { text: string } }>((m) => m.type === "action");
      expect(action).toMatchObject({ offerKey: "offer-2", endState: { text: "Finish the rest: 3 more values from Directory Fixture" } });
    });
  });
});
