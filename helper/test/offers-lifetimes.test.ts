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
import { PROTOCOL_VERSION, type Activity, type OfferAlternatives, type ReaderMessage } from "../src/protocol.ts";
import { OFFER_LIFETIMES } from "../src/offers/lifetimes.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { MAIL_APP, focus, jevPickingText, snap } from "./builders.ts";
import { Desk, PEOPLE, grid, roster, type GridWindow, type ListWindow } from "./scene.ts";
import { captureEdit } from "../src/patterns/preferences.ts";
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

  it("loopFinish outliving its quiet loop is withdrawn when the user fills one of its rows", async () => {
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
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === "offer-2")).toMatchObject({ reason: "stale" });
    expect(helper.offers.get("offer-2")).toBeUndefined();
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
        field: { pid: 6160, windowId: SEATING, key: guest(2), frame: [100, 100, 200, 24] },
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
