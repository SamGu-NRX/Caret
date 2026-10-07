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
from unittest import mock

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

    def test_swift_test_output_xctest_swift_testing_and_build_errors(self):
        xc_ok = ("Test Suite 'All tests' started at 2026-10-07 21:00:00.000.\n"
                 "Test Suite 'CaretHostTests.xctest' passed at 2026-10-07 21:00:01.234.\n"
                 "\t Executed 40 tests, with 0 failures (0 unexpected) in 1.200 (1.230) seconds\n"
                 "Test Suite 'All tests' passed at 2026-10-07 21:00:01.240.\n"
                 "\t Executed 42 tests, with 0 failures (0 unexpected) in 1.234 (1.240) seconds\n"
                 "\u2714 Test run with 12 tests in 3 suites passed after 0.004 seconds.\n")
        xc_fail = ("Test Suite 'All tests' failed at 2026-10-07 21:00:01.240.\n"
                   "\t Executed 42 tests, with 2 failures (0 unexpected) in 1.234 (1.240) seconds\n"
                   "\u2714 Test run with 0 tests passed after 0.001 seconds.\n")
        st_fail = ("\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.001) seconds\n"
                   "\u2718 Test run with 12 tests in 3 suites failed after 0.010 seconds with 2 issues.\n")
        build = ("Building for debugging...\n/x/Sources/A.swift:3:5: error: cannot find 'foo' in scope\n"
                 "error: fatalError\n")
        none = "\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.001) seconds\n"
        cases = [("ok", xc_ok, "0", 0, (0, 54)), ("xc-fail", xc_fail, "1", check.FAILED, (2, 40)),
                 ("xc-fail-exit0", xc_fail, "0", check.FAILED, (2, 40)), ("st-fail", st_fail, "1", check.FAILED, (2, 0)),
                 ("build", build, "1", check.PREPARE, (None, None)), ("none", none, "0", check.EVIDENCE, (0, 0))]
        for name, text, exit_code, want, counts in cases:
            with self.subTest(name):
                log = self.write("out/{}.txt".format(name), text)
                self.assertEqual(self.run_check("suite", name, "--log", log, "--exit", exit_code, "--kind", "swift"), want)
                with open(os.path.join(self.out, name + ".summary.json")) as fh:
                    summary = json.load(fh)
                self.assertEqual((summary["failed"], summary["passed"]), counts)
                self.assertEqual(summary["build_failed"], name == "build")
        with open(os.path.join(self.out, "ok.summary.json")) as fh:
            summary = json.load(fh)
        self.assertEqual((summary["xctest"], summary["swift_testing"]),
                         ({"executed": 42, "failures": 0}, {"tests": 12, "verdict": "passed", "issues": 0}))

    def test_vm_proof_needs_every_check_true(self):
        self.write("out/proof.json", json.dumps({"checks": {"clone_gone": True, "virtualization_gone": True}}))
        self.assertEqual(self.run_check("vm-proof", "--exit", "0"), 0)
        self.write("out/proof.json", json.dumps({"checks": {"clone_gone": True, "virtualization_gone": False}}))
        self.assertEqual(self.run_check("vm-proof", "--exit", "0"), check.FAILED)
        self.write("out/proof.json", json.dumps({"checks": {}}))
        self.assertEqual(self.run_check("vm-proof", "--exit", "0"), check.EVIDENCE)
        self.write("out/proof.json", "{not json")
        self.assertEqual(self.run_check("vm-proof", "--exit", "0"), check.EVIDENCE)
        os.unlink(os.path.join(self.out, "proof.json"))
        self.assertEqual(self.run_check("vm-proof", "--exit", "0"), check.EVIDENCE)
        self.write("out/proof.json", json.dumps({"checks": {"clone_gone": True}}))
        self.assertEqual(self.run_check("vm-proof", "--exit", "1"), check.FAILED)  # the proof script itself failed

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
        if harness == "h11":
            data = {"rev": rev, "options": self.H11_OPTS, "rows": rows or self.good_h11_rows(), "notes": []}
        else:
            ids = ["attach-input", "attach-dropzone", "tab-never-confirms", "click-opens", "save-line", "switches",
                   "zero-submits", "attach-input-undo", "attach-dropzone-undo"]
            data = {"rev": rev, "rows": [{"id": i, "pass": passed} for i in ids], "pass": passed,
                    "checks": [{"id": i, "pass": True} for i in ("fixture", "caret-up", "page", "window-id")]}
        self.write("out/rig-run/out/" + name, json.dumps(data))
        if leak is not None:
            self.write("out/rig-run/out/leak-check.txt", leak)
        self.write("out/rig-run/out/jev-spend/day.ndjson",
                   '{"usd": 1.0, "r2Seed": true}\n{"usd": %s}\n' % spend)
        return run

    H11_OPTS = {"pages": ["wizard-1"], "sources": "note", "nextPage": False, "scenarios": ["page_task"]}

    def test_r2_codes(self):
        pin = "c" * 40
        opts = json.dumps(self.H11_OPTS)
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
        self.assertEqual(self.run_check("r2", "--harness", "h11", "--run", self.r2_run(), "--options", opts,
                                        "--rev", pin, "--exit", "70", "--spend-limit", "0.20"), check.FAILED)
        # H11 without the plan's options cannot be checked against them.
        self.assertEqual(self.run_check("r2", "--harness", "h11", "--run", self.r2_run(), *base), check.EVIDENCE)
        for leak_code in (98, 99):
            self.assertEqual(self.run_check("r2", "--harness", "h11", "--run", self.r2_run(),
                                            "--rev", pin, "--exit", str(leak_code), "--spend-limit", "0.20"), leak_code)

    def test_malformed_evidence_is_12_whatever_the_eval_exited(self):
        self.write("out/garbled/page-loop.json", "{not json")
        self.assertEqual(self.run_check("page-loop", "garbled", "--exit", "1"), check.EVIDENCE)
        self.write("out/shape/page-loop.json", json.dumps({"rows": "not a list", "presses": 0}))
        self.assertEqual(self.run_check("page-loop", "shape", "--exit", "1"), check.EVIDENCE)
        self.write("out/rowshape/page-loop.json", json.dumps({"rows": [{"id": "a", "wrong": "x", "walk": {}}], "presses": 0}))
        self.assertEqual(self.run_check("page-loop", "rowshape", "--exit", "0"), check.EVIDENCE)

    def stopped_empty(self, name, **change):
        """The blind set's wizard-3 row (B1, caret-hb-1eac305-canned-n1), as synthetic evidence: a scored task with nothing
        eligible, which Caret stopped empty. *change* edits the row; the other page is an ordinary done one."""
        row = {"id": "wizard-3", "controls": 1, "walk": {"commandMs": 1}, "goal": None, "previewMs": None, "wrong": [],
               "error": "no preview: stopped Caret found nothing to put in Cover letter.",
               "task": {"scored": True, "eligible": 0, "right": 0, "missed": [], "attachGap": ["resume"],
                        "arrived": "harness Next on wizard-2"}}
        for key, value in change.items():
            if key in ("scored", "eligible"):
                row["task"][key] = value
            else:
                row[key] = value
        rows = [{"id": "wizard-1", "walk": {"commandMs": 1}, "wrong": [], "error": None, "goal": {"outcome": "done"},
                 "task": {"scored": True, "eligible": 2}}, row]
        self.write("out/{}/page-loop.json".format(name), json.dumps({"rows": rows, "presses": 0, "posts": 0}))
        self.write("out/{}.log".format(name), "log\n")

    def test_an_expected_empty_task_is_not_a_page_error_and_nothing_else_is_excused(self):
        cases = [
            ("stopped-empty", {}, "0", check.OK),
            ("other-error", {"error": "read ECONNRESET"}, "0", check.FAILED),
            ("unsettled-ask", {"error": "no preview: asked: Choose a source"}, "0", check.FAILED),
            ("eligible", {"eligible": 1}, "0", check.EVIDENCE),        # something to fill and no goal result
            ("unscored", {"scored": False}, "0", check.EVIDENCE),
            ("wrong-write", {"wrong": ["Cover letter: x (key: y)"]}, "0", check.WRONG),
            ("eval-failed", {}, "1", check.FAILED),
        ]
        for name, change, exit_code, want in cases:
            with self.subTest(name):
                self.stopped_empty(name, **change)
                self.assertEqual(self.run_check("page-loop", name, "--exit", exit_code, "--goal"), want)
        # Off the goal path the same rules hold for errors: only the stopped-empty task is excused.
        self.stopped_empty("plain-empty")
        self.assertEqual(self.run_check("page-loop", "plain-empty", "--exit", "0"), check.OK)
        self.stopped_empty("plain-eligible", eligible=1)
        self.assertEqual(self.run_check("page-loop", "plain-eligible", "--exit", "0"), check.FAILED)

    def test_page_loop_acceptance_needs_every_expected_page_no_error_and_goal_results(self):
        ids = self.write("ids.txt", "a\nb\n")
        self.page_loop("good")
        self.assertEqual(self.run_check("page-loop", "good", "--exit", "0", "--expect-ids", ids), 0)
        missing = self.write("ids2.txt", "a\nb\nc\n")
        self.assertEqual(self.run_check("page-loop", "good", "--exit", "0", "--expect-ids", missing), check.EVIDENCE)
        rows = [{"id": "a", "walk": {"x": 1}, "wrong": [], "error": "page crashed"},
                {"id": "b", "walk": {"x": 1}, "wrong": [], "error": None}]
        self.write("out/err/page-loop.json", json.dumps({"rows": rows, "presses": 0, "posts": 0}))
        self.assertEqual(self.run_check("page-loop", "err", "--exit", "0", "--expect-ids", ids), check.FAILED)
        # Goal path: every row needs a goal result, except a task page with nothing eligible to fill.
        rows = [{"id": "a", "walk": {"x": 1}, "wrong": [], "error": None, "goal": {"outcome": "done"},
                 "task": {"scored": True, "eligible": 3}},
                {"id": "b", "walk": {"x": 1}, "wrong": [], "error": None, "goal": None, "task": {"scored": True, "eligible": 0}}]
        self.write("out/goal/page-loop.json", json.dumps({"rows": rows, "presses": 0}))
        self.assertEqual(self.run_check("page-loop", "goal", "--exit", "0", "--goal"), 0)
        rows[1]["task"]["eligible"] = 2
        self.write("out/goal/page-loop.json", json.dumps({"rows": rows, "presses": 0}))
        self.assertEqual(self.run_check("page-loop", "goal", "--exit", "0", "--goal"), check.EVIDENCE)
        rows[1]["goal"] = {"outcome": "done"}
        rows[1]["task"]["scored"] = False
        self.write("out/goal/page-loop.json", json.dumps({"rows": rows, "presses": 0}))
        self.assertEqual(self.run_check("page-loop", "goal", "--exit", "0", "--goal"), check.EVIDENCE)

    def test_finish_requires_named_steps_and_fails_on_a_checker_error(self):
        self.page_loop("one")
        self.run_check("page-loop", "one", "--exit", "0")
        self.assertEqual(self.run_check("finish", "--require", "one", "two"), check.EVIDENCE)
        with open(os.path.join(self.out, "result.json")) as fh:
            self.assertIn("two", json.dumps(json.load(fh)["steps"]))
        self.assertEqual(self.run_check("finish", "--require", "one"), 0)
        self.write("out/checker-errors.txt", "page-loop two --exit 0 (exit 1)\n")
        self.assertEqual(self.run_check("finish", "--require", "one"), check.EVIDENCE)

    def h11(self, rows, notes=(), pages=("wizard-1",), next_page=False):
        opts = {"pages": list(pages), "sources": "note", "nextPage": next_page, "scenarios": ["page_task"]}
        run = os.path.join(self.out, "rig-run")
        shutil.rmtree(run, ignore_errors=True)
        self.write("out/rig-run/out/results.json", json.dumps({"rev": "c" * 40, "options": opts, "rows": rows,
                                                               "notes": list(notes)}))
        self.write("out/rig-run/out/leak-check.txt", "CLEAN\n")
        return self.run_check("r2", "--harness", "h11", "--run", run, "--rev", "c" * 40, "--exit", "0",
                              "--spend-limit", "0.2", "--options", json.dumps(opts))

    def good_h11_rows(self, page="wizard-1"):
        sid = "h11-" + page
        return [{"id": sid + "-ask-at-form", "offered": "yes", "right": "yes", "wrong": "no", "note": ""},
                {"id": sid + "-tab", "right": "yes", "verified": "yes", "wrong": "no", "note": ""},
                {"id": sid + "-no-submit", "verified": "yes", "wrong": "n/a", "note": ""},
                {"id": sid + "-undo", "undone": "yes", "wrong": "n/a", "note": ""}]

    def test_h11_acceptance_needs_every_page_row_completed(self):
        self.assertEqual(self.h11(self.good_h11_rows()), 0)
        self.assertEqual(self.h11([]), check.EVIDENCE)  # no rows at all
        self.assertEqual(self.h11(self.good_h11_rows()[:2]), check.EVIDENCE)  # no-submit and undo missing
        self.assertEqual(self.h11(self.good_h11_rows(), pages=("wizard-1", "reveal")), check.EVIDENCE)
        rows = self.good_h11_rows()
        rows[0] = dict(rows[0], offered="no", right="n/a", note="desk did not open")
        self.assertEqual(self.h11(rows), check.FAILED)
        rows = self.good_h11_rows()
        rows[3] = dict(rows[3], undone="n/a", note="not run: the goal never ended")
        self.assertEqual(self.h11(rows), check.FAILED)
        self.assertEqual(self.h11(self.good_h11_rows(), notes=["harness: page_task reveal crashed: KeyError()"]),
                         check.FAILED)
        self.assertEqual(self.h11(self.good_h11_rows(), notes=["phase P: page_task wizard-1 not run (time budget)"]),
                         check.FAILED)
        # With the next page on, page 1's undo moves to wizard-2's row.
        rows = self.good_h11_rows()[:3] + [{"id": "h11-wizard-1-undo", "note": "not run: H11_NEXT_PAGE=1 pressed Next first"}]
        self.assertEqual(self.h11(rows, next_page=True), check.EVIDENCE)
        rows.append({"id": "h11-wizard-2-undo", "undone": "yes", "wrong": "n/a", "note": ""})
        self.assertEqual(self.h11(rows, next_page=True), 0)

    def h14(self, drop=None, fail=None, check_fail=None):
        ids = ["attach-input", "attach-dropzone", "tab-never-confirms", "click-opens", "save-line", "switches",
               "zero-submits", "attach-input-undo", "attach-dropzone-undo"]
        rows = [{"id": i, "pass": i != fail} for i in ids if i != drop]
        checks = [{"id": i, "pass": i != check_fail} for i in ("fixture", "caret-up", "page", "window-id")]
        run = os.path.join(self.out, "rig-run")
        shutil.rmtree(run, ignore_errors=True)
        self.write("out/rig-run/out/result.json", json.dumps({"rev": "c" * 40, "rows": rows, "checks": checks,
                                                              "pass": all(r["pass"] for r in rows + checks)}))
        self.write("out/rig-run/out/leak-check.txt", "CLEAN\n")
        return self.run_check("r2", "--harness", "h14", "--run", run, "--rev", "c" * 40, "--exit", "0",
                              "--spend-limit", "0.2")

    def test_h14_acceptance_needs_every_row_and_check(self):
        self.assertEqual(self.h14(), 0)
        self.assertEqual(self.h14(drop="save-line"), check.EVIDENCE)
        self.assertEqual(self.h14(fail="switches"), check.FAILED)
        self.assertEqual(self.h14(check_fail="caret-up"), check.FAILED)

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

        def user_pids(self, uid):
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
                    "caret-laya": (12, 3.5, 0.1, True),
                    "caret-swift": (8, 6, 2, True), "caret-vm": (0, 6, 2, False)}
        self.assertEqual({k: (p.floor_gib, p.est_mem_gib, p.est_disk_gib, p.lease)
                          for k, p in caret_heavy.PROFILES.items()}, expected)
        for name, p in caret_heavy.PROFILES.items():
            with self.subTest(name):
                self.assertRegex(p.evidence, "Unmeasured|unmeasured")
                if name == "caret-swift":
                    # lr-lease's heavy floor exactly; the queue's per-job lease charges the estimates against it.
                    with open(os.path.expanduser("~/.long-run/lease-policy.json")) as fh:
                        self.assertEqual(p.floor_gib, json.load(fh)["kinds"]["heavy"]["diskFloorGB"])
                elif name == "caret-vm":
                    # No floor of its own: lr-lease's vm decision for these estimates admits it (VmAdmissionTest).
                    self.assertEqual((p.floor_gib, p.admit_kind), (0, "vm"))
                elif p.lease:
                    # Older profiles: the floor covers the lease's own 8 GiB plus the estimates.
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
                want = caret_heavy._plain(plan["admission"]["queue_min_free_gib"]) if name == "caret-vm" else str(prof.floor_gib)
                self.assertEqual(head[head.index("--min-free-gib") + 1], want)
                if name == "caret-swift":
                    self.assertEqual((head[head.index("--est-mem-gib") + 1], head[head.index("--est-disk-gib") + 1]),
                                     ("6", "2"))
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

    def test_r2_vm_payload_is_sealed_only_at_the_pin_and_options_are_recorded(self):
        pin = "a" * 40
        job = os.path.join(self.root, "vm")
        self.write("vm/job.sh", "#!/bin/bash\n")
        self.write("vm/tcc.txt", "")
        self.write("vm/payload/REV", "b" * 40 + "\n")
        self.write("vm/payload/h11-options.json", '{"pages": ["wizard-1"], "sources": "note"}')
        args = argparse.Namespace(harness="h11", job_dir=job, config="off", rig_wait=3600, allowance=0.2, prior_spend=0.0)
        argv, specs, recorded = caret_heavy._r2_vm_plan(args, "/w", pin, {})
        self.assertEqual(argv, ["h11", "3600", "0.2000", "0.0000", "off"])
        self.assertEqual([(e["name"], e["dest"]) for e in specs],
                         [("payload", "vm-job/payload"), ("job.sh", "vm-job/job.sh"), ("tcc.txt", "vm-job/tcc.txt")])
        self.assertEqual(recorded, {"H11_OPTIONS": '{"pages":["wizard-1"],"sources":"note"}'})
        with self.assertRaisesRegex(manifest.ManifestError, "not the pinned"):
            caret_heavy.seal_inputs(specs, os.path.join(self.root, "sealed-1"))
        self.write("vm/payload/REV", pin + "\n")
        entries = caret_heavy.seal_inputs(specs, os.path.join(self.root, "sealed-2"))
        self.assertEqual(entries[0]["path"], os.path.join(self.root, "sealed-2/vm-job/payload"))
        self.assertEqual(entries[0]["source"], os.path.join(job, "payload"))
        for bad in (dict(allowance=0.25), dict(prior_spend=0.2), dict(config=None)):
            with self.subTest(bad):
                with self.assertRaises(manifest.ManifestError):
                    caret_heavy._r2_vm_plan(argparse.Namespace(**dict(vars(args), **bad)), "/w", pin, {})

    def test_laya_seals_its_interpreter_packages_model_config_and_data(self):
        argv, specs, recorded = caret_heavy._laya_plan(None, "/w", "a" * 40, {})
        self.assertEqual((argv, recorded), ([], {}))
        self.assertEqual({s["dest"] for s in specs}, {
            "laya-python/bin/python3.12", "laya-python/lib/python3.12", "laya-site", "laya-tokenizers",
            "laya-mlx/laya_mlx", "laya-src", "laya-data/questions.jsonl", "laya-data/narrowed.jsonl",
            "laya-data/jev-fields.jsonl", "laya-data/weights-sha256.txt"})
        with open(os.path.join(HEAVY, "recipes/laya.sh")) as fh:
            text = "".join(line for line in fh if not line.lstrip().startswith("#"))
        self.assertIn('-S -B -X pycache_prefix=/var/empty', text)  # nothing from site-packages outside the sealed paths
        self.assertNotIn("ghq", text)
        self.assertNotIn(".caret-run", text)

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


class KeytypeWorld(Temp):
    """A main repository whose packages/keytype is a gitlink with no checkout, and a source worktree whose keytype
    checkout is at that commit with its gitignored llama.xcframework."""

    def make(self):
        sub = os.path.join(self.root, "keytype-src")
        os.makedirs(os.path.join(sub, "Packages/ModelRuntime/Vendor/llama.xcframework"))
        self.write("keytype-src/Packages/A/Package.swift", "// a\n")
        self.write("keytype-src/Packages/ModelRuntime/Vendor/llama.xcframework/Info.plist", "plist\n")
        self.write("keytype-src/.gitignore", "Packages/ModelRuntime/Vendor/\n")
        git(sub, "init", "-q")
        git(sub, "add", "-A")
        git(sub, "commit", "-q", "-m", "keytype")
        gitlink = git(sub, "rev-parse", "HEAD").stdout.strip()
        main = os.path.join(self.root, "main")
        os.makedirs(main)
        git(main, "init", "-q")
        self.write("main/apps/caret/Package.swift", "// caret\n")
        git(main, "add", "-A")
        git(main, "update-index", "--add", "--cacheinfo", "160000,{},packages/keytype".format(gitlink))
        git(main, "commit", "-q", "-m", "main")
        rev = git(main, "rev-parse", "HEAD").stdout.strip()
        source = os.path.join(self.root, "source")
        os.makedirs(os.path.join(source, "packages"))
        shutil.copytree(sub, os.path.join(source, "packages/keytype"), symlinks=True)
        return main, rev, source, gitlink



class SwiftInputsTest(KeytypeWorld):
    """swift-tests and r2-prepare at a commit whose keytype submodule is not checked out: keytype is sealed as an
    archive of the gitlink's commit from another worktree's checkout, with that checkout's llama.xcframework, only
    when that checkout is at the gitlink."""

    def test_keytype_is_the_gitlinks_commit_and_llama_comes_with_it(self):
        main, rev, source, gitlink = self.make()
        specs = caret_heavy.keytype_inputs(main, rev, source)
        self.assertEqual([(s["name"], s["kind"], s.get("rev")) for s in specs],
                         [("keytype", "git-archive", gitlink), ("llama.xcframework", "tree", None)])
        sealed = caret_heavy.seal_inputs(specs, os.path.join(self.root, "inputs"))
        self.assertTrue(os.path.isfile(os.path.join(self.root, "inputs/keytype/Packages/A/Package.swift")))
        self.assertFalse(os.path.exists(os.path.join(self.root, "inputs/keytype/Packages/ModelRuntime/Vendor")))
        self.assertEqual(sealed[0]["git_rev"], gitlink)
        self.assertEqual(manifest.check(sealed), [])
        self.assertTrue(os.path.isfile(os.path.join(self.root, "inputs/llama.xcframework/Info.plist")))

    def test_a_source_checkout_off_the_gitlink_or_without_it_is_refused(self):
        main, rev, source, gitlink = self.make()
        repo = os.path.join(source, "packages/keytype")
        self.write("source/packages/keytype/Packages/A/Package.swift", "// moved on\n")
        git(repo, "commit", "-q", "-am", "later")
        with self.assertRaisesRegex(manifest.ManifestError, "is at .*, not the gitlink"):
            caret_heavy.keytype_inputs(main, rev, source)
        with self.assertRaisesRegex(manifest.ManifestError, "no keytype checkout"):
            caret_heavy.keytype_inputs(main, rev, os.path.join(self.root, "nowhere"))


class BinariesFromTest(Temp):
    """canned-sets and live-tasks (task pages or --heldout) seal the bridge, its test host and Chrome for Testing from
    --binaries-from's worktree when given, else from the pinned one, and the manifest pins what was sealed."""

    def binaries(self, where):
        for rel in ("bridge/.build/release/caret-bridge", "bridge/.build/release/caret-bridge-testhost",
                    "fixtures/web-form/.browsers/chrome/Chrome"):
            self.write("{}/{}".format(where, rel), "{} {}\n".format(where, rel))
        return os.path.join(self.root, where)

    def test_live_and_canned_seal_binaries_from_the_named_worktree(self):
        pinned, other = self.binaries("pinned"), self.binaries("other")
        heldout = os.path.join(self.root, "heldout")
        os.makedirs(heldout)
        self.write("heldout/manifest.json", "[]")
        paths = caret_heavy.default_paths(os.path.join(self.root, "state"))
        cases = [("live-tasks", argparse.Namespace(tag="t", spend_limit=0.1, heldout=None, binaries_from=other)),
                 ("live-tasks", argparse.Namespace(tag="t", spend_limit=0.1, heldout=heldout, binaries_from=other)),
                 ("live-tasks", argparse.Namespace(tag="t", spend_limit=0.1, heldout=None, binaries_from=None)),
                 ("canned-sets", argparse.Namespace(tag="t", binaries_from=other))]
        for n, (recipe, args) in enumerate(cases):
            with self.subTest(n):
                _argv, specs, _env = caret_heavy.RECIPES[recipe].plan_args(args, pinned, "a" * 40, paths)
                source = os.path.realpath(args.binaries_from or pinned)
                bins = {s["name"]: s for s in specs if s["name"] in ("bridge", "bridge-testhost", "chrome-for-testing")}
                self.assertEqual(sorted(bins), ["bridge", "bridge-testhost", "chrome-for-testing"])
                self.assertTrue(all(s["path"].startswith(source + os.sep) for s in bins.values()), bins)
                self.assertEqual("heldout-pages" in [s["name"] for s in specs], bool(getattr(args, "heldout", None)))
                if recipe == "live-tasks":
                    sealed = caret_heavy.seal_inputs(list(bins.values()), os.path.join(self.root, "inputs-{}".format(n)))
                    self.assertEqual(manifest.check(sealed), [])
                    with open(os.path.join(self.root, "inputs-{}".format(n), "bridge/caret-bridge")) as fh:
                        self.assertTrue(fh.read().startswith("other" if args.binaries_from else "pinned"))
        done = subprocess.run([sys.executable, os.path.join(HEAVY, "caret_heavy.py"), "enqueue", "live-tasks", "--help"],
                              capture_output=True, text=True)
        self.assertIn("--binaries-from", done.stdout)


class NodeDistTest(KeytypeWorld):
    """The Node tarball r2-prepare seals: fetched once into a cache and kept only when its SHA-256 is the one
    build-app.sh pins at the pinned commit; sealed against that same hash."""

    TARBALL = b"synthetic node tarball, not node\n"

    def repo_with_pin(self, data):
        import hashlib
        main, rev, source, gitlink = self.make()
        self.write("main/apps/caret/scripts/build-app.sh",
                   "NODE_VERSION=26.5.0\nNODE_SHA256={}\n".format(hashlib.sha256(data).hexdigest()))
        for d in ("helper", "extension"):
            self.write("main/{}/pnpm-lock.yaml".format(d), "lock {}\n".format(d))
            self.write("source/{}/pnpm-lock.yaml".format(d), "lock {}\n".format(d))
            self.write("source/{}/node_modules/x/index.js".format(d), "x\n")
        git(main, "add", "apps", "helper", "extension")  # not -A: that would stage the gitlink's deletion
        git(main, "commit", "-q", "-m", "pin")
        rev = git(main, "rev-parse", "HEAD").stdout.strip()
        dist = os.path.join(self.root, "dist/v26.5.0")
        os.makedirs(dist)
        with open(os.path.join(dist, "node-v26.5.0-darwin-arm64.tar.gz"), "wb") as fh:
            fh.write(self.TARBALL)
        return main, rev, source

    def test_the_pin_is_read_at_the_commit_and_only_a_matching_download_is_kept(self):
        import hashlib
        main, rev, source = self.repo_with_pin(self.TARBALL)
        self.assertEqual(caret_heavy.node_pin(main, rev), ("26.5.0", hashlib.sha256(self.TARBALL).hexdigest()))
        cache = os.path.join(self.root, "cache")
        base = "file://" + os.path.join(self.root, "dist")
        path = caret_heavy.fetch_node(main, rev, cache, base_url=base)
        self.assertEqual(path, os.path.join(cache, "node-v26.5.0-darwin-arm64.tar.gz"))
        with open(path, "rb") as fh:
            self.assertEqual(fh.read(), self.TARBALL)
        shutil.rmtree(os.path.join(self.root, "dist"))
        self.assertEqual(caret_heavy.fetch_node(main, rev, cache, base_url=base), path)  # verified cache, no download
        # A download whose hash is not the pin's is refused and nothing is kept.
        self.write("main/apps/caret/scripts/build-app.sh", "NODE_VERSION=26.5.0\nNODE_SHA256={}\n".format("0" * 64))
        git(main, "commit", "-q", "-am", "other pin")
        rev2 = git(main, "rev-parse", "HEAD").stdout.strip()
        os.makedirs(os.path.join(self.root, "dist/v26.5.0"))
        with open(os.path.join(self.root, "dist/v26.5.0/node-v26.5.0-darwin-arm64.tar.gz"), "wb") as fh:
            fh.write(self.TARBALL)
        other = os.path.join(self.root, "cache2")
        with self.assertRaisesRegex(manifest.ManifestError, "does not match the pinned SHA-256"):
            caret_heavy.fetch_node(main, rev2, other, base_url=base)
        self.assertEqual(os.listdir(other), [])
        # Sealing checks the hash again.
        spec = caret_heavy.spec("node-dist", "file", path, "node-dist/n.tar.gz", expect_sha256="0" * 64)
        with self.assertRaisesRegex(manifest.ManifestError, "pinned SHA-256"):
            caret_heavy.seal_inputs([spec], os.path.join(self.root, "inputs"))

    def test_r2_prepare_seals_keytype_node_and_modules_from_the_matching_worktree(self):
        main, rev, source = self.repo_with_pin(self.TARBALL)
        paths = dict(caret_heavy.default_paths(os.path.join(self.root, "state")), node_cache=os.path.join(self.root, "cache"))
        args = argparse.Namespace(harness="h11", work=os.path.join(self.root, "work"), pages="wizard-1", sources="note",
                                  next_page="0", scenarios="page_task", inputs_from=source)
        with self.assertRaisesRegex(manifest.ManifestError, "fetch-node"):
            caret_heavy.RECIPES["r2-prepare"].plan_args(args, main, rev, paths)
        caret_heavy.fetch_node(main, rev, paths["node_cache"], base_url="file://" + os.path.join(self.root, "dist"))
        argv, specs, _env = caret_heavy.RECIPES["r2-prepare"].plan_args(args, main, rev, paths)
        by = {s["name"]: s for s in specs}
        self.assertEqual(sorted(by), sorted(["keytype", "llama.xcframework", "node-dist", "helper-node_modules",
                                             "extension-node_modules", "chrome-for-testing-app"]))
        self.assertEqual(by["keytype"]["kind"], "git-archive")
        self.assertTrue(by["node-dist"]["expect_sha256"])
        self.assertTrue(by["helper-node_modules"]["path"].startswith(os.path.realpath(source)))
        # A worktree whose lockfile is not the pin's cannot supply node_modules.
        self.write("source/extension/pnpm-lock.yaml", "lock extension, another version\n")
        with self.assertRaisesRegex(manifest.ManifestError, "extension/pnpm-lock.yaml"):
            caret_heavy.RECIPES["r2-prepare"].plan_args(args, main, rev, paths)



class VmAdmissionTest(Temp):
    """caret-vm admission (coordinator, 2026-10-07): the queue waits at a floor derived from lease-policy.json (vm floor
    + rig-run's 6 + 2), before heavy exclusion; under the lock the supervisor makes one read-only check, lr-lease-core's
    own decision() for vm 6/2, with no lease, ignoring only leases `lr-reap --run rig` would remove first. A refusal
    ends the job with 75; HOLD, cancellation, the runner and the deadline are rechecked after it and before release.
    The stub core is the real lr-lease-core.mjs with machineReaders reading a fixed free disk."""

    POLICY = os.path.expanduser("~/.long-run/lease-policy.json")
    CORE = os.path.expanduser("~/.long-run/bin/lr-lease-core.mjs")

    def setUp(self):
        super().setUp()
        self.home = os.path.join(self.root, "home")
        self.bin = os.path.join(self.home, ".long-run/bin")
        os.makedirs(self.bin)
        os.makedirs(os.path.join(self.home, ".long-run/leases"))
        shutil.copy2(self.POLICY, os.path.join(self.home, ".long-run/lease-policy.json"))
        with open(self.CORE) as fh:
            core = fh.read()
        self.assertEqual(core.count("export function machineReaders(root) {"), 1)
        core = core.replace("export function machineReaders(root) {", "function realMachineReaders(root) {")
        core += ("\nexport function machineReaders(root) {\n  return { ...realMachineReaders(root), "
                 "diskGB: () => Number(process.env.STUB_FREE_GIB), swapGB: () => 1000, pressure: () => 'normal', "
                 "quietUntil: () => 0 };\n}\n")
        self.write("home/.long-run/bin/lr-lease-core.mjs", core)
        # lr-lease itself is never run by the check: this one records any call.
        self.calls = os.path.join(self.root, "lr-lease-calls")
        self.lr_lease = self.write("home/.long-run/bin/lr-lease", "#!/bin/sh\necho \"$*\" >> {}\nexit 1\n".format(self.calls))
        os.chmod(self.lr_lease, 0o755)
        with open(self.POLICY) as fh:
            vm = json.load(fh)["kinds"]["vm"]
        prof = caret_heavy.PROFILES["caret-vm"]
        # lr-lease charges the estimates against free disk on top of the vm floor under normal pressure.
        self.threshold = vm["diskFloorGB"] + prof.est_mem_gib + prof.est_disk_gib

    def admission(self, policy=None):
        paths = dict(caret_heavy.default_paths("/tmp/state-for-argv-only"),
                     lease_policy=policy or os.path.join(self.home, ".long-run/lease-policy.json"))
        return caret_heavy.vm_admission(paths, caret_heavy.PROFILES["caret-vm"])

    def check(self, free_gib, timeout=60, admission=None):
        import supervise
        env = dict(os.environ, HOME=self.home, STUB_FREE_GIB=str(free_gib))
        return supervise.vm_check(self.lr_lease, caret_heavy.dataclasses.asdict(caret_heavy.PROFILES["caret-vm"]),
                                  admission or self.admission(), env=env, timeout=timeout)

    def leases(self):
        return sorted(n for n in os.listdir(os.path.join(self.home, ".long-run/leases")) if n.endswith(".json"))

    def lease(self, run, owner, cleanup=False):
        import uuid
        lid = str(uuid.uuid4())
        now = int(time.time() * 1000)
        record = {"id": lid, "kind": "vm", "run": run, "ownerPid": owner, "estMemGB": 6, "estDiskGB": 2,
                  "createdAt": now, "expiresAt": now + 600000}  # after its owner started: not a reused pid
        if cleanup:
            record.update(cleanupRequired=True, attempt="attempt-1", tokenSha256="a" * 64)
        self.write("home/.long-run/leases/{}.json".format(lid), json.dumps(record))
        return lid

    def dead_pid(self):
        child = subprocess.Popen(["/usr/bin/true"])
        child.wait()
        return child.pid

    def test_admitted_iff_lr_leases_read_only_decision_grants_and_no_lease_is_made(self):
        self.assertLessEqual(self.threshold, 12.9)
        self.assertIsNone(self.check(12.9))
        self.assertIsNone(self.check(self.threshold))
        refused = self.check(self.threshold - 0.05)
        self.assertIn("lr-lease would not grant vm", refused)
        self.assertEqual(self.leases(), [])
        self.assertFalse(os.path.exists(self.calls))  # lr-lease never ran: nothing acquired, nothing to release

    def test_a_dead_unmanaged_rig_lease_does_not_block_but_a_live_or_cleanup_required_one_does(self):
        dead = self.lease("rig", self.dead_pid())
        self.assertIsNone(self.check(100))  # rig-run's own `lr-reap --run rig` removes it first
        self.assertEqual(self.leases(), [dead + ".json"])  # left for rig-run, not removed by the check
        os.unlink(os.path.join(self.home, ".long-run/leases", dead + ".json"))
        self.lease("rig", os.getpid())
        self.assertIn("count limit", self.check(100))
        for name in self.leases():
            os.unlink(os.path.join(self.home, ".long-run/leases", name))
        self.lease("rig", self.dead_pid(), cleanup=True)  # reaped into quarantine, never removed: it blocks
        self.assertIn("lr-lease would not grant vm", self.check(100))
        for name in self.leases():
            os.unlink(os.path.join(self.home, ".long-run/leases", name))
        self.lease("someone-else", self.dead_pid())  # another run's: lr-reap --run rig does not touch it
        self.assertIn("count limit", self.check(100))

    def test_a_timeout_or_a_changed_core_is_an_explicit_refusal(self):
        self.write("home/.long-run/bin/lr-lease-core.mjs", "await new Promise(() => setTimeout(() => {}, 60000));\n")
        started = time.monotonic()
        why = self.check(100, timeout=2)
        self.assertLess(time.monotonic() - started, 10)
        self.assertIn("admission unknown", why)
        self.write("home/.long-run/bin/lr-lease-core.mjs", "export function decision(a, b) { return null; }\n")
        why = self.check(100)
        self.assertIn("admission unknown", why)
        self.assertIn("decision", why)

    def policy_copy(self, change):
        with open(self.POLICY) as fh:
            data = json.load(fh)
        change(data)
        return self.write("policy-{}.json".format(len(os.listdir(self.root))), json.dumps(data))

    def test_the_policy_is_the_one_recorded_at_enqueue_and_a_change_refuses(self):
        # The recorded file is the one read, not the one under HOME: here its vm floor needs 20 + 6 + 2 GiB.
        recorded = self.policy_copy(lambda d: d["kinds"]["vm"].__setitem__("diskFloorGB", 20))
        admission = self.admission(recorded)
        self.assertIn("low disk", self.check(12.9, admission=admission))
        with open(recorded, "a") as fh:
            fh.write("\n")
        self.assertEqual(self.check(100, admission=admission), "lease-policy.json changed since enqueue; re-enqueue")

    def test_a_dead_owners_cleanup_required_lease_counts_as_quarantined(self):
        # maxCount 2 (the review's case): counted as one active lease it would leave room, but reap quarantines it,
        # and a quarantined lease blocks its kind.
        recorded = self.policy_copy(lambda d: d["kinds"]["vm"].__setitem__("maxCount", 2))
        admission = self.admission(recorded)
        self.assertIsNone(self.check(100, admission=admission))
        self.lease("someone-else", self.dead_pid(), cleanup=True)
        self.assertIn("quarantined", self.check(100, admission=admission))

    def test_reaps_source_must_be_a_pinned_one(self):
        with open(os.path.join(self.bin, "lr-lease-core.mjs")) as fh:
            core = fh.read()
        line = "      const started = readers.pidStartedAt(lease.ownerPid);"
        self.assertEqual(core.count(line), 1)
        self.write("home/.long-run/bin/lr-lease-core.mjs", core.replace(line, "      const started = 0;"))
        why = self.check(100)
        self.assertIn("admission unknown", why)
        self.assertIn("reap", why)

    def test_the_stop_target_patched_core_passes(self):
        patch = os.path.join(os.path.dirname(caret_heavy.QUEUE), "../docs/proposals/lr-lease-stop-target/lr-lease.patch")
        if not os.path.isfile(patch):
            self.skipTest("the stop-target proposal is not in the queue checkout")
        work = os.path.join(self.root, "patched")
        os.makedirs(work)
        for name in ("lr-lease-core.mjs", "lr-lease-cli.mjs", "lr-lease.test.mjs"):
            shutil.copy2(os.path.join(os.path.dirname(self.CORE), name), work)
        done = subprocess.run(["patch", "-p1", "-s", "-d", work], stdin=open(patch), capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        with open(os.path.join(work, "lr-lease-core.mjs")) as fh:
            core = fh.read().replace("export function machineReaders(root) {", "function realMachineReaders(root) {")
        with open(os.path.join(self.bin, "lr-lease-core.mjs")) as fh:
            stub_tail = fh.read().split("function realMachineReaders(root) {", 1)[1]
        self.write("home/.long-run/bin/lr-lease-core.mjs",
                   core + "\nexport function machineReaders(root) {" + stub_tail.split("\nexport function machineReaders(root) {", 1)[1])
        self.assertIsNone(self.check(12.9))
        self.assertIn("lr-lease would not grant vm", self.check(self.threshold - 0.05))

    def test_exactly_at_the_threshold_lr_lease_grants_and_rig_runs_clone_gate_does_not(self):
        # Known, kept visible (coordinator, 2026-10-07): lr-lease grants vm at exactly floor + 6 + 2 = 12.0 GiB free,
        # while rig-run's own clone gate needs strictly more than 12 GiB. Changing that gate is a separate decision.
        self.assertEqual(self.threshold, 12)
        self.assertIsNone(self.check(12.0))
        with open(os.path.expanduser("~/.long-run/rig/bin/rig-run")) as fh:
            self.assertIn('[ "$FREE_BEFORE_CLONE" -gt $(( 12 * 1048576 )) ]', fh.read())

    def supervisor(self):
        import procs
        import supervise

        class Probes:
            def pressure_level(self):
                return procs.PRESSURE_NORMAL

            def free_bytes(self, path):
                return 0  # no floor of its own: this must not matter

            def usage(self, pid):
                return procs.DarwinProbes().usage(pid)  # the runner's identity, read for real

        sup = supervise.Supervisor.__new__(supervise.Supervisor)
        sup.plan = {"job_id": "caret-x", "worktree": self.root, "admission": self.admission()}
        sup.run_root = os.path.join(self.root, "runs", "caret-x")
        sup.paths = {"hold": os.path.join(self.root, "HOLD"), "lr_lease": self.lr_lease,
                     "queue_state": os.path.join(self.root, "queue")}
        sup.profile = caret_heavy.dataclasses.asdict(caret_heavy.PROFILES["caret-vm"])
        sup.probes, sup.pid, sup.heavy_fd, sup.lock_fd, sup.lease_id = Probes(), os.getpid(), None, None, None
        sup.lease_cleanup = sup.lease_oblige = sup.lease_obliged = False
        sup.custody, sup.record, sup.log, sup.runner = None, {}, lambda *a, **k: None, None
        import threading
        sup.cancel, sup.cancel_reason, sup.cancel_code = threading.Event(), None, None
        old = os.environ.get("HOME")
        self.addCleanup(lambda: os.environ.__setitem__("HOME", old))
        os.environ["HOME"] = self.home
        return sup

    def test_the_supervisor_admits_on_the_grant_and_ends_75_on_the_refusal_without_waiting(self):
        sup = self.supervisor()
        os.environ["STUB_FREE_GIB"] = "12.9"
        self.addCleanup(os.environ.pop, "STUB_FREE_GIB", None)
        self.assertIs(sup._admit(), True)
        os.environ["STUB_FREE_GIB"] = str(self.threshold - 0.05)
        started = time.monotonic()
        code, why = sup._admit()
        self.assertEqual(code, 75)
        self.assertIn("lr-lease would not grant vm", why)
        self.assertLess(time.monotonic() - started, 15)  # no wait under heavy.lock
        self.assertEqual(self.leases(), [])

    def test_hold_or_runner_death_during_the_check_refuses(self):
        import supervise
        real = supervise.vm_check
        for what in ("hold", "runner"):
            with self.subTest(what):
                sup = self.supervisor()
                os.environ["STUB_FREE_GIB"] = "100"
                self.addCleanup(os.environ.pop, "STUB_FREE_GIB", None)

                def during(*args, **kwargs):
                    if what == "hold":
                        self.write("HOLD", "test\n")
                    else:
                        sup.runner = [999999, 1]  # a runner identity that is not alive
                    return real(*args, **kwargs)
                with mock.patch.object(supervise, "vm_check", side_effect=during):
                    code, why = sup._admit()
                self.assertEqual(code, 75 if what == "hold" else supervise.EXIT_CANCELLED, why)
                self.assertIn("HOLD" if what == "hold" else "runner", why)
                if os.path.exists(os.path.join(self.root, "HOLD")):
                    os.unlink(os.path.join(self.root, "HOLD"))

    def test_the_derived_queue_floor_follows_the_policy_file(self):
        policy = os.path.join(self.root, "policy.json")
        with open(self.POLICY) as fh:
            data = json.load(fh)
        for vm_floor in (4, 5.5):
            with self.subTest(vm_floor):
                data["kinds"]["vm"]["diskFloorGB"] = vm_floor
                with open(policy, "w") as fh:
                    json.dump(data, fh)
                paths = dict(caret_heavy.default_paths("/tmp/state-for-argv-only"), lease_policy=policy)
                plan = caret_heavy.build_plan(caret_heavy.RECIPES["vm-cancel-proof"], "caret-x", "/w", "a" * 40, [], [],
                                              {}, None, paths, ("/snap", {}, "/ops", "b" * 40))
                head = caret_heavy.queue_enqueue_argv(plan, "/plans/caret-x.json", "c" * 64)
                head = head[:head.index("--")]
                self.assertEqual(float(head[head.index("--min-free-gib") + 1]), vm_floor + 6 + 2)
                import hashlib
                with open(policy, "rb") as fh:
                    digest = hashlib.sha256(fh.read()).hexdigest()
                self.assertEqual(plan["admission"], {"kind": "vm", "queue_min_free_gib": vm_floor + 6 + 2,
                                                     "vm_floor_gib": vm_floor, "est_mem_gib": 6, "est_disk_gib": 2,
                                                     "source": policy, "policy_sha256": digest})


class QueueLeaseRunTest(Temp):
    """The run name the supervisor obliges the queue's lease with: HEAVY_JOB_QUEUE_LEASE_RUN when the queue passes it
    (heavy-job-queue ac3e70c and later), which must be the lease record's own run; heavy-job-queue otherwise."""

    def supervisor(self, run_in_record):
        import supervise
        lease_id = "11111111-2222-4333-8444-555555555555"
        status = self.write("lr-lease", "#!/bin/sh\n[ \"$1\" = status ] || exit 2\necho 'Readings (stub)'\necho 'Leases: 1'\n"
                                        "echo '{}'\n".format(json.dumps({"id": lease_id, "run": run_in_record, "kind": "heavy"})))
        os.chmod(status, 0o755)
        sup = supervise.Supervisor.__new__(supervise.Supervisor)
        sup.paths, sup.queue_lease = {"lr_lease": status}, lease_id
        return sup

    def test_the_named_run_is_used_and_must_be_the_records(self):
        import procs
        sup = self.supervisor("heavy-job-queue-v2")
        with mock.patch.dict(os.environ, {"HEAVY_JOB_QUEUE_LEASE_RUN": "heavy-job-queue-v2"}):
            self.assertEqual(sup._queue_lease_run(), "heavy-job-queue-v2")
        with mock.patch.dict(os.environ, {"HEAVY_JOB_QUEUE_LEASE_RUN": "someone-else"}):
            with self.assertRaisesRegex(procs.Refusal, "HEAVY_JOB_QUEUE_LEASE_RUN"):
                sup._queue_lease_run()

    def test_without_it_an_older_queues_run_name_and_no_lookup(self):
        import supervise
        sup = self.supervisor("heavy-job-queue")
        sup.paths = {"lr_lease": "/nonexistent/lr-lease"}  # not consulted
        env = {k: v for k, v in os.environ.items() if k != "HEAVY_JOB_QUEUE_LEASE_RUN"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(sup._queue_lease_run(), supervise.QUEUE_LEASE_RUN)
