#!/usr/bin/env python3
"""Grounded-fill acceptance for the host, on caret-fixture's synthetic forms.

  fill_acceptance.py <evidence_dir>
  lockf -k ~/.long-run/locks/gui.lock fill_acceptance.py realtab|realtab-ghost|popup <evidence_dir>

Starts, and stops on exit, only processes it records: the helper (live Jev, its own socket and
data dir), one caret-fixture (Reference, Claim form, Schedule follow-up), the reader limited to
that pid, and the host limited to that pid with ghost text off.

The default mode posts no keyboard or mouse event anywhere. The fixture's key window changes by
AXMain writes and focus by AXFocused writes (fixture-ax refuses any pid it was not given). Tab,
Command-1 and Command-Z go through the host's debug-socket test hook, which calls the event tap's
own routing with a key headed for the fixture pid. Values are read back with fixture-ax and with
cua-driver get_window_state.

popup is the helper's fill pop-up end to end, in the foreground: Room number is filled by hand (an
AXValue write) so the five Schedule fields left all have a source, the fixture takes the
foreground, Meeting date is focused, live Jev grounds the form and the host draws "Fill 5 fields";
one real Tab runs the fill, every field is read back from the fixture, then a real Command-Z
undoes it and every field is read back empty.

Cases: ten fields driven to an exact match with the source text; a field whose answer is "none";
focus moved before Tab; Command-1 over a fill; undo; the source changing before Tab.

realtab-ghost also types a sentence into Promo code and reports keystroke-to-paint and how each
completion fit (`ghostFits`). CARET_GHOST_OVERFLOW=drop runs the host with KeyType's rule for a
completion too wide for its line, for the before row of A10's table.

realtab presses one real Tab through the event tap. It runs only with the gui lease, while
gui.lock is held, outside a quiet window and after CARET_REALTAB_IDLE_MIN seconds without input
(default 300). It starts by asking the fixture for the foreground (`activate legacy`, fixture_app.py),
posts the key only while NSWorkspace and lsappinfo both report the fixture frontmost, and hands the
foreground back when it ends (`quit PID`); any failed check ends the run as "deferred: foreground".
"""
import json
import os
import signal
import socket
import statistics
import subprocess
import sys
import threading
import time

import fixture_app

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SCREEN_BIN = os.path.join(ROOT, "apps", "screen-reader", ".build", "debug")
HELPER_DIR = os.path.join(ROOT, "helper")
CARET = os.path.join(ROOT, "apps", "caret", ".build", "Caret.app", "Contents", "MacOS", "Caret")
AX = os.path.join(ROOT, "apps", "caret", ".build", "fixture-ax")
COMPOSE = os.path.join(ROOT, "apps", "caret", ".build", "compose-shot")
SOCKETS = os.path.expanduser("~/.caret-run/sockets")
HELPER_SOCK = os.path.join(SOCKETS, "a2-screen.sock")
HOST_SOCK = os.path.join(SOCKETS, "a2-host.sock")
ENV_FILE = os.environ.get("CARET_ENV_FILE", os.path.expanduser("~/Programming Projects/Caret/.env"))

CLAIM = "Caret Fixture — Claim form"
SCHEDULE = "Caret Fixture — Schedule follow-up"
REFERENCE = "Caret Fixture — Reference"

STARTED = []  # (name, Popen), stopped in reverse order on exit
NAMES = {}  # pid to name, for the frontmost-app timeline
# Windows (start, end) in which an HIDIdleTime reset is this run's own HID-level key, not a person.
SYNTHETIC = []


def expect_synthetic(seconds):
    SYNTHETIC.append((time.time(), time.time() + seconds))
BEFORE_STOP = []  # run first: the fixture hands the foreground back while it still can


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


# B23: caret-screen accepts only a helper that proves it holds this run's launch secret; both get it
# on their standard input (--auth-fd 0), never on a command line.
LAUNCH_SECRET = os.urandom(32)


def start_with_secret(name, args, out_dir, env=None, cwd=None):
    proc = start(name, args, out_dir, env=env, cwd=cwd, stdin=subprocess.PIPE)
    proc.stdin.write(LAUNCH_SECRET)
    proc.stdin.close()
    return proc


def start(name, args, out_dir, env=None, cwd=None, stdin=None):
    out = open(os.path.join(out_dir, f"{name}.log"), "w")
    proc = subprocess.Popen(args, stdout=out, stderr=subprocess.STDOUT, env=env, cwd=cwd, stdin=stdin)
    STARTED.append((name, proc))
    NAMES[proc.pid] = name
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
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    s.connect(HOST_SOCK)
    s.sendall(command.encode() + b"\n")
    chunks = []
    while True:
        b = s.recv(65536)
        if not b:
            break
        chunks.append(b)
    s.close()
    return json.loads(b"".join(chunks))


def ax(pids, *args):
    env = dict(os.environ, CARET_TEST_PIDS=",".join(map(str, pids)))
    out = subprocess.run([AX, *map(str, args)], capture_output=True, text=True, env=env)
    if out.returncode != 0:
        raise RuntimeError(f"fixture-ax {args[0]} failed: {out.stderr.strip()}")
    return json.loads(out.stdout)


def wait_for(predicate, timeout, interval=0.01):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


def frame_arg(frame):
    return ",".join(str(v) for v in frame)


def record_proposals(path):
    """A second consumer on the helper's socket, saving every helper message with its arrival
    time. Fixture runs only: the proposals carry synthetic values."""
    def run():
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(HELPER_SOCK)
        s.sendall(json.dumps({"type": "hello", "v": 1, "role": "consumer", "mode": "live", "pid": os.getpid(),
                              "version": "fill_acceptance"}).encode() + b"\n")
        buf = b""
        with open(path, "a") as out:
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    return
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    out.write(json.dumps({"receivedAtMs": time.time() * 1000, "message": json.loads(line)}) + "\n")
                    out.flush()
    threading.Thread(target=run, daemon=True).start()


def cua_read(pid, window_title, frame):
    """cua-driver get_window_state: the value of the text field at `frame` in that window."""
    windows = json.loads(subprocess.run(["cua-driver", "list_windows", json.dumps({"pid": pid})], capture_output=True, text=True).stdout or "{}")
    wids = [w["window_id"] for w in windows.get("windows", []) if w.get("title") == window_title]
    if not wids:
        return {"status": "noWindow"}
    out = subprocess.run(["cua-driver", "get_window_state", json.dumps({"pid": pid, "window_id": wids[0]})], capture_output=True, text=True)
    try:
        state = json.loads(out.stdout)
    except json.JSONDecodeError:
        return {"status": "error", "raw": (out.stdout + out.stderr)[:300]}
    for e in state.get("elements", []):
        f = e.get("frame") or {}
        if e.get("role") == "AXTextField" and all(abs(a - b) <= 1 for a, b in zip([f.get("x"), f.get("y"), f.get("w"), f.get("h")], frame)):
            return {"status": "found", "element": e}
    return {"status": "noElement"}


def cua_verify(pid, window_title, value):
    """cua-driver verify_state: some text field in the window holds exactly `value`."""
    windows = json.loads(subprocess.run(["cua-driver", "list_windows", json.dumps({"pid": pid})], capture_output=True, text=True).stdout or "{}")
    wid = None
    for w in windows.get("windows", []):
        if w.get("title") == window_title and w.get("pid", pid) == pid:
            wid = w.get("window_id")
    args = {"pid": pid, "expect": [{"element": {"selector": {"role": "AXTextField"}, "value_equals": value}}], "timeout_ms": 1500}
    if wid is not None:
        args["window_id"] = wid
    out = subprocess.run(["cua-driver", "verify_state", json.dumps(args)], capture_output=True, text=True)
    try:
        result = json.loads(out.stdout)
    except json.JSONDecodeError:
        return {"status": "error", "raw": (out.stdout + out.stderr)[:400]}
    return result


PANELS_EVER_KEY = []


def shot(out_dir, pid, window_title, name):
    """The fixture window plus the host's overlay panels, each captured by window id and joined.
    Region captures are never used: the fixture sits behind other windows, and a region capture
    would record whatever covers it."""
    shots = os.path.join(out_dir, "shots")
    os.makedirs(shots, exist_ok=True)
    windows = json.loads(subprocess.run(["cua-driver", "list_windows", json.dumps({"pid": pid})], capture_output=True, text=True).stdout or "{}")
    win = next((w for w in windows.get("windows", []) if w.get("title") == window_title), None)
    if win is None:
        return None
    b = win["bounds"]
    layers = []
    base = os.path.join(shots, f"{name}-window.png")
    subprocess.run(["screencapture", "-x", "-o", f"-l{win['window_id']}", base], check=True)
    layers.append(f"{base}:{b['x']},{b['y']},{b['width']},{b['height']}")
    state = host()
    overlay = (state.get("fill") or {}).get("overlay") or {}
    surface = state.get("surface") or {}
    for kind, panel in [(k, overlay.get(k)) for k in ("ghost", "line", "toast")] + [("surface-" + k, surface.get(k)) for k in ("panel", "decor", "list")]:
        if not panel or (panel.get("text") or "").startswith("(exiting)"):
            continue
        if panel["isKey"]:
            PANELS_EVER_KEY.append((name, kind))
        path = os.path.join(shots, f"{name}-{kind}.png")
        subprocess.run(["screencapture", "-x", "-o", f"-l{panel['windowNumber']}", path], check=True)
        layers.append(path + ":" + ",".join(str(v) for v in panel["frame"]))
    out = os.path.join(shots, f"{name}.png")
    subprocess.run([COMPOSE, out, *layers], check=True, capture_output=True)
    for layer in layers:
        os.remove(layer.rsplit(":", 1)[0])
    return {"file": out, "overlay": overlay}


def fill_offer(pid, after_id):
    s = host()
    o = s.get("offer")
    if o and o.get("kind") == "fill" and o.get("pid") == pid and o.get("id", 0) > after_id:
        return o
    return None


def rig(out_dir, ghost=False, act=False):
    """Starts helper, fixtures, reader and host. Returns (fixture-claim, fixture-schedule, gold).
    `act`: the reader may write and press in the fixture (--act-pids), as the executor needs; the
    per-field fill writes through the host and needs no such grant."""
    os.makedirs(out_dir, exist_ok=True)
    for path in (HELPER_SOCK, HOST_SOCK):
        if os.path.exists(path):
            raise SystemExit(f"{path} exists; another run may be live")
    data_dir = os.path.join(out_dir, "helper-data")
    record = os.path.join(out_dir, "reader-record.ndjson")
    if os.path.exists(record):
        os.remove(record)

    helper_env = dict(os.environ, CARET_ENV_FILE=ENV_FILE)
    start_with_secret("helper", ["node", "src/main.ts", "--auth-fd", "0", "--socket", HELPER_SOCK, "--data-dir", data_dir, "--allow-background-focus"],
                      out_dir, env=helper_env, cwd=HELPER_DIR)
    if not wait_for(lambda: os.path.exists(HELPER_SOCK), 10, 0.1):
        raise SystemExit("helper did not open its socket")
    record_proposals(os.path.join(out_dir, "proposals.ndjson"))

    # One fixture process with the Reference window and both forms, as the screen track's fill
    # evaluation runs it. The driver switches the fixture's key window with AXMain (no activation),
    # so Reference is the window the user just left when a form is focused.
    # CaretFixture.app with --foreground, so AXMain can make its windows key (fixture_app.py); stdin
    # stays open for `activate` and `quit` in realtab.
    fx = start("fixture", fixture_app.args("--windows", "reference,claim,schedule",
                                           "--gold", os.path.join(out_dir, "gold.json"), "--duration", "1200"),
               out_dir, stdin=subprocess.PIPE)
    fx_a = fx_b = fx
    pids = [fx.pid]
    wait_for(lambda: os.path.exists(os.path.join(out_dir, "gold.json")), 10, 0.1)
    time.sleep(1)
    gold = {}
    with open(os.path.join(out_dir, "gold.json")) as f:
        for form in json.load(f)["forms"]:
            gold[form["window"]] = form["fields"]

    # The fixture writes view frames; Accessibility reports the field's frame with its bezel, 1 pt
    # larger on every side. The reader and host both use the AX frame, so the driver does too.
    for pid in pids:
        live = ax(pids, "fields", pid)

        for window, fields in gold.items():
            for field in fields:
                x, y, w, h = field["frame"]
                match = [f["frame"] for f in live if f["window"] == window
                         and all(abs(a - b) <= 2 for a, b in zip(f["frame"], [x, y, w, h]))]
                if match:
                    field["viewFrame"], field["frame"] = field["frame"], match[0]

    pid_list = ",".join(map(str, pids))
    start_with_secret("reader", [os.path.join(SCREEN_BIN, "caret-screen"), "--auth-fd", "0", "--socket", HELPER_SOCK, "--only-pids", pid_list,
                     "--event-pids", pid_list, "--record", record] + (["--act-pids", pid_list] if act else []), out_dir)
    host_args = [CARET, "--socket", HOST_SOCK, "--helper-socket", HELPER_SOCK, "--allow-pids", pid_list]
    if not ghost:
        host_args.append("--no-ghost")
    start("host", host_args, out_dir, env=dict(os.environ, CARET_FILL_ADVANCE=os.environ.get("CARET_FILL_ADVANCE", "off")))
    if not wait_for(lambda: os.path.exists(HOST_SOCK), 15, 0.1):
        raise SystemExit("host did not open its socket")
    state = wait_for(lambda: (lambda s: s if s.get("helper", {}).get("connected") else None)(host()), 15, 0.2)
    if not state:
        raise SystemExit("host never connected to the helper")
    log("host connected; trust", state["trust"])

    # The reader's first walk of every window takes a few seconds.
    time.sleep(4)
    return fx_a, fx_b, gold


def visit(pids, pid, form):
    """The user looks at Reference, then goes to the form: each becomes the fixture's key window."""
    r = ax(pids, "key-window", pid, REFERENCE)
    time.sleep(1.5)
    f = ax(pids, "key-window", pid, form)
    if r["frontAfter"] != r["frontBefore"] or f["frontAfter"] != f["frontBefore"]:
        raise SystemExit(f"frontmost app changed during a key-window switch: {r} {f}")
    time.sleep(0.3)


def main(out_dir):
    fx_a, fx_b, gold = rig(out_dir)
    pids = [fx_a.pid]

    results = {"fields": [], "cases": {}, "pids": {"claim": fx_a.pid, "schedule": fx_b.pid}}
    last_offer_id = 0

    shots_for = {"Email", "Shipping address", "Start time", "Attendee job title"}

    def drive(window, index, pid, claim=True):
        nonlocal last_offer_id
        field = gold[window][index]
        frame = field["frame"]
        current = ax(pids, "focused", pid)
        already = current.get("frame") and all(abs(a - b) <= 1 for a, b in zip(current["frame"], frame))
        focus_at = None
        if not already:
            focus_at = ax(pids, "focus", pid, frame_arg(frame))["atMs"] / 1000
        proposals_before = host()["helper"]["proposals"]
        offer = wait_for(lambda: fill_offer(pid, last_offer_id), 12)
        seen_at = time.time()
        entry = {"window": window, "label": field["label"], "gold": field["gold"], "focusedByDriver": not already}
        if offer is None:
            entry.update(offer=None, lastSkip=host()["fill"].get("lastSkip"))
            return entry
        last_offer_id = offer["id"]
        if shots_for and field["label"] in shots_for:
            time.sleep(0.25)  # let the 160 ms entrance finish
            entry["shotOffer"] = shot(out_dir, pid, window, field["label"].lower().replace(" ", "-") + "-offer")
        entry.update(offer=offer["text"], source=offer["fill"]["source"],
                     newProposalArrived=host()["helper"]["proposals"] > proposals_before,
                     focusToOfferMs=None if focus_at is None else round((seen_at - focus_at) * 1000, 1))
        if not claim:
            return entry
        consumed = host(f"key tab {pid}")["consumed"]
        claim_id = host()["lastClaim"]["claimID"] if consumed else None
        ins = wait_for(lambda: (lambda s: s["lastInsertion"] if s.get("lastInsertion") and s["lastInsertion"]["claimID"] == claim_id else None)(host()), 5)
        value = ax(pids, "value", pid, frame_arg(frame))["value"]
        entry.update(consumed=consumed, insertion=ins, value=value, exact=(value == field["gold"]))
        if shots_for and field["label"] in shots_for:
            time.sleep(0.25)
            entry["shotToast"] = shot(out_dir, pid, window, field["label"].lower().replace(" ", "-") + "-toast")
        entry["cua"] = cua_read(pid, window, frame)
        return entry

    # 1. Ten fields: Claim form 1-8 (fixture-claim), Schedule 1-2 (fixture-schedule).
    plan = [(CLAIM, i, fx_a.pid) for i in range(8)] + [(SCHEDULE, i, fx_b.pid) for i in range(2)]
    for window, index, pid in plan:
        if index == 0:
            visit(pids, pid, window)
        entry = drive(window, index, pid)
        results["fields"].append(entry)
        log(f"{entry['label']:<18} offer={entry.get('offer')!r} value={entry.get('value')!r} exact={entry.get('exact')} "
            f"latency={entry.get('focusToOfferMs')} method={(entry.get('insertion') or {}).get('method')}")
        # Undo on the last of the ten, while its toast is up.
        if (window, index) == (SCHEDULE, 1) and entry.get("exact"):
            toast = host()["fill"].get("toast")
            undo = host(f"key cmd-z {pid}")
            done = wait_for(lambda: host().get("lastUndo"), 3)
            after = ax(pids, "value", pid, frame_arg(gold[window][index]["frame"]))["value"]
            results["cases"]["undo"] = {"toastBefore": toast, "consumed": undo["consumed"], "lastUndo": done,
                                        "valueAfter": after, "restored": after == ""}
            # Second Command-Z must be the host app's: no toast, not consumed.
            results["cases"]["undo"]["shot"] = shot(out_dir, pid, window, "start-time-undone")
            results["cases"]["undo"]["secondConsumed"] = host(f"key cmd-z {pid}")["consumed"]
            log("undo", results["cases"]["undo"])

    # 2. "none": Claim form's Promo code and Schedule's Room number have no source.
    for window, index, pid in [(CLAIM, 8, fx_a.pid), (SCHEDULE, 5, fx_b.pid)]:
        field = gold[window][index]
        visit(pids, pid, window)
        ax(pids, "focus", pid, frame_arg(field["frame"]))
        time.sleep(4)  # long enough for a fresh proposal to arrive and be evaluated
        s = host()
        o = s.get("offer")
        results["cases"].setdefault("none", []).append({
            "label": field["label"], "offerShown": bool(o and o.get("kind") == "fill" and o.get("pid") == pid),
            "lastSkip": s["fill"].get("lastSkip"), "tabConsumed": host(f"key tab {pid}")["consumed"],
            "value": ax(pids, "value", pid, frame_arg(field["frame"]))["value"],
        })
        log("none", results["cases"]["none"][-1])

    # 3. Command-1 over a fill offer passes through and dismisses it (Schedule: Video link).
    entry = drive(SCHEDULE, 2, fx_b.pid, claim=False)
    c1 = host(f"key cmd-1 {fx_b.pid}")["consumed"]
    results["cases"]["command1"] = {"offerWas": entry.get("offer"), "consumed": c1, "offerAfter": host().get("offer")}
    log("cmd-1", results["cases"]["command1"])

    # 4. Focus moves before Tab: offer on Video link, focus to Room number (no offer), Tab passes.
    entry = drive(SCHEDULE, 2, fx_b.pid, claim=False)
    if entry.get("offer") is None:
        # Command-1 dismissed it; refocus elsewhere and back to get it again.
        ax(pids, "focus", fx_b.pid, frame_arg(gold[SCHEDULE][5]["frame"]))
        time.sleep(0.3)
        entry = drive(SCHEDULE, 2, fx_b.pid, claim=False)
    ax(pids, "focus", fx_b.pid, frame_arg(gold[SCHEDULE][5]["frame"]))
    gone = wait_for(lambda: not (host().get("offer") or {}).get("kind") == "fill", 2)
    consumed = host(f"key tab {fx_b.pid}")["consumed"]
    time.sleep(0.5)
    results["cases"]["focusMoved"] = {
        "offerBefore": entry.get("offer"), "offerGoneAfterFocus": bool(gone), "tabConsumed": consumed,
        "videoLink": ax(pids, "value", fx_b.pid, frame_arg(gold[SCHEDULE][2]["frame"]))["value"],
        "roomNumber": ax(pids, "value", fx_b.pid, frame_arg(gold[SCHEDULE][5]["frame"]))["value"],
    }
    log("focus moved", results["cases"]["focusMoved"])

    # 5. Source changes between proposal and Tab (Schedule: Attendee job title, only in Reference).
    entry = drive(SCHEDULE, 4, fx_b.pid, claim=False)
    change = {"offerBefore": entry.get("offer"), "source": entry.get("source")}
    if entry.get("offer"):
        try:
            rewrite = ax(pids, "set-text", fx_a.pid, REFERENCE, entry["offer"], "Principal Product Designer")
        except RuntimeError as e:
            rewrite = {"ok": False, "error": str(e)}
        change["rewrite"] = rewrite
        if not rewrite.get("ok"):
            # Fixture labels are not editable through AX; remove the source instead.
            change["closed"] = ax(pids, "close", fx_a.pid, REFERENCE)
        time.sleep(0.3)
        offer_still = host().get("offer")
        consumed = host(f"key tab {fx_b.pid}")["consumed"]
        time.sleep(0.6)
        change["shot"] = shot(out_dir, fx_b.pid, SCHEDULE, "source-changed-error")
        s = host()
        change.update(offerStillShownAtTab=bool(offer_still), tabConsumed=consumed,
                      insertion=s.get("lastInsertion"), fillResult=s["fill"].get("lastResult"),
                      toast=s["fill"].get("toast"),
                      value=ax(pids, "value", fx_b.pid, frame_arg(gold[SCHEDULE][4]["frame"]))["value"])
        change["untouched"] = change["value"] == ""
    results["cases"]["sourceChanged"] = change
    log("source changed", change)

    final = host()
    results["host"] = {k: final.get(k) for k in ("fill", "helper", "writeMethods", "tap", "counters", "lastUndo")}
    fields = results["fields"]
    lat = [f["focusToOfferMs"] for f in fields if f.get("focusToOfferMs") is not None]
    results["panelsEverKey"] = PANELS_EVER_KEY
    results["summary"] = {
        "driven": len(fields),
        "correct": sum(1 for f in fields if f.get("exact")),
        "wrong": sum(1 for f in fields if f.get("value") not in (None, "") and not f.get("exact")),
        "noOffer": sum(1 for f in fields if f.get("offer") is None),
        "cuaMatchesGold": sum(1 for f in fields if json.dumps((f.get("cua") or {}).get("element", {})).find(json.dumps(f["gold"] or "")[1:-1]) >= 0 and f.get("exact")),
        "focusToOfferMs": {
            "n": len(lat),
            "p50": statistics.median(lat) if lat else None,
            "p95": sorted(lat)[max(0, int(len(lat) * 0.95 + 0.999) - 1)] if lat else None,
            "samples": lat,
        },
    }
    with open(os.path.join(out_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=2, sort_keys=True)
    log("summary", json.dumps(results["summary"]))


IDLE_MIN = float(os.environ.get("CARET_REALTAB_IDLE_MIN", "300"))


def hid_idle_seconds():
    out = subprocess.run(["ioreg", "-c", "IOHIDSystem"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if "HIDIdleTime" in line:
            return int(line.split()[-1]) / 1e9
    return 0.0


def realtab(out_dir, ghost):
    """The real Tab path through the event tap, under the shared-Mac global-event exception."""
    result = {"status": None}
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "realtab.json")

    def finish(status, **extra):
        result.update(status=status, **extra)
        with open(path, "w") as f:
            json.dump(result, f, indent=2, sort_keys=True)
        log("realtab", status, json.dumps(extra)[:400])

    why = fixture_app.why_not_foreground(IDLE_MIN)
    if why:
        return finish(why, idleSeconds=hid_idle_seconds())
    fx_a, fx_b, gold = rig(out_dir, ghost=ghost)
    pids = [fx_a.pid]
    pid = fx_a.pid
    field = gold[CLAIM][0]
    visit(pids, pid, CLAIM)
    ax(pids, "focus", pid, frame_arg(field["frame"]))
    # Since A3's surface gate, an offer for an app that is not frontmost is held, not drawn
    # (lastSkip "held.appNotFront"); the offer itself is checked again after activation.
    offer = wait_for(lambda: fill_offer(pid, 0) or host()["fill"].get("lastSkip") == "held.appNotFront", 15)
    if not offer:
        return finish("failed: no fill offer before activation", lastSkip=host()["fill"].get("lastSkip"))
    # The visibility gate in the path: with the fixture behind, the offer is held, not drawn.
    pre = host()
    result["beforeActivation"] = {"offerShown": bool(fill_offer(pid, 0)), "lastSkip": pre["fill"].get("lastSkip"),
                                  "overlayLine": bool(((pre.get("fill") or {}).get("overlay") or {}).get("line"))}
    # The model loads before the foreground is taken, so the fixture is frontmost only for the
    # seconds the keys need.
    if ghost and not wait_for(lambda: host()["engine"]["state"] == "ready", 120, 0.5):
        return finish("failed: model did not load", engine=host()["engine"])
    why = fixture_app.why_not_foreground(IDLE_MIN)
    if why:
        return finish(why, idleSeconds=hid_idle_seconds())
    before = host()["tap"]
    previous = ax(pids, "frontmost").get("pid")
    BEFORE_STOP.append(lambda: fixture_app.hand_back(fx_a, previous))
    ok, front = fixture_app.activate(fx_a, lambda: ax(pids, "frontmost"))
    if not ok:
        return finish("deferred: foreground", step="activate legacy", frontmost=front)
    offer = wait_for(lambda: fill_offer(pid, 0), 3)
    if not offer:
        return finish("failed: offer gone after activation", lastSkip=host()["fill"].get("lastSkip"))
    env = dict(os.environ, CARET_TEST_PIDS=",".join(map(str, pids)))
    expect_synthetic(3)
    sent = subprocess.run([AX, "key-if-front", str(pid), "tab"], capture_output=True, text=True, env=env)
    if sent.returncode != 0:
        return finish("deferred: foreground", step="tab", output=sent.stdout + sent.stderr)
    claim_id = wait_for(lambda: (host().get("lastClaim") or {}).get("claimID"), 2)
    ins = wait_for(lambda: (lambda s: s["lastInsertion"] if s.get("lastInsertion") and s["lastInsertion"]["claimID"] == claim_id else None)(host()), 5)
    value = ax(pids, "value", pid, frame_arg(field["frame"]))["value"]
    after = host()["tap"]
    extra = {
        "offer": offer["text"], "gold": field["gold"], "value": value, "exact": value == field["gold"],
        "insertion": ins, "tapBefore": before, "tapAfter": after,
        "consumedDelta": after["consumed"] - before["consumed"],
    }
    if ghost:
        # Before cua_read: in A9 a cua-driver window (layer 0, opaque by its alpha) was over the
        # Promo code field after it, and the gate held all 79 ghost offers as covered.
        extra["paint"] = keystroke_to_paint(pids, pid, gold)
        if isinstance(extra["paint"], str):
            return finish(extra["paint"], **extra)
    extra["cua"] = cua_read(pid, CLAIM, field["frame"])
    finish("done", **extra)


def popup(out_dir):
    """The helper's fill pop-up, drawn, taken with a real Tab and undone with a real Command-Z."""
    result = {"status": None, "checks": []}
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "realtab.json")

    def check(name, ok, **detail):
        result["checks"].append({"check": name, "ok": bool(ok), **detail})
        log("PASS" if ok else "FAIL", name, json.dumps(detail, default=str)[:300])
        return ok

    def finish(status, **extra):
        result.update(status=status, **extra)
        with open(path, "w") as f:
            json.dump(result, f, indent=2, sort_keys=True, default=str)
        log("popup", status)

    why = fixture_app.why_not_foreground(IDLE_MIN)
    if why:
        return finish(why, idleSeconds=hid_idle_seconds())
    # The pop-up's fill runs through the executor, which writes with the reader's verbs.
    fx, _, gold = rig(out_dir, act=True)
    pids = [fx.pid]
    pid = fx.pid
    env = dict(os.environ, CARET_TEST_PIDS=str(pid))
    fields = gold[SCHEDULE]
    filled, room = fields[:5], fields[5]
    value = lambda f: ax(pids, "value", pid, frame_arg(f["frame"]))["value"]
    by_hand = ax(pids, "set-field", pid, frame_arg(room["frame"]), "12")
    if not check("Room number filled by hand, so every field left has a source", by_hand.get("ok") and value(room) == "12", write=by_hand):
        return finish("failed: could not fill Room number")

    previous = ax(pids, "frontmost").get("pid")
    BEFORE_STOP.append(lambda: fixture_app.hand_back(fx, previous))
    ok, front = fixture_app.activate(fx, lambda: ax(pids, "frontmost"))
    if not ok:
        return finish("deferred: foreground", step="activate legacy", frontmost=front)
    visit(pids, pid, SCHEDULE)
    focus_at = ax(pids, "focus", pid, frame_arg(filled[0]["frame"]))["atMs"] / 1000
    shown = wait_for(lambda: (lambda sf: sf if sf.get("kind") == "popup" and sf.get("panel") else None)(host().get("surface") or {}), 25, 0.05)
    shown_at = time.time()
    if not check("the helper's fill pop-up is drawn at Meeting date", shown is not None,
                 lastSkip=host()["fill"].get("lastSkip"), surface=(host().get("surface") or {})):
        return finish("failed: no fill pop-up")
    offer_key = shown["offerKey"]
    result["focusToPopupMs"] = round((shown_at - focus_at) * 1000, 1)
    time.sleep(0.25)  # the entrance
    result["shotPopup"] = shot(out_dir, pid, SCHEDULE, "popup-1-shown")
    check("it reads Fill 5 fields", "Fill 5 fields" in ((shown.get("panel") or {}).get("text") or shown.get("lineText") or ""),
          text=(shown.get("panel") or {}).get("text"))

    taps0 = host()["tap"]
    expect_synthetic(3)
    tab = subprocess.run([AX, "key-if-front", str(pid), "tab"], capture_output=True, text=True, env=env)
    if tab.returncode != 0:
        return finish("deferred: foreground", step="tab", output=tab.stdout + tab.stderr)
    tab_at = time.time()
    accepted = wait_for(lambda: (lambda a: a if a and a.get("offerKey") == offer_key else None)((host().get("surface") or {}).get("lastAccepted")), 3, 0.02)
    check("a real Tab through the tap takes the pop-up: offerAccept fillAll", accepted is not None and accepted.get("actionId") == "fillAll"
          and host()["tap"]["consumed"] - taps0["consumed"] == 1, accepted=accepted, tapConsumed=host()["tap"]["consumed"] - taps0["consumed"])
    result["shotWorking"] = shot(out_dir, pid, SCHEDULE, "popup-2-working")
    toast = wait_for(lambda: (lambda t: t if t and t.get("kind") in ("done", "error") else None)((host().get("surface") or {}).get("toast")), 40, 0.05)
    done_at = time.time()
    result["tabToToastMs"] = round((done_at - tab_at) * 1000, 1)
    values = [value(f) for f in filled]
    check("every field holds its source's value, read back from the fixture", values == [f["gold"] for f in filled],
          values=values, gold=[f["gold"] for f in filled])
    check("the toast reads Filled 5 fields from the fixture, with Command-Z", toast is not None and toast.get("kind") == "done"
          and (toast.get("caption") or "").startswith("Filled 5 fields from ") and toast.get("grantID") is not None, toast=toast)
    check("Room number, filled by hand, is untouched", value(room) == "12")
    time.sleep(0.25)
    result["shotToast"] = shot(out_dir, pid, SCHEDULE, "popup-3-toast")

    expect_synthetic(3)
    undo = subprocess.run([AX, "key-if-front", str(pid), "cmd-z"], capture_output=True, text=True, env=env)
    if undo.returncode != 0:
        return finish("deferred: foreground", step="cmd-z", output=undo.stdout + undo.stderr)
    undo_at = time.time()
    undone = wait_for(lambda: (lambda t: t if t and t.get("kind") in ("undone", "error") else None)((host().get("surface") or {}).get("toast")), 15, 0.05)
    result["undoMs"] = round((time.time() - undo_at) * 1000, 1)
    after = [value(f) for f in filled]
    check("a real Command-Z undoes it: every filled field is empty again", after == [""] * 5 and undone is not None
          and undone.get("kind") == "undone", values=after, toast=undone)
    check("Room number still holds what was typed by hand", value(room) == "12")
    result["shotUndone"] = shot(out_dir, pid, SCHEDULE, "popup-4-undone")
    final = host()
    result["host"] = {k: final.get(k) for k in ("tap", "counters", "lastUndo", "helper")}
    failed = [c["check"] for c in result["checks"] if not c["ok"]]
    finish("done" if not failed else f"failed: {failed[0]}", offerKey=offer_key)


def keystroke_to_paint(pids, pid, gold):
    """Types a sentence into the Claim form's Promo code field (no fill offer there) one HID key
    at a time, each only while the fixture is frontmost, and reads the host's keystroke-to-paint
    samples. Returns the samples, or a deferred status string."""
    env = dict(os.environ, CARET_TEST_PIDS=",".join(map(str, pids)))
    engine = wait_for(lambda: host()["engine"]["state"] == "ready", 90, 0.5)
    if not engine:
        return "failed: model did not load"
    promo = gold[CLAIM][8]["frame"]
    ax(pids, "focus", pid, frame_arg(promo))
    caret_point = (promo[0] + 4, promo[1] + promo[3] / 2)
    windows_before = json.loads(subprocess.run([AX, "windows-at", *map(str, caret_point)], capture_output=True, text=True).stdout or "[]")
    host("latency-reset")
    keys_before = host()["tap"]["keyDowns"]
    text = "Please send the meeting notes to the team before lunch"
    for ch in text:
        args = ["space"] if ch == " " else ["char", ch]
        expect_synthetic(0.6)
        sent = subprocess.run([AX, "key-if-front", str(pid), *args], capture_output=True, text=True, env=env)
        if sent.returncode != 0:
            return "deferred: foreground"
        time.sleep(0.15)
    time.sleep(1)
    s = host()
    # Read back that every key landed in the fixture's field and nowhere else: the field holds
    # exactly the typed text, and the tap saw exactly that many key-downs.
    value = ax(pids, "value", pid, frame_arg(promo))["value"]
    windows_after = json.loads(subprocess.run([AX, "windows-at", *map(str, caret_point)], capture_output=True, text=True).stdout or "[]")
    return {"latency": s["latency"], "typed": text, "fieldValue": value, "landed": value == text,
            "windowsAtCaret": {"before": windows_before, "after": windows_after},
            "tapKeyDowns": s["tap"]["keyDowns"] - keys_before, "keysSent": len(text),
            "ghostCounters": {k: v for k, v in s["counters"].items() if k.startswith(("suppressed", "discarded", "offer", "held", "withdrawn", "ghost"))},
            # Each attempt to draw a completion: how it fit, or why not, with the room it had (A10).
            "ghostOverflow": os.environ.get("CARET_GHOST_OVERFLOW", "capsule"), "ghostFits": s.get("ghostFits"),
            "counters": s["counters"], "engine": s.get("engine"), "focus": s.get("focus"), "presentation": s.get("presentation")}


if __name__ == "__main__":
    if len(sys.argv) == 2:
        mode, out = "fill", sys.argv[1]
    elif len(sys.argv) == 3 and sys.argv[1] in ("realtab", "realtab-ghost", "popup"):
        mode, out = sys.argv[1], sys.argv[2]
    else:
        raise SystemExit(__doc__)
    lease = None if mode == "fill" else fixture_app.GuiLease()
    front = lambda: (lambda o: json.loads(o.stdout) if o.returncode == 0 else {})(
        subprocess.run([AX, "frontmost"], capture_output=True, text=True, env=dict(os.environ, CARET_TEST_PIDS="1")))
    dog = None if mode == "fill" else fixture_app.Watchdog(lambda t: any(a - 0.2 <= t <= b for a, b in SYNTHETIC), front, NAMES)
    stopped_by = None
    try:
        if lease:
            lease.__enter__()
        if dog:
            dog.__enter__()
        if mode == "fill":
            main(out)
        elif mode == "popup":
            popup(out)
        else:
            realtab(out, ghost=mode == "realtab-ghost")
    except KeyboardInterrupt:
        stopped_by = f"deferred: user active (input at {dog.tripped})" if dog and dog.tripped else "interrupted"
        log(stopped_by)
    finally:
        if dog:
            dog.__exit__()
        for hand_back in BEFORE_STOP:
            hand_back()
        stop_all()
        if lease:
            lease.__exit__()
        if dog:
            dog.timeline.append((round(time.time() - dog.start, 2), front().get("pid"), "after hand-back"))
            path = os.path.join(out, "realtab.json")
            result = json.load(open(path)) if os.path.exists(path) else {}
            result["frontTimeline"] = dog.timeline
            if stopped_by:
                result["status"] = stopped_by
            with open(path, "w") as f:
                json.dump(result, f, indent=2, sort_keys=True)
