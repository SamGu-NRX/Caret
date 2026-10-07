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


if __name__ == "__main__":
    unittest.main(verbosity=2)
