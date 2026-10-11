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
# Where fixtures are placed, in global points. It must be on a display that is actually drawing:
# on 2026-10-02 the primary display captured black, so the default sits on the laptop panel.
_frame = [float(v) for v in os.environ.get("CARET_E2E_FRAME", "600,1520,640,400").split(",")]
FRAME = {"x": _frame[0], "y": _frame[1], "width": _frame[2], "height": _frame[3]}


def cua(tool, args):
    out = subprocess.run(["cua-driver", tool, json.dumps(args)], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"{tool} failed: {out.stdout} {out.stderr}")
    return json.loads(out.stdout)


def state(command="state"):
    for attempt in range(5):
        out = subprocess.run([sys.executable, STATE, command], capture_output=True, text=True)
        if out.returncode == 0:
            return json.loads(out.stdout)
        time.sleep(0.5)
    raise RuntimeError(f"host socket did not answer: {out.stderr.strip()}")


def capture(pid, window_id, path):
    subprocess.run([sys.executable, CAPTURE, str(pid), str(window_id), path], check=True, capture_output=True)


def keys(pid, *args):
    subprocess.run([KEYS, str(pid), *map(str, args)], check=True)


class UserActive(RuntimeError):
    """Someone else is using this Mac. Tests stop instead of competing for the foreground."""


IDLE_MIN_SECONDS = float(os.environ.get("CARET_E2E_IDLE_MIN", "600"))
# Wall-clock time of our last synthetic key, shared across runs: our own keys reset the HID idle
# clock, so "no input since our last key" is the test for a run that follows another.
STAMP = os.path.expanduser("~/.caret-run/logs/e2e-last-synthetic-key")
LAST_SYNTHETIC = None


def hid_idle_seconds():
    out = subprocess.run(["ioreg", "-c", "IOHIDSystem"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if "HIDIdleTime" in line:
            return int(line.split()[-1]) / 1e9
    return 0.0


def last_synthetic_age():
    if LAST_SYNTHETIC is not None:
        return time.time() - LAST_SYNTHETIC
    try:
        return time.time() - float(open(STAMP).read())
    except (OSError, ValueError):
        return None


def require_idle():
    """No user input for IDLE_MIN_SECONDS, or none since our own last key (from this or an earlier
    run that itself started on an idle Mac)."""
    # The screen track's GUI experiments run a `caret-fixture` app that needs the foreground.
    if subprocess.run(["pgrep", "-x", "caret-fixture"], capture_output=True).returncode == 0:
        raise UserActive("another builder's caret-fixture GUI run is active")
    idle = hid_idle_seconds()
    age = last_synthetic_age()
    if age is not None and age < IDLE_MIN_SECONDS * 2 and idle + 1.0 >= age:
        return
    if idle < IDLE_MIN_SECONDS:
        raise UserActive(f"user input {idle:.0f}s ago; need {IDLE_MIN_SECONDS:.0f}s idle")


class FocusLost(RuntimeError):
    """The fixture lost the foreground with no user input (an app activating itself)."""

    def __init__(self, sent):
        super().__init__(f"focus lost after {sent}")
        self.sent = sent


def run_keys(pid, *args):
    global LAST_SYNTHETIC
    require_idle()
    out = subprocess.run([KEYS, str(pid), *map(str, args)], capture_output=True, text=True)
    LAST_SYNTHETIC = time.time()
    with open(STAMP, "w") as handle:
        handle.write(str(LAST_SYNTHETIC))
    if out.returncode == 3:
        raise FocusLost(int(out.stdout.split()[-1]) if out.stdout.strip() else 0)
    out.check_returncode()
    return out


def focus(pid, window_id):
    """Bring the fixture forward. Every attempt first checks for user input and stops the run if
    there was any, so re-acquiring only ever competes with apps that activate themselves."""
    for _ in range(10):
        require_idle()
        cua("bring_to_front", {"pid": pid, "window_id": window_id})
        for _ in range(20):
            time.sleep(0.1)
            if subprocess.run([KEYS, str(pid), "check"], capture_output=True).returncode == 0:
                return
    raise UserActive("fixture could not get the foreground")


def focused(pid):
    return subprocess.run([KEYS, str(pid), "check"], capture_output=True).returncode == 0


def send(pid, window_id, mode, payload, extra):
    """Types `payload`, re-focusing and resuming where it stopped if an app took the foreground."""
    remaining = payload
    for _ in range(30):
        focus(pid, window_id)
        try:
            run_keys(pid, mode, remaining, *extra)
            return
        except FocusLost as lost:
            remaining = remaining[lost.sent:]
            if not remaining:
                return
    raise UserActive("kept losing the foreground")


def send_keys(pid, window_id, key, count):
    remaining = count
    for _ in range(30):
        focus(pid, window_id)
        try:
            run_keys(pid, "key", key, remaining)
            return
        except FocusLost as lost:
            remaining -= lost.sent
            if remaining <= 0:
                return
    raise UserActive("kept losing the foreground")


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


# Mid-sentence fixtures, tried in order until one gets an offer. KeyType's mid-line gate is a
# confidence threshold, and these sit near it: the same text can be offered on one run and not
# the next.
MID_CASES = [
    ("Can we move the", " to Friday?"),
    ("We should schedule a call for next", " to go over it."),
    ("Please send me the", " by Monday."),
    ("I will be in the", " all afternoon."),
]


def accept(case, evidence):
    os.makedirs(evidence, exist_ok=True)
    if case == "end":
        return accept_one(case, evidence, "", "", "I will send you the report by the end of the ")
    if case == "midword":
        return accept_one(case, evidence, "I read your ", " and they were clear.", "detailed meeting no")
    if case == "mid":
        tried = []
        for prefix, suffix in MID_CASES:
            report = accept_one(case, evidence, prefix, suffix, "")
            if report.get("result") == "satisfied":
                report["mid_cases_without_offer"] = tried
                return report
            tried.append(prefix + "|" + suffix)
            stop_fixtures()
        return {"case": case, "result": "no offer accepted", "mid_cases_without_offer": tried}
    raise SystemExit(f"unknown case {case}")


def stop_fixtures():
    for pid in LAUNCHED:
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
    LAUNCHED.clear()


def accept_one(case, evidence, prefix, suffix, typed):
    """Opens a fixture holding prefix + suffix, puts the caret between them, types `typed`, waits
    for an offer, presses Tab and verifies the document."""
    pid, window_id, _ = open_fixture(f"caret-accept-{case}.txt", prefix + suffix)
    if prefix and suffix:
        # Opening puts the caret at 0; walk it to the end of the prefix.
        send_keys(pid, window_id, "right", len(prefix))
    if typed:
        send(pid, window_id, "type", typed, ["60"])
    report = {"case": case, "typed": typed, "prefix": prefix, "suffix": suffix}
    insertion = None
    offer = None
    for _ in range(4):
        focus(pid, window_id)
        offer = wait_offer(pid)
        if not offer or not focused(pid):
            continue
        capture(pid, window_id, os.path.join(evidence, f"caret-{case}-offer.png"))
        claim_before = (state().get("lastInsertion") or {}).get("claimID", 0)
        try:
            run_keys(pid, "key", "tab")
        except FocusLost:
            continue
        insertion = json.loads(subprocess.run(
            [sys.executable, STATE, "wait-insertion", str(claim_before), "5"], capture_output=True, text=True
        ).stdout or "null")
        break
    report["offer"] = offer
    if not insertion:
        report["result"] = "no offer accepted"
        report["counters"] = state().get("counters")
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
