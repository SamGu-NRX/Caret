#!/usr/bin/env python3
"""Walk onboarding through the host's debug socket with no window on screen.

Usage: onboarding_socket_walk.py <Caret.app/Contents/MacOS/Caret> <out_dir>

Starts the host with --onboarding hidden, --surfaces headless, --perch hidden, --status-item off
and --no-ghost, on sockets and a settings file of its own under a temporary directory, so it
reads and writes none of the user's state. A fake helper on the run's own socket answers
`firstLook` with the contract's fixture lines (Tests/CaretHostCoreTests/Fixtures/
first-look.ndjson): found, nothing, error, or silence. The script drives every screen with the
`onboarding` test hooks, reads back each setting with `settings`, checks after every step that
the host owns no window (cua-driver list_windows, read only), restarts the host to read the
settings back from the file, and writes walk.json and a summary to <out_dir>.

Posts no event, opens no window, and never touches another process.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "Tests", "CaretHostCoreTests", "Fixtures", "first-look.ndjson")
REPLIES = [json.loads(line) for line in open(FIXTURE) if line.strip()]
FOUND, NOTHING, ERROR = REPLIES[1], REPLIES[3], REPLIES[4]
# A fill proposal for a synthetic pid, to show pause refusing it.
PROPOSAL = {
    "type": "fillProposal", "v": 1, "id": "walk-fill-1", "at": 1790000000500, "pid": 5150, "windowId": "5150-1",
    "bundleId": "dev.caret.fixture", "triggerKey": "k", "candidates": 1, "cutoff": 0.75,
    "jev": {"model": "m", "latencyMs": 1, "inputTokens": 1, "costUsd": 0},
    "fields": [{"key": "k", "frame": [1, 1, 10, 10], "descriptor": "d", "choice": "none", "confidence": 0, "value": None,
                "source": None, "withheld": None, "asks": [{"choice": "none", "confidence": 0, "value": None}] * 2}],
}


class FakeHelper:
    """A consumer-facing helper that only speaks firstLook."""

    def __init__(self, path):
        self.path = path
        self.mode = "found"
        self.requests = []
        self.conn = None
        self.lock = threading.Lock()
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(path)
        self.server.listen(1)
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            with self.lock:
                self.conn = conn
            buffer = b""
            while True:
                try:
                    chunk = conn.recv(65536)
                except OSError:
                    break
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if line.strip():
                        self._handle(json.loads(line))

    def _handle(self, message):
        if message.get("type") != "firstLook":
            return
        self.requests.append({"at": time.monotonic(), "request": message, "mode": self.mode})
        reply = {"found": FOUND, "nothing": NOTHING, "error": ERROR}.get(self.mode)
        if reply is None:
            return  # silence: the host's deadline decides
        reply = dict(reply, requestId=message["requestId"])
        self.send(reply)

    def send(self, message):
        with self.lock:
            if self.conn:
                self.conn.sendall((json.dumps(message, separators=(",", ":")) + "\n").encode())

    def close(self):
        self.server.close()


class Host:
    def __init__(self, binary, run_dir, helper_socket, name):
        self.socket = os.path.join(run_dir, f"{name}.sock")
        self.log = open(os.path.join(run_dir, f"{name}.log"), "w")
        args = [
            binary, "--socket", self.socket, "--helper-socket", helper_socket, "--settings", os.path.join(run_dir, "settings.json"),
            "--onboarding", "hidden", "--surfaces", "headless", "--perch", "hidden", "--status-item", "off",
            "--no-ghost", "--test-hooks", "--allow-pids", "5150",
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
        raise RuntimeError("host did not answer on its socket")

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

    def windows(self):
        """The host's windows as the window server lists them (read only)."""
        try:
            out = subprocess.run(["cua-driver", "list_windows", json.dumps({"pid": self.proc.pid})], capture_output=True, text=True, timeout=10)
            return [w for w in json.loads(out.stdout).get("windows", []) if w.get("is_on_screen", True)]
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            return [{"unreadable": str(error)}]

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()


def main():
    binary, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    # A short path: sun_path holds 104 bytes.
    run_dir = tempfile.mkdtemp(prefix="cow-", dir="/tmp")
    helper = FakeHelper(os.path.join(run_dir, "helper.sock"))
    steps, failures = [], []

    def check(name, ok, detail=None):
        steps.append({"check": name, "ok": bool(ok), "detail": detail})
        if not ok:
            failures.append(name)
        print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"  {detail}"))

    host = Host(binary, run_dir, helper.path, "host")
    try:
        def ob(command="", expect_step=None):
            reply = host.ask(("onboarding " + command).strip())
            if "error" in reply:
                check(f"onboarding {command}", False, reply)
            if expect_step is not None:
                check(f"onboarding {command} -> {expect_step}", reply.get("step") == expect_step, reply.get("step"))
            no_window = host.windows() == [] and reply.get("windowShown") in (None, False)
            check(f"no window after '{command or 'read'}'", no_window, host.windows())
            return reply

        def settings(command=""):
            return host.ask(("settings " + command).strip())

        def wait(predicate, timeout):
            start = time.monotonic()
            while time.monotonic() - start < timeout:
                reply = host.ask("onboarding")
                if predicate(reply):
                    return reply, time.monotonic() - start
                time.sleep(0.05)
            return host.ask("onboarding"), None

        r = ob()
        check("a hidden launch opens the flow at welcome, with no window", r.get("step") == "welcome" and r.get("windowShown") is False, r)
        s = settings()
        check("defaults: every role, balanced, pebble, not paused, not onboarded",
              s["settings"]["roles"] == ["fill", "repeat", "watch", "words"] and s["settings"]["level"] == "balanced"
              and s["settings"]["character"] == "pebble" and not s["settings"]["paused"] and not s["settings"]["onboarded"], s["settings"])
        check("balanced: grounded offers from day one, routines need history",
              {r["family"]: (r["on"], r["seenBefore"]) for r in s["gate"]["rules"]}.get("fill") == (True, 0)
              and {r["family"]: r["seenBefore"] for r in s["gate"]["rules"]}["routine"] == 3, s["gate"])

        ob("open", "welcome")  # already open: brought forward, not restarted
        ob("next", "work")
        ob("role repeat off")
        r = ob("level eager")
        check("work screen holds the choices", r["roles"] == ["fill", "watch", "words"] and r["level"] == "eager", r)
        # The run's own grants: both off, so the permission screen asks for both.
        ob("permissions off off")
        r = ob("next", "permissions")
        check("Input Monitoring row shown when it is off", r.get("showsInputMonitoring") is True, r)
        check("Continue waits for Accessibility", r["canContinue"] is False, r)
        s = settings()
        check("leaving the work screen wrote the roles and level",
              s["settings"]["roles"] == ["fill", "watch", "words"] and s["settings"]["level"] == "eager", s["settings"])
        check("each choice is a memory entry from onboarding",
              [(m["key"], m["value"], m["source"]) for m in s["settings"]["memory"]]
              == [("role.fill", "on", "onboarding"), ("role.repeat", "off", "onboarding"), ("role.watch", "on", "onboarding"),
                  ("role.words", "on", "onboarding"), ("level", "eager", "onboarding")], s["settings"]["memory"])
        check("the gate follows: loop and routine off, rewrites on at eager",
              {r["family"]: r["on"] for r in s["gate"]["rules"]} == {"ghost": True, "fill": True, "pending": True, "loop": False, "routine": False, "rewrite": True}
              and s["gate"]["offersPerHour"] == 8, s["gate"])
        r = ob("next", "permissions")
        granted = time.monotonic()
        host.ask("onboarding permissions on on")
        r, _ = wait(lambda x: x["step"] == "tryIt", 3)
        waited = time.monotonic() - granted if r["step"] == "tryIt" else None
        check("no window after the grant", host.windows() == [])
        check("the grant appearing moves the screen on by itself", waited is not None, r)
        steps.append({"measure": "grant to next screen (0.6 s by design, 0.5 s poll), s", "value": waited})

        r = ob("key return", "tryIt")
        check("Return does not complete try-it", r["tryIt"]["completed"] is False, r["tryIt"])
        r = ob("key char:5")
        check("typing says no", r["tryIt"]["offerVisible"] is False and r["tryIt"]["declined"] is True, r["tryIt"])
        r = ob("key tab")
        check("Tab with the offer gone takes nothing", r["tryIt"]["completed"] is False and r["tryIt"]["tabs"] == 1, r["tryIt"])
        r = ob("key delete")
        check("deleting brings the offer back", r["tryIt"]["offerVisible"] is True, r["tryIt"])
        r = ob("next", "tryIt")
        r = ob("key tab")
        check("Tab completes try-it with the sample value", r["tryIt"]["completed"] is True and r["tryIt"]["value"] == "$1,240.00", r["tryIt"])

        helper.mode = "found"
        sent = time.monotonic()
        host.ask("onboarding next")
        r, _ = wait(lambda x: x.get("firstLook") == "found", 5)
        waited = time.monotonic() - sent if r.get("firstLook") == "found" else None
        check("no window on the first look", host.windows() == [])
        check("first look: the helper's offer is shown", r.get("firstLook") == "found" and r.get("firstLookTitle") == "Fill 4 fields", r)
        steps.append({"measure": "Continue to found shown, through the socket and the fake helper, s", "value": waited})
        check("the request named the families the choices enable",
              helper.requests and helper.requests[-1]["request"]["families"] == ["fill", "pending"]
              and helper.requests[-1]["request"]["level"] == "eager", helper.requests[-1:] and helper.requests[-1]["request"])

        helper.mode = "nothing"
        ob("back", "tryIt")
        ob("next", "firstLook")
        r, _ = wait(lambda x: x.get("firstLook") == "nothing", 5)
        check("first look: nothing yet", r.get("firstLook") == "nothing", r)

        helper.mode = "error"
        ob("back", "tryIt")
        ob("next", "firstLook")
        r, _ = wait(lambda x: x.get("firstLook") == "failed", 5)
        check("first look: an error reply", r.get("firstLook") == "failed" and r.get("firstLookError") == "reader not connected", r)

        helper.mode = "silent"
        ob("look-again")
        r, waited = wait(lambda x: x.get("firstLook") == "failed", 12)
        check("first look: no answer by the deadline", r.get("firstLookError") == "timedOut", r)
        steps.append({"measure": "silent helper to timedOut, s", "value": waited})

        helper.mode = "found"
        ob("look-again")
        wait(lambda x: x.get("firstLook") == "found", 5)
        r = ob("next")
        check("Done finishes the flow", r["finished"] is True and r.get("windowShown") is False, r)
        s = settings()
        check("finishing records onboarded", s["settings"]["onboarded"] is True, s["settings"])
        check("the host counted every reply", host.ask("state")["helper"]["firstLookReplies"] == 4, host.ask("state")["helper"])

        for command, read in [
            ("set character wren", lambda s: s["settings"]["character"] == "wren"),
            ("set character seed", lambda s: s["settings"]["character"] == "seed"),
            ("set character pebble", lambda s: s["settings"]["character"] == "pebble"),
            ("set role watch off", lambda s: "watch" not in s["settings"]["roles"]),
            ("set level quiet", lambda s: s["settings"]["level"] == "quiet" and s["gate"]["offersPerHour"] == 1),
            ("set paused on", lambda s: s["settings"]["paused"] and all(not r["on"] for r in s["gate"]["rules"])),
        ]:
            s = settings(command)
            check(f"settings {command} reads back", "error" not in s and read(s), s.get("settings", s))
        before = host.ask("state")["counters"].get("gate.refused.fillProposal", 0)
        helper.send(PROPOSAL)
        time.sleep(0.5)
        after = host.ask("state")["counters"].get("gate.refused.fillProposal", 0)
        check("paused: a fill proposal is refused at the gate", after == before + 1, {"before": before, "after": after})
        check("the surface shows nothing while paused", host.ask("state").get("offer") is None)
    finally:
        host.stop()

    # A second launch reads the same file back.
    host = Host(binary, run_dir, helper.path, "relaunch")
    try:
        s = host.ask("settings")
        check("settings survive a relaunch",
              "error" not in s and s["settings"]["onboarded"] and s["settings"]["paused"] and s["settings"]["level"] == "quiet"
              and s["settings"]["roles"] == ["fill", "words"] and s["settings"]["character"] == "pebble", s)
        r = host.ask("onboarding")
        check("a hidden launch reopens the flow but no window", r.get("step") == "welcome" and host.windows() == [], r)
    finally:
        host.stop()
    helper.close()

    # No helper at all: the request cannot be written, and the look says so at once.
    lone = Host(binary, run_dir, os.path.join(run_dir, "absent.sock"), "nohelper")
    try:
        # Still paused from the walk: the first look has nothing it may run, and asks nothing.
        for c in ["permissions on on", "next", "next", "next", "key tab", "next"]:
            lone.ask("onboarding " + c)
        r = lone.ask("onboarding")
        check("paused: the first look asks for nothing", r.get("firstLook") == "nothing" and "firstLookRequest" not in r, r)
        lone.ask("settings set paused off")
        lone.ask("onboarding back")
        lone.ask("onboarding next")
        r = lone.ask("onboarding")
        check("no helper: the first look fails at once", r.get("firstLook") == "failed" and r.get("firstLookError") == "helperNotConnected", r)
    finally:
        lone.stop()

    shutil.copy(os.path.join(run_dir, "settings.json"), os.path.join(out_dir, "settings-after-walk.json"))
    for name in ["host.log", "relaunch.log", "nohelper.log"]:
        shutil.copy(os.path.join(run_dir, name), os.path.join(out_dir, name))
    shutil.rmtree(run_dir, ignore_errors=True)
    passed = sum(1 for s in steps if s.get("ok"))
    total = sum(1 for s in steps if "ok" in s)
    with open(os.path.join(out_dir, "walk.json"), "w") as f:
        json.dump({"passed": passed, "total": total, "failures": failures, "steps": steps}, f, indent=2)
    print(f"\n{passed} of {total} checks passed")
    for m in (s for s in steps if "measure" in s):
        print(f"{m['measure']}: {m['value']}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
