"""Strict isolated tests of the parts with one correct answer: the content manifest, the recipe
checker's exit codes, the evidence adapter, the profiles and the queue command enqueue builds.
No queue runner, no lease, no recipe process."""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HEAVY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HEAVY)
sys.path.insert(0, os.path.join(HEAVY, "recipes"))

import caret_heavy  # noqa: E402
import check  # noqa: E402
import manifest  # noqa: E402
import results  # noqa: E402
from support import git  # noqa: E402


class Temp(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="caret-heavy-unit-"))
        self.addCleanup(shutil.rmtree, self.root, True)

    def write(self, rel, text="x\n", mode=0o644):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write(text)
        os.chmod(path, mode)
        return path


class ManifestTest(Temp):
    def test_tree_digest_covers_content_mode_links_and_new_files(self):
        self.write("t/a.txt", "one\n")
        self.write("t/sub/b.bin", "two\n")
        os.symlink("a.txt", os.path.join(self.root, "t/link"))
        tree = os.path.join(self.root, "t")
        base = manifest.record("t", "tree", tree)
        self.assertEqual(manifest.check([base]), [])
        self.assertEqual((base["files"], base["bytes"]), (2, 8))
        changes = [
            lambda: self.write("t/a.txt", "ONE\n"),
            lambda: os.chmod(os.path.join(tree, "sub/b.bin"), 0o755),
            lambda: (os.unlink(os.path.join(tree, "link")), os.symlink("sub/b.bin", os.path.join(tree, "link"))),
            lambda: self.write("t/sub/new.txt", ""),
        ]
        for change in changes:
            with self.subTest(change=change):
                entry = manifest.record("t", "tree", tree)
                change()
                problems = manifest.check([entry])
                self.assertEqual(len(problems), 1)
                self.assertIn("tree t changed since enqueue", problems[0])

    def test_tree_digest_records_directories_even_empty_ones(self):
        self.write("t/a.txt", "one\n")
        tree = os.path.join(self.root, "t")
        entry = manifest.record("t", "tree", tree)
        os.makedirs(os.path.join(tree, "new-empty-dir"))
        self.assertEqual(len(manifest.check([entry])), 1)

    def test_symlinks_must_resolve_inside_the_tree(self):
        self.write("t/a.txt", "one\n")
        self.write("outside.txt", "secret\n")
        tree = os.path.join(self.root, "t")
        os.makedirs(os.path.join(tree, "sub"))
        os.symlink("../a.txt", os.path.join(tree, "sub/inside"))
        manifest.record("t", "tree", tree)  # an in-tree link is fine
        for name, target in (("escape", "../outside.txt"), ("absolute", os.path.join(self.root, "outside.txt")),
                             ("dangling", "missing.txt"), ("dir-escape", "..")):
            with self.subTest(name):
                link = os.path.join(tree, name)
                os.symlink(target, link)
                with self.assertRaisesRegex(manifest.ManifestError, "symlink"):
                    manifest.record("t", "tree", tree)
                os.unlink(link)

    def test_no_bytecode_is_read_from_beside_a_module(self):
        """An unchecked-hash .pyc beside a module runs instead of its source, unless pycache_prefix points elsewhere."""
        import py_compile
        mod = self.write("m/mod.py", "print('source')\n")
        evil = self.write("evil.py", "print('bytecode from outside the manifest')\n")
        pyc = os.path.join(self.root, "m/__pycache__/mod.{}.pyc".format(sys.implementation.cache_tag))
        py_compile.compile(evil, cfile=pyc, invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
        code = "import sys; sys.path.insert(0, {!r}); import mod".format(os.path.dirname(mod))
        plain = subprocess.run([caret_heavy.PYTHON, "-I", "-B", "-c", code], capture_output=True, text=True).stdout
        self.assertEqual(plain.strip(), "bytecode from outside the manifest")  # the hole being closed
        flags = caret_heavy.PY_FLAGS
        guarded = subprocess.run([caret_heavy.PYTHON, *flags, "-c", code], capture_output=True, text=True).stdout
        self.assertEqual(guarded.strip(), "source")
        self.assertEqual(caret_heavy.boot_argv(caret_heavy.PYTHON, "/p", "d")[1:1 + len(flags)], list(flags))
        with open(os.path.join(HEAVY, "recipes/lib.sh")) as fh:
            self.assertIn("-X pycache_prefix=/var/empty", fh.read())

    def test_sealed_tree_messages_name_no_file(self):
        self.write("held/tasks/expect/secret-page-name.json", "{}")
        entry = manifest.record("heldout-pages", "sealed", os.path.join(self.root, "held"))
        self.assertEqual(set(entry), {"name", "kind", "path", "sha256", "files", "bytes"})
        self.write("held/tasks/expect/secret-page-name.json", '{"changed": 1}')
        problems = manifest.check([entry])
        self.assertEqual(len(problems), 1)
        self.assertNotIn("secret-page-name", problems[0])
        shutil.rmtree(os.path.join(self.root, "held"))
        self.assertEqual(manifest.check([entry]), ["sealed input heldout-pages is unreadable"])

    def test_file_entry_detects_change_and_refuses_symlink(self):
        path = self.write("bridge", "binary\n")
        entry = manifest.record("bridge", "file", path)
        self.write("bridge", "binary2\n")
        self.assertEqual(manifest.check([entry]), ["bridge ({}) changed since enqueue".format(path)])
        os.symlink(path, os.path.join(self.root, "link"))
        with self.assertRaises(manifest.ManifestError):
            manifest.record("link", "file", os.path.join(self.root, "link"))

    def test_payload_revision_must_equal_the_pin(self):
        pin, other = "a" * 40, "b" * 40
        self.write("p/REV", other + "\n")
        with self.assertRaisesRegex(manifest.ManifestError, "built at {}, not the pinned {}".format(other, pin)):
            manifest.record("payload", "payload", os.path.join(self.root, "p"), rev=pin)
        self.write("p/REV", pin + "\n")
        self.write("p/acc/Caret", "app\n")
        entry = manifest.record("payload", "payload", os.path.join(self.root, "p"), rev=pin)
        # Written at run time by the feeder and the recipe, so not part of the record.
        self.write("p/CONFIG", "off\n")
        self.write("p/spend-control.json", "{}")
        self.assertEqual(manifest.check([entry]), [])
        self.write("p/acc/Caret", "app2\n")
        self.assertIn("payload payload changed since enqueue", manifest.check([entry])[0])
        self.write("p/acc/Caret", "app\n")
        self.write("p/REV", other + "\n")
        self.assertIn("not the pinned", manifest.check([entry])[0])

    def test_git_entry_refuses_dirty_or_moved_checkout(self):
        repo = os.path.join(self.root, "repo")
        os.makedirs(repo)
        git(repo, "init", "-q")
        self.write("repo/f", "1\n")
        git(repo, "add", "f")
        git(repo, "commit", "-q", "-m", "one")
        head = git(repo, "rev-parse", "HEAD").stdout.strip()
        entry = manifest.record("wt", "git", repo, rev=head)
        self.assertEqual(manifest.check([entry]), [])
        self.write("repo/untracked", "")
        self.assertIn("uncommitted or untracked", manifest.check([entry])[0])
        os.unlink(os.path.join(repo, "untracked"))
        self.write("repo/f", "2\n")
        git(repo, "commit", "-q", "-am", "two")
        self.assertIn("not the pinned", manifest.check([entry])[0])


class CheckTest(Temp):
    """recipes/check.py: each step's exit code, and finish's precedence and result.json."""

    def setUp(self):
        super().setUp()
        self.out = os.path.join(self.root, "out")
        os.makedirs(self.out)
        os.environ.update(CARET_HEAVY_OUT=self.out, CARET_HEAVY_JOB_ID="caret-unit", CARET_HEAVY_PLAN_SHA256="f" * 64,
                          CARET_HEAVY_RECIPE="canned-sets")
        self.addCleanup(lambda: [os.environ.pop(k, None) for k in (
            "CARET_HEAVY_OUT", "CARET_HEAVY_JOB_ID", "CARET_HEAVY_PLAN_SHA256", "CARET_HEAVY_RECIPE")])

    def page_loop(self, name, wrong=0, walked=True, extra=None):
        rows = [{"id": "a", "walk": {"commandMs": 1} if walked else None, "wrong": ["x"] * wrong, "error": None},
                {"id": "b", "walk": {"commandMs": 1}, "wrong": [], "error": None}]
        self.write("out/{}/page-loop.json".format(name), json.dumps(dict({"rows": rows, "presses": 0, "posts": 0}, **(extra or {}))))
        self.write("out/{}.log".format(name), "log\n")

    def run_check(self, *argv):
        return check.main(list(argv))

    def test_page_loop_codes(self):
        self.page_loop("good")
        self.assertEqual(self.run_check("page-loop", "good", "--exit", "0"), 0)
        self.page_loop("bad", wrong=2)
        self.assertEqual(self.run_check("page-loop", "bad", "--exit", "1"), check.WRONG)
        self.page_loop("seen")
        self.assertEqual(self.run_check("page-loop", "seen", "--exit", "130", "--wrong-seen"), check.WRONG)
        self.assertEqual(self.run_check("page-loop", "crashed", "--exit", "1"), check.FAILED)
        self.assertEqual(self.run_check("page-loop", "silent", "--exit", "0"), check.EVIDENCE)
        self.page_loop("unwalked", walked=False)
        self.assertEqual(self.run_check("page-loop", "unwalked", "--exit", "0"), check.EVIDENCE)
        self.write("out/garbled/page-loop.json", "{not json")
        self.assertEqual(self.run_check("page-loop", "garbled", "--exit", "0"), check.EVIDENCE)

    def test_suite_codes_from_real_formats(self):
        vitest_fail = self.write("out/v1.txt", " Test Files  5 failed | 153 passed (158)\n      Tests  8 failed | 3474 passed (3482)\n")
        vitest_ok = self.write("out/v2.txt", " Test Files  1 passed (1)\n      Tests  23 passed (23)\n")
        node_fail = self.write("out/n1.txt", "ℹ tests 15\nℹ pass 14\nℹ fail 1\n")
        tsc = self.write("out/t.txt", "a.ts(1,1): error TS2322: Type 'undefined' is not assignable\nexit 2\n")
        self.assertEqual(self.run_check("suite", "v1", "--log", vitest_fail, "--exit", "1", "--kind", "vitest"), check.FAILED)
        self.assertEqual(self.run_check("suite", "v2", "--log", vitest_ok, "--exit", "0", "--kind", "vitest"), 0)
        # A runner that exits 0 while reporting failures still fails.
        self.assertEqual(self.run_check("suite", "n1", "--log", node_fail, "--exit", "0", "--kind", "node-test"), check.FAILED)
        self.assertEqual(self.run_check("suite", "t", "--log", tsc, "--exit", "0", "--kind", "tsc"), check.FAILED)
        empty = self.write("out/e.txt", "nothing ran\n")
        self.assertEqual(self.run_check("suite", "e", "--log", empty, "--exit", "0", "--kind", "vitest"), check.EVIDENCE)
        self.assertEqual(self.run_check("suite", "gone", "--log", os.path.join(self.out, "none.txt"),
                                        "--exit", "0", "--kind", "vitest"), check.EVIDENCE)

    def test_spend_limit(self):
        ledger = os.path.join(self.root, "ledger")
        self.write("ledger/2026-10-07.ndjson", '{"usd": 0.05}\n{"usd": 0.04}\n{"usd": 0.07}\n')
        self.assertEqual(self.run_check("spend", "--day", "2026-10-07", "--from-line", "2", "--limit", "0.10",
                                        "--ledger-dir", ledger), check.SPEND)
        self.assertEqual(self.run_check("spend", "--day", "2026-10-07", "--from-line", "3", "--limit", "0.10",
                                        "--ledger-dir", ledger), 0)
        self.assertEqual(self.run_check("spend", "--day", "2026-10-08", "--from-line", "1", "--limit", "0.10",
                                        "--ledger-dir", ledger), 0)

    def r2_run(self, harness="h11", rev="c" * 40, rows=None, leak="CLEAN (scanned 12 files)\n", spend=0.0, passed=True):
        run = os.path.join(self.out, "rig-run")
        shutil.rmtree(run, ignore_errors=True)
        self.write("out/rig-run/rig.json", '{"exit": 0}')
        name = "results.json" if harness == "h11" else "result.json"
        data = {"rev": rev, "options": {"pages": ["wizard-1"]}, "rows": rows or [{"id": "r1", "wrong": "no"}],
                "pass": passed}
        self.write("out/rig-run/out/" + name, json.dumps(data))
        if leak is not None:
            self.write("out/rig-run/out/leak-check.txt", leak)
        self.write("out/rig-run/out/jev-spend/day.ndjson",
                   '{"usd": 1.0, "r2Seed": true}\n{"usd": %s}\n' % spend)
        return run

    def test_r2_codes(self):
        pin = "c" * 40
        opts = json.dumps({"pages": ["wizard-1"]})
        base = ["--rev", pin, "--exit", "0", "--spend-limit", "0.20"]
        self.assertEqual(self.run_check("r2", "--harness", "h11", "--run", self.r2_run(), "--options", opts, *base), 0)
        self.assertEqual(self.run_check("r2", "--harness", "h11", "--run",
                                        self.r2_run(rows=[{"id": "r1", "wrong": "yes"}]), *base), check.WRONG)
        self.assertEqual(self.run_check("r2", "--harness", "h11", "--run", self.r2_run(rev="d" * 40), *base), check.EVIDENCE)
        self.assertEqual(self.run_check("r2", "--harness", "h11", "--run", self.r2_run(leak=None), *base), check.EVIDENCE)
        self.assertEqual(self.run_check("r2", "--harness", "h11", "--run", self.r2_run(), "--options",
                                        json.dumps({"pages": ["reveal"]}), *base), check.EVIDENCE)
        self.assertEqual(self.run_check("r2", "--harness", "h11", "--run", self.r2_run(spend=0.25), *base), check.SPEND)
        self.assertEqual(self.run_check("r2", "--harness", "h14", "--run", self.r2_run("h14", passed=False), *base),
                         check.FAILED)
        self.assertEqual(self.run_check("r2", "--harness", "h11", "--run", self.r2_run(),
                                        "--rev", pin, "--exit", "70", "--spend-limit", "0.20"), check.FAILED)
        for leak_code in (98, 99):
            self.assertEqual(self.run_check("r2", "--harness", "h11", "--run", self.r2_run(),
                                            "--rev", pin, "--exit", str(leak_code), "--spend-limit", "0.20"), leak_code)

    def test_finish_precedence_and_result(self):
        self.assertEqual(self.run_check("finish"), check.EVIDENCE)  # no steps recorded
        os.unlink(os.path.join(self.out, "result.json"))
        self.page_loop("good")
        self.run_check("page-loop", "good", "--exit", "0")
        failing = self.write("out/v.txt", "      Tests  1 failed | 2 passed (3)\n")
        self.run_check("suite", "v", "--log", failing, "--exit", "1", "--kind", "vitest")
        self.page_loop("bad", wrong=1)
        self.run_check("page-loop", "bad", "--exit", "1")
        self.assertEqual(self.run_check("finish"), check.WRONG)
        with open(os.path.join(self.out, "result.json")) as fh:
            result = json.load(fh)
        self.assertEqual((result["job_id"], result["plan_sha256"], result["recipe"], result["exit"]),
                         ("caret-unit", "f" * 64, "canned-sets", check.WRONG))
        self.assertEqual(result["evidence"], ["bad.log", "bad/page-loop.json", "good.log", "good/page-loop.json",
                                              "steps.ndjson", "v.txt"])


class AdapterTest(Temp):
    def setUp(self):
        super().setUp()
        self.out = os.path.join(self.root, "out")
        os.makedirs(self.out)
        self.plan = {"job_id": "caret-unit", "recipe": {"name": "canned-sets"}}
        self.started = time.time() - 5

    def result(self, **over):
        data = dict({"schema": 1, "job_id": "caret-unit", "plan_sha256": "f" * 64, "recipe": "canned-sets",
                     "exit": 0, "evidence": ["set/page-loop.json"]}, **over)
        self.write("out/set/page-loop.json", "{}")
        self.write("out/result.json", json.dumps(data))

    def validate(self, exit_code=0):
        return results.validate(self.plan, "f" * 64, self.out, self.started, exit_code)

    def test_accepts_matching_fresh_evidence(self):
        self.result()
        self.assertEqual(self.validate(), [])

    def test_rejects_missing_foreign_stale_and_escaping_evidence(self):
        self.assertEqual(self.validate(), ["result.json is missing"])
        cases = {
            "job_id": ({"job_id": "caret-other"}, "job_id is 'caret-other'"),
            "plan": ({"plan_sha256": "0" * 64}, "plan_sha256"),
            "recipe": ({"recipe": "live-tasks"}, "recipe is 'live-tasks'"),
            "exit": ({"exit": 10}, "exit is 10, expected 0"),
            "no evidence": ({"evidence": []}, "lists no evidence"),
            "escape": ({"evidence": ["../outside"]}, "outside the run's output directory"),
            "absolute": ({"evidence": ["/etc/hosts"]}, "not a relative path"),
            "missing file": ({"evidence": ["nope.json"]}, "evidence nope.json is missing"),
        }
        for name, (over, expected) in cases.items():
            with self.subTest(name):
                self.result(**over)
                problems = self.validate()
                self.assertTrue(any(expected in p for p in problems), problems)
        self.result()
        old = time.time() - 3600
        os.utime(os.path.join(self.out, "set/page-loop.json"), (old, old))
        self.assertEqual(self.validate(), ["evidence set/page-loop.json predates this run"])
        self.write("out/result.json", "{broken")
        self.assertIn("unreadable", self.validate()[0])


class TrackerTest(unittest.TestCase):
    """procs.Tracker with fake probes: pid reuse never hides a marked process, and never signals a stranger."""

    class Probes:
        def __init__(self):
            self.procs = {}  # pid -> (start, env, ppid, pgid)

        def all_pids(self):
            return list(self.procs)

        def usage(self, pid):
            p = self.procs.get(pid)
            return None if p is None else (1, p[0])

        def procargs(self, pid):
            p = self.procs.get(pid)
            return None if p is None else (["x"], p[1])

        def children(self, pid):
            return [c for c, p in self.procs.items() if p[2] == pid]

        def group(self, pgid):
            return [c for c, p in self.procs.items() if p[3] == pgid]

    def tracker(self):
        import procs
        probes = self.Probes()
        t = procs.Tracker(probes, "caret-x.n", "caret-heavy.caret-x.", started_abstime=100)
        t.me = -1
        procs_launchd = procs.launchd_jobs
        procs.launchd_jobs = lambda prefix, uid=None: []
        self.addCleanup(setattr, procs, "launchd_jobs", procs_launchd)
        return probes, t

    def test_a_reused_pid_carrying_the_marker_is_still_found(self):
        probes, t = self.tracker()
        probes.procs[500] = (200, ["CARET_HEAVY_MARK=caret-x.n"], 1, 500)
        self.assertEqual(set(t.owned(full=True)), {500})
        del probes.procs[500]
        self.assertEqual(t.owned(full=True), {})
        # The pid comes back as another marked process (a later start), detached from every tracked group.
        probes.procs[500] = (300, ["CARET_HEAVY_MARK=caret-x.n"], 1, 999)
        self.assertEqual(set(t.owned(full=True)), {500})

    def test_a_reused_pid_without_the_marker_is_never_owned(self):
        probes, t = self.tracker()
        probes.procs[500] = (200, ["CARET_HEAVY_MARK=caret-x.n"], 1, 500)
        t.owned(full=True)
        probes.procs[500] = (300, ["OTHER=1"], 1, 999)
        self.assertEqual(t.owned(full=True), {})
        from unittest import mock
        with mock.patch.object(os, "kill") as kill:  # never a real signal, even if this regresses
            self.assertEqual(t.signal_all(15, {500: 1}), [])
        kill.assert_not_called()


class ProfileAndEnqueueTest(Temp):
    def test_profiles_floors_estimates_and_evidence(self):
        expected = {"caret-browser-eval": (11, 2.5, 0.5, True), "caret-helper-suite": (12, 3, 0.5, True),
                    "caret-swift": (20, 6, 6, True), "caret-vm": (15, 6, 2, False)}
        self.assertEqual({k: (p.floor_gib, p.est_mem_gib, p.est_disk_gib, p.lease)
                          for k, p in caret_heavy.PROFILES.items()}, expected)
        for name, p in caret_heavy.PROFILES.items():
            with self.subTest(name):
                self.assertRegex(p.evidence, "Unmeasured|unmeasured")
                # A floor must cover the lease's own 8 GiB plus the estimates the queue does not charge.
                if p.lease:
                    self.assertGreaterEqual(p.floor_gib, 8 + p.est_mem_gib + p.est_disk_gib)
                self.assertEqual(p.queue_timeout_s, p.lease_wait_s + p.exec_s + p.term_grace_s + 300)
        self.assertEqual(caret_heavy.PROFILES["caret-vm"].wait_flock, ("ios_qa_lock",))
        for recipe in caret_heavy.RECIPES.values():
            self.assertIn(recipe.profile, caret_heavy.PROFILES)
            self.assertTrue(os.path.isfile(os.path.join(HEAVY, recipe.script)), recipe.script)

    def test_queue_command_waits_on_hold_pins_and_never_unpins(self):
        paths = caret_heavy.default_paths("/tmp/state-for-argv-only")
        for name, prof in caret_heavy.PROFILES.items():
            with self.subTest(name):
                recipe = next(r for r in caret_heavy.RECIPES.values() if r.profile == name)
                plan = caret_heavy.build_plan(recipe, "caret-x", "/w", "a" * 40, [], [], {}, None, paths,
                                              ("/snap", {}, "/ops", "b" * 40))
                argv = caret_heavy.queue_enqueue_argv(plan, "/plans/caret-x.json", "c" * 64)
                head = argv[:argv.index("--")]
                self.assertNotIn("--unpinned", argv)
                self.assertEqual(head[head.index("--wait-absent") + 1], os.path.expanduser("~/.caret-run/HOLD"))
                self.assertEqual(head[head.index("--min-free-gib") + 1], str(prof.floor_gib))
                self.assertEqual((head[head.index("--repo") + 1], head[head.index("--expect-rev") + 1]), ("/w", "a" * 40))
                self.assertEqual(float(head[head.index("--timeout") + 1]), prof.queue_timeout_s)
                self.assertEqual("--wait-flock" in head, name == "caret-vm")
                tail = argv[argv.index("--") + 1:]
                n = len(caret_heavy.PY_FLAGS)
                self.assertEqual(tail[:n + 2], [caret_heavy.PYTHON, *caret_heavy.PY_FLAGS, "-c"])
                self.assertEqual(tail[n + 3:], ["/plans/caret-x.json", "c" * 64, "relay"])

    def test_live_recipes_need_an_env_file_and_offline_ones_get_none(self):
        paths = caret_heavy.default_paths(os.path.join(self.root, "state"))
        repo = os.path.join(self.root, "wt")
        os.makedirs(repo)
        git(repo, "init", "-q")
        self.write("wt/f")
        git(repo, "add", "f")
        git(repo, "commit", "-q", "-m", "x")
        rev = git(repo, "rev-parse", "HEAD").stdout.strip()
        args = argparse.Namespace(tag="t", spend_limit=0.1, heldout=None)
        with self.assertRaisesRegex(manifest.ManifestError, "needs CARET_ENV_FILE"):
            caret_heavy.enqueue("live-tasks", "caret-x", repo, rev, args, paths)
        with self.assertRaisesRegex(manifest.ManifestError, "absolute file"):
            caret_heavy.enqueue("live-tasks", "caret-x", repo, rev, args, paths, env_file="relative.env")
        for bad_id in ("x-caret", "caret-", "caret-a b"):
            with self.assertRaisesRegex(manifest.ManifestError, "job ID"):
                caret_heavy.enqueue("helper-window", bad_id, repo, rev, argparse.Namespace(tag="t"), paths)
        with self.assertRaisesRegex(manifest.ManifestError, "full 40-character"):
            caret_heavy.enqueue("helper-window", "caret-x", repo, "HEAD", argparse.Namespace(tag="t"), paths)

    def test_r2_vm_plan_refuses_a_payload_not_at_the_pin_and_records_options(self):
        pin = "a" * 40
        job = os.path.join(self.root, "vm")
        self.write("vm/job.sh", "#!/bin/bash\n")
        self.write("vm/tcc.txt", "")
        self.write("vm/payload/REV", "b" * 40 + "\n")
        self.write("vm/payload/h11-options.json", '{"pages": ["wizard-1"], "sources": "note"}')
        args = argparse.Namespace(harness="h11", job_dir=job, config="off", rig_wait=3600, allowance=0.2, prior_spend=0.0)
        with self.assertRaisesRegex(manifest.ManifestError, "not the pinned"):
            caret_heavy._r2_vm_plan(args, "/w", pin, {})
        self.write("vm/payload/REV", pin + "\n")
        argv, inputs, recorded = caret_heavy._r2_vm_plan(args, "/w", pin, {})
        self.assertEqual(argv, ["h11", job, "3600", "0.2000", "0.0000", "off"])
        self.assertEqual([e["name"] for e in inputs], ["payload", "job.sh", "tcc.txt"])
        self.assertEqual(recorded, {"H11_OPTIONS": '{"pages":["wizard-1"],"sources":"note"}'})
        for bad in (dict(allowance=0.25), dict(prior_spend=0.2), dict(config=None)):
            with self.subTest(bad):
                with self.assertRaises(manifest.ManifestError):
                    caret_heavy._r2_vm_plan(argparse.Namespace(**dict(vars(args), **bad)), "/w", pin, {})

    def test_r2_prepare_puts_stage_options_in_argv(self):
        parser = argparse.ArgumentParser()
        caret_heavy._r2_prepare_options(parser)
        args = parser.parse_args(["--harness", "h11", "--work", "/w2", "--pages", "wizard-1,reveal", "--next-page", "1"])
        self.assertEqual((args.pages, args.sources, args.next_page, args.scenarios), ("wizard-1,reveal", "note", "1", "page_task"))
        with self.assertRaises(SystemExit):
            parser.parse_args(["--harness", "h11", "--work", "/w2", "--pages", "wizard-9"])

    def test_no_recipe_hardcodes_a_key_file(self):
        found = subprocess.run(["grep", "-rlE", r"Caret/\.env|TYPESAFE_API_KEY=[A-Za-z0-9]", os.path.join(HEAVY, "recipes")],
                               capture_output=True, text=True).stdout.split()
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
