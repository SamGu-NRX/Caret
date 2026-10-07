"""The recipe scripts' own control flow, run directly with stub tools (tests/stubs) in place of pnpm, node, npx,
rig-run and Lume. Checks the exit codes, stopping at the first wrong value, the live watcher, the spend check, and
R2's feeder with its spend control and leak scan. The real tools run only in real heavy jobs; build.sh and stage.sh
(r2-prepare) are not covered here."""

import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HEAVY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STUBS = os.path.join(HEAVY, "tests/stubs")
RECIPES = os.path.join(HEAVY, "recipes")
PY = "/opt/homebrew/opt/python@3.14/bin/python3.14"
REV = "c" * 40


class Recipes(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="caret-heavy-recipes-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.home = os.path.join(self.root, "home")
        self.worktree = os.path.join(self.root, "worktree")
        for d in ("helper", "extension", "fixtures/web-form", "bridge/.build/release"):
            os.makedirs(os.path.join(self.worktree, d))
        os.makedirs(self.home)
        self.out = os.path.join(self.root, "out")

    def run_recipe(self, script, *args, env=None):
        shutil.rmtree(self.out, ignore_errors=True)
        os.makedirs(self.out)
        base = {"PATH": STUBS + ":/usr/bin:/bin", "HOME": self.home, "CARET_HEAVY_RECIPES": RECIPES,
                "CARET_HEAVY_PY": PY, "CARET_HEAVY_OUT": self.out, "CARET_HEAVY_JOB_ID": "caret-recipe-test",
                "CARET_HEAVY_PLAN_SHA256": "e" * 64, "CARET_HEAVY_RECIPE": os.path.basename(script)[:-3],
                "CARET_HEAVY_REV": REV}
        done = subprocess.run(["/bin/bash", os.path.join(RECIPES, script), *args], cwd=self.worktree,
                              env=dict(base, **(env or {})), capture_output=True, text=True, timeout=120)
        try:
            with open(os.path.join(self.out, "result.json")) as fh:
                result = json.load(fh)
        except FileNotFoundError:
            result = None
        return done, result

    def steps(self, result):
        return [(s["kind"], s["name"], s["code"]) for s in result["steps"]]

    def test_canned_sets_stop_at_the_first_wrong_value(self):
        done, result = self.run_recipe("canned-sets.sh", "t", env={"STUB_WRONG": "tasks-labelled"})
        self.assertEqual(done.returncode, 10, done.stdout + done.stderr)
        self.assertEqual(self.steps(result), [("prepare", "dependencies", 0), ("page-loop", "tasks-blind-t", 0),
                                              ("page-loop", "tasks-labelled-t", 10)])
        self.assertFalse(os.path.exists(os.path.join(self.out, "corpus-goal-t")))
        self.assertEqual(result["exit"], 10)

    def test_canned_sets_clone_binaries_from_a_source_and_pass(self):
        source = os.path.join(self.root, "source")
        os.makedirs(os.path.join(source, "bridge/.build/release"))
        os.makedirs(os.path.join(source, "fixtures/web-form/.browsers/chrome"))
        for rel in ("bridge/.build/release/caret-bridge", "bridge/.build/release/caret-bridge-testhost",
                    "fixtures/web-form/.browsers/chrome/Chrome"):
            with open(os.path.join(source, rel), "w") as fh:
                fh.write(rel + "\n")
        with open(os.path.join(self.worktree, "bridge/.build/release/caret-bridge"), "w") as fh:
            fh.write("stale build\n")
        done, result = self.run_recipe("canned-sets.sh", "t", source)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual([s[2] for s in self.steps(result)], [0, 0, 0, 0, 0])
        with open(os.path.join(self.worktree, "bridge/.build/release/caret-bridge")) as fh:
            self.assertEqual(fh.read(), "bridge/.build/release/caret-bridge\n")  # replaced, not kept
        self.assertTrue(os.path.exists(os.path.join(self.worktree, "fixtures/web-form/.browsers/chrome/Chrome")))

    def test_a_failed_offline_install_stops_before_any_set(self):
        done, result = self.run_recipe("canned-sets.sh", "t", env={"STUB_INSTALL_EXIT": "1"})
        self.assertEqual(done.returncode, 14)
        self.assertEqual(self.steps(result), [("prepare", "dependencies", 14)])

    def test_helper_window_runs_every_suite_and_fails_on_one(self):
        done, result = self.run_recipe("helper-window.sh", "t", env={"STUB_FAIL_SUITE": "extension"})
        self.assertEqual(done.returncode, 11, done.stdout + done.stderr)
        self.assertEqual(self.steps(result), [("prepare", "dependencies", 0), ("suite", "helper-t", 0),
                                              ("suite", "extension-t", 11), ("suite", "fixtures-tsc-t", 0),
                                              ("suite", "fixtures-test-t", 0)])
        done, result = self.run_recipe("helper-window.sh", "t")
        self.assertEqual(done.returncode, 0)

    def live(self, **env):
        env_file = os.path.join(self.root, "synthetic.env")
        with open(env_file, "w") as fh:
            fh.write("TYPESAFE_API_KEY=synthetic-not-a-credential\n")
        return self.run_recipe("live-tasks.sh", "t", "0.10", env=dict({"CARET_ENV_FILE": env_file}, **env))

    def test_live_stops_the_eval_at_the_first_wrong_value(self):
        started = time.monotonic()
        done, result = self.live(STUB_WRONG="live-tasks-blind")
        self.assertLess(time.monotonic() - started, 30)  # the stub would hang 120 s
        self.assertEqual(done.returncode, 10, done.stdout + done.stderr)
        self.assertIn("wrong value seen, stopping pid", done.stdout)
        self.assertEqual(self.steps(result)[1:], [("page-loop", "live-tasks-blind-t", 10),
                                                  ("spend", datetime.date.today().isoformat(), 0)])

    def test_live_spend_over_the_limit_fails(self):
        done, result = self.live(STUB_SPEND="0.15")
        self.assertEqual(done.returncode, 13, done.stdout + done.stderr)
        done, result = self.live()
        self.assertEqual(done.returncode, 0)

    def test_live_without_a_key_path_refuses(self):
        done, _ = self.run_recipe("live-tasks.sh", "t", "0.10")
        self.assertEqual(done.returncode, 64)

    def r2(self, **env):
        job = os.path.join(self.root, "vm")
        shutil.rmtree(job, ignore_errors=True)
        os.makedirs(os.path.join(job, "payload/tools"))
        with open(os.path.join(job, "job.sh"), "w") as fh:
            fh.write("#!/bin/bash\n")
        options = {"pages": ["wizard-1"], "sources": "note", "nextPage": False, "scenarios": ["page_task"]}
        with open(os.path.join(job, "payload/REV"), "w") as fh:
            fh.write(REV + "\n")
        with open(os.path.join(job, "payload/h11-options.json"), "w") as fh:
            json.dump(options, fh)
        rig = os.path.join(self.home, ".long-run/rig/bin")
        os.makedirs(rig, exist_ok=True)
        shutil.copy2(os.path.join(STUBS, "rig-run"), os.path.join(rig, "rig-run"))
        env_file = os.path.join(self.root, "synthetic.env")
        with open(env_file, "w") as fh:
            fh.write("TYPESAFE_API_KEY=synthetic-key-not-a-credential-0123\n")
        done, result = self.run_recipe("r2/vm.sh", "h11", job, "30", "0.2000", "0.0500", "off", env=dict({
            "CARET_ENV_FILE": env_file, "CARET_HEAVY_TEST_LUME": os.path.join(STUBS, "lume"),
            "H11_OPTIONS": json.dumps(options, sort_keys=True, separators=(",", ":"))}, **env))
        return done, result, job

    def test_r2_vm_writes_spend_control_runs_the_feeder_and_checks_the_run(self):
        done, result, job = self.r2()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.steps(result), [("prepare", "spend-control", 0), ("r2", "h11", 0)])
        with open(os.path.join(self.out, "spend-control.json")) as fh:
            control = json.load(fh)
        for key, want in (("capUsd", 0.2), ("remainingUsd", 0.15), ("priorR2SpendUsd", 0.05), ("seedUsd", 0.05)):
            self.assertAlmostEqual(control[key], want)
        self.assertFalse(os.path.exists(os.path.join(job, "payload/spend-control.json")))
        [run] = os.listdir(os.path.join(job, "runs"))
        with open(os.path.join(job, "runs", run, "cap-seen.txt")) as fh:
            self.assertEqual(float(fh.read()), 0.2)
        with open(os.path.join(job, "payload/CONFIG")) as fh:
            self.assertEqual(fh.read().strip(), "off")
        self.assertTrue(os.path.exists(os.path.join(self.out, "rig-run/out/results.json")))

    def test_r2_vm_codes(self):
        for env, code in (({"STUB_WRONG_ROW": "yes"}, 10), ({"STUB_RESULT_REV": "d" * 40}, 12), ({"STUB_RIG_EXIT": "70"}, 11)):
            with self.subTest(env):
                done, result, _ = self.r2(**env)
                self.assertEqual(done.returncode, code, done.stdout + done.stderr)

    def test_r2_vm_key_found_in_the_copied_back_run_fails_and_is_deleted(self):
        env_file = os.path.join(self.root, "synthetic.env")
        done, result, job = self.r2(STUB_LEAK_KEY_FROM=env_file)
        self.assertEqual(done.returncode, 99, done.stdout + done.stderr)
        [run] = os.listdir(os.path.join(job, "runs"))
        self.assertFalse(os.path.exists(os.path.join(job, "runs", run, "out/job.log")))
        self.assertTrue(os.path.exists(os.path.join(job, "runs", run, "KEY-LEAK.txt")))
        self.assertNotIn("synthetic-key-not-a-credential-0123", done.stdout + done.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
