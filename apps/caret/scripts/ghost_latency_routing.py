#!/usr/bin/env python3
"""H6: ghost-text latency with the router on and off, from the host's own latency recorder.

  ghost_latency_routing.py <evidence_dir> on|off [interval_ms]

on: the helper runs D2-02's router with live Jev (acceptance_helper.ts --routing live) and the host's
"Caret decides when to help" is on. off: the helper runs without the router and the host's setting is
"Always suggest as I type", which is how Caret worked before H6.

The passage is typed into an empty document in a TextEdit instance this run launches (never Sam's own
TextEdit: launch_app creates a new instance and the run refuses a pid that was already running), one
character at a time. Before each key the run checks that its TextEdit is frontmost (NSWorkspace and
LaunchServices). The key is first routed through the host's own tap path by the debug socket's `key`
hook, which stamps the key-down the latency recorder measures from and lets the arbiter see the key as
the event tap would; the character is then posted to that pid only (pid-keys, CGEventPostToPid), and the
document is read back through Accessibility before the next key. No key goes to the HID stream or the
session tap: real HID keys run only in the rig VM (BUILD-ORDER). caret-fixture's single-line fields were
tried first and posted too few value notifications for the host to read most keys (ghost-off-1).

The host records keystroke-to-paint for every key (`latency`) and, apart, for the key that finished a
sentence (`breakpointLatency`), the moment the router decides. After each sentence the run waits
`SETTLE` seconds so the decision and the first ghost text can arrive before the next key.

Every GUI gate of fixture_app.py: the gui lease, gui.lock held by the caller, 300 s idle, no quiet
window; a watchdog stops the run on any input that is not the run's own.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

import fixture_app
import surface_acceptance as sa
from e2e_textedit import FRAME, cua, textedit_pids

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = sa.ROOT
SCREEN_BIN = os.environ.get("CARET_FIXTURE_BIN_DIR") or os.path.join(ROOT, "apps", "screen-reader", ".build", "debug")
PIDKEYS = os.path.join(ROOT, "apps", "caret", ".build", "pid-keys")
SOCKS = tempfile.mkdtemp(prefix="caret-h6-ghost-")
HELPER_SOCK = os.path.join(SOCKS, "helper.sock")
STATE = os.path.join(SOCKS, "helper-state.json")
SETTLE = 2.5
# Synthetic, and short enough that a sentence is a breakpoint within the Message field. Four sentences:
# four breakpoint samples per run.
PASSAGE = [
    "Thanks for sending the notes. ",
    "I read them on the train this morning. ",
    "The budget section needs one more pass. ",
    "Can we talk it over soon. ",
]


def helper_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def document_value(pid):
    """The focused text of this run's TextEdit, read through Accessibility."""
    return sa.ax(pid, "focused-value", pid).get("value")


def type_char(c, pid, typed):
    """One character: frontmost checked, through the host's tap path (it stamps the key-down), posted to
    this run's TextEdit only, then read back before the next."""
    now = sa.front_pid()
    if not (now.get("pid") == pid and now.get("lsappinfo") == pid):
        raise SystemExit(f"deferred: foreground (front={now} before {c!r})")
    sa.expect_synthetic(1.0)
    sa.key("space" if c == " " else f"char:{c}", pid)
    out = subprocess.run([PIDKEYS, str(pid), "TextEdit", "text:" + c], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"pid-keys refused: {out.stdout.strip()} {out.stderr.strip()}")
    if not sa.wait_for(lambda: document_value(pid) == typed, 2, 0.03):
        raise SystemExit(f"the key {c!r} did not land in this run's document (read {document_value(pid)!r})")


def open_textedit(out_dir):
    """A new TextEdit instance on an empty file of this run's, framed and brought to the front."""
    path = os.path.join(out_dir, "h6-ghost.txt")
    open(path, "w").close()
    before = set(textedit_pids())
    pid = cua("launch_app", {"bundle_id": "com.apple.TextEdit", "urls": [path], "creates_new_application_instance": True})["pid"]
    if pid in before:
        raise SystemExit(f"launch_app returned a TextEdit that was already running ({pid}); refusing to type into it")
    sa.NAMES[pid] = "textedit"
    window_id = None
    for _ in range(50):
        match = [w for w in cua("list_windows", {"pid": pid})["windows"] if w["title"] == "h6-ghost.txt"]
        if match:
            window_id = match[0]["window_id"]
            break
        time.sleep(0.1)
    if window_id is None:
        raise SystemExit("no window for this run's document")
    cua("set_window_frame", {"pid": pid, "window_id": window_id, **FRAME})
    for _ in range(10):
        cua("bring_to_front", {"pid": pid, "window_id": window_id})
        if sa.wait_for(lambda: sa.front_pid().get("pid") == pid and sa.front_pid().get("lsappinfo") == pid, 2, 0.1):
            return pid, window_id
    raise SystemExit("deferred: foreground (this run's TextEdit did not come to the front)")


def rig(out_dir, mode):
    os.makedirs(out_dir, exist_ok=True)
    why = fixture_app.why_not_foreground(sa.IDLE_MIN)
    if why:
        raise SystemExit(why)
    sa.RUN_START = time.time()
    before = sa.front_pid()
    sa.start_with_secret("helper", ["node", os.path.join(HERE, "acceptance_helper.ts"), "--auth-fd", "0", "--socket", HELPER_SOCK, "--state", STATE,
                                    "--routing", "live" if mode == "on" else "off"], out_dir)
    if not sa.wait_for(lambda: os.path.exists(HELPER_SOCK), 20, 0.1):
        raise SystemExit("helper did not open its socket")
    pid, _ = open_textedit(out_dir)
    # Quit only the instance this run launched, then give the front back to the app that had it.
    sa.BEFORE_STOP.append(lambda: (subprocess.run(["kill", str(pid)]), sa.ax(before.get("pid") or 1, "hand-back", before.get("pid") or 1) if before.get("pid") else None))
    sa.check("this run's TextEdit is frontmost (NSWorkspace and lsappinfo)", True, before=before, after=sa.front_pid(), pid=pid)
    sa.start_with_secret("reader", [os.path.join(SCREEN_BIN, "caret-screen"), "--auth-fd", "0", "--socket", HELPER_SOCK, "--only-pids", str(pid)],
                         out_dir)
    # Ghost text alone: every other role off, so no other offer takes the arbiter's slot.
    settings = os.path.join(out_dir, "settings.json")
    with open(settings, "w") as f:
        json.dump({"version": 2, "roles": ["words"], "level": "balanced", "character": "pebble", "paused": False, "onboarded": True,
                   "memory": [], "routing": mode == "on"}, f)
    h = sa.start_caret("host", [sa.CARET, "--socket", sa.HOST_SOCK, "--helper-socket", HELPER_SOCK, "--allow-pids", str(pid), "--test-hooks",
                          "--settings", settings, "--status-item", "off", "--perch", "hidden"], out_dir)
    if not sa.wait_for(lambda: os.path.exists(sa.HOST_SOCK), 15, 0.1):
        raise SystemExit("host did not open its socket")
    sa.wait_for(lambda: (sa.host().get("helper") or {}).get("connected"), 15, 0.2)
    ready = sa.wait_for(lambda: (sa.host().get("engine") or {}).get("state") == "ready", 60, 0.5)
    sa.check("the ghost-text engine is ready", bool(ready), engine=sa.host().get("engine"))
    return pid, h


def run(out_dir, mode, interval):
    pid, h = rig(out_dir, mode)
    time.sleep(0.5)
    sa.host("latency-reset")
    sentences = []
    typed = ""
    for sentence in PASSAGE:
        t0 = time.time()
        for c in sentence:
            typed += c
            type_char(c, pid, typed)
            time.sleep(interval)
        time.sleep(SETTLE)
        st = sa.host()
        sentences.append({"seconds": round(time.time() - t0, 2), "routing": st.get("routing"), "offer": (st.get("offer") or {}).get("kind")})
    st = sa.host()
    value = document_value(pid)
    sa.check("every character landed in this run's document", value == "".join(PASSAGE), value=value)
    counters = {k: v for k, v in (st.get("counters") or {}).items() if k.split(".")[0] in ("routing", "held", "discarded", "offer", "suppressed", "withdrawn")}
    results = {
        "mode": mode, "intervalMs": int(interval * 1000), "settleSeconds": SETTLE, "pid": pid,
        "latency": st.get("latency"), "breakpointLatency": st.get("breakpointLatency"), "routing": st.get("routing"),
        "counters": counters, "helperLink": st.get("helper"), "sentences": sentences,
        "helper": {k: helper_state().get(k) for k in ("router", "decisions", "offers", "errors")},
    }
    bp = st.get("breakpointLatency") or {}
    sa.check("a breakpoint latency sample per sentence", (bp.get("count") or 0) >= len(PASSAGE) - 1, breakpointLatency=bp)
    return results


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4) or sys.argv[2] not in ("on", "off"):
        raise SystemExit(__doc__)
    out, mode = sys.argv[1], sys.argv[2]
    interval = (int(sys.argv[3]) if len(sys.argv) == 4 else 250) / 1000
    results = {}
    lease = fixture_app.GuiLease()
    dog = fixture_app.Watchdog(lambda t: any(a - 0.2 <= t <= b for a, b in sa.SYNTHETIC), sa.front_pid, sa.NAMES)
    stopped_by = None
    try:
        lease.__enter__()
        dog.__enter__()
        results = run(out, mode, interval)
    except KeyboardInterrupt:
        stopped_by = f"deferred: user active (input at {dog.tripped})" if dog.tripped else "interrupted"
        sa.log(stopped_by)
    except SystemExit as e:
        # A gate or a check that stopped the run: kept in the result, which the exit below would hide.
        stopped_by = str(e.code)
        sa.log(stopped_by)
    except Exception as e:  # noqa: BLE001 - recorded, then the run still hands everything back
        stopped_by = f"error: {e!r}"[:400]
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
        with open(os.path.join(out, f"ghost-latency-{mode}.json"), "w") as f:
            json.dump(results, f, indent=2)
        failed = [c for c in sa.CHECKS if not c["ok"]]
        print(f"{len(sa.CHECKS) - len(failed)}/{len(sa.CHECKS)} checks passed -> {out}")
        sys.exit(1 if failed or stopped_by else 0)
