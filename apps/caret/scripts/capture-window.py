#!/usr/bin/env python3
"""Capture one window's screen region, including other windows drawn over it (the ghost-text
overlay is a separate window, so a per-window capture would miss it).

Usage: capture-window.py <pid> <window_id> <out.png> [margin_points]

Takes a full-display capture through cua-driver into a temp file, crops it to the window's bounds
plus a margin with sips, and deletes the full capture so nothing outside the fixture is kept.
"""
import json
import os
import subprocess
import sys
import tempfile


def cua(tool: str, args: dict) -> dict:
    out = subprocess.run(["cua-driver", tool, json.dumps(args)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def main() -> int:
    pid, window_id, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    margin = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
    windows = cua("list_windows", {"pid": pid})["windows"]
    window = next(w for w in windows if w["window_id"] == window_id)
    bounds = window["bounds"]
    fd, full = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        desktop = cua("get_desktop_state", {"screenshot_out_file": full})
        # The capture is in device pixels; bounds are in points.
        scale = desktop["screenshot_width"] / desktop["screen_width"]
        x = max(0.0, bounds["x"] - margin) * scale
        y = max(0.0, bounds["y"] - margin) * scale
        w = (bounds["width"] + 2 * margin) * scale
        h = (bounds["height"] + 2 * margin) * scale
        subprocess.run(
            ["sips", "--cropToHeightWidth", str(int(h)), str(int(w)), "--cropOffset", str(int(y)), str(int(x)),
             full, "--out", out],
            capture_output=True, check=True,
        )
    finally:
        os.unlink(full)
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
