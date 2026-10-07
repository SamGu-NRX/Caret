"""Phase B's rig.ts (branch ops/heavy-browser, fixtures/web-form/rig.ts) with light fakes: a shell script stands in for
Chrome for Testing, and a fake registration command records what was registered and when. Skipped when that branch's
worktree is absent; CARET_HEAVY_RIG_TS points at another copy of rig.ts."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RIG_TS = os.environ.get("CARET_HEAVY_RIG_TS",
                        "/Users/samgu/Programming Projects/caret-ops-heavy-browser/fixtures/web-form/rig.ts")
NODE = shutil.which("node") or "/opt/homebrew/bin/node"
PREFIX = "caret-heavy.caret-rigts-{}.".format(os.getpid())


@unittest.skipUnless(os.path.exists(RIG_TS), "phase B's rig.ts is not checked out")
class RigTs(unittest.TestCase):
    def setUp(self):
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="caret-rigts-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        os.makedirs(os.path.join(self.dir, "profile"))
        # Stands in for Chrome: marks that it started, leaves a child that ignores SIGTERM in its group, and waits.
        self.script("fake-chrome", '''#!/bin/sh
d=$(dirname "$0")
touch "$d/started"
/bin/sh -c 'trap "" TERM; echo $$ > "'$d'/child.pid"; while :; do sleep 1; done' &
while :; do sleep 1; done
''')
        # Records each registration; for a group, whether the fake Chrome had already started (it must not have).
        self.script("register", '''#!/bin/sh
d=$(dirname "$0")
if [ "$1" = group ]; then
  if [ -e "$d/started" ]; then echo "group $2 AFTER-START" >> "$d/register.log"; else echo "group $2 before-start" >> "$d/register.log"; fi
  [ -e "$d/refuse" ] && { echo refused >&2; exit 1; }
else
  if launchctl print "gui/$(id -u)/$2" >/dev/null 2>&1; then echo "launchd $2 AFTER-BOOTSTRAP" >> "$d/register.log"
  else echo "launchd $2 before-bootstrap" >> "$d/register.log"; fi
fi
exit 0
''')

    def script(self, name, text):
        path = os.path.join(self.dir, name)
        with open(path, "w") as fh:
            fh.write(text)
        os.chmod(path, 0o755)

    def run_harness(self, mode, custody=True):
        env = dict(os.environ)
        env.pop("CARET_HEAVY_REGISTER", None)
        env.pop("CARET_HEAVY_LAUNCHD_PREFIX", None)
        if custody:
            env.update(CARET_HEAVY_REGISTER=os.path.join(self.dir, "register"), CARET_HEAVY_LAUNCHD_PREFIX=PREFIX)
        done = subprocess.run([NODE, os.path.join(HERE, "rig_ts_harness.mjs"), RIG_TS, self.dir, mode], env=env,
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr)
        with open(os.path.join(self.dir, "result.json")) as fh:
            return json.load(fh)

    def test_chrome_is_registered_before_it_starts_and_stop_waits_for_its_whole_group(self):
        out = self.run_harness("launch")
        self.assertIsNone(out["error"])
        self.assertEqual(out["registerLog"].split(), ["group", str(out["pid"]), "before-start"])
        self.assertTrue(out["started"])
        self.assertIn("fake-chrome", out["command"])
        self.assertNotIn("chrome-held", out["command"])  # the held shell exec'd Chrome in place: same pid, same group
        self.assertGreaterEqual(out["membersBeforeStop"], 2)
        self.assertEqual(out["membersAfterStop"], [])  # the SIGTERM-proof child included
        self.assertGreater(out["stopMs"], 4500)  # it took the SIGKILL after the 5 s wait

    def test_a_refused_registration_means_chrome_never_starts(self):
        open(os.path.join(self.dir, "refuse"), "w").close()
        out = self.run_harness("refused")
        self.assertIn("was not registered, so it was never started", out["error"])
        self.assertFalse(out["started"])

    def test_the_test_hosts_label_carries_the_job_prefix_and_is_registered_before_bootstrap(self):
        out = self.run_harness("launchd")
        self.assertIn("is not under this job's prefix", out["unprefixed"])
        self.assertTrue(out["label"].startswith(PREFIX))
        self.assertEqual(out["registerLog"].split(), ["launchd", out["label"], "before-bootstrap"])
        self.assertTrue(out["loaded"])
        self.assertEqual(out["afterCleanup"], "gone")

    def test_outside_caret_heavy_chrome_starts_directly_as_before(self):
        out = self.run_harness("plain", custody=False)
        self.assertIsNone(out["error"])
        self.assertEqual(out["registerLog"], "")
        self.assertTrue(out["command"].endswith("fake-chrome") or "fake-chrome" in out["command"])
        self.assertNotIn("chrome-held", out["command"])
        self.assertEqual(out["membersAfterStop"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
