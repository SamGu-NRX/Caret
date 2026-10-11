#!/usr/bin/env python3
"""E1 report: which Accessibility notifications arrive for which scripted change, how late, and
what the reader costs. Reads the outputs of run-e1.sh (on and off) and of the TextEdit run.

  e1_report.py --on DIR --off DIR [--latency DIR] [--textedit DIR] > e1-report.md

--on and --off give the CPU runs. --latency, when given, is a separate reader-on run whose
notification log is used for the coverage table instead of --on's.

Changes carry markers "T<epoch ms><action><n>". A change counts as covered by a notification when
a notification carrying its marker arrived (on the element, or on a container whose children show
it). Window closes and web node removals leave nothing to read, so they are matched by time.
"""
import argparse
import collections
import json
import os
import re
import statistics
import subprocess

ACTION_NAMES = {
    "v": "value set by code",
    "k": "text inserted (typing path)",
    "f": "focus moved to another field",
    "s": "static text changed",
    "t": "title changed",
    "w": "window opened",
    "c": "window closed",
    "a": "node added",
    "r": "node removed",
}
MARK = re.compile(r"T(\d{13})([a-z]+)(\d+)")


def load(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def pct(n, d):
    return "n/a" if d == 0 else f"{100 * n / d:.0f}%"


def q(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else None


def fmt_ms(x):
    return "-" if x is None else f"{x:.0f}"


READY = {"t": 0}


def family_rows(name, notes, actions):
    """actions: list of (action, marker, t) performed. notes: notification records for this family.
    Actions made before the reader's first logged notification (observers not yet registered) are left out."""
    actions = [x for x in actions if x[2] >= READY["t"] or x[2] == 0]
    by_marker = collections.defaultdict(list)
    for n in notes:
        if "marker" in n:
            by_marker[n["marker"]].append(n)
    rows = []
    for a in sorted({x[0] for x in actions}, key=lambda c: "vkfstwcar".index(c) if c in "vkfstwcar" else 99):
        done = [x for x in actions if x[0] == a]
        covered, lat, per_type = 0, [], collections.Counter()
        for _, m, t in done:
            hits = by_marker.get(m, [])
            if a in ("c", "r"):
                hits = [n for n in notes if t <= n["t"] <= t + 1000 and n["n"] in ("AXUIElementDestroyed", "AXLayoutChanged", "AXRowCountChanged", "AXSelectedChildrenChanged")]
            if hits:
                covered += 1
                lat.append(min(n["t"] for n in hits) - t)
                for typ in {n["n"] for n in hits}:
                    per_type[typ] += 1
        types = ", ".join(f"{k.removeprefix('AX')} {pct(v, len(done))}" for k, v in per_type.most_common())
        rows.append((name, a, len(done), pct(covered, len(done)), fmt_ms(q(lat, 0.5)), fmt_ms(q(lat, 0.9)), types or "none"))
    return rows


def web_actions(notes):
    """Web pages script themselves, so performed actions are inferred: every marker seen, plus the
    cycles in between for actions whose markers never appeared, timed from the 'a' marker."""
    seen = {}
    for n in notes:
        if "marker" in n:
            m = MARK.match(n["marker"])
            if m:
                seen[n["marker"]] = (m.group(2), int(m.group(1)), int(m.group(3)))
    if not seen:
        return []
    cycles = max(c for _, _, c in seen.values()) + 1
    # Cycles that began before the reader was ready are skipped; a cycle's start is its earliest marker.
    starts = collections.defaultdict(lambda: None)
    for a, t, c in seen.values():
        starts[c] = t if starts[c] is None else min(starts[c], t)
    first = min((c for c in range(cycles) if starts[c] is not None and starts[c] >= READY["t"]), default=cycles)
    out = []
    by_action = collections.defaultdict(dict)
    for mk, (a, t, c) in seen.items():
        by_action[a][c] = (mk, t)
    adds = by_action.get("a", {})
    for a in "vkfsatr":
        for c in range(first, cycles):
            if c in by_action.get(a, {}):
                mk, t = by_action[a][c]
                out.append((a, mk, t))
            elif a == "r" and c in adds:
                out.append(("r", f"unseen-r{c}", adds[c][1] + 1200))
            else:
                out.append((a, f"unseen-{a}{c}", 0))
    return out


def cpu(path):
    blocks, cur = {}, None
    with open(path) as f:
        for line in f:
            parts = line.split()
            if line.startswith("label="):
                cur = parts[0].split("=")[1]
                blocks[cur] = {"t": int(parts[1].split("=")[1])}
            elif len(parts) == 2:
                blocks[cur][parts[0]] = float(parts[1])
    return blocks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--on", required=True)
    ap.add_argument("--off", required=True)
    ap.add_argument("--textedit")
    ap.add_argument("--latency")
    args = ap.parse_args()

    src = args.latency or args.on
    pids = open(os.path.join(src, "pids.txt")).read().split()
    fix, chrome = int(pids[1]), int(pids[3]) if pids[3] != "none" else -1
    notes = load(os.path.join(src, "e1.ndjson"))
    fixture_log = load(os.path.join(src, "fixture-actions.ndjson"))
    appkit_markers = {x["marker"] for x in fixture_log}
    READY["t"] = min(n["t"] for n in notes) + 500 if notes else 0

    # The WKWebView lives in the fixture's process, so its notifications share the pid: they are told
    # apart by marker. Unmarked ones (closes, removals) are offered to both families' time matching.
    appkit_notes = [n for n in notes if n["pid"] == fix and (n.get("marker") in appkit_markers or "marker" not in n)]
    webkit_notes = [n for n in notes if n["pid"] == fix and "marker" in n and n["marker"] not in appkit_markers]
    chrome_notes = [n for n in notes if n["pid"] == chrome]
    other = [n for n in notes if n["pid"] not in (fix, chrome)]

    rows = []
    rows += family_rows("AppKit (caret-fixture)", appkit_notes, [(x["action"], x["marker"], x["t"]) for x in fixture_log])
    rows += family_rows("WebKit (WKWebView in caret-fixture)", webkit_notes + [n for n in notes if n["pid"] == fix and "marker" not in n], web_actions(webkit_notes))
    rows += family_rows("Chromium (Chrome, throwaway profile)", chrome_notes, web_actions(chrome_notes))
    if args.textedit:
        te_notes = load(os.path.join(args.textedit, "e1.ndjson"))
        te_log = load(os.path.join(args.textedit, "driver.ndjson"))
        READY["t"] = min(n["t"] for n in te_notes) if te_notes else 0
        rows += family_rows("AppKit (TextEdit, own document)", te_notes, [(x["action"], x["marker"], x["t"]) for x in te_log])

    print("# E1: Accessibility notifications per app family, and what reading costs\n")
    print("Scripted changes ran in windows the experiment opened itself; nothing was typed into or clicked in anyone else's window.")
    print("The fixture, its WKWebView and the Chrome page were never frontmost, so they were read as `--event-pids` apps.")
    print("Latency is from the moment the change was made (marker timestamp, same clock) to the moment the observer callback ran.")
    print("Changes made before the reader had registered its observers are left out. Observers are registered on the application element only.")
    print("The WKWebView sat in a window behind others, and WebKit throttles timers there, so its page ran fewer cycles.\n")
    print("| Family | Change | Times made | Any notification | Median ms | p90 ms | Notifications that carried it |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for fam, a, n, cov, med, p90, types in rows:
        print(f"| {fam} | {ACTION_NAMES.get(a, a)} | {n} | {cov} | {med} | {p90} | {types} |")

    print("\n## Electron, observed passively\n")
    names = {}
    for pid in {n["pid"] for n in other}:
        try:
            names[pid] = subprocess.run(["ps", "-o", "comm=", "-p", str(pid)], capture_output=True, text=True).stdout.strip().split("/")[-1] or f"pid {pid}"
        except Exception:
            names[pid] = f"pid {pid}"
    if other:
        t0, t1 = min(n["t"] for n in other), max(n["t"] for n in other)
        mins = max(1e-9, (t1 - t0) / 60000)
        by_app = collections.defaultdict(collections.Counter)
        for n in other:
            by_app[names[n["pid"]]][n["n"]] += 1
        print("No scripted changes: these are notifications from apps that were frontmost or forced event-driven during the run, while agents and people used them. Counts only; no content was recorded.\n")
        print("| App | Notification | Count | Per minute |")
        print("| --- | --- | --- | --- |")
        for app, c in sorted(by_app.items()):
            for typ, k in c.most_common():
                print(f"| {app} | {typ.removeprefix('AX')} | {k} | {k / mins:.1f} |")

    on, off = cpu(os.path.join(args.on, "cpu.txt")), cpu(os.path.join(args.off, "cpu.txt"))
    def delta(b, k):
        return b["end"].get(k, 0) - b["start"].get(k, 0)
    don = on["end"]["t"] - on["start"]["t"]
    doff = off["end"]["t"] - off["start"]["t"]
    print(f"\n## CPU over {don} s with the reader on and {doff} s with it off\n")
    print("CPU seconds from `ps` TIME at both ends; percent is of one core.\n")
    print("| Process | Off: CPU s | Off: % | On: CPU s | On: % | Added by reading |")
    print("| --- | --- | --- | --- | --- | --- |")
    for k, label in [("fixture", "caret-fixture (AppKit window + WKWebView host)"), ("chrome", "Chrome, throwaway profile (all processes)"), ("t3code", "T3 Code (all processes, passive)")]:
        a, b = delta(off, k), delta(on, k)
        print(f"| {label} | {a:.1f} | {100 * a / doff:.1f} | {b:.1f} | {100 * b / don:.1f} | {100 * b / don - 100 * a / doff:+.1f} pts |")
    for k, label in [("reader", "caret-screen (all apps, fixture and Chrome event-driven)"), ("helper", "helper (no Jev)")]:
        b = delta(on, k)
        print(f"| {label} | - | - | {b:.1f} | {100 * b / don:.1f} | {100 * b / don:+.1f} pts |")
    print(f"\nResident memory at the end: reader {on['end'].get('reader_rss_kb', 0) / 1024:.0f} MB, helper {on['end'].get('helper_rss_kb', 0) / 1024:.0f} MB.")


if __name__ == "__main__":
    main()
