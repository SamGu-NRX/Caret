"""Queue lanes, end to end against heavy-job-queue feat/queue-lanes (e21588d): a browser-lane job runs in its browser
slot, with the slot lock the queue names (HEAVY_JOB_QUEUE_SLOT_LOCK), its browser lease, and never heavy.lock; a heavy
job on that queue keeps slot.lock. A browser-lane job whose process opens an on-screen window is stopped (exit 77)."""

import json
import os
import time
import unittest

from support import World, profile  # first: puts ops/heavy on sys.path
import supervise  # noqa: E402

LANES_REV = "e21588d6f17288ba7c46f3b24a8fafa9c62c931a"


def finished(world, job_id):
    outcome = world.outcome(job_id)
    return outcome is not None and "exit" in outcome


class Lanes(World):
    QUEUE_REV = LANES_REV

    def slot(self, name):
        return os.path.join(self.paths["queue_state"], name)

    def adopted_slot(self, job_id):
        return [r.get("slot_path") for r in self.journal(job_id) if r["event"] == "adopted"]

    def test_a_browser_job_runs_in_its_browser_slot_without_heavy_lock(self):
        # The job holds at its barrier until the lock assertions are done: with a fixed sleep it could finish, and
        # free its slot, before they ran (347f8ea review, P3).
        job_id, _ = self.enqueue(["spawn-held"], profile=profile(grace=3, lease_kind="browser"))
        self.assertEqual(self.job(job_id).get("lease_kind"), "browser")
        self.run_queue("--lane", "browser", "--once", "--max-wait", "120")
        out = os.path.join(self.run_root(job_id), "out")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(out, "ready")), 120), self.queue_log(job_id))
        try:
            self.assertFalse(self.lock_busy(self.paths["heavy_lock"]))  # never taken, by the runner or the job
            self.assertTrue(any(self.lock_busy(self.slot(n)) for n in ("slot-browser-1.lock", "slot-browser-2.lock")))
            self.assertFalse(finished(self, job_id))
        finally:
            open(os.path.join(out, "release"), "w").close()
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 120), self.queue_log(job_id))
        outcome = self.outcome(job_id)
        self.assertEqual((outcome["exit"], outcome["cleanup"]), (0, "clean"), outcome["reason"])
        self.assertIn(os.path.basename(outcome["slot_lock"]), ("slot-browser-1.lock", "slot-browser-2.lock"))
        self.assertEqual(set(self.adopted_slot(job_id)), {outcome["slot_lock"]})
        self.assertEqual(outcome["lane"], "browser")

    def test_a_heavy_job_on_the_lanes_queue_keeps_slot_lock(self):
        job_id, _ = self.enqueue(["ok"], profile=profile(grace=3))
        self.run_queue("--once", "--max-wait", "120").wait(timeout=300)
        outcome = self.outcome(job_id)
        self.assertEqual(outcome["exit"], 0, outcome["reason"])
        self.assertEqual(outcome["slot_lock"], self.slot("slot.lock"))
        self.assertEqual(set(self.adopted_slot(job_id)), {self.slot("slot.lock")})

    def test_a_browser_job_whose_process_opens_a_window_is_stopped(self):
        owners = os.path.join(self.root, "window-owners")
        job_id, _ = self.enqueue(["spawn", "600"], profile=profile(grace=3, lease_kind="browser"),
                                 test={"window_owners_file": owners})
        self.run_queue("--lane", "browser", "--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120),
                        self.queue_log(job_id))
        child = self.spawned(job_id)["detached-group"]
        with open(owners, "w") as fh:
            fh.write("{}\n".format(child))  # a process of the job now owns an on-screen window
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 60), self.queue_log(job_id))
        outcome = self.outcome(job_id)
        self.assertEqual(outcome["exit"], supervise.EXIT_WINDOW, outcome["reason"])
        self.assertIn("on-screen window", outcome["reason"])
        self.assertIn(str(child), outcome["reason"])
        self.assertEqual(outcome["cleanup"], "clean")
        self.assertFalse(self.alive(child))


class WindowList(unittest.TestCase):
    def test_the_on_screen_window_owners_are_read(self):
        import procs
        owners = procs.DarwinProbes().window_owner_pids()
        self.assertTrue(owners and all(isinstance(p, int) and p > 0 for p in owners), owners)


if __name__ == "__main__":
    unittest.main(verbosity=2)
