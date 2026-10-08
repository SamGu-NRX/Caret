import { beforeEach as vercelBeforeEach, afterEach as vercelAfterEach, vi as vercelVi } from "vitest";
// PV2's three invariants after the second re-review, each as a property over random cases:
// - budget: whatever path reveals a window's text (candidate, descriptor, held, a derivation from a basis, take), what
//   the request's final bytes reveal of the window stays within its limit;
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
import { windowBudget } from "../src/privacy.ts";
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
 * The output ledger's invariant (OUTPUT-LEDGER-SPEC sections 4, 5 and 9), where it is the guarantee: at seal. For
 * random requests built from shared, copied and repeated text, the charge declared for the final bytes is exactly the
 * brute-force reference's measure of their decoded units (test/ledger-reference.ts, which shares only the normalizer),
 * and the seal refuses exactly when that breaks a window's limit.
 */
describe("invariant: what a request's final bytes reveal of a window is exactly what it is charged", () => {
  /** A window's inventory as section 1 collects it from a view: title first, distinct lines. */
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

  const MESSAGES = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };

  /**
   * A desk of windows near their limits: a note, a short chat (its limit is under half of a few lines) and a chat that
   * repeats a sentence and quotes a line. Sentences are shared between windows, and copied in another case or spacing.
   */
  function desk(r: () => number): { m: ScreenModel; lines: Map<string, string[]> } {
    let next = 0;
    const word = (): string => `${pick(r, ["Ka", "lo", "Mi", "ne", "su", "Ta"])}${pick(r, ["ber", "dan", "fel", "gor"])}${next++}`;
    const sentence = (n: number): string => {
      const ws = Array.from({ length: n }, word);
      if (r() < 0.4 && ws.length > 2) ws.push(ws[Math.floor(r() * ws.length)] as string);
      return ws.join(" ");
    };
    const shared = Array.from({ length: 2 }, () => sentence(3 + Math.floor(r() * 10)));
    const m = new ScreenModel();
    const lines = new Map<string, string[]>();
    const put = (id: string, mine: string[], chat: boolean): void => {
      m.apply(snap(mine.map((l, i) => text(`${id}${i}`, l)), { at: 1000, windowId: id, title: `Title ${id}`, ...(chat ? { app: MESSAGES } : {}) }));
      lines.set(id, [...new Set(mine)]);
    };
    const note = [...Array.from({ length: 2 + Math.floor(r() * 3) }, () => sentence(2 + Math.floor(r() * 16))), ...shared.filter(() => r() < 0.7)];
    if (r() < 0.5) note.push((note[0] as string).toUpperCase());
    put("a", note, false);
    put("b", [...Array.from({ length: 1 + Math.floor(r() * 3) }, () => sentence(3 + Math.floor(r() * 8))), ...shared.filter(() => r() < 0.5)], true);
    const said = sentence(4 + Math.floor(r() * 6));
    const chat = [said, sentence(3 + Math.floor(r() * 6)), `> ${said}`, ...shared.filter(() => r() < 0.5)];
    if (r() < 0.5) chat.push(said.split(" ").join("  "));
    put("c", chat, true);
    return { m, lines };
  }

  /**
   * One seed: pieces of 1 to 8 words cut, held or derived from a window's line, many of them under 12 scalars and so
   * uncharged when minted, and compositions that join a line's consecutive pieces back into a longer run; then the
   * seal's measure of a body that holds them, against the reference's.
   */
  function runSeed(seed: number): { fits: boolean; want: { id: string; charged: number; limit: number }[]; got: Record<string, number> | null } {
    const r = rng(seed * 7);
    const { m, lines } = desk(r);
    const d = new Disclosure(m);
    const views = new Map([...m.windows.values()].map((w) => [w.window.windowId, redactWindow(w)]));
    const said: ModelText[] = [];
    for (let step = 0; step < 12; step++) {
      const id = pick(r, [...lines.keys()]);
      const view = views.get(id) as WindowState;
      const ws = pick(r, linesOfWindow(view).slice(1)).split(" ");
      const a = Math.floor(r() * ws.length);
      const run = ws.slice(a, Math.min(ws.length, a + 1 + Math.floor(r() * 8)));
      const path = pick(r, ["candidate", "held", "derived", "joined"] as const);
      let got: ModelText | null = null;
      if (path === "candidate") got = d.candidate(view, run.join(" "));
      else if (path === "held") got = d.held(view, run.join(" "));
      else if (path === "derived") {
        const b = d.basis(view, run.join(" "));
        if (b !== null) got = d.derived(b, run.map((w) => (r() < 0.3 ? w.toUpperCase() : w)).join(r() < 0.3 ? "  " : " "));
      } else {
        // Each word minted on its own, then joined in order: the join is measured only at seal.
        const parts = run.map((w) => d.candidate(view, w));
        if (parts.every((x): x is ModelText => x !== null)) got = parts.slice(1).reduce((acc, x) => d.t`${acc} ${x}`, parts[0] as ModelText);
      }
      if (got !== null) said.push(got);
    }
    const bytes = JSON.stringify({ state: { said } });
    const units = refUnits(bytes);
    const want = [...m.windows.values()].map((w) => ({ id: w.window.windowId, charged: refReveal(units, linesOfWindow(redactWindow(w))).charged, limit: windowBudget(w) }));
    let got: Record<string, number> | null = null;
    try {
      got = { ...d.measureSent("test", decodeUnits(bytes).units.map((u) => u.text)).charged };
    } catch (e) {
      if (!(e instanceof LedgerRefused)) throw e;
    }
    return { fits: want.every((w) => w.charged <= w.limit), want, got };
  }

  it.each(Array.from({ length: 80 }, (_, i) => i + 1))("seed %i: cuts, derivations and compositions across shared, copied and repeated text", (seed) => {
    const { fits, want, got } = runSeed(seed);
    expect(got !== null, `seed ${seed}: the seal admits exactly when the reference fits`).toBe(fits);
    if (got !== null) for (const w of want) expect(got[w.id] ?? 0, `seed ${seed}: ${w.id}`).toBe(w.charged);
  });

  // 34 of the 80 refuse, every one for a chat, mostly where joined words rebuild a run their pieces were too short to count.
  it("refuses a fair share of those seeds, so both sides of the invariant are exercised", () => {
    const refused = Array.from({ length: 80 }, (_, i) => runSeed(i + 1)).filter((x) => !x.fits).length;
    expect(refused).toBeGreaterThanOrEqual(20);
    expect(refused).toBeLessThanOrEqual(60);
  });

  it("a basis cut twice from 'Echo Echo', said as 'Echo Echo', reveals the whole line", () => {
    const m = new ScreenModel();
    m.apply(snap([text("e0", "Echo Echo"), text("e1", "Other line here")], { at: 1000, windowId: "e", title: "E" }));
    const d = new Disclosure(m);
    const b = d.basis(redactWindow(m.windows.get("e") as WindowState), "Echo\nEcho");
    expect(b).not.toBeNull();
    expect(d.derived(b!, "Echo Echo")).toBe("Echo Echo");
    // 9 for the line, and 1 for the window's one-letter title "E", a whole line the text holds.
    expect(d.declared().charged.e).toBe(10);
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
