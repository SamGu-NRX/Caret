"""The recipe scripts' own control flow, run directly with stub tools (tests/stubs) in place of pnpm, node, npx,
rig-run and Lume, and a temporary sealed-inputs directory like the one enqueue makes. Checks the exit codes, the
required steps and expected pages, stopping at the first wrong value, the live watcher, the spend check, R2's feeder
with its spend control, exact run directory and leak scan (also on cancellation), and R2's fresh export. The real tools
run only in real heavy jobs; build.sh and stage.sh past the export are not covered here."""

import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

HEAVY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STUBS = os.path.join(HEAVY, "tests/stubs")
RECIPES = os.path.join(HEAVY, "recipes")
PY = "/opt/homebrew/opt/python@3.14/bin/python3.14"
REV = "c" * 40
KEY = "synthetic-key-not-a-credential-0123"


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)


class RecipeWorld(unittest.TestCase):
    """A temporary worktree, sealed-inputs directory and HOME, and running one recipe in them."""

    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="caret-heavy-recipes-"))
        self.addCleanup(lambda: (subprocess.run(["chmod", "-R", "u+w", self.root]), shutil.rmtree(self.root, True)))
        self.home = os.path.join(self.root, "home")
        self.worktree = os.path.join(self.root, "worktree")
        self.inputs = os.path.join(self.root, "inputs")
        for d in ("helper", "extension", "fixtures/web-form/tasks/expect", "bridge/.build/release"):
            os.makedirs(os.path.join(self.worktree, d))
        for page in ("wizard-1", "reveal"):
            write(os.path.join(self.worktree, "fixtures/web-form/tasks/expect", page + ".json"), "{}")
        write(os.path.join(self.worktree, "fixtures/web-form/page-loop-eval.ts"), '// "w4-owners"\n')
        write(os.path.join(self.worktree, "fixtures/realfill/corpus.json"),
              json.dumps({"forms": [{"id": "httpbin-pizza"}, {"id": "clinic-intake"}]}))
        # The sealed inputs, as enqueue clones them.
        write(os.path.join(self.inputs, "bridge/caret-bridge"), "bridge\n")
        write(os.path.join(self.inputs, "bridge/caret-bridge-testhost"), "testhost\n")
        write(os.path.join(self.inputs, "browsers/chrome/Chrome"), "chrome\n")
        for site in ("greenhouse-discord", "ashby-ramp-application"):
            write(os.path.join(self.inputs, "w4/real", site + ".html"), "<form></form>")
        for name in ("key.json", "note.txt", "owners.json"):
            write(os.path.join(self.inputs, "w4/replay", name), "{}")
        write(os.path.join(self.inputs, "heldout/manifest.json"), json.dumps([{"name": "heldout-zh"}, {"name": "heldout-ar"}]))
        os.makedirs(self.home)
        self.out = os.path.join(self.root, "out")
        self.env_file = os.path.join(self.root, "synthetic.env")
        write(self.env_file, "TYPESAFE_API_KEY={}\n".format(KEY))

    def env(self, script, extra=None):
        base = {"PATH": STUBS + ":/usr/bin:/bin", "HOME": self.home, "CARET_HEAVY_RECIPES": RECIPES,
                "CARET_HEAVY_PY": PY, "CARET_HEAVY_OUT": self.out, "CARET_HEAVY_JOB_ID": "caret-recipe-test",
                "CARET_HEAVY_PLAN_SHA256": "e" * 64, "CARET_HEAVY_RECIPE": os.path.basename(script)[:-3],
                "CARET_HEAVY_REV": REV, "CARET_HEAVY_INPUTS": self.inputs}
        return dict(base, **(extra or {}))

    def run_recipe(self, script, *args, env=None):
        shutil.rmtree(self.out, ignore_errors=True)
        os.makedirs(self.out)
        done = subprocess.run(["/bin/bash", os.path.join(RECIPES, script), *args], cwd=self.worktree,
                              env=self.env(script, env), capture_output=True, text=True, timeout=120)
        return done, self.result()

    def result(self):
        try:
            with open(os.path.join(self.out, "result.json")) as fh:
                return json.load(fh)
        except FileNotFoundError:
            return None

    def steps(self, result):
        return [(s["kind"], s["name"], s["code"]) for s in result["steps"]]


class Recipes(RecipeWorld):

    # Browser and helper recipes

    def test_canned_sets_pass_with_every_expected_page_and_sealed_binaries(self):
        with open(os.path.join(self.worktree, "bridge/.build/release/caret-bridge"), "w") as fh:
            fh.write("stale build\n")
        done, result = self.run_recipe("canned-sets.sh", "t")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual([s[2] for s in self.steps(result)], [0] * 7)
        with open(os.path.join(self.worktree, "bridge/.build/release/caret-bridge")) as fh:
            self.assertEqual(fh.read(), "bridge\n")  # replaced by the sealed copy
        with open(os.path.join(self.out, "ids-corpus.txt")) as fh:
            self.assertEqual(fh.read().split(), ["ashby-ramp-application", "clinic-intake", "greenhouse-discord",
                                                 "httpbin-pizza"])

    def test_canned_sets_stop_at_the_first_wrong_value(self):
        done, result = self.run_recipe("canned-sets.sh", "t", env={"STUB_WRONG": "tasks-labelled"})
        self.assertEqual(done.returncode, 10, done.stdout + done.stderr)
        self.assertEqual(self.steps(result)[-2:], [("page-loop", "tasks-labelled-t", 10),
                                                   ("required", "corpus-goal-t", 0)])
        self.assertTrue(result["steps"][-1]["skipped"])
        self.assertFalse(os.path.exists(os.path.join(self.out, "corpus-goal-t")))

    def test_a_missing_page_or_a_page_error_fails_the_set(self):
        os.unlink(os.path.join(self.inputs, "w4/real/ashby-ramp-application.html"))
        write(os.path.join(self.worktree, "fixtures/realfill/corpus.json"),
              json.dumps({"forms": [{"id": "httpbin-pizza"}, {"id": "clinic-intake"}, {"id": "never-run"}]}))
        os.chmod(os.path.join(STUBS, "node"), 0o755)
        # The stub runs the corpus.json it finds, so make it drop never-run as a broken eval would.
        done, result = self.run_recipe("canned-sets.sh", "t", env={"STUB_ROW_ERROR": "tasks-blind"})
        self.assertEqual(done.returncode, 11, done.stdout + done.stderr)
        self.assertEqual(self.steps(result)[4], ("page-loop", "tasks-blind-t", 11))

    def test_a_checker_that_crashes_mid_recipe_fails_the_recipe(self):
        recipes = os.path.join(self.root, "recipes")
        shutil.copytree(RECIPES, recipes)
        real = os.path.join(recipes, "check_real.py")
        os.rename(os.path.join(recipes, "check.py"), real)
        with open(os.path.join(recipes, "check.py"), "w") as fh:
            fh.write("import runpy, sys\n"
                     "if sys.argv[1:3] == ['page-loop', 'tasks-labelled-t']: raise SystemExit(1)\n"
                     "sys.argv[0] = {!r}; runpy.run_path({!r}, run_name='__main__')\n".format(real, real))
        done, result = self.run_recipe("canned-sets.sh", "t", env={"CARET_HEAVY_RECIPES": recipes})
        self.assertEqual(done.returncode, 12, done.stdout + done.stderr)
        self.assertEqual(result["exit"], 12)

    def test_a_failed_offline_install_stops_before_any_set(self):
        done, result = self.run_recipe("canned-sets.sh", "t", env={"STUB_INSTALL_EXIT": "1"})
        self.assertEqual(done.returncode, 14)
        self.assertEqual(self.steps(result)[0], ("prepare", "dependencies", 14))
        self.assertTrue(all(s[0] == "required" and r["skipped"] for s, r in zip(self.steps(result)[1:], result["steps"][1:])))

    def test_helper_window_runs_every_suite_and_fails_on_one(self):
        done, result = self.run_recipe("helper-window.sh", "t", env={"STUB_FAIL_SUITE": "extension"})
        self.assertEqual(done.returncode, 11, done.stdout + done.stderr)
        self.assertEqual(self.steps(result), [("prepare", "dependencies", 0), ("suite", "helper-t", 0),
                                              ("suite", "extension-t", 11), ("suite", "fixtures-tsc-t", 0),
                                              ("suite", "fixtures-test-t", 0)])
        done, result = self.run_recipe("helper-window.sh", "t")
        self.assertEqual(done.returncode, 0)

    def live(self, *extra, **env):
        return self.run_recipe("live-tasks.sh", "t", "0.10", *extra, env=dict({"CARET_ENV_FILE": self.env_file}, **env))

    def test_live_stops_the_eval_at_the_first_wrong_value(self):
        started = time.monotonic()
        done, result = self.live(STUB_WRONG="live-tasks-blind")
        self.assertLess(time.monotonic() - started, 30)  # the stub would hang 120 s
        self.assertEqual(done.returncode, 10, done.stdout + done.stderr)
        self.assertIn("wrong value seen, stopping pid", done.stdout)
        self.assertEqual(self.steps(result)[-2:], [("page-loop", "live-tasks-blind-t", 10), ("spend", "spend", 0)])

    def test_live_spend_over_the_limit_fails(self):
        done, result = self.live(STUB_SPEND="0.15")
        self.assertEqual(done.returncode, 13, done.stdout + done.stderr)
        done, result = self.live()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def test_live_heldout_runs_the_sealed_pages(self):
        done, result = self.live("heldout")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        with open(os.path.join(self.out, "heldout-t/page-loop.json")) as fh:
            self.assertEqual(sorted(r["id"] for r in json.load(fh)["rows"]), ["heldout-ar", "heldout-zh"])

    def test_live_without_a_key_path_refuses(self):
        done, _ = self.run_recipe("live-tasks.sh", "t", "0.10")
        self.assertEqual(done.returncode, 64)

    # Laya

    def laya_inputs(self):
        q = [{"shaped": {"laya": {"state": 1}, "typed-decisions": {"state": 1}, "multilingual": {"misfit": True}}},
             {"shaped": {"laya": {"state": 1}, "typed-decisions": {"misfit": True}, "multilingual": {"state": 1}}}]
        write(os.path.join(self.inputs, "laya-data/questions.jsonl"), "".join(json.dumps(x) + "\n" for x in q))
        stub = os.path.join(self.inputs, "laya-python/bin/python3.12")
        write(stub, """#!/opt/homebrew/opt/python@3.14/bin/python3.14 -I
import json, os, sys
args = [a for a in sys.argv[1:] if a not in ("-S", "-B", "-X", "pycache_prefix=/var/empty")]
out = os.environ["CARET_HEAVY_OUT"]
assert os.environ["PYTHONPATH"].startswith(os.environ["CARET_HEAVY_INPUTS"] + "/laya-mlx:"), os.environ["PYTHONPATH"]
if args[0].endswith("laya_run.py"):
    ck = args[args.index("--ckpt") + 1]
    if os.environ.get("STUB_LAYA_FAIL") == ck:
        sys.exit(1)
    n = sum(1 for l in open(os.environ["CARET_HEAVY_INPUTS"] + "/laya-data/questions.jsonl")
            if "misfit" not in json.loads(l)["shaped"].get(ck, {"misfit": 1}))
    n -= os.environ.get("STUB_LAYA_SHORT") == ck
    os.makedirs(out + "/runs", exist_ok=True)
    with open(out + "/runs/" + ck + ".jsonl", "w") as fh:
        fh.writelines(json.dumps({"A": {}, "B": {}}) + "\\n" for _ in range(n))
    for s in ("-sanity.json", "-latency.json"):
        open(out + "/runs/" + ck + s, "w").write("{}")
else:
    assert os.environ["CARET_HELPER_SRC"].endswith("/helper/src")
    json.dump(dict({"jev": {}}, **{c: {"zeroShot": {}} for c in args[1:]}), open(out + "/score.json", "w"))
""")
        os.chmod(stub, 0o755)

    def test_laya_runs_every_checkpoint_on_the_sealed_interpreter_then_scores(self):
        self.laya_inputs()
        done, result = self.run_recipe("laya.sh")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.steps(result), [("prepare", "dependencies", 0), ("laya", "laya", 0),
                                              ("laya", "typed-decisions", 0), ("laya", "multilingual", 0),
                                              ("laya-score", "score", 0)])

    def test_laya_fails_on_a_crashed_or_short_checkpoint(self):
        self.laya_inputs()
        done, result = self.run_recipe("laya.sh", env={"STUB_LAYA_FAIL": "multilingual"})
        self.assertEqual(done.returncode, 11, done.stdout)
        done, result = self.run_recipe("laya.sh", env={"STUB_LAYA_SHORT": "laya"})
        self.assertEqual(done.returncode, 12, done.stdout)
        self.assertIn("1 records, expected 2", json.dumps(result["steps"]))

    # R2

    def vm_inputs(self):
        job = os.path.join(self.inputs, "vm-job")
        os.makedirs(os.path.join(job, "payload/tools"))
        os.makedirs(os.path.join(job, "runs"))
        write(os.path.join(job, "job.sh"), "#!/bin/bash\n")
        write(os.path.join(job, "payload/REV"), REV + "\n")
        self.options = {"pages": ["wizard-1"], "sources": "note", "nextPage": False, "scenarios": ["page_task"]}
        write(os.path.join(job, "payload/h11-options.json"), json.dumps(self.options))
        os.chmod(os.path.join(job, "payload"), 0o555)  # sealed, as enqueue leaves it
        rig = os.path.join(self.home, ".long-run/rig/bin")
        os.makedirs(rig, exist_ok=True)
        shutil.copy2(os.path.join(STUBS, "rig-run"), os.path.join(rig, "rig-run"))
        return job

    def vm_env(self, **extra):
        return dict({"CARET_ENV_FILE": self.env_file, "CARET_HEAVY_TEST_LUME": os.path.join(STUBS, "lume"),
                     "H11_OPTIONS": json.dumps(self.options, sort_keys=True, separators=(",", ":"))}, **extra)

    def r2(self, **env):
        job = self.vm_inputs()
        done, result = self.run_recipe("r2/vm.sh", "h11", "30", "0.2000", "0.0500", "off", env=self.vm_env(**env))
        return done, result, job

    def test_r2_vm_writes_spend_control_runs_the_feeder_and_checks_the_run(self):
        done, result, job = self.r2()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.steps(result), [("prepare", "spend-control", 0), ("r2", "h11", 0)])
        with open(os.path.join(self.out, "spend-control.json")) as fh:
            control = json.load(fh)
        for key, want in (("capUsd", 0.2), ("remainingUsd", 0.15), ("priorR2SpendUsd", 0.05), ("seedUsd", 0.05)):
            self.assertAlmostEqual(control[key], want)
        [run] = os.listdir(os.path.join(job, "runs"))
        with open(os.path.join(job, "runs", run, "cap-seen.txt")) as fh:
            self.assertEqual(float(fh.read()), 0.2)
        with open(os.path.join(job, "payload/CONFIG")) as fh:
            self.assertEqual(fh.read().strip(), "off")
        with open(os.path.join(self.out, "rig-run-dir")) as fh:
            self.assertEqual(fh.read().strip(), os.path.join(job, "runs", run))
        self.assertTrue(os.path.exists(os.path.join(self.out, "rig-run/out/results.json")))

    def test_r2_vm_takes_rig_runs_own_run_directory_not_an_older_one_with_its_pid(self):
        job = self.vm_inputs()
        # A stale run directory for every pid this test could see, as an earlier rig-run with a reused pid leaves.
        old = os.path.join(job, "runs", "20260101T000000Z-stale")
        write(os.path.join(old, "out/results.json"), "{}")
        done, result = self.run_recipe("r2/vm.sh", "h11", "30", "0.2000", "0.0000", "off", env=self.vm_env())
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        with open(os.path.join(self.out, "rig-run-dir")) as fh:
            self.assertNotEqual(fh.read().strip(), old)

    def test_r2_vm_codes(self):
        for env, code in (({"STUB_WRONG_ROW": "yes"}, 10), ({"STUB_RESULT_REV": "d" * 40}, 12), ({"STUB_RIG_EXIT": "70"}, 11)):
            with self.subTest(env):
                if os.path.exists(os.path.join(self.inputs, "vm-job")):
                    subprocess.run(["chmod", "-R", "u+w", self.inputs])
                    shutil.rmtree(os.path.join(self.inputs, "vm-job"))
                done, result, _ = self.r2(**env)
                self.assertEqual(done.returncode, code, done.stdout + done.stderr)

    def test_r2_vm_runs_rae_and_publishes_its_scoreboard(self):
        job = self.vm_inputs()
        subprocess.run(["chmod", "u+w", os.path.join(job, "payload")], check=True)
        os.unlink(os.path.join(job, "payload/h11-options.json"))
        rae = {"mode": "probe", "targets": ["contacts-me", "mail-compose"]}
        write(os.path.join(job, "payload/rae-options.json"), json.dumps(rae))
        os.chmod(os.path.join(job, "payload"), 0o555)
        env = dict(self.vm_env(), RAE_OPTIONS=json.dumps(rae, sort_keys=True, separators=(",", ":")))
        del env["H11_OPTIONS"]
        done, result = self.run_recipe("r2/vm.sh", "rae", "30", "0.2000", "0.0000", "-", env=env)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.steps(result), [("prepare", "spend-control", 0), ("r2", "rae", 0)])
        for name in ("results.json", "scoreboard.md", "rows.json", "leak-check.txt"):
            self.assertTrue(os.path.exists(os.path.join(self.out, "rig-run/out", name)), name)
        self.assertFalse(os.path.exists(os.path.join(job, "payload/CONFIG")))

    def assert_key_nowhere(self):
        hits = []
        for root, _, names in os.walk(self.root):
            for name in names:
                path = os.path.join(root, name)
                if path != self.env_file and not os.path.islink(path):
                    with open(path, "rb") as fh:
                        if KEY.encode() in fh.read():
                            hits.append(path)
        self.assertEqual(hits, [])

    def test_r2_vm_key_found_in_the_copied_back_run_fails_and_is_deleted(self):
        done, result, job = self.r2(STUB_LEAK_KEY_FROM=self.env_file)
        self.assertEqual(done.returncode, 99, done.stdout + done.stderr)
        [run] = os.listdir(os.path.join(job, "runs"))
        self.assertTrue(os.path.exists(os.path.join(job, "runs", run, "KEY-LEAK.txt")))
        self.assert_key_nowhere()
        self.assertFalse(os.path.exists(os.path.join(self.out, "rig-run/out/results.json")))  # nothing published

    def test_cancelling_r2_vm_still_runs_the_leak_scan_and_publishes_nothing_unscanned(self):
        job = self.vm_inputs()
        os.makedirs(self.out, exist_ok=True)
        shutil.rmtree(self.out)
        os.makedirs(self.out)
        proc = subprocess.Popen(["/bin/bash", os.path.join(RECIPES, "r2/vm.sh"), "h11", "30", "0.2000", "0.0000", "off"],
                                cwd=self.worktree, env=self.env("r2/vm.sh", self.vm_env(STUB_HANG="1",
                                STUB_LEAK_KEY_FROM=self.env_file)), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        deadline = time.monotonic() + 30
        while not os.path.exists(os.path.join(self.inputs, "rig-started")) and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertTrue(os.path.exists(os.path.join(self.inputs, "rig-started")))
        os.killpg(proc.pid, signal.SIGTERM)  # the recipe's own group, started by this test: rig-run, feeder, vm.sh
        out, _ = proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, 99, out)  # the scan ran and found the key the stopped rig-run left
        self.assertIn("KEY LEAK on the host", out)
        self.assert_key_nowhere()
        self.assertFalse(os.path.exists(os.path.join(self.out, "rig-run/out/job.log")))

    def test_r2_export_is_fresh_every_time(self):
        repo = os.path.join(self.root, "repo")
        os.makedirs(repo)
        git = lambda *a: subprocess.run(["git", "-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid",
                                         "-c", "commit.gpgsign=false", *a], capture_output=True, text=True, check=True)
        git("init", "-q")
        write(os.path.join(repo, "app.txt"), "v1\n")
        git("add", "app.txt")
        git("commit", "-q", "-m", "one")
        rev = git("rev-parse", "HEAD").stdout.strip()
        dest = os.path.join(self.root, "work/src")
        write(os.path.join(dest, ".REV"), rev + "\n")  # an export of the same commit, with a file no commit has
        write(os.path.join(dest, "planted.txt"), "left by an earlier build\n")
        done = subprocess.run(["/bin/bash", os.path.join(RECIPES, "r2/export.sh"), repo, rev, dest],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(sorted(os.listdir(dest)), [".REV", "app.txt"])
        for harness in ("h11", "h14"):
            with open(os.path.join(RECIPES, "r2", harness, "build.sh")) as fh:
                text = fh.read()
            self.assertNotIn('.REV" 2>/dev/null)" != ', text)  # no reuse of an export by its .REV
            self.assertIn("export.sh", text)


class SwiftWorld(RecipeWorld):
    """A worktree with the three Swift packages committed, sealed keytype inputs, and swift-tests.sh run in it."""

    def setUp(self):
        super().setUp()
        for pkg in ("apps/caret", "apps/screen-reader", "bridge"):
            write(os.path.join(self.worktree, pkg, "Package.swift"), "// {}\n".format(pkg))
        write(os.path.join(self.worktree, "apps/caret/Tests/__Snapshots__/T/old.png"), "old\n")  # a committed reference
        subprocess.run(["git", "-C", self.worktree, "init", "-q"], check=True)
        subprocess.run(["git", "-C", self.worktree, "add", "-A"], check=True)
        subprocess.run(["git", "-C", self.worktree, "-c", "user.name=t", "-c", "user.email=t@example.invalid",
                        "-c", "commit.gpgsign=false", "commit", "-q", "-m", "pin"], check=True)
        self.rev = subprocess.run(["git", "-C", self.worktree, "rev-parse", "HEAD"], capture_output=True, text=True,
                                  check=True).stdout.strip()
        write(os.path.join(self.inputs, "keytype/Packages/A/Package.swift"), "// keytype at the gitlink\n")
        write(os.path.join(self.inputs, "llama.xcframework/Info.plist"), "plist\n")
        os.makedirs(os.path.join(self.inputs, "keytype/Packages/ModelRuntime"))  # as in the real archive, no Vendor/
        # Read-only, as enqueue seals a job's inputs (caret_heavy._read_only); caret-swift-s2-70a6845-n1 failed here.
        import sys
        sys.path.insert(0, HEAVY)
        import caret_heavy
        caret_heavy._read_only(self.inputs)
        self.tmp = os.path.join(self.root, "tmp")
        os.makedirs(self.tmp)

    def swift(self, extra=None):
        env = dict({"CARET_HEAVY_REV": self.rev, "TMPDIR": self.tmp}, **(extra or {}))
        done, result = self.run_recipe("swift-tests.sh", "t", "apps/caret", "apps/screen-reader", "bridge", env=env)
        with open(os.path.join(self.out, "swift-calls.txt")) as fh:
            calls = fh.read().splitlines()
        self.assertEqual(os.listdir(self.tmp), [])  # the export and the builds are gone, whatever happened
        return done, result, calls


class SwiftTests(SwiftWorld):
    """swift-tests.sh: `swift test` in each package of a fresh export of the pinned commit, with keytype and
    llama.xcframework from the sealed inputs; every package runs; 11 on a test failure, 14 on a build error."""

    def test_every_package_passes(self):
        done, result, calls = self.swift()
        self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
        self.assertEqual(self.steps(result), [("prepare", "export", 0), ("prepare", "inputs", 0),
                                              ("suite", "swift-apps-caret-t", 0), ("suite", "swift-apps-screen-reader-t", 0),
                                              ("suite", "swift-bridge-t", 0)])
        self.assertEqual(len(calls), 3)
        self.assertTrue(calls[0].split()[0].endswith("/src/apps/caret") and "keytype=yes" in calls[0], calls[0])
        for call in calls:
            self.assertIn("test --disable-automatic-resolution --scratch-path", call)
        for pkg in ("apps-caret", "apps-screen-reader", "bridge"):
            with open(os.path.join(self.out, "swift-{}-t.summary.json".format(pkg))) as fh:
                self.assertEqual(json.load(fh)["passed"], 7)
        with open(os.path.join(self.out, "swift-times.ndjson")) as fh:
            self.assertEqual([json.loads(line)["package"] for line in fh], ["apps/caret", "apps/screen-reader", "bridge"])

    def test_a_test_failure_is_11_and_every_package_still_runs(self):
        done, result, calls = self.swift({"STUB_SWIFT_FAIL": "screen-reader"})
        self.assertEqual(done.returncode, 11)
        self.assertEqual(len(calls), 3)

    def test_the_inputs_come_from_read_only_sealed_copies_and_are_checked_against_them(self):
        done, result, calls = self.swift()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("keytype=yes", calls[0])
        # The sealed inputs stay read-only; only the job's own work copy was written.
        self.assertFalse(os.access(os.path.join(self.inputs, "keytype/Packages/ModelRuntime"), os.W_OK))
        with open(os.path.join(self.out, "inputs.log")) as fh:
            self.assertIn("matches the sealed copy", fh.read())

    def test_a_build_error_is_14(self):
        done, result, calls = self.swift({"STUB_SWIFT_BUILD_ERROR": "bridge"})
        self.assertEqual(done.returncode, 14)
        self.assertIn(("suite", "swift-bridge-t", 14), self.steps(result))


class SwiftRecordMode(SwiftWorld):
    """CARET_RECORD_SNAPSHOTS=1: every image file the run adds or changes in the export is copied to OUT/snapshots at
    its path in the repository, with OUT/snapshots/manifest.json giving each one's sha256 and whether it was added or
    modified; any other file the run adds or changes there is listed (not copied). Without it, nothing is copied."""

    def manifest(self):
        with open(os.path.join(self.out, "snapshots", "manifest.json")) as fh:
            return json.load(fh)

    def test_recorded_images_are_copied_out_with_their_sha256(self):
        import hashlib
        done, result, calls = self.swift({"CARET_RECORD_SNAPSHOTS": "1"})
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        m = self.manifest()
        images = {i["path"]: i for i in m["images"]}
        expected = {"apps/caret/Tests/__Snapshots__/T/new.1.png": "added",
                    "apps/caret/Tests/__Snapshots__/T/old.png": "modified",
                    "apps/screen-reader/Tests/__Snapshots__/T/new.1.png": "added",
                    "bridge/Tests/__Snapshots__/T/new.1.png": "added"}
        self.assertEqual({p: i["change"] for p, i in images.items()}, expected)
        for path, item in images.items():
            with open(os.path.join(self.out, "snapshots", path), "rb") as fh:
                self.assertEqual(hashlib.sha256(fh.read()).hexdigest(), item["sha256"])
        with open(os.path.join(self.out, "snapshots/apps/caret/Tests/__Snapshots__/T/old.png")) as fh:
            self.assertEqual(fh.read(), "recorded\n")
        self.assertEqual(sorted(o["path"] for o in m["other_changes"]),
                         ["apps/caret/.swiftpm/state.txt", "apps/screen-reader/.swiftpm/state.txt",
                          "bridge/.swiftpm/state.txt"])
        self.assertFalse(os.path.exists(os.path.join(self.out, "snapshots/bridge/.swiftpm")))
        self.assertIn(("prepare", "snapshots", 0), self.steps(result))
        self.assertEqual(m["rev"], self.rev)

    def test_without_record_mode_nothing_is_copied(self):
        done, result, calls = self.swift()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.out, "snapshots")))


class VmCancelProof(RecipeWorld):
    """vm-cancel-proof.sh with a stub rig-run (tests/stubs/vm-proof/rig-run): it starts rig-run on the sealed job, waits
    for the guest, cancels rig-run itself, and proves the clone, Lume and Virtualization are gone and where the vm lease
    went. 14 when no guest ever boots, 11 when a proof fails."""

    def setUp(self):
        super().setUp()
        write(os.path.join(self.inputs, "vm-job/job.sh"), "# rig-timeout-seconds: 120\nexit 0\n")
        os.makedirs(os.path.join(self.inputs, "vm-job/runs"))
        rig = os.path.join(self.home, ".long-run/rig/bin")
        os.makedirs(rig)
        shutil.copy2(os.path.join(STUBS, "vm-proof/rig-run"), os.path.join(rig, "rig-run"))
        self.leases = os.path.join(self.home, "leases.ndjson")
        lr = os.path.join(self.home, ".long-run/bin/lr-lease")
        write(lr, "#!/bin/sh\n[ \"$1\" = status ] || exit 2\nf=\"$HOME/leases.ndjson\"\necho 'Readings (stub)'\n"
                  "if [ -s \"$f\" ]; then echo \"Leases: $(wc -l < \"$f\" | tr -d ' ')\"; cat \"$f\"; else echo 'Leases: 0'; fi\n")
        os.chmod(lr, 0o755)
        self.addCleanup(self.kill_stand_in)

    def kill_stand_in(self):
        path = os.path.join(self.inputs, "stub-vz.pid")
        if os.path.exists(path):
            with open(path) as fh:
                pid = int(fh.read())
            if "sleep" in subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout:
                os.kill(pid, signal.SIGKILL)  # the stub's stand-in, by its exact recorded pid

    def proof(self, extra=None):
        done, result = self.run_recipe("vm-cancel-proof.sh", "60", "30", "3", env=extra)
        try:
            with open(os.path.join(self.out, "proof.json")) as fh:
                proof = json.load(fh)
        except FileNotFoundError:
            proof = None
        return done, result, proof

    def test_a_clean_cancellation_proves_everything_gone(self):
        done, result, proof = self.proof()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.steps(result), [("prepare", "boot", 0), ("prepare", "cancel", 0), ("vm-proof", "proof", 0)])
        self.assertEqual(proof["checks"], {"rig_run_cancelled": True, "clone_gone": True, "lume_gone": True,
                                           "virtualization_gone": True, "vm_lease_released": True})
        self.assertTrue(os.path.exists(os.path.join(self.out, "state-before/lume.pid")))

    def test_a_virtualization_process_that_outlives_the_cleanup_fails_the_proof(self):
        done, result, proof = self.proof({"STUB_VM": "linger"})
        self.assertEqual(done.returncode, 11)
        self.assertFalse(proof["checks"]["virtualization_gone"])

    def test_a_clone_left_behind_fails_the_proof(self):
        done, result, proof = self.proof({"STUB_VM": "clone"})
        self.assertEqual(done.returncode, 11)
        self.assertFalse(proof["checks"]["clone_gone"])

    def test_no_guest_is_14(self):
        done, result, proof = self.proof({"STUB_VM": "no-boot"})
        self.assertEqual(done.returncode, 14)
        self.assertEqual(self.steps(result)[0], ("prepare", "boot", 14))

    def test_in_managed_mode_the_vm_lease_must_be_left_cleanup_required_for_the_attempt(self):
        managed = {"RIG_RUN_MANAGED": "1", "CARET_HEAVY_ATTEMPT": "att-1"}
        done, result, proof = self.proof(dict(managed, STUB_LEASE_FILE=self.leases))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertTrue(proof["checks"]["vm_lease_left_for_custody"])
        self.assertNotIn("vm_lease_released", proof["checks"])
        os.unlink(self.leases)
        done, result, proof = self.proof(managed)  # the lease is not listed: not left for custody
        self.assertEqual(done.returncode, 11)
        self.assertFalse(proof["checks"]["vm_lease_left_for_custody"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
