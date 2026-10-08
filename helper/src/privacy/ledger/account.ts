// The output ledger's accounting (OUTPUT-LEDGER-SPEC sections 1, 4 and 5): which windows a request is measured against,
// their inventories and limits, and the one charge, used twice:
// - at seal (privacy/send.ts), over the request's final decoded units: the authoritative charge, which admits or
//   refuses the bytes;
// - while a request is built (privacy.ts SnippetLedger, under Disclosure), over each text as it is minted: an early
//   refusal, so a builder leaves out one optional contribution instead of having its whole request refused at seal.
// The measure is a union of positions, so a text's own charge is never more than the charge of a request that holds it
// (superstring monotonicity, section 4), and the early check can only refuse what the seal would also refuse or charge
// less than the seal will. It never authorizes anything.
import type { WindowState } from "../../model.ts";
import { isConversation } from "../../conversation.ts";
import { isRedacted, redactWindow } from "../../fill/redact.ts";
import { LedgerEncodingError, ledgerNormalizeV1, type Normalized } from "./normalize.ts";
import { partsOf, readParts } from "./source.ts";
import { inventoryOf, limitOf, spanPositions, UnitProbe, withPositions, type DeclaredSpan, type LineInventory, type Revealed } from "./measure.ts";

export { sectionTexts } from "./source.ts";

let conversationCap = true;

/**
 * Turns the conversation rule off or back on, for the live replay's comparison of fill with and without it
 * (scripts/live-replay.ts). The helper never calls it; the rule is on from start.
 */
export function setConversationCap(on: boolean): void {
  conversationCap = on;
}

/** Whether the conversation rule holds this window: it is a conversation, and the rule is on. */
export function heldAsConversation(w: WindowState): boolean {
  return conversationCap && isConversation(w);
}

const INVENTORY = new WeakMap<WindowState, LineInventory>();

/**
 * Section 1: a redacted view's inventory, read by source.ts readParts: its title and every node's label, value and
 * placeholder (and SCP1's section texts), split at line breaks, whitespace collapsed and trimmed, empty lines removed,
 * exact repeats kept once, with each part's map for recorded source ranges. Text the view does not show (an excluded
 * value, a line redaction removed) is not in it. Cached per view object, which is immutable: a new snapshot is a new
 * view. A line holding an unpaired surrogate cannot be measured: the inventory says so, and every request is refused
 * while the window is on screen (MeasuredWindow.inv.malformed), rather than measured without the line.
 */
export function viewInventory(view: WindowState): LineInventory {
  let inv = INVENTORY.get(view);
  if (inv !== undefined) return inv;
  const { lines, maps, malformed } = readParts(partsOf(view));
  inv = inventoryOf(lines, malformed, maps);
  INVENTORY.set(view, inv);
  return inv;
}

/** What a Disclosure is measured against: the screen model's windows (ScreenModel satisfies it). */
export interface ScreenRegistry {
  readonly windows: ReadonlyMap<string, WindowState>;
}

/**
 * A registry of these windows, for tests, evaluation scripts and probes that hold windows rather than a screen model.
 * Production code passes the ScreenModel itself.
 */
export function registryOf(ws: Iterable<WindowState>): ScreenRegistry {
  return { windows: new Map([...ws].map((w) => [w.window.windowId, w])) };
}

/** One window state a request is measured against, with its limit. `key` names it in charges and refusals. */
export interface MeasuredWindow {
  readonly key: string;
  readonly windowId: string;
  readonly view: WindowState;
  readonly inv: LineInventory;
  readonly limit: number;
  readonly conversation: boolean;
}

const viewOf = (w: WindowState): WindowState => (isRedacted(w) ? w : redactWindow(w));

/**
 * Section 1: every window the registry knows, as its redacted view, and every older snapshot the Disclosure holds that is
 * not the registry's current state, each measured on its own (a retained revision keeps its own bound; it does not
 * pool with the live one). A window's first state is keyed by its id, so a window that has closed is still charged by
 * name in the state the task found it; a later state of the same id is `id@n`. Classified by the raw window where there
 * is one, since redaction can empty a title the conversation rule reads.
 */
export function measuredWindows(registry: ScreenRegistry, held: Iterable<WindowState>): MeasuredWindow[] {
  const out: MeasuredWindow[] = [];
  const seen = new Set<WindowState>();
  const add = (raw: WindowState): void => {
    const view = viewOf(raw);
    if (seen.has(view)) return;
    seen.add(view);
    const id = raw.window.windowId;
    const inv = viewInventory(view);
    const older = out.filter((m) => m.windowId === id).length;
    const conversation = heldAsConversation(raw);
    out.push({ key: older === 0 ? id : `${id}@${older}`, windowId: id, view, inv, limit: limitOf(inv, conversation), conversation });
  };
  for (const w of registry.windows.values()) add(w);
  for (const w of held) add(w);
  return out;
}

/** What a request reveals of each window it is measured against. */
export interface Measurement {
  /** Positions revealed, by window key; windows with none are left out. */
  readonly charged: Readonly<Record<string, number>>;
  /** The revealed positions themselves, by window key, for an operation's union (section 7); never sent. */
  readonly positions: ReadonlyMap<string, { readonly view: WindowState; readonly bits: Uint8Array }>;
}

/** A window a measurement takes past its limit, the charge and the limit. Never any text. */
export interface Breach {
  readonly key: string;
  readonly charged: number;
  readonly limit: number;
}

/** Normalizes measured texts; null when one holds an unpaired surrogate (refused, never measured as zero). */
export function normalizedUnits(texts: readonly string[]): Normalized[] | null {
  try {
    return texts.map(ledgerNormalizeV1);
  } catch (e) {
    if (e instanceof LedgerEncodingError) return null;
    throw e;
  }
}

/**
 * Section 4's declared spans: by the redacted view a minted unit was read from, the source texts it was minted from.
 * Only units present in the request's final bytes contribute.
 */
export type DeclaredSpans = ReadonlyMap<WindowState, readonly DeclaredSpan[]>;

/** What `units` reveal of `m` lexically, with the declared spans of `spans` read from `m`'s view added. */
function revealIn(probe: UnitProbe, m: MeasuredWindow, spans: DeclaredSpans): Revealed {
  const r = probe.reveal(m.inv);
  const mine = spans.get(m.view);
  if (mine === undefined || mine.length === 0) return r;
  const extra = new Uint8Array(m.inv.total);
  for (const sp of mine) spanPositions(m.inv, sp).forEach((b, p) => (extra[p] = extra[p]! | b));
  return withPositions(r, extra);
}

/** Measures normalized units, and the declared spans of the minted units among them, against every window. */
export function measure(units: readonly Normalized[], windows: readonly MeasuredWindow[], spans: DeclaredSpans = new Map()): Measurement {
  const probe = new UnitProbe(units);
  const charged: Record<string, number> = {};
  const positions = new Map<string, { view: WindowState; bits: Uint8Array }>();
  for (const m of windows) {
    const r = revealIn(probe, m, spans);
    if (r.charged === 0) continue;
    charged[m.key] = r.charged;
    positions.set(m.key, { view: m.view, bits: r.positions });
  }
  return { charged, positions };
}

/** The first window, in window order, a measurement takes past its limit, or null. */
export function breach(m: Measurement, windows: readonly MeasuredWindow[]): Breach | null {
  for (const w of windows) {
    const charged = m.charged[w.key] ?? 0;
    if (charged > w.limit) return { key: w.key, charged, limit: w.limit };
  }
  return null;
}

/**
 * Section 8: which units are whole owner notes, by the window state each was read from. A note counts against its own
 * window's owner-note allotment instead of that window's limit; every other window measures it like any other unit.
 */
export type OwnerNotes = ReadonlyMap<WindowState, ReadonlySet<number>>;

/** A window's own owner notes, split from the rest of a request: what each part reveals of that window. */
export interface NoteSplit {
  readonly key: string;
  readonly ordinary: number;
  readonly notes: Uint8Array;
  readonly noted: number;
}

/** For every window with owner notes among `units`, what the rest and the notes each reveal of it. */
export function splitNotes(units: readonly Normalized[], windows: readonly MeasuredWindow[], notes: OwnerNotes, spans: DeclaredSpans = new Map()): NoteSplit[] {
  const out: NoteSplit[] = [];
  for (const w of windows) {
    const mine = notes.get(w.view);
    if (mine === undefined || mine.size === 0) continue;
    // Owner notes declare no span (a note is whole lines, which the lexical measure charges whole): spans are ordinary.
    const ordinary = revealIn(new UnitProbe(units.filter((_, i) => !mine.has(i))), w, spans);
    const noted = new UnitProbe(units.filter((_, i) => mine.has(i))).reveal(w.inv);
    out.push({ key: w.key, ordinary: ordinary.charged, notes: noted.positions, noted: noted.charged });
  }
  return out;
}

/**
 * The first window a measurement takes past its limit, or a window's own owner notes past `allotment`, or null. A
 * window with owner notes holds the rest of the request to its limit and the notes to the allotment; the full charge
 * is reported as `charged` either way.
 */
export function breachWithNotes(m: Measurement, windows: readonly MeasuredWindow[], split: readonly NoteSplit[], allotment: number): (Breach & { notes: boolean }) | null {
  for (const w of windows) {
    const s = split.find((x) => x.key === w.key);
    if (s === undefined) {
      const charged = m.charged[w.key] ?? 0;
      if (charged > w.limit) return { key: w.key, charged, limit: w.limit, notes: false };
    } else {
      if (s.ordinary > w.limit) return { key: w.key, charged: s.ordinary, limit: w.limit, notes: false };
      if (s.noted > allotment) return { key: w.key, charged: s.noted, limit: allotment, notes: true };
    }
  }
  return null;
}

/** `had` with `bits` added, and how many positions the union holds. */
/**
 * A window's source positions as the operation counts them: by the line's text and the offset in it, so an identical
 * snapshot refresh (a new view object, the same lines) names the same positions. Lines are distinct in an inventory
 * (section 1), so a line's text is its occurrence.
 */
function sourceKeys(inv: LineInventory, bits: Uint8Array): string[] {
  const out: string[] = [];
  for (let li = 0; li < inv.lines.length; li++) {
    const start = inv.starts[li]!;
    const line = inv.lines[li]!;
    for (let k = 0; k < line.length; k++) if (bits[start + k] === 1) out.push(`${line}\u0000${k}`);
  }
  return out;
}

/**
 * Sections 7 and 8: one operation's ledger. The positions every request it sent revealed of each conversation, unioned
 * by window id and source line (sourceKeys), are held to that conversation's limit: two requests of one fill cannot each
 * take just under half, and a snapshot refresh between them changes nothing. A window's owner notes, unioned over the
 * operation's requests, are held to the allotment: every wording and retry shares one. A retried or repeated request
 * adds no positions. Other windows are held per request only.
 */
export class OperationLedger {
  private readonly union = new Map<string, Set<string>>();
  private readonly notes = new Map<string, Set<string>>();

  /**
   * Keeps a sent request's positions (only checks them, without `commit`), or returns the conversation they would take
   * past its limit, or the window whose owner notes would pass `allotment`, and keeps nothing. A window measured in two
   * states (a retained snapshot and the live one) is one window: their positions are unioned by source line, and each
   * state's limit holds the union.
   */
  admit(m: Measurement, windows: readonly MeasuredWindow[], split: readonly NoteSplit[] = [], allotment = 0, commit = true): (Breach & { notes: boolean }) | null {
    const next = { union: new Map<string, Set<string>>(), notes: new Map<string, Set<string>>() };
    const grown = (which: "union" | "notes", id: string, keys: readonly string[]): Set<string> => {
      let set = next[which].get(id);
      if (set === undefined) next[which].set(id, (set = new Set(this[which].get(id) ?? [])));
      for (const k of keys) set.add(k);
      return set;
    };
    for (const w of windows) {
      const bits = w.conversation ? m.positions.get(w.key)?.bits : undefined;
      if (bits !== undefined) grown("union", w.windowId, sourceKeys(w.inv, bits));
      const s = split.find((x) => x.key === w.key);
      if (s !== undefined) grown("notes", w.windowId, sourceKeys(w.inv, s.notes));
    }
    for (const w of windows) {
      const u = next.union.get(w.windowId);
      if (u !== undefined && u.size > w.limit) return { key: w.key, charged: u.size, limit: w.limit, notes: false };
      const n = next.notes.get(w.windowId);
      if (n !== undefined && split.some((x) => x.key === w.key) && n.size > allotment) return { key: w.key, charged: n.size, limit: allotment, notes: true };
    }
    if (commit) for (const which of ["union", "notes"] as const) for (const [id, set] of next[which]) this[which].set(id, set);
    return null;
  }
}

/**
 * The early check while a request is built: each minted text's positions, unioned per window state, held to that
 * window's limit. A text that would break one is refused and nothing of it is kept. Superseded by the seal's measure of
 * the final bytes, which alone decides what is sent and what is declared charged.
 */
export class MintAccount {
  /** By window state: the positions the request's texts reveal, apart from that window's own owner notes, and those notes'. */
  private readonly running = new WeakMap<WindowState, { readonly bits: Uint8Array; charged: number; readonly notes: Uint8Array; noted: number }>();
  /** Window keys charged so far, with the view each was charged in, in first-charged order. */
  private readonly charged = new Map<string, WindowState>();
  private readonly windows: () => readonly MeasuredWindow[];
  /** Section 8's owner-note allotment, in characters of a window's own notes. */
  private readonly allotment: number;

  constructor(windows: () => readonly MeasuredWindow[], allotment = 0) {
    this.windows = windows;
    this.allotment = allotment;
  }

  /**
   * What admitting these texts would add to each window, or null when one window would break its limit (or its owner
   * notes the allotment) or a text cannot be measured. `notes` names the texts that are whole owner notes, by the window
   * state each was read from. `commit` keeps the positions. Each window's newly shown stretches, as its lines spell them,
   * are returned for declarations.
   */
  admit(texts: readonly string[], commit: boolean, notes: ReadonlyMap<string, WindowState> = new Map(), spans: DeclaredSpans = new Map()): Map<string, { added: number; lines: string[] }> | null {
    const kept = texts.filter((t) => t !== "");
    const units = normalizedUnits(kept);
    if (units === null) return null;
    if (units.length === 0 && spans.size === 0) return new Map();
    const probe = new UnitProbe(units);
    const adds: { m: MeasuredWindow; r: { bits: Uint8Array; charged: number; notes: Uint8Array; noted: number }; bits: Uint8Array; notes: Uint8Array | null; added: number; addedNotes: number }[] = [];
    const windows = this.windows();
    if (windows.some((m) => m.inv.malformed)) return null;
    for (const m of windows) {
      const mine = new Set(kept.flatMap((t, i) => (notes.get(t) === m.view ? [i] : [])));
      const got = revealIn(mine.size === 0 ? probe : new UnitProbe(units.filter((_, i) => !mine.has(i))), m, spans);
      const noted = mine.size === 0 ? null : new UnitProbe(units.filter((_, i) => mine.has(i))).reveal(m.inv);
      if (got.charged === 0 && (noted === null || noted.charged === 0)) continue;
      let r = this.running.get(m.view);
      if (r === undefined) this.running.set(m.view, (r = { bits: new Uint8Array(m.inv.total), charged: 0, notes: new Uint8Array(m.inv.total), noted: 0 }));
      let added = 0;
      for (let p = 0; p < got.positions.length; p++) if (got.positions[p] === 1 && r.bits[p] !== 1) added++;
      let addedNotes = 0;
      if (noted !== null) for (let p = 0; p < noted.positions.length; p++) if (noted.positions[p] === 1 && r.notes[p] !== 1) addedNotes++;
      if (added === 0 && addedNotes === 0) continue;
      if (r.charged + added > m.limit || r.noted + addedNotes > this.allotment) return null;
      adds.push({ m, r, bits: got.positions, notes: noted?.positions ?? null, added, addedNotes });
    }
    const out = new Map<string, { added: number; lines: string[] }>();
    for (const a of adds) {
      const had = a.r.bits.map((b, p) => b | a.r.notes[p]!);
      const shown = a.notes === null ? a.bits : a.bits.map((b, p) => b | a.notes![p]!);
      let added = 0;
      for (let p = 0; p < shown.length; p++) if (shown[p] === 1 && had[p] !== 1) added++;
      out.set(a.m.key, { added, lines: newlyShown(a.m.inv, shown, had) });
      if (!commit) continue;
      for (let p = 0; p < a.bits.length; p++) if (a.bits[p] === 1) a.r.bits[p] = 1;
      if (a.notes !== null) for (let p = 0; p < a.notes.length; p++) if (a.notes[p] === 1) a.r.notes[p] = 1;
      a.r.charged += a.added;
      a.r.noted += a.addedNotes;
      if (!this.charged.has(a.m.key)) this.charged.set(a.m.key, a.m.view);
    }
    return out;
  }

  /**
   * Keeps positions the early check did not charge but the seal did: a committed seal's (Caret's wording, a run across
   * composed parts), so the requests built after it see the room it took; and, with `texts`, the lexical charge of
   * wording a builder will send, before it admits any value. Never refuses: what it adds is already sent or will be.
   */
  absorb(m: Measurement): void {
    for (const w of this.windows()) {
      const got = m.positions.get(w.key);
      if (got === undefined || got.view !== w.view) continue;
      this.keep(w, got.bits);
    }
  }

  /**
   * absorb's second job: the lexical charge of `texts` (a builder's own wording), kept; false when a text cannot be
   * measured. `strict`: kept only when no window would pass its limit, false (keeping nothing) otherwise.
   */
  reserve(texts: readonly string[], strict = false): boolean {
    const units = normalizedUnits(texts.filter((t) => t !== ""));
    if (units === null) return false;
    const probe = new UnitProbe(units);
    const adds: [MeasuredWindow, Uint8Array][] = [];
    for (const w of this.windows()) {
      if (w.inv.malformed) return false;
      const r = probe.reveal(w.inv);
      if (r.charged === 0) continue;
      if (strict) {
        const had = this.running.get(w.view);
        let count = had?.charged ?? 0;
        for (let p = 0; p < r.positions.length; p++) if (r.positions[p] === 1 && had?.bits[p] !== 1 && had?.notes[p] !== 1) count++;
        if (count > w.limit) return false;
      }
      adds.push([w, r.positions]);
    }
    for (const [w, bits] of adds) this.keep(w, bits);
    return true;
  }

  private keep(w: MeasuredWindow, bits: Uint8Array): void {
    let r = this.running.get(w.view);
    if (r === undefined) this.running.set(w.view, (r = { bits: new Uint8Array(w.inv.total), charged: 0, notes: new Uint8Array(w.inv.total), noted: 0 }));
    for (let p = 0; p < bits.length; p++) {
      if (bits[p] === 1 && r.bits[p] !== 1 && r.notes[p] !== 1) {
        r.bits[p] = 1;
        r.charged++;
      }
    }
    if (!this.charged.has(w.key)) this.charged.set(w.key, w.view);
  }

  /** Characters charged so far, by window key: every position revealed, owner notes included, counted once. */
  charges(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, view] of this.charged) {
      const r = this.running.get(view);
      if (r === undefined) continue;
      let n = 0;
      for (let p = 0; p < r.bits.length; p++) n += r.bits[p]! | r.notes[p]!;
      if (n > 0) out[key] = n;
    }
    return out;
  }
}

/** The stretches of `inv`'s lines that `bits` marks and `had` did not, each as its line spells it. */
function newlyShown(inv: LineInventory, bits: Uint8Array, had: Uint8Array): string[] {
  const out = new Set<string>();
  inv.lines.forEach((line, li) => {
    const st = inv.starts[li]!;
    let from = -1;
    for (let p = 0; p <= line.length; p++) {
      const on = p < line.length && bits[st + p] === 1 && had[st + p] !== 1;
      if (on && from < 0) from = p;
      if (!on && from >= 0) {
        out.add(line.slice(from, p).trim());
        from = -1;
      }
    }
  });
  out.delete("");
  return [...out];
}
