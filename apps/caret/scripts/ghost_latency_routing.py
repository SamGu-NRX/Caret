#!/usr/bin/env python3
"""H6: ghost-text latency with the router on and off, from the host's own latency recorder.

  ghost_latency_routing.py <evidence_dir> on|off [interval_ms]

on: the helper runs D2-02's router with live Jev (acceptance_helper.ts --routing live) and the host's
"Caret decides when to help" is on. off: the helper runs without the router and the host's setting is
"Always suggest as I type", which is how Caret worked before H6.

The passage is typed into caret-fixture's Message field one character at a time. Each character is
first routed through the host's own tap path by the debug socket's `key` hook, which stamps the
key-down the latency recorder measures from and lets the arbiter see the key as the event tap would;
the character itself is then posted to the fixture's pid (pid-keys, CGEventPostToPid). No key goes to
the HID stream or the session tap: real HID keys run only in the rig VM (BUILD-ORDER).

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

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = sa.ROOT
SCREEN_BIN = os.environ.get("CARET_FIXTURE_BIN_DIR") or os.path.join(ROOT, "apps", "screen-reader", ".build", "debug")
PIDKEYS = os.path.join(ROOT, "apps", "caret", ".build", "pid-keys")
EXECUTOR = "Caret Fixture — Executor"
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
    "Can we talk it over on Thursday. ",
]


def helper_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def message_frame(pid):
    fields = [f for f in sa.ax(pid, "fields", pid) if f["window"] == EXECUTOR]
    top = sorted(fields, key=lambda f: (f["frame"][1], f["frame"][0]))
    return top[3]["frame"]


def type_char(c, pid, exe):
    """One character: through the host's tap path first (it stamps the key-down), then to the fixture."""
    sa.expect_synthetic(1.0)
    sa.key("space" if c == " " else f"char:{c}", pid)
    out = subprocess.run([PIDKEYS, str(pid), exe, "text:" + c], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"pid-keys refused: {out.stdout.strip()} {out.stderr.strip()}")


def rig(out_dir, mode):
    os.makedirs(out_dir, exist_ok=True)
    why = fixture_app.why_not_foreground(sa.IDLE_MIN)
    if why:
        raise SystemExit(why)
    sa.RUN_START = time.time()
    before = sa.front_pid()
    secret = os.urandom(32)
    helper = sa.start("helper", ["node", os.path.join(HERE, "acceptance_helper.ts"), "--auth-fd", "0", "--socket", HELPER_SOCK, "--state", STATE,
                                 "--routing", "live" if mode == "on" else "off"], out_dir, stdin=subprocess.PIPE)
    helper.stdin.write(secret)
    helper.stdin.close()
    if not sa.wait_for(lambda: os.path.exists(HELPER_SOCK), 20, 0.1):
        raise SystemExit("helper did not open its socket")
    fx = sa.start("fixture", fixture_app.args("--windows", "executor", "--duration", "900"), out_dir, stdin=subprocess.PIPE)
    sa.BEFORE_STOP.append(lambda: fixture_app.hand_back(fx, before.get("pid")))
    time.sleep(1)
    ok, now = fixture_app.activate(fx, sa.front_pid)
    if not ok:
        raise SystemExit(f"deferred: foreground (activate legacy, front={now})")
    sa.check("fixture activated and frontmost (NSWorkspace and lsappinfo)", True, before=before, after=now)
    reader = sa.start("reader", [os.path.join(SCREEN_BIN, "caret-screen"), "--auth-fd", "0", "--socket", HELPER_SOCK, "--only-pids", str(fx.pid)],
                      out_dir, stdin=subprocess.PIPE)
    reader.stdin.write(secret)
    reader.stdin.close()
    # Ghost text alone: every other role off, so no other offer takes the arbiter's slot.
    settings = os.path.join(out_dir, "settings.json")
    with open(settings, "w") as f:
        json.dump({"version": 2, "roles": ["words"], "level": "balanced", "character": "pebble", "paused": False, "onboarded": True,
                   "memory": [], "routing": mode == "on"}, f)
    h = sa.start("host", [sa.CARET, "--socket", sa.HOST_SOCK, "--helper-socket", HELPER_SOCK, "--allow-pids", str(fx.pid), "--test-hooks",
                          "--settings", settings, "--status-item", "off", "--perch", "hidden"], out_dir)
    if not sa.wait_for(lambda: os.path.exists(sa.HOST_SOCK), 15, 0.1):
        raise SystemExit("host did not open its socket")
    sa.wait_for(lambda: (sa.host().get("helper") or {}).get("connected"), 15, 0.2)
    ready = sa.wait_for(lambda: (sa.host().get("engine") or {}).get("state") == "ready", 60, 0.5)
    sa.check("the ghost-text engine is ready", bool(ready), engine=sa.host().get("engine"))
    return fx, h


def run(out_dir, mode, interval):
    fx, h = rig(out_dir, mode)
    pid = fx.pid
    exe = os.path.basename(fixture_app.executable())
    frame = message_frame(pid)
    sa.ax(pid, "focus", pid, sa.frame_arg(frame))
    time.sleep(0.5)
    sa.host("latency-reset")
    sentences = []
    for sentence in PASSAGE:
        t0 = time.time()
        for c in sentence:
            if fx.poll() is not None:
                raise SystemExit("the fixture quit")
            type_char(c, pid, exe)
            time.sleep(interval)
        time.sleep(SETTLE)
        st = sa.host()
        sentences.append({"seconds": round(time.time() - t0, 2), "routing": st.get("routing"), "offer": (st.get("offer") or {}).get("kind")})
    st = sa.host()
    value = sa.ax(pid, "value", pid, sa.frame_arg(frame)).get("value")
    typed = "".join(PASSAGE)
    sa.check("every character landed in the Message field", value == typed, value=value)
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
