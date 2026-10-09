// B19's synthetic days: three routines a person repeats among noise (calendar to a mail reply, invoice to an
// expense form, shipment to a tracker form), and a distractor version with near misses of each. From
// `caretFrom` on, the planted stream opens each routine's window and leaves it empty for a while, so a
// driver can take the routine's offer and let Caret fill it (StreamReader). Every name, number and
// address is invented. Seeded, so a run repeats exactly.
import { PROTOCOL_VERSION, type AppRef, type Node, type ReaderMessage, type ReaderVerb, type Snapshot, type VerbResult, type ActGrant, type ActRevoke, type CalendarGrant } from "../src/protocol.ts";
import type { Helper } from "../src/helper.ts";
import type { ReaderLink } from "../src/executor/means.ts";
import { FIXTURE_APP, MAIL_APP } from "./builders.ts";
import { FakeGrants } from "./fake-grants.ts";
import { SHEET_APP, World, calendarLines, desk, invoiceLines } from "./stream.ts";

export const TRACKER_APP: AppRef = { pid: 7270, bundleId: "dev.caret.tracker", name: "Tracker Fixture" };

const CARRIERS = ["Northwind", "Lumen", "Bayside", "Harbor", "Cedar", "Summit", "Orchard"];
export const shipLines = (d: number): string[] => [`ORD-2026-${51000 + d * 13}`, `${CARRIERS[d % CARRIERS.length]} Freight`, `1Z${880000 + d * 97}X`];

export interface Plant {
  name: string;
  dstApp: string;
  labels: string[];
  /** Each occurrence: the message index its window opens at, the values it copies, and whether Caret is left to fill it. */
  opens: { day: number; index: number; windowId: string; values: string[]; caret: boolean }[];
}

export interface SkillStream {
  messages: ReaderMessage[];
  plants: Plant[];
}

interface Routine {
  plant: Plant;
  src: ReturnType<World["list"]>;
  lines: (d: number) => string[];
  app: AppRef;
  title: string;
  idPrefix: string;
}

/** One occurrence: the source shows the day's lines, the window opens, and the user copies the values in `order`, or leaves it to Caret. */
function occurrence(w: World, r: Routine, d: number, caret: boolean, order: readonly number[] = [0, 1, 2], typed: Record<number, string> = {}): void {
  const lines = r.lines(d);
  w.setLines(r.src, lines);
  w.idle(1500);
  const id = `${r.idPrefix}-${100 + d}`;
  r.plant.opens.push({ day: d, index: w.messages.length, windowId: id, values: lines.slice(0, r.plant.labels.length), caret });
  const g = w.grid(id, r.app, `${r.title} ${d}`, r.plant.labels, 1);
  if (caret) {
    // Caret's snapshots of this window come from the reader now, not from the background noise.
    w.untrack(id);
    w.idle(4000);
  } else {
    r.plant.labels.forEach((_, c) => {
      const t = typed[c];
      const i = order[c];
      if (t !== undefined) w.type(g, 0, c, t);
      else if (i !== undefined) w.type(g, 0, c, lines[i]!);
    });
  }
  w.close(id);
  w.idle(3000);
}

/** Mail-reply orders for the distractor stream: never the same two days running, so every silent prediction misses. */
const SHUFFLED = [[0, 1, 2], [1, 0, 3], [3, 1, 0], [0, 3, 2], [2, 0, 1], [1, 2, 0], [3, 0, 1], [0, 2, 3], [2, 3, 1]];

export function skillStream(o: { seed?: number; days?: number; caretFrom?: number | null; distractor?: boolean } = {}): SkillStream {
  const days = o.days ?? 7;
  const w = new World(o.seed ?? 19);
  const s = desk(w);
  const shipping = w.list("5150-7", FIXTURE_APP, "Shipping", "Ready to ship", ["", "", ""]);
  const mail: Routine = { plant: { name: "calendar to mail reply", dstApp: MAIL_APP.name, labels: ["Subject", "To", "Link"], opens: [] }, src: s.calendar, lines: calendarLines, app: MAIL_APP, title: "Re: Design review", idPrefix: "6160" };
  const expense: Routine = { plant: { name: "invoice to expense form", dstApp: SHEET_APP.name, labels: ["Vendor", "Amount", "Invoice"], opens: [] }, src: s.invoices, lines: invoiceLines, app: SHEET_APP, title: "Expense", idPrefix: "7170" };
  const tracker: Routine = { plant: { name: "shipment to tracker form", dstApp: TRACKER_APP.name, labels: ["Order", "Carrier", "Tracking number"], opens: [] }, src: shipping, lines: shipLines, app: TRACKER_APP, title: "Shipment", idPrefix: "7270" };
  for (let d = 1; d <= days; d++) {
    if (d > 1) w.nextDay();
    w.idle(4000);
    w.noiseTransfer();
    if (o.distractor !== true) {
      const caret = o.caretFrom !== null && o.caretFrom !== undefined && d >= o.caretFrom;
      occurrence(w, mail, d, caret);
      occurrence(w, expense, d, caret);
      w.noiseTransfer();
      occurrence(w, tracker, d, caret);
    } else {
      // Mail replies whose lines move every day; an expense form on two days only; a tracker form with one
      // value copied and two typed from nowhere, which is one transfer shape and so no routine.
      occurrence(w, mail, d, false, SHUFFLED[(d - 1) % SHUFFLED.length]);
      if (d === 2 || d === 4) occurrence(w, expense, d, false);
      w.noiseTransfer();
      occurrence(w, tracker, d, false, [0], { 1: `carrier pending ${d}q`, 2: `no tracking yet ${d}z` });
    }
    w.idle(6000);
    w.noiseTransfer();
    w.idle(6000);
  }
  return { messages: w.messages, plants: [mail.plant, expense.plant, tracker.plant] };
}

/**
 * The reader for a replayed stream: it keeps the latest snapshot of every window the stream showed, answers
 * walks with it, and applies writes the way caret-screen does (recheck the field, write, send a fresh
 * snapshot), under act grants. It never presses.
 */
export class StreamReader implements ReaderLink {
  helper: Helper | null = null;
  readonly grants = new FakeGrants();
  readonly writes: { taskId: string | undefined; key: string; value: string }[] = [];
  private readonly windows = new Map<string, Snapshot>();
  private at = 0;

  observe(m: ReaderMessage): void {
    if ("at" in m) this.at = Math.max(this.at, m.at);
    if (m.type === "snapshot") this.windows.set(m.window.windowId, m);
    else if (m.type === "windowClosed") this.windows.delete(m.windowId);
  }

  grant(m: ActGrant | ActRevoke | CalendarGrant): void {
    this.grants.receive(m);
  }

  async run(verb: ReaderVerb): Promise<VerbResult> {
    const answer = (outcome: VerbResult["outcome"], detail: string | null = null): VerbResult => ({ type: "verbResult", v: PROTOCOL_VERSION, id: "stream", at: this.at, outcome, detail });
    if (verb.kind === "watchInput" || verb.kind === "watchWindows" || verb.kind === "watchPresses") return answer("ok");
    if (verb.kind !== "walk" && verb.kind !== "write") return answer("notAllowed", `the stream reader does not ${verb.kind}`);
    const refused = this.grants.refusal(verb);
    if (refused !== null) return answer("notAllowed", refused);
    const s = this.windows.get(verb.windowId);
    if (s === undefined) return answer("noWindow");
    if (verb.kind === "walk") return answer("ok");
    const n = s.nodes.find((x) => x.key === verb.key);
    if (n === undefined || n.editable !== true) return answer("noElement", verb.key);
    if ((n.value ?? "") !== verb.expect) return answer("changed", `value is '${n.value ?? ""}'`);
    if (verb.attribute !== "value") return answer("ok");
    const nodes: Node[] = s.nodes.map((x) => {
      if (x.key !== verb.key) return x;
      const { value: _old, ...rest } = x;
      return verb.value === "" ? rest : { ...rest, value: verb.value };
    });
    const next: Snapshot = { ...s, seq: s.seq + 1, at: this.at, reason: "request", nodes };
    this.windows.set(verb.windowId, next);
    this.writes.push({ taskId: verb.taskId, key: verb.key, value: verb.value });
    await this.helper?.handleReader(next);
    return answer("ok");
  }
}
