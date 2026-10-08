"""Astra's design, section 4, tests 1-10: 1-6 and 8-10 for the group-contained profiles (phase A), 7 for VM jobs
(phase C, with a fake rig-run in managed mode).

End-to-end tests run the real queue runner, relay, supervisor and a real launchd recovery agent in a
temporary world (support.World). Exclusion is checked by a separate contender that tries to lock
slot.lock and heavy.lock, not by a recorded status. Probe failures and pid reuse are also checked
in isolation with fake probes and fake commands.
"""

import hashlib
import json
import os
import re
import signal
import subprocess
import time
import unittest
from unittest import mock

from support import QUEUE_LEGACY_REV, HEAVY, PY, World, profile  # first: puts ops/heavy on sys.path
import procs  # noqa: E402
import recovery  # noqa: E402


def finished(world, job_id):
    outcome = world.outcome(job_id)
    return outcome is not None and "exit" in outcome


class Custody(World):
    def wait_clean(self, job_id, by, seconds=90):
        ok = self.wait_for(lambda: any(r["event"] == "clean" for r in self.journal(job_id)), seconds)
        self.assertTrue(ok, (self.journal(job_id), self.queue_log(job_id)))
        self.assertEqual([r["by"] for r in self.journal(job_id) if r["event"] == "clean"], [by])

    def assert_all_released(self, job_id):
        # The live queue leaves a dead runner's lease for lr-lease's reaper (heavy-job-queue 401c4d1).
        subprocess.run([self.paths["lr_reap"]], env=self.env, stdout=subprocess.DEVNULL, check=True)
        self.assertTrue(self.wait_for(self.both_free, 20), "a lock is still held")
        self.assertTrue(self.wait_for(lambda: not self.recovery_agents(job_id), 20), self.recovery_agents(job_id))
        self.assertEqual(self.marked(job_id), [])
        self.assertEqual(self.labels(job_id), [])
        self.assertEqual(self.leases(), [])


class Test1ChildrenOutliveTheirParent(Custody):
    def test_a_child_that_closed_its_descriptors_and_ignores_sigterm_keeps_the_job_held(self):
        job_id, _ = self.enqueue(["stubborn"], profile=profile(grace=4))
        self.run_queue("--once", "--max-wait", "120")
        out = os.path.join(self.run_root(job_id), "out")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(out, "stubborn.pid")), 120))
        with open(os.path.join(out, "stubborn.pid")) as fh:
            child = int(fh.read())
        self.assertTrue(self.wait_for(lambda: "stopping: recipe exited" in self.queue_log(job_id), 30))
        # The parent is gone and the child holds no descriptor, but the job still excludes everyone.
        self.assertTrue(self.alive(child))
        self.assertTrue(self.contender_blocked())
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 60), self.queue_log(job_id))
        self.assertFalse(self.alive(child))  # SIGTERM ignored, so SIGKILL after the grace
        outcome = self.outcome(job_id)
        self.assertEqual((outcome["exit"], outcome["cleanup"]), (0, "clean"), outcome["reason"])
        self.wait_clean(job_id, "supervisor")
        self.assert_all_released(job_id)


class Test2CleanupLongerThanTheQueueGrace(Custody):
    def test_the_queue_sigkills_the_relay_while_cleanup_takes_15_s(self):
        job_id, _ = self.enqueue(["slow-cleanup", "15"], profile=profile(grace=30))
        self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120))
        self.assertEqual(self.queue("cancel", "--id", job_id).returncode, 0)
        self.assertTrue(self.wait_for(lambda: self.job(job_id)["state"] == "cancelled", 25))
        self.assertIn("SIGKILL", self.job(job_id)["outcome_reason"])  # the queue's 10 s ran out
        self.assertTrue(self.contender_blocked())
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 60))
        self.assertTrue(os.path.exists(os.path.join(self.run_root(job_id), "out", "cleanup-done")))
        self.wait_clean(job_id, "supervisor")
        self.assert_all_released(job_id)


class Test3KillEachHolderAtEachBoundary(Custody):
    SUPERVISOR_POINTS = ("supervisor:after-adopt", "supervisor:after-register", "supervisor:after-release",
                         "supervisor:before-settle", "supervisor:after-settle")

    def run_killed(self, point, args=("ok",)):
        job_id, _ = self.enqueue(list(args), test={"kill_at": point}, profile=profile(grace=3))
        self.run_queue("--once", "--max-wait", "120").wait(timeout=300)
        return job_id

    def test_supervisor_death_at_each_boundary_is_finished_by_the_recovery_owner(self):
        for point in self.SUPERVISOR_POINTS:
            with self.subTest(point):
                job_id = self.run_killed(point, ("spawn", "3") if point == "supervisor:after-release" else ("ok",))
                self.assertTrue(os.path.exists(os.path.join(self.run_root(job_id), "test-point-fired")))
                self.wait_clean(job_id, "recovery")
                if point == "supervisor:after-release":
                    for kind, pid in self.spawned(job_id).items():
                        if isinstance(pid, int):
                            self.assertFalse(self.alive(pid), kind)
                self.assert_all_released(job_id)

    def test_recovery_owner_death_at_each_boundary_is_survived(self):
        for point in ("recovery:after-adopt", "recovery:after-register", "recovery:after-clean"):
            with self.subTest(point):
                job_id = self.run_killed(point)
                outcome = self.outcome(job_id)
                self.assertEqual((outcome["exit"], outcome["cleanup"]), (0, "clean"), outcome["reason"])
                self.assertTrue(os.path.exists(os.path.join(self.run_root(job_id), "test-point-fired")))
                adopted = [r for r in self.journal(job_id) if r["event"] == "adopted"]
                if point == "recovery:after-clean":
                    # CLEAN was journalled but its reply died with the owner: the restarted owner replays it.
                    with open(os.path.join(self.run_root(job_id), "recovery", "recovery.log")) as fh:
                        self.assertIn("replaying it to supervisor", fh.read())
                else:
                    self.assertGreaterEqual(len(adopted), 2)  # the restarted owner was adopted again
                self.wait_clean(job_id, "supervisor")
                self.assert_all_released(job_id)

    def test_queue_runner_death_cancels_the_workload(self):
        job_id, _ = self.enqueue(["spawn", "600"], profile=profile(grace=3))
        runner = self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120))
        os.kill(runner.pid, signal.SIGKILL)  # this test's own runner, by exact pid
        runner.wait()
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 60), self.queue_log(job_id))
        outcome = self.outcome(job_id)
        self.assertEqual(outcome["exit"], 143)
        self.assertIn("queue runner", outcome["reason"])
        for kind, pid in self.spawned(job_id).items():
            if isinstance(pid, int):
                self.assertFalse(self.alive(pid), kind)
        self.wait_clean(job_id, "supervisor")
        self.assert_all_released(job_id)


class Test4RecoveryRestartAndDuplicates(Custody):
    def test_a_restarted_recovery_owner_is_adopted_again_and_a_duplicate_owner_steps_aside(self):
        job_id, plan_path = self.enqueue(["spawn", "15"], profile=profile(grace=3))
        self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120))
        with open(os.path.join(self.run_root(job_id), "supervisor.json")) as fh:
            rec = json.load(fh)["recovery"]
        pid = self.agent_pid(rec["label"])
        os.kill(pid, signal.SIGKILL)  # this test's own agent, by exact pid
        self.assertTrue(self.wait_for(lambda: self.agent_pid(rec["label"]) not in (None, pid), 10))
        self.assertTrue(self.wait_for(lambda: len([r for r in self.journal(job_id) if r["event"] == "adopted"]) >= 2, 20))
        # A second owner for the same attempt finds the first one's lock and exits without touching anything.
        import caret_heavy
        with open(plan_path, "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        dup = subprocess.run(caret_heavy.boot_argv(PY, plan_path, digest, "recover", "--socket", rec["socket"],
                                                   "--attempt", rec["attempt"]),
                             env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(dup.returncode, 0, dup.stderr)
        self.assertIn("another recovery owner holds this job", dup.stderr)
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 90), self.queue_log(job_id))
        self.assertEqual(self.outcome(job_id)["exit"], 0, self.outcome(job_id)["reason"])
        self.wait_clean(job_id, "supervisor")
        self.assert_all_released(job_id)

    def agent_pid(self, label):
        out = subprocess.run(["/bin/launchctl", "print", "gui/{}/{}".format(os.getuid(), label)],
                             capture_output=True, text=True).stdout
        m = re.search(r"^\s*pid = (\d+)", out, re.M)
        return int(m.group(1)) if m else None


class Test5LaunchdResource(Custody):
    def test_a_registered_launchd_job_is_booted_out_when_its_caller_and_supervisor_die(self):
        job_id, _ = self.enqueue(["launchd-up"], profile=profile(grace=3))
        self.run_queue("--once", "--max-wait", "120")
        ready = os.path.join(self.run_root(job_id), "out", "ready")
        self.assertTrue(self.wait_for(lambda: os.path.exists(ready), 120), self.queue_log(job_id))
        with open(ready) as fh:
            label = fh.read().strip()
        self.assertTrue(any(r["event"] == "register" and r["resource"].get("label") == label
                            for r in self.journal(job_id)))
        self.assertEqual(procs.launchd_state(label)[0], procs.PRESENT)
        with open(os.path.join(self.run_root(job_id), "supervisor.json")) as fh:
            supervisor = json.load(fh)["supervisor_pid"]
        # The caller dies before reporting success, and the supervisor with it: only the journal knows the job.
        for pid in self.marked(job_id):
            os.kill(pid, signal.SIGKILL)
        os.kill(supervisor, signal.SIGKILL)
        self.wait_clean(job_id, "recovery")
        self.assertEqual(procs.launchd_state(label)[0], procs.ABSENT)
        self.assert_all_released(job_id)

    def test_a_recipe_registers_a_group_it_started_but_not_a_strangers(self):
        """Phase B's path: rig.ts registers Chrome's own process group before releasing it."""
        stranger = subprocess.Popen(["/bin/sleep", "600"], start_new_session=True)
        self.addCleanup(lambda: (stranger.kill(), stranger.wait()))
        job_id, _ = self.enqueue(["group-held", str(stranger.pid)], profile=profile(grace=3))
        self.run_queue("--once", "--max-wait", "120")
        out = os.path.join(self.run_root(job_id), "out")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(out, "ready")), 120), self.queue_log(job_id))
        with open(os.path.join(out, "held.pid")) as fh:
            held = int(fh.read())
        with open(os.path.join(out, "register-group.txt")) as fh:
            self.assertIn("exit 0", fh.read())
        with open(os.path.join(out, "register-stranger.txt")) as fh:
            text = fh.read()
        self.assertIn("exit 1", text)
        self.assertIn("was not started by this job", text)
        groups = [r["resource"]["pgid"] for r in self.journal(job_id)
                  if r["event"] == "register" and r["resource"]["type"] == "group"]
        self.assertIn(held, groups)
        self.assertNotIn(stranger.pid, groups)
        with open(os.path.join(self.run_root(job_id), "supervisor.json")) as fh:
            os.kill(json.load(fh)["supervisor_pid"], signal.SIGKILL)
        self.wait_clean(job_id, "recovery")
        self.assertFalse(self.alive(held))
        self.assertTrue(self.alive(stranger.pid))  # never touched
        self.assert_all_released(job_id)

    def test_registration_outside_the_jobs_prefix_is_refused(self):
        job_id, _ = self.enqueue(["register-bad"])
        self.run_queue("--once", "--max-wait", "120").wait(timeout=300)
        with open(os.path.join(self.run_root(job_id), "out", "register-bad.txt")) as fh:
            text = fh.read()
        self.assertIn("exit 1", text)
        self.assertIn("must start with caret-heavy.{}.".format(job_id), text)
        self.assertFalse(any(r["event"] == "register" and r["resource"]["type"] == "launchd"
                             for r in self.journal(job_id)))


class Test6ProbeFailures(unittest.TestCase):
    """Every probe failure is UNKNOWN, never an empty answer."""

    def script(self, body):
        import tempfile
        d = tempfile.mkdtemp(prefix="caret-heavy-probe-")
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", d]))
        path = os.path.join(d, "tool")
        with open(path, "w") as fh:
            fh.write("#!/bin/sh\n" + body + "\n")
        os.chmod(path, 0o755)
        return path

    def test_lease_status_nonzero_malformed_unexpected_or_slow_is_unknown(self):
        good = "echo 'Readings x'; echo 'Quiet until: none'; echo 'Leases: 1'; echo '{\"id\": \"L1\"}'"
        self.assertEqual(procs.lease_state(self.script(good), "L1")[0], procs.PRESENT)
        self.assertEqual(procs.lease_state(self.script(good), "L2")[0], procs.ABSENT)
        for body in ("echo 'Readings x'; echo 'Leases: 0'; exit 75",
                     "echo 'Readings x'; echo 'Leases: 1'; echo '{not json'",
                     "echo 'something else entirely'",
                     "echo 'Readings x'; echo 'Leases: 1'; echo '[1, 2]'",
                     "sleep 5"):
            with self.subTest(body):
                self.assertEqual(procs.lease_state(self.script(body), "L1", timeout=1)[0], procs.UNKNOWN)

    def test_launchd_print_failure_or_timeout_is_unknown(self):
        self.assertEqual(procs.launchd_state("x", launchctl=self.script("exit 113"))[0], procs.ABSENT)
        self.assertEqual(procs.launchd_state("x", launchctl=self.script("exit 0"))[0], procs.PRESENT)
        self.assertEqual(procs.launchd_state("x", launchctl=self.script("exit 5"))[0], procs.UNKNOWN)
        self.assertEqual(procs.launchd_state("x", launchctl=self.script("sleep 5"), timeout=1)[0], procs.UNKNOWN)

    def test_permission_denied_or_a_failed_listing_is_unknown(self):
        class Probes:
            def group(self, pgid):
                return [500]

            def usage(self, pid):
                raise PermissionError(1, "denied")

            def children(self, pid):
                return []
        self.assertEqual(procs.GroupWatch(Probes(), 500, [500, 1]).inventory()[0], procs.UNKNOWN)

        class Failing(Probes):
            def group(self, pgid):
                raise OSError(5, "proc_listpids failed")
        self.assertEqual(procs.GroupWatch(Failing(), 500, [500, 1]).inventory()[0], procs.UNKNOWN)
        self.assertTrue(procs.alive(Probes(), 500))  # a permission error never means dead


class Test6And9QuarantineHoldsEverything(Custody):
    QUEUE_REV = QUEUE_LEGACY_REV  # the supervisor's own lease, and rig-run's for VM jobs

    def test_an_unknown_lease_status_quarantines_and_blocks_the_next_job_until_it_clears(self):
        flaky = os.path.join(self.home, ".long-run/flaky-status")
        self.paths["lr_lease"] = os.path.join(self.home, ".long-run/bin/lr-lease-flaky")
        first, _ = self.enqueue(["ok"], profile=profile(grace=3))
        second, _ = self.enqueue(["ok"])
        open(flaky, "w").close()
        runner = self.run_queue("--max-wait", "6")
        self.assertTrue(self.wait_for(lambda: any(r["event"] == "quarantined" for r in self.journal(first)), 60),
                        self.queue_log(first))
        self.assertTrue(self.contender_blocked())
        # The queue gives up on the quarantined job (cancel: its relay is SIGKILLed 10 s later) and turns to the next,
        # which cannot get the slot: the supervisor and the recovery owner still hold it.
        self.assertEqual(self.queue("cancel", "--id", first).returncode, 0)
        self.assertEqual(runner.wait(timeout=90), 75)
        self.assertEqual(self.job(first)["state"], "cancelled")
        self.assertEqual(self.job(second)["state"], "queued")
        self.assertTrue(self.contender_blocked())
        self.assertFalse(os.path.exists(self.run_root(second)))
        with open(os.path.join(self.run_root(first), "outcome.json")) as fh:
            self.assertEqual(json.load(fh)["cleanup"], "quarantined")
        os.unlink(flaky)  # the probe recovers; the quarantine clears on a fresh, complete ABSENT
        self.wait_clean(first, "supervisor")
        self.assertTrue(self.wait_for(lambda: finished(self, first) and self.outcome(first)["cleanup"] == "clean", 60))
        self.assertEqual(self.run_queue("--once", "--max-wait", "120").wait(timeout=300), 0)
        self.assertEqual(self.job(second)["state"], "succeeded")
        self.assert_all_released(first)


class JournalReplay(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix="caret-journal-")
        self.addCleanup(subprocess.run, ["rm", "-rf", self.dir])
        self.path = os.path.join(self.dir, "journal.ndjson")

    def test_a_torn_tail_is_repaired_before_the_next_append_survives_replay(self):
        j = recovery.Journal(self.path)
        j.append({"event": "adopted"})
        with open(self.path, "ab") as fh:
            fh.write(b'{"event": "regis')  # a crash mid-append
        self.assertEqual([r["event"] for r in j.load(repair=True)], ["adopted"])
        j.append({"event": "register"})  # acknowledged after the restart
        self.assertEqual([r["event"] for r in recovery.Journal(self.path).load()], ["adopted", "register"])

    def test_interior_corruption_is_refused_not_skipped(self):
        with open(self.path, "wb") as fh:
            fh.write(b'{"event": "adopted"}\nnot json\n{"event": "register"}\n')
        with self.assertRaises(recovery.JournalCorrupt):
            recovery.Journal(self.path).load(repair=True)

    def test_a_failed_append_leaves_nothing_for_the_next_one_to_land_behind(self):
        for failing in ("write", "fsync"):
            with self.subTest(failing):
                os.unlink(self.path) if os.path.exists(self.path) else None
                j = recovery.Journal(self.path)
                j.append({"event": "adopted"})
                real_write, calls = os.write, []

                def write(fd, data):
                    calls.append(1)
                    if failing == "write" and len(calls) > 1:
                        raise OSError(28, "No space left on device")
                    return real_write(fd, bytes(data[:5]) if failing == "write" else data)
                with mock.patch.object(recovery.os, "write", side_effect=write), \
                        mock.patch.object(recovery.os, "fsync", side_effect=OSError(5, "I/O error")
                                          if failing == "fsync" else (lambda fd: None)):
                    with self.assertRaises(OSError):
                        j.append({"event": "register"})  # not acknowledged, so it must not be there
                j.append({"event": "lease"})
                self.assertEqual([r["event"] for r in recovery.Journal(self.path).load()], ["adopted", "lease"])

    def test_a_failed_record_whose_rollback_failed_is_cut_before_the_next_one(self):
        j = recovery.Journal(self.path)
        j.append({"event": "adopted"})
        real_truncate, cuts = os.ftruncate, []

        def ftruncate(fd, size):
            cuts.append(size)
            if len(cuts) == 1:
                raise OSError(5, "I/O error")  # the rollback of the failed record
            return real_truncate(fd, size)
        with mock.patch.object(recovery.os, "fsync", side_effect=OSError(5, "I/O error")), \
                mock.patch.object(recovery.os, "ftruncate", side_effect=ftruncate):
            with self.assertRaises(OSError):
                j.append({"event": "register"})  # written whole, never durable, not acknowledged
        j.append({"event": "lease"})
        self.assertEqual([r["event"] for r in recovery.Journal(self.path).load()], ["adopted", "lease"])

    def test_nothing_is_appended_while_a_failed_record_cannot_be_cut(self):
        j = recovery.Journal(self.path)
        j.append({"event": "adopted"})
        with mock.patch.object(recovery.os, "fsync", side_effect=OSError(5, "I/O error")), \
                mock.patch.object(recovery.os, "ftruncate", side_effect=OSError(5, "I/O error")):
            with self.assertRaises(OSError):
                j.append({"event": "register"})
            with self.assertRaises(OSError):
                j.append({"event": "lease"})  # refused: it would land behind the failed record
        self.assertEqual([r["event"] for r in recovery.Journal(self.path).load()], ["adopted", "register"])
        j.append({"event": "lease"})
        self.assertEqual([r["event"] for r in recovery.Journal(self.path).load()], ["adopted", "lease"])

    def test_a_failed_directory_fsync_fails_the_first_record(self):
        import stat
        real_fsync = os.fsync

        def fsync(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError(5, "I/O error")
            return real_fsync(fd)
        j = recovery.Journal(self.path)
        with mock.patch.object(recovery.os, "fsync", side_effect=fsync):
            with self.assertRaises(OSError):
                j.append({"event": "adopted"})  # its directory entry is not durable: not acknowledged
        j.append({"event": "lease"})
        self.assertEqual([r["event"] for r in recovery.Journal(self.path).load()], ["lease"])

    def test_short_writes_are_completed(self):
        real = os.write
        with mock.patch.object(recovery.os, "write", side_effect=lambda fd, data: real(fd, bytes(data[:3]))):
            recovery.Journal(self.path).append({"event": "adopted", "supervisor": [1, 2]})
        self.assertEqual(recovery.Journal(self.path).load()[0]["supervisor"], [1, 2])


class DiscoveryIsJournalled(unittest.TestCase):
    def test_an_identity_learned_while_answering_is_journalled_before_the_reply(self):
        import tempfile
        d = tempfile.mkdtemp(prefix="caret-discover-")
        self.addCleanup(subprocess.run, ["rm", "-rf", d])
        probes = Test8PidReuseAndStaleRecords.Probes()
        probes.procs[500] = (100, 1, 500, [])
        owner = recovery.Owner.__new__(recovery.Owner)
        owner.probes, owner.journal = probes, recovery.Journal(os.path.join(d, "journal.ndjson"))
        owner.resources, owner.watches = {}, {}
        owner._track({"id": "recipe", "type": "group", "pgid": 500, "leader": [500, 100]})
        probes.procs[501] = (110, 500, 500, [])  # a child, seen first by the inventory below
        results = owner.inventory()
        self.assertEqual(results["recipe"][0], procs.PRESENT)
        members = [r for r in owner.journal.load() if r["event"] == "members"]
        self.assertEqual([tuple(m) for r in members for m in r["add"]], [(501, 110)])
        owner._tick_groups()  # a later tick must not be the first to journal it, nor journal it twice
        self.assertEqual(len([r for r in owner.journal.load() if r["event"] == "members"]), 1)


class OwnerSurvivesCleanupFailures(unittest.TestCase):
    def test_a_launchctl_timeout_during_cleanup_is_unknown_and_the_descriptors_stay(self):
        import tempfile
        d = tempfile.mkdtemp(prefix="caret-owner-")
        self.addCleanup(subprocess.run, ["rm", "-rf", d])
        probes = Test8PidReuseAndStaleRecords.Probes()
        owner = recovery.Owner.__new__(recovery.Owner)
        owner.probes, owner.journal = probes, recovery.Journal(os.path.join(d, "journal.ndjson"))
        owner.plan = {"lease": {"renew_s": 300, "ttl_min": 15}, "test": {}}
        owner.paths, owner.profile = {"lr_lease": "/nonexistent/lr-lease"}, {"term_grace_s": 0}
        owner.resources, owner.watches, owner.fds = {}, {}, {"slot": 99}
        owner.lease, owner.token, owner.attempt = None, None, "a" * 32
        owner.supervisor, owner.state = [424242, 1], "cleanup"  # the supervisor is gone
        owner.term_at = owner.next_kill = None
        owner.lease_renewed = 0
        owner._track({"id": "launchd-prefix", "type": "launchd-prefix", "prefix": "caret-heavy.caret-x."})
        timeout = subprocess.TimeoutExpired(["launchctl"], 20)
        with mock.patch.object(procs, "launchd_jobs", side_effect=timeout), \
                mock.patch.object(procs, "launchd_bootout", side_effect=timeout):
            for _ in range(3):
                owner._tick()  # must not raise
            self.assertEqual(owner.inventory()["launchd-prefix"][0], procs.UNKNOWN)
        self.assertIn(owner.state, ("cleanup", "quarantined"))
        self.assertEqual(owner.fds, {"slot": 99})


class WireDescriptorsAndDeadlines(unittest.TestCase):
    """Received descriptors are owned by the connection and closed on every failure path; framing never blocks the
    owner; the supervisor's side has an I/O deadline."""

    def owner(self):
        import tempfile
        d = tempfile.mkdtemp(prefix="caret-wire-")
        self.addCleanup(subprocess.run, ["rm", "-rf", d])
        owner = recovery.Owner.__new__(recovery.Owner)
        owner.journal = recovery.Journal(os.path.join(d, "journal.ndjson"))
        owner.supervisor, owner.watches, owner.clients, owner.fds = None, {}, {}, {}
        owner.plan, owner.paths, owner.state = {"job_id": "caret-x", "test": {}}, {}, "custody"
        return owner

    def copies(self, target):
        """How many of this process's descriptors refer to *target*'s file."""
        want = os.fstat(target)
        n = 0
        for name in os.listdir("/dev/fd"):
            try:
                st = os.fstat(int(name))
            except OSError:
                continue
            n += (st.st_dev, st.st_ino) == (want.st_dev, want.st_ino)
        return n

    def serve(self, owner, payload, fds=(), close=False):
        import socket
        a, b = socket.socketpair()
        self.addCleanup(a.close)
        owner.clients[b] = recovery.Conn(b)
        if fds:
            socket.send_fds(a, [payload], list(fds))
        else:
            a.sendall(payload)
        if close:
            a.shutdown(socket.SHUT_WR)
        before = time.monotonic()
        owner._serve(b)
        self.assertLess(time.monotonic() - before, 1.0)  # never waits for the rest of a frame
        return a, b

    def test_rejected_frames_close_every_received_descriptor(self):
        import tempfile
        owner = self.owner()
        f = tempfile.TemporaryFile()
        self.addCleanup(f.close)
        for payload, close in ((b"not json\n", False), (b'{"op": "sta', True), (b'{"op": "status"}\n', False)):
            with self.subTest(payload):
                a, b = self.serve(owner, payload, fds=[f.fileno()], close=close)
                if close:
                    self.assertEqual(self.copies(f.fileno()), 2)  # an unfinished frame holds it until its end...
                    owner._serve(b)  # ...which the owner's loop reads next
                    self.assertNotIn(b, owner.clients)
                self.assertEqual(self.copies(f.fileno()), 1)  # only the test's own: the received copy was closed
                if b in owner.clients:
                    owner.clients.pop(b).discard()
                b.close()

    def test_a_partial_frame_waits_for_more_without_blocking(self):
        owner = self.owner()
        a, b = self.serve(owner, b'{"op": "sta')
        self.assertIn(b, owner.clients)  # kept, still waiting for the rest
        a.sendall(b'tus"}\n')
        owner._serve(b)
        reply = recovery.Reader(a).read()[0]
        self.assertEqual(reply["ok"], False)  # status from a stranger is refused, but it was parsed and answered
        b.close()

    def test_a_stalled_owner_times_the_supervisor_out(self):
        import socket
        a, b = socket.socketpair()
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        c = recovery.Custody.__new__(recovery.Custody)
        c.io_timeout = 1.0
        c._attach(a)
        started = time.monotonic()
        with self.assertRaises(OSError):
            c._exchange({"op": "status"})  # b never answers
        self.assertLess(time.monotonic() - started, 5)


class ClientDeadlines(unittest.TestCase):
    """Nothing that talks to the recovery owner or launchd waits forever."""

    def test_register_gives_up_on_an_owner_that_never_answers(self):
        import socket
        import tempfile
        d = tempfile.mkdtemp(prefix="chr.", dir="/tmp")  # a short path: AF_UNIX names are limited
        self.addCleanup(subprocess.run, ["rm", "-rf", d])
        path = os.path.join(d, "s")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(server.close)
        server.bind(path)
        server.listen(1)  # accepted by the kernel, never answered
        env = dict(os.environ, CARET_HEAVY_RECOVERY_SOCKET=path, CARET_HEAVY_REGISTER_TIMEOUT_S="2")
        started = time.monotonic()
        done = subprocess.run([PY, "-I", os.path.join(HEAVY, "register.py"), "launchd", "caret-heavy.caret-x.svc"],
                              env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertLess(time.monotonic() - started, 15)

    def test_the_agent_pid_lookup_has_a_deadline(self):
        c = recovery.Custody.__new__(recovery.Custody)
        c.label = "caret-heavy-recovery.caret-x.00000000"
        calls = []

        def run(*args, **kwargs):
            calls.append(kwargs)
            raise subprocess.TimeoutExpired(args[0], kwargs.get("timeout"))
        with mock.patch.object(recovery.subprocess, "run", side_effect=run):
            self.assertIsNone(c._agent_pid())
        self.assertTrue(calls[0].get("timeout"))


class AdoptionIsAllOrNothing(unittest.TestCase):
    def test_a_refused_descriptor_leaves_none_of_the_others_kept(self):
        import fcntl
        import tempfile
        d = tempfile.mkdtemp(prefix="caret-adopt-")
        self.addCleanup(subprocess.run, ["rm", "-rf", d])
        slot, heavy = os.path.join(d, "slot.lock"), os.path.join(d, "heavy.lock")
        good = os.open(slot, os.O_RDWR | os.O_CREAT)
        fcntl.flock(good, fcntl.LOCK_EX)
        unlocked = os.open(heavy, os.O_RDWR | os.O_CREAT)  # holds no lock: refused
        self.addCleanup(os.close, unlocked)
        owner = recovery.Owner.__new__(recovery.Owner)
        owner.paths, owner.fds = {"slot_lock": slot, "heavy_lock": heavy}, {}
        with self.assertRaises(procs.Refusal):
            owner._adopt_locks(["slot", "heavy"], [good, unlocked])
        self.assertEqual(owner.fds, {})
        os.close(good)


class SlotLockIdentity(unittest.TestCase):
    """P1 (347f8ea review): the owner takes the slot lock the supervisor names only when the path is the regular file
    itself, not a symlink, and journals its (st_dev, st_ino). A later descriptor for the slot must be that same file."""

    def setUp(self):
        import fcntl
        import tempfile
        self.fcntl = fcntl
        d = os.path.realpath(tempfile.mkdtemp(prefix="caret-slot-id-"))
        self.addCleanup(subprocess.run, ["rm", "-rf", d])
        self.state = os.path.join(d, "state")
        os.makedirs(self.state)
        self.slot = os.path.join(self.state, "slot-browser-1.lock")
        self.lock = self.locked(self.slot)
        owner = recovery.Owner.__new__(recovery.Owner)
        owner.journal = recovery.Journal(os.path.join(d, "journal.ndjson"))
        owner.probes = procs.DarwinProbes()
        owner.paths = {"slot_lock": os.path.join(self.state, "slot.lock"), "queue_state": self.state}
        owner.plan = {"job_id": "caret-x", "test": {}, "lane": "browser"}
        owner.attempt, owner.state, owner.supervisor, owner.token, owner.lease = "a" * 32, "waiting", None, None, None
        owner.fds, owner.clients, owner.watches, owner.resources = {}, {}, {}, {}
        owner.adopted_ms = owner.dead_ms = owner.slot_path = None
        self.owner = owner
        self.me = recovery.identity(owner.probes, os.getpid())

    def locked(self, path):
        fd = os.open(path, os.O_RDWR | os.O_CREAT)
        self.addCleanup(os.close, fd)
        self.fcntl.flock(fd, self.fcntl.LOCK_EX)
        return fd

    serve = WireDescriptorsAndDeadlines.serve

    def ask(self, msg, fds=()):
        a, b = self.serve(self.owner, (json.dumps(msg) + "\n").encode(), fds=fds)
        self.addCleanup(b.close)
        return recovery.Reader(a).read()[0]

    def adopt(self, slot_path, fd):
        return self.ask({"op": "adopt", "attempt": self.owner.attempt, "token": "t" * 64, "supervisor": self.me,
                         "locks": ["slot"], "slot_path": slot_path}, fds=[fd])

    def test_a_symlinked_slot_lock_is_refused(self):
        real = os.path.join(os.path.dirname(self.state), "real.lock")
        fd = self.locked(real)
        link = os.path.join(self.state, "slot-browser-2.lock")
        os.symlink(real, link)
        reply = self.adopt(link, fd)
        self.assertFalse(reply["ok"])
        self.assertIn("symlink", reply["error"])
        self.assertEqual(self.owner.fds, {})

    def test_the_adopted_identity_is_journalled_and_a_replaced_file_is_refused(self):
        self.assertTrue(self.adopt(self.slot, self.lock)["ok"])
        st = os.stat(self.slot)
        adopted = [r for r in self.owner.journal.load() if r["event"] == "adopted"]
        self.assertEqual(adopted[-1]["slot_identity"], [st.st_dev, st.st_ino])
        os.unlink(self.slot)
        replaced = self.locked(self.slot)  # the same path, another file
        reply = self.ask({"op": "lock", "name": "slot"}, fds=[replaced])
        self.assertFalse(reply["ok"])
        self.assertIn("identity", reply["error"])
        reply = self.adopt(self.slot, replaced)
        self.assertFalse(reply["ok"])
        self.assertIn("identity", reply["error"])


class SupervisorErrorWithoutAnOwner(Custody):
    def test_an_error_with_no_confirmed_owner_keeps_the_locks_until_one_holds_them(self):
        job_id, _ = self.enqueue(["spawn", "600"], profile=profile(grace=3),
                                 test={"raise_at": "supervisor:after-release", "bootout_owner": True})
        self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120),
                        self.queue_log(job_id))
        # The workload runs and the original owner is gone: the locks must never be free meanwhile.
        for _ in range(10):
            self.assertTrue(self.contender_blocked() or not self.marked(job_id), "locks free while the job runs")
            if finished(self, job_id):
                break
            time.sleep(1)
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 120), self.queue_log(job_id))
        outcome = self.outcome(job_id)
        self.assertEqual(outcome["exit"], 125)
        self.assertIn("cleanup left to the recovery owner", outcome["reason"])
        self.assertGreaterEqual(len([r for r in self.journal(job_id) if r["event"] == "adopted"]), 2)
        self.wait_clean(job_id, "recovery")
        for kind, pid in self.spawned(job_id).items():
            if isinstance(pid, int):
                self.assertFalse(self.alive(pid), kind)
        self.assert_all_released(job_id)


class StateOnlyAfterTheJournal(unittest.TestCase):
    """Custody, leases and discovered identities change in memory only after their journal record is durable. A failed
    append leaves the owner as it was, and closes every descriptor it received."""

    def setUp(self):
        import fcntl
        import tempfile
        d = tempfile.mkdtemp(prefix="caret-state-")
        self.addCleanup(subprocess.run, ["rm", "-rf", d])
        self.slot = os.path.join(d, "slot.lock")
        self.lock = os.open(self.slot, os.O_RDWR | os.O_CREAT)
        self.addCleanup(os.close, self.lock)
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        owner = recovery.Owner.__new__(recovery.Owner)
        owner.journal = recovery.Journal(os.path.join(d, "journal.ndjson"))
        owner.probes = procs.DarwinProbes()
        owner.paths, owner.plan = {"slot_lock": self.slot}, {"job_id": "caret-x", "test": {}}
        owner.attempt, owner.state, owner.supervisor, owner.token, owner.lease = "a" * 32, "waiting", None, None, None
        owner.fds, owner.clients, owner.watches, owner.resources = {}, {}, {}, {}
        owner.adopted_ms = owner.dead_ms = None
        self.owner = owner
        self.me = recovery.identity(owner.probes, os.getpid())

    serve = WireDescriptorsAndDeadlines.serve
    copies = WireDescriptorsAndDeadlines.copies

    def ask(self, msg, fds=()):
        a, b = self.serve(self.owner, (json.dumps(msg) + "\n").encode(), fds=fds)
        self.addCleanup(b.close)
        return recovery.Reader(a).read()[0]

    def adopt(self):
        return self.ask({"op": "adopt", "attempt": self.owner.attempt, "token": "t" * 64, "supervisor": self.me,
                         "locks": ["slot"]}, fds=[self.lock])

    def test_a_failed_adoption_record_keeps_no_descriptor_no_token_and_no_supervisor(self):
        with mock.patch.object(self.owner.journal, "append", side_effect=OSError(28, "No space left on device")):
            self.assertFalse(self.adopt()["ok"])
        self.assertEqual((self.owner.fds, self.owner.token, self.owner.supervisor, self.owner.state),
                         ({}, None, None, "waiting"))
        self.assertEqual(self.copies(self.lock), 1)  # the received copy was closed, not kept in a map
        self.assertTrue(self.adopt()["ok"])  # and a later adoption works
        self.assertEqual(sorted(self.owner.fds), ["slot"])

    def test_a_failed_lock_or_lease_record_changes_nothing(self):
        self.assertTrue(self.adopt()["ok"])
        kept = self.owner.fds["slot"]
        with mock.patch.object(self.owner.journal, "append", side_effect=OSError(28, "No space left on device")):
            self.assertFalse(self.ask({"op": "lease", "id": "l-1", "cleanup": True})["ok"])
            self.assertFalse(self.ask({"op": "lock", "name": "slot"}, fds=[self.lock])["ok"])
        self.assertIsNone(self.owner.lease)
        self.assertEqual(self.owner.fds, {"slot": kept})
        self.assertEqual(self.copies(self.lock), 2)  # the test's and the first adoption's, nothing more
        os.fstat(kept)  # still open

    def test_an_identity_whose_record_failed_is_journalled_by_the_next_tick(self):
        probes = Test8PidReuseAndStaleRecords.Probes()
        probes.procs[500] = (100, 1, 500, [])
        self.owner.probes = probes
        self.owner._track({"id": "recipe", "type": "group", "pgid": 500, "leader": [500, 100]})
        probes.procs[501] = (110, 500, 500, [])
        with mock.patch.object(self.owner.journal, "append", side_effect=OSError(28, "No space left on device")):
            with self.assertRaises(OSError):
                self.owner._tick_groups()
        self.owner._tick_groups()
        members = [tuple(m) for r in self.owner.journal.load() if r["event"] == "members" for m in r["add"]]
        self.assertEqual(members, [(501, 110)])

    def test_a_clean_owner_answers_inventory_and_closes_descriptors_it_does_not_keep(self):
        self.owner.state, self.owner.supervisor = "clean", self.me
        reply = self.ask({"op": "inventory"})
        self.assertEqual((reply["ok"], reply["state"], reply["results"]), (True, "clean", {}))
        self.assertTrue(self.adopt()["ok"])
        self.assertEqual(self.copies(self.lock), 1)
        self.assertEqual(self.owner.fds, {})


class LeaseAcquiredButNotYetRegistered(Custody):
    """The supervisor dies after lr-lease created its lease and before the owner learned the lease's id."""
    QUEUE_REV = QUEUE_LEGACY_REV  # the supervisor's own lease

    def run_case(self):
        job_id, _ = self.enqueue(["ok"], test={"kill_at": "supervisor:after-lease-acquire"})
        self.run_queue("--once", "--max-wait", "120").wait(timeout=300)
        self.assertTrue(os.path.exists(os.path.join(self.run_root(job_id), "test-point-fired")))
        self.wait_clean(job_id, "recovery")
        clean = [r for r in self.journal(job_id) if r["event"] == "clean"][0]
        self.assertTrue(clean.get("reconciled"), clean)
        self.assertEqual(self.leases(), [])  # settled by the owner, not left to quarantine or the reaper
        self.assert_all_released(job_id)

    def test_with_the_live_lr_lease(self):
        self.run_case()


class LeaseAcquiredButNotYetRegisteredCleanupRequired(LeaseAcquiredButNotYetRegistered):
    LEASE_SOURCE = os.path.join(HEAVY, "vendor/long-run/bin")

    def test_with_the_live_lr_lease(self):
        pass  # replaced below

    def test_with_the_vendored_cleanup_required_lease(self):
        self.run_case()


class LeaderStaysUnreaped(Custody):
    QUEUE_REV = QUEUE_LEGACY_REV  # quarantined through the supervisor's own lease status

    def test_the_recipes_leader_is_not_reaped_while_the_job_is_quarantined(self):
        flaky = os.path.join(self.home, ".long-run/flaky-status")
        self.paths["lr_lease"] = os.path.join(self.home, ".long-run/bin/lr-lease-flaky")
        job_id, _ = self.enqueue(["ok"], profile=profile(grace=3))
        open(flaky, "w").close()
        self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: any(r["event"] == "quarantined" for r in self.journal(job_id)), 120),
                        self.queue_log(job_id))
        leader = [r for r in self.journal(job_id) if r["event"] == "register" and r["resource"]["id"] == "recipe"]
        pid = leader[0]["resource"]["pgid"]
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        self.assertTrue(state.startswith("Z"), "leader {} is {!r}: reaped, so its pid could be reused".format(pid, state))
        os.unlink(flaky)
        self.wait_clean(job_id, "supervisor")
        self.assertTrue(self.wait_for(lambda: subprocess.run(["ps", "-p", str(pid)], capture_output=True).returncode != 0, 20))
        self.assert_all_released(job_id)


class MarkerScanFailsClosed(unittest.TestCase):
    """A process of this user that the scan cannot read is UNKNOWN, never assumed unmarked; another user's process is
    excluded only because the kernel lists it under another uid."""

    class Probes(object):
        def __init__(self, mine, procs_):
            self.mine, self.procs = mine, procs_  # pid -> (start, env or None for unreadable, denied?)

        def user_pids(self, uid):
            if self.mine is None:
                raise OSError(5, "sysctl failed")
            return list(self.mine)

        def all_pids(self):
            return list(self.procs)

        def group(self, pgid):
            return []

        def children(self, pid):
            return []

        def usage(self, pid):
            start, env, denied = self.procs[pid]
            if denied:
                raise PermissionError(1, "denied")
            return (1, start)

        def procargs(self, pid):
            env = self.procs[pid][1]
            return None if env is None else (["x"], env)

    marker = {"mark": "caret-x.n", "since": 100}

    def test_unreadable_own_processes_are_unknown(self):
        mark = ["CARET_HEAVY_MARK=caret-x.n"]
        for procs_, why in (({10: (200, None, False)}, "arguments unreadable"),
                            ({11: (200, [], True)}, "usage denied")):
            with self.subTest(why):
                probes = self.Probes(list(procs_), procs_)
                self.assertEqual(recovery.marked_state(probes, self.marker)[0], procs.UNKNOWN)
        probes = self.Probes([12], {12: (200, mark, False), 13: (200, None, True)})  # 13 belongs to another user
        self.assertEqual(recovery.marked_state(probes, self.marker), (procs.PRESENT, [(12, 200)]))
        self.assertEqual(recovery.marked_state(self.Probes(None, {}), self.marker)[0], procs.UNKNOWN)

    def test_the_supervisor_scan_reports_unreadable_candidates_but_never_owns_or_signals_them(self):
        for procs_, why in (({10: (200, None, False)}, "arguments unreadable"), ({10: (200, [], True)}, "usage denied")):
            with self.subTest(why):
                probes = self.Probes([10], procs_)
                probes.children = lambda pid: [11]  # its child would be walked as owned if it were owned
                probes.procs[11] = (210, [], False)
                t = procs.Tracker(probes, "caret-x.n", "caret-heavy.caret-x.", started_abstime=100)
                t.me = -1
                with mock.patch.object(procs, "launchd_jobs", return_value=[]):
                    owned = t.owned(full=True)
                self.assertEqual((owned, t.unverified), ({}, {10}))
                self.assertNotIn(10, t.tracked)
                with mock.patch.object(procs.os, "kill") as kill:
                    t.signal_all(signal.SIGKILL, set(owned) | {10})  # even when asked: never ours by proof
                kill.assert_not_called()


class Test8PidReuseAndStaleRecords(unittest.TestCase):
    class Probes:
        def __init__(self):
            self.procs = {}  # pid -> (start, ppid, pgid, env)

        def group(self, pgid):
            return [p for p, v in self.procs.items() if v[2] == pgid]

        def usage(self, pid):
            return None if pid not in self.procs else (1, self.procs[pid][0])

        def children(self, pid):
            return [p for p, v in self.procs.items() if v[1] == pid]

        def all_pids(self):
            return list(self.procs)

        def user_pids(self, uid):
            return list(self.procs)  # every fake process is this user's

        def procargs(self, pid):
            return ["x"], self.procs[pid][3]

    def test_never_signals_a_reused_pid_an_untraceable_member_or_an_old_marked_process(self):
        probes = self.Probes()
        probes.procs[500] = (100, 1, 500, [])
        probes.procs[501] = (110, 500, 500, [])
        watch = procs.GroupWatch(probes, 500, [500, 100])
        self.assertEqual(watch.inventory()[0], procs.PRESENT)
        # Everything exits; pid 501 comes back as a stranger in another group, and an orphan nobody traced joins 500.
        probes.procs = {501: (300, 1, 777, []), 502: (310, 1, 500, [])}
        state, detail = watch.inventory()
        self.assertEqual(state, procs.UNKNOWN)
        self.assertIn("502", detail)
        with mock.patch.object(os, "kill") as kill:
            self.assertEqual(watch.signal(signal.SIGKILL), [])
        kill.assert_not_called()
        # A stale journal record (restarted owner) naming 501 with its old start time is not 501 now.
        restored = procs.GroupWatch(probes, 500, [500, 100], identities=[(501, 110)])
        restored.tick()
        self.assertNotIn(501, restored.live_verified)
        # A process carrying the marker but started before the job is not the job's.
        probes.procs = {600: (50, 1, 600, ["CARET_HEAVY_MARK=caret-x.n"]), 601: (200, 1, 601, ["CARET_HEAVY_MARK=caret-x.n"])}
        state, found = recovery.marked_state(probes, {"mark": "caret-x.n", "since": 100})
        self.assertEqual((state, found), (procs.PRESENT, [(601, 200)]))
        with mock.patch.object(os, "kill") as kill, mock.patch.object(recovery, "same_process", return_value=False):
            self.assertEqual(recovery.signal_identities(probes, found, signal.SIGKILL), [])
        kill.assert_not_called()


class Test10ReservationsAndCredentials(Custody):
    """With the vendored lr-lease (cleanup-required leases, pending install)."""

    QUEUE_REV = QUEUE_LEGACY_REV  # the supervisor's own lease, and rig-run's for VM jobs

    LEASE_SOURCE = os.path.join(HEAVY, "vendor/long-run/bin")

    def test_owner_death_and_expiry_keep_the_reservation_until_the_recovery_owner_acknowledges(self):
        job_id, _ = self.enqueue(["spawn", "600"], profile=profile(grace=3), lease_ttl_min=0.02, lease_renew_s=10000)
        self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120))
        [lease] = self.leases()
        self.assertTrue(lease["cleanupRequired"])
        time.sleep(2)  # the TTL has passed; the owner is alive
        subprocess.run([self.paths["lr_reap"]], env=self.env, check=True)
        self.assertEqual([l["id"] for l in self.leases()], [lease["id"]])
        with open(os.path.join(self.run_root(job_id), "supervisor.json")) as fh:
            supervisor = json.load(fh)["supervisor_pid"]
        os.kill(supervisor, signal.SIGKILL)
        subprocess.run([self.paths["lr_reap"]], env=self.env, check=True)  # the owner is dead: quarantined, kept
        kept = self.leases()
        self.assertEqual([(l["id"], l.get("state")) for l in kept], [(lease["id"], "quarantined")])
        other = subprocess.run([self.paths["lr_lease"], "acquire", "--run", "rig", "--kind", "heavy", "--est-mem", "0",
                                "--est-disk", "0", "--owner-pid", str(os.getpid())], env=self.env,
                               capture_output=True, text=True)
        self.assertEqual(other.returncode, 75)
        self.assertIn("quarantined lease", other.stdout)
        self.wait_clean(job_id, "recovery")  # the recovery owner acknowledged with the token
        self.assert_all_released(job_id)
        self.assert_no_token_anywhere(lease["tokenSha256"])

    def assert_no_token_anywhere(self, token_sha256):
        """No file this world wrote holds a string whose SHA-256 is the lease's token digest."""
        hexes = set()
        for root, _, names in os.walk(self.root):
            for name in names:
                path = os.path.join(root, name)
                if os.path.islink(path):
                    continue
                with open(path, "rb") as fh:
                    hexes.update(re.findall(rb"[0-9a-f]{64}", fh.read()))
        self.assertTrue(hexes)
        self.assertFalse([h for h in hexes if hashlib.sha256(h).hexdigest() == token_sha256])



class QueueLeaseUntilClean(Custody):
    """The live queue (401c4d1) releases its per-job lease once the relay's process group is empty."""

    def supervisor_pid(self, job_id):
        with open(os.path.join(self.run_root(job_id), "supervisor.json")) as fh:
            return json.load(fh)["supervisor_pid"]

    def held_until(self, done, lease_id, seconds=90):
        """Samples until done(): the moments the lease was missing before then. done() is checked again after the
        lease list, so an end that landed in between does not count as missing."""
        missing = []
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if done():
                return missing
            if lease_id not in [l["id"] for l in self.leases()] and not done():
                missing.append(time.monotonic())
            time.sleep(0.3)
        self.fail("not done within {} s".format(seconds))

    def held_until_clean(self, job_id, lease_id):
        """The relay stays in the queue's group until CLEAN: the queue keeps counting the job as running, and its lease
        (obliged, so acknowledged by the token only once the workload's cleanup is done) outlives that cleanup.
        Returns the moments either was not so."""
        clean = lambda: any(r["event"] == "clean" for r in self.journal(job_id))
        done = lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "cleanup-done"))
        early = []
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline and not clean():
            state = self.job(job_id)["state"]
            listed = lease_id in [l["id"] for l in self.leases()]
            if not clean() and (state != "running" or (not listed and not done())):
                early.append((round(time.monotonic(), 1), state, listed))
            time.sleep(0.3)
        self.assertTrue(clean(), "no CLEAN within 90 s")
        return early

    def test_a_dead_supervisor_leaves_the_relay_holding_the_queue_lease_until_recovery_journals_clean(self):
        job_id, _ = self.enqueue(["slow-cleanup", "12"], profile=profile(grace=30))
        self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120))
        lease_id = self.job(job_id)["lease_id"]
        os.kill(self.supervisor_pid(job_id), signal.SIGKILL)  # this test's own supervisor, by exact pid
        self.assertEqual(self.held_until_clean(job_id, lease_id), [], "the queue's lease went before CLEAN")
        self.assertTrue(os.path.exists(os.path.join(self.run_root(job_id), "out", "cleanup-done")))
        self.wait_clean(job_id, "recovery")
        self.assertTrue(self.wait_for(lambda: self.job(job_id)["state"] not in ("running", "launching"), 30))
        self.assertIn("recovery owner journalled CLEAN", self.queue_log(job_id))
        self.assert_all_released(job_id)


    def test_a_supervisor_error_handed_to_the_owner_keeps_the_queue_lease_until_clean(self):
        # Raised once the recipe is ready (its TERM trap set), so its cleanup takes the full 12 s.
        job_id, _ = self.enqueue(["slow-cleanup", "12"], profile=profile(grace=30),
                                 test={"raise_at": "supervisor:watching", "raise_when": "out/ready"})
        self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 120), self.queue_log(job_id))
        self.assertIn("cleanup left to the recovery owner", self.outcome(job_id)["reason"])
        lease_id = self.job(job_id)["lease_id"]
        self.assertEqual(self.held_until_clean(job_id, lease_id), [], "the queue's lease went before CLEAN")
        self.assertTrue(os.path.exists(os.path.join(self.run_root(job_id), "out", "cleanup-done")))
        self.wait_clean(job_id, "recovery")
        self.assertTrue(self.wait_for(lambda: self.job(job_id)["state"] not in ("running", "launching"), 30))
        self.assertIn("recovery owner journalled CLEAN", self.queue_log(job_id))
        self.assert_all_released(job_id)


class QueueLeaseObliged(QueueLeaseUntilClean):
    """With the vendored lr-lease (pending install): the supervisor makes the queue's lease cleanup-required, so the
    queue's own release after its 10 s SIGKILL of the relay quarantines it rather than dropping it."""

    LEASE_SOURCE = os.path.join(HEAVY, "vendor/long-run/bin")

    def test_a_dead_supervisor_leaves_the_relay_holding_the_queue_lease_until_recovery_journals_clean(self):
        pass  # the parent class covers it

    def test_a_supervisor_error_handed_to_the_owner_keeps_the_queue_lease_until_clean(self):
        pass  # the parent class covers it

    def test_the_queues_lease_outlives_the_queues_release_until_the_cleanup_is_acknowledged(self):
        job_id, _ = self.enqueue(["slow-cleanup", "18"], profile=profile(grace=30))
        self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120))
        lease_id = self.job(job_id)["lease_id"]
        [lease] = self.leases()
        self.assertEqual((lease["id"], lease.get("cleanupRequired")), (lease_id, True))
        self.assertEqual(self.queue("cancel", "--id", job_id).returncode, 0)
        self.assertTrue(self.wait_for(lambda: self.job(job_id)["state"] == "cancelled", 25))
        self.assertIn("SIGKILL", self.job(job_id)["outcome_reason"])  # the queue's 10 s ran out, then it released
        # The queue settles its lease after it records the cancellation: wait for that release to land.
        self.assertTrue(self.wait_for(lambda: [l.get("state") for l in self.leases()] == ["quarantined"], 20),
                        self.leases())
        self.assertNotIn("lease_release_error", self.job(job_id))
        self.assertFalse(os.path.exists(os.path.join(self.run_root(job_id), "out", "cleanup-done")))
        # Still the queue's lease, now quarantined; no second lease was taken over.
        self.assertEqual([(l["id"], l.get("state")) for l in self.leases()], [(lease_id, "quarantined")])
        # Kept while the workload is still cleaning up; acknowledged (so gone) just before the supervisor's CLEAN.
        self.assertEqual(self.held_until(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out",
                                                                             "cleanup-done")), lease_id), [])
        self.wait_clean(job_id, "supervisor")
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 30))  # the outcome is written after CLEAN
        outcome = self.outcome(job_id)
        self.assertNotIn("taken_over_from", outcome["lease"])
        self.assertTrue(outcome["lease"]["obliged"])
        self.assert_all_released(job_id)
        self.assert_no_token_anywhere(lease["tokenSha256"])

    def test_death_between_oblige_and_registration_is_settled_by_attempt(self):
        job_id, _ = self.enqueue(["ok"], test={"kill_at": "supervisor:after-oblige"})
        self.run_queue("--once", "--max-wait", "120").wait(timeout=300)
        self.assertTrue(os.path.exists(os.path.join(self.run_root(job_id), "test-point-fired")))
        self.wait_clean(job_id, "recovery")
        [clean] = [r for r in self.journal(job_id) if r["event"] == "clean"]
        self.assertEqual(clean["reconciled"], [self.job(job_id)["lease_id"]])
        self.assertNotIn("lease_release_error", self.job(job_id))
        self.assert_all_released(job_id)

    assert_no_token_anywhere = Test10ReservationsAndCredentials.assert_no_token_anywhere



VZ_NAME = ("/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/"
           "com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine")


class VmInventoryIsStrict(unittest.TestCase):
    """The recovery owner's vm resource: a failed lookup is UNKNOWN, Lume is matched by its command, and only the job's
    own rig-run can register a VM."""

    class Probes(object):
        def __init__(self, argvs):
            self.argvs = argvs  # pid -> argv

        def user_pids(self, uid):
            return list(self.argvs)

        def usage(self, pid):
            return (1, 500)

        def procargs(self, pid):
            return (self.argvs[pid], [])

    vm = {"id": "vm:rig-run-123", "type": "vm", "name": "rig-run-123", "since": 100}

    def test_a_clone_that_cannot_be_looked_up_is_unknown(self):
        import tempfile
        d = tempfile.mkdtemp(prefix="caret-vm-")
        self.addCleanup(subprocess.run, ["rm", "-rf", d])
        real = os.lstat

        def lstat(path, *args, **kwargs):
            if path == os.path.join(d, "rig-run-123"):
                raise PermissionError(13, "Permission denied", path)
            return real(path, *args, **kwargs)
        with mock.patch.object(recovery.os, "lstat", side_effect=lstat):
            self.assertEqual(recovery.vm_state(self.Probes({}), self.vm, d)[0], procs.UNKNOWN)
        self.assertEqual(recovery.vm_state(self.Probes({}), self.vm, d)[0], procs.ABSENT)

    def test_lume_is_matched_by_its_command_not_by_its_words(self):
        probes = self.Probes({
            10: ["/x/lume", "clone", "run", "rig-run-123"],                  # not running this VM
            11: ["/x/lume", "run", "rig-run-123", "--display", "none"],      # rig-run's own `lume run`
            12: ["/bin/bash", "/x/lume", "run", "rig-run-123"],              # a lume script through its interpreter
            13: ["/x/lume", "run", "rig-run-1234"],                          # another VM
            14: ["/x/notlume", "run", "rig-run-123"],
        })
        state, found = recovery.vm_processes(probes, self.vm)
        self.assertEqual((state, [p for p, _ in found["lume"]]), (procs.PRESENT, [11, 12]))

    def test_only_the_jobs_own_rig_run_can_register_its_vm(self):
        owner = recovery.Owner.__new__(recovery.Owner)
        with mock.patch.object(owner, "_verified", return_value={123}, create=True):
            owner._check_vm_owner({"name": "rig-run-123"})
            with self.assertRaisesRegex(ValueError, "not one of this job's processes"):
                owner._check_vm_owner({"name": "rig-run-999"})


class Test7VirtualizationOutlivesLume(Custody):
    """Design test 7, on the live queue (401c4d1): a VM job hands the queue's lease, obliged to its attempt, to rig-run
    (a fake rig-run in managed mode). A stand-in Virtualization process, started outside the job as launchd starts the
    real one, outlives Lume. Nothing is released and no lease settled while it lives, and it is never signalled; once it
    exits, the job concludes CLEAN with both leases acknowledged."""

    def start_vm(self):
        job_id, _ = self.enqueue(["rig", self.paths["rig_run"], "managed", "2"], profile=profile(lease=False, grace=5))
        self.run_queue("--once", "--max-wait", "120")
        registered = lambda: any(r["event"] == "register" and r["resource"]["type"] == "vm" for r in self.journal(job_id))
        self.assertTrue(self.wait_for(registered, 120), self.queue_log(job_id))
        clones = self.paths["lume_clones"]  # made only after the vm lease, so it may not exist yet
        self.assertTrue(self.wait_for(lambda: len(self.leases()) == 2 and os.path.isdir(clones) and os.listdir(clones), 30))
        vz = subprocess.Popen(["/bin/bash", "-c", 'exec -a "$0" /bin/sleep 600', VZ_NAME], start_new_session=True,
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: vz.poll() is None and (vz.kill(), vz.wait()))  # this test's own child, by exact pid
        leases = {l["kind"]: l for l in self.leases()}
        self.assertEqual(sorted(leases), ["heavy", "vm"])
        self.assertEqual((leases["heavy"]["id"], leases["heavy"]["run"]), (self.job(job_id)["lease_id"], "heavy-job-queue"))
        self.assertEqual(leases["vm"]["run"], "rig")
        self.assertTrue(all(l["cleanupRequired"] for l in leases.values()))
        self.assertEqual(len({l["attempt"] for l in leases.values()}), 1)
        return job_id, vz, leases

    def assert_held_while_virtualization_lives(self, job_id, vz):
        self.assertTrue(self.wait_for(lambda: not os.listdir(self.paths["lume_clones"]), 60))  # rig-run's own cleanup
        time.sleep(8)
        self.assertIsNone(vz.poll(), "the Virtualization stand-in was signalled")
        self.assertFalse(any(r["event"] == "clean" for r in self.journal(job_id)))
        self.assertTrue(self.contender_blocked())
        self.assertEqual(sorted(l["kind"] for l in self.leases()), ["heavy", "vm"])

    def test_a_cancelled_vm_job_waits_for_virtualization_to_exit(self):
        job_id, vz, leases = self.start_vm()
        self.assertEqual(self.queue("cancel", "--id", job_id).returncode, 0)
        self.assert_held_while_virtualization_lives(job_id, vz)
        vz.kill()
        vz.wait()
        self.wait_clean(job_id, "supervisor")
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 30))
        outcome = self.outcome(job_id)
        self.assertEqual(outcome["cleanup"], "clean")
        self.assertTrue(outcome["lease"]["obliged"])
        self.assert_all_released(job_id)

    def test_with_the_supervisor_dead_the_recovery_owner_waits_for_virtualization(self):
        job_id, vz, leases = self.start_vm()
        with open(os.path.join(self.run_root(job_id), "supervisor.json")) as fh:
            os.kill(json.load(fh)["supervisor_pid"], signal.SIGKILL)  # this test's own supervisor, by exact pid
        self.assert_held_while_virtualization_lives(job_id, vz)
        vz.kill()
        vz.wait()
        self.wait_clean(job_id, "recovery")
        [clean] = [r for r in self.journal(job_id) if r["event"] == "clean"]
        self.assertIn(leases["vm"]["id"], clean["reconciled"])  # rig-run's vm lease, settled by the attempt's token
        self.assert_all_released(job_id)


if __name__ == "__main__":
    unittest.main(verbosity=2)
