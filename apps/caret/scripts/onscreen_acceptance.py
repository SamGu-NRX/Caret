#!/usr/bin/env python3
"""A13 on screen: the event card from a sentence typed into caret-fixture, and Ask Caret in the
activity list, each with the host's surfaces drawn and the real helper (fake Jev) behind them.

  onscreen_acceptance.py event-fake <evidence_dir> [light|dark]     the helper's fake calendar
  onscreen_acceptance.py event-reader <evidence_dir> [light|dark]   the reader's --calendar-test path
  onscreen_acceptance.py ask <evidence_dir> [light|dark]

Processes, all started here and only these signalled: acceptance_helper.ts (the real helper with a
fake Jev, on its own socket), CaretFixture.app with the executor window, the reader caret-screen with
only the fixture's pid (and --calendar-test for event-reader; never --act-pids), and the built host
limited to the fixture's pid, ghost text off, its menu bar item off.

event: the fixture's Message field is focused and given the sentence by an AX value write; the
helper's event generator asks the fake Jev and offers the line; the host draws it at the field; ↓
opens the card ("Add to calendar", no calendar named), Tab sends offerAccept through the event tap's
own routing (debug socket `key`, no event posted), and the helper adds the event: to its fake
calendar (event-fake), or through the reader's EventKit adapter (event-reader), which on a Mac that
has not granted Calendar access answers `blocked: tcc` without asking, so the host shows the line
naming what is missing.

ask: the menu's Ask Caret (`ask open`) puts the activity list up with its field key, while the
fixture stays the active app. Text goes into the field and Return, Tab and Esc are pressed as key events
posted to the host's pid alone (pid-keys.swift, CGEventPostToPid; no window raised, nothing posted
to the HID stream or the session tap; cua-driver's background route refuses Caret's panels); the card lists the write and the Send left to the user; Tab runs it; the field is read back
and Send is never pressed. If a background key does not land, the step falls back to the debug
socket's `ask` hook and says so.

Every GUI gate of fixture_app.py: the gui lease, gui.lock held by the caller, 300 s idle, no quiet
window; a watchdog stops the run on any input. Screenshots are of this run's own windows only, by
window number.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

import fixture_app
import surface_acceptance as sa

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = sa.ROOT
SCREEN_BIN = os.environ.get("CARET_FIXTURE_BIN_DIR") or os.path.join(ROOT, "apps", "screen-reader", ".build", "debug")
EXECUTOR = "Caret Fixture — Executor"
SENTENCE = "I'll grab coffee with Dana on Thursday at 3."
INSTRUCTION = "Write 'See you at 3' in Message and send it"
SOCKS = tempfile.mkdtemp(prefix="caret-a13-gui-")
HELPER_SOCK = os.path.join(SOCKS, "helper.sock")
sa.HOST_SOCK = os.path.join(SOCKS, "host.sock")
STATE = os.path.join(SOCKS, "helper-state.json")


def helper_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def own_window_shot(out_dir, name, window_number):
    shots = os.path.join(out_dir, "shots")
    os.makedirs(shots, exist_ok=True)
    path = os.path.join(shots, f"{name}.png")
    ok = subprocess.run(["screencapture", "-x", "-o", f"-l{window_number}", path]).returncode == 0
    return path if ok else None


def shot(out_dir, fixture_pid, host_pid, name):
    """The executor window and the host's panels, each by window number (sa.shot with this window)."""
    old = sa.CLAIM
    sa.CLAIM = EXECUTOR
    try:
        return sa.shot(out_dir, fixture_pid, host_pid, name)
    finally:
        sa.CLAIM = old


def message_frame(pid):
    fields = [f for f in sa.ax(pid, "fields", pid) if f["window"] == EXECUTOR]
    # Name, Email, Reference, Message, Event title from the top, then the two boxes.
    top = sorted(fields, key=lambda f: (f["frame"][1], f["frame"][0]))
    return top[3]["frame"]


def fixture_dump(fx, out_dir):
    fx.stdin.write(b"dump\n")
    fx.stdin.flush()
    time.sleep(0.4)
    with open(os.path.join(out_dir, "fixture.log")) as f:
        lines = [l for l in f.read().splitlines() if l.startswith("{") and '"fields"' in l]
    return json.loads(lines[-1]) if lines else {}


PIDKEYS = os.path.join(ROOT, "apps", "caret", ".build", "pid-keys")


def pid_keys(pid, *keys):
    """Keys posted to the host's pid only (CGEventPostToPid), its executable rechecked before each.
    cua-driver's background route refuses here: Caret's panels are not in the host's AXWindows."""
    # Events posted to a pid reset HIDIdleTime as a person's would (A13: the watchdog stopped the
    # first ask run at the first posted key). Each burst is this run's own input, so the watchdog
    # ignores input inside its window, as it does for the host's own Tab; a person's key inside
    # that window is missed.
    chars = sum(len(k) - 5 if k.startswith("text:") else 1 for k in keys)
    sa.expect_synthetic(2.0 + 0.03 * chars)
    out = subprocess.run([PIDKEYS, str(pid), "Caret", *keys], capture_output=True, text=True)
    try:
        return json.loads(out.stdout or "{}")
    except ValueError:
        return {"raw": out.stdout[:300], "err": out.stderr[:300]}


def rig(out_dir, appearance, calendar):
    os.makedirs(out_dir, exist_ok=True)
    why = fixture_app.why_not_foreground(sa.IDLE_MIN)
    if why:
        raise SystemExit(why)
    sa.RUN_START = time.time()
    before = sa.front_pid()
    # B23: the reader accepts only a helper holding this run's launch secret; both get it on stdin, and Caret gets the
    # host key derived from it (launch_secret.py).
    sa.start_with_secret("helper", ["node", os.path.join(HERE, "acceptance_helper.ts"), "--auth-fd", "0", "--socket", HELPER_SOCK, "--state", STATE,
                                    "--calendar", "reader" if calendar == "reader" else "fake"], out_dir)
    if not sa.wait_for(lambda: os.path.exists(HELPER_SOCK), 20, 0.1):
        raise SystemExit("helper did not open its socket")
    fx = sa.start("fixture", fixture_app.args("--windows", "executor", "--duration", "900", "--appearance", appearance), out_dir, stdin=subprocess.PIPE)
    sa.BEFORE_STOP.append(lambda: fixture_app.hand_back(fx, before.get("pid")))
    time.sleep(1)
    ok, now = fixture_app.activate(fx, sa.front_pid)
    if not ok:
        raise SystemExit(f"deferred: foreground (activate legacy, front={now})")
    sa.check("fixture activated and frontmost (NSWorkspace and lsappinfo)", True, before=before, after=now)
    reader_args = [os.path.join(SCREEN_BIN, "caret-screen"), "--auth-fd", "0", "--socket", HELPER_SOCK, "--only-pids", str(fx.pid), "--event-pids", str(fx.pid)]
    if calendar == "reader":
        reader_args.append("--calendar-test")
    sa.start_with_secret("reader", reader_args, out_dir)
    # The run's own settings: every role off but the calendar, so no other offer competes.
    settings = os.path.join(out_dir, "settings.json")
    with open(settings, "w") as f:
        json.dump({"version": 2, "roles": ["calendar"], "level": "balanced", "character": "pebble", "paused": False, "onboarded": True, "memory": []}, f)
    h = sa.start_caret("host", [sa.CARET, "--socket", sa.HOST_SOCK, "--helper-socket", HELPER_SOCK, "--allow-pids", str(fx.pid), "--no-ghost",
                          "--test-hooks", "--appearance", appearance, "--settings", settings, "--status-item", "off"], out_dir)
    if not sa.wait_for(lambda: os.path.exists(sa.HOST_SOCK), 15, 0.1):
        raise SystemExit("host did not open its socket")
    sa.wait_for(lambda: (sa.host().get("helper") or {}).get("connected"), 15, 0.2)
    time.sleep(1.5)
    return fx, h


def event(out_dir, appearance, calendar):
    fx, h = rig(out_dir, appearance, calendar)
    pid = fx.pid
    results = {"pid": pid, "calendar": calendar, "steps": []}
    frame = message_frame(pid)
    sa.ax(pid, "focus", pid, sa.frame_arg(frame))
    time.sleep(0.4)
    before = sa.watch(pid)
    r = sa.ax(pid, "set-field", pid, sa.frame_arg(frame), SENTENCE)
    sa.check("the sentence is in the Message field", r.get("ok") and r.get("value") == SENTENCE, result=r)
    t0 = time.time()
    s = sa.wait_for(lambda: (lambda st: st if (st.get("offer") or {}).get("kind") == "action" else None)(sa.host()), 15, 0.1)
    seconds = round(time.time() - t0, 2)
    sf = (s or {}).get("surface") or {}
    sa.check("the event line is drawn at the field", bool(s) and "Coffee with Dana" in ((sf.get("panel") or {}).get("text") or ""),
             seconds=seconds, panel=sf.get("panel"), offers=helper_state().get("offers"))
    results["steps"].append({"step": "line", "seconds": seconds, "shot": shot(out_dir, pid, h.pid, "event-1-line"), "placement": sf.get("panelPlacement")})
    k = sa.key("down", pid)
    time.sleep(0.25)
    s = sa.host()
    sf = s.get("surface") or {}
    sa.check("down opens the card", k.get("consumed") and (sf.get("ui") or {}).get("expanded") and (sf.get("panel") or {}).get("text") == "Coffee with Dana",
             key=k, ui=sf.get("ui"), panel=sf.get("panel"))
    results["steps"].append({"step": "card", "shot": shot(out_dir, pid, h.pid, "event-2-card"), "placement": sf.get("panelPlacement")})
    k = sa.key("tab", pid)
    time.sleep(0.3)
    acc = (sa.host().get("surface") or {}).get("lastAccepted") or {}
    key_ = acc.get("offerKey")
    sa.check("tab sends offerAccept add for the event", k.get("consumed") and acc.get("actionId") == "add" and (key_ or "").startswith("event-"), accepted=acc)
    end = sa.wait_for(lambda: next((p for p in helper_state().get("progress", []) if p.get("taskId") == key_ and p.get("phase") in ("done", "handoff", "stopped")), None), 15, 0.2)
    st = helper_state()
    line = (sa.host().get("surface") or {}).get("lineText") or ""
    if calendar == "fake":
        events = st.get("events") or []
        sa.check("the event is in the helper's fake calendar, once, as the sentence said", (end or {}).get("phase") == "done" and len(events) == 1
                 and events[0]["title"] == "Coffee with Dana" and events[0]["calendar"] == "Caret Test", end=end, events=events, calls=st.get("calls"))
        sa.check("the line says it was added", line.startswith("Done,") and "Calendar" in line, line=line)
    else:
        sa.check("the reader's test calendar refuses without asking: blocked tcc, a hand-off", (end or {}).get("phase") == "handoff" and (end or {}).get("blocked") == "tcc", end=end)
        sa.check("the line names what is missing", line == "Nothing was added: Caret needs Calendar access in Privacy & Security.", line=line)
    mine = [g["type"] for g in st.get("grants", []) if g.get("taskId") == key_]
    if calendar == "fake":
        sa.check("the calendar grant is revoked after the run", mine[:1] == ["calendarGrant"] and mine[-1:] == ["actRevoke"], grants=mine)
    else:
        # Blocked at the first calendar read, before any write: no grant may be left open (none is
        # issued when the reader refuses before the helper writes).
        sa.check("no calendar grant is left open", not mine or mine[-1] == "actRevoke", grants=mine, issued=bool(mine))
    results["steps"].append({"step": "after", "shot": shot(out_dir, pid, h.pid, "event-3-after"), "line": line})
    after = sa.watch(pid)
    sa.check("the event card never moved the frontmost app or the focused element", after["front"] == before["front"] and after["focused"] == before["focused"],
             before=before, after=after)
    sa.check("no panel was ever the key window", not sa.KEY_PANELS, keyPanels=sa.KEY_PANELS)
    results["helper"] = helper_state()
    return results


def ask(out_dir, appearance):
    fx, h = rig(out_dir, appearance, "fake")
    pid = fx.pid
    results = {"pid": pid, "steps": [], "delivery": {}}
    frame = message_frame(pid)
    sa.ax(pid, "focus", pid, sa.frame_arg(frame))
    time.sleep(0.3)
    before = sa.front_pid()
    sa.host("ask open")
    time.sleep(0.5)
    perch = sa.host("perch")
    sa.check("Ask Caret puts the list up with its field key", perch.get("listOnScreen") and perch.get("isKey"), perch={k: perch.get(k) for k in ("listOpen", "listOnScreen", "isKey")})
    now = sa.front_pid()
    sa.check("the fixture stays the active app", now.get("pid") == before.get("pid") == pid, before=before, after=now)
    lw = perch.get("listWindowNumber")
    results["steps"].append({"step": "empty", "shot": own_window_shot(out_dir, "ask-1-empty", lw)})

    def ask_state():
        return sa.host("ask")

    # Typing: cua-driver's background route into the host's focused element, else the socket hook.
    r = pid_keys(h.pid, "text:" + INSTRUCTION)
    typed = sa.wait_for(lambda: ask_state().get("text") == INSTRUCTION, 5, 0.1)
    results["delivery"]["type"] = "pid-keys text" if typed else "socket hook (real keys did not land)"
    # The real field path is what this run is for: a fallback keeps the later checks running, but
    # the run fails (review A13, finding 9).
    sa.check("real typing reached the ask field (key events posted to the host's pid)", bool(typed), reply=r, text=ask_state().get("text"))
    if not typed:
        results["delivery"]["typeReply"] = r
        sa.host("ask type " + INSTRUCTION)
    sa.check("the instruction is in the field", ask_state().get("text") == INSTRUCTION, delivery=results["delivery"]["type"])
    results["steps"].append({"step": "text", "shot": own_window_shot(out_dir, "ask-2-text", lw)})

    def press(name, done):
        p = sa.host("perch")
        results.setdefault("keyState", []).append({"key": name, "isKey": p.get("isKey"), "askEditing": p.get("askEditing"), "front": sa.front_pid()})
        r = pid_keys(h.pid, name)
        landed = sa.wait_for(done, 3, 0.1)
        results["delivery"][name] = "pid-keys" if landed else "socket hook (real key did not land)"
        sa.check(f"a real {name} reached the list's key handling (posted to the host's pid)", bool(landed), reply=r)
        if not landed:
            results["delivery"][name + "Reply"] = r
            sa.host({"return": "ask submit", "tab": "ask key tab", "escape": "ask key esc"}[name])
        return landed

    press("return", lambda: ask_state().get("phase") in ("asking", "proposed", "failed"))
    s = sa.wait_for(lambda: (lambda st: st if st.get("phase") in ("proposed", "failed") else None)(ask_state()), 15, 0.2)
    card = (s or {}).get("card") or {}
    steps = [(x["text"], x["yours"]) for x in card.get("steps", [])]
    sa.check("the instruction becomes a proposal card", (s or {}).get("phase") == "proposed", ask=s)
    sa.check("the Send is a hand-off marked yours", steps == [("Put “See you at 3” in Message", False), ("Press Send", True)], steps=steps)
    results["steps"].append({"step": "proposal", "shot": own_window_shot(out_dir, "ask-3-proposal", lw), "card": card})
    press("tab", lambda: ask_state().get("phase") in ("running", "ended"))
    s = sa.wait_for(lambda: (lambda st: st if st.get("phase") == "ended" else None)(ask_state()), 15, 0.2)
    sa.check("the run ends on the hand-off line", (s or {}).get("line") == "Filled 1 field. Your turn: press Send in caret-fixture"
             or ((s or {}).get("line") or "").startswith("Filled 1 field. Your turn: press Send in "), line=(s or {}).get("line"))
    value = sa.ax(pid, "value", pid, sa.frame_arg(frame)).get("value")
    d = fixture_dump(fx, out_dir)
    sa.check("the field reads back the value", value == "See you at 3" and (d.get("fields") or {}).get("message") == "See you at 3", ax=value, dump=d.get("fields"))
    sa.check("Send was never pressed", d.get("sent") is False, sent=d.get("sent"))
    key_ = card.get("offerKey")
    mine = [g["type"] for g in helper_state().get("grants", []) if g.get("taskId") == key_]
    sa.check("granted, then revoked after the run", mine[:1] == ["actGrant"] and mine[-1:] == ["actRevoke"], grants=mine)
    results["steps"].append({"step": "ended", "shot": own_window_shot(out_dir, "ask-4-ended", lw), "line": (s or {}).get("line")})
    press("escape", lambda: ask_state().get("phase") == "idle")
    sa.host("activity close")
    now = sa.front_pid()
    sa.check("the fixture is still the active app after asking", now.get("pid") == pid, after=now)
    results["helper"] = helper_state()
    return results


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ("event-fake", "event-reader", "ask"):
        raise SystemExit(__doc__)
    mode, out = sys.argv[1], sys.argv[2]
    appearance = sys.argv[3] if len(sys.argv) == 4 else "light"
    results = {}
    lease = fixture_app.GuiLease()
    dog = fixture_app.Watchdog(lambda t: any(a - 0.2 <= t <= b for a, b in sa.SYNTHETIC), sa.front_pid, sa.NAMES)
    stopped_by = None
    try:
        lease.__enter__()
        dog.__enter__()
        if mode == "ask":
            results = ask(out, appearance)
        else:
            results = event(out, appearance, "reader" if mode == "event-reader" else "fake")
    except KeyboardInterrupt:
        stopped_by = f"deferred: user active (input at {dog.tripped})" if dog.tripped else "interrupted"
        sa.log(stopped_by)
    finally:
        dog.__exit__()
        for hand_back in sa.BEFORE_STOP:
            hand_back()
        sa.stop_all()
        lease.__exit__()
        if stopped_by:
            results["stoppedBy"] = stopped_by
        os.makedirs(out, exist_ok=True)
        results["checks"] = sa.CHECKS
        results["passed"] = sum(c["ok"] for c in sa.CHECKS)
        results["failed"] = sum(not c["ok"] for c in sa.CHECKS)
        with open(os.path.join(out, "results.json"), "w") as f:
            json.dump(results, f, indent=2, sort_keys=True, default=str)
        sa.log("summary", results["passed"], "passed,", results["failed"], "failed")
    # Nonzero on any failed check, and a distinct status for a run the user's input stopped.
    sys.exit(76 if stopped_by else (1 if results["failed"] else 0))
