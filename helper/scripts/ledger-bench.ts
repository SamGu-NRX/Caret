// Times the SnippetLedger (src/privacy.ts) on a screen of eight windows of 5,000 lines each, the
// screen B13's review measured at 20 to 25 ms for a ledger's first take.
//
//   node --expose-gc scripts/ledger-bench.ts --out DIR [--rounds N] [--modes cold,same]
//
// Per round the screen is put in one of five states before a new ledger takes 40 texts (lines,
// names that several windows show, and values quoted inside longer lines), each from the window
// that shows it:
// - cold: eight windows the helper has never seen, under new window ids.
// - rewalk: every window arrives again as a full walk with new node objects and the same text.
// - changed (walk): one window arrives again as a full walk with one line changed.
// - changed (partial): one window arrives as a partial snapshot of the one node that changed.
// - same: nothing changed since the last round's ledger.
// For each it records the wall and thread-CPU time of the new ledger's first take (what a request's
// first charge holds the event loop for) and of all 40 takes. Like the helper, the bench reads each
// window's line table as its snapshot arrives (privacy.ts readWindow), and records that per snapshot
// too, since it holds the event loop then; --no-arrival leaves it to the ledger, as B13 did. Snapshots go through JSON.parse first,
// as they do off the reader's socket, so their strings are flat as in the helper. Writes results.json
// and summary.md.
// Every text is invented.
import { Disclosure } from "../src/privacy/disclosure.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { positiveInt } from "./flags.ts";
import { ScreenModel, type WindowState } from "../src/model.ts";
import type { AppRef, Node, Snapshot } from "../src/protocol.ts";
import * as privacy from "../src/privacy.ts";
import { rng } from "../test/large-scene.ts";
import { snap } from "../test/builders.ts";

const { values: a } = parseArgs({ options: { out: { type: "string" }, rounds: { type: "string", default: "60" }, modes: { type: "string" }, "no-arrival": { type: "boolean", default: false } } });
if (a.out === undefined) throw new Error("--out is required");
const OUT = a.out;
const ROUNDS = positiveInt("rounds", a.rounds);
mkdirSync(OUT, { recursive: true });

const WINDOWS = 8;
const LINES = 5000;
const FIRST = ["Ines", "Tomas", "Priya", "Dana", "Kofi", "Mirela", "Aiko", "Bram", "Lucia", "Oren", "Sefa", "Wren"];
const LAST = ["Okafor", "Lindqvist", "Raman", "Whitfield", "Mensah", "Vasquez", "Tanaka", "Dekker", "Moreau", "Halevi"];
const WORDS = ["venue", "deposit", "invoice", "schedule", "draft", "review", "budget", "shipment", "catering", "renewal", "agenda", "quote", "receipt", "booking"];

const r = rng(14);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const phrase = (k: number): string => Array.from({ length: k }, () => pick(WORDS)).join(" ");
const person = (): string => `${pick(FIRST)} ${pick(LAST)}`;
const email = (p: string, i: number): string => `${p.toLowerCase().replace(" ", ".")}${i}@example.org`;

/** Each window's lines: even windows are chats (Messages, so conversations), odd ones notes. */
const lines: string[][] = Array.from({ length: WINDOWS }, (_, w) =>
  Array.from({ length: LINES }, (_, i) => {
    switch (i % 4) {
      case 0:
        return person();
      case 1:
        return `${phrase(5)} ${w}-${i}`;
      case 2:
        return `write to ${email(person(), i)} about the ${pick(WORDS)}`;
      default:
        return `${phrase(3)}, ${phrase(4)} at ${(i % 12) + 1}:${String(i % 60).padStart(2, "0")} PM`;
    }
  }),
);
const appOf = (w: number): AppRef =>
  w % 2 === 0 ? { pid: 7000 + w, bundleId: "com.apple.MobileSMS", name: "Messages" } : { pid: 7000 + w, bundleId: "dev.caret.notes", name: "Notes" };
const nodesOf = (w: number, ls: readonly string[]): Node[] => ls.map((l, i) => ({ key: `w${w}/text~${i}`, parent: null, role: "AXStaticText", label: l }));
let at = 1_000_000;
/** The id prefix of the screen's windows; cold rounds start a new one. */
let screen = "win";
const parsed = (s: Snapshot): Snapshot => JSON.parse(JSON.stringify(s)) as Snapshot;
const walk = (w: number): Snapshot => parsed(snap(nodesOf(w, lines[w] as string[]), { at: ++at, windowId: `${screen}-${w}`, title: `Window ${w}`, app: appOf(w) }));

/** 40 texts: 20 whole lines, 10 names, 10 email addresses quoted inside lines, each with its window. */
const texts: { w: number; t: string }[] = [];
for (let k = 0; k < 20; k++) {
  const w = k % WINDOWS;
  texts.push({ w, t: (lines[w] as string[])[(k * 211 + 1) % LINES] as string });
}
for (let k = 0; k < 10; k++) {
  const w = (k * 3) % WINDOWS;
  texts.push({ w, t: (lines[w] as string[])[k * 400] as string });
}
for (let k = 0; k < 10; k++) {
  const w = (k * 5) % WINDOWS;
  const line = (lines[w] as string[])[k * 400 + 2] as string;
  texts.push({ w, t: line.split(" ")[2] as string });
}

/** The B13 ledger (bb2b1fb) has no readWindow; there the bench's arrival reading does nothing. */
const readAtArrival = !a["no-arrival"] && "readWindow" in privacy;
const arrivals: number[] = [];
const model = new ScreenModel();
const apply = (s: Snapshot): void => {
  model.apply(s);
  if (!readAtArrival) return;
  const t0 = performance.now();
  (privacy as unknown as { readWindow: (w: WindowState) => void }).readWindow(model.windows.get(s.window.windowId) as WindowState);
  arrivals.push(performance.now() - t0);
};
for (let w = 0; w < WINDOWS; w++) apply(walk(w));

const collect = (): void => (globalThis as { gc?: () => void }).gc?.();
const quant = (xs: number[]): { p50: number; p95: number; max: number; n: number } => {
  const s = [...xs].sort((x, y) => x - y);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const rd = (x: number): number => Math.round(x * 100) / 100;
  return { p50: rd(q(0.5)), p95: rd(q(0.95)), max: rd(s.at(-1) ?? 0), n: s.length };
};

type Mode = "cold" | "rewalk" | "changed (walk)" | "changed (partial)" | "same";
let edit = 0;
let screens = 0;
/** Snapshots built before the timed part, so building and parsing them is not timed. */
function prepare(mode: Mode): void {
  if (mode === "same") return;
  if (mode === "cold") {
    for (let w = 0; w < WINDOWS; w++) model.close(`${screen}-${w}`, ++at);
    screen = `cold${++screens}`;
    for (let w = 0; w < WINDOWS; w++) apply(walk(w));
    return;
  }
  if (mode === "rewalk") {
    for (let w = 0; w < WINDOWS; w++) apply(walk(w));
    return;
  }
  const w = edit % WINDOWS;
  const i = 4 * ((edit * 37) % (LINES / 4)) + 1;
  edit++;
  const ls = lines[w] as string[];
  ls[i] = `${phrase(5)} edit ${edit}`;
  if (mode === "changed (walk)") apply(walk(w));
  else apply(parsed(snap([{ key: `w${w}/text~${i}`, parent: null, role: "AXStaticText", label: ls[i] as string }], { at: ++at, windowId: `${screen}-${w}`, title: `Window ${w}`, app: appOf(w), root: `w${w}/text~${i}` })));
}

interface Row {
  mode: Mode;
  firstWallMs: ReturnType<typeof quant>;
  firstCpuMs: ReturnType<typeof quant>;
  allWallMs: ReturnType<typeof quant>;
  allCpuMs: ReturnType<typeof quant>;
  taken: number;
  arrivalMs: ReturnType<typeof quant> | null;
}

function run(mode: Mode): Row {
  const firstWall: number[] = [];
  const firstCpu: number[] = [];
  const allWall: number[] = [];
  const allCpu: number[] = [];
  let taken = 0;
  const arrivalsBefore = arrivals.length;
  // One untimed round, so "same" starts from a screen a ledger has read.
  for (let round = -1; round < ROUNDS; round++) {
    if (round === 0) arrivals.length = arrivalsBefore;
    prepare(mode);
    collect();
    const states = new Map([...model.windows].map(([id, w]) => [id, w] as const));
    const c0 = process.threadCpuUsage();
    const t0 = performance.now();
    const ledger = new Disclosure(model.windows.values());
    let ok = 0;
    for (let k = 0; k < texts.length; k++) {
      const { w, t } = texts[k] as { w: number; t: string };
      if (ledger.take(states.get(`${screen}-${w}`) as WindowState, "candidate", [t])) ok++;
      if (k === 0) {
        const c = process.threadCpuUsage(c0);
        if (round >= 0) {
          firstWall.push(performance.now() - t0);
          firstCpu.push((c.user + c.system) / 1000);
        }
      }
    }
    const c = process.threadCpuUsage(c0);
    if (round >= 0) {
      allWall.push(performance.now() - t0);
      allCpu.push((c.user + c.system) / 1000);
      taken = ok;
    }
  }
  const arrived = arrivals.slice(arrivalsBefore);
  return { mode, firstWallMs: quant(firstWall), firstCpuMs: quant(firstCpu), allWallMs: quant(allWall), allCpuMs: quant(allCpu), taken, arrivalMs: arrived.length === 0 ? null : quant(arrived) };
}

const load = loadavg();
const rows: Row[] = [];
const MODES: readonly Mode[] = ["cold", "rewalk", "changed (walk)", "changed (partial)", "same"];
const chosen = a.modes === undefined ? MODES : a.modes.split(",").map((m) => {
  const mode = MODES.find((x) => x === m);
  if (mode === undefined) throw new Error(`unknown mode ${m}; the modes are ${MODES.join(", ")}`);
  return mode;
});
for (const mode of chosen) {
  const row = run(mode);
  rows.push(row);
  process.stdout.write(`${mode}: first take p50 ${row.firstWallMs.p50} p95 ${row.firstWallMs.p95} max ${row.firstWallMs.max} ms; 40 takes p95 ${row.allWallMs.p95} ms; arrival p95 ${row.arrivalMs?.p95 ?? "-"} max ${row.arrivalMs?.max ?? "-"} ms\n`);
}
const loadAfter = loadavg();
writeFileSync(join(OUT, "results.json"), `${JSON.stringify({ at: new Date().toISOString(), rounds: ROUNDS, windows: WINDOWS, lines: LINES, loadavg: { before: load, after: loadAfter }, rows }, null, 2)}\n`);
const md = [
  "# Disclosure on eight windows of 5,000 lines",
  "",
  `\`node ${(globalThis as { gc?: unknown }).gc === undefined ? "" : "--expose-gc "}scripts/ledger-bench.ts --out DIR --rounds ${ROUNDS}\` in the helper, ${new Date().toISOString().slice(0, 16)}Z, one-minute load average ${load[0]?.toFixed(1)} before and ${loadAfter[0]?.toFixed(1)} after (this Mac was shared). ${ROUNDS} rounds per row; four of the windows are Messages chats. ${readAtArrival ? "Each window's line table was read as its snapshot arrived; *Arrival* is that, per snapshot." : "No line table was read at arrival."}`,
  "",
  "| Screen before the ledger | First take wall p50 / p95 / max ms | First take CPU p50 / p95 / max ms | 40 takes wall p50 / p95 / max ms | 40 takes CPU p95 ms | Taken | Arrival p50 / p95 / max ms |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...rows.map(
    (x) =>
      `| ${x.mode} | ${x.firstWallMs.p50} / ${x.firstWallMs.p95} / ${x.firstWallMs.max} | ${x.firstCpuMs.p50} / ${x.firstCpuMs.p95} / ${x.firstCpuMs.max} | ${x.allWallMs.p50} / ${x.allWallMs.p95} / ${x.allWallMs.max} | ${x.allCpuMs.p95} | ${x.taken} / ${texts.length} | ${x.arrivalMs === null ? "-" : `${x.arrivalMs.p50} / ${x.arrivalMs.p95} / ${x.arrivalMs.max}`} |`,
  ),
  "",
];
writeFileSync(join(OUT, "summary.md"), md.join("\n"));
