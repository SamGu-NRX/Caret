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
import { writeLocalFile } from "../store-path.ts";
import { CARD_LINE_CHARS, inventoryOf, limitsOf, overLimits, UnitProbe, wordSetOn, type LineInventory, type Limits } from "./measure.ts";

/**
 * SCP1: a page web area's heading list and section texts (Node.headings, Node.outline), which a section question sends:
 * lines of the window like its labels, so they count toward its budget and prose share and the ledger charges them.
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

/** One window state a request is measured against, with its limits. `key` names it in charges and refusals. */
export interface MeasuredWindow {
  readonly key: string;
  readonly windowId: string;
  readonly view: WindowState;
  readonly inv: LineInventory;
  readonly limits: Limits;
  /** The registry's current state of the window; false for an older snapshot a Disclosure holds (a task's kept source). */
  readonly live: boolean;
  readonly conversation: boolean;
}

const viewOf = (w: WindowState): WindowState => (isRedacted(w) ? w : redactWindow(w));

/**
 * Section 1: every window the registry knows, as its redacted view, and every older snapshot the Disclosure holds that is
 * not the registry's current state, each measured on its own (a retained revision keeps its own bounds; it does not
 * pool with the live one). Classified by the raw window where there is one, since redaction can empty a title the
 * conversation rule reads.
 */
export function measuredWindows(registry: ScreenRegistry, held: Iterable<WindowState>, consented: ReadonlySet<string>): MeasuredWindow[] {
  const out: MeasuredWindow[] = [];
  const seen = new Set<WindowState>();
  const add = (raw: WindowState, live: boolean): void => {
    const view = viewOf(raw);
    if (seen.has(view)) return;
    seen.add(view);
    const id = raw.window.windowId;
    const inv = viewInventory(view);
    const conversation = heldAsConversation(raw);
    const limits = limitsOf(inv, { conversation, consented: consented.has(id) });
    const older = out.filter((m) => m.windowId === id).length;
    out.push({ key: live && older === 0 ? id : `${id}@${older}`, windowId: id, view, inv, limits, live, conversation });
  };
  for (const w of registry.windows.values()) add(w, true);
  for (const w of held) add(w, false);
  return out;
}

/** What a request reveals of each window it is measured against. */
export interface Measurement {
  /** Positions revealed, by window key; windows with none are left out. */
  readonly charged: Readonly<Record<string, number>>;
  readonly prose: Readonly<Record<string, number>>;
  /** The revealed positions themselves, by window key, for an operation's union (section 7); never sent. */
  readonly positions: ReadonlyMap<string, { readonly view: WindowState; readonly bits: Uint8Array }>;
  /** MEASUREMENT ONLY (measure.ts LEDGER_WORDS_ENV): the single-word set's charge and prose, by window key. */
  readonly words?: { readonly charged: Readonly<Record<string, number>>; readonly prose: Readonly<Record<string, number>> };
}

/** A bound a measurement breaks: the window, which bound, the charge and the limit. Never any text. */
export interface Breach {
  readonly key: string;
  readonly bound: "chars" | "prose";
  readonly charged: number;
  readonly limit: number;
  /** MEASUREMENT ONLY: the single-word set broke it, not the main charge. */
  readonly words?: true;
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
  const prose: Record<string, number> = {};
  const positions = new Map<string, { view: WindowState; bits: Uint8Array }>();
  const wc: Record<string, number> = {};
  const wp: Record<string, number> = {};
  for (const m of windows) {
    const r = probe.reveal(m.inv);
    if (r.words !== undefined && r.words.charged > 0) {
      wc[m.key] = r.words.charged;
      if (r.words.prose > 0) wp[m.key] = r.words.prose;
    }
    if (r.charged === 0) continue;
    charged[m.key] = r.charged;
    if (r.prose > 0) prose[m.key] = r.prose;
    positions.set(m.key, { view: m.view, bits: r.positions });
  }
  return wordSetOn() ? { charged, prose, positions, words: { charged: wc, prose: wp } } : { charged, prose, positions };
}

/** The first bound a measurement breaks, in window order, or null. */
export function breach(m: Measurement, windows: readonly MeasuredWindow[]): Breach | null {
  for (const w of windows) {
    const r = { charged: m.charged[w.key] ?? 0, prose: m.prose[w.key] ?? 0 };
    const over = overLimits(r, w.limits);
    if (over === "chars") return { key: w.key, bound: "chars", charged: r.charged, limit: w.limits.chars };
    if (over === "prose") return { key: w.key, bound: "prose", charged: r.prose, limit: w.limits.prose as number };
    if (m.words !== undefined) {
      const x = { charged: m.words.charged[w.key] ?? 0, prose: m.words.prose[w.key] ?? 0 };
      const o = overLimits(x, w.limits);
      if (o === "chars") return { key: w.key, bound: "chars", charged: x.charged, limit: w.limits.chars, words: true };
      if (o === "prose") return { key: w.key, bound: "prose", charged: x.prose, limit: w.limits.prose as number, words: true };
    }
  }
  return null;
}

/** One window's running union while a request is built. */
interface Running {
  readonly bits: Uint8Array;
  charged: number;
  prose: number;
  /** MEASUREMENT ONLY: the single-word set's running union. */
  readonly wbits: Uint8Array;
  wcharged: number;
  wprose: number;
}

/**
 * The early check while a request is built: each minted text's positions, unioned per window state, held to that
 * window's limits. A text that would break one is refused and nothing of it is kept. Superseded by the seal's measure of
 * the final bytes, which alone decides what is sent and what is declared charged.
 */
export class MintAccount {
  private readonly running = new WeakMap<WindowState, Running>();
  /** Window keys charged so far, with the view each was charged in, in first-charged order. */
  private readonly charged = new Map<string, WindowState>();
  /** Every text admitted so far, in order: what the running charge is the measure of. */
  private readonly texts: string[] = [];

  private readonly windows: () => readonly MeasuredWindow[];

  constructor(windows: () => readonly MeasuredWindow[]) {
    this.windows = windows;
  }

  private runningOf(m: MeasuredWindow): Running {
    let r = this.running.get(m.view);
    if (r === undefined) this.running.set(m.view, (r = { bits: new Uint8Array(m.inv.total), charged: 0, prose: 0, wbits: new Uint8Array(m.inv.total), wcharged: 0, wprose: 0 }));
    return r;
  }

  /**
   * What admitting these texts would add to each window, or null when one window would break a bound or a text cannot
   * be measured. `commit` keeps the positions. The lines each window newly showed are returned for declarations.
   */
  admit(texts: readonly string[], commit: boolean): Map<string, { added: number; lines: string[] }> | null {
    const got = this.admitInner(texts, commit);
    // MEASUREMENT ONLY (step 0 of the lead's ledger decision): every committed admit, with the conversation windows of
    // the registry (their inventories written once to a side file) and the window that refused it, for an offline replay.
    const trace = process.env.CARET_TEST_MINT_TRACE;
    if (trace !== undefined && commit) {
      const conv = this.windows().filter((m) => m.conversation);
      for (const m of conv) {
        const id = `${m.key}#${m.inv.lines.length}#${m.inv.total}`;
        if (!TRACED.has(id)) {
          TRACED.add(id);
          writeLocalFile(`${trace}.windows`, `${JSON.stringify({ id, key: m.key, lines: m.inv.lines })}\n`, { append: true });
        }
      }
      writeLocalFile(trace, `${JSON.stringify({ test: (globalThis as { __caretTest?: string }).__caretTest, ledger: this.traceId, texts, conv: conv.map((m) => `${m.key}#${m.inv.lines.length}#${m.inv.total}`), refused: got === null ? (this.lastRefusal ?? "?") : null })}\n`, { append: true });
    }
    return got;
  }

  private lastRefusal: string | null = null;
  private readonly traceId = ++TRACE_IDS;

  private admitInner(texts: readonly string[], commit: boolean): Map<string, { added: number; lines: string[] }> | null {
    this.lastRefusal = null;
    const units = normalizedUnits(texts.filter((t) => t !== ""));
    if (units === null) return null;
    if (units.length === 0) return new Map();
    const probe = new UnitProbe(units);
    const ws = this.windows();
    const adds: { m: MeasuredWindow; r: Running; bits: Uint8Array; added: number; prose: number }[] = [];
    const wadds: { r: Running; bits: Uint8Array; added: number; prose: number }[] = [];
    for (const m of ws) {
      const got = probe.reveal(m.inv);
      if (got.words !== undefined && got.words.charged > 0) {
        const r = this.runningOf(m);
        let added = 0;
        let prose = 0;
        const bits = got.words.positions;
        for (let p = 0; p < bits.length; p++) {
          if (bits[p] !== 1 || r.wbits[p] === 1) continue;
          added++;
          if (lineAt(m.inv, p).length > CARD_LINE_CHARS) prose++;
        }
        if (added > 0) {
          if (overLimits({ charged: r.wcharged + added, prose: r.wprose + prose }, m.limits) !== null) return ((this.lastRefusal = m.key), null);
          wadds.push({ r, bits, added, prose });
        }
      }
      if (got.charged === 0) continue;
      const r = this.runningOf(m);
      let added = 0;
      let prose = 0;
      const bits = got.positions;
      for (let p = 0; p < bits.length; p++) {
        if (bits[p] !== 1 || r.bits[p] === 1) continue;
        added++;
        if (lineAt(m.inv, p).length > CARD_LINE_CHARS) prose++;
      }
      if (added === 0) continue;
      if (overLimits({ charged: r.charged + added, prose: r.prose + prose }, m.limits) !== null) {
        this.lastRefusal = m.key;
        // MEASUREMENT ONLY: which window and bound refused a mint, and what of it was already charged and newly marked.
        const log = process.env.CARET_TEST_MINT_LOG;
        if (log !== undefined) {
          const runs = (bits: Uint8Array, skip: Uint8Array | null): string[] => {
            const out: string[] = [];
            m.inv.lines.forEach((l, li) => {
              const st = m.inv.starts[li]!;
              let t = "";
              for (let p = 0; p < l.length; p++) t += bits[st + p] === 1 && (skip === null || skip[st + p] !== 1) ? l[p] : "\u2591";
              for (const x of t.split(/\u2591+/u)) if (x.trim() !== "") out.push(x);
            });
            return out;
          };
          writeLocalFile(log, `${JSON.stringify({ test: (globalThis as { __caretTest?: string }).__caretTest, window: m.key, title: m.view.window.title.slice(0, 60), conversation: m.limits.prose === null && m.limits.chars < 1200, limits: m.limits, running: { chars: r.charged, prose: r.prose }, added: { chars: added, prose }, texts: texts.map((t) => t.slice(0, 80)), newly: runs(bits, r.bits), already: runs(r.bits, null).slice(0, 80).map((sp) => ({ sp, from: this.texts.filter((t) => t.toLowerCase().includes(sp.toLowerCase())).map((t) => t.slice(0, 160)).slice(0, 3) })) })}\n`, { append: true });
        }
        return null;
      }
      adds.push({ m, r, bits, added, prose });
    }
    if (commit) for (const w of wadds) {
      for (let p = 0; p < w.bits.length; p++) if (w.bits[p] === 1) w.r.wbits[p] = 1;
      w.r.wcharged += w.added;
      w.r.wprose += w.prose;
    }
    const out = new Map<string, { added: number; lines: string[] }>();
    for (const a of adds) {
      const lines = new Set<string>();
      for (let p = 0; p < a.bits.length; p++) {
        if (a.bits[p] !== 1 || a.r.bits[p] === 1) continue;
        lines.add(lineAt(a.m.inv, p));
        if (commit) a.r.bits[p] = 1;
      }
      if (commit) {
        a.r.charged += a.added;
        a.r.prose += a.prose;
        if (!this.charged.has(a.m.key)) this.charged.set(a.m.key, a.m.view);
      }
      out.set(a.m.key, { added: a.added, lines: [...lines] });
    }
    if (commit) this.texts.push(...texts.filter((t) => t !== ""));
    return out;
  }

  /** The texts admitted so far, in order. */
  admitted(): readonly string[] {
    return this.texts;
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

const TRACED = new Set<string>();
let TRACE_IDS = 0;

/** The line of an inventory a position falls in. */
function lineAt(inv: LineInventory, p: number): string {
  let lo = 0;
  let hi = inv.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (inv.starts[mid]! <= p) lo = mid;
    else hi = mid - 1;
  }
  return inv.lines[lo]!;
}
