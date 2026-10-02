#!/usr/bin/env python3
"""Alternatives, pop-ups and the fill line, on caret-fixture's synthetic forms.

  surface_acceptance.py alternatives <evidence_dir> [light|dark]
  surface_acceptance.py fill <evidence_dir> [light|dark]

Starts, and stops on exit, only processes it records: one caret-fixture (Reference and Claim form)
and the host limited to that pid, with ghost text off and no helper. Posts no keyboard or mouse
event anywhere. Focus moves by AX writes on the fixture (fixture-ax refuses pids it was not given);
keys go through the host's debug-socket test hook, which runs the event tap's own routing for a
key headed for the fixture pid; offers arrive through the socket's `inject` command (a fill
proposal is injected as the helper line it would be).

alternatives: an injected offer appears; the down arrow opens it; Command-2 selects; Tab takes and
the field holds the chosen text; one typed character removes every panel by the next read; the
three pop-ups and an action line take their actions; the frontmost app and the fixture's focused
element never change because of a panel, and no panel is ever key.

fill: the toast and the next field's offer give way to each other, and in the tight form the line
covers no neighbor. Screenshots in the given appearance (both host and fixture).
"""
import json
import os
import signal
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
# The screen track's fixture build, which has --background-only (activation policy .prohibited);
# this worktree's copy predates the flag. Executed only, never rebuilt or edited from here.
FIXTURE = os.environ.get("CARET_FIXTURE_BIN") or os.path.join(
    os.path.dirname(ROOT), "caret-v2-screen", "apps", "screen-reader", ".build", "debug", "caret-fixture")
GUI_LOCK = os.path.expanduser("~/.long-run/locks/gui.lock")
CARET = os.path.join(ROOT, "apps", "caret", ".build", "Caret.app", "Contents", "MacOS", "Caret")
AX = os.path.join(ROOT, "apps", "caret", ".build", "fixture-ax")
COMPOSE = os.path.join(ROOT, "apps", "caret", ".build", "compose-shot")
GOLDEN = os.path.join(ROOT, "apps", "caret", "Tests", "CaretHostCoreTests", "Fixtures", "popup-specs.json")
SOCKETS = os.path.expanduser("~/.caret-run/sockets")
HOST_SOCK = os.path.join(SOCKETS, "a3-host.sock")
NO_HELPER = os.path.join(SOCKETS, "a3-no-helper.sock")

CLAIM = "Caret Fixture — Claim form"
REFERENCE = "Caret Fixture — Reference"

STARTED = []
CLEANUP = []
CHECKS = []
KEY_PANELS = []
RUN_START = None
# Launched without --background-only, caret-fixture took the foreground (measured 2026-10-02:
# lsappinfo front was the fixture pid within 0.5 s, three runs between 10:56 and 11:01 CDT). Now it
# is launched with --background-only under gui.lock, the frontmost app is checked after launch, and
# a fixture that is frontmost anyway is killed at once. A run also only starts after the Mac has
# been idle this long, and stops on any input. This script itself posts no input events.
IDLE_MIN = float(os.environ.get("CARET_SURFACE_IDLE_MIN", "120"))


def hid_idle_seconds():
    out = subprocess.run(["ioreg", "-c", "IOHIDSystem"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if "HIDIdleTime" in line:
            return int(line.split()[-1]) / 1e9
    return 0.0


# The host's own pid-posted keys (the paste after Tab, the Tab that moves a form's focus) reset
# HIDIdleTime too (measured: idle fell to 0 at the Tab step, then grew steadily with nobody at the
# Mac). Each Tab this script routes opens a window in which a reset is the host's, not a person's.
SYNTHETIC = []
IDLE_LOG = []


def expect_synthetic(seconds=3.0):
    SYNTHETIC.append((time.time(), time.time() + seconds))


def guard_user():
    """Any HID input since the run began, outside the host's own key windows, is someone using
    the Mac: stop at once. A fixture that became frontmost is killed."""
    if RUN_START is None:
        return
    fixture = next((p for n, p in STARTED if n == "fixture" and p.poll() is None), None)
    if fixture is not None:
        now = front_pid()
        if fixture.pid in (now.get("pid"), now.get("lsappinfo")):
            fixture.kill()
            CHECKS.append({"check": "fixture never frontmost", "ok": False, "front": now, "killed": fixture.pid})
            raise SystemExit(f"fixture {fixture.pid} became frontmost during the run; killed it")
    idle = hid_idle_seconds()
    last_input = time.time() - idle
    IDLE_LOG.append((round(time.time() - RUN_START, 2), round(idle, 2)))
    if last_input > RUN_START + 0.5 and not any(a - 0.2 <= last_input <= b for a, b in SYNTHETIC):
        raise SystemExit(f"deferred: user active during the run (input at {time.strftime('%H:%M:%S', time.localtime(last_input))})")


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


def check(name, ok, **detail):
    CHECKS.append({"check": name, "ok": bool(ok), **detail})
    log("PASS" if ok else "FAIL", name, json.dumps(detail)[:300] if detail else "")
    return ok


def start(name, args, out_dir, env=None):
    out = open(os.path.join(out_dir, f"{name}.log"), "w")
    proc = subprocess.Popen(args, stdout=out, stderr=subprocess.STDOUT, env=env)
    STARTED.append((name, proc))
    log("started", name, proc.pid)
    return proc


def stop_all():
    for name, proc in reversed(STARTED):
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
            log("stopped", name, proc.pid)


def host(command="state"):
    guard_user()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect(HOST_SOCK)
    s.sendall((command + "\n").encode())
    s.shutdown(socket.SHUT_WR)
    chunks = []
    while True:
        c = s.recv(65536)
        if not c:
            break
        chunks.append(c)
    s.close()
    reply = json.loads(b"".join(chunks))
    if command == "state":
        note_key_panels(reply)
    return reply


def note_key_panels(state):
    """Every panel the host reports, on every read: none may ever be the key window."""
    panels = dict((state.get("surface") or {}))
    overlay = (state.get("fill") or {}).get("overlay") or {}
    for kind in ("panel", "decor", "list"):
        p = panels.get(kind)
        if p and p.get("isKey"):
            KEY_PANELS.append(kind)
    for kind in ("ghost", "line", "toast"):
        p = overlay.get(kind)
        if p and p.get("isKey"):
            KEY_PANELS.append(kind)


def ax(pid, *args):
    env = dict(os.environ, CARET_TEST_PIDS=str(pid))
    out = subprocess.run([AX, *map(str, args)], capture_output=True, text=True, env=env)
    if out.returncode != 0:
        raise RuntimeError(f"fixture-ax {args[0]} failed: {out.stderr.strip()}")
    return json.loads(out.stdout)


def wait_for(predicate, timeout, interval=0.02):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


def key(name, pid):
    if name == "tab":
        expect_synthetic()
    return host(f"key {name} {pid}")


def inject(obj):
    return host("inject " + json.dumps(obj, separators=(",", ":")))


def frame_arg(frame):
    return ",".join(str(v) for v in frame)


def watch(pid):
    """Frontmost app (NSWorkspace and lsappinfo) and the fixture's focused element."""
    return {"front": ax(pid, "frontmost"), "focused": ax(pid, "focused", pid)}


def shot(out_dir, fixture_pid, host_pid, name):
    """The fixture's Claim window plus every on-screen window of the host, each captured by window
    id and joined. Region captures are never used: the fixture sits behind other windows, and a
    region capture would record whatever covers it."""
    shots = os.path.join(out_dir, "shots")
    os.makedirs(shots, exist_ok=True)
    listing = lambda pid: json.loads(subprocess.run(["cua-driver", "list_windows", json.dumps({"pid": pid})],
                                                    capture_output=True, text=True).stdout or "{}").get("windows", [])
    base = next((w for w in listing(fixture_pid) if w.get("title") == CLAIM), None)
    if base is None:
        return None
    layers = []
    path = os.path.join(shots, f"{name}-window.png")
    subprocess.run(["screencapture", "-x", "-o", f"-l{base['window_id']}", path], check=True)
    b = base["bounds"]
    layers.append(f"{path}:{b['x']},{b['y']},{b['width']},{b['height']}")
    # The host's panels, by the window numbers and frames its debug socket reports.
    state = host()
    surface = state.get("surface") or {}
    overlay = (state.get("fill") or {}).get("overlay") or {}
    panels = [surface.get(k) for k in ("ghostPanel", "decor", "panel", "list")] + [overlay.get(k) for k in ("ghost", "line", "toast")]
    for i, p in enumerate(x for x in panels if x and not (x.get("text") or "").startswith("(exiting)")):
        path_i = os.path.join(shots, f"{name}-host{i}.png")
        if subprocess.run(["screencapture", "-x", "-o", f"-l{p['windowNumber']}", path_i]).returncode == 0 and os.path.exists(path_i):
            layers.append(path_i + ":" + ",".join(str(v) for v in p["frame"]))
    out = os.path.join(shots, f"{name}.png")
    subprocess.run([COMPOSE, out, *layers], check=True, capture_output=True)
    for layer in layers:
        os.remove(layer.rsplit(":", 1)[0])
    return out


def gui_lock_held():
    """True when some process holds gui.lock: a zero-wait lockf fails. The caller is expected to be
    that process (`lockf -k ~/.long-run/locks/gui.lock surface_acceptance.py ...`)."""
    return subprocess.run(["/usr/bin/lockf", "-t", "0", GUI_LOCK, "true"], capture_output=True).returncode != 0


def front_pid():
    """NSWorkspace's and LaunchServices' frontmost pids, from fixture-ax (no pid needed)."""
    out = subprocess.run([AX, "frontmost"], capture_output=True, text=True, env=dict(os.environ, CARET_TEST_PIDS="1"))
    return json.loads(out.stdout) if out.returncode == 0 else {}


def launch_fixture(out_dir):
    before = front_pid()
    fx = start("fixture", [FIXTURE, "--windows", "reference,claim", "--gold", os.path.join(out_dir, "gold.json"),
                           "--duration", "900", "--background-only"], out_dir)
    # Watch the first two seconds: the fixture must never be frontmost.
    deadline = time.time() + 2
    while time.time() < deadline:
        now = front_pid()
        if fx.pid in (now.get("pid"), now.get("lsappinfo")):
            fx.kill()
            fx.wait()
            CHECKS.append({"check": "fixture never frontmost", "ok": False, "before": before, "after": now, "killed": fx.pid})
            raise SystemExit(f"fixture {fx.pid} became frontmost; killed it")
        time.sleep(0.1)
    after = front_pid()
    check("fixture launched without changing the frontmost app", after.get("pid") == before.get("pid"), before=before, after=after)
    return fx


def rig(out_dir, appearance):
    global RUN_START
    os.makedirs(out_dir, exist_ok=True)
    if not gui_lock_held():
        raise SystemExit("refused: run under lockf -k ~/.long-run/locks/gui.lock")
    idle = hid_idle_seconds()
    if idle < IDLE_MIN:
        raise SystemExit(f"deferred: user active (idle {idle:.0f} s < {IDLE_MIN:.0f} s)")
    RUN_START = time.time()
    # The fixture has no appearance flag; its own defaults domain (created here, removed on exit)
    # sets it for this run only.
    prefs = os.path.expanduser("~/Library/Preferences/caret-fixture.plist")
    if appearance == "dark" and not os.path.exists(prefs):
        subprocess.run(["defaults", "write", "caret-fixture", "AppleInterfaceStyle", "Dark"], check=True)
        CLEANUP.append(lambda: subprocess.run(["defaults", "delete", "caret-fixture"]))
        # `defaults delete` leaves an empty plist behind; it is this run's file.
        CLEANUP.append(lambda: os.path.exists(prefs) and os.remove(prefs))
    CHECKS.append({"check": "front app before launch", "ok": True,
                   "front": subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()})
    if os.path.exists(HOST_SOCK):
        raise SystemExit(f"{HOST_SOCK} exists; another run may be live")
    fx = launch_fixture(out_dir)
    wait_for(lambda: os.path.exists(os.path.join(out_dir, "gold.json")), 10, 0.1)
    time.sleep(1)
    fields = [f for f in ax(fx.pid, "fields", fx.pid) if f["window"] == CLAIM]
    with open(os.path.join(out_dir, "gold.json")) as f:
        gold = next(form for form in json.load(f)["forms"] if form["window"] == CLAIM)["fields"]
    # The fixture writes view frames; Accessibility reports them 1 pt larger on every side.
    for g in gold:
        g["frame"] = next(f["frame"] for f in fields if all(abs(a - b) <= 2 for a, b in zip(f["frame"], g["frame"])))
    args = [CARET, "--socket", HOST_SOCK, "--helper-socket", NO_HELPER, "--allow-pids", str(fx.pid), "--no-ghost",
            "--appearance", appearance]
    h = start("host", args, out_dir)
    if not wait_for(lambda: os.path.exists(HOST_SOCK), 15, 0.1):
        raise SystemExit("host did not open its socket")
    time.sleep(1)
    r = ax(fx.pid, "key-window", fx.pid, CLAIM)
    check("key-window switch leaves the frontmost app alone", r["frontAfter"] == r["frontBefore"] and r["frontAfter"] != fx.pid, result=r)
    return fx.pid, h.pid, gold


def golden(name):
    with open(GOLDEN) as f:
        return json.load(f)["valid"][name]


def alternatives(out_dir, appearance):
    pid, host_pid, gold = rig(out_dir, appearance)
    by_label = {g["label"]: g for g in gold}
    results = {"pid": pid, "appearance": appearance, "steps": []}

    def step(name, **data):
        results["steps"].append({"step": name, **data})

    # --- Alternatives in the Full name field --------------------------------------------------
    field = by_label["Full name"]
    ax(pid, "focus", pid, frame_arg(field["frame"]))
    time.sleep(0.3)
    before = watch(pid)
    candidates = ["Dana Whitfield", "Dana R. Whitfield", "D. Whitfield", "Dana Whitfield-Ames"]
    reply = inject({"kind": "alternatives", "pid": pid, "candidates": candidates})
    s = host()
    sf = s.get("surface") or {}
    check("injected alternatives appear", reply.get("ok") and sf.get("ghost") == candidates[0] and sf.get("decor") and not sf.get("list"),
          reply=reply, ghost=sf.get("ghost"), decor=bool(sf.get("decor")))
    step("shown", shot=shot(out_dir, pid, host_pid, "alt-1-shown"), surface=sf)

    k = key("down", pid)
    s = host()
    sf = s.get("surface") or {}
    ui = sf.get("ui") or {}
    check("down opens them on candidate 2", k.get("consumed") and ui.get("open") and ui.get("candidate") == 1
          and sf.get("ghost") == candidates[1] and sf.get("list") and "2 of 4" in (sf.get("decor") or {}).get("text", ""),
          key=k, ui=ui, ghost=sf.get("ghost"), list=(sf.get("list") or {}).get("text"))
    step("open", shot=shot(out_dir, pid, host_pid, "alt-2-open"), surface=sf)

    key("down", pid)
    k = key("cmd-2", pid)
    s = host()
    sf = s.get("surface") or {}
    check("command-2 selects candidate 2 while open", k.get("consumed") and (sf.get("ui") or {}).get("candidate") == 1
          and sf.get("ghost") == candidates[1], key=k, ui=sf.get("ui"))
    step("cmd-2", shot=shot(out_dir, pid, host_pid, "alt-3-cmd2"), surface=sf)

    mid = watch(pid)
    check("showing and opening alternatives left the frontmost app and focused element alone",
          mid["front"] == before["front"] and mid["focused"] == before["focused"], before=before, after=mid)

    last = (s.get("lastInsertion") or {}).get("claimID", 0)
    k = key("tab", pid)
    ins = wait_for(lambda: (lambda st: st["lastInsertion"] if st.get("lastInsertion") and st["lastInsertion"]["claimID"] > last else None)(host()), 5)
    value = ax(pid, "value", pid, frame_arg(field["frame"]))["value"]
    s = host()
    check("tab takes the selected alternative into the field", k.get("consumed") and value == candidates[1]
          and (s.get("lastClaim") or {}).get("candidate") == 1 and (s.get("surface") or {}).get("lastAccepted", {}).get("candidate") == 1,
          key=k, value=value, lastClaim=s.get("lastClaim"), insertion=ins)
    step("taken", value=value, insertion=ins, lastClaim=s.get("lastClaim"))

    # --- One typed character removes everything ----------------------------------------------
    field = by_label["Email"]
    ax(pid, "focus", pid, frame_arg(field["frame"]))
    time.sleep(0.3)
    inject({"kind": "alternatives", "pid": pid, "candidates": ["dana@lumenlabs.example", "dana.whitfield@lumenlabs.example"]})
    key("down", pid)
    open_state = host().get("surface") or {}
    k = key("char:x", pid)
    s = host()
    sf = s.get("surface") or {}
    gone = not s.get("offer") and not sf.get("ghost") and not sf.get("decor") and not sf.get("list") and not sf.get("panel")
    check("one typed character removes the panel by the next read", bool(open_state.get("list")) and not k.get("consumed") and gone,
          key=k, before=bool(open_state.get("list")), after={kk: sf.get(kk) for kk in ("ghost", "decor", "list", "panel")}, offer=s.get("offer"))

    # --- Pop-ups -------------------------------------------------------------------------------
    field = by_label["Phone"]
    ax(pid, "focus", pid, frame_arg(field["frame"]))
    time.sleep(0.3)
    before = watch(pid)
    reply = inject({"kind": "popup", "pid": pid, "offerKey": "card-1", "spec": golden("eventCard")})
    time.sleep(0.3)
    s = host()
    check("event card appears", reply.get("ok") and (s.get("surface") or {}).get("panel"), reply=reply)
    step("card", shot=shot(out_dir, pid, host_pid, "card-1-shown"))
    k = key("cmd-2", pid)
    s = host()
    check("command-2 reveals the times", k.get("consumed") and ((s.get("surface") or {}).get("ui") or {}).get("revealed") == "changeTime",
          ui=(s.get("surface") or {}).get("ui"))
    step("card-time", shot=shot(out_dir, pid, host_pid, "card-2-change-time"))
    key("down", pid)
    k = key("tab", pid)
    time.sleep(0.25)
    s = host()
    acc = (s.get("surface") or {}).get("lastAccepted") or {}
    check("tab reports the accepted action with the chosen time", k.get("consumed") and acc.get("actionId") == "add"
          and acc.get("overrides") == {"time": 2} and acc.get("offerKey") == "card-1", accepted=acc)
    step("working", shot=shot(out_dir, pid, host_pid, "card-3-working"), accepted=acc)
    time.sleep(3.3)
    s = host()
    line_text = (s.get("surface") or {}).get("lineText") or ""
    check("after 3 s the working line counts seconds (and offers Esc Stop)",
          any(f", {n} s" in line_text for n in range(3, 10)), line=line_text)
    step("working-3s", shot=shot(out_dir, pid, host_pid, "card-4-working-3s"))
    host("progress done")
    time.sleep(0.4)
    step("done", shot=shot(out_dir, pid, host_pid, "card-5-done"), line=(host().get("surface") or {}).get("lineText"))
    after = watch(pid)
    check("the card never moved the frontmost app or the focused element", after["front"] == before["front"]
          and after["focused"] == before["focused"], before=before, after=after)
    time.sleep(5.5)

    reply = inject({"kind": "popup", "pid": pid, "offerKey": "which-1", "spec": golden("picker")})
    time.sleep(0.3)
    step("picker", shot=shot(out_dir, pid, host_pid, "picker-1-shown"))
    key("cmd-3", pid)
    step("picker-3", shot=shot(out_dir, pid, host_pid, "picker-2-cmd3"))
    k = key("tab", pid)
    time.sleep(0.2)
    acc = (host().get("surface") or {}).get("lastAccepted") or {}
    check("picker: command-3 then tab takes row 3", k.get("consumed") and acc.get("actionId") == "choose" and acc.get("row") == 2, accepted=acc)
    host("progress error")
    time.sleep(0.4)
    step("error", shot=shot(out_dir, pid, host_pid, "picker-3-error"))
    k = key("esc", pid)
    s = host()
    check("esc closes the error line", k.get("consumed") and not ((s.get("surface") or {}).get("lineText")), key=k)

    reply = inject({"kind": "popup", "pid": pid, "offerKey": "fill-1", "spec": golden("fillPreview")})
    time.sleep(0.3)
    step("fill-preview", shot=shot(out_dir, pid, host_pid, "fill-preview"))
    k = key("esc", pid)
    s = host()
    check("esc closes a pop-up", k.get("consumed") and not s.get("offer"), key=k)

    line = {"kind": "action", "pid": pid, "offerKey": "line-1", "app": "Calendar",
            "endState": {"text": "Coffee with Dana, Thu 3:00 to 3:30", "ref": {"node": "4242-1/compose/body", "quote": "coffee with Dana on Thursday at 3"}},
            "actions": [{"id": "add", "label": "Add", "key": "tab"}], "variants": golden("picker")}
    inject(line)
    time.sleep(0.3)
    step("action-line", shot=shot(out_dir, pid, host_pid, "line-1-shown"))
    k1 = key("cmd-1", pid)
    s = host()
    check("command-1 on an action line with nothing numbered passes through and dismisses", not k1.get("consumed") and not s.get("offer"), key=k1)
    inject(line)
    time.sleep(0.2)
    key("down", pid)
    step("action-variants", shot=shot(out_dir, pid, host_pid, "line-2-variants"))
    key("down", pid)
    k = key("tab", pid)
    time.sleep(0.2)
    acc = (host().get("surface") or {}).get("lastAccepted") or {}
    check("down opens an action line's variants; tab takes the highlighted one", k.get("consumed") and acc.get("overrides") == {"variants": 1}, accepted=acc)
    host("progress done")

    check("no panel was ever the key window", not KEY_PANELS, keyPanels=KEY_PANELS)
    results["checks"] = CHECKS
    results["final"] = host()
    return results


def fill(out_dir, appearance):
    pid, host_pid, gold = rig(out_dir, appearance)
    by_label = {g["label"]: g for g in gold}
    results = {"pid": pid, "appearance": appearance, "steps": []}
    labels = ["Full name", "Email", "Phone", "Company", "Order number"]
    proposal = {
        "type": "fillProposal", "v": 1, "id": "a3-fill-1", "at": int(time.time() * 1000), "windowId": f"{pid}-2",
        "bundleId": "dev.caret.fixture", "triggerKey": "claim/name",
        "fields": [{
            "key": f"claim/{label.lower().replace(' ', '-')}", "frame": by_label[label]["frame"],
            "descriptor": f"Text field. Label: '{label}'.", "choice": f"c{i}", "confidence": 0.97,
            "value": by_label[label]["gold"],
            "source": {"windowId": f"{pid}-1", "bundleId": "dev.caret.fixture", "appName": "Caret Fixture",
                       "windowTitle": REFERENCE, "nodeKey": f"reference/{i}", "kind": None},
            "withheld": None,
            "asks": [{"choice": f"c{i}", "confidence": 0.97, "value": by_label[label]["gold"]}] * 2,
        } for i, label in enumerate(labels)],
        "candidates": len(labels), "cutoff": 0.9,
        "jev": {"model": "synthetic", "latencyMs": 0, "inputTokens": 0, "costUsd": 0},
    }
    ax(pid, "focus", pid, frame_arg(by_label["Full name"]["frame"]))
    time.sleep(0.3)
    before = watch(pid)
    reply = inject({"kind": "helperLine", "line": proposal})
    offer = wait_for(lambda: (lambda s: s.get("offer") if (s.get("offer") or {}).get("kind") == "fill" else None)(host()), 5)
    s = host()
    ov = (s.get("fill") or {}).get("overlay") or {}
    check("fill offer for the first field", reply.get("ok") and offer is not None, reply=reply, lastSkip=(s.get("fill") or {}).get("lastSkip"))
    results["steps"].append({"step": "first", "placement": ov.get("placement"), "shot": shot(out_dir, pid, host_pid, "fill-1-first-offer")})

    def take_and_follow(label, next_label, name):
        last = (host().get("lastInsertion") or {}).get("claimID", 0)
        key("tab", pid)
        wait_for(lambda: (lambda st: st.get("lastInsertion") and st["lastInsertion"]["claimID"] > last)(host()), 5)
        # The host posts Tab to the fixture's pid to move focus; the next field's offer follows.
        nxt = wait_for(lambda: (lambda st: st["offer"] if (st.get("offer") or {}).get("kind") == "fill"
                                and (st["offer"].get("fill") or {}).get("fieldKey", "").endswith(next_label.lower().replace(" ", "-")) else None)(host()), 5)
        time.sleep(0.35)
        st = host()
        ov = (st.get("fill") or {}).get("overlay") or {}
        value = ax(pid, "value", pid, frame_arg(by_label[label]["frame"]))["value"]
        stacked = bool(ov.get("line")) and bool(ov.get("toast"))
        check(f"{label}: filled, and the toast and the next offer do not stack", value == by_label[label]["gold"] and nxt is not None
              and not stacked and ov.get("toast") and ov.get("lineDeferred"),
              value=value, nextOffer=bool(nxt), line=bool(ov.get("line")), toast=bool(ov.get("toast")), deferred=ov.get("lineDeferred"),
              placement=ov.get("placement"))
        results["steps"].append({"step": name, "placement": ov.get("placement"), "toast": ov.get("toast"), "shot": shot(out_dir, pid, host_pid, name)})
        return ov

    take_and_follow("Full name", "Email", "fill-2-toast-then-email")
    take_and_follow("Email", "Phone", "fill-3-toast-then-phone")
    # The toast lives 5 s; then the waiting offer's line takes the stage, placed so it covers
    # neither neighbor in this tight form.
    time.sleep(5.6)
    s = host()
    ov = (s.get("fill") or {}).get("overlay") or {}
    line = ov.get("line")
    covered = []
    if line:
        lx, ly, lw, lh = line["frame"]
        for g in gold:
            gx, gy, gw, gh = g["frame"]
            if g["label"] != "Phone" and lx < gx + gw and gx < lx + lw and ly < gy + gh and gy < ly + lh:
                covered.append(g["label"])
    check("after the toast, the next offer's line appears and covers no other field", line is not None and not covered and not ov.get("toast"),
          placement=ov.get("placement"), covered=covered, frame=line and line["frame"])
    results["steps"].append({"step": "after-toast", "placement": ov.get("placement"), "shot": shot(out_dir, pid, host_pid, "fill-4-line-after-toast")})
    after = watch(pid)
    check("fill never moved the frontmost app", after["front"] == before["front"], before=before["front"], after=after["front"])
    check("no panel was ever the key window", not KEY_PANELS, keyPanels=KEY_PANELS)
    results["checks"] = CHECKS
    results["final"] = host()
    return results


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ("alternatives", "fill"):
        raise SystemExit(__doc__)
    mode, out = sys.argv[1], sys.argv[2]
    appearance = sys.argv[3] if len(sys.argv) == 4 else "light"
    results = {}
    try:
        results = (alternatives if mode == "alternatives" else fill)(out, appearance)
    finally:
        stop_all()
        for undo in CLEANUP:
            undo()
        os.makedirs(out, exist_ok=True)
        results["checks"] = CHECKS
        results["idleLog"] = IDLE_LOG
        results["passed"] = sum(c["ok"] for c in CHECKS)
        results["failed"] = sum(not c["ok"] for c in CHECKS)
        with open(os.path.join(out, "results.json"), "w") as f:
            json.dump(results, f, indent=2, sort_keys=True, default=str)
        log("summary", results["passed"], "passed,", results["failed"], "failed")
