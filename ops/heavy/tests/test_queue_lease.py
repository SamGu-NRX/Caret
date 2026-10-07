"""Against the shared queue since 401c4d1, which takes a heavy lr-lease per job (owner: its runner) and needs the
job's estimates at enqueue. The supervisor uses that lease instead of taking a second one, which lr-lease's heavy
count limit of 1 would refuse; VM jobs, whose rig-run takes its own heavy lease, are refused at enqueue for now."""

import os
import unittest

from support import World, profile  # first: puts ops/heavy on sys.path
import manifest  # noqa: E402


class QueueHoldsTheLease(World):
    def test_the_job_runs_under_the_queues_lease_and_takes_none_of_its_own(self):
        job_id, _ = self.enqueue(["spawn", "4"], profile=profile(grace=3))
        self.assertEqual((self.job(job_id)["est_mem_gib"], self.job(job_id)["est_disk_gib"]), (0.1, 0.1))
        self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120),
                        self.queue_log(job_id))
        [lease] = self.leases()
        self.assertEqual((lease["run"], lease["kind"], lease["id"]), ("heavy-job-queue", "heavy", self.job(job_id)["lease_id"]))
        self.assertTrue(self.contender_blocked())
        self.assertTrue(self.wait_for(lambda: self.outcome(job_id) and "exit" in self.outcome(job_id), 90))
        outcome = self.outcome(job_id)
        self.assertEqual((outcome["exit"], outcome["cleanup"]), (0, "clean"), outcome["reason"])
        self.assertEqual((outcome["lease"]["id"], outcome["lease"]["queue_lease"]), (None, lease["id"]))
        self.assertTrue(self.wait_for(lambda: self.leases() == [], 20))
        self.assertTrue(self.wait_for(lambda: not self.contender_blocked(), 20))

    def test_vm_jobs_are_refused_at_enqueue_while_the_queue_holds_the_heavy_lease(self):
        with self.assertRaisesRegex(manifest.ManifestError, "rig-run's own heavy lease"):
            self.enqueue(["ok"], profile=profile(lease=False))
        self.assertFalse(os.path.exists(os.path.join(self.paths["queue_state"], "jobs")) and
                         os.listdir(os.path.join(self.paths["queue_state"], "jobs")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
