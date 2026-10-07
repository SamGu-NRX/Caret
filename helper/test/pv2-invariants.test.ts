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
import { makeJevClient, jevSettings, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import { DailySpend } from "../src/engines/decide/daily-cap.ts";
import { llamaEngine } from "../src/engines/decide/llama.ts";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { cachedAsk } from "../src/engines/decide/cache.ts";
import type { Node, Snapshot } from "../src/protocol.ts";
import { snap, text } from "./builders.ts";
import { rng } from "./large-scene.ts";

const dir = mkdtempSync(join(tmpdir(), "pv2-inv-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const words = (s: string): { w: string; at: number }[] => [...s.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ w: m[0], at: m.index }));

describe("invariant: a window's prose share and budget hold whatever path reveals its text", () => {
  /**
   * What a set of texts shows of a line, measured on its own: each maximal run of a text's words that stands in the line
   * (case aside) covers where it stands. The lines' words are all distinct, so a run stands in one place only.
   */
  function covered(line: string, texts: readonly string[]): number {
    const hit = new Uint8Array(line.length);
    const lower = line.toLowerCase();
    for (const t of texts) {
      const ws = words(t);
      for (let i = 0; i < ws.length; ) {
        let j = ws.length - 1;
        let at = -1;
        for (; j >= i; j--) {
          const run = t.slice((ws[i] as { at: number }).at, (ws[j] as { at: number; w: string }).at + (ws[j] as { w: string }).w.length).toLowerCase();
          at = lower.indexOf(run);
          if (at >= 0 && (at === 0 || !/[\p{L}\p{N}]/u.test(lower[at - 1] as string)) && !/[\p{L}\p{N}]/u.test(lower[at + run.length] ?? " ")) {
            hit.fill(1, at, at + run.length);
            break;
          }
          at = -1;
        }
        i = at < 0 ? i + 1 : j + 1;
      }
    }
    return hit.reduce((n, b) => n + b, 0);
  }

  it.each(Array.from({ length: 40 }, (_, i) => i + 1))("seed %i", (seed) => {
    const r = rng(seed);
    let next = 0;
    const word = (): string => `${pick(r, ["ka", "lo", "mi", "ne", "su", "ta", "vo", "ri"])}${pick(r, ["ber", "dan", "fel", "gor", "hin", "jun", "kel", "mor"])}${next++}`;
    const lines = Array.from({ length: 2 + Math.floor(r() * 5) }, () => Array.from({ length: r() < 0.5 ? 2 + Math.floor(r() * 3) : 14 + Math.floor(r() * 8) }, word).join(" "));
    const m = new ScreenModel();
    m.apply(snap(lines.map((l, i) => text(`t${i}`, l)), { at: 1000, windowId: "w", title: "Notes" }));
    const w = m.windows.get("w") as WindowState;
    const view = redactWindow(w);
    const d = new Disclosure(m.windows.values());
    const sent: string[] = [];
    const span = (min = 1): string => {
      const ws = words(pick(r, lines)).map((x) => x.w);
      const a = Math.floor(r() * ws.length);
      const b = Math.min(ws.length, a + min + Math.floor(r() * 10));
      return ws.slice(a, b).join(" ");
    };
    for (let step = 0; step < 60; step++) {
      const path = pick(r, ["candidate", "descriptor", "held", "derived", "take"] as const);
      if (path === "derived") {
        const basis = span(3);
        const b = d.basis(view, basis);
        if (b === null) continue;
        const ws = basis.split(" ");
        const textOut = r() < 0.3 ? basis : ws.filter(() => r() < 0.6).join(" ");
        if (textOut === "") continue;
        const got = d.derived(b, textOut);
        if (got !== null) sent.push(got);
      } else if (path === "take") {
        const t = `${span()} ${span()}`;
        if (d.take(view, "candidate", [t])) sent.push(t);
      } else {
        const t = span();
        const got = path === "candidate" ? d.candidate(view, t) : path === "descriptor" ? d.descriptor(view, t) : d.held(view, t);
        if (got !== null) sent.push(got);
      }
      const share = windowShare(w);
      const prose = lines.filter((l) => l.length > 80).reduce((n, l) => n + covered(l, sent), 0);
      const all = lines.reduce((n, l) => n + covered(l, sent), 0);
      if (share.prose !== null) expect(prose, `seed ${seed} step ${step}: prose`).toBeLessThanOrEqual(share.prose);
      expect(all, `seed ${seed} step ${step}: window`).toBeLessThanOrEqual(share.budget);
    }
  });

  it("charges a repeat at another occurrence each time, and a basis's prefix of a prose line as that line's prose", () => {
    // Short lines beside the prose give the window a budget well past the prose line's share, so only the share stops it.
    const cards = Array.from({ length: 12 }, (_, i) => text(`c${i}`, `Card line ${i}: value ${i}`));
    const alphas = Array(20).fill("alpha").join(" ");
    const m = new ScreenModel();
    m.apply(snap([text("t0", alphas), ...cards], { at: 1000, windowId: "w" }));
    const v = redactWindow(m.windows.get("w") as WindowState);
    const d = new Disclosure(m.windows.values());
    const b = d.basis(v, alphas);
    expect(d.derived(b!, Array(12).fill("alpha").join(" "))).toBeNull();
    // The reviewer's case: the first 78 characters of a 95-character prose line, from a basis of that prefix.
    const line = "Dana says the staging rotation moves to Austin after the March review, and back in June, again.";
    expect(line.length).toBe(95);
    const m2 = new ScreenModel();
    m2.apply(snap([text("t0", line), ...cards], { at: 1000, windowId: "w" }));
    const v2 = redactWindow(m2.windows.get("w") as WindowState);
    const d2 = new Disclosure(m2.windows.values());
    const prefix = line.slice(0, 78);
    expect(d2.derived(d2.basis(v2, prefix)!, prefix)).toBeNull();
  });
});

describe("invariant: nothing inside an excluded node keeps a value", () => {
  const ROLES = ["AXGroup", "AXTextField", "AXStaticText", "AXCell", "AXList", "AXWindow", "AXWebArea", "AXScrollArea", "AXApplication", "AXSplitGroup", "AXBrowser", "AXSheet", "AXDrawer", "AXSecureTextField"];

  function tree(r: () => number, n: number): Node[] {
    const out: Node[] = [];
    for (let i = 0; i < n; i++) {
      const parent = i === 0 ? null : `n${Math.floor(r() * i)}`;
      const mark = r();
      out.push({ key: `n${i}`, parent, role: pick(r, ROLES), label: `node ${i}`, value: `value of node ${i}`, ...(r() < 0.5 ? { editable: true } : {}), ...(mark < 0.08 ? { states: ["secure" as const] } : mark < 0.12 ? { excluded: "password" as const } : {}) });
    }
    return out;
  }

  function check(m: ScreenModel, seed: number, step: number): void {
    const w = m.windows.get("w") as WindowState;
    const excludedAbove = (n: Node): boolean => {
      const seen = new Set<string>();
      for (let p = n.parent === null ? undefined : w.nodes.get(n.parent); p !== undefined && !seen.has(p.key); p = p.parent === null ? undefined : w.nodes.get(p.parent)) {
        seen.add(p.key);
        if (p.excluded !== undefined || p.states?.includes("secure") === true || p.role === "AXSecureTextField") return true;
      }
      return false;
    };
    for (const n of w.nodes.values()) {
      if (!excludedAbove(n)) continue;
      expect(n.value, `seed ${seed} step ${step}: ${n.key}`).toBeUndefined();
      expect(w.values.some((v) => v.nodeKey === n.key), `seed ${seed} step ${step}: typed value of ${n.key}`).toBe(false);
    }
  }

  it.each(Array.from({ length: 60 }, (_, i) => i + 1))("seed %i, merged across random cut and partial walks", (seed) => {
    const r = rng(seed * 7919);
    const nodes = tree(r, 8 + Math.floor(r() * 25));
    const values = nodes.filter(() => r() < 0.4).map((n) => ({ kind: "email" as const, text: `${n.key}@example.test`, nodeKey: n.key }));
    const valued = nodes.map((n) => {
      const v = values.find((x) => x.nodeKey === n.key);
      return v === undefined ? n : { ...n, value: `${n.value} ${v.text}` };
    });
    const m = new ScreenModel();
    m.apply(snap(valued, { at: 1000, windowId: "w", values }));
    check(m, seed, 0);
    for (let step = 1; step <= 6; step++) {
      // A cut walk: some nodes again, a mark flipped on some of them; or a partial walk from a random root.
      const sent = valued.filter(() => r() < 0.5).map((n) => (r() < 0.25 ? { ...n, states: ["secure" as const] } : r() < 0.1 ? { ...n, editable: true as const, states: ["secure" as const] } : n));
      const at = 1000 + step * 100;
      const s: Snapshot = r() < 0.6
        ? { ...snap(sent, { at, windowId: "w", values: values.filter((v) => sent.some((n) => n.key === v.nodeKey)) }), stats: { walkMs: 5, visited: sent.length, truncated: true } }
        : snap(sent.filter((n) => n.parent !== null), { at, windowId: "w", root: pick(r, valued).key, values: [] });
      m.apply(s);
      check(m, seed, step);
    }
  });
});

describe("invariant: no request built before a switch-off reaches a transport or a store", () => {
  /** A request whose one own text names it, so the transport can tell which request it carries. */
  function request(id: number): JevRequest {
    const d = new Disclosure([]);
    const name = `request ${id}` as "request 1";
    return d.seal({ purpose: "route.judge" as const, state: { task: d.own(name) }, questions: { q: { type: "choice" as const, instructions: d.own("Which?"), criteria: { a: d.own("A"), b: d.own("B") } } }, snippets: [], charged: {} });
  }
  const idOf = (body: string): number => Number(/request (\d+)/u.exec(body)?.[1] ?? "-1");
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it.each(Array.from({ length: 25 }, (_, i) => i + 1))("seed %i: random builds, queueing, 429 retries, store writes and switch-offs", async (seed) => {
    const r = rng(seed * 104729);
    let generation = 0;
    const builtAt = new Map<number, number>();
    const reached: { id: number; generation: number; where: string }[] = [];
    // The transport: Jev's (answering 429 first, at random) and llama-server's; each records what reaches it.
    const jevFetch: typeof fetch = async (_u, init) => {
      const id = idOf(String(init?.body));
      reached.push({ id, generation, where: "jev" });
      await tick();
      if (r() < 0.4) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ model: "jev-test", answers: { q: { choice: "a", confidence: 0.9 } }, usage: { input_tokens: 1 } }), { status: 200 });
    };
    const client = makeJevClient(() => "k", 10_000, new DailySpend({ dir: join(dir, `cap-${seed}`), capUsd: 100 }), jevSettings({}), jevFetch);
    const llamaFetch = (async (_u: string, init?: RequestInit) => {
      reached.push({ id: idOf(String(init?.body)), generation, where: "llama" });
      await tick();
      return new Response(JSON.stringify({ completion_probabilities: [{ top_logprobs: [{ token: "A", logprob: 0 }] }], timings: { prompt_n: 1 } }), { status: 200 });
    }) as typeof fetch;
    const llama = llamaEngine({ url: "http://127.0.0.1:1", model: "m", prompt: "document", fetchImpl: llamaFetch });
    const slow: AskJev = async (req) => {
      await tick();
      return { model: "x", answers: { q: { choice: "a", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    const log = join(dir, `log-${seed}.ndjson`);
    const harness = harnessEngine({ name: "canned", canned: slow, fixture: { windows: () => true, memory: true, plan: true }, logRequests: log });
    const cacheDir = join(dir, `cache-${seed}`);
    const cache = cachedAsk(slow, { dir: cacheDir, mode: "record", engine: "jev", model: "m", fixture: { windows: () => true, memory: true, plan: true }, env: {} });
    const inflight: Promise<unknown>[] = [];
    let refused = 0;
    const logLines = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : []);
    const cacheFiles = (): string[] => (existsSync(cacheDir) ? readdirSync(cacheDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => join(e.parentPath, e.name)) : []);
    // What the stores held at each switch-off: anything written after it must be of a request built after it.
    const marks: { generation: number; log: number; cache: Set<string> }[] = [];
    for (let step = 0, id = 0; step < 30; step++) {
      const op = r();
      if (op < 0.15) {
        noteSwitchedOff();
        generation++;
        marks.push({ generation, log: logLines().length, cache: new Set(cacheFiles()) });
      } else {
        const req = request(++id);
        builtAt.set(id, generation);
        const send = pick(r, [client, llama.ask, harness.ask, cache]);
        // A refusal, or a second 429 the client gives up on, is an outcome; what matters is what reached the transport.
        inflight.push(send(req).catch((e: unknown) => (refused += e instanceof UnmintedText ? 1 : 0)));
      }
      if (r() < 0.5) await tick();
    }
    await Promise.all(inflight);
    void refused;
    for (const x of reached) expect(x.generation, `seed ${seed}: request ${x.id} reached ${x.where} after a switch-off`).toBe(builtAt.get(x.id));
    // The stores: a log line past a switch-off's count, or a cache entry absent at a switch-off, was written after it.
    logLines().forEach((l, i) => {
      const after = marks.filter((k) => k.log <= i).at(-1);
      if (after !== undefined) expect(builtAt.get(idOf(l)), `seed ${seed}: log line ${i} written after switch-off ${after.generation}`).toBeGreaterThanOrEqual(after.generation);
    });
    for (const f of cacheFiles()) {
      const after = marks.filter((k) => !k.cache.has(f)).at(-1);
      if (after !== undefined) expect(builtAt.get(idOf(readFileSync(f, "utf8"))), `seed ${seed}: cache entry written after switch-off ${after.generation}`).toBeGreaterThanOrEqual(after.generation);
    }
  });
});
