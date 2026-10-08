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
import type { Node } from "../../protocol.ts";
import { isConversation } from "../../conversation.ts";
import { isRedacted, redactWindow } from "../../fill/redact.ts";
import { LedgerEncodingError, ledgerNormalizeV1, type Normalized } from "./normalize.ts";
import { inventoryOf, limitOf, UnitProbe, type LineInventory } from "./measure.ts";

/**
 * SCP1: a page web area's heading list and section texts (Node.headings, Node.outline), which a section question sends:
 * lines of the window like its labels, so they count toward its limit and the ledger charges them.
 */
export function sectionTexts(n: Node): string[] {
  if (n.headings === undefined && n.outline === undefined) return [];
  return [...(n.headings ?? []), ...(n.outline ?? []).flatMap((o) => (o.text === undefined ? [] : [o.text]))];
}

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

/** Whitespace collapsed and trimmed, as every SC1 inventory line is (privacy.ts flat). */
const flatLine = (s: string): string => s.replace(/\s+/gu, " ").trim();

const INVENTORY = new WeakMap<WindowState, LineInventory>();

/**
 * Section 1: a redacted view's inventory. Its title and every node's label, value and placeholder (and SCP1's section
 * texts), split at line breaks, whitespace collapsed and trimmed, empty lines removed, exact repeats kept once. Text the
 * view does not show (an excluded value, a line redaction removed) is not in it. Cached per view object, which is
 * immutable: a new snapshot is a new view.
 */
export function viewInventory(view: WindowState): LineInventory {
  let inv = INVENTORY.get(view);
  if (inv !== undefined) return inv;
  const lines = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (raw === undefined || raw === "") return;
    for (const l of raw.split(/\r\n|\r|\n/u)) {
      const f = flatLine(l);
      if (f !== "") lines.add(f);
    }
  };
  add(view.window.title);
  for (const n of view.nodes.values()) {
    add(n.label);
    add(n.value);
    add(n.placeholder);
    for (const t of sectionTexts(n)) add(t);
  }
  // A line holding an unpaired surrogate cannot be measured; it is kept out of the measure and refuses nothing here, but
  // a unit holding one refuses at seal (units.ts), so such text is never sent either way.
  const measurable = [...lines].filter((l) => l.isWellFormed());
  inv = inventoryOf(measurable);
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
}

const viewOf = (w: WindowState): WindowState => (isRedacted(w) ? w : redactWindow(w));

/**
 * Section 1: every window the registry knows, as its redacted view, and every older snapshot the Disclosure holds that is
 * not the registry's current state, each measured on its own (a retained revision keeps its own bound; it does not
 * pool with the live one). Classified by the raw window where there is one, since redaction can empty a title the
 * conversation rule reads.
 */
export function measuredWindows(registry: ScreenRegistry, held: Iterable<WindowState>): MeasuredWindow[] {
  const out: MeasuredWindow[] = [];
  const seen = new Set<WindowState>();
  const add = (raw: WindowState, live: boolean): void => {
    const view = viewOf(raw);
    if (seen.has(view)) return;
    seen.add(view);
    const id = raw.window.windowId;
    const inv = viewInventory(view);
    const older = out.filter((m) => m.windowId === id).length;
    out.push({ key: live && older === 0 ? id : `${id}@${older}`, windowId: id, view, inv, limit: limitOf(inv, heldAsConversation(raw)) });
  };
  for (const w of registry.windows.values()) add(w, true);
  for (const w of held) add(w, false);
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

/** Measures normalized units against every window. */
export function measure(units: readonly Normalized[], windows: readonly MeasuredWindow[]): Measurement {
  const probe = new UnitProbe(units);
  const charged: Record<string, number> = {};
  const positions = new Map<string, { view: WindowState; bits: Uint8Array }>();
  for (const m of windows) {
    const r = probe.reveal(m.inv);
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
 * The early check while a request is built: each minted text's positions, unioned per window state, held to that
 * window's limit. A text that would break one is refused and nothing of it is kept. Superseded by the seal's measure of
 * the final bytes, which alone decides what is sent and what is declared charged.
 */
export class MintAccount {
  private readonly running = new WeakMap<WindowState, { readonly bits: Uint8Array; charged: number }>();
  /** Window keys charged so far, with the view each was charged in, in first-charged order. */
  private readonly charged = new Map<string, WindowState>();
  private readonly windows: () => readonly MeasuredWindow[];

  constructor(windows: () => readonly MeasuredWindow[]) {
    this.windows = windows;
  }

  /**
   * What admitting these texts would add to each window, or null when one window would break its limit or a text cannot
   * be measured. `commit` keeps the positions. Each window's newly shown stretches, as its lines spell them, are returned
   * for declarations.
   */
  admit(texts: readonly string[], commit: boolean): Map<string, { added: number; lines: string[] }> | null {
    const units = normalizedUnits(texts.filter((t) => t !== ""));
    if (units === null) return null;
    if (units.length === 0) return new Map();
    const probe = new UnitProbe(units);
    const adds: { m: MeasuredWindow; r: { bits: Uint8Array; charged: number }; bits: Uint8Array; added: number }[] = [];
    for (const m of this.windows()) {
      const got = probe.reveal(m.inv);
      if (got.charged === 0) continue;
      let r = this.running.get(m.view);
      if (r === undefined) this.running.set(m.view, (r = { bits: new Uint8Array(m.inv.total), charged: 0 }));
      let added = 0;
      for (let p = 0; p < got.positions.length; p++) if (got.positions[p] === 1 && r.bits[p] !== 1) added++;
      if (added === 0) continue;
      if (r.charged + added > m.limit) return null;
      adds.push({ m, r, bits: got.positions, added });
    }
    const out = new Map<string, { added: number; lines: string[] }>();
    for (const a of adds) {
      out.set(a.m.key, { added: a.added, lines: newlyShown(a.m.inv, a.bits, a.r.bits) });
      if (!commit) continue;
      for (let p = 0; p < a.bits.length; p++) if (a.bits[p] === 1) a.r.bits[p] = 1;
      a.r.charged += a.added;
      if (!this.charged.has(a.m.key)) this.charged.set(a.m.key, a.m.view);
    }
    return out;
  }

  /** Characters charged so far, by window key. */
  charges(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, view] of this.charged) {
      const r = this.running.get(view);
      if (r !== undefined && r.charged > 0) out[key] = r.charged;
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
