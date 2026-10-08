"""The test world's teardown stops everything the world started, even when a test ends while its job is mid-run: no
relay, supervisor or other process whose arguments name the world survives it. (2026-10-07: eleven relays and
supervisors from failed tests were found orphaned for hours, holding their deleted worlds' locks.)"""

import os
import signal
import unittest

from support import World, profile, world_processes  # first: puts ops/heavy on sys.path


class TeardownLeavesNothing(unittest.TestCase):
    def test_a_world_torn_down_mid_job_leaves_no_process_of_it(self):
        class _World(World):  # defined here, so the loader does not collect it as a test of its own
            def runTest(self):
                pass
        world = _World()
        world.setUp()
        root = world.root
        # Whatever this test's own world leaves is stopped here, by exact pid, so a failing run leaks nothing either.
        self.addCleanup(lambda: [os.kill(pid, signal.SIGKILL) for pid, _ in world_processes(root)])
        job_id, _ = world.enqueue(["spawn", "600"], profile=profile(grace=3))
        world.run_queue("--once", "--max-wait", "120")
        self.assertTrue(world.wait_for(lambda: os.path.exists(os.path.join(world.run_root(job_id), "out", "ready")), 120))
        self.assertTrue(any(" relay" in cmd for _, cmd in world_processes(root)))
        world.doCleanups()  # the test ends here, its job still running
        self.assertEqual(world_processes(root), [])


class NoAgentIsBootedOutWhileItsReloaderLives(unittest.TestCase):
    """A live supervisor loads its recovery agent again when the agent is gone (Custody._ensure_loaded). The teardown
    must stop every such process before it boots agents out; otherwise an agent comes back between the stages, and
    with the world deleted it fails its boot check and launchd restarts it for good. launchd is a stand-in here: a
    bootout while the stand-in supervisor lives reloads the agent at once, so the order is checked deterministically."""

    def test_the_supervisors_die_before_the_single_sweep(self):
        import subprocess
        import sys
        from unittest import mock
        import procs

        class _World(World):
            def runTest(self):
                pass
        world = _World()
        world.setUp()
        job_id = "caret-test-reload-{}".format(os.getpid())
        world.jobs.append(job_id)
        # Its command line names the world, as a supervisor's does.
        supervisor = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)",
                                       os.path.join(world.root, "supervisor-stand-in")])
        self.addCleanup(lambda: (supervisor.poll() is None and supervisor.kill(), supervisor.wait()))
        loaded, reloads, bootouts = {"caret-heavy-recovery.{}.a".format(job_id)}, [], []

        def launchd_jobs(prefix, uid=None):
            return [(label, None) for label in sorted(loaded) if label.startswith(prefix)]

        def launchd_bootout(label, uid=None):
            bootouts.append(label)
            loaded.discard(label)
            if supervisor.poll() is None:
                loaded.add(label)
                reloads.append(label)
            return 0
        with mock.patch.object(procs, "launchd_jobs", launchd_jobs), mock.patch.object(procs, "launchd_bootout",
                                                                                       launchd_bootout):
            world.doCleanups()
        self.assertIsNotNone(supervisor.poll())
        self.assertEqual((reloads, sorted(loaded)), ([], []))
        self.assertEqual(bootouts, ["caret-heavy-recovery.{}.a".format(job_id)])  # one sweep


class AFailingTestKeepsItsWorld(unittest.TestCase):
    """A failing test's world (queue logs, journals, outcomes, run directories) is kept and its path printed, so an
    exception inside a relay or supervisor can be read afterwards. A passing test's is removed."""

    def run_world(self, fail):
        import io
        import shutil
        import sys

        class _World(World):
            def runTest(self):
                open(os.path.join(self.root, "marker"), "w").close()
                if fail:
                    self.fail("deliberately")
        world = _World()
        err = io.StringIO()
        stderr, sys.stderr = sys.stderr, err
        try:
            result = unittest.TestResult()
            world.run(result)
        finally:
            sys.stderr = stderr
        self.addCleanup(shutil.rmtree, world.root, True)
        return world.root, result, err.getvalue()

    def test_a_failing_world_is_kept(self):
        root, result, err = self.run_world(fail=True)
        self.assertEqual(len(result.failures), 1)
        self.assertTrue(os.path.exists(os.path.join(root, "marker")))
        self.assertIn(root, err)

    def test_a_passing_world_is_removed(self):
        root, result, err = self.run_world(fail=False)
        self.assertTrue(result.wasSuccessful(), result.errors)
        self.assertFalse(os.path.exists(root))


if __name__ == "__main__":
    unittest.main(verbosity=2)
