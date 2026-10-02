// Synthetic reader streams for the pattern acceptance: several days of a person working across
// list windows, grids and forms, as reader messages with a fake clock. The planted stream holds three
// loops and two routines among noise; the distractor stream holds near misses of both and the same
// noise. Every name, number and address is invented. Seeded, so a run can be repeated exactly.
import type { Helper } from "../src/helper.ts";
import type { DecisionRow } from "../src/patterns/memory.ts";
import { PROTOCOL_VERSION, type AppRef, type HelperMessage, type Node, type PatternOffer, type ReaderMessage } from "../src/protocol.ts";
import { FIXTURE_APP, MAIL_APP, snap } from "./builders.ts";
import { keyLabel } from "./scene.ts";

export const SHEET_APP: AppRef = { pid: 7170, bundleId: "dev.caret.sheet", name: "Sheet Fixture" };
const DAY = 24 * 60 * 60 * 1000;

interface ListWin {
  kind: "list";
  id: string;
  app: AppRef;
  title: string;
  group: string;
  lines: string[];
}
interface GridWin {
  kind: "grid";
  id: string;
  app: AppRef;
  title: string;
  columns: string[];
  rows: number;
  values: Map<string, string>;
}
type Win = ListWin | GridWin;

/** Ground truth for one planted loop: the round-three cells the recognizer must predict, and where rounds two and three sit in the stream. */
export interface PlantedLoop {
  name: string;
  /** Index of the snapshot that completed round two, and of the first message of round three. */
  round2End: number;
  round3Start: number;
  expect: { key: string; value: string }[];
  /** Every cell "Finish the rest" should write once round three is confirmed. */
  finish: { key: string; value: string }[];
}
export interface PlantedRoutine {
  name: string;
  /** Message index at which each occurrence's window opens. */
  opens: { occurrence: number; index: number; windowId: string; values: string[] }[];
}

export interface Stream {
  messages: ReaderMessage[];
  loops: PlantedLoop[];
  routines: PlantedRoutine[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Dana", "Priya", "Marcus", "Ines", "Tomas", "Keiko", "Rafael", "Amara", "Jonas", "Leila", "Owen", "Sofia"];
const LAST = ["Whitfield", "Raman", "Lowe", "Okafor", "Brandt", "Sato", "Duarte", "Nwosu", "Berg", "Haddad", "Pryce", "Marin"];
const WORDS = ["quarterly", "harbor", "lantern", "meadow", "ledger", "copper", "signal", "orchard", "summit", "drift", "canvas", "relay", "pivot", "beacon"];

export class World {
  at = Date.UTC(2026, 9, 5, 15, 0, 0);
  readonly messages: ReaderMessage[] = [];
  private readonly wins = new Map<string, Win>();
  private readonly rand: () => number;
  private seq = 0;
  private inboxRound = 0;
  private noteSerial = 0;

  constructor(seed: number) {
    this.rand = mulberry32(seed);
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rand() * xs.length)] as T;
  }

  person(i: number): string {
    return `${FIRST[i % FIRST.length]} ${LAST[(i * 5 + 3) % LAST.length]}`;
  }

  // MARK: - windows

  list(id: string, app: AppRef, title: string, group: string, lines: string[]): ListWin {
    const w: ListWin = { kind: "list", id, app, title, group, lines };
    this.wins.set(id, w);
    this.show(w, false);
    return w;
  }

  grid(id: string, app: AppRef, title: string, columns: string[], rows: number): GridWin {
    const w: GridWin = { kind: "grid", id, app, title, columns, rows, values: new Map() };
    this.wins.set(id, w);
    this.show(w, true);
    return w;
  }

  close(id: string): void {
    this.wins.delete(id);
    this.push({ type: "windowClosed", v: PROTOCOL_VERSION, at: this.at, windowId: id });
  }

  setLines(w: ListWin, lines: string[]): void {
    w.lines = lines;
    this.show(w, false);
  }

  cellKey(w: GridWin, row: number, col: number): string {
    return `${w.app.bundleId}/standard/textfield:${keyLabel(w.columns[col] ?? "")}~${row}`;
  }

  // MARK: - the user

  /**
   * Types `value` into one cell in three bursts, then works elsewhere (noise only) until the edit has
   * settled. Returns the index of the snapshot that completed the value.
   */
  type(w: GridWin, row: number, col: number, value: string, noise = true): number {
    const key = this.cellKey(w, row, col);
    const before = w.values.get(key) ?? "";
    this.push({ type: "focus", v: PROTOCOL_VERSION, at: this.at, app: w.app, windowId: w.id, key, role: "AXTextField", editable: true, empty: before === "", frontmost: true });
    for (const frac of [0.34, 0.67, 1]) {
      this.wait(150);
      w.values.set(key, value.slice(0, Math.max(1, Math.round(value.length * frac))));
      this.show(w, true);
    }
    const done = this.messages.length - 1;
    this.idle(2200, noise);
    return done;
  }

  /** Time passes with background noise every ~90 ms: other windows refresh, focus moves, notes get typed. */
  idle(ms: number, noise = true): void {
    const end = this.at + ms;
    while (this.at < end) {
      this.wait(60 + Math.floor(this.rand() * 60));
      if (noise) this.noiseEvent();
    }
    this.at = end;
  }

  nextDay(): void {
    this.at += DAY;
    // The day starts with the sources on screen again, as the reader's first walk would show them.
    for (const w of this.wins.values()) this.show(w, false);
  }

  private wait(ms: number): void {
    this.at += ms;
  }

  // MARK: - noise

  private noiseEvent(): void {
    const r = this.rand();
    const inbox = this.wins.get("5150-6") as ListWin | undefined;
    const notes = this.wins.get("6160-9") as GridWin | undefined;
    if (r < 0.35 && inbox !== undefined) {
      // New mail arrives: the inbox list changes.
      this.inboxRound++;
      const lines = inbox.lines.slice(1);
      lines.push(`${this.pick(WORDS)} ${this.pick(WORDS)} update ${this.inboxRound}`);
      this.setLines(inbox, lines);
    } else if (r < 0.55 && notes !== undefined) {
      // Typing in the Title or Tag field: text that exists nowhere else, so it is never a transfer.
      // The Comment field is left to noiseTransfer, so this typing never overwrites a copy settling there.
      const col = this.rand() < 0.5 ? 0 : 2;
      const key = this.cellKey(notes, 0, col);
      this.noteSerial++;
      notes.values.set(key, `note ${this.pick(WORDS)} q${this.noteSerial}x`);
      this.show(notes, false);
    } else if (r < 0.7) {
      const w = this.pick([...this.wins.values()]);
      this.push({ type: "focus", v: PROTOCOL_VERSION, at: this.at, app: w.app, windowId: w.id, key: null, role: "AXGroup", editable: false, empty: true, frontmost: true });
    } else if (r < 0.8) {
      this.push({ type: "appSwitch", v: PROTOCOL_VERSION, at: this.at, from: FIXTURE_APP, to: this.pick([MAIL_APP, SHEET_APP, FIXTURE_APP]) });
    } else if (r < 0.88) {
      this.push({ type: "pasteboard", v: PROTOCOL_VERSION, at: this.at, changeCount: ++this.seq });
    } else {
      // A background refresh of some window, unchanged.
      const w = this.pick([...this.wins.values()]);
      this.show(w, false);
    }
  }

  /** A single unrelated copy: one inbox line into the notes' Comment field. */
  noiseTransfer(): void {
    const inbox = this.wins.get("5150-6") as ListWin;
    const notes = this.wins.get("6160-9") as GridWin;
    this.type(notes, 0, 1, this.pick(inbox.lines));
  }

  // MARK: - messages

  show(w: Win, focused: boolean): void {
    const nodes: Node[] = [];
    if (w.kind === "list") {
      const group = `${w.app.bundleId}/standard/group:${keyLabel(w.group)}~0`;
      nodes.push({ key: group, parent: null, role: "AXGroup", label: w.group });
      const seen = new Map<string, number>();
      for (const line of w.lines) {
        const label = keyLabel(line);
        const n = seen.get(label) ?? 0;
        seen.set(label, n + 1);
        nodes.push({ key: `${w.app.bundleId}/standard/group:${keyLabel(w.group)}/statictext:${label}~${n}`, parent: group, role: "AXStaticText", label: line });
      }
    } else {
      for (let r = 0; r < w.rows; r++) {
        for (let c = 0; c < w.columns.length; c++) {
          const key = this.cellKey(w, r, c);
          const v = w.values.get(key) ?? "";
          nodes.push({ key, parent: null, role: "AXTextField", label: w.columns[c], editable: true, ...(v === "" ? {} : { value: v }) });
        }
      }
    }
    this.push(snap(nodes, { at: this.at, windowId: w.id, title: w.title, app: w.app, focused, seq: ++this.seq, reason: focused ? "focus" : "background" }));
  }

  private push(m: ReaderMessage): void {
    this.messages.push(m);
  }
}

// MARK: - the two streams

function desk(w: World): { roster: ListWin; pairs: ListWin; orders: ListWin; calendar: ListWin; invoices: ListWin } {
  const people = Array.from({ length: 10 }, (_, i) => w.person(i));
  const roster = w.list("5150-1", FIXTURE_APP, "Roster", "Attendees", people);
  const pairs = w.list("5150-2", FIXTURE_APP, "Directory", "People", people.slice(0, 8).flatMap((p) => [p, `${p.toLowerCase().replace(" ", ".")}@lumen.example`]));
  const orders = w.list("5150-3", FIXTURE_APP, "Orders", "Open orders", Array.from({ length: 9 }, (_, i) => `ORD-2026-${48210 + i * 7}`));
  const calendar = w.list("5150-4", FIXTURE_APP, "Calendar", "Today", ["", "", "", ""]);
  const invoices = w.list("5150-5", FIXTURE_APP, "Invoices", "Latest invoice", ["", "", ""]);
  w.list("5150-6", FIXTURE_APP, "Inbox", "Messages", Array.from({ length: 6 }, (_, i) => `${w.pick(WORDS)} ${w.pick(WORDS)} thread ${i + 1}`));
  w.grid("6160-9", MAIL_APP, "Notes", ["Title", "Comment", "Tag"], 1);
  return { roster, pairs, orders, calendar, invoices };
}

const calendarLines = (d: number): string[] => [`Design review ${d}`, `priya.raman+d${d}@northwind.example`, `https://meet.example.com/rvw-${d}`, `Room ${d}B, Building C`];
const invoiceLines = (d: number): string[] => [`Northwind Supply ${d}`, `$${1200 + d * 37}.50`, `INV-2026-${30400 + d * 11}`];

/** Fills rows `from`..`to` of a grid from a list, one round per row, columns in order, with `stride` list lines per row. */
function fillRows(w: World, src: ListWin, dst: GridWin, from: number, to: number, stride: number, rounds: { start: number; end: number }[]): void {
  for (let r = from; r <= to; r++) {
    const start = w.messages.length;
    let end = start;
    for (let c = 0; c < dst.columns.length; c++) end = w.type(dst, r, c, src.lines[r * stride + c]!);
    rounds.push({ start, end });
  }
}

/** Two routines across five days. The first three occurrences of each teach it; the last two may be offered. */
function routineDay(w: World, d: number, s: ReturnType<typeof desk>, mail: PlantedRoutine, expense: PlantedRoutine): void {
  w.setLines(s.calendar, calendarLines(d));
  w.idle(1500);
  const composeId = `6160-${100 + d}`;
  mail.opens.push({ occurrence: d, index: w.messages.length, windowId: composeId, values: calendarLines(d).slice(0, 3) });
  const compose = w.grid(composeId, MAIL_APP, `Re: Design review ${d}`, ["Subject", "To", "Link"], 1);
  for (let c = 0; c < 3; c++) w.type(compose, 0, c, calendarLines(d)[c]!);
  w.close(composeId);
  w.idle(3000);

  w.setLines(s.invoices, invoiceLines(d));
  w.idle(1500);
  const formId = `7170-${100 + d}`;
  expense.opens.push({ occurrence: d, index: w.messages.length, windowId: formId, values: invoiceLines(d) });
  const form = w.grid(formId, SHEET_APP, `Expense ${d}`, ["Vendor", "Amount", "Invoice"], 1);
  for (let c = 0; c < 3; c++) w.type(form, 0, c, invoiceLines(d)[c]!);
  w.close(formId);
  w.idle(3000);
}

export function plantedStream(seed = 7): Stream {
  const w = new World(seed);
  const s = desk(w);
  const loops: PlantedLoop[] = [];
  const mail: PlantedRoutine = { name: "calendar to mail reply", opens: [] };
  const expense: PlantedRoutine = { name: "invoice to expense form", opens: [] };

  const loop = (name: string, src: ListWin, dst: GridWin, stride: number, rows: number): void => {
    const rounds: { start: number; end: number }[] = [];
    fillRows(w, src, dst, 0, 1, stride, rounds);
    const r3Start = w.messages.length;
    loops.push({
      name,
      round2End: rounds[1]!.end,
      round3Start: r3Start,
      expect: dst.columns.map((_, c) => ({ key: w.cellKey(dst, 2, c), value: src.lines[2 * stride + c]! })),
      finish: Array.from({ length: dst.rows - 3 }, (_, i) => i + 3)
        .filter((r) => src.lines[r * stride + dst.columns.length - 1] !== undefined)
        .flatMap((r) => dst.columns.map((_, c) => ({ key: w.cellKey(dst, r, c), value: src.lines[r * stride + c]! }))),
    });
    // The user carries on by hand, so the recognizer also sees round three.
    fillRows(w, src, dst, 2, rows - 1, stride, rounds);
  };

  for (let d = 1; d <= 5; d++) {
    if (d > 1) w.nextDay();
    w.idle(4000);
    w.noiseTransfer();
    routineDay(w, d, s, mail, expense);
    w.noiseTransfer();
    if (d === 2) loop("one column: roster to seating chart", s.roster, w.grid("6160-1", MAIL_APP, "Seating", ["Guest"], 8), 1, 4);
    if (d === 3) loop("two columns: directory to contact sheet", s.pairs, w.grid("6160-2", MAIL_APP, "Contacts", ["Name", "Email"], 6), 2, 4);
    if (d === 4) loop("other app: orders to tracker", s.orders, w.grid("7170-1", SHEET_APP, "Tracker", ["Order"], 9), 1, 3);
    w.idle(6000);
    w.noiseTransfer();
    w.idle(6000);
  }
  return { messages: w.messages, loops, routines: [mail, expense] };
}

/** The same desk and noise, with near misses of every pattern and nothing that should be offered. */
export function distractorStream(seed = 11): Stream {
  const w = new World(seed);
  const s = desk(w);
  for (let d = 1; d <= 5; d++) {
    if (d > 1) w.nextDay();
    w.idle(4000);
    w.noiseTransfer();

    // Bundles with the mail routine's shapes, but the user copies different calendar lines each day,
    // so every silent prediction misses.
    w.setLines(s.calendar, calendarLines(d));
    w.idle(1500);
    const compose = w.grid(`6160-${100 + d}`, MAIL_APP, `Re: Design review ${d}`, ["Subject", "To", "Link"], 1);
    const order = [[0, 1, 2], [1, 0, 3], [3, 1, 0], [0, 3, 2], [2, 0, 1]][d - 1]!;
    for (let c = 0; c < 3; c++) w.type(compose, 0, c, calendarLines(d)[order[c]!]!);
    w.close(compose.id);

    // An expense bundle seen only on two days, which is never enough.
    if (d === 2 || d === 4) {
      w.setLines(s.invoices, invoiceLines(d));
      w.idle(1500);
      const form = w.grid(`7170-${100 + d}`, SHEET_APP, `Expense ${d}`, ["Vendor", "Amount", "Invoice"], 1);
      for (let c = 0; c < 3; c++) w.type(form, 0, c, invoiceLines(d)[c]!);
      w.close(form.id);
    }
    w.idle(3000);

    const seat = w.grid(`6160-${10 + d}`, MAIL_APP, `Seating ${d}`, ["Guest"], 8);
    const tracker = w.grid(`7170-${10 + d}`, SHEET_APP, `Tracker ${d}`, ["Order"], 9);
    switch (d) {
      case 1: // rows 1 and 3: the destination skips a row
        w.type(seat, 0, 0, s.roster.lines[0]!);
        w.type(seat, 2, 0, s.roster.lines[1]!);
        break;
      case 2: // the source jumps six lines
        w.type(seat, 0, 0, s.roster.lines[0]!);
        w.type(seat, 1, 0, s.roster.lines[6]!);
        break;
      case 3: // a different source window each round: the order number is only in the orders window
        w.type(seat, 0, 0, s.roster.lines[0]!);
        w.type(seat, 1, 0, s.orders.lines[1]!);
        break;
      case 4: // bottom row first, going up
        w.type(tracker, 1, 0, s.orders.lines[1]!);
        w.type(tracker, 0, 0, s.orders.lines[0]!);
        break;
      case 5: // a copy elsewhere between two rows breaks "in a row"
        w.type(tracker, 0, 0, s.orders.lines[0]!);
        w.noiseTransfer();
        w.type(tracker, 1, 0, s.orders.lines[1]!);
        break;
    }
    w.close(seat.id);
    w.close(tracker.id);
    w.idle(6000);
    w.noiseTransfer();
    w.idle(6000);
  }
  return { messages: w.messages, loops: [], routines: [] };
}

// MARK: - replay

export interface Replayed {
  /** Every offer, with the index of the message whose handling published it. */
  offers: { index: number; offer: PatternOffer }[];
  /** Wall time to handle each message, including the ticks before it, in milliseconds. */
  eventMs: number[];
}

/**
 * Feeds a stream to a helper, ticking every 250 ms of stream time as main.ts does. With `paceMs`,
 * messages are released at that wall-clock spacing (20 ms is 50 events a second).
 */
export async function replay(helper: Helper, sent: HelperMessage[], stream: Stream, paceMs = 0): Promise<Replayed> {
  const out: Replayed = { offers: [], eventMs: [] };
  let last: number | null = null;
  /** Ticks fall on a fixed 250 ms grid of stream time, as main.ts's interval does, however dense the messages. */
  let nextTick: number | null = null;
  const t0 = performance.now();
  for (let i = 0; i < stream.messages.length; i++) {
    const m = stream.messages[i]!;
    const at = "at" in m ? m.at : (last ?? 0);
    if (paceMs > 0) {
      const due = t0 + i * paceMs;
      const wait = due - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    const before = sent.length;
    const s = performance.now();
    // A gap of hours (the next day) gets one tick; otherwise every grid point up to this message ticks.
    if (nextTick === null) nextTick = at + 250;
    else if (at - nextTick > 60_000) {
      helper.tick(at - 1);
      nextTick = at + 250;
    } else {
      for (; nextTick <= at; nextTick += 250) helper.tick(nextTick);
    }
    last = Math.max(last ?? at, at);
    void helper.handleReader(m);
    out.eventMs.push(performance.now() - s);
    for (const x of sent.slice(before)) if (x.type === "patternOffer") out.offers.push({ index: i, offer: x });
  }
  helper.tick((last ?? 0) + 5000);
  return out;
}

// MARK: - checking a replay against the plant

export interface StreamCheck {
  messages: number;
  loops: {
    name: string;
    /** The round-three prediction was published after round two settled and before round three began. */
    foundAtRoundTwo: boolean;
    predictionRight: boolean;
    finishRight: boolean;
    offerIndex: number | null;
    predicted: { key: string; value: string }[];
  }[];
  routines: {
    name: string;
    /** Occurrence numbers whose opening got an offer. */
    offeredAt: number[];
    /** Every offer's values equal what the user then copied that day. */
    offersRight: boolean;
    /** The gate's decision at each occurrence's opening. */
    decisions: { occurrence: number; speak: boolean; reasons: string[]; showProbability: number }[];
  }[];
  unexpectedOffers: { index: number; kind: string; says: string }[];
}

export function checkStream(s: Stream, r: Replayed, helper: Helper): StreamCheck {
  const accounted = new Set<number>();
  const same = (a: { key: string; value: string }[], b: { key: string; value: string }[]): boolean =>
    a.length === b.length && a.every((x, i) => x.key === b[i]?.key && x.value === b[i]?.value);
  const cellsOf = (o: PatternOffer): { key: string; value: string }[] => o.cells.map((c) => ({ key: c.key, value: c.value }));

  const loops = s.loops.map((l) => {
    const keys = new Set(l.expect.map((e) => e.key));
    const i = r.offers.findIndex((x) => x.offer.kind === "loopNext" && x.offer.cells.length > 0 && x.offer.cells.every((c) => keys.has(c.key)));
    const hit = r.offers[i];
    if (i >= 0) accounted.add(i);
    const fi = r.offers.findIndex((x) => x.offer.kind === "loopFinish" && same(cellsOf(x.offer), l.finish));
    if (fi >= 0) accounted.add(fi);
    return {
      name: l.name,
      foundAtRoundTwo: hit !== undefined && hit.index > l.round2End && hit.index < l.round3Start,
      predictionRight: hit !== undefined && same(cellsOf(hit.offer), l.expect),
      finishRight: fi >= 0,
      offerIndex: hit?.index ?? null,
      predicted: hit === undefined ? [] : cellsOf(hit.offer),
    };
  });

  const decisions = helper.memory.decisions().filter((d) => d.offerKind === "routine");
  const routines = s.routines.map((rt) => {
    const offeredAt: number[] = [];
    let offersRight = true;
    const ds: StreamCheck["routines"][number]["decisions"] = [];
    for (const occ of rt.opens) {
      const at = s.messages[occ.index] !== undefined && "at" in s.messages[occ.index]! ? (s.messages[occ.index] as { at: number }).at : -1;
      const d = decisions.find((x: DecisionRow) => x.at === at);
      if (d !== undefined) ds.push({ occurrence: occ.occurrence, speak: d.speak, reasons: d.reasons, showProbability: d.showProbability });
      r.offers.forEach((x, i) => {
        if (x.offer.kind !== "routine" || x.offer.windowId !== occ.windowId) return;
        accounted.add(i);
        offeredAt.push(occ.occurrence);
        if (x.offer.cells.map((c) => c.value).join("|") !== occ.values.join("|")) offersRight = false;
      });
    }
    return { name: rt.name, offeredAt, offersRight, decisions: ds };
  });

  const unexpectedOffers = r.offers.filter((_, i) => !accounted.has(i)).map((x) => ({ index: x.index, kind: x.offer.kind, says: x.offer.says }));
  return { messages: s.messages.length, loops, routines, unexpectedOffers };
}
