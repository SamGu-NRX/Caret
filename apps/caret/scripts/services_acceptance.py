#!/usr/bin/env python3
"""Caret.app starts its own helper and reader (brief H4, acceptance 2), checked on the built bundle.

The app runs by direct exec with a temporary Caret home for its sockets and data and a PATH with no node on it, with
nothing on screen (--surfaces headless --perch hidden --status-item off --no-ghost) and offers allowed only in a pid
that does not exist. Every check reads the host's debug socket (`services`) and the processes themselves.

  1. It starts the bundled helper and caret-screen; the reader logs that the helper proved itself.
  2. A helper killed with SIGKILL is started again, and the still-running reader accepts the new one: the reader only
     accepts a helper that proves the launch secret, so the restart used the same secret.
  3. Five more kills within 60 s stop both, and `services` says why (the menu's "Caret stopped. Restart").
  4. `services restart` (the menu's Restart) starts both again.
  5. SIGTERM: the host exits 0 and leaves no helper or reader running.

The reader reads the screen while it runs (reading only; it posts no input). Its Accessibility grant is the launching
terminal's, as for every direct exec of Caret on this Mac.

  python3 apps/caret/scripts/services_acceptance.py --out DIR [--app PATH]
"""
import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CLEAN_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


def ask(sock: str, command: str) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(5.0)
        s.connect(sock)
        s.sendall((command + "\n").encode())
        s.shutdown(socket.SHUT_WR)
        chunks = []
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    return json.loads(b"".join(chunks))


def wait(what: str, fn, timeout: float):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = fn()
        except (OSError, ValueError) as e:
            last = e
        if last and not isinstance(last, Exception):
            return last
        time.sleep(0.1)
    raise AssertionError(f"{what}: not within {timeout} s (last: {last})")


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def dead_pid() -> int:
    for pid in range(99_000, 99_999):
        if not alive(pid):
            return pid
    raise RuntimeError("no free pid to allow offers in")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--app", default=os.path.join(HERE, "..", ".build", "Caret.app"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    caret = os.path.join(os.path.abspath(a.app), "Contents", "MacOS", "Caret")
    results: list[dict] = []
    # /tmp, not $TMPDIR: socket paths under the home must fit in 103 bytes.
    home = tempfile.mkdtemp(prefix="caret-a2-", dir="/tmp")
    sock = os.path.join(home, "sockets", "host.sock")
    env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "TMPDIR", "LANG") if k in os.environ}
    env["PATH"] = CLEAN_PATH
    log_path = os.path.join(a.out, "host.log")
    host = None

    def check(name: str, fn) -> None:
        t0 = time.monotonic()
        try:
            detail = fn()
            results.append({"name": name, "pass": True, "ms": round((time.monotonic() - t0) * 1000), "detail": detail})
            print(f"PASS {name}: {detail}")
        except Exception as e:  # noqa: BLE001 - every failure is reported, then the run goes on to clean up
            results.append({"name": name, "pass": False, "ms": round((time.monotonic() - t0) * 1000), "detail": str(e)})
            print(f"FAIL {name}: {e}")

    def services() -> dict:
        return ask(sock, "services")

    def log_text() -> str:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            return f.read()

    try:
        if shutil.which("node", path=CLEAN_PATH) is not None:
            raise RuntimeError(f"node is on {CLEAN_PATH}; the run needs a PATH without it")
        args = [caret, "--home", home, "--surfaces", "headless", "--perch", "hidden", "--status-item", "off",
                "--no-ghost", "--onboarding", "off", "--allow-pids", str(dead_pid()), "--test-hooks"]
        with open(log_path, "w") as log:
            host = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)

        first: dict = {}

        def starts() -> str:
            s = wait("both services running", lambda: (lambda r: r if r.get("helper", {}).get("state") == "running"
                                                       and r.get("reader", {}).get("state") == "running" else None)(services()), 30)
            first.update(s)
            wait("the reader logs that the helper proved itself", lambda: "the helper proved itself" in log_text(), 30)
            helper_cmd = subprocess.run(["ps", "-o", "command=", "-p", str(s["helper"]["pid"])], capture_output=True, text=True).stdout.strip()
            assert "/Contents/Helpers/node" in helper_cmd and "/Contents/Resources/helper/main.mjs" in helper_cmd, helper_cmd
            assert "--auth-fd 0" in helper_cmd and helper_cmd.count(home) >= 3, helper_cmd
            return f"mode {s['mode']}, helper {s['helper']['pid']}, reader {s['reader']['pid']}, bridge {s['bridge']}; no node on PATH"
        check("Caret.app starts the bundled helper and reader, and the reader accepts the helper", starts)

        def restart_same_secret() -> str:
            old = first["helper"]["pid"]
            reader = first["reader"]["pid"]
            proofs = log_text().count("the helper proved itself")
            os.kill(old, signal.SIGKILL)
            s = wait("a new helper", lambda: (lambda r: r if r["helper"].get("state") == "running" and r["helper"]["pid"] != old else None)(services()), 15)
            wait("the reader accepts the new helper", lambda: log_text().count("the helper proved itself") > proofs, 15)
            assert s["reader"]["pid"] == reader and alive(reader), "the reader was restarted, so it proves nothing about the secret"
            assert s["helper"]["starts"] == 2 and s["helper"]["lastExit"] == "signal 9", s["helper"]
            return f"helper {old} -> {s['helper']['pid']}; reader {reader} kept running and accepted it"
        check("a killed helper is started again with the same secret", restart_same_secret)

        def stops_after_five() -> str:
            pids = []
            for _ in range(5):
                s = wait("a running helper", lambda: (lambda r: r if r["helper"].get("state") == "running" else r if r.get("stopped") else None)(services()), 15)
                if s.get("stopped"):
                    break
                pids.append(s["helper"]["pid"])
                os.kill(s["helper"]["pid"], signal.SIGKILL)
                wait("the helper is reaped", lambda: services()["helper"].get("pid") != pids[-1] or services()["helper"]["state"] != "running", 5)
            s = wait("the services stop", lambda: (lambda r: r if r.get("stopped") and r["helper"]["state"] == "stopped" and r["reader"]["state"] == "stopped" else None)(services()), 15)
            assert "exited 6 times within 60 s" in s["stopped"], s["stopped"]
            gone = [p for p in pids + [first["reader"]["pid"]] if alive(p)]
            assert not gone, f"still running: {gone}"
            return f"killed {len(pids)} more; stopped: {s['stopped']}"
        check("six helper exits within 60 s stop both, with the reason the menu shows", stops_after_five)

        def restart_menu() -> str:
            ask(sock, "services restart")
            s = wait("both running again", lambda: (lambda r: r if r["helper"].get("state") == "running" and r["reader"].get("state") == "running" and not r.get("stopped") else None)(services()), 30)
            return f"helper {s['helper']['pid']}, reader {s['reader']['pid']}"
        check("Restart starts both again", restart_menu)

        def quits_cleanly() -> str:
            s = services()
            children = [s["helper"]["pid"], s["reader"]["pid"]]
            host.send_signal(signal.SIGTERM)
            code = host.wait(timeout=20)
            assert code == 0, f"exit {code}"
            wait("the children are gone", lambda: not any(alive(p) for p in children), 10)
            return f"exit 0; helper {children[0]} and reader {children[1]} gone"
        check("SIGTERM: Caret exits 0 and stops its helper and reader", quits_cleanly)
    finally:
        if host is not None and host.poll() is None:
            host.kill()
            host.wait()
        shutil.rmtree(home, ignore_errors=True)
        with open(os.path.join(a.out, "services-acceptance.json"), "w") as f:
            json.dump(results, f, indent=2)
    passed = sum(r["pass"] for r in results)
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) and results else 1


if __name__ == "__main__":
    sys.exit(main())
