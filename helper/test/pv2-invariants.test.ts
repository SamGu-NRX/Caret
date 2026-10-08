// PV2's three invariants after the second re-review, each as a property over random cases:
// - budget: whatever path reveals a window's text (candidate, descriptor, held, a derivation from a basis, take), what
//   the request shows of the window's prose stays within its prose share and of the window within its budget;
// - exclusion: no node with an excluded ancestor holds a value or a typed value in the model, whatever the roles between
//   and however walks were merged;
// - sends: after an app or site is switched off, no request built before it reaches a transport or a store.
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Disclosure, UnmintedText, type ModelText } from "../src/privacy/disclosure.ts";
import { windowShare } from "../src/privacy.ts";
import { noteSwitchedOff } from "../src/privacy/read-policy.ts";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { makeJevClient, jevSettings, JevHttpError, sealRequest, storedRecord, type AskJev, type ChoiceQuestion, type JevRequest } from "../src/fill/jev.ts";
import { makeWriterPort, type WriterRequest } from "../src/writer/port.ts";
import { gatewayRoute } from "../src/writer/routes.ts";
import { appendStore } from "../src/privacy/send.ts";
import { minted } from "./minted.ts";
import { FORM } from "./codemode/fixtures.ts";
import { DailySpend } from "../src/engines/decide/daily-cap.ts";
import { llamaEngine } from "../src/engines/decide/llama.ts";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { cachedAsk } from "../src/engines/decide/cache.ts";
import { eventsIn } from "../src/goals/inventory.ts";
import { macClock } from "../src/offers/event-time.ts";
import type { Node, Snapshot } from "../src/protocol.ts";
import { snap, text } from "./builders.ts";
import { labelKind } from "../src/memory/sensitive.ts";
import { rng } from "./large-scene.ts";

const dir = mkdtempSync(join(tmpdir(), "pv2-inv-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const words = (s: string): { w: string; at: number }[] => [...s.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ w: m[0], at: m.index }));

/**
 * The ledger's rule written out a second time, independently, as the reference the budget property holds the ledger to
 * (SC1 2c as restated for PV2): a cut text stands where it is located (as written before case aside, whole words before
 * inside a word, a whole line before inside a longer one); it reveals that stretch, every line of any window it holds
 * whole (case aside), and where it stands in every other window (3 characters or more); a derivation reveals the stretches
 * of its bases it repeats, and the same of each; one occurrence per stretch per window, another for each repeat; each
 * window charged the characters newly revealed, its prose (lines over 80) against its share, and refused whole when one
 * window would go over.
 */
class Reference {
  readonly marks = new Map<string, Map<string, Uint8Array>>();
  readonly chars = new Map<string, number>();
  readonly prose = new Map<string, number>();
  readonly taken = new Map<string, Set<string>>();
  readonly windows: { id: string; lines: string[]; share: { budget: number; prose: number | null } }[];
  constructor(windows: { id: string; lines: string[]; share: { budget: number; prose: number | null } }[]) {
    this.windows = windows;
  }
  static fold(t: string): string {
    let o = "";
    for (const c of t) {
      const l = c.toLowerCase();
      o += l.length === c.length ? l : c;
    }
    return o;
  }
  private win(id: string): { id: string; lines: string[]; share: { budget: number; prose: number | null } } {
    return this.windows.find((w) => w.id === id) as never;
  }
  /** Where `t` stands in window `id`: the best of (as written, case aside) × (whole words, inside a word), in line order. */
  find(id: string, t: string): { line: string; at: number }[] {
    const ft = Reference.fold(t);
    const word = /[\p{L}\p{N}]/u;
    const buckets: { line: string; at: number }[][] = [[], [], [], []];
    for (const line of this.win(id).lines) {
      const fl = Reference.fold(line);
      for (let p = fl.indexOf(ft); p >= 0; p = fl.indexOf(ft, p + 1)) {
        const bounded = !(word.test(ft[0] ?? "") && word.test(fl[p - 1] ?? "")) && !(word.test(ft[ft.length - 1] ?? "") && word.test(fl[p + ft.length] ?? ""));
        const exact = line.startsWith(t, p);
        (buckets[(exact ? 0 : 2) + (bounded ? 0 : 1)] as { line: string; at: number }[]).push({ line, at: p });
      }
    }
    return buckets.find((b) => b.length > 0) ?? [];
  }
  /** Lines of window `id` of 3 or more characters that `t` holds whole, case aside (inside a word too: T-M2's measure). */
  held(id: string, t: string): string[] {
    const ft = Reference.fold(t);
    return this.win(id).lines.filter((l) => l.length >= 3 && ft.includes(Reference.fold(l)));
  }
  /** The units a run reveals, as the ledger orders them: held lines, the run where it stands, other windows. */
  unitsOf(from: string, run: string, repeat: number, place: { line: string; at: number }[] | null): { id: string; alts: { line: string; at: number; len: number }[]; repeat: number }[] {
    const out: { id: string; alts: { line: string; at: number; len: number }[]; repeat: number }[] = [];
    for (const w of this.windows) for (const l of this.held(w.id, run)) out.push({ id: w.id, alts: [{ line: l, at: 0, len: l.length }], repeat });
    const here = place ?? this.find(from, run);
    const whole = here.filter((o) => o.at === 0 && o.line.length === run.length);
    out.push({ id: from, alts: (whole.length > 0 ? whole : here).map((o) => ({ ...o, len: run.length })), repeat });
    if (run.length >= 3) for (const w of this.windows) if (w.id !== from) {
      const there = this.find(w.id, run);
      if (there.length > 0) out.push({ id: w.id, alts: there.map((o) => ({ ...o, len: run.length })), repeat });
    }
    return out;
  }
  /** The units a derivation's exact stretch reveals: held lines, the stretch itself where the basis stands, other windows. */
  unitsOfSpan(id: string, x: { line: string; at: number; len: number }, repeat: number): ReturnType<Reference["unitsOf"]> {
    const t = x.line.slice(x.at, x.at + x.len);
    const out: ReturnType<Reference["unitsOf"]> = [];
    for (const w of this.windows) for (const l of this.held(w.id, t)) out.push({ id: w.id, alts: [{ line: l, at: 0, len: l.length }], repeat });
    out.push({ id, alts: [{ ...x }], repeat });
    if (t.length >= 3) for (const w of this.windows) if (w.id !== id) {
      const there = this.find(w.id, t);
      if (there.length > 0) out.push({ id: w.id, alts: there.map((o) => ({ ...o, len: t.length })), repeat });
    }
    return out;
  }
  /** Charges units by the rule; the spans chosen, or null (nothing charged) when a window would go over. */
  charge(units: { id: string; alts: { line: string; at: number; len: number }[]; repeat: number }[]): { id: string; line: string; at: number; len: number }[] | null {
    const marks = new Map<string, Map<string, Uint8Array>>();
    const cost = new Map<string, number>();
    const prose = new Map<string, number>();
    const taken = new Map<string, Map<number, Set<string>>>();
    const chosen: { id: string; line: string; at: number; len: number }[] = [];
    const key = (o: { line: string; at: number; len: number }): string => `${o.line}\u0000${o.at}\u0000${o.len}`;
    for (const u of units) {
      if (u.alts.length === 0) continue;
      const f = u.alts[0] as { line: string; at: number; len: number };
      const cls = `${u.id}\u0000${Reference.fold(f.line.slice(f.at, f.at + f.len))}`;
      let byRepeat = taken.get(cls);
      if (byRepeat === undefined) taken.set(cls, (byRepeat = new Map()));
      const mine = byRepeat.get(u.repeat) ?? new Set<string>();
      const others = new Set([...byRepeat].filter(([r]) => r !== u.repeat).flatMap(([, x]) => [...x]));
      const same = u.alts.filter((o) => mine.has(key(o)));
      const free = u.alts.filter((o) => !others.has(key(o)));
      const alts = same.length > 0 ? same : free.length > 0 ? free : u.alts;
      let wm = marks.get(u.id);
      if (wm === undefined) marks.set(u.id, (wm = new Map()));
      const view = (line: string): Uint8Array | undefined => wm?.get(line) ?? this.marks.get(u.id)?.get(line);
      let best: { line: string; at: number; len: number } | null = null;
      let bestMarked = -1;
      for (const o of alts) {
        const m = view(o.line);
        let marked = 0;
        if (m !== undefined) for (let k = o.at; k < o.at + o.len; k++) marked += m[k] as number;
        if (marked === o.len) {
          best = o;
          break;
        }
        const short = o.line.length <= 80;
        const bestShort = best !== null && best.line.length <= 80;
        if (best === null || (short && !bestShort) || (short === bestShort && marked > bestMarked)) (best = o, (bestMarked = marked));
      }
      if (best === null) continue;
      mine.add(key(best));
      byRepeat.set(u.repeat, mine);
      chosen.push({ id: u.id, ...best });
      let m = wm.get(best.line);
      if (m === undefined) wm.set(best.line, (m = (this.marks.get(u.id)?.get(best.line) ?? new Uint8Array(best.line.length)).slice()));
      let n = 0;
      for (let k = best.at; k < best.at + best.len; k++) if (m[k] === 0) (m[k] = 1, n++);
      cost.set(u.id, (cost.get(u.id) ?? 0) + n);
      if (best.line.length > 80) prose.set(u.id, (prose.get(u.id) ?? 0) + n);
    }
    for (const [id, c] of cost) {
      const w = this.win(id);
      if ((this.chars.get(id) ?? 0) + c > w.share.budget) return null;
      if (w.share.prose !== null && (this.prose.get(id) ?? 0) + (prose.get(id) ?? 0) > w.share.prose) return null;
    }
    for (const [id, wm] of marks) for (const [l, m] of wm) {
      let e = this.marks.get(id);
      if (e === undefined) this.marks.set(id, (e = new Map()));
      e.set(l, m);
    }
    for (const [id, c] of cost) this.chars.set(id, (this.chars.get(id) ?? 0) + c);
    for (const [id, c] of prose) this.prose.set(id, (this.prose.get(id) ?? 0) + c);
    return chosen;
  }
  /** Whether the view shows `t` as written: each piece (a line, or a stretch between ellipses) inside one line. */
  shows(id: string, t: string): boolean {
    const pieces = t.split("\n").flatMap((x) => x.split("…")).map((x) => x.replace(/\s+/gu, " ").trim()).filter((x) => x !== "");
    return pieces.length > 0 && pieces.every((p) => this.win(id).lines.some((l) => l.includes(p)));
  }
  /** Cutting texts from window `from`: each piece located (here only whole stretches of a line), repeats per text. */
  cut(from: string, texts: string[]): { id: string; line: string; at: number; len: number }[] | null {
    const seen = this.taken.get(from) ?? new Set<string>();
    const fresh = [...new Set(texts)].filter((t) => !seen.has(t));
    const units: ReturnType<Reference["unitsOf"]> = [];
    for (const t of fresh) {
      const said = new Map<string, number>();
      const add = (run: string): void => {
        const r = said.get(Reference.fold(run)) ?? 0;
        said.set(Reference.fold(run), r + 1);
        units.push(...this.unitsOf(from, run, r, null));
      };
      for (const piece of t.split("\n").flatMap((x) => x.split("…")).map((x) => x.replace(/\s+/gu, " ").trim()).filter((x) => x !== "")) {
        if (this.find(from, piece).length > 0) {
          add(piece);
          continue;
        }
        // Else runs of its words, each where a line shows it, the longest first; a word no line shows: no cut.
        const ws = [...piece.matchAll(/[\p{L}\p{N}]+/gu)].map((x) => ({ at: x.index, end: x.index + x[0].length }));
        for (let i = 0; i < ws.length; ) {
          let k = ws.length - 1;
          for (; k >= i; k--) if (this.find(from, piece.slice((ws[i] as { at: number }).at, (ws[k] as { end: number }).end)).length > 0) break;
          if (k < i) return null;
          add(piece.slice((ws[i] as { at: number }).at, (ws[k] as { end: number }).end));
          i = k + 1;
        }
      }
    }
    const got = this.charge(units);
    if (got === null) return null;
    for (const t of fresh) seen.add(t);
    this.taken.set(from, seen);
    return got;
  }
}

describe("invariant: pricing never searches text; what a request reveals of a window is exactly what it is charged", () => {
  const spanKey = (x: { windowId?: string; id?: string; line: string; at: number; len: number }): string => `${x.windowId ?? x.id}\u0000${x.line}\u0000${x.at}\u0000${x.len}`;
  const sameSpans = (got: readonly { windowId: string; line: string; at: number; len: number }[], want: readonly { id: string; line: string; at: number; len: number }[], why: string): void => {
    expect([...new Set(got.map(spanKey))].sort(), why).toEqual([...new Set(want.map(spanKey))].sort());
  };
  function agree(d: Disclosure, ref: Reference, why: string): void {
    for (const w of ref.windows) {
      const charged = d.markedLines(w.id);
      const want = ref.marks.get(w.id) ?? new Map<string, Uint8Array>();
      for (const l of new Set([...charged.keys(), ...want.keys()])) expect(charged.get(l) ?? 0, `${why}: ${w.id} line ${JSON.stringify(l.slice(0, 40))}`).toBe((want.get(l) ?? new Uint8Array()).reduce((n, b) => n + b, 0));
      expect(d.declared().charged[w.id] ?? 0, `${why}: ${w.id}`).toBe(ref.chars.get(w.id) ?? 0);
      expect(ref.chars.get(w.id) ?? 0, `${why}: ${w.id} budget`).toBeLessThanOrEqual(w.share.budget);
      if (w.share.prose !== null) expect(ref.prose.get(w.id) ?? 0, `${why}: ${w.id} prose`).toBeLessThanOrEqual(w.share.prose);
    }
  }
  /** A desk of windows that share sentences, copy lines in another case or spacing, and repeat words and lines. */
  function desk(r: () => number): { m: ScreenModel; consented: Set<string>; lines: Map<string, string[]> } {
    let next = 0;
    const word = (): string => `${pick(r, ["Ka", "lo", "Mi", "ne", "su", "Ta"])}${pick(r, ["ber", "dan", "fel", "gor"])}${next++}`;
    const sentence = (n: number): string => {
      const ws = Array.from({ length: n }, word);
      // A word said twice in the line, now and then.
      if (r() < 0.4 && ws.length > 2) ws.push(ws[Math.floor(r() * ws.length)] as string);
      return ws.join(" ");
    };
    const shared = Array.from({ length: 2 }, () => sentence(r() < 0.5 ? 3 : 15));
    const ids = ["a", "b", "c"];
    const m = new ScreenModel();
    const lines = new Map<string, string[]>();
    for (const id of ids) {
      const own = Array.from({ length: 2 + Math.floor(r() * 3) }, () => sentence(r() < 0.5 ? 2 + Math.floor(r() * 3) : 14 + Math.floor(r() * 6)));
      const mine = [...own, ...shared.filter(() => r() < 0.7)];
      // A copy of one of its lines in capitals, and one with doubled spaces (the same line once whitespace is collapsed).
      if (r() < 0.5) mine.push((mine[0] as string).toUpperCase());
      if (r() < 0.5) mine.push((mine[1] ?? (mine[0] as string)).split(" ").join("  "));
      // A line said twice in the window.
      if (r() < 0.3) mine.push(mine[0] as string);
      m.apply(snap(mine.map((l, i) => text(`${id}${i}`, l)), { at: 1000, windowId: id, title: `Title ${id}` }));
      lines.set(id, mine);
    }
    return { m, consented: new Set(r() < 0.5 ? ["a"] : []), lines };
  }
  /** The reference's view of each window: its distinct lines, whitespace collapsed, title first, as the ledger reads them. */
  function reference(m: ScreenModel, consented: Set<string>): Reference {
    return new Reference([...m.windows.values()].map((w) => {
      const lines: string[] = [];
      for (const raw of [w.window.title, ...[...w.nodes.values()].flatMap((n) => [n.label, n.value, n.placeholder])]) {
        for (const l of (raw ?? "").split("\n")) {
          const f = l.replace(/\s+/gu, " ").trim();
          if (f !== "" && !lines.includes(f)) lines.push(f);
        }
      }
      return { id: w.window.windowId, lines, share: consented.has(w.window.windowId) ? { budget: 1200, prose: null } : windowShare(w) };
    }));
  }

  it.each(Array.from({ length: 80 }, (_, i) => i + 1))("seed %i: cuts and derivations across shared, copied and repeated text", (seed) => {
    const r = rng(seed * 7);
    const { m, consented, lines } = desk(r);
    const d = new Disclosure(m.windows.values(), { consented });
    const ref = reference(m, consented);
    const views = new Map([...m.windows.values()].map((w) => [w.window.windowId, redactWindow(w)]));
    const spansOf = new Map<string, Map<string, { id: string; line: string; at: number; len: number }>>();
    const attach = (t: string, xs: readonly { id: string; line: string; at: number; len: number }[]): void => {
      let s0 = spansOf.get(t);
      if (s0 === undefined) spansOf.set(t, (s0 = new Map()));
      for (const x of xs) s0.set(spanKey(x), x);
    };
    let nulls = 0;
    let mints = 0;
    const minted: ModelText[] = [];
    for (let step = 0; step < 40; step++) {
      const id = pick(r, [...lines.keys()]);
      const view = views.get(id) as WindowState;
      const ws = pick(r, ref.windows.find((w) => w.id === id)?.lines ?? []).split(" ");
      const a = Math.floor(r() * ws.length);
      const piece = ws.slice(a, Math.min(ws.length, a + 1 + Math.floor(r() * 5))).join(" ");
      const path = pick(r, ["candidate", "held", "take", "foreign", "derived", "compose"] as const);
      const why = `seed ${seed} step ${step} (${path} ${id})`;
      if (path === "candidate" || path === "held") {
        const want = ref.shows(id, piece) ? ref.cut(id, [piece]) : null;
        const got = path === "candidate" ? d.candidate(view, piece) : d.held(view, piece);
        expect(got === null, why).toBe(want === null);
        if (got === null) nulls++;
        else (mints++, attach(piece, want ?? []), minted.push(got));
      } else if (path === "take") {
        const other = pick(r, ref.windows.find((w) => w.id === id)?.lines ?? []).split(" ")[0] as string;
        const t = `${piece}${pick(r, [" ", "\n", "… "])}${other}`;
        const want = ref.cut(id, [t]);
        const got = d.take(view, "candidate", [t]);
        expect(got, why).toBe(want !== null);
        if (!got) nulls++;
        else mints++;
      } else if (path === "foreign") {
        // A text a word of which no line shows is no cut: null, and nothing charged.
        expect(d.candidate(view, `${piece} unseen${step}`), why).toBeNull();
        expect(d.take(view, "candidate", [`${piece} unseen${step}`]), why).toBe(false);
        nulls++;
      } else if (path === "derived") {
        // A basis that spans a repeated word, or a line said twice; the derivation says some of it again, its case changed.
        const basisText = r() < 0.3 ? `${piece}\n${piece}` : piece;
        const b = d.basis(view, basisText);
        expect(b === null, why).toBe(!ref.shows(id, basisText));
        if (b === null) {
          nulls++;
          continue;
        }
        const pieces = basisText.split("\n");
        const used = new Set<string>();
        const placed = pieces.map((p) => {
          const alts = ref.find(id, p).filter((o) => o.line.slice(o.at, o.at + p.length).length === p.length);
          const whole = alts.filter((o) => o.at === 0 && o.line.length === p.length);
          const pool = whole.length > 0 ? whole : alts;
          const at = pool.find((o) => !used.has(`${o.line}\u0000${o.at}`)) ?? pool[0];
          if (at !== undefined) used.add(`${at.line}\u0000${at.at}`);
          return { text: p, line: (at as { line: string }).line, at: (at as { at: number }).at };
        });
        const outWords = pieces.flatMap((p) => p.split(" ")).filter(() => r() < 0.7);
        if (outWords.length === 0) continue;
        const out = outWords.map((w) => (r() < 0.3 ? w.toUpperCase() : w)).join(r() < 0.3 ? "  " : " ");
        // The stretches it reveals of its basis: each run of its words that a basis piece shows as consecutive words.
        const words = (t: string): { w: string; at: number; end: number }[] => [...t.matchAll(/[\p{L}\p{N}]+/gu)].map((x) => ({ w: Reference.fold(x[0]), at: x.index, end: x.index + x[0].length }));
        const ow = words(out);
        const pw = placed.map((p) => ({ ...p, words: words(p.text) }));
        const usedStart = new Set<string>();
        const spans: { line: string; at: number; len: number }[] = [];
        for (let i = 0; i < ow.length; ) {
          let best: { key: string; k: number; span: { line: string; at: number; len: number } } | null = null;
          for (const p of pw) for (let st = 0; st < p.words.length; st++) {
            const key = `${p.line}\u0000${p.at}\u0000${st}`;
            if (usedStart.has(key)) continue;
            let k = 0;
            while (i + k < ow.length && st + k < p.words.length && (ow[i + k] as { w: string }).w === (p.words[st + k] as { w: string }).w) k++;
            if (k === 0 || (best !== null && k <= best.k)) continue;
            best = { key, k, span: { line: p.line, at: p.at + (p.words[st] as { at: number }).at, len: (p.words[st + k - 1] as { end: number }).end - (p.words[st] as { at: number }).at } };
          }
          if (best === null) {
            i++;
            continue;
          }
          usedStart.add(best.key);
          spans.push(best.span);
          i += best.k;
        }
        const exact = spans.flatMap((x, i) => ref.unitsOfSpan(id, x, i));
        const want = spans.length === 0 ? [] : ref.charge(exact);
        const got = d.derived(b, out);
        expect(got === null, why).toBe(want === null);
        if (got === null) nulls++;
        else {
          mints++;
          attach(out, want ?? []);
          sameSpans(d.spansOfText(got), [...(spansOf.get(out)?.values() ?? [])], `${why}: spans`);
          minted.push(got);
        }
      } else if (minted.length >= 2) {
        // Composition: the union of its parts' spans, and nothing charged anew.
        const [x, y] = [pick(r, minted), pick(r, minted)];
        const before = JSON.stringify(d.declared().charged);
        const c = d.t`${x} and ${y}`;
        expect(JSON.stringify(d.declared().charged), why).toBe(before);
        const union = [...d.spansOfText(x), ...d.spansOfText(y)];
        expect([...new Set(d.spansOfText(c).map(spanKey))].sort(), why).toEqual([...new Set(union.map(spanKey))].sort());
      }
      if (path === "candidate" || path === "held") {
        const got = spansOf.get(piece);
        if (got !== undefined && d.spansOfText(piece).length > 0) sameSpans(d.spansOfText(piece), [...got.values()], `${why}: spans`);
      }
      agree(d, ref, why);
    }
    // Not vacuous: the generator mints, and some cuts are refused.
    expect(mints, `seed ${seed}: mints`).toBeGreaterThan(0);
    expect(nulls, `seed ${seed}: nulls`).toBeGreaterThan(0);
  });

  it("the reviewer's three counterexamples", () => {
    // 1. A 108-character sentence, its uppercase copy and unrelated prose: the sentence reveals both lines.
    const s1 = "Dana said the staging rotation moves to the Austin office after the March review then back in June ok.";
    const s108 = `${s1}${"x".repeat(108 - s1.length - 1)}.`;
    expect(s108.length).toBe(108);
    const prose = "Unrelated prose about the shipment, the invoice and the venue that nobody asked about at all, written out long.";
    const m1 = new ScreenModel();
    m1.apply(snap([text("t0", s108), text("t1", s108.toUpperCase()), text("t2", prose), text("t3", `${prose} Again.`)], { at: 1000, windowId: "w", title: "Notes" }));
    const w1 = m1.windows.get("w") as WindowState;
    const d1 = new Disclosure(m1.windows.values());
    const got1 = d1.candidate(redactWindow(w1), s108);
    const share1 = windowShare(w1);
    // It reveals 216 characters of prose; refused whole when that is over the share, else charged all 216.
    if (share1.prose !== null && share1.prose < 216) {
      expect(got1).toBeNull();
      expect(d1.declared().charged.w ?? 0).toBe(0);
    } else expect(d1.declared().charged.w).toBe(216);
    // 2. A consented note and an unconsented chat show the same 110-character sentence: a derivation of it from the note
    // is charged to the chat too, against the chat's own budget.
    const s110 = "Robin asked whether the staging rotation could move to the Austin office after the March review is done".padEnd(109, " x") + ".";
    expect(s110.length).toBe(110);
    const m2 = new ScreenModel();
    m2.apply(snap([text("n0", s110), text("n1", "Notes about other things")], { at: 1000, windowId: "note", title: "Note" }));
    m2.apply(snap([text("c0", s110), text("c1", "ok")], { at: 1000, windowId: "chat", title: "Chat" }));
    const chat = m2.windows.get("chat") as WindowState;
    const d2 = new Disclosure(m2.windows.values(), { consented: new Set(["note"]) });
    const b2 = d2.basis(redactWindow(m2.windows.get("note") as WindowState), s110);
    const got2 = b2 === null ? null : d2.derived(b2, s110);
    const chatBudget = windowShare(chat).budget;
    if (chatBudget < 110) {
      expect(got2).toBeNull();
      expect(d2.declared().charged.chat ?? 0).toBe(0);
    } else expect(d2.declared().charged.chat).toBe(110);
    // 3. A basis "Echo\nEcho" cut from "Echo Echo" reveals both occurrences.
    const m3 = new ScreenModel();
    m3.apply(snap([text("e0", "Echo Echo"), text("e1", "Other line here")], { at: 1000, windowId: "e", title: "E" }));
    const d3 = new Disclosure(m3.windows.values());
    const b3 = d3.basis(redactWindow(m3.windows.get("e") as WindowState), "Echo\nEcho");
    expect(b3).not.toBeNull();
    expect(d3.derived(b3!, "Echo Echo")).toBe("Echo Echo");
    expect(d3.markedLines("e").get("Echo Echo")).toBe(8);
  });

  it.each(Array.from({ length: 20 }, (_, i) => i + 1))("seed %i: the goal inventory's event derivations reveal the person, the dates, the event's kind and the title", (seed) => {
    const r = rng(seed * 31);
    const name = pick(r, ["Priya", "Dana", "Robin", "Aiko", "Mateo"]);
    const kind = pick(r, ["lunch", "coffee", "meet", "dinner"]);
    const day = 8 + Math.floor(r() * 10);
    const weekday = ["Thursday", "Friday", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday"][(day - 8) % 7] as string;
    const date = `${weekday}, October ${day}, 2026`;
    const hour = 1 + Math.floor(r() * 5);
    const time = `${hour}:00 PM to ${hour}:45 PM PT`;
    const sentence = kind === "meet" ? `Can we meet with ${name} on ${date} from ${time} to sort it out?` : `Can we have ${kind} with ${name} on ${date} from ${time} to sort it out?`;
    const filler = Array.from({ length: 3 }, (_, i) => `Earlier note ${i}: the shipment went out on time and the invoice was paid in full last month, nothing else.`);
    const m = new ScreenModel();
    m.apply(snap([text("t0", sentence), ...filler.map((f, i) => text(`x${i}`, f))], { at: 1000, windowId: "c", title: "Chat", values: [{ kind: "date", text: date, nodeKey: "t0" }, { kind: "time", text: time, nodeKey: "t0" }] }));
    const w = m.windows.get("c") as WindowState;
    const d = new Disclosure(m.windows.values());
    let n = 0;
    const found = eventsIn(w, [], macClock(new Date("2026-10-07T10:00:00Z")), "s1", d, () => `v${++n}`);
    expect(found.length, `seed ${seed}: an event`).toBe(1);
    const want = new Map<string, Set<number>>();
    const reveal = (line: string, at: number, len: number): void => {
      const x = want.get(line) ?? new Set<number>();
      for (let q = at; q < at + len; q++) x.add(q);
      want.set(line, x);
    };
    reveal(sentence, sentence.indexOf(name), name.length);
    reveal(sentence, sentence.indexOf(date), date.length);
    reveal(sentence, sentence.indexOf(time), time.length);
    // The event's kind, when the sentence names one; "Meet" is Caret's template word, not the sentence's.
    if (kind !== "meet") reveal(sentence, sentence.indexOf(kind), kind.length);
    reveal("Chat", 0, 4);
    const charged = d.markedLines("c");
    for (const l of new Set([...want.keys(), ...charged.keys()])) expect(charged.get(l) ?? 0, `seed ${seed}: ${l.slice(0, 30)}`).toBe(want.get(l)?.size ?? 0);
  });
});

describe("invariant: nothing inside an excluded node keeps a value", () => {
  const ROLES = ["AXGroup", "AXTextField", "AXStaticText", "AXCell", "AXList", "AXWindow", "AXWebArea", "AXScrollArea", "AXApplication", "AXSplitGroup", "AXBrowser", "AXSheet", "AXDrawer", "AXSecureTextField"];
  /** Labels: plain ones, and ones whose kind is sensitive (memory/sensitive.ts labelKind), on a field or a group. */
  const LABELS = ["Name", "Notes", "Card number", "Password", "Security code", "Account", "Email"];

  /** A random tree, its nodes in a random order, so a child may come before its parent. */
  function tree(r: () => number, n: number): Node[] {
    const out: Node[] = [];
    for (let i = 0; i < n; i++) {
      const parent = i === 0 ? null : `n${Math.floor(r() * i)}`;
      const mark = r();
      out.push({ key: `n${i}`, parent, role: pick(r, ROLES), label: pick(r, LABELS), value: `value of node ${i}`, ...(r() < 0.5 ? { editable: true as const } : {}), ...(mark < 0.08 ? { states: ["secure" as const] } : mark < 0.12 ? { excluded: "password" as const } : {}) });
    }
    for (let i = out.length - 1; i > 0; i--) {
      const k = Math.floor(r() * (i + 1));
      [out[i], out[k]] = [out[k] as Node, out[i] as Node];
    }
    return out;
  }

  function check(w: WindowState, seed: number, step: string): void {
    const excludedAbove = (n: Node): boolean => {
      const seen = new Set<string>();
      for (let p = n.parent === null ? undefined : w.nodes.get(n.parent); p !== undefined && !seen.has(p.key); p = p.parent === null ? undefined : w.nodes.get(p.parent)) {
        seen.add(p.key);
        if (p.excluded !== undefined || p.states?.includes("secure") === true || p.role === "AXSecureTextField") return true;
      }
      return false;
    };
    for (const n of w.nodes.values()) {
      // Rule (ii): an editable field whose own label names a sensitive kind is excluded.
      if (n.editable === true && labelKind(n.label) !== null) expect(n.excluded, `seed ${seed} ${step}: ${n.key} labelled ${n.label}`).toBeDefined();
      // Rule (i): nothing inside an excluded node keeps a value or a typed value.
      if (!excludedAbove(n)) continue;
      expect(n.value, `seed ${seed} ${step}: ${n.key}`).toBeUndefined();
      expect(w.values.some((v) => v.nodeKey === n.key), `seed ${seed} ${step}: typed value of ${n.key}`).toBe(false);
    }
  }

  it.each(Array.from({ length: 60 }, (_, i) => i + 1))("seed %i, merged across random cut and partial walks, and read with a page's nodes", (seed) => {
    const r = rng(seed * 7919);
    const nodes = tree(r, 8 + Math.floor(r() * 25));
    const values = nodes.filter(() => r() < 0.4).map((n) => ({ kind: "email" as const, text: `${n.key}@example.test`, nodeKey: n.key }));
    const valued = nodes.map((n) => {
      const v = values.find((x) => x.nodeKey === n.key);
      return v === undefined ? n : { ...n, value: `${n.value} ${v.text}` };
    });
    const m = new ScreenModel();
    m.apply(snap(valued, { at: 1000, windowId: "w", values }));
    check(m.windows.get("w") as WindowState, seed, "step 0");
    for (let step = 1; step <= 6; step++) {
      // A cut walk: some nodes again, a mark flipped on some of them; or a partial walk from a random root.
      const sent = valued.filter(() => r() < 0.5).map((n) => (r() < 0.25 ? { ...n, states: ["secure" as const] } : r() < 0.1 ? { ...n, editable: true as const, states: ["secure" as const] } : n));
      const at = 1000 + step * 100;
      const s: Snapshot = r() < 0.6
        ? { ...snap(sent, { at, windowId: "w", values: values.filter((v) => sent.some((n) => n.key === v.nodeKey)) }), stats: { walkMs: 5, visited: sent.length, truncated: true } }
        : snap(sent.filter((n) => n.parent !== null), { at, windowId: "w", root: pick(r, valued).key, values: [] });
      m.apply(s);
      check(m.windows.get("w") as WindowState, seed, `step ${step}`);
    }
    // A page's nodes read in over the window (ScreenModel.withNodes, the page context): new ones under kept ones, and
    // kept ones marked again, in a random order.
    const extra: Node[] = Array.from({ length: 6 }, (_, i) => ({ key: `p${i}`, parent: pick(r, valued).key, role: pick(r, ROLES), label: pick(r, LABELS), value: `page value ${i}`, ...(r() < 0.5 ? { editable: true as const } : {}) }));
    const remarked = valued.filter(() => r() < 0.2).map((n) => ({ ...n, states: ["secure" as const] }));
    const v = m.withNodes(new Map([["w", { nodes: [...extra, ...remarked].sort(() => r() - 0.5), title: null }]]));
    check(v.windows.get("w") as WindowState, seed, "with the page's nodes");
  });
});

describe("invariant: what leaves is the sealed copy, checked as it leaves, on every attempt", () => {
  /** A request whose one own text names it, so a transport or a store can tell which request it carries. */
  function jevRequest(id: number, questions = 1): JevRequest {
    const d = new Disclosure([]);
    const qs: Record<string, ChoiceQuestion> = {};
    for (let q = 0; q < questions; q++) qs[`q${q}`] = { type: "choice", instructions: d.own("Which?"), criteria: { a: d.own("A"), b: d.own("B") } };
    return d.seal({ purpose: "route.judge" as const, state: { task: d.own(`request ${id}` as "request 1") }, questions: qs, snippets: [], charged: {} });
  }
  function writerRequest(id: number): WriterRequest {
    const r = minted({ kind: "plan" as const, disclosureId: "inv", input: { goal: `request ${id}`, snapshots: [FORM] }, maxOutputTokens: 16, signal: new AbortController().signal });
    return r as unknown as WriterRequest;
  }
  /** Another request's text, minted by a Disclosure this request does not have: what a mutation swaps in. */
  const foreign = (id: number): ModelText => new Disclosure([]).own(`swapped secret ${id}` as "swapped secret 1");
  const idOf = (body: string): number => Number(/request (\d+)/u.exec(body)?.[1] ?? "-1");
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it.each(Array.from({ length: 30 }, (_, i) => i + 1))("seed %i: builds, queueing, 429 retries, mutations while pending, stores and switch-offs", async (seed) => {
    const r = rng(seed * 104729);
    let generation = 0;
    const builtAt = new Map<number, number>();
    const events: { id: number; generation: number; where: string; bytes: string }[] = [];
    const record = (where: string, bytes: string): void => void events.push({ id: idOf(bytes), generation, where, bytes });
    const jevFetch: typeof fetch = async (_u, init) => {
      record("jev", String(init?.body));
      await tick();
      if (r() < 0.4) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ model: "jev-test", answers: { q0: { choice: "a", confidence: 0.9 } }, usage: { input_tokens: 1 } }), { status: 200 });
    };
    const client = makeJevClient(() => "k", 10_000, new DailySpend({ dir: join(dir, `cap-${seed}`), capUsd: 100 }), jevSettings({}), jevFetch);
    // llama-server takes one request at a time: a completion of a template's rendered prompt names no request, so it
    // belongs to the last request a body named.
    let llamaCurrent = "";
    const llamaFetch = (async (u: string, init?: RequestInit) => {
      const body = String(init?.body);
      if (idOf(body) >= 0) llamaCurrent = `request ${idOf(body)}`;
      record("llama", idOf(body) >= 0 ? body : `${body} (${llamaCurrent})`);
      await tick();
      if (String(u).endsWith("/apply-template")) return new Response(JSON.stringify({ prompt: "rendered" }), { status: 200 });
      return new Response(JSON.stringify({ completion_probabilities: [{ top_logprobs: [{ token: "A", logprob: 0 }] }], timings: { prompt_n: 1 } }), { status: 200 });
    }) as typeof fetch;
    const llama = llamaEngine({ url: "http://127.0.0.1:1", model: "m", prompt: r() < 0.5 ? "chat" : "document", fetchImpl: llamaFetch });
    const writerFetch = (async (_u: string, init?: RequestInit) => {
      record("writer", String(init?.body));
      await tick();
      return new Response(JSON.stringify({ model: "w", choices: [{ message: { content: "```ts\nasync function main(caret) {}\n```" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    }) as typeof fetch;
    const writer = makeWriterPort(gatewayRoute("inclusionai/ling-3.1-flash-free"), { key: () => "k", fetchFn: writerFetch });
    const slow: AskJev = async () => {
      await tick();
      return { model: "x", answers: { q0: { choice: "a", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    const log = join(dir, `log-${seed}.ndjson`);
    const harness = harnessEngine({ name: "canned", canned: slow, fixture: { windows: () => true, memory: true, plan: true }, logRequests: log });
    const cacheDir = join(dir, `cache-${seed}`);
    const cache = cachedAsk(slow, { dir: cacheDir, mode: "record", engine: "jev", model: "m", fixture: { windows: () => true, memory: true, plan: true }, env: {} });
    const script = join(dir, `script-${seed}.ndjson`);
    // A script's store: sealed before it is sent, sent, then written from the sealed copy (fill/jev.ts storedRecord).
    const scriptStore = async (req: JevRequest): Promise<void> => {
      const sent = sealRequest(req);
      await client(sent.asked);
      appendStore(script, `${JSON.stringify(storedRecord(sent, (f) => ({ state: f.state, questions: { ...f.questions, ...f.nouls } })))}\n`);
    };
    const inflight: Promise<void>[] = [];
    const original = new Map<number, string>();
    let ok = 0;
    const settle = (p: Promise<unknown>): Promise<void> =>
      p.then(
        () => void ok++,
        (e: unknown) => {
          // A refusal at the boundary, or a second 429 the client gives up on, is an outcome; anything else fails the test.
          if (e instanceof UnmintedText || (e instanceof JevHttpError && e.status === 429)) return;
          throw e;
        },
      );
    const logLines = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : []);
    const scriptLines = (): string[] => (existsSync(script) ? readFileSync(script, "utf8").split("\n").filter((l) => l !== "") : []);
    const cacheFiles = (): string[] => (existsSync(cacheDir) ? readdirSync(cacheDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => join(e.parentPath, e.name)) : []);
    const marks: { generation: number; log: number; script: number; cache: Set<string> }[] = [];
    for (let step = 0, id = 0; step < 36; step++) {
      if (step >= 3 && r() < 0.12) {
        noteSwitchedOff();
        generation++;
        marks.push({ generation, log: logLines().length, script: scriptLines().length, cache: new Set(cacheFiles()) });
      } else {
        const n = ++id;
        builtAt.set(n, generation);
        const which = pick(r, ["jev", "llama", "harness", "cache", "writer", "script"] as const);
        if (which === "writer") {
          const req = writerRequest(n);
          inflight.push(settle(writer.write(req)));
          if (r() < 0.4) (req as { input: unknown }).input = { goal: foreign(n), snapshots: [] };
        } else {
          const req = jevRequest(n, which === "llama" ? 1 + Math.floor(r() * 3) : 1);
          // What was sent, as built: every store must record exactly this, byte for byte.
          original.set(n, JSON.stringify({ state: req.state, questions: { ...req.questions, ...req.nouls } }));
          const send = which === "jev" ? client : which === "llama" ? llama.ask : which === "harness" ? harness.ask : which === "cache" ? cache : scriptStore;
          inflight.push(settle(send(req)));
          // A caller changing its request while it is pending changes nothing that leaves.
          if (r() < 0.4) (req as { state: unknown }).state = { task: foreign(n) };
        }
      }
      if (r() < 0.5) await tick();
    }
    await Promise.all(inflight);
    const stored = [...logLines().map((l, i) => ({ l, i, where: "log" })), ...scriptLines().map((l, i) => ({ l, i, where: "script" }))];
    for (const x of events) {
      expect(x.bytes, `seed ${seed}: ${x.where} got a swapped text`).not.toContain("swapped");
      expect(x.generation, `seed ${seed}: request ${x.id} reached ${x.where} after a switch-off`).toBe(builtAt.get(x.id));
    }
    for (const x of events.filter((e) => e.where === "jev")) {
      const b = JSON.parse(x.bytes) as { state: unknown; questions: unknown };
      expect(JSON.stringify({ state: b.state, questions: b.questions }), `seed ${seed}: jev body of request ${x.id}`).toBe(original.get(x.id));
    }
    for (const { l, i, where } of stored) {
      expect(l, `seed ${seed}: ${where} kept a swapped text`).not.toContain("swapped");
      const rec = JSON.parse(l) as { body?: { state: unknown; questions: unknown }; state?: unknown; questions?: unknown };
      const kept = rec.body ?? rec;
      expect(JSON.stringify({ state: kept.state, questions: kept.questions }), `seed ${seed}: ${where} line ${i} is the sent copy`).toBe(original.get(idOf(l)));
      const after = marks.filter((k) => (where === "log" ? k.log : k.script) <= i).at(-1);
      if (after !== undefined) expect(builtAt.get(idOf(l)), `seed ${seed}: ${where} line ${i} written after switch-off ${after.generation}`).toBeGreaterThanOrEqual(after.generation);
    }
    for (const f of cacheFiles()) {
      const text = readFileSync(f, "utf8");
      expect(text, `seed ${seed}: cache kept a swapped text`).not.toContain("swapped");
      const entry = JSON.parse(text) as { canonical: { state: unknown } };
      expect(JSON.stringify(entry.canonical.state), `seed ${seed}: cache entry is the sent copy`).toBe(JSON.stringify((JSON.parse(original.get(idOf(text)) ?? "{}") as { state: unknown }).state));
      const after = marks.filter((k) => !k.cache.has(f)).at(-1);
      if (after !== undefined) expect(builtAt.get(idOf(text)), `seed ${seed}: cache entry written after switch-off ${after.generation}`).toBeGreaterThanOrEqual(after.generation);
    }
    // Not vacuous: requests did go out and get answered.
    expect(ok, `seed ${seed}: nothing succeeded`).toBeGreaterThan(0);
  });
});
