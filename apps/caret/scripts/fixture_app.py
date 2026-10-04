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
    """True when some process holds gui.lock: a zero-wait lockf finds it locked (EX_TEMPFAIL, 75).
    Any other failure, such as a lock file it cannot create, is not proof of a holder and counts
    as not held. The caller is expected to be the holder (`lockf -k ~/.long-run/locks/gui.lock
    <script> ...`)."""
    return subprocess.run(["/usr/bin/lockf", "-t", "0", GUI_LOCK, "true"], capture_output=True).returncode == 75


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


class Watchdog:
    """Reads HIDIdleTime every 0.2 s for a foreground run, and interrupts the main thread
    (KeyboardInterrupt, so the run's `finally` hands the foreground back) as soon as there is
    input under 5 s old that `synthetic(t)` does not claim as the run's own key at time t.
    Checks made only at socket reads left gaps of up to 6 s, during sleeps and screenshots.

    Also records the frontmost app whenever it changes, as (seconds into the run, pid, name),
    from `front()`, which returns {"pid": ...}. `names` maps pids the run started to a label;
    any other app is recorded by pid and process name only."""

    def __init__(self, synthetic, front, names, interval=0.2):
        self.synthetic = synthetic
        self.front = front
        self.names = names
        self.interval = interval
        self.start = time.time()
        self.timeline = []
        self.tripped = None
        self._stop = False
        self._thread = None

    def __enter__(self):
        import threading
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_):
        self._stop = True
        if self._thread:
            self._thread.join(timeout=2)

    def _name(self, pid):
        if pid in self.names:
            return self.names[pid]
        out = subprocess.run(["ps", "-p", str(pid), "-o", "comm="], capture_output=True, text=True).stdout.strip()
        return os.path.basename(out) or "?"

    def _run(self):
        import _thread
        last_pid = None
        tick = 0
        while not self._stop:
            idle = hid_idle_seconds()
            last_input = time.time() - idle
            if idle < 5 and last_input > self.start + 0.5 and not self.synthetic(last_input):
                self.tripped = time.strftime("%H:%M:%S", time.localtime(last_input))
                _thread.interrupt_main()
                return
            if tick % 3 == 0:
                pid = (self.front() or {}).get("pid")
                if pid != last_pid:
                    self.timeline.append((round(time.time() - self.start, 2), pid, self._name(pid) if pid else None))
                    last_pid = pid
            tick += 1
            time.sleep(self.interval)


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
