// Scores for the slow runner's sets (brief R1), read from each eval's own report, which already scored every field or
// Ask against its answer key. The rules are J1's bake-off's (~/.caret-run/evidence/screen/j1/bakeoff.py) so a Laya row
// sits beside canned and Jev rows scored the same way; the same functions score those reference runs.
//
// - Fields (task pages, wizard, tab-source): right and wrong are the oracle's; written = right + wrong; abstained =
//   eligible - written. Wrong counts every wrong value the page held, a second Ask's included.
// - Corpus goal: written = each preview's eligible fields Caret wrote, right = written - wrong. A page with no preview has
//   no goal row, so its eligible count comes from the reference run of the same pages (`fallbackEligible`), as J1 did.
// - Corpus Fill all: there is no per-field key count, so only written and wrong.
// - Asks: right, partial, wrong (a continued Ask's wrong included), asked, refused; written = Asks that proposed values.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SetKind = "asks" | "tasks" | "corpus" | "fill" | "wizard" | "journey";

export interface SetScore {
  /** What one unit is: a form field, or one Ask. */
  unit: "fields" | "asks";
  right: number;
  wrong: number;
  /** Eligible units Caret left alone (fields), or Asks answered with a question or a refusal. */
  abstained: number | null;
  written: number;
  eligible: number | null;
  /** Decision requests the eval answered in this run (replayed ones included). */
  decisions: number;
  /** Each decision's latency as the eval saw it (a replay reports the recorded latency). */
  latencies: number[];
  /** One short clause the set's kind adds (partials, checks, the attach). */
  extra: string;
}

interface TaskRow { right: number; eligible: number; wrong: unknown[] }
interface GoalRow { eligible: number; eligibleWritten: number }
interface PageRow { id: string; wrong: unknown[] | null; written: number; goal: GoalRow | null; task?: TaskRow }
interface PageLoop { suite?: string; rows: PageRow[]; calls?: { latencyMs: number }[] }

const read = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** The report file each kind writes in its --out directory. */
export function reportFile(kind: SetKind, drop = false): string {
  switch (kind) {
    case "asks":
      return "realfill-asks.json";
    case "wizard":
      return drop ? "wizard-drop.json" : "wizard.json";
    case "journey":
      return "journey.json";
    default:
      return "page-loop.json";
  }
}

export function scorePages(kind: "tasks" | "corpus" | "fill", d: PageLoop, fallbackEligible: ReadonlyMap<string, number> = new Map()): SetScore {
  const wrong = sum(d.rows.map((r) => r.wrong?.length ?? 0));
  const latencies = (d.calls ?? []).map((c) => c.latencyMs);
  if (kind === "tasks") {
    const t = d.rows.flatMap((r) => (r.task === undefined ? [] : [r.task]));
    const right = sum(t.map((x) => x.right));
    const eligible = sum(t.map((x) => x.eligible));
    return { unit: "fields", right, wrong, written: right + wrong, eligible, abstained: eligible - right - wrong, decisions: latencies.length, latencies, extra: "" };
  }
  if (kind === "corpus") {
    let eligible = 0;
    const missing: string[] = [];
    for (const r of d.rows) {
      if (r.goal !== null) eligible += r.goal.eligible;
      else {
        const e = fallbackEligible.get(r.id);
        if (e === undefined) missing.push(r.id);
        else eligible += e;
      }
    }
    const written = sum(d.rows.map((r) => r.goal?.eligibleWritten ?? 0));
    const right = written - wrong;
    const noPreview = d.rows.filter((r) => r.goal === null).length;
    return {
      unit: "fields",
      right,
      wrong,
      written,
      eligible,
      abstained: eligible - written,
      decisions: latencies.length,
      latencies,
      extra: `${noPreview} of ${d.rows.length} pages without a preview${missing.length === 0 ? "" : `; no eligible count for ${missing.join(", ")}`}`,
    };
  }
  const written = sum(d.rows.map((r) => r.written));
  return { unit: "fields", right: written - wrong, wrong, written, eligible: null, abstained: null, decisions: latencies.length, latencies, extra: `${d.rows.filter((r) => r.written > 0).length} of ${d.rows.length} pages written` };
}

interface WizardReport { rows: { page: string; right: number; eligible: number; wrong: string[] }[]; attached: string | null; calls: { latencyMs: number }[] }

export function scoreWizard(d: WizardReport): SetScore {
  const right = sum(d.rows.map((r) => r.right));
  const wrong = sum(d.rows.map((r) => r.wrong.length));
  const eligible = sum(d.rows.map((r) => r.eligible));
  const latencies = d.calls.map((c) => c.latencyMs);
  return { unit: "fields", right, wrong, written: right + wrong, eligible, abstained: eligible - right - wrong, decisions: latencies.length, latencies, extra: `resume ${d.attached === "ines-vandermeer-resume-2026.pdf" ? "attached" : `not attached (${d.attached ?? "nothing"})`}` };
}

/** C2's wizard runs predate wizard.json: the same numbers from wizard.md's table and its resume line. */
export function scoreWizardMd(md: string): SetScore {
  let right = 0;
  let eligible = 0;
  let wrong = 0;
  for (const line of md.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (!/^wizard-\d$/.test(cells[1] ?? "")) continue;
    const m = /^(\d+) \/ (\d+)$/.exec(cells[6] ?? "");
    if (m === null) throw new Error(`wizard.md row '${line.slice(0, 80)}' has no 'right / eligible' cell`);
    right += Number(m[1]);
    eligible += Number(m[2]);
    wrong += cells[7] === "0" ? 0 : (cells[7] ?? "").split("; ").length;
  }
  const attached = /resume(?:_drop)? reads: ines-vandermeer-resume-2026\.pdf/.test(md);
  return { unit: "fields", right, wrong, written: right + wrong, eligible, abstained: eligible - right - wrong, decisions: 0, latencies: [], extra: `resume ${attached ? "attached" : "not attached"}` };
}

interface JourneyReport { checks: { ok: boolean }[]; oracle: { right: string[]; wrong: unknown[]; missed: string[] }; calls?: { latencyMs: number }[] }

export function scoreJourney(d: JourneyReport): SetScore {
  const right = d.oracle.right.length;
  const wrong = d.oracle.wrong.length;
  const eligible = right + wrong + d.oracle.missed.length;
  const latencies = (d.calls ?? []).map((c) => c.latencyMs);
  return { unit: "fields", right, wrong, written: right + wrong, eligible, abstained: eligible - right - wrong, decisions: latencies.length, latencies, extra: `${d.checks.filter((c) => c.ok).length}/${d.checks.length} checks` };
}

type Verdict = "right" | "partial" | "wrong" | "asked" | "refused";
interface AsksReport { requestMs?: number[]; rows: { verdict: Verdict; continued: { verdict: Verdict } | null; maker: { latencyMs: number } | null }[] }

export function scoreAsks(d: AsksReport): SetScore {
  const n = (v: Verdict): number => d.rows.filter((r) => r.verdict === v).length;
  const cont = (v: Verdict): number => d.rows.filter((r) => r.continued?.verdict === v).length;
  // P1's runs predate requestMs; their latency is the maker's alone (J1 bakeoff.py says so in its table).
  const latencies = d.requestMs ?? d.rows.flatMap((r) => (r.maker === null ? [] : [r.maker.latencyMs]));
  const wrong = n("wrong") + cont("wrong");
  return {
    unit: "asks",
    right: n("right"),
    wrong,
    written: n("right") + n("partial") + n("wrong"),
    eligible: d.rows.length,
    abstained: n("asked") + n("refused"),
    decisions: latencies.length,
    latencies,
    extra: `${n("partial")} partial, ${n("asked")} asked, ${n("refused")} refused; after a pick ${cont("right")}R ${cont("partial")}P ${cont("wrong")}W${d.requestMs === undefined ? "; latency: maker requests only" : ""}`,
  };
}

/** Scores the report in `dir` for a set of `kind`. */
export function scoreDir(kind: SetKind, dir: string, opts: { drop?: boolean; fallbackEligible?: ReadonlyMap<string, number> } = {}): SetScore {
  const file = join(dir, reportFile(kind, opts.drop));
  if (kind === "wizard" && !existsSync(file)) {
    const md = join(dir, opts.drop === true ? "wizard-drop.md" : "wizard.md");
    return scoreWizardMd(readFileSync(md, "utf8"));
  }
  switch (kind) {
    case "asks":
      return scoreAsks(read<AsksReport>(file));
    case "wizard":
      return scoreWizard(read<WizardReport>(file));
    case "journey":
      return scoreJourney(read<JourneyReport>(file));
    default:
      return scorePages(kind, read<PageLoop>(file), opts.fallbackEligible);
  }
}

/** Each corpus page's eligible fields in a goal run, for pages another run of the same set had no preview on. */
export function eligibleByPage(dir: string): Map<string, number> {
  const d = read<PageLoop>(join(dir, "page-loop.json"));
  return new Map(d.rows.flatMap((r) => (r.goal === null ? [] : [[r.id, r.goal.eligible] as const])));
}

/** The p-th fraction of `xs` as J1's bake-off takes it (the value at index floor(p * n), clamped). */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
}

/** "right / eligible, W wrong" in one cell. */
export function cell(s: SetScore): string {
  const of = s.eligible === null ? `${s.written} written` : `${s.right} / ${s.eligible}`;
  return `${of}, ${s.wrong} wrong${s.unit === "asks" ? ` (${s.extra.split(";")[0]})` : ""}`;
}
