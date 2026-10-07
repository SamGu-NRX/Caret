"""Against the shared queue since 401c4d1, which takes a heavy lr-lease per job (owner: its runner) and needs the
job's estimates at enqueue. The supervisor uses that lease instead of taking a second one, which lr-lease's heavy
count limit of 1 would refuse, and obliges it to its attempt. A VM job hands it to rig-run (RIG_HEAVY_LEASE_ID); a
rig-run that cannot take it is refused at enqueue."""

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
        # The installed lr-lease obliges: the queue's lease is this job's, cleanup-required for its attempt.
        self.assertEqual((outcome["lease"]["id"], outcome["lease"]["queue_lease"], outcome["lease"]["obliged"]),
                         (lease["id"], lease["id"], True))
        self.assertTrue(self.wait_for(lambda: self.leases() == [], 20))
        self.assertTrue(self.wait_for(self.both_free, 20))

    def test_vm_jobs_need_a_rig_run_that_is_handed_the_queues_lease(self):
        old = os.path.join(self.root, "old-rig-run")
        with open(old, "w") as fh:
            fh.write("#!/bin/bash\n# takes its own heavy lease\n")
        self.paths["rig_run"] = old
        with self.assertRaisesRegex(manifest.ManifestError, "handed the queue's heavy lease"):
            self.enqueue(["ok"], profile=profile(lease=False))
        self.assertFalse(os.path.exists(os.path.join(self.paths["queue_state"], "jobs")) and
                         os.listdir(os.path.join(self.paths["queue_state"], "jobs")))

    def test_a_vm_jobs_queue_lease_carries_no_estimates(self):
        job_id, _ = self.enqueue(["ok"], profile=profile(lease=False))  # the World's fake rig-run takes the lease
        self.assertEqual((self.job(job_id)["est_mem_gib"], self.job(job_id)["est_disk_gib"]), (0, 0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
