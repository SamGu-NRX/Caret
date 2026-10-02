#!/usr/bin/env python3
"""Screenshot whichever autocomplete is running in three fixture cases, so Caret and Cotypist can
be compared on the same text.

  observe_cases.py <label> <evidence_dir>

Cases (all in fresh TextEdit plain-text documents):
  mid      caret inside "I read your | and they were clear."; types "detailed meeting no"
  mid2     caret inside "We should schedule a call for next| to go over it."; types " w"
  wrap     a line typed until the caret sits a few characters before the right edge
  narrow   a 260-point-wide window, caret in the middle of a wrapped sentence

Writes <label>-<case>.png per case. Accepts nothing: Tab is never pressed. When the label is
"caret", it also records the host's offer for each case from the debug socket.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_textedit as e2e  # noqa: E402

WRAP_LINE = "I wanted to follow up on our conversation from last week about the project plan and the next "
NARROW_TEXT = "Could you send me the updated numbers for the "


def settle_and_capture(pid, window_id, path, expected, wait=1.6):
    """Waits for a suggestion to appear, then photographs the window only if the document holds
    exactly the synthetic text (anything else may be someone's real typing)."""
    time.sleep(wait)
    e2e.still_focused(pid)
    if e2e.verify_value(pid, window_id, expected).get("status") != "satisfied":
        return False
    e2e.capture(pid, window_id, path)
    e2e.still_focused(pid)
    return True


def run_case(case, label, evidence):
    if case in ("mid", "mid2"):
        prefix, suffix, typed = {
            "mid": ("I read your ", " and they were clear.", "detailed meeting no"),
            "mid2": ("We should schedule a call for next", " to go over it.", " w"),
        }[case]
        pid, window_id, _ = e2e.open_fixture(f"{label}-{case}.txt", prefix + suffix)
        e2e.send_keys(pid, window_id, "right", len(prefix))
        expected = prefix + typed + suffix
    elif case == "wrap":
        pid, window_id, _ = e2e.open_fixture(f"{label}-{case}.txt", "")
        typed = WRAP_LINE
        expected = typed
    elif case == "narrow":
        pid, window_id, _ = e2e.open_fixture(f"{label}-{case}.txt", "")
        e2e.cua("set_window_frame", {"pid": pid, "window_id": window_id, "x": 200, "y": 120, "width": 260, "height": 300})
        typed = NARROW_TEXT
        expected = typed
    else:
        raise SystemExit(f"unknown case {case}")
    e2e.send(pid, window_id, "type", typed, ["90"])
    path = os.path.join(evidence, f"{label}-{case}.png")
    captured = settle_and_capture(pid, window_id, path, expected)
    result = {"case": case, "typed": typed, "captured": captured, "screenshot": path if captured else None}
    if label == "caret":
        state = e2e.state()
        result["offer"] = state.get("offer")
        result["counters"] = state.get("counters")
    return result


def main():
    label, evidence = sys.argv[1], sys.argv[2]
    cases = sys.argv[3:] or ["mid", "mid2", "wrap", "narrow"]
    os.makedirs(evidence, exist_ok=True)
    results = []
    try:
        for case in cases:
            try:
                results.append(run_case(case, label, evidence))
            except e2e.UserActive as error:
                results.append({"case": case, "blocked": str(error)})
                break
            for pid in e2e.LAUNCHED:
                try:
                    os.kill(pid, 15)
                except ProcessLookupError:
                    pass
            e2e.LAUNCHED.clear()
            time.sleep(0.5)
    finally:
        for pid in e2e.LAUNCHED:
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass
    print(json.dumps(results, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
