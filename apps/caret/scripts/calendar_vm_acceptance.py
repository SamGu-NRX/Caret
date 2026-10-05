#!/usr/bin/env python3
"""H8 in the rig guest: the packaged Caret adds an event card's event to the user's default calendar,
the card names where it goes, Caret asks for Calendar access on the first Tab and not before, and ⌘Z
removes exactly that event. Every claim is read back through EventKit by calendar-tool, never from
Caret's own word.

  calendar_vm_acceptance.py --app Caret.app --tool calendar-tool --out DIR

Processes, all started here: acceptance_helper.ts (the real helper with a fake Jev that says yes to
the event sentence) on the bundle's own Node; CaretFixture.app with the executor window; the bundle's
caret-screen with --calendar-user, reading Caret's settings file as the shipped app's reader does; and
Caret itself, attached to that helper, started by launchd (launchctl bootstrap) so that Calendar's
prompt is Caret's own: a process started from this script would be judged by this script's
responsible process. The reader here is started by the script, so the job grants its responsible
process Calendar beforehand; Caret is granted nothing, and asks.

Keys go through the debug socket's `key` hook (the event tap's own decision code, no event posted).
The one press outside Caret is on macOS's prompt, by Accessibility. Captures are by window number.
Only in the rig guest: it changes the guest's calendar and TCC state.
"""
import argparse
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import time

import fixture_app
import surface_acceptance as sa

HERE = os.path.dirname(os.path.abspath(__file__))
EXECUTOR = "Caret Fixture — Executor"
# "at 3pm", not "at 3": since D2-03 a time the sentence leaves AM or PM open makes no card. A card from a time
# with no end asks how long it is (30 minutes first, highlighted); Tab takes the highlighted choice.
SENTENCE = "I'll grab coffee with Dana on Thursday at 3pm."
TITLE = "Coffee with Dana"
SECOND = "Lunch with Sam on Friday at 1pm."
LABEL = "dev.caret.h8-host"
UID = os.getuid()
SOCKS = tempfile.mkdtemp(prefix="caret-h8-")
HELPER_SOCK = os.path.join(SOCKS, "helper.sock")
sa.HOST_SOCK = os.path.join(SOCKS, "host.sock")
STATE = os.path.join(SOCKS, "helper-state.json")
TOOL = None


def helper_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def tool(*args):
    r = subprocess.run([TOOL, *args], capture_output=True, text=True, timeout=30)
    try:
        return json.loads(r.stdout) if r.stdout.strip() else {"error": r.stderr.strip()}
    except ValueError:
        return {"error": r.stderr.strip(), "raw": r.stdout[:300]}


def window_shot(out_dir, name, number):
    shots = os.path.join(out_dir, "shots")
    os.makedirs(shots, exist_ok=True)
    path = os.path.join(shots, f"{name}.png")
    return path if subprocess.run(["screencapture", "-x", "-o", f"-l{number}", path]).returncode == 0 else None


def shot(out_dir, fixture_pid, host_pid, name):
    old = sa.CLAIM
    sa.CLAIM = EXECUTOR
    try:
        return sa.shot(out_dir, fixture_pid, host_pid, name)
    finally:
        sa.CLAIM = old


def message_frame(pid):
    fields = [f for f in sa.ax(pid, "fields", pid) if f["window"] == EXECUTOR]
    return sorted(fields, key=lambda f: (f["frame"][1], f["frame"][0]))[3]["frame"]


def host_pid():
    out = subprocess.run(["launchctl", "print", f"gui/{UID}/{LABEL}"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("pid = "):
            return int(line.split("=")[1])
    return None


def start_host(app, settings, fixture_pid, out_dir):
    """Caret as a launchd job of its own, attached to this run's helper."""
    caret = os.path.join(app, "Contents", "MacOS", "Caret")
    plist = os.path.join(SOCKS, f"{LABEL}.plist")
    with open(plist, "wb") as f:
        plistlib.dump({
            "Label": LABEL,
            "ProgramArguments": [caret, "--socket", sa.HOST_SOCK, "--helper-socket", HELPER_SOCK, "--allow-pids", str(fixture_pid), "--no-ghost",
                                 "--test-hooks", "--settings", settings, "--status-item", "off", "--onboarding", "off"],
            "AssociatedBundleIdentifiers": ["dev.caret.host"],
            "StandardOutPath": os.path.join(out_dir, "host.log"),
            "StandardErrorPath": os.path.join(out_dir, "host.log"),
            "RunAtLoad": True,
            "KeepAlive": False,
            "ProcessType": "Interactive",
            "LimitLoadToSessionType": "Aqua",
        }, f)
    subprocess.run(["launchctl", "bootout", f"gui/{UID}/{LABEL}"], capture_output=True)
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{UID}", plist], capture_output=True, text=True)
    sa.check("Caret started by launchd", r.returncode == 0, rc=r.returncode, err=r.stderr.strip())
    sa.BEFORE_STOP.append(lambda: subprocess.run(["launchctl", "bootout", f"gui/{UID}/{LABEL}"], capture_output=True))
    if not sa.wait_for(lambda: os.path.exists(sa.HOST_SOCK), 20, 0.1):
        raise SystemExit("host did not open its socket")
    sa.wait_for(lambda: (sa.host().get("helper") or {}).get("connected"), 15, 0.2)
    return sa.wait_for(host_pid, 5, 0.1)


def progress(key, phases):
    return next((p for p in helper_state().get("progress", []) if p.get("taskId") == key and p.get("phase") in phases), None)


def run(app, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    results = {"steps": []}
    why = fixture_app.why_not_foreground(sa.IDLE_MIN)
    if why:
        raise SystemExit(why)
    sa.RUN_START = time.time()
    before = sa.front_pid()
    # The tool's own access (the job granted it), not Caret's: Caret's is read from its debug state below.
    results["toolAccess"] = tool("status")
    node = os.path.join(app, "Contents", "Helpers", "node")
    reader = os.path.join(app, "Contents", "Helpers", "caret-screen")
    secret = os.urandom(32)
    helper = sa.start("helper", [node, os.path.join(HERE, "acceptance_helper.ts"), "--auth-fd", "0", "--socket", HELPER_SOCK, "--state", STATE,
                                 "--calendar", "reader"], out_dir, stdin=subprocess.PIPE)
    helper.stdin.write(secret)
    helper.stdin.close()
    if not sa.wait_for(lambda: os.path.exists(HELPER_SOCK), 30, 0.1):
        raise SystemExit("helper did not open its socket")
    fx = sa.start("fixture", fixture_app.args("--windows", "executor", "--duration", "900"), out_dir, stdin=subprocess.PIPE)
    sa.BEFORE_STOP.append(lambda: fixture_app.hand_back(fx, before.get("pid")))
    time.sleep(1)
    ok, now = fixture_app.activate(fx, sa.front_pid)
    if not ok:
        raise SystemExit(f"deferred: foreground (activate legacy, front={now})")
    settings = os.path.join(out_dir, "settings.json")
    with open(settings, "w") as f:
        json.dump({"version": 2, "roles": ["calendar"], "level": "balanced", "character": "pebble", "paused": False, "onboarded": True, "memory": []}, f)
    rd = sa.start("reader", [reader, "--auth-fd", "0", "--socket", HELPER_SOCK, "--only-pids", str(fx.pid), "--event-pids", str(fx.pid),
                             "--calendar-user", settings], out_dir, stdin=subprocess.PIPE)
    rd.stdin.write(secret)
    rd.stdin.close()
    hpid = start_host(app, settings, fx.pid, out_dir)
    time.sleep(1.5)
    pid = fx.pid

    # 1. Launch asks nothing.
    s = sa.host()
    cal = s.get("calendar") or {}
    sa.check("at launch Caret has not asked: access notDetermined, no prompt on screen",
             cal.get("access") == "notDetermined" and tool("prompt", "Caret") is None, calendar=cal)
    sa.check("before access the line names the default calendar", cal.get("line") == "Adding to your default calendar", calendar=cal)

    # 2. The card names the destination. The guest's screen is 960 by 600 points, and the executor window
    # fills most of its height: centred, every spot by the Message field covers one of its fields
    # (noClearSpot in the first runs). At the screen's left edge the card fits to the field's right.
    moved = sa.ax(pid, "move", pid, EXECUTOR, 0, 30)
    sa.check("the fixture window moved to the screen's left edge", moved.get("ok"), moved=moved)
    time.sleep(0.5)
    frame = message_frame(pid)
    sa.ax(pid, "focus", pid, sa.frame_arg(frame))
    time.sleep(0.4)
    r = sa.ax(pid, "set-field", pid, sa.frame_arg(frame), SENTENCE)
    sa.check("the sentence is in the Message field", r.get("ok") and r.get("value") == SENTENCE, result=r)
    s = sa.wait_for(lambda: (lambda st: st if (st.get("offer") or {}).get("kind") == "action" else None)(sa.host()), 20, 0.1)
    results["modelAfterSentence"] = helper_state().get("model")
    sa.check("the event line is drawn", bool(s), offers=helper_state().get("offers"), asked=helper_state().get("asked"))
    k = sa.key("down", pid)
    time.sleep(0.3)
    sf = sa.host().get("surface") or {}
    sa.check("the card says where the event goes", (sf.get("ui") or {}).get("expanded") and sf.get("eventDestination") == "Adding to your default calendar",
             key=k, eventDestination=sf.get("eventDestination"), panel=sf.get("panel"))
    results["steps"].append({"step": "card", "shot": shot(out_dir, pid, hpid, "1-card-before-access")})

    # 3. Tab asks macOS, and nothing reaches the helper until it is answered.
    k = sa.key("tab", pid)
    acc = (sa.host().get("surface") or {}).get("lastAccepted") or {}
    key_ = acc.get("offerKey")
    prompt = sa.wait_for(lambda: tool("prompt", "Caret"), 15, 0.3)
    sa.check("Tab puts macOS's Calendar prompt up, naming Caret", bool(prompt) and k.get("consumed"), prompt=prompt, accepted=acc)
    sa.check("no accept reached the helper while macOS asks", progress(key_, ("done", "handoff", "stopped", "started", "step")) is None and not helper_state().get("grants"),
             grants=helper_state().get("grants"), progress=helper_state().get("progress"))
    for i, n in enumerate((prompt or {}).get("windows", [])):
        results["steps"].append({"step": "prompt", "shot": window_shot(out_dir, f"2-prompt-{i}", n)})
    results["prompt"] = prompt

    # 4. Allow; the event goes to the default calendar.
    pressed = tool("allow", "Caret")
    sa.check("the prompt's Allow is pressed", pressed.get("pressed") is True, pressed=pressed)
    end = sa.wait_for(lambda: progress(key_, ("done", "handoff", "stopped")), 30, 0.2)
    sa.check("the run ends done", (end or {}).get("phase") == "done", end=end)
    # The toast with ⌘Z lives 5 s: the capture and the read-back come first, quickly, then ⌘Z.
    results["steps"].append({"step": "after-add", "shot": shot(out_dir, pid, hpid, "2b-after-add")})
    default = tool("default")
    found = tool("find", TITLE, "9")
    results["default"], results["found"] = default, found
    ev = found[0] if isinstance(found, list) and len(found) == 1 else None
    sa.check("exactly one such event, in the default calendar for new events, Thursday 15:00 to 15:30 on the guest's clock",
             ev is not None and ev.get("calendarId") == (default or {}).get("id") and ev.get("startLocal") == "Thursday 15:00" and ev.get("endLocal") == "Thursday 15:30",
             default=default, found=found)
    # 5. ⌘Z while the toast holds it.
    k = sa.key("cmd-z", pid)
    undone = sa.wait_for(lambda: progress(key_, ("undone",)), 20, 0.2)
    sa.check("⌘Z undoes the run", k.get("consumed") and bool(undone), key=k, undone=undone, progress=helper_state().get("progress"))
    gone = tool("event", ev["id"]) if ev else "no event"
    after = tool("find", TITLE, "9")
    sa.check("undo removed exactly that event: its id is gone and no such event is left", gone is None and after == [], event=gone, found=after)
    results["steps"].append({"step": "after-undo", "shot": shot(out_dir, pid, hpid, "3-after-undo")})

    # 6. With access, the next card names the calendar.
    cal = sa.host().get("calendar") or {}
    sa.check("access is full now, and the line names the calendar", cal.get("access") == "fullAccess" and cal.get("line") == f"Adding to {(default or {}).get('title')}",
             calendar=cal, default=default)
    sa.ax(pid, "set-field", pid, sa.frame_arg(frame), SECOND)
    s = sa.wait_for(lambda: (lambda st: st if (st.get("offer") or {}).get("kind") == "action" and (st.get("surface") or {}).get("offerKey") != key_ else None)(sa.host()), 20, 0.1)
    sa.key("down", pid)
    time.sleep(0.3)
    sf = sa.host().get("surface") or {}
    sa.check("the next card says Adding to the default calendar by name", sf.get("eventDestination") == f"Adding to {(default or {}).get('title')}",
             eventDestination=sf.get("eventDestination"), drawn=bool(s))
    results["steps"].append({"step": "second-card", "shot": shot(out_dir, pid, hpid, "4-card-with-access")})
    sa.key("esc", pid)
    results["calendarAfter"] = tool("find", "Lunch with Sam", "9")
    sa.check("Esc adds nothing", results["calendarAfter"] == [], found=results["calendarAfter"])
    results["helper"] = helper_state()
    results["hostLog"] = os.path.join(out_dir, "host.log")
    return results


def main():
    global TOOL
    p = argparse.ArgumentParser()
    p.add_argument("--app", required=True)
    p.add_argument("--tool", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    TOOL = a.tool
    results = {}
    lease = fixture_app.GuiLease()
    dog = fixture_app.Watchdog(lambda t: any(x - 0.2 <= t <= y for x, y in sa.SYNTHETIC), sa.front_pid, sa.NAMES)
    stopped_by = None
    try:
        lease.__enter__()
        dog.__enter__()
        results = run(a.app, a.out)
    except KeyboardInterrupt:
        stopped_by = f"deferred: user active (input at {dog.tripped})" if dog.tripped else "interrupted"
    except SystemExit as e:
        stopped_by = str(e)
    finally:
        dog.__exit__()
        for hand_back in sa.BEFORE_STOP:
            hand_back()
        sa.stop_all()
        lease.__exit__()
        if stopped_by:
            results["stoppedBy"] = stopped_by
        results["checks"] = sa.CHECKS
        results["passed"] = sum(c["ok"] for c in sa.CHECKS)
        results["failed"] = sum(not c["ok"] for c in sa.CHECKS)
        os.makedirs(a.out, exist_ok=True)
        with open(os.path.join(a.out, "results.json"), "w") as f:
            json.dump(results, f, indent=2, sort_keys=True, default=str)
        sa.log("summary", results["passed"], "passed,", results["failed"], "failed", stopped_by or "")
    sys.exit(76 if stopped_by else (1 if results["failed"] else 0))


if __name__ == "__main__":
    main()
