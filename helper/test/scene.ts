// A synthetic desk for pattern tests: a source list window and a destination grid window, sent to a
// Helper as reader snapshots, with a clock the test advances. All names and addresses are invented.
import type { Helper } from "../src/helper.ts";
import type { AppRef, Node } from "../src/protocol.ts";
import { FIXTURE_APP, MAIL_APP, snap } from "./builders.ts";

export const PEOPLE = [
  "Dana Whitfield",
  "Priya Raman",
  "Marcus Lowe",
  "Ines Okafor",
  "Tomas Brandt",
  "Keiko Sato",
  "Rafael Duarte",
  "Amara Nwosu",
];
export const emailOf = (name: string): string => `${name.toLowerCase().replace(" ", ".")}@example.com`;

export interface ListWindow {
  windowId: string;
  app: AppRef;
  title: string;
  group: string;
  lines: string[];
}

export interface GridWindow {
  windowId: string;
  app: AppRef;
  title: string;
  /** Field labels of one row, in document order. */
  columns: string[];
  rows: number;
  values: Map<string, string>;
}

export const listKey = (l: ListWindow, i: number): string =>
  `${l.app.bundleId}/standard/group:${l.group.toLowerCase()}/statictext:${(l.lines[i] ?? "").toLowerCase()}~0`;
export const cellKey = (g: GridWindow, row: number, col: number): string =>
  `${g.app.bundleId}/standard/textfield:${(g.columns[col] ?? "").toLowerCase()}~${row}`;

export class Desk {
  at = 1_000_000;
  readonly helper: Helper;

  constructor(helper: Helper) {
    this.helper = helper;
  }

  /** Moves the clock forward, ticking the helper every 250 ms as main.ts does. */
  advance(ms: number): void {
    const end = this.at + ms;
    while (this.at < end) {
      this.at = Math.min(end, this.at + 250);
      this.helper.tick(this.at);
    }
  }

  showList(l: ListWindow): void {
    const groupKey = `${l.app.bundleId}/standard/group:${l.group.toLowerCase()}~0`;
    const nodes: Node[] = [{ key: groupKey, parent: null, role: "AXGroup", label: l.group }];
    l.lines.forEach((line, i) => nodes.push({ key: listKey(l, i), parent: groupKey, role: "AXStaticText", label: line }));
    void this.helper.handleReader(snap(nodes, { at: this.at, windowId: l.windowId, title: l.title, app: l.app }));
  }

  showGrid(g: GridWindow, focused = true): void {
    const nodes: Node[] = [];
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.columns.length; c++) {
        const key = cellKey(g, r, c);
        const v = g.values.get(key) ?? "";
        nodes.push({ key, parent: null, role: "AXTextField", label: g.columns[c], editable: true, ...(v === "" ? {} : { value: v }) });
      }
    }
    void this.helper.handleReader(snap(nodes, { at: this.at, windowId: g.windowId, title: g.title, app: g.app, focused }));
  }

  /** The user types `value` into one cell, then pauses long enough for the edit to settle. */
  fill(g: GridWindow, row: number, col: number, value: string): void {
    g.values.set(cellKey(g, row, col), value);
    this.showGrid(g);
    this.advance(2000);
  }
}

export function roster(lines: string[] = PEOPLE, windowId = "5150-1"): ListWindow {
  return { windowId, app: FIXTURE_APP, title: "Roster", group: "Attendees", lines };
}

export function grid(columns: string[] = ["Guest"], rows = 6, windowId = "6160-2"): GridWindow {
  return { windowId, app: MAIL_APP, title: "Seating", columns, rows, values: new Map() };
}
