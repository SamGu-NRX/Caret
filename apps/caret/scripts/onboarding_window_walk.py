#!/usr/bin/env python3
"""Onboarding in its real window, every screen, with real keys.

  lockf -k ~/.long-run/locks/gui.lock onboarding_window_walk.py <Caret binary> <out_dir> [light|dark]

The socket walk (onboarding_socket_walk.py) proves the flow with no window. This run opens the
window itself (--onboarding show) and moves through it only with real keys pressed in it: Return
on welcome, work and permissions, a real Tab on try-it's staged field, Return to the first look,
a real Tab on the found offer, a real Command-Z on its result, and Return to finish. Each key is
posted at the HID level by fixture-ax key-if-front, which refuses unless Caret's own pid is
frontmost by both NSWorkspace and LaunchServices. The first look is answered by the socket walk's
fake helper, on the run's own socket. Settings live in a temporary file, so none of the user's
state is read or written.

Runs only behind every gate of a foreground run (fixture_app.py): the gui lease, gui.lock held by
the caller, 300 s without input, no quiet window. It stops within 0.2 s of input that is not its
own key, and gives the foreground back to the app that had it. Screenshots are of Caret's
onboarding window alone (screencapture -l with its window id).

CARET_WALK_WAITING=1 shows the permissions screen waiting first: before Return on work, the run's
own host is told both grants are off (the `onboarding permissions off off` test hook; nothing in
System Settings changes), the waiting screen is captured, then the grants are reported on and the
screen must move on by itself.
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

import fixture_app
from onboarding_socket_walk import FakeHelper

HERE = os.path.dirname(os.path.abspath(__file__))
AX = os.path.join(HERE, "..", ".build", "fixture-ax")
SYNTHETIC = []
CHECKS = []


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


def check(name, ok, **detail):
    CHECKS.append({"check": name, "ok": bool(ok), **detail})
    log("PASS" if ok else "FAIL", name, json.dumps(detail, default=str)[:300] if detail else "")
    return ok


def front():
    out = subprocess.run([AX, "frontmost"], capture_output=True, text=True, env=dict(os.environ, CARET_TEST_PIDS="1"))
    return json.loads(out.stdout) if out.returncode == 0 else {}


class Host:
    def __init__(self, binary, run_dir, helper_socket, appearance):
        self.socket = os.path.join(run_dir, "host.sock")
        self.log = open(os.path.join(run_dir, "host.log"), "w")
        args = [
            binary, "--socket", self.socket, "--helper-socket", helper_socket, "--settings", os.path.join(run_dir, "settings.json"),
            "--onboarding", "show", "--perch", "hidden", "--status-item", "off", "--no-ghost", "--test-hooks",
            # No other app's field may get an offer: pid 1 is launchd, which has none.
            "--allow-pids", "1", "--appearance", appearance,
        ]
        self.proc = subprocess.Popen(args, stdout=self.log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if self.ask("ping").get("ok"):
                    return
            except OSError:
                pass
            time.sleep(0.1)
        raise SystemExit("host did not answer on its socket")

    def ask(self, command):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(5)
            s.connect(self.socket)
            s.sendall((command + "\n").encode())
            s.shutdown(socket.SHUT_WR)
            data = b""
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                data += chunk
        return json.loads(data)

    def window(self):
        out = subprocess.run(["cua-driver", "list_windows", json.dumps({"pid": self.proc.pid})], capture_output=True, text=True, timeout=10)
        windows = json.loads(out.stdout or "{}").get("windows", [])
        return next((w for w in windows if w.get("title") == "Set up Caret" and w.get("is_on_screen", True)), None)

    def stop(self):
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.log.close()


def walk(binary, out_dir, appearance, run_dir, result):
    helper = FakeHelper(os.path.join(run_dir, "helper.sock"))
    host = Host(binary, run_dir, helper.path, appearance)
    result["names"][host.proc.pid] = "caret"
    pid = host.proc.pid
    env = dict(os.environ, CARET_TEST_PIDS=str(pid))
    shots = os.path.join(out_dir, "shots")
    os.makedirs(shots, exist_ok=True)

    def ob():
        return host.ask("onboarding")

    def wait(predicate, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            r = ob()
            if predicate(r):
                return r
            time.sleep(0.05)
        return None

    def shot(name):
        w = host.window()
        if w is None:
            return None
        path = os.path.join(shots, f"{name}.png")
        subprocess.run(["screencapture", "-x", "-o", f"-l{w['window_id']}", path], check=True)
        return path

    def key(name):
        now = front()
        if not (now.get("pid") == pid and now.get("lsappinfo") == pid):
            raise SystemExit(f"deferred: foreground (front={now} before {name})")
        SYNTHETIC.append((time.time(), time.time() + 3))
        out = subprocess.run([AX, "key-if-front", str(pid), name], capture_output=True, text=True, env=env)
        if out.returncode != 0:
            raise SystemExit(f"deferred: foreground (key-if-front {name}: {(out.stdout + out.stderr).strip()})")
        time.sleep(0.25)

    shown = wait(lambda r: r.get("windowShown") and r.get("step") == "welcome", 5)
    if not check("the window opens on welcome", shown is not None, state=ob()):
        return
    deadline = time.time() + 3
    while time.time() < deadline and not (front().get("pid") == pid and front().get("lsappinfo") == pid):
        time.sleep(0.1)
    now = front()
    if not check("Caret is frontmost with its window key (NSWorkspace and lsappinfo)", now.get("pid") == pid and now.get("lsappinfo") == pid, front=now):
        raise SystemExit("deferred: foreground (Caret did not become frontmost)")
    time.sleep(0.4)
    result["shots"]["welcome"] = shot("1-welcome")

    key("return")
    r = wait(lambda r: r.get("step") == "work", 2)
    check("Return on welcome goes to work", r is not None, state=ob())
    time.sleep(0.4)
    result["shots"]["work"] = shot("2-work")

    waiting = os.environ.get("CARET_WALK_WAITING") == "1"
    if waiting:
        host.ask("onboarding permissions off off")
    key("return")
    r = wait(lambda r: r.get("step") in ("permissions", "tryIt"), 2)
    check("Return on work goes to permissions", r is not None, state=ob())
    time.sleep(0.4)
    if waiting:
        time.sleep(1.0)
        r = ob()
        check("with no grants the permissions screen waits", r.get("step") == "permissions"
              and (r.get("permissions") or {}).get("accessibility") is False, state=r)
        result["shots"]["permissionsWaiting"] = shot("3-permissions-waiting")
        host.ask("onboarding permissions on on")
        r = wait(lambda r: r.get("step") == "tryIt", 3)
        check("the grant arriving moves the screen on by itself", r is not None, state=ob())
    else:
        result["shots"]["permissions"] = shot("3-permissions")
    r = ob()
    if not waiting:
        check("permissions reads the real grants as on", (r.get("permissions") or {}).get("accessibility") is True, permissions=r.get("permissions"))
    if r.get("step") == "permissions":
        # The grants are already there; the screen may move on by itself (advancingAfterGrant).
        if not wait(lambda r: r.get("step") == "tryIt", 1.5):
            key("return")
    r = wait(lambda r: r.get("step") == "tryIt", 2)
    check("permissions moves on to try-it", r is not None, state=ob())
    time.sleep(0.4)
    result["shots"]["tryIt"] = shot("4-try-it")
    check("try-it shows its offer, not yet taken", (r or {}).get("tryIt", {}).get("offerVisible") is True, tryIt=(r or {}).get("tryIt"))

    key("tab")
    r = wait(lambda r: (r.get("tryIt") or {}).get("completed"), 2)
    check("a real Tab in the window takes try-it's offer", r is not None and r["tryIt"]["isSample"] is True and r["tryIt"]["tabs"] == 1,
          tryIt=(r or ob()).get("tryIt"))
    time.sleep(0.4)
    result["shots"]["tryItFilled"] = shot("5-try-it-filled")

    key("return")
    r = wait(lambda r: r.get("step") == "firstLook" and r.get("firstLook") == "found", 5)
    check("Return goes to the first look, and the helper's offer is shown", r is not None and r.get("firstLookTitle") == "Fill 4 fields", state=ob())
    time.sleep(0.4)
    result["shots"]["firstLookFound"] = shot("6-first-look-found")

    key("tab")
    r = wait(lambda r: r.get("firstLookRun") == "done", 5)
    check("a real Tab runs the found offer to its done line", r is not None and r.get("firstLookLine") == "Filled 4 fields from Mail"
          and [a["message"].get("offerId") for a in helper.accepts] == [helper.requests[-1]["request"]["requestId"] + ".0"], state=ob())
    time.sleep(0.3)
    result["shots"]["firstLookDone"] = shot("7-first-look-done")

    key("cmd-z")
    r = wait(lambda r: r.get("firstLookRun") == "undone", 5)
    check("a real Command-Z undoes it", r is not None and r.get("firstLookLine") == "Cleared 4 fields"
          and [c["message"].get("action") for c in helper.controls] == ["undo"], state=ob())
    time.sleep(0.3)
    result["shots"]["firstLookUndone"] = shot("8-first-look-undone")

    key("return")
    r = wait(lambda r: r.get("finished"), 3)
    check("Return on the first look finishes onboarding", r is not None, state=ob())
    settings = host.ask("settings")
    check("finishing records onboarded in the run's own settings file", (settings.get("settings") or {}).get("onboarded") is True,
          settings=settings.get("settings"))
    time.sleep(0.5)
    check("the window is gone once onboarding is done", host.window() is None, state=ob())
    result["helper"] = {"requests": [x["request"] for x in helper.requests], "accepts": [x["message"] for x in helper.accepts],
                        "controls": [x["message"] for x in helper.controls]}
    result["finalState"] = ob()
    host.stop()
    helper.close()


def main():
    if len(sys.argv) not in (3, 4):
        raise SystemExit(__doc__)
    binary, out_dir = sys.argv[1], sys.argv[2]
    appearance = sys.argv[3] if len(sys.argv) == 4 else "light"
    os.makedirs(out_dir, exist_ok=True)
    result = {"shots": {}, "names": {}}
    why = fixture_app.why_not_foreground()
    if why:
        print(why)
        result["status"] = why
        json.dump(result, open(os.path.join(out_dir, "walk.json"), "w"), indent=2)
        return 75
    before = front().get("pid")
    run_dir = tempfile.mkdtemp(prefix="cow-", dir="/tmp")
    lease = fixture_app.GuiLease()
    dog = fixture_app.Watchdog(lambda t: any(a - 0.2 <= t <= b for a, b in SYNTHETIC), front, result["names"])
    status = None
    try:
        lease.__enter__()
        dog.__enter__()
        walk(binary, out_dir, appearance, run_dir, result)
    except KeyboardInterrupt:
        status = f"deferred: user active (input at {dog.tripped})" if dog.tripped else "interrupted"
        log(status)
    except SystemExit as stop:
        status = str(stop)
        log(status)
    finally:
        dog.__exit__()
        for name in ("host.log",):
            if os.path.exists(os.path.join(run_dir, name)):
                shutil.copy(os.path.join(run_dir, name), os.path.join(out_dir, name))
        # Stop whatever is still running, then give the foreground back if macOS did not.
        for pid in list(result["names"]):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        time.sleep(0.5)
        if before and front().get("pid") != before:
            result["handBack"] = json.loads(subprocess.run([AX, "hand-back", str(before)], capture_output=True, text=True).stdout or "{}")
        dog.timeline.append((round(time.time() - dog.start, 2), front().get("pid"), "after hand-back"))
        lease.__exit__()
        shutil.rmtree(run_dir, ignore_errors=True)
        result["frontTimeline"] = dog.timeline
        result["checks"] = CHECKS
        result["passed"] = sum(c["ok"] for c in CHECKS)
        result["failed"] = sum(not c["ok"] for c in CHECKS)
        result["status"] = status or ("done" if result["failed"] == 0 else "failed")
        result["names"] = {str(k): v for k, v in result["names"].items()}
        with open(os.path.join(out_dir, "walk.json"), "w") as f:
            json.dump(result, f, indent=2, sort_keys=True, default=str)
        log("summary", result["passed"], "passed,", result["failed"], "failed;", result["status"])
    return 0 if result["status"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
