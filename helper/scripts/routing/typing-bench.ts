// What routing adds to the helper's work per keystroke inside a write session (D2-02): the same typing session, a
// document being written beside 15 other windows, through a Helper with routing on and one with routing off. Ghost text
// is the host's (KeyType's engine), which this change does not touch; the helper's share of a keystroke is reading the
// reader's snapshot, and with routing on also deriving the routing context. Jev is a stub that answers at once, so only
// the helper's own time is measured.
//
//   node scripts/routing/typing-bench.ts [--keys N] [--out FILE.json]
import { writeStore } from "../../src/privacy/send.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { Helper } from "../../src/helper.ts";
import { Store } from "../../src/store.ts";
import { MemoryStore } from "../../src/patterns/memory.ts";
import { PROTOCOL_VERSION, type AppRef, type Node, type Snapshot } from "../../src/protocol.ts";
import type { AskJev } from "../../src/fill/jev.ts";

const { values: a } = parseArgs({ options: { keys: { type: "string", default: "600" }, out: { type: "string" } } });
const KEYS = Number(a.keys);
const TEXT =
  "Thanks for the notes on the venue. I think the Thursday review can move to the afternoon if Dana agrees. The deposit is due on the twelfth, so we should confirm the head count before then. Let me know what works for the catering order and I will send the final list. ".repeat(4);

const stub: AskJev = async (req) => ({
  model: "stub",
  answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { choice: k === "outcome" ? "write" : "none", confidence: 0.9 }])),
  inputTokens: 0,
  latencyMs: 0,
  costUsd: 0,
});

function background(i: number, at: number): Snapshot {
  const app: AppRef = { pid: 7000 + i, bundleId: `dev.caret.bg${i}`, name: `Background ${i}` };
  const nodes: Node[] = Array.from({ length: 120 }, (_, n) => ({ key: `bg${i}/statictext:line~${n}`, parent: null, role: "AXStaticText", label: `Line ${n} of window ${i}: some text that sits on screen while the user writes elsewhere.` }));
  return { type: "snapshot", v: PROTOCOL_VERSION, seq: 0, at, reason: "initial", app, window: { windowId: `${7000 + i}-1`, kind: "standard", title: `Window ${i}`, frame: [0, 0, 800, 600] }, focused: false, root: null, nodes, values: [], focusedKey: null, stats: { walkMs: 5, visited: nodes.length, truncated: false } };
}

const DOC: AppRef = { pid: 4242, bundleId: "dev.caret.notes", name: "Notes Fixture" };
const BODY = "dev.caret.notes/standard/textarea:body~0";
function doc(value: string, at: number): Snapshot {
  const nodes: Node[] = [{ key: BODY, parent: null, role: "AXTextArea", label: "Body", editable: true, ...(value === "" ? {} : { value }) }];
  return { type: "snapshot", v: PROTOCOL_VERSION, seq: 0, at, reason: "event", app: DOC, window: { windowId: "4242-1", kind: "standard", title: "Plans", frame: [0, 0, 800, 600] }, focused: true, root: null, nodes, values: [], focusedKey: BODY, stats: { walkMs: 5, visited: 1, truncated: false } };
}

async function session(routed: boolean): Promise<{ ms: number[]; routerCalls: number; contexts: number; sameContext: number }> {
  const dir = mkdtempSync(join(tmpdir(), "caret-typing-bench-"));
  const store = new Store(join(dir, "data"));
  const memory = new MemoryStore(join(dir, "data"));
  let at = Date.parse("2026-10-05T10:00:00-05:00");
  let calls = 0;
  const helper = new Helper({
    store,
    memory,
    askJev: async (r) => {
      calls++;
      return stub(r);
    },
    shadow: false,
    allowBackgroundFocus: false,
    publish: () => undefined,
    now: () => at,
    routing: routed ? { hostWrites: () => true, setTimer: (fn, ms) => {
      const t = setTimeout(fn, 0);
      void ms;
      return () => clearTimeout(t);
    } } : null,
  });
  for (let i = 0; i < 15; i++) void helper.handleReader(background(i, at - 60_000 + i));
  void helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at, from: null, to: DOC });
  const ms: number[] = [];
  for (let k = 1; k <= KEYS; k++) {
    at += 180;
    const snap = doc(TEXT.slice(0, k), at);
    const t0 = performance.now();
    void helper.handleReader(snap);
    ms.push(performance.now() - t0);
    if (k % 50 === 0) await helper.routing?.idle();
  }
  await helper.routing?.idle();
  const out = { ms, routerCalls: calls, contexts: helper.routing?.stats.contexts ?? 0, sameContext: helper.routing?.stats.sameContext ?? 0 };
  helper.memory.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  return out;
}

const q = (xs: number[], p: number): number => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
};
// Warm both paths once, then measure each twice, alternating, so neither gets the JIT's warm-up alone.
await session(false);
await session(true);
const runs = { direct: [] as number[], routed: [] as number[] };
let routedInfo = { routerCalls: 0, contexts: 0, sameContext: 0 };
for (let i = 0; i < 2; i++) {
  runs.direct.push(...(await session(false)).ms);
  const r = await session(true);
  runs.routed.push(...r.ms);
  routedInfo = { routerCalls: r.routerCalls, contexts: r.contexts, sameContext: r.sameContext };
}
const summary = {
  keys: KEYS,
  sentences: TEXT.slice(0, KEYS).split(/(?<=[.!?])\s+/).length - 1,
  direct: { p50: q(runs.direct, 0.5), p95: q(runs.direct, 0.95), p99: q(runs.direct, 0.99) },
  routed: { p50: q(runs.routed, 0.5), p95: q(runs.routed, 0.95), p99: q(runs.routed, 0.99) },
  routedSession: routedInfo,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (a.out !== undefined) writeStore(a.out, `${JSON.stringify(summary, null, 2)}\n`);
