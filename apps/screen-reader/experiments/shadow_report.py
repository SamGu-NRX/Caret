#!/usr/bin/env python3
"""Shadow run report: what the shadow logger persisted, scored against the fixture's own log of
what it typed, plus reader and helper CPU and memory.   shadow_report.py OUTDIR > shadow-report.md"""
import json
import os
import sqlite3
import sys

out = sys.argv[1]
db = sqlite3.connect(f"file:{os.path.join(out, 'shadow-data', 'screen.sqlite')}?mode=ro", uri=True)
counts = dict(db.execute("SELECT metric, SUM(n) FROM counts GROUP BY metric").fetchall())
rows = db.execute("SELECT dst_bundle, existed, entered_length, trigger, src_bundle FROM shadow_episodes").fetchall()
fixture_rows = [r for r in rows if r[0] == ""]  # caret-fixture runs unbundled
other_rows = [r for r in rows if r[0] != ""]

acts = [json.loads(l) for l in open(os.path.join(out, "activity.ndjson")) if l.strip()]
entered = [a for a in acts if a["event"] == "entered"]
truth_yes = sum(1 for a in entered if a["existsElsewhere"])
truth_no = len(entered) - truth_yes

res = [l.rstrip("\n").split("\t") for l in open(os.path.join(out, "resources.tsv"))][1:]
res = [[float(x) for x in r] for r in res if len(r) == 5 and all(r)]
span = res[-1][0] - res[0][0]
r_cpu = res[-1][1] - res[0][1]
h_cpu = res[-1][3] - res[0][3]

print("# Shadow logger, 10 minutes on caret-fixture\n")
print("`caret-screen --shadow` read every app as on a real day, with caret-fixture event-driven; the helper ran in shadow mode (no Jev, nothing shown).")
print("caret-fixture typed one entry every 8 s through the field editor; it logged whether each value also appears in its Reference window.\n")
print("| Measure | Value |")
print("| --- | --- |")
print(f"| Entries the fixture typed | {len(entered)} ({truth_yes} copy a value shown elsewhere, {truth_no} invented) |")
print(f"| Fixture episodes persisted | {len(fixture_rows)} |")
yes = [r for r in fixture_rows if r[1] != "no"]
print(f"| Judged as existing elsewhere | {len(yes)} (exact {sum(1 for r in yes if r[1] == 'exact')}, normalized {sum(1 for r in yes if r[1] == 'normalized')}) |")
print(f"| Judged as not existing | {sum(1 for r in fixture_rows if r[1] == 'no')} |")
print(f"| Episodes in other apps during the run | {len(other_rows)} |")
print(f"| Reader CPU | {r_cpu:.1f} s over {span:.0f} s ({100 * r_cpu / span:.1f}% of one core) |")
print(f"| Helper CPU | {h_cpu:.1f} s ({100 * h_cpu / span:.1f}% of one core) |")
print(f"| Reader resident memory | start {res[0][2] / 1024:.0f} MB, end {res[-1][2] / 1024:.0f} MB, max {max(r[2] for r in res) / 1024:.0f} MB |")
print(f"| Helper resident memory | start {res[0][4] / 1024:.0f} MB, end {res[-1][4] / 1024:.0f} MB, max {max(r[4] for r in res) / 1024:.0f} MB |")
print("\nCounters persisted (all apps):\n")
print("| Counter | Value |")
print("| --- | --- |")
for k in sorted(counts):
    if k.startswith(("shadow.", "transfer.", "reader.app_switch", "reader.focus", "reader.pasteboard")):
        print(f"| {k} | {counts[k]} |")
cols = [r[1] for r in db.execute("PRAGMA table_info(shadow_episodes)")]
print(f"\nColumns of a persisted episode: {', '.join(cols)}. No column holds screen text.")
