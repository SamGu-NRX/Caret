#!/usr/bin/env python3
"""End-to-end host check in a TextEdit document this script creates.

  e2e_textedit.py accept <case> <evidence_dir>
      case "end": type a seed sentence into an empty document, wait for an offer, press Tab,
      and verify the document holds seed + offer.
      case "mid": open a document with an existing sentence, move the caret into the middle,
      type a few characters, wait for an offer, press Tab, and verify prefix + typed + offer +
      suffix.
  e2e_textedit.py latency <evidence_dir> [interval_ms]
      type a long passage key by key and report the host's keystroke-to-paint samples.

Requires a running Caret host (scripts/host-state.py must answer). cua-driver launches and
frames the fixture window, captures screenshots and runs verify_state. Keystrokes go through
fixture-keys, which posts at the HID level and refuses to type unless the fixture is focused.
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS = os.path.join(HERE, "..", ".build", "fixture-keys")
STATE = os.path.join(HERE, "host-state.py")
CAPTURE = os.path.join(HERE, "capture-window.py")
FIXTURES = os.path.expanduser("~/.caret-run/fixtures")
LAUNCHED = []
FRAME = {"x": 200, "y": 120, "width": 640, "height": 400}


def cua(tool, args):
    out = subprocess.run(["cua-driver", tool, json.dumps(args)], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"{tool} failed: {out.stdout} {out.stderr}")
    return json.loads(out.stdout)


def state(command="state"):
    return json.loads(subprocess.run([sys.executable, STATE, command], capture_output=True, text=True, check=True).stdout)


def keys(pid, *args):
    subprocess.run([KEYS, str(pid), *map(str, args)], check=True)


def open_fixture(name, text):
    """A fresh TextEdit instance on a plain-text file holding `text`, framed and focused."""
    os.makedirs(FIXTURES, exist_ok=True)
    path = os.path.join(FIXTURES, name)
    with open(path, "w") as handle:
        handle.write(text)
    launched = cua("launch_app", {
        "bundle_id": "com.apple.TextEdit", "urls": [path], "creates_new_application_instance": True,
    })
    pid = launched["pid"]
    LAUNCHED.append(pid)
    window_id = None
    for _ in range(50):
        windows = cua("list_windows", {"pid": pid})["windows"]
        match = [w for w in windows if w["title"] == name]
        if match:
            window_id = match[0]["window_id"]
            break
        time.sleep(0.1)
    if window_id is None:
        raise RuntimeError(f"no window for {name}")
    cua("set_window_frame", {"pid": pid, "window_id": window_id, **FRAME})
    # Another tool's focus-restore can hand the foreground back shortly after; retry until the
    # fixture has held it for a moment.
    for _ in range(5):
        cua("bring_to_front", {"pid": pid, "window_id": window_id})
        time.sleep(1.0)
        if subprocess.run([KEYS, str(pid), "check"], capture_output=True).returncode == 0:
            return pid, window_id, path
    raise RuntimeError("fixture could not keep the foreground")


def wait_offer(after_id=0, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        offer = state().get("offer")
        if offer and offer["id"] > after_id and offer["ageMs"] > 120:
            return offer
        time.sleep(0.05)
    return None


def verify_value(pid, window_id, expected):
    result = cua("verify_state", {
        "pid": pid, "window_id": window_id,
        "expect": [{"element": {"selector": {"role": "AXTextArea"}, "value_equals": expected}}],
    })
    return result


def accept(case, evidence):
    os.makedirs(evidence, exist_ok=True)
    if case == "end":
        pid, window_id, _ = open_fixture("caret-accept-end.txt", "")
        prefix, suffix = "", ""
        typed = "Thanks again for sending the notes from"
    elif case == "mid":
        prefix, suffix = "I read your ", " and they were clear."
        pid, window_id, _ = open_fixture("caret-accept-mid.txt", prefix + suffix)
        # Opening puts the caret at 0; walk it to the end of the prefix.
        keys(pid, "key", "right", len(prefix))
        typed = "detailed meeting no"
    else:
        raise SystemExit(f"unknown case {case}")

    before = state()
    last_offer_id = before["offer"]["id"] if before.get("offer") else 0
    keys(pid, "type", typed, 140)
    offer = wait_offer(last_offer_id)
    report = {"case": case, "typed": typed, "prefix": prefix, "suffix": suffix, "offer": offer}
    if not offer:
        report["result"] = "no offer"
        return report
    subprocess.run([sys.executable, CAPTURE, str(pid), str(window_id), os.path.join(evidence, f"caret-{case}-offer.png")], check=True)
    claim_before = (state().get("lastInsertion") or {}).get("claimID", 0)
    keys(pid, "key", "tab")
    insertion = json.loads(subprocess.run(
        [sys.executable, STATE, "wait-insertion", str(claim_before), "5"], capture_output=True, text=True
    ).stdout or "null")
    report["insertion"] = insertion
    expected = prefix + typed + offer["text"] + suffix
    report["expected_value"] = expected
    report["verify_state"] = verify_value(pid, window_id, expected)
    subprocess.run([sys.executable, CAPTURE, str(pid), str(window_id), os.path.join(evidence, f"caret-{case}-accepted.png")], check=True)
    report["host"] = {k: state()[k] for k in ("lastClaim", "lastInsertion", "counters")}
    report["result"] = report["verify_state"].get("status")
    return report


PASSAGE = (
    "Hi Maya, thanks for the update on the launch plan. I read through the timeline and it looks "
    "good to me. Could you send the final numbers before the meeting on Thursday? I would also like "
    "to see the draft of the announcement so we can review it together. Let me know if anything "
    "changes and I will update the team. Thanks again for pulling this together so quickly."
)


def latency(evidence, interval_ms):
    os.makedirs(evidence, exist_ok=True)
    pid, window_id, _ = open_fixture("caret-latency.txt", "")
    state("latency-reset")
    start = state()
    keys(pid, "type", PASSAGE, interval_ms)
    time.sleep(1.0)
    end = state()
    summary = end["latency"]
    return {
        "interval_ms": interval_ms,
        "keystrokes": len(PASSAGE),
        "tap_keydowns": end["tap"]["keyDowns"] - start["tap"]["keyDowns"],
        "samples": summary["count"],
        "p50_ms": summary.get("p50Ms"),
        "p95_ms": summary.get("p95Ms"),
        "max_ms": summary.get("maxMs"),
        "samples_ms": summary["samplesMs"],
        "tap": end["tap"],
        "counters_delta": {k: v - start["counters"].get(k, 0) for k, v in end["counters"].items()},
    }


def main():
    try:
        if sys.argv[1] == "accept":
            report = accept(sys.argv[2], sys.argv[3])
        elif sys.argv[1] == "latency":
            report = latency(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 200)
        else:
            raise SystemExit(__doc__)
        print(json.dumps(report, indent=2, sort_keys=True))
    finally:
        # Each run owns one TextEdit instance on a synthetic file; nothing in it needs saving.
        # cua-driver's kill_app refuses processes started by another CLI session, so signal it.
        for pid in LAUNCHED:
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass


if __name__ == "__main__":
    main()
