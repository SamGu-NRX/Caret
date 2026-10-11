"""a18_vm_walk.py's failure paths, run end to end against stand-ins, on any Mac.

V1a's walk lost the keyboard focus partway through mid case 8 (fixture-keys sent 3 of 12 Right
arrows, then refused because pid 361 had focus), raised, and left no results.json. These tests run
the walk with every tool it calls replaced by a stand-in in a temporary bin directory:

- cua-driver "launches" TextEdit as a `sleep` this test owns, so the walk's close() can only stop
  that;
- fixture-keys refuses `key right 2` once or every time, the way the real one does (exit 3, "sent N"
  on stdout, the focus owner on stderr);
- the host answers every debug command with an empty object;
- screencapture, hid-key and pid-keys exist so that a stray call is visible, and screencapture
  fails, so nothing on this Mac's screen is captured.

No key, click or capture reaches this Mac. Run with
`python3 -m unittest apps/caret/scripts/test_a18_vm_walk.py` from the repository root. WALK names
another copy of the walk to test (the fail-before run used the one at 9fd8235).
"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WALK = os.environ.get("WALK", os.path.join(HERE, "a18_vm_walk.py"))

CUA = r'''
import json, os, subprocess, sys
tool, args = sys.argv[1], json.loads(sys.argv[2])
state = os.path.join(os.environ["STUB_DIR"], "cua.json")
s = json.load(open(state)) if os.path.exists(state) else {"windows": {}}
out = {}
if tool == "launch_app":
    p = subprocess.Popen(["sleep", "600"], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    s["windows"][str(p.pid)] = os.path.basename(args["urls"][0])
    out = {"pid": p.pid}
elif tool == "list_windows":
    title = s["windows"].get(str(args["pid"]))
    out = {"windows": [{"window_id": 7, "title": title, "bounds": {"x": 0, "y": 30, "width": 960, "height": 480}}] if title else []}
elif tool == "get_window_state":
    out = {"elements": [{"role": "AXTextArea", "value": ""}]}
json.dump(s, open(state, "w"))
print(json.dumps(out))
'''

KEYS = r'''
import os, sys
pid, verb = sys.argv[1], sys.argv[2]
log = open(os.path.join(os.environ["STUB_DIR"], "keys.log"), "a")
log.write(" ".join(sys.argv[1:]) + "\n")
if verb == "check":
    sys.exit(0)
if verb == "key" and sys.argv[3:] == ["right", "2"]:
    marker = os.path.join(os.environ["STUB_DIR"], "refused-once")
    if os.environ.get("STUB_REFUSE") == "always" or not os.path.exists(marker):
        open(marker, "w").close()
        print("sent 1")
        sys.stderr.write(f"refused: focus is app=361 element=361, not {pid}\n")
        sys.exit(3)
count = sys.argv[4] if verb == "key" and len(sys.argv) > 4 else "1"
print("sent " + (str(len(sys.argv[3])) if verb == "type" else count))
'''

HOST = r'''
import json, os, socket, sys
path = sys.argv[sys.argv.index("--socket") + 1]
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(path)
server.listen(8)
while True:
    conn, _ = server.accept()
    data = b""
    while not data.endswith(b"\n"):
        chunk = conn.recv(65536)
        if not chunk:
            break
        data += chunk
    verb = data.decode().split(" ")[0].strip()
    conn.sendall(json.dumps({"ok": True} if verb == "ping" else {}).encode())
    conn.close()
'''

SCREENCAPTURE = r'''
import os, sys
open(os.path.join(os.environ["STUB_DIR"], "screencapture.log"), "a").write(" ".join(sys.argv[1:]) + "\n")
sys.exit(1)
'''


class WalkFocusLossTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="a18-walk-test-")
        self.bin = os.path.join(self.dir, "bin")
        os.makedirs(self.bin)
        for name, body in (("cua-driver", CUA), ("fixture-keys", KEYS), ("caret", HOST), ("screencapture", SCREENCAPTURE),
                           ("hid-key", "import sys; sys.exit(0)"), ("pid-keys", "import sys; sys.exit(0)"),
                           ("compose-shot", "import sys; sys.exit(0)")):
            path = os.path.join(self.bin, name)
            with open(path, "w") as f:
                f.write("#!" + sys.executable + "\n" + textwrap.dedent(body))
            os.chmod(path, 0o755)
        # Three mid cases; the third ("abc") is where the arrows are refused. Every outcome is silent,
        # so the walk takes no screenshot.
        self.mids = [{"before": "Hi", "after": " there."}, {"before": "Yo", "after": " you."}, {"before": "abc", "after": " def."}]
        replay = {"entries": [{"before": m["before"], "after": m["after"], "reason": "lowConfidenceMidLine"} for m in self.mids]}
        for name, value in (("replay.json", replay), ("mid.json", self.mids), ("tab.json", [])):
            json.dump(value, open(os.path.join(self.dir, name), "w"))
        self.out = os.path.join(self.dir, "out")

    def tearDown(self):
        state = os.path.join(self.dir, "cua.json")
        if os.path.exists(state):
            for pid in json.load(open(state))["windows"]:
                try:
                    os.kill(int(pid), 9)
                except ProcessLookupError:
                    pass

    def walk(self, refuse):
        env = dict(os.environ, RIG_JOB="stub", STUB_DIR=self.dir, STUB_REFUSE=refuse, PATH=self.bin + os.pathsep + os.environ["PATH"])
        b = self.bin
        args = [sys.executable, WALK, "--caret", f"{b}/caret", "--keys", f"{b}/fixture-keys", "--hidkey", f"{b}/hid-key",
                "--compose", f"{b}/compose-shot", "--replay", f"{self.dir}/replay.json", "--mid", f"{self.dir}/mid.json",
                "--tab", f"{self.dir}/tab.json", "--screen", "960x600", "--out", self.out]
        run = subprocess.run(args, env=env, capture_output=True, text=True, timeout=180)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "screencapture.log")), "nothing was captured")
        return run

    def results(self):
        path = os.path.join(self.out, "results.json")
        self.assertTrue(os.path.exists(path), "the walk wrote results.json")
        return json.load(open(path))

    def test_focus_lost_every_time_fails_the_case_and_keeps_the_report(self):
        run = self.walk("always")
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        r = self.results()
        names = [c["check"] for c in r["checks"]]
        self.assertIn("mid 1: silent, as the model run was (lowConfidenceMidLine)", names, "earlier checks are kept")
        failed = [c for c in r["checks"] if not c["ok"] and c["check"].startswith("mid 3")]
        self.assertEqual(len(failed), 1, names)
        self.assertEqual(len(r["interruptions"]), 2, "the first attempt and its one retry")
        first = r["interruptions"][0]
        self.assertEqual((first["case"], first["command"], first["sent"], first["of"]), ("mid 3", "key right 2", 1, 2))
        self.assertIn("app=361", first["focus"])
        self.assertTrue(r["complete"], "the walk went on to its end")
        self.assertIsNone(r["exception"])
        self.assertIn("mid 3", r["done"])
        sys.path.insert(0, HERE)
        import vm_results
        ok, line = vm_results.verdict(r)
        self.assertFalse(ok)
        # The focus owner is named by its process (whatever pid 361 is on this Mac, or "gone").
        self.assertRegex(line, r"mid 3 \(key right 2: sent 1 of 2, focus app=361 element=361 \([^)]+\)\)")

    def test_focus_lost_once_is_retried_from_a_fresh_document(self):
        run = self.walk("once")
        r = self.results()
        self.assertEqual(len(r["interruptions"]), 1)
        mid3 = [c for c in r["checks"] if c["check"].startswith("mid 3")]
        self.assertTrue(mid3 and all(c["ok"] for c in mid3), mid3)
        launched = json.load(open(os.path.join(self.dir, "cua.json")))["windows"]
        self.assertEqual(sum(1 for t in launched.values() if t == "mid-3.txt"), 2, "the retry opened its own document")
        self.assertTrue(r["complete"])
        self.assertNotIn("mid 3", " ".join(c["check"] for c in r["checks"] if not c["ok"]), run.stdout)


class VerdictTests(unittest.TestCase):
    """vm_results.py, which job.sh asks for check 7's line."""

    def verdict(self, results, *expect):
        sys.path.insert(0, HERE)
        import vm_results
        return vm_results.verdict(results, expect)

    def test_missing_results_say_the_walk_aborted(self):
        ok, line = self.verdict(None)
        self.assertFalse(ok)
        self.assertIn("results missing", line)

    def test_an_exception_or_a_missing_case_is_a_failure(self):
        base = {"passed": 2, "failed": 0, "checks": [{"check": "a", "ok": True}, {"check": "b", "ok": True}],
                "planned": ["a", "b"], "done": ["a", "b"], "complete": True, "exception": None, "interruptions": []}
        self.assertTrue(self.verdict(base)[0])
        self.assertFalse(self.verdict(dict(base, exception={"case": "mid 3", "error": "boom"}))[0])
        self.assertFalse(self.verdict(dict(base, complete=False))[0])
        ok, line = self.verdict(dict(base, planned=["a", "b", "c"]))
        self.assertFalse(ok)
        self.assertIn("cases not finished: c", line)
        ok, line = self.verdict(base, "d")
        self.assertFalse(ok, "an expected case the walk never planned")
        self.assertIn("cases not finished: d", line)

    def test_interruptions_are_named_in_the_line(self):
        r = {"passed": 1, "failed": 0, "checks": [{"check": "mid 3", "ok": True}], "planned": ["mid 3"], "done": ["mid 3"], "complete": True,
             "exception": None, "interruptions": [{"case": "mid 3", "command": "key right 12", "sent": 3, "of": 12, "focus": "app=361 element=361"}]}
        ok, line = self.verdict(r)
        self.assertTrue(ok)
        self.assertIn("mid 3", line)
        self.assertIn("3 of 12", line)


if __name__ == "__main__":
    unittest.main()
