"""CaretFixture.app for the host's on-screen scripts, and the gates every foreground run keeps.

macOS would not activate the bare caret-fixture executable however long the Mac had been idle (A4,
A5), so the screen track bundles it as CaretFixture.app (apps/screen-reader/scripts/
bundle-fixture.sh). B9 then made the bundle take the foreground on request, 4 of 4 times: the
fixture's stdin command `activate legacy` calls `NSApp.activate(ignoringOtherApps:)`, and `quit PID`
hands activation back to the app that had it (apps/screen-reader/experiments/activation-proof.swift).

Scripts exec the bundle's executable directly, never with `open`, so it inherits the launcher's
Accessibility grant, and always with --foreground: without it the fixture is background-only and
its windows can never be key, which the AXMain-driven runs need. A --foreground fixture still hands
activation back whenever it gets it, until `activate` says otherwise.

A foreground run starts with `activate`, and only behind every gate of the shared Mac: the gui
lease, gui.lock held by the caller, 300 s without input, and no quiet window
(~/.long-run/QUIET-UNTIL).
"""
import json
import os
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
# The fixture with `activate` and `quit` is v2/screen 42500c8 or later; this worktree has it once
# v2/screen is merged. Until then, CARET_FIXTURE_BIN_DIR names another build (caret-v2-screen's).
BIN_DIR = os.environ.get("CARET_FIXTURE_BIN_DIR") or os.path.join(ROOT, "apps", "screen-reader", ".build", "debug")
BUNDLE_SCRIPT = os.path.join(ROOT, "apps", "screen-reader", "scripts", "bundle-fixture.sh")
GUI_LOCK = os.path.expanduser("~/.long-run/locks/gui.lock")
QUIET_FILE = os.path.expanduser("~/.long-run/QUIET-UNTIL")
LEASE = os.path.expanduser("~/.long-run/bin/lr-lease")
IDLE_MIN = 300.0


def executable(bin_dir=BIN_DIR):
    """The bundle's executable, bundling the built caret-fixture first when the bundle is missing
    or older than the binary."""
    app = os.path.join(bin_dir, "CaretFixture.app")
    exe = os.path.join(app, "Contents", "MacOS", "caret-fixture")
    raw = os.path.join(bin_dir, "caret-fixture")
    if not os.path.exists(raw) and not os.path.exists(exe):
        raise SystemExit(f"no caret-fixture in {bin_dir}: build it with `swift build --product caret-fixture` in apps/screen-reader")
    if not os.path.exists(exe) or (os.path.exists(raw) and os.path.getmtime(raw) > os.path.getmtime(exe)):
        subprocess.run([BUNDLE_SCRIPT, bin_dir], check=True, capture_output=True)
    return exe


def args(*extra):
    """The fixture's command line: the bundle's executable, --foreground, then `extra`."""
    return [executable(), "--foreground", *extra]


def hid_idle_seconds():
    out = subprocess.run(["ioreg", "-c", "IOHIDSystem"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if "HIDIdleTime" in line:
            return int(line.split()[-1]) / 1e9
    return 0.0


def quiet_now():
    """Sam is presenting or in a call: the first field of QUIET-UNTIL (epoch seconds) is ahead.
    An unreadable file counts as quiet."""
    if not os.path.exists(QUIET_FILE):
        return False
    try:
        with open(QUIET_FILE) as f:
            return float(f.read().split()[0]) > time.time()
    except (OSError, ValueError, IndexError):
        return True


def gui_lock_held():
    """True when some process holds gui.lock: a zero-wait lockf fails. The caller is expected to
    be that process (`lockf -k ~/.long-run/locks/gui.lock <script> ...`)."""
    return subprocess.run(["/usr/bin/lockf", "-t", "0", GUI_LOCK, "true"], capture_output=True).returncode != 0


def why_not_foreground(idle_min=IDLE_MIN):
    """None when a foreground run may start now; otherwise the status to stop with."""
    if not gui_lock_held():
        return "refused: run under lockf -k ~/.long-run/locks/gui.lock"
    if quiet_now():
        return "deferred: quiet window"
    idle = hid_idle_seconds()
    if idle < idle_min:
        return f"deferred: user active (idle {idle:.0f} s < {idle_min:.0f} s)"
    return None


class GuiLease:
    """The admission lease for a foreground run, held by this process for the run's length.
    Refused: the run does not start (`deferred: gui lease ...`)."""

    def __init__(self, ttl_minutes=20):
        self.ttl = ttl_minutes
        self.id = None

    def __enter__(self):
        out = subprocess.run([LEASE, "acquire", "--run", "caret-v2", "--kind", "gui", "--est-mem", "1", "--est-disk", "0",
                              "--ttl", str(self.ttl), "--owner-pid", str(os.getpid())], capture_output=True, text=True)
        if out.returncode != 0:
            raise SystemExit(f"deferred: gui lease refused ({(out.stdout + out.stderr).strip()})")
        self.id = out.stdout.strip()
        return self

    def __exit__(self, *_):
        if self.id:
            subprocess.run([LEASE, "release", self.id], capture_output=True)
            self.id = None


def send(proc, line):
    """One stdin command to a fixture started with stdin=PIPE."""
    proc.stdin.write((line + "\n").encode())
    proc.stdin.flush()


def activate(proc, front, timeout=3.0):
    """Asks the fixture to take the foreground (`activate legacy`) and waits until NSWorkspace and
    LaunchServices both report it frontmost. `front()` returns {"pid": ..., "lsappinfo": ...}.
    Returns (ok, the last reading)."""
    send(proc, "activate legacy")
    deadline = time.time() + timeout
    now = front()
    while time.time() < deadline:
        now = front()
        if now.get("pid") == proc.pid and now.get("lsappinfo") == proc.pid:
            return True, now
        time.sleep(0.1)
    return False, now


def hand_back(proc, previous_pid):
    """Gives the foreground back to `previous_pid` and lets the fixture exit (`quit PID`)."""
    if proc.poll() is None and previous_pid:
        try:
            send(proc, f"quit {previous_pid}")
            proc.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass


if __name__ == "__main__":
    # `fixture_app.py check`: what a foreground run would decide now, without starting one.
    print(json.dumps({"executable": executable(), "gate": why_not_foreground(), "quiet": quiet_now(),
                      "idleSeconds": round(hid_idle_seconds(), 1)}))
