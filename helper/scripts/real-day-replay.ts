// What the shadow logger's real days say about routines and loops (B21 part 5), read only, counts and hashes only.
//
//   node scripts/real-day-replay.ts --data-dir DIR --out FILE.md [--json FILE] [--pmset-log FILE | --no-activity]
//
// The live stores are never opened: `sqlite3` makes read-only backups of screen.sqlite and memory.sqlite into a
// private temp directory, which is read and then deleted, as scripts/shadow-report.ts does. Nothing is written
// back, and no value, label or text is read: transfers are stored as keyed hashes, and of the memory store only
// routine rows' counts and step counts and the decision log's reasons are read.
//
// Three views, because the store keeps hashes, not the structure the recognizers read:
//   1. The live recognizer's own records (memory.sqlite routine rows): what the shadow helper's routine
//      recognizer counted while it ran, with real element templates. That helper is the build deployed on
//      2026-10-02, older than this code.
//   2. A replay of the transfer log through this code's RoutineRecognizer. A stored transfer has its source and
//      destination element keys only as hashes, so a hash stands in for each element's template and every
//      position is 0. "strict" keeps the source element's hash in the shape; "loose" drops it and keeps the
//      source's app, window kind and part. Neither bounds the live count from one side: a key hash keeps the
//      row ordinal a template drops, so strict splits a repeated routine into several (fewer repeats) and can
//      also make one field filled from two list rows into two shapes, a routine the live recognizer would not
//      see (B21 review); loose merges sources the live recognizer keeps apart. A destination window is one app
//      and window kind until 120 s pass with no transfer (the recognizer's own idle close), since window ids
//      are not stored, so separate windows of one app can share a bundle.
//   3. A loop proxy: the loop recognizer needs element positions, which are not stored, so runs of transfers
//      that repeat one (source app and kind, part, destination app and kind) into distinct destination fields,
//      under LOOP_GAP_MS apart, are counted instead. An upper bound: it cannot check that rows step evenly.
//
// Thresholds are this code's: a routine is proven after LEVELS[level].routineSightings silent hits at
// ROUTINE_MIN_PRECISION (gate.ts), and a skill is promoted after PROMOTE_AFTER clean runs (skills.ts). A
// prediction cannot be scored from hashes (it reads the live window), so crossing times assume every repeat was
// predicted right: an upper bound on how soon.
import { writeStore } from "../src/privacy/send.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { ScreenModel } from "../src/model.ts";
import { humanActiveSpans, type Span } from "../src/opportunity.ts";
import { readTransfers, type TransferRow } from "../src/store.ts";
import { LEVELS } from "../src/offers/settings.ts";
import { MemoryStore, ROUTINE_MIN_PRECISION } from "../src/patterns/memory.ts";
import { BUNDLE_IDLE_MS, MIN_ROUTINE_STEPS, RoutineRecognizer, type BundleClose } from "../src/patterns/routines.ts";
import { LOOP_GAP_MS } from "../src/patterns/loops.ts";
import { PROMOTE_AFTER } from "../src/patterns/skills.ts";
import { shapeOf, type Part, type PatternTransfer, type Side } from "../src/patterns/shape.ts";

const { values: a } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    out: { type: "string" },
    json: { type: "string" },
    "pmset-log": { type: "string" },
    "no-activity": { type: "boolean", default: false },
  },
});
if (a["data-dir"] === undefined || a.out === undefined) throw new Error("--data-dir and --out are required");
const DIR = resolve(a["data-dir"]);
for (const f of ["screen.sqlite", "memory.sqlite"]) if (!existsSync(join(DIR, f))) throw new Error(`no ${f} in ${DIR}`);

const BALANCED = LEVELS.balanced.routineSightings ?? 3;
const EAGER = LEVELS.eager.routineSightings ?? 2;
/** Occurrence (1-based) whose close proves a routine at `sightings`: the first teaches it, each later one is a silent hit at best. */
const provenAt = (sightings: number): number => 1 + sightings;
/** Occurrence whose Caret run is the PROMOTE_AFTER-th clean one: offers start the occurrence after proof, one run each. */
const promotedAt = (sightings: number): number => provenAt(sightings) + PROMOTE_AFTER;

const tmp = mkdtempSync(join(tmpdir(), "caret-real-day-"));
const iso = (t: number | null): string => (t === null ? "never" : new Date(t).toISOString().replace(/\.\d+Z$/, "Z"));
try {
  for (const f of ["screen.sqlite", "memory.sqlite"]) {
    execFileSync("sqlite3", [`file:${join(DIR, f)}?mode=ro`, `.backup '${join(tmp, f)}'`], { stdio: ["ignore", "ignore", "inherit"] });
  }
  const copiedAt = Date.now();
  const screen = new DatabaseSync(join(tmp, "screen.sqlite"), { readOnly: true });
  const transfers = readTransfers(screen).sort((x, y) => x.at - y.at);
  screen.close();
  const mem = new DatabaseSync(join(tmp, "memory.sqlite"), { readOnly: true });
  // Routine rows are plain JSON of hashes and structure; only their counts and step counts are read here.
  const liveRoutines = (mem.prepare("SELECT id, count, first_seen, last_seen, hits, misses, fields FROM memory WHERE kind = 'routine'").all() as Record<string, unknown>[]).map((r) => {
    const f = JSON.parse(String(r.fields)) as { steps?: unknown[]; finish?: { by?: string } | null };
    return {
      id: String(r.id),
      count: Number(r.count),
      firstSeen: Number(r.first_seen),
      lastSeen: Number(r.last_seen),
      hits: Number(r.hits),
      misses: Number(r.misses),
      steps: f.steps?.length ?? 0,
      finishBy: f.finish?.by ?? (f.finish === null || f.finish === undefined ? null : "buttons"),
    };
  });
  const decisions = mem.prepare("SELECT offer_kind, speak, reasons, COUNT(*) AS n FROM decisions GROUP BY offer_kind, speak, reasons").all() as { offer_kind: string; speak: number; reasons: string; n: number }[];
  mem.close();

  let spans: Span[] | null = null;
  if (!a["no-activity"]) {
    const log =
      a["pmset-log"] === undefined
        ? execFileSync("pmset", ["-g", "log"], { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] })
        : readFileSync(a["pmset-log"], "utf8");
    spans = humanActiveSpans(log);
  }
  const active = (t: number): boolean => spans === null || spans.some((s) => t >= s.from && t <= s.to);

  type Variant = "strict" | "loose";
  interface Occurrence {
    routineId: string;
    n: number;
    at: number;
    dst: string;
  }
  interface BundleSeen {
    sig: string | null;
    dst: string;
    dstKeys: Set<string>;
    at: number;
  }
  interface Replay {
    variant: Variant;
    scope: "all" | "humanActive";
    transfers: number;
    bundles: number;
    bundlesWithRoutineSize: number;
    routines: { id: string; dst: string; steps: number; occurrences: number[]; provenBalanced: number | null; provenEager: number | null; promoteBalanced: number | null; promoteEager: number | null }[];
    /** Per routine, the streak of its own occurrences before each later bundle into its destination that shares a field: hit (the routine again) or miss (something else). */
    streaks: { length: number; nextHit: boolean }[];
  }

  const replay = (variant: Variant, scope: Replay["scope"]): Replay => {
    const dir = mkdtempSync(join(tmp, `mem-${variant}-${scope}-`));
    const memory = new MemoryStore(dir);
    const hash = (t: string): string => createHash("sha256").update(t).digest("hex").slice(0, 16);
    const rec = new RoutineRecognizer(new ScreenModel(), memory, hash);
    const rows = transfers.filter((t) => scope === "all" || active(t.at));
    const lastAt = new Map<string, number>();
    const keysIn = new Map<string, Set<string>>();
    const occurrences: Occurrence[] = [];
    const bundles: BundleSeen[] = [];
    const take = (closes: readonly BundleClose[]): void => {
      for (const c of closes) {
        const at = lastAt.get(c.dstWindowId) ?? 0;
        bundles.push({ sig: c.sig, dst: c.dstWindowId, dstKeys: keysIn.get(c.dstWindowId) ?? new Set(), at });
        keysIn.delete(c.dstWindowId);
        if (c.recorded !== null) occurrences.push({ routineId: c.recorded.id, n: c.recorded.count, at, dst: c.dstWindowId });
      }
    };
    const side = (bundleId: string, windowKind: string, keyHash: string, windowId: string, template: string): Side & { key: string } => ({
      windowId,
      bundleId,
      appName: bundleId,
      windowKind,
      template,
      pos: 0,
      key: keyHash,
    });
    for (const t of rows) {
      take(rec.tick(t.at));
      const dstWin = `${t.dstBundle}|${t.dstWindowKind}`;
      const part: Part = (t.kind ?? "whole") as Part;
      const src = side(t.srcBundle, t.srcWindowKind, t.srcKeyHash, `${t.srcBundle}|${t.srcWindowKind}`, variant === "strict" ? `k:${t.srcKeyHash}` : "k:*");
      const dst = side(t.dstBundle, t.dstWindowKind, t.dstKeyHash, dstWin, `k:${t.dstKeyHash}`);
      const pt: PatternTransfer = { at: t.at, value: t.valueHash, kind: null, part, src, dst, shape: shapeOf(src, part, dst), srcOptions: [{ side: src, part }] };
      rec.onTransfer(pt);
      lastAt.set(dstWin, t.at);
      let ks = keysIn.get(dstWin);
      if (ks === undefined) keysIn.set(dstWin, (ks = new Set()));
      ks.add(t.dstKeyHash);
    }
    take(rec.flush());
    const routines = [...new Set(occurrences.map((o) => o.routineId))].map((id) => {
      const os = occurrences.filter((o) => o.routineId === id).sort((x, y) => x.n - y.n);
      const at = (n: number): number | null => os.find((o) => o.n === n)?.at ?? null;
      return {
        id,
        dst: os[0]?.dst ?? "",
        steps: memory.routine(id)?.steps.length ?? 0,
        occurrences: os.map((o) => o.at),
        provenBalanced: at(provenAt(BALANCED)),
        provenEager: at(provenAt(EAGER)),
        promoteBalanced: at(promotedAt(BALANCED)),
        promoteEager: at(promotedAt(EAGER)),
      };
    });
    // Streaks: walk the bundles into each routine's destination in time order. A bundle with the routine's
    // signature extends the streak and, after a streak of k, counts as a hit for k; a bundle that writes one of the
    // routine's fields with another signature is a miss for k and ends the streak.
    const streaks: Replay["streaks"] = [];
    for (const r of routines) {
      const sig = memory.routine(r.id)?.sig ?? null;
      const fields = new Set(bundles.filter((b) => b.sig === sig).flatMap((b) => [...b.dstKeys]));
      let streak = 0;
      for (const b of bundles.filter((x) => x.dst === r.dst).sort((x, y) => x.at - y.at)) {
        if (b.sig === sig) {
          if (streak > 0) streaks.push({ length: streak, nextHit: true });
          streak++;
        } else if (streak > 0 && [...b.dstKeys].some((k) => fields.has(k))) {
          streaks.push({ length: streak, nextHit: false });
          streak = 0;
        }
      }
    }
    memory.close();
    return {
      variant,
      scope,
      transfers: rows.length,
      bundles: bundles.length,
      bundlesWithRoutineSize: bundles.filter((b) => b.sig !== null).length,
      routines: routines.sort((x, y) => y.occurrences.length - x.occurrences.length),
      streaks,
    };
  };

  // The loop proxy: consecutive transfers into one destination app and kind with the same source app, kind and
  // part, each into a field not yet written in the run, under LOOP_GAP_MS apart.
  const loopRuns = (rows: readonly TransferRow[]): { length: number; at: number }[] => {
    const out: { length: number; at: number }[] = [];
    let run: { key: string; keys: Set<string>; last: number; length: number; at: number } | null = null;
    for (const t of rows) {
      const key = `${t.srcBundle}|${t.srcWindowKind}|${t.kind ?? "whole"}>${t.dstBundle}|${t.dstWindowKind}`;
      if (run !== null && run.key === key && t.at - run.last <= LOOP_GAP_MS && !run.keys.has(t.dstKeyHash)) {
        run.keys.add(t.dstKeyHash);
        run.last = t.at;
        run.length++;
        continue;
      }
      if (run !== null && run.length >= 2) out.push({ length: run.length, at: run.at });
      run = { key, keys: new Set([t.dstKeyHash]), last: t.at, length: 1, at: t.at };
    }
    if (run !== null && run.length >= 2) out.push({ length: run.length, at: run.at });
    return out;
  };

  const replays = (["strict", "loose"] as const).flatMap((v) => (spans === null ? [replay(v, "all")] : [replay(v, "all"), replay(v, "humanActive")]));
  const loopsAll = loopRuns(transfers);
  const loopsActive = spans === null ? null : loopRuns(transfers.filter((t) => active(t.at)));
  const byDst = new Map<string, number>();
  for (const t of transfers) byDst.set(t.dstBundle, (byDst.get(t.dstBundle) ?? 0) + 1);

  const md: string[] = [
    "# What the real days say about routines and loops",
    "",
    `Store copied read-only at ${iso(copiedAt)}. Transfers ${transfers.length}, from ${iso(transfers[0]?.at ?? null)} to ${iso(transfers.at(-1)?.at ?? null)}; ${spans === null ? "human activity not read" : `${transfers.filter((t) => active(t.at)).length} of them inside the pmset log's human-active spans`}.`,
    `Thresholds in this code: proven after ${BALANCED} silent hits (balanced) or ${EAGER} (eager) at precision ${ROUTINE_MIN_PRECISION}; promoted after ${PROMOTE_AFTER} clean runs. So, at best, a routine is proven at its occurrence ${provenAt(BALANCED)} (balanced) or ${provenAt(EAGER)} (eager), and promoted at occurrence ${promotedAt(BALANCED)} or ${promotedAt(EAGER)}.`,
    "",
    "Transfers by destination app: " + [...byDst].sort((x, y) => y[1] - x[1]).map(([b, n]) => `${b} ${n}`).join(", ") + ".",
    "",
    "## 1. The live recognizer's records (shadow helper, real templates)",
    "",
    `${liveRoutines.length} routines; occurrences per routine: ${JSON.stringify(Object.fromEntries([...new Set(liveRoutines.map((r) => r.count))].sort().map((c) => [c, liveRoutines.filter((r) => r.count === c).length])))} (count: routines). Silent predictions scored: hits ${liveRoutines.reduce((n, r) => n + r.hits, 0)}, misses ${liveRoutines.reduce((n, r) => n + r.misses, 0)}. Steps per routine: ${JSON.stringify(liveRoutines.map((r) => r.steps))}. Finish learned: ${liveRoutines.filter((r) => r.finishBy !== null).length}.`,
    `Proven at balanced: ${liveRoutines.filter((r) => r.count >= provenAt(BALANCED)).length}; at eager: ${liveRoutines.filter((r) => r.count >= provenAt(EAGER)).length} (by occurrences alone, an upper bound). Routines seen twice: ${liveRoutines.filter((r) => r.count >= 2).map((r) => `${r.id} (${iso(r.firstSeen)} to ${iso(r.lastSeen)})`).join(", ") || "none"}.`,
    `Decision log: ${decisions.map((d) => `${d.offer_kind} ${d.speak === 1 ? "spoke" : "held"} [${d.reasons}] x${d.n}`).join("; ") || "empty"}.`,
    "",
    "## 2. Replay through this code's RoutineRecognizer (hashes as templates)",
    "",
    "Approximations, not bounds: strict can split one routine into many and can invent one from a field filled from two list rows; loose merges different sources; one app's windows share a bundle until 120 s pass.",
    "",
    "| Shape | Transfers | Bundles | Bundles of 2+ shapes | Routines | Seen 2+ | Seen 3+ | Seen 4+ | Reach proof by balanced (first) | Reach proof by eager (first) | Reach promotion (balanced / eager) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...replays.map((r) => {
      const seen = (k: number): number => r.routines.filter((x) => x.occurrences.length >= k).length;
      const first = (xs: (number | null)[]): string => {
        const ts = xs.filter((x): x is number => x !== null).sort((p, q) => p - q);
        return ts.length === 0 ? "0" : `${ts.length} (${iso(ts[0] ?? null)})`;
      };
      return `| ${r.variant}, ${r.scope} | ${r.transfers} | ${r.bundles} | ${r.bundlesWithRoutineSize} | ${r.routines.length} | ${seen(2)} | ${seen(3)} | ${seen(4)} | ${first(r.routines.map((x) => x.provenBalanced))} | ${first(r.routines.map((x) => x.provenEager))} | ${first(r.routines.map((x) => x.promoteBalanced))} / ${first(r.routines.map((x) => x.promoteEager))} |`;
    }),
    "",
    "Routines seen more than once (loose, all), by destination app and window kind, with occurrence times:",
    "",
    ...(replays.find((r) => r.variant === "loose" && r.scope === "all")?.routines.filter((r) => r.occurrences.length >= 2).map((r) => `- ${r.dst}: ${r.steps} steps, ${r.occurrences.length} occurrences: ${r.occurrences.map((t) => iso(t)).join(", ")}`) ?? []),
    "",
    "## Clean streaks before the next occurrence into the same destination",
    "",
    "A streak is a routine's own occurrences in a row; the next bundle into its destination that writes one of its fields either repeats it (hit) or does something else there (miss).",
    "",
    "| Shape | Streak length: hits / misses |",
    "| --- | --- |",
    ...replays.map((r) => {
      const ls = [...new Set(r.streaks.map((s) => s.length))].sort((x, y) => x - y);
      return `| ${r.variant}, ${r.scope} | ${ls.map((l) => `${l}: ${r.streaks.filter((s) => s.length === l && s.nextHit).length} / ${r.streaks.filter((s) => s.length === l && !s.nextHit).length}`).join("; ") || "no streak followed by another bundle"} |`;
    }),
    "",
    "## 3. Loop proxy (positions not stored)",
    "",
    `Runs of 2+ like transfers into new fields of one destination: all ${loopsAll.length} (lengths ${JSON.stringify(loopsAll.map((l) => l.length))}); human-active ${loopsActive === null ? "n/a" : `${loopsActive.length} (lengths ${JSON.stringify(loopsActive.map((l) => l.length))})`}. A real loop offers its next round after round 2 matches round 1, so a run of 3 or more is where Caret would first have spoken, if the rows stepped evenly.`,
    "",
  ];
  writeStore(a.out, md.join("\n") + "\n");
  if (a.json !== undefined) writeStore(a.json, JSON.stringify({ copiedAt, transfers: transfers.length, liveRoutines, decisions, replays, loopsAll, loopsActive, thresholds: { BALANCED, EAGER, PROMOTE_AFTER, ROUTINE_MIN_PRECISION, BUNDLE_IDLE_MS, MIN_ROUTINE_STEPS, LOOP_GAP_MS } }, null, 2) + "\n");
  process.stdout.write(md.join("\n") + "\n");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
