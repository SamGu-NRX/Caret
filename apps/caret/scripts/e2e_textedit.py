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
    for attempt in range(3):
        out = subprocess.run([sys.executable, STATE, command], capture_output=True, text=True)
        if out.returncode == 0:
            return json.loads(out.stdout)
        time.sleep(0.2)
    raise RuntimeError(f"host socket did not answer: {out.stderr.strip()}")


def capture(pid, window_id, path):
    subprocess.run([sys.executable, CAPTURE, str(pid), str(window_id), path], check=True, capture_output=True)


def keys(pid, *args):
    subprocess.run([KEYS, str(pid), *map(str, args)], check=True)


class UserActive(RuntimeError):
    """Someone else is using this Mac. Tests stop instead of competing for the foreground."""


IDLE_MIN_SECONDS = float(os.environ.get("CARET_E2E_IDLE_MIN", "600"))
LAST_SYNTHETIC = None  # monotonic time our last synthetic key finished


def hid_idle_seconds():
    out = subprocess.run(["ioreg", "-c", "IOHIDSystem"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if "HIDIdleTime" in line:
            return int(line.split()[-1]) / 1e9
    return 0.0


def require_idle():
    """Before the first key: no user input for IDLE_MIN_SECONDS. Afterwards our own keys reset the
    idle clock, so the check becomes: no input since our last key."""
    idle = hid_idle_seconds()
    if LAST_SYNTHETIC is None:
        if idle < IDLE_MIN_SECONDS:
            raise UserActive(f"user input {idle:.0f}s ago; need {IDLE_MIN_SECONDS:.0f}s idle")
        return
    since = time.monotonic() - LAST_SYNTHETIC
    if idle + 1.0 < since:
        raise UserActive(f"user input {idle:.1f}s ago, after our last key {since:.1f}s ago")


def run_keys(pid, *args):
    global LAST_SYNTHETIC
    require_idle()
    out = subprocess.run([KEYS, str(pid), *map(str, args)], capture_output=True, text=True)
    LAST_SYNTHETIC = time.monotonic()
    if out.returncode == 3:
        raise UserActive("fixture lost focus: " + out.stderr.strip())
    out.check_returncode()
    return out


def focus(pid, window_id):
    """Bring the fixture forward once. Losing it later means someone else took the foreground, so
    callers abort instead of taking it back."""
    require_idle()
    cua("bring_to_front", {"pid": pid, "window_id": window_id})
    time.sleep(0.4)
    if subprocess.run([KEYS, str(pid), "check"], capture_output=True).returncode != 0:
        raise UserActive("fixture did not get the foreground")


def still_focused(pid):
    require_idle()
    if subprocess.run([KEYS, str(pid), "check"], capture_output=True).returncode != 0:
        raise UserActive("fixture lost the foreground")


def send(pid, window_id, mode, payload, extra):
    run_keys(pid, mode, payload, *extra)
    return 0


def send_keys(pid, window_id, key, count):
    run_keys(pid, "key", key, count)


def textedit_pids():
    out = subprocess.run(["pgrep", "-x", "TextEdit"], capture_output=True, text=True).stdout
    return [int(p) for p in out.split()]


def open_fixture(name, text):
    """A fresh TextEdit instance on a plain-text file holding `text`, framed and focused."""
    os.makedirs(FIXTURES, exist_ok=True)
    path = os.path.join(FIXTURES, name)
    with open(path, "w") as handle:
        handle.write(text)
    before = set(textedit_pids())
    launched = cua("launch_app", {
        "bundle_id": "com.apple.TextEdit", "urls": [path], "creates_new_application_instance": True,
    })
    pid = launched["pid"]
    if pid in before:
        raise RuntimeError(f"launch_app returned an existing TextEdit ({pid}); refusing to use or stop it")
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
    focus(pid, window_id)
    return pid, window_id, path


def wait_offer(pid, timeout=4.0):
    """An offer for the fixture that has been on screen for a moment (settled, not mid-update)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        offer = state().get("offer")
        if offer and offer["pid"] == pid and offer["ageMs"] > 150:
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
        typed = "I will send you the report by the end of the "
    elif case == "mid":
        prefix, suffix = "I read your ", " and they were clear."
        pid, window_id, _ = open_fixture("caret-accept-mid.txt", prefix + suffix)
        # Opening puts the caret at 0; walk it to the end of the prefix.
        send_keys(pid, window_id, "right", len(prefix))
        typed = "detailed meeting no"
    else:
        raise SystemExit(f"unknown case {case}")

    send(pid, window_id, "type", typed, ["60"])
    report = {"case": case, "typed": typed, "prefix": prefix, "suffix": suffix}
    insertion = None
    offer = wait_offer(pid)
    if offer:
        still_focused(pid)
        capture(pid, window_id, os.path.join(evidence, f"caret-{case}-offer.png"))
        claim_before = (state().get("lastInsertion") or {}).get("claimID", 0)
        run_keys(pid, "key", "tab")
        insertion = json.loads(subprocess.run(
            [sys.executable, STATE, "wait-insertion", str(claim_before), "5"], capture_output=True, text=True
        ).stdout or "null")
    report["offer"] = offer
    if not insertion:
        report["result"] = "no offer accepted"
        return report
    report["insertion"] = insertion
    # What Tab actually inserted; it equals the offer read above unless the offer was refreshed in
    # between, which the report shows.
    expected = prefix + typed + insertion["text"] + suffix
    report["offer_matches_insertion"] = insertion["text"] == offer["text"]
    report["expected_value"] = expected
    report["verify_state"] = verify_value(pid, window_id, expected)
    # Only photograph a document that holds exactly the synthetic text: a failed paste can put
    # the user's own clipboard into the fixture, and that must not land in evidence.
    if report["verify_state"].get("status") == "satisfied":
        capture(pid, window_id, os.path.join(evidence, f"caret-{case}-accepted.png"))
    else:
        # The document holds something other than our synthetic text; drop the earlier capture.
        offer_png = os.path.join(evidence, f"caret-{case}-offer.png")
        if os.path.exists(offer_png):
            os.unlink(offer_png)
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
    send(pid, window_id, "type", PASSAGE, [str(interval_ms)])
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
    except UserActive as error:
        print(json.dumps({"blocked": "user active", "reason": str(error)}))
        sys.exit(4)
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
