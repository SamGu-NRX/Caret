#!/usr/bin/env python3
"""What Caret knows, in Caret's own windows, with real keys (brief A11, acceptance 4).

  lockf -k ~/.long-run/locks/gui.lock memory_window_walk.py <Caret binary> <out_dir> [light|dark]

Part one is onboarding's know screen in its real window: Return through welcome and work, the name
typed key by key into the name field, Tab to the email field, an incomplete email typed, Return
(the problem shows and Continue holds), the rest typed, and Return on to permissions. The run's
helper must receive both values as `add` requests with what the keys typed.

Part two is the memory window, opened by the `memory show` test hook as the menu opens it. Edit is
a button, so the socket opens the edit as a click would (`memory edit`); then real keys select the
value (Command-A), type a new one and Return saves it; the helper must receive that edit and the row
must read it back. A second edit is cancelled with a real Esc, and nothing is sent.

Each key is posted at the HID level by fixture-ax key-if-front, which refuses unless Caret's own
pid is frontmost by both NSWorkspace and LaunchServices. The helper is a fake on the run's own
socket that answers memoryRequest from Tests/CaretHostCoreTests/Fixtures/memory.ndjson's entries
and implements the host's `add` contract (today's helper refuses add; memory_socket_acceptance.ts
shows that). Settings live in a temporary file. Runs only behind every gate of a foreground run
(fixture_app.py): the gui lease, gui.lock held by the caller, 300 s without input, no quiet window;
stops within 0.2 s of input that is not its own key and gives the foreground back. Screenshots are
of Caret's window alone.
"""
import copy
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import fixture_app
import onboarding_window_walk as ow
from onboarding_socket_walk import FakeHelper

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "Tests", "CaretHostCoreTests", "Fixtures", "memory.ndjson")
ENTRIES = json.loads(open(FIXTURE).read().split("\n")[1])["entries"]
PERM_SAYS = {"read": "Read and prepare", "show": "Show in Caret's UI", "writeHere": "Write where you are",
             "writeElsewhere": "Reversible write elsewhere", "outbound": "Send, submit, post", "destructive": "Delete, overwrite",
             "sensitive": "Money, passwords, system dialogs"}
RULE_SAYS = {"act": "act", "actIfApproved": "act if pre-approved", "ask": "ask first", "handoff": "hand off to you"}
NAME, EMAIL_START, EMAIL_END = "Dana Whitfield", "dana.whitfield@example", ".com"
NEW_VALUE = "Marcus Lowe, Operations"


class MemoryHelper(FakeHelper):
    """The socket walk's fake helper, plus memoryRequest over a copy of the fixture's entries."""

    def __init__(self, path):
        self.entries = copy.deepcopy(ENTRIES)
        self.memory = []
        self.added = 0
        super().__init__(path)

    def _handle(self, message):
        if message.get("type") != "memoryRequest":
            return super()._handle(message)
        self.received.append((time.monotonic(), message))
        self.memory.append(message)
        op, rid = message["op"], message["requestId"]

        def reply(entries, error=None):
            self.send({"type": "memoryReply", "v": 1, "requestId": rid, "error": error, "entries": entries})

        if op == "list":
            return reply([e for e in self.entries if message.get("kind") in (None, e["kind"])])
        if op == "add":
            self.added += 1
            f = dict(message["fields"])
            e = {"kind": "about", "id": f"about-typed-{self.added}", "status": "active", "says": f"{f['label']}: {f['value']} (you typed this)",
                 "evidence": {"count": 1, "lastSeen": int(time.time() * 1000), "app": None}, "fields": f}
            self.entries.insert(0, e)
            return reply([e])
        e = next((x for x in self.entries if x["id"] == message.get("id")), None)
        if e is None:
            return reply([], f"no memory entry {message.get('id')}")
        if op == "edit":
            e["fields"].update(message["fields"])
            if e["kind"] == "about":
                e["says"] = f"{e['fields']['label']}: {e['fields']['value']} (from your edit)"
            elif e["kind"] == "permission":
                e["says"] = f"{PERM_SAYS[e['fields']['action']]}: {RULE_SAYS[e['fields']['rule']]}"
            return reply([e])
        if op in ("pause", "resume"):
            e["status"] = "paused" if op == "pause" else "active"
            return reply([e])
        if op == "forget":
            self.entries.remove(e)
            return reply([])
        return reply([], f"unknown op {op}")


def window(host, title):
    out = subprocess.run(["cua-driver", "list_windows", json.dumps({"pid": host.proc.pid})], capture_output=True, text=True, timeout=10)
    windows = json.loads(out.stdout or "{}").get("windows", [])
    return next((w for w in windows if w.get("title") == title and w.get("is_on_screen", True)), None)


def walk(binary, out_dir, appearance, run_dir, result):
    check = ow.check
    helper = MemoryHelper(os.path.join(run_dir, "helper.sock"))
    host = ow.Host(binary, run_dir, helper.path, appearance)
    result["names"][host.proc.pid] = "caret"
    pid = host.proc.pid
    env = dict(os.environ, CARET_TEST_PIDS=str(pid))
    shots = os.path.join(out_dir, "shots")
    os.makedirs(shots, exist_ok=True)

    def wait(read, predicate, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            r = read()
            if predicate(r):
                return r
            time.sleep(0.05)
        return None

    ob = lambda: host.ask("onboarding")
    mem = lambda: host.ask("memory")

    def shot(name, title):
        w = window(host, title)
        if w is None:
            return None
        path = os.path.join(shots, f"{name}.png")
        subprocess.run(["screencapture", "-x", "-o", f"-l{w['window_id']}", path], check=True)
        result["shots"][name] = path
        return path

    def key(name, char=None):
        now = ow.front()
        if not (now.get("pid") == pid and now.get("lsappinfo") == pid):
            raise SystemExit(f"deferred: foreground (front={now} before {name})")
        ow.SYNTHETIC.append((time.time(), time.time() + 3))
        args = [ow.AX, "key-if-front", str(pid), name] + ([char] if char is not None else [])
        out = subprocess.run(args, capture_output=True, text=True, env=env)
        if out.returncode != 0:
            raise SystemExit(f"deferred: foreground (key-if-front {name}: {(out.stdout + out.stderr).strip()})")
        time.sleep(0.12)

    def type_text(text):
        for c in text:
            key("space") if c == " " else key("char", c)

    # Part one: the know screen.
    shown = wait(ob, lambda r: r.get("windowShown") and r.get("step") == "welcome", 5)
    if not check("the onboarding window opens on welcome", shown is not None, state=ob()):
        return
    if not wait(lambda: ow.front(), lambda f: f.get("pid") == pid and f.get("lsappinfo") == pid, 3):
        raise SystemExit("deferred: foreground (Caret did not become frontmost)")
    time.sleep(0.4)
    key("return")
    wait(ob, lambda r: r.get("step") == "work", 2)
    key("return")
    r = wait(ob, lambda r: r.get("step") == "know", 2)
    check("Return on work goes to the know screen", r is not None, state=ob())
    time.sleep(0.5)
    shot("1-know", "Set up Caret")
    type_text(NAME)
    r = wait(ob, lambda r: (r.get("about") or {}).get("name") == len(NAME), 2)
    check("real keys type the name into the name field, which has focus as the screen opens", r is not None, about=ob().get("about"))
    key("tab")
    type_text(EMAIL_START)
    r = wait(ob, lambda r: (r.get("about") or {}).get("email") == len(EMAIL_START), 2)
    check("Tab moves to the email field and keys type into it", r is not None, about=ob().get("about"))
    key("return")
    r = wait(ob, lambda r: r.get("aboutProblem") == "That email looks incomplete.", 2)
    check("Return with an incomplete email holds the screen and says why", r is not None and r.get("step") == "know", state=ob())
    time.sleep(0.3)
    shot("2-know-problem", "Set up Caret")
    type_text(EMAIL_END)
    r = wait(ob, lambda r: r.get("aboutProblem") is None and (r.get("about") or {}).get("email") == len(EMAIL_START + EMAIL_END), 2)
    check("typing after the problem keeps going into the email field and clears the problem", r is not None, state=ob())
    key("return")
    r = wait(ob, lambda r: r.get("step") == "permissions", 2)
    check("Return keeps them and moves on to permissions", r is not None, state=ob())
    adds = wait(lambda: [m for m in helper.memory if m["op"] == "add"], lambda a: len(a) >= 2, 3) or []
    check("the helper receives what the keys typed, as add requests",
          [(m["fields"]["label"], m["fields"]["value"], m["fields"]["source"]) for m in adds]
          == [("Name", NAME, "typed"), ("Email", EMAIL_START + EMAIL_END, "typed")], adds=adds)
    host.ask("onboarding close")
    time.sleep(0.5)

    # Part two: the memory window.
    host.ask("memory show")
    shown = wait(lambda: window(host, "What Caret knows"), lambda w: w is not None, 5)
    if not check("memory show puts up the What Caret knows window", shown is not None):
        return
    if not wait(lambda: ow.front(), lambda f: f.get("pid") == pid and f.get("lsappinfo") == pid, 3):
        raise SystemExit("deferred: foreground (Caret's memory window did not come to the front)")
    m = wait(mem, lambda m: m["book"]["loaded"] and any(e["says"].startswith("Name: ") for e in m["book"]["entries"]), 3)
    check("the window lists the helper's memory, the typed name and email included", m is not None,
          says=[e["says"] for e in (m or mem())["book"]["entries"] if e["kind"] == "about"])
    time.sleep(0.6)
    shot("3-memory", "What Caret knows")

    host.ask("memory edit about-1a2b3c4d")
    wait(mem, lambda m: m["book"].get("editing") == "about-1a2b3c4d", 2)
    time.sleep(0.6)
    key("cmd-a")
    type_text(NEW_VALUE)
    r = wait(mem, lambda m: (m["book"].get("draft") or {}).get("value") == NEW_VALUE, 3)
    check("real keys replace the value in the edit's focused field", r is not None, draft=mem()["book"].get("draft"))
    time.sleep(0.2)
    shot("4-memory-edit", "What Caret knows")
    edits_before = len([x for x in helper.memory if x["op"] == "edit"])
    key("return")
    r = wait(mem, lambda m: m["book"].get("editing") is None
             and any(e["id"] == "about-1a2b3c4d" and e["says"] == f"Guest: {NEW_VALUE} (from your edit)" for e in m["book"]["entries"]), 3)
    sent = [x for x in helper.memory if x["op"] == "edit"][edits_before:]
    check("Return saves: the helper gets the edit and the row reads it back",
          r is not None and [x.get("fields") for x in sent] == [{"value": NEW_VALUE}], sent=sent)
    time.sleep(0.6)
    shot("5-memory-saved", "What Caret knows")

    host.ask("memory edit about-1a2b3c4d")
    wait(mem, lambda m: m["book"].get("editing") == "about-1a2b3c4d", 2)
    time.sleep(0.4)
    count = len(helper.memory)
    type_text("x")
    key("esc")
    r = wait(mem, lambda m: m["book"].get("editing") is None, 2)
    time.sleep(0.3)
    check("Esc cancels the edit and sends nothing", r is not None and len(helper.memory) == count, sent=helper.memory[count:])

    host.ask("memory tab permissions")
    time.sleep(0.5)
    shot("6-permissions", "What Caret knows")
    result["memoryRequests"] = helper.memory
    host.ask("memory close")
    time.sleep(0.4)
    check("the window closes", window(host, "What Caret knows") is None)
    host.stop()
    helper.close()


def main():
    if len(sys.argv) not in (3, 4):
        raise SystemExit(__doc__)
    binary, out_dir = sys.argv[1], sys.argv[2]
    appearance = sys.argv[3] if len(sys.argv) == 4 else "light"
    os.makedirs(out_dir, exist_ok=True)
    result = {"shots": {}, "names": {}, "appearance": appearance}
    why = fixture_app.why_not_foreground()
    if why:
        print(why)
        result["status"] = why
        json.dump(result, open(os.path.join(out_dir, "walk.json"), "w"), indent=2)
        return 75
    before = ow.front().get("pid")
    run_dir = tempfile.mkdtemp(prefix="cmw-", dir="/tmp")
    lease = fixture_app.GuiLease()
    dog = fixture_app.Watchdog(lambda t: any(a - 0.2 <= t <= b for a, b in ow.SYNTHETIC), ow.front, result["names"])
    status = None
    try:
        lease.__enter__()
        dog.__enter__()
        walk(binary, out_dir, appearance, run_dir, result)
    except KeyboardInterrupt:
        status = f"deferred: user active (input at {dog.tripped})" if dog.tripped else "interrupted"
        ow.log(status)
    except SystemExit as stop:
        status = str(stop)
        ow.log(status)
    except Exception as e:
        # A crash is a failure, never "done".
        import traceback
        status = f"error: {e!r}"
        result["traceback"] = traceback.format_exc()
        ow.log(status)
    finally:
        dog.__exit__()
        if os.path.exists(os.path.join(run_dir, "host.log")):
            shutil.copy(os.path.join(run_dir, "host.log"), os.path.join(out_dir, "host.log"))
        for p in list(result["names"]):
            try:
                os.kill(p, signal.SIGTERM)
            except ProcessLookupError:
                pass
        time.sleep(0.5)
        if before and ow.front().get("pid") != before:
            result["handBack"] = json.loads(subprocess.run([ow.AX, "hand-back", str(before)], capture_output=True, text=True).stdout or "{}")
        dog.timeline.append((round(time.time() - dog.start, 2), ow.front().get("pid"), "after hand-back"))
        lease.__exit__()
        shutil.rmtree(run_dir, ignore_errors=True)
        result["frontTimeline"] = dog.timeline
        result["checks"] = ow.CHECKS
        result["passed"] = sum(c["ok"] for c in ow.CHECKS)
        result["failed"] = sum(not c["ok"] for c in ow.CHECKS)
        result["status"] = status or ("done" if result["failed"] == 0 else "failed")
        result["names"] = {str(k): v for k, v in result["names"].items()}
        with open(os.path.join(out_dir, "walk.json"), "w") as f:
            json.dump(result, f, indent=2, sort_keys=True, default=str)
        ow.log("summary", result["passed"], "passed,", result["failed"], "failed;", result["status"])
    return 0 if result["status"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
