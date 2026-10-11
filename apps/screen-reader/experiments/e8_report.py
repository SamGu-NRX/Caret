#!/usr/bin/env python3
"""E8 report from run-e8.sh output.   e8_report.py OUTDIR > e8-report.md

An element is tracked when it is a kept node in the first counted walk. It is stable when it was
present in every walk (the same live element, by CFEqual) and carried the same key every time."""
import json
import os
import sys

out = sys.argv[1]
conds = [("still", "Nothing changing"), ("active", "Typing in forms; E1 page changing in WKWebView and Chrome"), ("drift", "Window built to move keys")]
print("# E8: element key stability over 100 walks\n")
print("| Condition | App | Window | Walk ms | Tracked | Present in every walk | Same key every walk | Share stable | Keys from walk 1 found in every walk |")
print("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
tot_p = tot_s = 0
drifts = []
for c, desc in conds:
    path = os.path.join(out, f"{c}.json")
    if not os.path.exists(path):
        continue
    for w in json.load(open(path)):
        title = w["window"] if "Google Chrome" not in w["window"] else "Caret E1 page (Chrome)"
        share = w["stableKey"] / w["presentInAll"] if w["presentInAll"] else 0
        tot_p += w["presentInAll"]; tot_s += w["stableKey"]
        print(f"| {c} | {w['app']} | {title} | {w['meanWalkMs']:.0f} | {w['tracked']} | {w['presentInAll']} | {w['stableKey']} | {100 * share:.0f}% | {w['keysInAll']} of {w['keysFirst']} |")
        for d in w["drift"]:
            drifts.append((c, title, d))
print(f"\nAll conditions together: {tot_s} of {tot_p} elements present in every walk kept one key ({100 * tot_s / max(1, tot_p):.1f}%).\n")
print("## Drift cases\n")
print("| Condition | Window | Role | Cause | Keys seen (after app and window kind) |")
print("| --- | --- | --- | --- | --- |")
for c, title, d in drifts:
    keys = " → ".join(k.split("/", 2)[-1] for k in d["keys"])
    print(f"| {c} | {title} | {d['role']} | {d['cause']} | `{keys}` |")
print("\nCauses: `label` means the element's own name changed; `ordinal` means an element with the same role and label appeared before it under the same named ancestors; `ancestors` means a named container above it was renamed.")
