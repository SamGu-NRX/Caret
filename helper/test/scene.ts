// A synthetic desk for pattern tests: a source list window and a destination grid window, sent to a
// Helper as reader snapshots, with a clock the test advances. All names and addresses are invented.
import type { Helper } from "../src/helper.ts";
import type { ReaderLink } from "../src/executor/means.ts";
import { PROTOCOL_VERSION, type AppRef, type Node, type ReaderVerb, type VerbResult } from "../src/protocol.ts";
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

/**
 * The reader's label normalization (ElementKey.normalizeLabel in Swift): lowercased, digit runs to "#",
 * "/" and "~" to spaces, whitespace collapsed, trailing colons dropped, cut to 40 characters.
 */
export function keyLabel(s: string): string {
  let t = s.normalize("NFKC").toLowerCase().replace(/\d+/g, "#").replace(/[\s/~]+/g, " ").trim();
  if (t.length > 40) t = t.slice(0, 40).trim();
  return t.replace(/(\s*:)+$/, "");
}

/** Keys as the reader builds them, with ordinals counted per label as the reader counts them. */
export function listKeys(l: ListWindow): string[] {
  const seen = new Map<string, number>();
  return l.lines.map((line) => {
    const label = keyLabel(line);
    const n = seen.get(label) ?? 0;
    seen.set(label, n + 1);
    return `${l.app.bundleId}/standard/group:${keyLabel(l.group)}/statictext:${label}~${n}`;
  });
}
export const listKey = (l: ListWindow, i: number): string => listKeys(l)[i] ?? "";
export const cellKey = (g: GridWindow, row: number, col: number): string =>
  `${g.app.bundleId}/standard/textfield:${keyLabel(g.columns[col] ?? "")}~${row}`;

export class Desk implements ReaderLink {
  at = 1_000_000;
  helper: Helper | null = null;
  readonly grids = new Map<string, GridWindow>();
  /** Verbs the executor sent, for tests that count writes. */
  readonly verbs: ReaderVerb[] = [];

  /** Must be called once the helper exists; the helper takes the desk as its reader link first. */
  attach(helper: Helper): this {
    this.helper = helper;
    return this;
  }

  private get h(): Helper {
    if (this.helper === null) throw new Error("desk not attached to a helper");
    return this.helper;
  }

  /** Answers the executor's reader verbs for grid windows the way caret-screen does: recheck, act, send a fresh snapshot. */
  async run(verb: ReaderVerb): Promise<VerbResult> {
    this.verbs.push(verb);
    const answer = (outcome: VerbResult["outcome"], detail: string | null = null): VerbResult => ({ type: "verbResult", v: PROTOCOL_VERSION, id: "desk", at: this.at, outcome, detail });
    if (verb.kind === "watchInput") return answer("ok");
    const g = this.grids.get(verb.windowId);
    if (g === undefined) return answer("noWindow");
    if (verb.pid !== g.app.pid) return answer("notAllowed");
    if (verb.kind === "walk") {
      this.showGrid(g);
      return answer("ok");
    }
    if (verb.kind === "press") return answer("noElement", verb.key);
    const cells = new Set(Array.from({ length: g.rows }, (_, r) => g.columns.map((_, c) => cellKey(g, r, c))).flat());
    if (!cells.has(verb.key)) return answer("noElement", verb.key);
    if (verb.attribute !== "value") return answer("ok");
    const now = g.values.get(verb.key) ?? "";
    if (now !== verb.expect) return answer("changed", `value is '${now}'`);
    g.values.set(verb.key, verb.value);
    this.showGrid(g);
    return answer("ok");
  }

  /** Moves the clock forward, ticking the helper every 250 ms as main.ts does. */
  advance(ms: number): void {
    const end = this.at + ms;
    while (this.at < end) {
      this.at = Math.min(end, this.at + 250);
      this.h.tick(this.at);
    }
  }

  showList(l: ListWindow): void {
    const groupKey = `${l.app.bundleId}/standard/group:${keyLabel(l.group)}~0`;
    const nodes: Node[] = [{ key: groupKey, parent: null, role: "AXGroup", label: l.group }];
    const keys = listKeys(l);
    l.lines.forEach((line, i) => nodes.push({ key: keys[i]!, parent: groupKey, role: "AXStaticText", label: line }));
    void this.h.handleReader(snap(nodes, { at: this.at, windowId: l.windowId, title: l.title, app: l.app }));
  }

  showGrid(g: GridWindow, focused = true): void {
    this.grids.set(g.windowId, g);
    const nodes: Node[] = [];
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.columns.length; c++) {
        const key = cellKey(g, r, c);
        const v = g.values.get(key) ?? "";
        nodes.push({ key, parent: null, role: "AXTextField", label: g.columns[c], editable: true, ...(v === "" ? {} : { value: v }) });
      }
    }
    void this.h.handleReader(snap(nodes, { at: this.at, windowId: g.windowId, title: g.title, app: g.app, focused }));
  }

  close(windowId: string): void {
    this.grids.delete(windowId);
    void this.h.handleReader({ type: "windowClosed", v: PROTOCOL_VERSION, at: this.at, windowId });
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
