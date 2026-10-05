#!/usr/bin/env python3
"""A18's on-screen acceptance in the rig's VM: the surfaces in a real TextEdit, with real keys.

  a18_vm_walk.py --caret <Caret binary> --keys <fixture-keys> --hidkey <hid-key> --compose <compose-shot>
                 --replay <replay.json> --mid <cases.json> --tab <cases.json> --screen WxH --out DIR

It posts keys at the HID level, which BUILD-ORDER allows only inside the rig's VM, so it refuses to
run unless rig-run started it (RIG_JOB is set).

  1. Placement (bug 2): an action line and an event card injected for a TextEdit document whose
     text view fills a screen-wide window are drawn, not held; each is captured by window number.
  2. Ask (bugs 13 and 14): with a TextEdit window at the left of the screen, Ask Caret opens the
     list under the menu bar over that window; a failed ask is cleared by one real Esc, and real
     typing after a failure replaces the old instruction.
  3. Ghost text between words (bugs 6 and 7): each held-out sentence is typed with real keys and
     the caret moved back with real arrows; what the host shows is what the model chose on the host
     (`--ghost-replay`), or nothing, and a capsule lies inside the TextEdit window.
  4. Tab (bug 17): end-of-line sentences typed with real keys; a real Tab inserts the whole
     phrase, a real Option-Right one word, and the tap and arbiter counters count each (bug 18).

The host runs on its own sockets and settings file, with no helper. Every TextEdit instance is
launched here as a new instance and only those are stopped.

DIR/results.json is written after every check and again at the end, whatever ends the walk. It
lists the planned cases, each check, every interrupted attempt and any exception, and says whether
the walk reached its end (`complete`). V1a's walk lost the keyboard focus partway through a case,
raised, and left no report.

Focus: before each case's input the walk brings its TextEdit window forward and asks fixture-keys
that the window's app owns the focused element. If focus moves during a case's keys, fixture-keys
stops (exit 3) and says how many it sent; the case is recorded as interrupted with the command, the
count and the focus owner, never continued from a guessed caret. It is run once more from its
initial document, in a new TextEdit; a second interruption fails the case.
"""
import argparse
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import traceback

if not os.environ.get("RIG_JOB"):
    sys.exit("a18_vm_walk.py posts HID keys and runs only inside the rig's VM (rig-run sets RIG_JOB)")

p = argparse.ArgumentParser()
for name in ("caret", "keys", "hidkey", "compose", "replay", "mid", "tab", "screen", "out"):
    p.add_argument("--" + name, required=True)
# U2: part 2 alone (the desk over a TextEdit window, one real Esc), so a VM pass of the desk does not
# hold the VM and heavy leases for the whole walk.
p.add_argument("--only-ask", action="store_true")
A = p.parse_args()
OUT = A.out
os.makedirs(os.path.join(OUT, "shots"), exist_ok=True)
SCREEN_W, SCREEN_H = (int(v) for v in A.screen.split("x"))
TMP = tempfile.mkdtemp(prefix="a18-walk-")
SOCK = os.path.join(TMP, "host.sock")
CHECKS = []
LAUNCHED = []
REPLAY = json.load(open(A.replay))["entries"]
REPORT = {"planned": [], "done": [], "interruptions": [], "exception": None, "complete": False, "results": {}}
results = REPORT["results"]


def save():
    """results.json as it stands, replaced atomically, so a run stopped from outside leaves the
    checks done so far."""
    passed = sum(c["ok"] for c in CHECKS)
    body = dict(REPORT, passed=passed, failed=len(CHECKS) - passed, checks=CHECKS)
    tmp = os.path.join(OUT, ".results.json.tmp")
    with open(tmp, "w") as f:
        json.dump(body, f, indent=2, default=str)
    os.replace(tmp, os.path.join(OUT, "results.json"))


def check(name, ok, **detail):
    CHECKS.append({"check": name, "ok": bool(ok), **detail})
    print(("PASS " if ok else "FAIL ") + name + " " + json.dumps(detail, default=str)[:600], flush=True)
    save()
    return bool(ok)


class FocusLost(Exception):
    """fixture-keys refused to go on: another app or element took the keyboard focus."""

    def __init__(self, command, sent, of, focus):
        super().__init__(f"{command}: sent {sent} of {of}; focus {focus}")
        self.command, self.sent, self.of, self.focus = command, sent, of, focus


def cua(tool, args):
    out = subprocess.run(["cua-driver", tool, json.dumps(args)], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"{tool}: {out.stdout} {out.stderr}")
    return json.loads(out.stdout)


def host(command="state"):
    for _ in range(20):
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                s.settimeout(5)
                s.connect(SOCK)
                s.sendall((command + "\n").encode())
                s.shutdown(socket.SHUT_WR)
                data = b""
                while chunk := s.recv(65536):
                    data += chunk
            return json.loads(data)
        except (OSError, json.JSONDecodeError):
            time.sleep(0.25)
    raise RuntimeError(f"host did not answer {command}")


def start_host(name, extra):
    if os.path.exists(SOCK):
        os.remove(SOCK)
    env = dict(os.environ, CARET_ALLOW_BUNDLES="com.apple.TextEdit")
    log = open(os.path.join(OUT, f"host-{name}.log"), "w")
    proc = subprocess.Popen(
        [A.caret, "--socket", SOCK, "--helper-socket", os.path.join(TMP, "no-helper.sock"), "--test-hooks",
         "--settings", os.path.join(TMP, f"settings-{name}.json"), *extra],
        stdout=log, stderr=subprocess.STDOUT, env=env,
    )
    for _ in range(100):
        if os.path.exists(SOCK):
            try:
                host("ping")
                return proc
            except RuntimeError:
                pass
        time.sleep(0.1)
    raise RuntimeError("host did not start")


def stop(proc):
    proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()


def keys(pid, *args):
    """fixture-keys, which posts each key only while `pid` owns the focus. Exit 3 is its refusal:
    stdout says how many it sent, stderr who has the focus."""
    out = subprocess.run([A.keys, str(pid), *map(str, args)], capture_output=True, text=True)
    if out.returncode == 3:
        sent = re.search(r"sent (\d+)", out.stdout)
        focus = re.search(r"focus is (.*?), not", out.stderr)
        total = int(args[2]) if args[0] == "key" and len(args) > 2 else (len(args[1]) if args[0] == "type" else 1)
        raise FocusLost(" ".join(map(str, args)), int(sent.group(1)) if sent else 0, total,
                        focus.group(1) if focus else out.stderr.strip())
    if out.returncode != 0:
        raise RuntimeError(f"fixture-keys {args}: {out.stdout} {out.stderr}")


def hid(*args):
    subprocess.run([A.hidkey, *map(str, args)], check=True)


def focus_ok(pid):
    return subprocess.run([A.keys, str(pid), "check"], capture_output=True).returncode == 0


def ensure_focus(pid, wid):
    """The case's window in front with its text area focused, before any of the case's input."""
    for _ in range(40):
        if focus_ok(pid):
            return
        cua("bring_to_front", {"pid": pid, "window_id": wid})
        time.sleep(0.25)
    out = subprocess.run([A.keys, str(pid), "check"], capture_output=True, text=True)
    focus = re.search(r"focus is (.*?), not", out.stderr)
    raise FocusLost("check", 0, 0, focus.group(1) if focus else out.stderr.strip())


def textedit(name, text, frame):
    path = os.path.join(TMP, name)
    with open(path, "w") as f:
        f.write(text)
    launched = cua("launch_app", {"bundle_id": "com.apple.TextEdit", "urls": [path], "creates_new_application_instance": True})
    pid = launched["pid"]
    LAUNCHED.append(pid)
    wid = None
    for _ in range(80):
        match = [w for w in cua("list_windows", {"pid": pid})["windows"] if w.get("title") == name]
        if match:
            wid = match[0]["window_id"]
            break
        time.sleep(0.1)
    if wid is None:
        raise RuntimeError(f"no TextEdit window for {name}")
    cua("set_window_frame", {"pid": pid, "window_id": wid, **frame})
    for _ in range(40):
        cua("bring_to_front", {"pid": pid, "window_id": wid})
        time.sleep(0.25)
        if focus_ok(pid):
            return pid, wid
    raise RuntimeError(f"TextEdit {pid} never took the front")


def close(pid):
    """Stops a TextEdit this walk launched and waits until it is gone, so the next case's window
    does not come up beside it."""
    if pid not in LAUNCHED:
        return
    LAUNCHED.remove(pid)
    try:
        os.kill(pid, 15)
    except ProcessLookupError:
        return
    for _ in range(100):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass


def bounds(pid, wid):
    for w in cua("list_windows", {"pid": pid})["windows"]:
        if w["window_id"] == wid:
            b = w["bounds"]
            return [b["x"], b["y"], b["width"], b["height"]]
    return None


def inside(inner, outer, slack=1.0):
    return (inner[0] >= outer[0] - slack and inner[1] >= outer[1] - slack
            and inner[0] + inner[2] <= outer[0] + outer[2] + slack and inner[1] + inner[3] <= outer[1] + outer[3] + slack)


def value(pid, wid):
    state = cua("get_window_state", {"pid": pid, "window_id": wid})
    for e in state.get("elements", []):
        if e.get("role") == "AXTextArea":
            return e.get("value")
    return None


def shot(name, pid, wid, panels=()):
    """The TextEdit window and the host's panels, each captured by its window number, joined."""
    layers = []
    base = os.path.join(OUT, "shots", f"{name}-window.png")
    subprocess.run(["screencapture", "-x", "-o", f"-l{wid}", base], check=True)
    layers.append(base + ":" + ",".join(str(v) for v in bounds(pid, wid)))
    for i, panel in enumerate(p for p in panels if p):
        path = os.path.join(OUT, "shots", f"{name}-panel{i}.png")
        if subprocess.run(["screencapture", "-x", "-o", f"-l{panel['windowNumber']}", path]).returncode == 0:
            layers.append(path + ":" + ",".join(str(v) for v in panel["frame"]))
    subprocess.run([A.compose, os.path.join(OUT, "shots", f"{name}.png"), *layers], capture_output=True)
    return os.path.join("shots", f"{name}.png")


def counter(state, name):
    return (state.get("counters") or {}).get(name, 0)


def ghost_counters(state):
    """The host's counters that say why ghost text was or was not offered."""
    prefixes = ("held.ghost", "offer.", "suppressed.", "discarded.", "withdrawn.ghost", "replay")
    return {k: v for k, v in (state.get("counters") or {}).items() if k.startswith(prefixes)}


def front_app():
    """LaunchServices' front app, as the keys see it."""
    asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()
    info = subprocess.run(["lsappinfo", "info", "-only", "name", asn], capture_output=True, text=True).stdout.strip()
    return info.split("=")[-1].strip('" ') if info else None


def replay_for(before, after):
    for e in REPLAY:
        if before.endswith(e["before"]) and e["after"].rstrip() == after.rstrip():
            return e
    return None


def golden(name):
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "..", "Tests", "CaretHostCoreTests", "Fixtures", "popup-specs.json")) as f:
        return json.load(f)["valid"][name]


def attempt(case, run):
    """Runs one case; a focus change during it is recorded and the case run once more from its
    initial document. `run` opens its own TextEdit, so a retry never continues the first attempt."""
    for n in (1, 2):
        before = list(LAUNCHED)
        try:
            run()
            REPORT["done"].append(case)
            save()
            return
        except FocusLost as lost:
            REPORT["interruptions"].append({"case": case, "attempt": n, "command": lost.command, "sent": lost.sent,
                                            "of": lost.of, "focus": lost.focus})
            print(f"INTERRUPTED {case} attempt {n}: {lost}", flush=True)
            for pid in [p for p in LAUNCHED if p not in before]:
                close(pid)
            save()
    REPORT["done"].append(case)
    check(f"{case}: interrupted twice by a focus change; not replayed", False,
          interruptions=[i for i in REPORT["interruptions"] if i["case"] == case])


# ---------------------------------------------------------------------------------------------- 1 and 2

def placement():
    lines = "\n".join(f"Line {i}: notes from the planning session, nothing to act on here." for i in range(1, 41))
    full = {"x": 0, "y": 30, "width": SCREEN_W, "height": SCREEN_H - 120}
    pid, wid = textedit("plan.txt", lines, full)
    ensure_focus(pid, wid)
    keys(pid, "type", "Coffee with Dana on Thursday at 3 ")
    time.sleep(0.6)
    window = bounds(pid, wid)
    check("TextEdit's window spans the screen", window and window[2] >= SCREEN_W - 40, window=window)
    for kind, payload, expect in (
        ("action", {"kind": "action", "pid": pid, "offerKey": "line-1", "app": "Calendar",
                    "endState": {"text": "Coffee with Dana, Thu 3:00 to 3:30", "ref": {"node": "te/plan/body", "quote": "Coffee with Dana on Thursday at 3"}},
                    "actions": [{"id": "add", "label": "Add", "key": "tab"}]}, "Coffee with Dana"),
        ("event-card", {"kind": "popup", "pid": pid, "offerKey": "card-1", "spec": golden("eventCard")}, None),
    ):
        before = host()
        reply = host("inject " + json.dumps(payload, separators=(",", ":")))
        time.sleep(0.5)
        s = host()
        sf = s.get("surface") or {}
        panel = sf.get("panel")
        check(f"{kind}: drawn in the full-window document, not held", reply.get("ok") and panel and not sf.get("held"),
              reply=reply, held=sf.get("held"), unshown=sf.get("lastUnshown"))
        if panel:
            check(f"{kind}: the panel lies inside TextEdit's window", inside(panel["frame"], window), panel=panel["frame"], window=window,
                  placement=sf.get("panelPlacement"))
            if expect:
                check(f"{kind}: it says what it offers", expect in (panel.get("text") or ""), text=panel.get("text"))
        results[kind] = {
            "placement": sf.get("panelPlacement"),
            "compact": counter(s, "surface.compact.action") + counter(s, "surface.compact.popup") > counter(before, "surface.compact.action") + counter(before, "surface.compact.popup"),
            "caretLine": counter(s, "surface.placed.caretLine") - counter(before, "surface.placed.caretLine"),
            "shot": shot(kind, pid, wid, [panel]) if panel else None,
        }
        check(f"{kind}: no offer was held for want of a clear spot", counter(s, "surface.held.noClearSpot") == counter(before, "surface.held.noClearSpot"))
        ensure_focus(pid, wid)
        keys(pid, "key", "escape")
        time.sleep(0.4)
        check(f"{kind}: a real Esc takes it down", not (host().get("surface") or {}).get("panel"))
    close(pid)


def ask(h):
    left = {"x": 40, "y": 160, "width": 640, "height": 520}
    pid, wid = textedit("ask.txt", "Notes for the form.\n", left)
    ensure_focus(pid, wid)
    window = bounds(pid, wid)
    host("ask open")
    time.sleep(0.6)
    perch = host("perch")
    frame = perch.get("listFrame")
    check("Ask Caret opens the list on the first press", perch.get("listOnScreen") and frame, listOpen=perch.get("listOpen"), reopened=perch.get("stats", {}).get("reopened"))
    if frame:
        mid_list, mid_window = frame[0] + frame[2] / 2, window[0] + window[2] / 2
        check("the list is centered over the window in front (or held on screen)",
              abs(mid_list - mid_window) < 2 or frame[0] <= 9, list=frame, window=window, anchor=perch.get("stats", {}).get("listAnchor"))
        check("the list sits just under the menu bar", 25 <= frame[1] <= 50, y=frame[1])
        check("it overlaps the window horizontally, so it reads as near the work",
              frame[0] < window[0] + window[2] and frame[0] + frame[2] > window[0])
        results["ask"] = {"list": frame, "window": window, "shot": shot("ask-open", pid, wid, [{"windowNumber": perch["listWindowNumber"], "frame": frame}])}
    host("ask type fill my name and email")
    host("ask submit")
    a = host("ask")
    check("an ask with no helper fails with a sentence", a.get("phase") == "failed", ask=a)
    pidkeys = os.path.join(os.path.dirname(A.keys), "pid-keys")

    def to_panel(hid_args, pid_key, done):
        """A key for the list panel: at the HID level first, as a keyboard sends it; if the panel
        did not get it (the active app is TextEdit), posted to Caret's pid as A13 did. Says which."""
        hid(*hid_args)
        time.sleep(0.4)
        if done():
            return "hid"
        subprocess.run([pidkeys, str(h.pid), "Caret", pid_key], capture_output=True)
        time.sleep(0.4)
        return "pid" if done() else "neither"

    check("the ask field has the keyboard after Ask Caret", perch.get("askEditing") or host("perch").get("askEditing"), perch=host("perch"))
    route = to_panel(["escape"], "escape", lambda: host("ask").get("phase") == "idle")
    a = host("ask")
    check("one Esc clears the failed ask: line and text", a.get("phase") == "idle" and a.get("text") == "", ask=a, route=route)
    host("ask type fill my name and email")
    host("ask submit")
    time.sleep(0.3)
    route = to_panel(["type", "P"], "text:P", lambda: host("ask").get("text") not in ("fill my name and email", None))
    a = host("ask")
    check("typing after a failure starts a new instruction", a.get("text") == "P", ask=a, route=route)
    results["askKeys"] = route
    for _ in range(2):
        to_panel(["escape"], "escape", lambda: not host("perch").get("listOnScreen"))
    close(pid)


# ---------------------------------------------------------------------------------------------- 3 and 4

def mid_case(number, before, after, expected, tally):
    pid, wid = textedit(f"mid-{number}.txt", before + after, {"x": 200, "y": 200, "width": 900, "height": 420})
    ensure_focus(pid, wid)
    # Every caret position on the way is a context too, with no recorded outcome; only the last one
    # must find its entry.
    if len(before) > 1:
        keys(pid, "key", "right", len(before) - 1)
    time.sleep(0.8)
    missing0 = counter(host(), "suppressed.replayMissing")
    keys(pid, "key", "right", 1)
    time.sleep(1.5)
    s = host()
    missing = counter(s, "suppressed.replayMissing") - missing0
    offer = s.get("offer") if (s.get("offer") or {}).get("pid") == pid else None
    fits = s.get("ghostFits") or []
    last = fits[-1] if fits else {}
    want = expected.get("text")
    if want:
        capsule = last.get("capsule")
        window = bounds(pid, wid)
        ok = offer and offer.get("text") == want and last.get("outcome") != "declined" and capsule and inside(capsule, window)
        tally["shown" if ok else "wrong"] += 1
        check(f"mid {number}: offers the model's fit, in a capsule inside the window", ok, offer=offer, fit=last, window=window,
              shot=shot(f"mid-{number}", pid, wid))
    else:
        ok = offer is None
        tally["silent" if ok else "wrong"] += 1
        check(f"mid {number}: silent, as the model run was ({expected.get('reason')})", ok and missing == 0, offer=offer, replayMissing=missing)
    close(pid)


def tab_case(name, before, expected, word, taken):
    pid, wid = textedit(f"{name}.txt", "", {"x": 200, "y": 200, "width": 900, "height": 420})
    ensure_focus(pid, wid)
    keys(pid, "type", before)
    offer = None
    s = {}
    for _ in range(40):
        s = host()
        if (s.get("offer") or {}).get("pid") == pid and s["offer"].get("ageMs", 0) > 150:
            offer = s["offer"]
            break
        time.sleep(0.1)
    if not check(f"{name}: the recorded phrase is offered", offer and offer.get("text") == expected, offer=offer, expected=expected,
                 front=front_app(), counters=ghost_counters(s), fit=(s.get("ghostFits") or [None])[-1]):
        close(pid)
        return
    ensure_focus(pid, wid)
    keys(pid, "key", "opt-right" if word else "tab")
    time.sleep(0.8)
    after_state = host()
    got = value(pid, wid)
    lead = expected[: len(expected) - len(expected.lstrip())]
    want = before + (lead + expected.split()[0] if word else expected)
    tap0, tap1 = s.get("tap", {}), after_state.get("tap", {})
    claim = after_state.get("lastClaim") or {}
    ok = check(f"{name}: a real {'Option-Right takes one word' if word else 'Tab takes the whole phrase'}", got == want,
               got=got, want=want, wordOnly=claim.get("wordOnly"))
    check(f"{name}: the tap and the arbiter count the accept",
          tap1.get("consumed", 0) - tap0.get("consumed", 0) == 1
          and counter(after_state, "offers.claimed") - counter(s, "offers.claimed") == 1
          and (tap1.get("tabs", 0) - tap0.get("tabs", 0)) == (0 if word else 1),
          consumed=[tap0.get("consumed"), tap1.get("consumed")], tabs=[tap0.get("tabs"), tap1.get("tabs")],
          claimed=[counter(s, "offers.claimed"), counter(after_state, "offers.claimed")])
    taken.append({"case": name, "word": word, "ok": ok, "phrase": expected, "shot": shot(name, pid, wid)})
    close(pid)


def ghost():
    mids = json.load(open(A.mid))
    tally = {"shown": 0, "silent": 0, "wrong": 0}
    for i, case in enumerate(mids):
        number, before, after = i + 1, case["before"], case["after"]
        expected = replay_for(before, after)
        if not check(f"mid {number}: the replay file has the model's outcome for it", expected is not None, before=before, after=after):
            tally["wrong"] += 1
            REPORT["done"].append(f"mid {number}")
            continue
        attempt(f"mid {number}", lambda: mid_case(number, before, after, expected, tally))
    results["mid"] = {"cases": len(mids), "offeredAndFit": tally["shown"], "silent": tally["silent"], "wrong": tally["wrong"]}

    taken = []
    runs = tab_runs()
    check("the recorded Tab cases include a phrase of more than one word", any(r[3] for r in runs), runs=[r[2] for r in runs])
    for name, before, expected, word in runs:
        attempt(name, lambda: tab_case(name, before, expected, word, taken))
    results["tab"] = taken


def tab_runs():
    runs = []
    for i, case in enumerate(json.load(open(A.tab))):
        expected = (replay_for(case["before"], "") or {}).get("text")
        if expected:
            runs.append((f"tab-{i + 1}", case["before"], expected, False))
    multi = next((r for r in runs if len(r[2].split()) > 1), None)
    if multi:
        runs.append((multi[0] + "-word", multi[1], multi[2], True))
    return runs


def plan():
    cases = [] if A.only_ask else ["placement"]
    cases.append("ask")
    if not A.only_ask:
        cases += [f"mid {i + 1}" for i in range(len(json.load(open(A.mid))))]
        cases += [r[0] for r in tab_runs()]
    return cases


current = "start"
hosts = []
try:
    REPORT["planned"] = plan()
    save()
    h = start_host("surfaces", ["--no-ghost"])
    hosts.append(h)
    if not A.only_ask:
        current = "placement"
        attempt("placement", placement)
    current = "ask"
    attempt("ask", lambda: ask(h))
    stop(h)
    hosts.remove(h)
    if not A.only_ask:
        current = "ghost"
        h = start_host("ghost", ["--ghost-replay", A.replay])
        hosts.append(h)
        ghost()
    REPORT["complete"] = True
except Exception as e:  # noqa: BLE001 - every failure must reach the report
    REPORT["exception"] = {"case": current, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()}
    print(f"EXCEPTION in {current}: {e}", flush=True)
finally:
    for proc in hosts:
        stop(proc)
    for pid in list(LAUNCHED):
        close(pid)
    save()

passed = sum(c["ok"] for c in CHECKS)
print(f"{passed}/{len(CHECKS)} checks pass; {len(REPORT['interruptions'])} interrupted attempts; complete {REPORT['complete']}")
sys.exit(0 if REPORT["complete"] and REPORT["exception"] is None and passed == len(CHECKS) else 1)
