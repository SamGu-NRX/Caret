"""The memory watchdog: every job's peak physical footprint is recorded, and a profile's mem_cap_gib stops a job that
goes over it (exit 76). Laya cannot be enqueued without a cap. Real processes that touch at most 200 MB."""

import json
import os
import subprocess
import sys
import time
import unittest

from support import PY, World, profile  # first: puts ops/heavy on sys.path
import caret_heavy  # noqa: E402
import manifest  # noqa: E402
import procs  # noqa: E402
import supervise  # noqa: E402

MB = 1 << 20


class FootprintProbe(unittest.TestCase):
    def test_footprint_and_its_lifetime_maximum(self):
        child = subprocess.Popen([PY, "-c", "import mmap, sys, time\n"
                                  "m = mmap.mmap(-1, 100 << 20)\n"
                                  "for i in range(0, len(m), 4096): m[i] = 1\n"
                                  "print('touched', flush=True); sys.stdin.readline(); m.close()\n"
                                  "print('freed', flush=True); sys.stdin.readline()"],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(child.stdout.close)
        self.addCleanup(child.stdin.close)
        self.addCleanup(lambda: child.poll() is None and (child.kill(), child.wait()))
        probes = procs.DarwinProbes()
        self.assertEqual(child.stdout.readline().strip(), "touched")
        now, peak = probes.footprint(child.pid)
        self.assertGreaterEqual(now, 95 * MB)
        child.stdin.write("\n")
        child.stdin.flush()
        self.assertEqual(child.stdout.readline().strip(), "freed")
        now, peak = probes.footprint(child.pid)
        self.assertLess(now, 50 * MB)
        self.assertGreaterEqual(peak, 95 * MB)  # the peak survives the free, between any two samples
        child.stdin.write("\n")
        child.stdin.flush()
        child.wait()
        self.assertIsNone(probes.footprint(child.pid))


class LayaNeedsACap(unittest.TestCase):
    def test_laya_is_refused_without_a_memory_cap_and_takes_the_one_given(self):
        laya = caret_heavy.RECIPES["laya"]
        with self.assertRaisesRegex(manifest.ManifestError, "--mem-cap-gib"):
            caret_heavy.capped_profile(laya, None, None)
        for bad in (0, -1, 65):
            with self.assertRaises(manifest.ManifestError):
                caret_heavy.capped_profile(laya, None, bad)
        self.assertEqual(caret_heavy.capped_profile(laya, None, 6).mem_cap_gib, 6)
        self.assertEqual(caret_heavy.capped_profile(caret_heavy.RECIPES["helper-window"], None, None).mem_cap_gib, 0)
        done = subprocess.run([PY, os.path.join(os.path.dirname(caret_heavy.__file__), "caret_heavy.py"), "enqueue",
                               "laya", "caret-x", "--worktree", "/nonexistent", "--rev", "0" * 40],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)  # argparse: the cap is a required option
        self.assertIn("--mem-cap-gib", done.stderr)


class Watchdog(World):
    def run_alloc(self, mb, hold, cap):
        prof = profile(grace=10)
        if cap:
            prof = caret_heavy.dataclasses.replace(prof, mem_cap_gib=cap)
        job_id, _ = self.enqueue(["alloc", str(mb), str(hold)], profile=prof)
        self.run_queue("--once", "--max-wait", "120").wait(timeout=300)
        outcome = self.outcome(job_id)
        self.assertIsNotNone(outcome, self.queue_log(job_id))
        return job_id, outcome

    def test_the_peak_is_recorded_for_every_job(self):
        job_id, outcome = self.run_alloc(150, 2, None)
        self.assertEqual((outcome["exit"], outcome["cleanup"]), (0, "clean"), outcome["reason"])
        memory = outcome["memory"]
        self.assertIsNone(memory["cap_gib"])
        self.assertGreaterEqual(memory["peak_total_bytes"], 140 * MB)
        self.assertGreaterEqual(max(memory["process_lifetime_max_bytes"].values()), 140 * MB)
        self.assertGreater(memory["samples"], 0)
        with open(os.path.join(self.run_root(job_id), "memory.ndjson")) as fh:
            series = [json.loads(line) for line in fh]
        self.assertTrue(series and all("total_bytes" in s for s in series))

    def test_a_job_over_its_cap_is_stopped_with_76_and_cleaned_up(self):
        job_id, outcome = self.run_alloc(200, 60, 0.1)  # 0.1 GiB cap: about 102 MB
        self.assertEqual(outcome["exit"], supervise.EXIT_MEMORY_CAP, outcome["reason"])
        self.assertIn("memory cap of 0.1 GiB", outcome["reason"])
        self.assertEqual(outcome["cleanup"], "clean")
        self.assertGreater(outcome["memory"]["peak_total_bytes"], 0.1 * (1 << 30))
        stopped = [e for e in outcome["events"] if e["event"].startswith("stopping: memory cap")]
        self.assertTrue(stopped)
        self.assertFalse(os.path.exists(os.path.join(self.run_root(job_id), "out", "page-loop.json")))
        self.assertEqual(self.marked(job_id), [])
        self.assertTrue(self.wait_for(self.both_free, 20))


if __name__ == "__main__":
    unittest.main(verbosity=2)
