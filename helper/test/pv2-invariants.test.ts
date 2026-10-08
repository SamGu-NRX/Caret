import { beforeEach as vercelBeforeEach, afterEach as vercelAfterEach, vi as vercelVi } from "vitest";
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
import { Disclosure, LedgerRefused, UnmintedText, type ModelText, registryOf } from "../src/privacy/disclosure.ts";
import { decodeUnits } from "../src/privacy/ledger/units.ts";
import { isConversation } from "../src/conversation.ts";
import { refReveal, refUnits } from "./ledger-reference.ts";
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
 * The output ledger's invariant (OUTPUT-LEDGER-SPEC sections 4, 5 and 9), at the two places it is applied:
 * - while a request is built, every window's running charge is exactly the brute-force reference's measure
 *   (test/ledger-reference.ts) of the texts admitted so far, and a mint is refused exactly when admitting it would break a
 *   window's limit;
 * - at seal, the charge declared for the request's final bytes is exactly the reference's measure of their decoded units.
 * The reference shares only the normalizer with production.
 */
describe("invariant: what a request reveals of a window is exactly what it is charged", () => {
  /** A window's inventory as section 1 collects it from a view with nothing redacted: title first, distinct lines. */
  const linesOfWindow = (w: WindowState): string[] => {
    const out: string[] = [];
    for (const raw of [w.window.title, ...[...w.nodes.values()].flatMap((n) => [n.label, n.value, n.placeholder])]) {
      for (const l of (raw ?? "").split(/\r\n|\r|\n/u)) {
        const f = l.replace(/\s+/gu, " ").trim();
        if (f !== "" && !out.includes(f)) out.push(f);
      }
    }
    return out;
  };
  /** The limit of a window: section 5's, consent included (a conversation's limit stands over it). */
  const limitOf = (w: WindowState, consented: ReadonlySet<string>): { budget: number; prose: number | null } => (consented.has(w.window.windowId) && !isConversation(w) ? { budget: 1200, prose: null } : windowShare(w));
  const breaks = (r: { charged: number; prose: number }, l: { budget: number; prose: number | null }): boolean => r.charged > l.budget || (l.prose !== null && r.prose > l.prose);

  /** A desk of windows that share sentences, copy lines in another case or spacing, and repeat words and lines. */
  function desk(r: () => number): { m: ScreenModel; consented: Set<string>; lines: Map<string, string[]> } {
    let next = 0;
    const word = (): string => `${pick(r, ["Ka", "lo", "Mi", "ne", "su", "Ta"])}${pick(r, ["ber", "dan", "fel", "gor"])}${next++}`;
    const sentence = (n: number): string => {
      const ws = Array.from({ length: n }, word);
      if (r() < 0.4 && ws.length > 2) ws.push(ws[Math.floor(r() * ws.length)] as string);
      return ws.join(" ");
    };
    const shared = Array.from({ length: 2 }, () => sentence(r() < 0.5 ? 3 : 15));
    const m = new ScreenModel();
    const lines = new Map<string, string[]>();
    for (const id of ["a", "b", "c"]) {
      const own = Array.from({ length: 2 + Math.floor(r() * 3) }, () => sentence(r() < 0.5 ? 2 + Math.floor(r() * 3) : 14 + Math.floor(r() * 6)));
      const mine = [...own, ...shared.filter(() => r() < 0.7)];
      if (r() < 0.5) mine.push((mine[0] as string).toUpperCase());
      if (r() < 0.5) mine.push((mine[1] ?? (mine[0] as string)).split(" ").join("  "));
      if (r() < 0.3) mine.push(mine[0] as string);
      m.apply(snap(mine.map((l, i) => text(`${id}${i}`, l)), { at: 1000, windowId: id, title: `Title ${id}` }));
      lines.set(id, mine);
    }
    return { m, consented: new Set(r() < 0.5 ? ["a"] : []), lines };
  }

  function agree(d: Disclosure, m: ScreenModel, consented: ReadonlySet<string>, why: string): void {
    const admitted = d.admitted().map((t) => [t]);
    for (const w of m.windows.values()) {
      const want = refReveal(admitted, linesOfWindow(w));
      expect(d.declared().charged[w.window.windowId] ?? 0, `${why}: ${w.window.windowId}`).toBe(want.charged);
      expect(breaks(want, limitOf(w, consented)), `${why}: ${w.window.windowId} within its limit`).toBe(false);
    }
  }

  /** Whether admitting `t` on top of what is admitted would break some window's limit, by the reference. */
  function refused(d: Disclosure, m: ScreenModel, consented: ReadonlySet<string>, t: string): boolean {
    const units = [...d.admitted(), t].map((x) => [x]);
    return [...m.windows.values()].some((w) => breaks(refReveal(units, linesOfWindow(w)), limitOf(w, consented)));
  }

  it.each(Array.from({ length: 80 }, (_, i) => i + 1))("seed %i: cuts, derivations and compositions across shared, copied and repeated text", (seed) => {
    const r = rng(seed * 7);
    const { m, consented, lines } = desk(r);
    const d = new Disclosure(m, { consented });
    const views = new Map([...m.windows.values()].map((w) => [w.window.windowId, redactWindow(w)]));
    let nulls = 0;
    let mints = 0;
    const minted: ModelText[] = [];
    for (let step = 0; step < 40; step++) {
      const id = pick(r, [...lines.keys()]);
      const view = views.get(id) as WindowState;
      const ws = pick(r, linesOfWindow(view).slice(1)).split(" ");
      const a = Math.floor(r() * ws.length);
      const piece = ws.slice(a, Math.min(ws.length, a + 1 + Math.floor(r() * 5))).join(" ");
      const path = pick(r, ["candidate", "held", "take", "foreign", "derived", "compose"] as const);
      const why = `seed ${seed} step ${step} (${path} ${id})`;
      if (path === "candidate" || path === "held") {
        const want = refused(d, m, consented, piece);
        const got = path === "candidate" ? d.candidate(view, piece) : d.held(view, piece);
        expect(got === null, why).toBe(want);
        if (got === null) nulls++;
        else (mints++, minted.push(got));
      } else if (path === "take") {
        const other = pick(r, linesOfWindow(view).slice(1)).split(" ")[0] as string;
        const t = `${piece}${pick(r, [" ", "\n", "… "])}${other}`;
        const want = refused(d, m, consented, t);
        expect(d.take(view, "candidate", [t]), why).toBe(!want);
        if (want) nulls++;
        else mints++;
      } else if (path === "foreign") {
        // A text a word of which no line shows is no cut: null, and nothing charged.
        const before = JSON.stringify(d.declared().charged);
        expect(d.candidate(view, `${piece} unseen${step}`), why).toBeNull();
        expect(d.take(view, "candidate", [`${piece} unseen${step}`]), why).toBe(false);
        expect(JSON.stringify(d.declared().charged), why).toBe(before);
        nulls++;
      } else if (path === "derived") {
        const basisText = r() < 0.3 ? `${piece}\n${piece}` : piece;
        const b = d.basis(view, basisText);
        if (b === null) {
          nulls++;
          continue;
        }
        const outWords = basisText.split("\n").flatMap((p) => p.split(" ")).filter(() => r() < 0.7);
        if (outWords.length === 0) continue;
        const out = outWords.map((w) => (r() < 0.3 ? w.toUpperCase() : w)).join(r() < 0.3 ? "  " : " ");
        const want = refused(d, m, consented, out);
        const got = d.derived(b, out);
        expect(got === null, why).toBe(want);
        if (got === null) nulls++;
        else (mints++, minted.push(got));
      } else if (minted.length >= 2) {
        // A composition is not charged while it is built: the seal measures it in the request's bytes.
        const [x, y] = [pick(r, minted), pick(r, minted)];
        const before = JSON.stringify(d.declared().charged);
        d.t`${x} and ${y}`;
        expect(JSON.stringify(d.declared().charged), why).toBe(before);
      }
      agree(d, m, consented, why);
    }
    expect(mints, `seed ${seed}: mints`).toBeGreaterThan(0);
    expect(nulls, `seed ${seed}: nulls`).toBeGreaterThan(0);
    // The seal's measure of a body holding what was minted, composed, is the reference's measure of its decoded units.
    const body = { state: { said: minted.slice(0, 6), joined: minted.length >= 2 ? d.t`${minted[0] as ModelText} and ${minted[1] as ModelText}` : d.own("none") } };
    const bytes = JSON.stringify(body);
    const units = refUnits(bytes);
    const fits = [...m.windows.values()].every((w) => !breaks(refReveal(units, linesOfWindow(w)), limitOf(w, consented)));
    let got: Record<string, number> | null = null;
    try {
      got = { ...d.measureSent("test", decodeUnits(bytes).units.map((u) => u.text)).charged };
    } catch (e) {
      if (!(e instanceof LedgerRefused)) throw e;
    }
    expect(got !== null, `seed ${seed}: seal admits exactly when the reference fits`).toBe(fits);
    if (got !== null) for (const w of m.windows.values()) expect(got[w.window.windowId] ?? 0, `seed ${seed}: seal ${w.window.windowId}`).toBe(refReveal(units, linesOfWindow(w)).charged);
  });

  it("the reviewer's three counterexamples, measured on what is said", () => {
    // 1. A 108-character sentence, its uppercase copy and unrelated prose: the sentence reveals both lines whole, and its
    // runs of four or more scalars that the prose lines share; refused when that breaks the prose limit.
    const s1 = "Dana said the staging rotation moves to the Austin office after the March review then back in June ok.";
    const s108 = `${s1}${"x".repeat(108 - s1.length - 1)}.`;
    const prose = "Unrelated prose about the shipment, the invoice and the venue that nobody asked about at all, written out long.";
    const m1 = new ScreenModel();
    m1.apply(snap([text("t0", s108), text("t1", s108.toUpperCase()), text("t2", prose), text("t3", `${prose} Again.`)], { at: 1000, windowId: "w", title: "Notes" }));
    const w1 = m1.windows.get("w") as WindowState;
    const d1 = new Disclosure(m1);
    const want1 = refReveal([[s108]], linesOfWindow(w1));
    expect(want1.charged).toBeGreaterThanOrEqual(216);
    const got1 = d1.candidate(redactWindow(w1), s108);
    expect(got1 === null).toBe(breaks(want1, windowShare(w1)));
    expect(d1.declared().charged.w ?? 0).toBe(got1 === null ? 0 : want1.charged);
    // 2. A consented note and an unconsented chat show the same 110-character sentence: a derivation of it from the note
    // is charged to the chat too, against the chat's own limit.
    const s110 = "Robin asked whether the staging rotation could move to the Austin office after the March review is done".padEnd(109, " x") + ".";
    const m2 = new ScreenModel();
    m2.apply(snap([text("n0", s110), text("n1", "Notes about other things")], { at: 1000, windowId: "note", title: "Note" }));
    m2.apply(snap([text("c0", s110), text("c1", "ok")], { at: 1000, windowId: "chat", title: "Chat" }));
    const chat = m2.windows.get("chat") as WindowState;
    const d2 = new Disclosure(m2, { consented: new Set(["note"]) });
    const b2 = d2.basis(redactWindow(m2.windows.get("note") as WindowState), s110);
    const got2 = b2 === null ? null : d2.derived(b2, s110);
    if (windowShare(chat).budget < 110) {
      expect(got2).toBeNull();
      expect(d2.declared().charged.chat ?? 0).toBe(0);
    } else expect(d2.declared().charged.chat).toBe(110);
    // 3. "Echo Echo" said from a basis "Echo\nEcho" cut from the line "Echo Echo" reveals the whole line, space included.
    const m3 = new ScreenModel();
    m3.apply(snap([text("e0", "Echo Echo"), text("e1", "Other line here")], { at: 1000, windowId: "e", title: "E" }));
    const d3 = new Disclosure(m3);
    const b3 = d3.basis(redactWindow(m3.windows.get("e") as WindowState), "Echo\nEcho");
    expect(b3).not.toBeNull();
    expect(d3.derived(b3!, "Echo Echo")).toBe("Echo Echo");
    // 9 for the line, and 1 for the window's one-letter title "E", a whole source line the text holds (section 4).
    expect(d3.declared().charged.e).toBe(10);
  });

  it.each(Array.from({ length: 20 }, (_, i) => i + 1))("seed %i: the goal inventory's event derivations are charged exactly what they say", (seed) => {
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
    const d = new Disclosure(m);
    let n = 0;
    const found = eventsIn(w, [], macClock(new Date("2026-10-07T10:00:00Z")), "s1", d, () => `v${++n}`);
    expect(found.length, `seed ${seed}: an event`).toBe(1);
    // Exactly what the admitted texts reveal, all of them: the person, the dates, the kind, the title, and any run of four
    // or more scalars they share with the filler lines.
    expect(d.declared().charged.c, `seed ${seed}`).toBe(refReveal(d.admitted().map((t) => [t]), linesOfWindow(redactWindow(w))).charged);
    const revealed = refReveal(d.admitted().map((t) => [t]), [sentence]).positions.length;
    expect(revealed, `seed ${seed}: the sentence's name, date and time at least`).toBeGreaterThanOrEqual(name.length + date.length + time.length);
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
    const d = new Disclosure(registryOf([]));
    const qs: Record<string, ChoiceQuestion> = {};
    for (let q = 0; q < questions; q++) qs[`q${q}`] = { type: "choice", instructions: d.own("Which?"), criteria: { a: d.own("A"), b: d.own("B") } };
    return d.seal({ purpose: "route.judge" as const, state: { task: d.own(`request ${id}` as "request 1") }, questions: qs, snippets: [], charged: {} });
  }
  function writerRequest(id: number): WriterRequest {
    const r = minted({ kind: "plan" as const, disclosureId: "inv", input: { goal: `request ${id}`, snapshots: [FORM] }, maxOutputTokens: 16, signal: new AbortController().signal });
    return r as unknown as WriterRequest;
  }
  /** Another request's text, minted by a Disclosure this request does not have: what a mutation swaps in. */
  const foreign = (id: number): ModelText => new Disclosure(registryOf([])).own(`swapped secret ${id}` as "swapped secret 1");
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

// These provider-shaping tests use fake transports; gateway execution requires an explicit dev opt-in.
// INT1: v2/gate added this to the tests that existed at its base; these reach the gateway route too.
vercelBeforeEach(() => { vercelVi.stubEnv("CARET_DEV_VERCEL_GEMINI", "1"); vercelVi.stubEnv("CARET_RELEASE_HOST", "0"); });
vercelAfterEach(() => vercelVi.unstubAllEnvs());
