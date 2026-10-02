// Checks files for text an audit saw on real windows, by hash (src/leak-check.ts).
//
//   node scripts/leak-check.ts --seen FILE [--repo DIR --diff REV] [--public-rev REV] [--show] [PATH...]
//
// PATHs are files or directories, read whole. --diff adds the lines added since REV in the repo's
// commits (git diff REV..HEAD). A match that also occurs in the repo at --public-rev was public before
// the audit ran, such as a word in this code base, and is counted apart. Prints counts; --show also
// prints the matching text, which comes from the files under check, never from the seen file. That
// text can be real-window content when a check fails, so --show output stays in the terminal and
// goes into no file. Exits 1 when any match is not public.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { scanText, SeenSet, type LeakHit, type SeenFile } from "../src/leak-check.ts";

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seen: { type: "string" },
    repo: { type: "string" },
    diff: { type: "string" },
    "public-rev": { type: "string" },
    show: { type: "boolean", default: false },
  },
});
if (a.seen === undefined) throw new Error("--seen is required");
if ((a.diff !== undefined || a["public-rev"] !== undefined) && a.repo === undefined) throw new Error("--diff and --public-rev need --repo");
const seen = SeenSet.fromJSON(JSON.parse(readFileSync(a.seen, "utf8")) as SeenFile);

const targets = new Map<string, string>();
const walk = (p: string): void => {
  if (statSync(p).isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
  else targets.set(p, readFileSync(p, "utf8"));
};
for (const p of positionals) walk(p);
if (a.diff !== undefined && a.repo !== undefined) {
  const diff = execFileSync("git", ["-C", a.repo, "diff", "--unified=0", "--no-color", `${a.diff}..HEAD`], { encoding: "utf8", maxBuffer: 1 << 28 });
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = `diff:${line.slice(6)}`;
    else if (line.startsWith("+") && file !== "") targets.set(file, `${targets.get(file) ?? ""}${line.slice(1)}\n`);
  }
}

const hits = new Map<string, { hit: LeakHit; files: Set<string> }>();
let lines = 0;
for (const [file, text] of targets) {
  lines += text.split("\n").length;
  for (const h of scanText(text, seen)) {
    const e = hits.get(h.unit) ?? { hit: h, files: new Set<string>() };
    e.files.add(file);
    hits.set(h.unit, e);
  }
}

// One git grep over the public tree for every matched unit at once.
const isPublic = new Set<string>();
if (a["public-rev"] !== undefined && a.repo !== undefined && hits.size > 0) {
  try {
    // -w: a unit counts as public only as a whole word there, so a private name is not excused by a longer public one that starts with it.
    const out = execFileSync("git", ["-C", a.repo, "grep", "-h", "-o", "-i", "-w", "-F", "--no-color", "-f", "/dev/stdin", a["public-rev"]], {
      input: [...hits.keys()].join("\n"),
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    for (const m of out.split("\n")) {
      const k = m.trim().toLowerCase();
      // git prefixes each match with the revision.
      const unit = k.startsWith(`${a["public-rev"].toLowerCase()}:`) ? k.slice(a["public-rev"].length + 1) : k;
      if (hits.has(unit)) isPublic.add(unit);
    }
  } catch (e) {
    // git grep exits 1 when nothing matches.
    if ((e as { status?: number }).status !== 1) throw e;
  }
}

const open = [...hits.values()].filter((e) => !isPublic.has(e.hit.unit));
const byBundle: Record<string, number> = {};
for (const e of open) for (const b of e.hit.bundles) byBundle[b] = (byBundle[b] ?? 0) + 1;
process.stdout.write(
  `${JSON.stringify({ files: targets.size, lines, seenUnits: seen.size, matches: hits.size, public: isPublic.size, notPublic: open.length, notPublicByApp: byBundle }, null, 2)}\n`,
);
if (a.show) for (const e of open) process.stdout.write(`${JSON.stringify(e.hit.unit)}\t${e.hit.bundles.join(",")}\t${[...e.files].join(",")}\n`);
process.exitCode = open.length > 0 ? 1 : 0;
