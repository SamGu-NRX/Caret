#!/usr/bin/env python3
"""What Caret knows, M1's markdown memory, walked headless against a real helper (brief U2, acceptance 5).

  memory_documents_walk.py --caret <Caret binary> --helper <M1 helper dir> --out <dir>

The helper is M1's own (helper/src/main.ts from a v2/screen checkout), started on a temporary home and
data directory, so it reads and writes nothing of the user's. Its memory folder is seeded with two
facts Caret noticed (an About value and a person) and one the user typed. The host runs with no window,
no menu bar item, no ghost text and no surfaces drawn (`--perch hidden --surfaces headless
--status-item off`), on its own sockets and settings file, acting on no app (`--allow-pids 1`). Every
step goes through the host's debug socket, which makes the same MemoryBook and MemoryFiles calls as the
window's buttons; each step is then checked on disk, where the helper keeps the files.

  1. list: the host's list shows the noticed facts as noticed and the three files with their revisions.
  2. edit through save: open about-me.md, change a value, save; the save names the revision it read,
     and the file on disk holds the new text.
  3. a forced conflict: open the file, change it on disk behind Caret's back, save; the helper writes
     nothing, and the host shows the conflict with the revision now. Reload takes the disk's text; a
     second conflict and Keep my text saves the typing over the newer file.
  4. Not right on a noticed fact: a correction makes the About value active with the typed text; a
     forget removes the noticed person.

The debug state leaves out a key whose value is nil (an editor that closed, no conflict), so those
are read with .get. Nothing here posts input or opens a window. Writes go only to the temporary directory, which is
removed at the end unless --keep.
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

SOCKETS = os.path.expanduser("~/.caret-run/sockets")
NOTICED_AT = "2026-10-02T15:05:00.000Z"

ABOUT = "\n".join([
    "# About me",
    "",
    "## Name <!-- caret:id=about-typed01 kind=about -->",
    "- Label: Name",
    "- Value: Dana Whitfield",
    "- Source: typed",
    "- Status: active",
    "",
    "## Office <!-- caret:id=about-noticed1 kind=about -->",
    "- Label: Office",
    "- Value: 4th floor, Northline",
    "- Source: typed",
    "- Status: noticed",
    "- Noticed in: Mail",
    "- Window: Re: Friday",
    f"- Noticed on: {NOTICED_AT}",
    "",
])

PEOPLE = "\n".join([
    "# People",
    "",
    "## Sam <!-- caret:id=people-noticed1 kind=people -->",
    "- Alias: Sam",
    "- Name: Sam Okafor",
    "- Status: noticed",
    "- Noticed in: Messages",
    f"- Noticed on: {NOTICED_AT}",
    "",
])


class Walk:
    def __init__(self, out: str):
        self.out = out
        self.checks: list[dict] = []
        self.log: list[str] = []

    def check(self, name: str, ok: bool, **detail):
        self.checks.append({"check": name, "ok": bool(ok), **({"detail": detail} if detail else {})})
        self.log.append(f"{'PASS' if ok else 'FAIL'} {name}" + (f" {json.dumps(detail, default=str)[:400]}" if not ok and detail else ""))
        print(self.log[-1], flush=True)

    def write(self, extra: dict):
        with open(os.path.join(self.out, "walk.json"), "w") as f:
            json.dump({**extra, "checks": self.checks, "passed": sum(c["ok"] for c in self.checks), "total": len(self.checks)}, f, indent=2)
        with open(os.path.join(self.out, "walk.log"), "w") as f:
            f.write("\n".join(self.log) + "\n")


def ask(path: str, command: str) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(5.0)
        s.connect(path)
        s.sendall((command + "\n").encode())
        s.shutdown(socket.SHUT_WR)
        chunks = []
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    return json.loads(b"".join(chunks))


def wait(predicate, timeout: float, step: float = 0.1):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            pass
        time.sleep(step)
    return last


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--caret", required=True)
    p.add_argument("--helper", required=True, help="the M1 helper's directory (holds src/main.ts)")
    p.add_argument("--out", required=True)
    p.add_argument("--keep", action="store_true")
    a = p.parse_args()
    os.makedirs(a.out, exist_ok=True)
    walk = Walk(a.out)

    home = tempfile.mkdtemp(prefix="caret-u2-walk-")
    data = os.path.join(home, "data")
    memory = os.path.join(data, "Memory")
    os.makedirs(memory, mode=0o700)
    for name, text in [("about-me.md", ABOUT), ("people.md", PEOPLE)]:
        with open(os.path.join(memory, name), "w") as f:
            f.write(text)
        os.chmod(os.path.join(memory, name), 0o600)
    os.makedirs(SOCKETS, exist_ok=True)
    helper_sock = os.path.join(SOCKETS, "u2-walk-helper.sock")
    host_sock = os.path.join(SOCKETS, "u2-walk-host.sock")
    for s in (helper_sock, host_sock):
        if os.path.exists(s):
            os.unlink(s)
    env = {**os.environ, "HOME": home}
    procs: list[subprocess.Popen] = []
    helper_log = open(os.path.join(a.out, "helper.log"), "w")
    host_log = open(os.path.join(a.out, "host.log"), "w")
    disk = lambda name: open(os.path.join(memory, name)).read()
    try:
        helper = subprocess.Popen(
            ["node", os.path.join(a.helper, "src", "main.ts"), "--data-dir", data, "--socket", helper_sock, "--no-jev", "--no-page"],
            cwd=a.helper, env=env, stdout=helper_log, stderr=subprocess.STDOUT,
        )
        procs.append(helper)
        if not wait(lambda: os.path.exists(helper_sock), 20):
            walk.check("helper listens", False)
            return 1
        host = subprocess.Popen(
            [a.caret, "--helper-socket", helper_sock, "--socket", host_sock, "--no-ghost", "--perch", "hidden", "--surfaces", "headless",
             "--status-item", "off", "--onboarding", "off", "--allow-pids", "1", "--settings", os.path.join(home, "settings.json"), "--test-hooks"],
            env=env, stdout=host_log, stderr=subprocess.STDOUT,
        )
        procs.append(host)
        mem = lambda command="": ask(host_sock, f"memory {command}".strip())
        info = wait(lambda: (m := mem()) and m["book"]["loaded"] and m["files"]["loaded"] and m, 30)
        walk.check("host connects and lists memory and files", bool(info), info=info)
        if not info:
            return 1

        # 1. list
        entries = {e["id"]: e for e in info["book"]["entries"]}
        walk.check("the noticed About value lists as noticed", entries.get("about-noticed1", {}).get("status") == "noticed", entry=entries.get("about-noticed1"))
        walk.check("the noticed person lists as noticed", entries.get("people-noticed1", {}).get("status") == "noticed", entry=entries.get("people-noticed1"))
        walk.check("the typed value lists as active", entries.get("about-typed01", {}).get("status") == "active", entry=entries.get("about-typed01"))
        docs = info["files"]["documents"]
        walk.check("the three files are listed with revisions", set(docs) >= {"about-me", "people", "preferences"} and docs["about-me"] != "none" and docs["preferences"] == "none", documents=docs)
        walk.check("the folder is the temporary home's", info["files"]["folder"] == memory, folder=info["files"]["folder"])

        # 2. edit through save with a base revision
        base = docs["about-me"]
        mem("open about-me")
        opened = wait(lambda: (m := mem())["files"].get("editing") == "about-me" and m, 5)
        walk.check("Edit reads the file into the editor at its revision", bool(opened) and opened["files"].get("base") == base, files=opened and opened["files"])
        current = disk("about-me.md")
        edited = current.replace("Dana Whitfield", "Dana R. Whitfield")
        mem("text " + edited.replace("\n", "\\n"))
        r = mem("savefile")
        walk.check("Save is sent", r.get("sent") is True, files=r.get("files"))
        walk.check("Save names the revision it read", f"save:about-me:{base}" in r["files"]["sent"], sent=r["files"]["sent"])
        saved = wait(lambda: (m := mem())["files"].get("editing") is None and m, 5)
        walk.check("the save closed the editor and the file holds the new text", bool(saved) and "Dana R. Whitfield" in disk("about-me.md"), disk=disk("about-me.md")[:300])
        walk.check("the file's revision moved", bool(saved) and saved["files"]["documents"]["about-me"] not in (base, "none"))

        # 3. a forced conflict
        mem("open about-me")
        opened = wait(lambda: (m := mem())["files"].get("editing") == "about-me" and m, 5)
        read_base = opened["files"].get("base") if opened else None
        theirs = disk("about-me.md").replace("Dana R. Whitfield", "Dana Whitfield-Reyes")
        with open(os.path.join(memory, "about-me.md"), "w") as f:
            f.write(theirs)
        mine = theirs.replace("Dana Whitfield-Reyes", "Dana Mine")
        mem("text " + mine.replace("\n", "\\n"))
        mem("savefile")
        conflicted = wait(lambda: (m := mem())["files"].get("conflict") and m, 5)
        walk.check("a save over a file changed on disk is refused as a conflict", bool(conflicted), files=conflicted and conflicted["files"])
        walk.check("nothing was written over their change", "Dana Whitfield-Reyes" in disk("about-me.md"))
        walk.check("the conflict names a newer revision than the one read", bool(conflicted) and conflicted["files"].get("conflict") not in (read_base, None))
        mem("reload")
        reloaded = wait(lambda: (m := mem())["files"].get("conflict") is None and m["files"].get("saving") is False and m, 5)
        walk.check("Reload takes the file as it is now", bool(reloaded) and reloaded["files"]["textLength"] == len(theirs.encode("utf-16-le")) // 2, files=reloaded and reloaded["files"])
        # A second conflict, answered with Keep my text.
        with open(os.path.join(memory, "about-me.md"), "w") as f:
            f.write(theirs.replace("Dana Whitfield-Reyes", "Dana Whitfield-Ortiz"))
        mem("text " + mine.replace("\n", "\\n"))
        mem("savefile")
        wait(lambda: mem()["files"].get("conflict"), 5)
        r = mem("keepmine")
        walk.check("Keep my text is sent over the revision now", r.get("sent") is True and r["files"]["sent"][-1].startswith("save:about-me:sha256:"), sent=r["files"]["sent"][-3:])
        kept = wait(lambda: (m := mem())["files"].get("editing") is None and m, 5)
        walk.check("Keep my text saves the typing over the newer file", bool(kept) and "Dana Mine" in disk("about-me.md"), disk=disk("about-me.md")[:300])

        # 4. Not right on a noticed fact
        mem("list")
        wait(lambda: any(e["id"] == "about-noticed1" for e in mem()["book"]["entries"]), 5)
        mem("notright about-noticed1")
        r = mem("correct 6th floor, Northline")
        walk.check("Not right with a correction is sent", r.get("sent") is True, book=r["book"].get("correcting"))
        fixed = wait(lambda: next((e for e in mem()["book"]["entries"] if e["id"] == "about-noticed1" and e["status"] == "active"), None), 5)
        walk.check("the corrected fact is active with what was typed", bool(fixed) and "6th floor" in fixed["says"], entry=fixed)
        walk.check("the file says so", "6th floor, Northline" in disk("about-me.md"), disk=disk("about-me.md")[:400])
        mem("notright people-noticed1")
        r = mem("forgetnoticed")
        walk.check("Not right, Forget is sent", r.get("sent") is True)
        gone = wait(lambda: not any(e["id"] == "people-noticed1" for e in mem()["book"]["entries"]), 5)
        walk.check("the forgotten person is gone from the list", bool(gone))
        walk.check("and from people.md", "Sam Okafor" not in disk("people.md"), disk=disk("people.md")[:300])
        return 0 if all(c["ok"] for c in walk.checks) else 1
    finally:
        for proc in reversed(procs):
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(10)
                except subprocess.TimeoutExpired:
                    proc.kill()
        helper_log.close()
        host_log.close()
        for s in (helper_sock, host_sock):
            if os.path.exists(s):
                os.unlink(s)
        walk.write({"home": home if a.keep else "(temporary, removed)", "helper": a.helper, "caret": a.caret})
        if not a.keep:
            shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
