"""The guard of a swift-tests run with on-screen accessibility tests (CARET_AX_ONSCREEN=1).

  onscreen.py OUT RECIPE-PID

Started in the background by the recipe, which leads its own process group (the supervisor starts it so). In order:

1. gui.lock (CARET_HEAVY_GUI_LOCK), non-blocking: the long-run rule for anything that can open a window or take
   keystrokes, shared with every other GUI batch on this Mac.
2. A gui lease (lr-lease acquire --kind gui, owned by this process), on top of the job's heavy one. Its estimates are
   zero: the heavy lease already reserves the job's memory and disk; this one adds the gui count and quiet windows.
   Its TTL covers the job's execution limit (CARET_HEAVY_EXEC_S) plus 5 minutes.
3. The HID idle for at least CARET_ONSCREEN_IDLE_MIN seconds (300, the on-screen rule of Caret's acceptance scripts),
   waiting up to CARET_ONSCREEN_WAIT_S (900; an assumed bound, unmeasured, during which the job holds its slot).

Then it writes OUT/onscreen.ready and watches HIDIdleTime every CARET_ONSCREEN_POLL_S (1). The tests may use only
background input, which does not reset it, so any reset is someone at the Mac: it writes OUT/onscreen.interrupted
and sends SIGTERM to the recipe's process group, and the recipe exits 15. On SIGTERM it releases everything and exits
0. OUT/onscreen.json records each state and the reason. A step that fails exits 1 before onscreen.ready, with what
it held released. A lease left by a SIGKILLed guard has a dead owner and is reaped (lr-reap).
"""

import fcntl
import json
import math
import os
import re
import signal
import subprocess
import sys
import time

IDLE = re.compile(r'"HIDIdleTime" = (\d+)')


class Guard:
    def __init__(self, out, recipe_pid, env):
        self.out, self.recipe_pid = out, recipe_pid
        self.lock_path, self.lr_lease = env["CARET_HEAVY_GUI_LOCK"], env["CARET_HEAVY_LR_LEASE"]
        self.run, self.exec_s = env["CARET_HEAVY_LEASE_RUN"], float(env["CARET_HEAVY_EXEC_S"])
        self.idle_min = float(env.get("CARET_ONSCREEN_IDLE_MIN", "300"))
        self.wait_s = float(env.get("CARET_ONSCREEN_WAIT_S", "900"))
        self.poll_s = float(env.get("CARET_ONSCREEN_POLL_S", "1"))
        self.lock_fd = self.lease = None
        self.record = {"state": "starting", "reason": None, "lease": None, "idle_s_at_start": None}

    def write(self, **change):
        self.record.update(change)
        tmp = os.path.join(self.out, "onscreen.json.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.record, fh)
        os.replace(tmp, os.path.join(self.out, "onscreen.json"))
        print("onscreen: {}{}".format(self.record["state"], ": " + self.record["reason"] if self.record["reason"] else ""),
              flush=True)

    def idle_s(self):
        """HIDIdleTime in seconds. Raises OSError when ioreg fails or does not report it."""
        done = subprocess.run(["ioreg", "-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"],
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)
        match = IDLE.search(done.stdout)
        if done.returncode != 0 or match is None:
            raise OSError("ioreg reported no HIDIdleTime (exit {})".format(done.returncode))
        return int(match.group(1)) / 1e9

    def take(self):
        """Steps 1-3. Returns None when held and idle, else why not."""
        if os.getpgid(self.recipe_pid) != self.recipe_pid or os.getpgrp() != self.recipe_pid:
            return "the recipe {} does not lead this guard's process group".format(self.recipe_pid)
        self.lock_fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return "gui.lock {} is held by another GUI batch".format(self.lock_path)
        ttl = math.ceil(self.exec_s / 60) + 5
        done = subprocess.run([self.lr_lease, "acquire", "--run", self.run, "--kind", "gui", "--est-mem", "0",
                               "--est-disk", "0", "--ttl", str(ttl), "--owner-pid", str(os.getpid())],
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
        if done.returncode != 0:
            return "gui lease refused (exit {}): {}".format(done.returncode, done.stdout.strip()[:300])
        self.lease = done.stdout.strip()
        self.write(state="leased", lease=self.lease)
        deadline = time.monotonic() + self.wait_s
        while True:
            idle = self.idle_s()
            if idle >= self.idle_min:
                self.write(state="holding", idle_s_at_start=idle)
                return None
            if time.monotonic() >= deadline:
                return "the HID was not idle {:.0f} s within {:.0f} s (last idle {:.1f} s)".format(
                    self.idle_min, self.wait_s, idle)
            time.sleep(self.poll_s)

    def release(self):
        if self.lease is not None:
            done = subprocess.run([self.lr_lease, "release", self.lease], stdin=subprocess.DEVNULL,
                                  capture_output=True, text=True, timeout=120)
            if done.returncode != 0:
                print("onscreen: releasing lease {} exited {}: {}; lr-reap removes it once this process is gone".format(
                    self.lease, done.returncode, done.stdout.strip()[:300]), flush=True)
            self.lease = None
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None

    def watch(self):
        last = self.record["idle_s_at_start"]
        while True:
            time.sleep(self.poll_s)
            idle = self.idle_s()
            if idle < last:
                return "HID input during the run: the HID idle time went from {:.1f} s to {:.1f} s".format(last, idle)
            last = idle


def main(argv):
    out, recipe_pid = argv[0], int(argv[1])
    guard = Guard(out, recipe_pid, os.environ)

    def on_term(_signum, _frame):
        raise SystemExit(0)  # the recipe is done, or the supervisor is stopping the job: release and exit
    signal.signal(signal.SIGTERM, on_term)
    try:
        why = guard.take()
        if why is not None:
            guard.release()
            guard.write(state="not admitted", reason=why)
            return 1
        open(os.path.join(out, "onscreen.ready"), "w").close()
        why = guard.watch()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        open(os.path.join(out, "onscreen.interrupted"), "w").close()
        guard.write(state="interrupted", reason=why)
        os.killpg(recipe_pid, signal.SIGTERM)
        guard.release()
        return 15
    except SystemExit:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        guard.release()
        if guard.record["state"] not in ("not admitted", "interrupted"):
            guard.write(state="released")
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as ex:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        guard.release()
        guard.write(state="failed", reason="{!r}".format(ex))
        if os.path.exists(os.path.join(out, "onscreen.ready")):
            # The run had started: unknown HID state is not a safe run. Stop it as an interruption.
            open(os.path.join(out, "onscreen.interrupted"), "w").close()
            os.killpg(recipe_pid, signal.SIGTERM)
            return 15
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
