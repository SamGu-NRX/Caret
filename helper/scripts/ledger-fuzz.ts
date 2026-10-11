// The output ledger's consistency check (scripts/ledger-fuzz-cases.ts) over the full seeded set, written to a findings
// file; the suite runs a fixed-seed sample of it (test/ledger-fuzz.test.ts). Fixture data only: no Jev, no network.
//
//   node scripts/ledger-fuzz.ts --seed 20261008 --cases 2400 --out findings.json [--from <i>] [--only <i,...>] [--dump 1]
//   node scripts/ledger-fuzz.ts --replay desk.json --out findings.json
//   node scripts/ledger-fuzz.ts --minimize <case> --window <id> --out min.json   (greedy reduction of a flagged case)
import { readFileSync } from "node:fs";
import { writeStoreJson } from "../src/privacy/send.ts";
import { caseSeed, makeDesk, runCase, runFuzz, type CaseResult, type Desk } from "./ledger-fuzz-cases.ts";

type WinSpec = Desk["windows"][number];
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/u, ""), process.argv[i + 1]!);
const SEED = Number(args.get("seed") ?? "20261008");
const CASES = Number(args.get("cases") ?? "2400");
const FROM = Number(args.get("from") ?? "0");
const OUT = args.get("out") ?? "ledger-fuzz-findings.json";
const ONLY = args.get("only")?.split(",").map(Number) ?? null;
const REPLAY = args.get("replay") ?? null;

// --minimize <case> --window <id>: greedy reduction of one flagged case's desk while the same window stays flagged.
if (args.has("minimize")) {
  const i = Number(args.get("minimize"));
  const win = args.get("window")!;
  let desk: Desk = makeDesk(caseSeed(SEED, i));
  const flags = async (d: Desk): Promise<CaseResult | null> => {
    try {
      const res = await runCase(i, JSON.parse(JSON.stringify(d)) as Desk);
      return res.flagged.some((f) => f.windowId === win) ? res : null;
    } catch {
      return null;
    }
  };
  if ((await flags(desk)) === null) throw new Error(`case ${i} does not flag ${win}`);
  const tries = (d: Desk): Desk[] => {
    const out: Desk[] = [];
    const clone = (): Desk => JSON.parse(JSON.stringify(d)) as Desk;
    if (d.event !== null) out.push({ ...clone(), event: null });
    if (d.mode === "scope") out.push({ ...clone(), mode: "focus" });
    if (d.whose) out.push({ ...clone(), whose: false });
    d.windows.forEach((w, wi) => {
      if (w.windowId === d.form.windowId || w.windowId === win || (d.tab !== null && w.windowId === d.tab.windowId)) return;
      const x = clone();
      x.windows.splice(wi, 1);
      out.push(x);
    });
    const shrinkNodes = (get: (x: Desk) => WinSpec | undefined): void => {
      const w = get(d);
      if (w === undefined) return;
      w.nodes.forEach((n, ni) => {
        const x = clone();
        const xw = get(x)!;
        xw.nodes.splice(ni, 1);
        xw.values = xw.values.filter((v) => v.nodeKey !== n.key);
        out.push(x);
        const text = n.label ?? n.value ?? "";
        const parts = text.split(/(\r\n|\r|\n)/u);
        for (let k = 0; k < parts.length; k += 2) {
          if (parts.length < 3) break;
          const y = clone();
          const yn = get(y)!.nodes[ni]!;
          const kept = [...parts];
          kept.splice(k === 0 ? 0 : k - 1, 2);
          const t = kept.join("");
          if (yn.label !== undefined) yn.label = t;
          else yn.value = t;
          out.push(y);
        }
      });
    };
    for (const w of d.windows) shrinkNodes((x) => x.windows.find((y) => y.windowId === w.windowId && y.nodes.length > 0 && y.windowId !== x.form.windowId));
    if (d.event !== null && d.event.ev.type !== "close") shrinkNodes((x) => (x.event !== null && x.event.ev.type !== "close" ? x.event.ev.win : undefined));
    if (d.tab !== null) d.tab.blocks.forEach((_, bi) => {
      const x = clone();
      x.tab!.blocks.splice(bi, 1);
      out.push(x);
    });
    // A field goes with its control's children (a menu's items, a group's buttons); a box goes alone.
    if (d.form.keys.length > 1) d.form.keys.forEach((key, fi) => {
      const x = clone();
      x.form.keys.splice(fi, 1);
      x.form.labels.splice(fi, 1);
      const f = x.windows.find((w) => w.windowId === x.form.windowId)!;
      f.nodes = f.nodes.filter((n) => n.key !== key && n.parent !== key);
      out.push(x);
    });
    return out;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of tries(desk)) {
      if ((await flags(t)) !== null) {
        desk = t;
        changed = true;
        break;
      }
    }
  }
  const res = (await flags(desk))!;
  writeStoreJson(OUT, { case: i, window: win, desk, result: res }, 1);
  console.log(JSON.stringify({ case: i, flagged: res.flagged, requests: res.requests }));
  process.exit(0);
}

const run = await runFuzz({
  seed: SEED,
  cases: ONLY ?? Array.from({ length: CASES }, (_, k) => FROM + k),
  dump: args.has("dump"),
  ...(REPLAY === null ? {} : { replay: JSON.parse(readFileSync(REPLAY, "utf8")) as Desk }),
});
const { summary, results, desks } = run;
writeStoreJson(OUT, { summary, gaps: results.filter((r) => (r.gaps?.length ?? 0) > 0).map((r) => ({ case: r.case, mode: r.mode, event: r.event, gaps: r.gaps })), flagged: results.filter((r) => r.flagged.length > 0 || args.has("dump")), desks, errors: results.filter((r) => r.error !== undefined).map((r) => ({ case: r.case, error: r.error })), all: results.map((r) => ({ case: r.case, mode: r.mode, event: r.event, sent: r.requests.filter((x) => x.ok).length, refused: r.requests.filter((x) => !x.ok).length, flagged: r.flagged.length, ...(r.inventoryMismatch.length > 0 ? { inventoryMismatch: r.inventoryMismatch } : {}) })) }, 1);
console.log(JSON.stringify(summary));
