#!/usr/bin/env python3
"""Capture one window's screen region, including other windows drawn over it (the ghost-text
overlay is a separate window, so a per-window capture would miss it).

Usage: capture-window.py <pid> <window_id> <out.png>

Reads the window's bounds from cua-driver and captures exactly that rectangle with
`screencapture -x -R`, so nothing outside the fixture window is recorded. Works on any display.
"""
import json
import subprocess
import sys


def main() -> int:
    pid, window_id, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    listed = subprocess.run(["cua-driver", "list_windows", json.dumps({"pid": pid})], capture_output=True, text=True, check=True)
    bounds = next(w for w in json.loads(listed.stdout)["windows"] if w["window_id"] == window_id)["bounds"]
    region = "%d,%d,%d,%d" % (bounds["x"], bounds["y"], bounds["width"], bounds["height"])
    subprocess.run(["screencapture", "-x", "-R" + region, out], check=True)
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
