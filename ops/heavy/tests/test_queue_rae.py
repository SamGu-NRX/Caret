"""RAE's acceptance as recipes/check.py holds it: a copy of rae_acceptance and leak_ok from the RAE harness's
queue_rae.py (~/.caret-run/evidence/host/rae/harness), checked by that harness's own cases (its tests/test_queue_rae.py),
unchanged but for this docstring and the import."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "recipes"))
sys.dont_write_bytecode = True
from check import leak_ok, rae_acceptance  # noqa: E402

OPTS = {"mode": "run", "targets": ["contacts-me", "mail-compose", "usps-address"]}


def data(*rows, opts=OPTS, notes=()):
    return {"harness": "rae", "options": opts, "rows": list(rows), "notes": list(notes)}


def row(tid, status="ran", **k):
    r = {"id": tid, "status": status, "verdict": "complete", "clipboard": "restored", "wrong": "no", "note": ""}
    r.update(k)
    return r


class Acceptance(unittest.TestCase):
    def test_clean_run_with_a_blocked_app_passes(self):
        self.assertEqual(rae_acceptance(data(row("contacts-me"), row("mail-compose", "blocked"), row("usps-address")), OPTS), ([], []))

    def test_missing_row_and_other_options_are_problems(self):
        p, _ = rae_acceptance(data(row("contacts-me"), row("mail-compose", "blocked")), OPTS)
        self.assertEqual(p, ["row usps-address is missing"])
        p, _ = rae_acceptance(data(row("contacts-me"), opts={"mode": "run", "targets": ["contacts-me"]}), OPTS)
        self.assertTrue(p and "options" in p[0])

    def test_clipboard_crash_and_budget_are_failures(self):
        _, f = rae_acceptance(data(row("contacts-me", clipboard="changed"), row("mail-compose", "crashed"), row("usps-address", "budget")), OPTS)
        self.assertEqual(len(f), 3)

    def test_evidence_incomplete_is_a_problem(self):
        p, _ = rae_acceptance(data(row("contacts-me", verdict="evidence-incomplete"), row("mail-compose", "blocked"), row("usps-address")), OPTS)
        self.assertEqual(len(p), 1)

    def test_run_where_nothing_ran_fails(self):
        _, f = rae_acceptance(data(row("contacts-me", "absent"), row("mail-compose", "blocked"), row("usps-address", "unreachable")), OPTS)
        self.assertIn("no target ran", f)

    def test_probe_mode(self):
        opts = {"mode": "probe", "targets": ["contacts-me", "mail-compose"]}
        self.assertEqual(rae_acceptance(data(row("contacts-me", "probed"), row("mail-compose", "blocked"), opts=opts), opts), ([], []))
        p, _ = rae_acceptance(data(row("contacts-me", "ran"), row("mail-compose", "blocked"), opts=opts), opts)
        self.assertTrue(p)

    def test_not_rae_results(self):
        p, _ = rae_acceptance({"harness": None, "rows": []}, OPTS)
        self.assertTrue(p)

    def test_leak_check(self):
        self.assertTrue(leak_ok("CLEAN SCANNED 40", "run"))
        self.assertFalse(leak_ok("NO KEYS (nothing to scan for)", "run"))
        self.assertTrue(leak_ok("NO KEYS (nothing to scan for)", "probe"))
        self.assertFalse(leak_ok("LEAK", "probe"))


if __name__ == "__main__":
    unittest.main()
