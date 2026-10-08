"""RAE's acceptance, which recipes/check.py owns: rae_acceptance and leak_ok. Started from the RAE harness's own cases
(~/.caret-run/evidence/host/rae/harness/tests/test_queue_rae.py); rows carry what rae.py's row() writes for a target
that ran."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "recipes"))
sys.dont_write_bytecode = True
from check import leak_ok, rae_acceptance  # noqa: E402

KNOWN = {"contacts-me", "mail-compose", "usps-address", "greenhouse-stop"}
OPTS = {"mode": "run", "targets": ["contacts-me", "mail-compose", "usps-address"]}


def data(*rows, opts=OPTS, notes=()):
    return {"harness": "rae", "options": opts, "rows": list(rows), "notes": list(notes)}


def row(tid, status="ran", **k):
    r = {"id": tid, "status": status, "wrong": "no", "note": ""}
    if status == "ran":
        r.update(verdict="complete", taken=1, right=2, partial=0, kept=1, missed=0, abstained=0, extra=0,
                 clipboard="restored", undone="n/a", stopped="n/a")
    r.update(k)
    return r


OUTCOMES = ("right", "partial", "kept", "missed", "abstained", "extra")


def score_of(r, **k):
    """The score.json rae.py saves for a ran row: one field per counted outcome, a wrong field when the row is wrong."""
    fields = [{"id": "{}-{}".format(o, i), "outcome": o} for o in OUTCOMES for i in range(r[o])]
    if r["wrong"] == "yes":
        fields.append({"id": "wrong-0", "outcome": "wrong"})
    score = {"target": r["id"], "verdict": r.get("verdict"), "wrong": int(r["wrong"] == "yes"), "fields": fields,
             "unexpected": []}
    score.update(k)
    return score


def accept(d, opts=OPTS, scores=None):
    if scores is None:
        scores = {r["id"]: score_of(r) for r in d.get("rows", []) if r.get("status") == "ran" and "right" in r
                  and all(isinstance(r.get(o), int) for o in OUTCOMES) and r.get("wrong") in ("yes", "no")}
    return rae_acceptance(d, opts, KNOWN, scores)


class Acceptance(unittest.TestCase):
    def test_clean_run_with_a_blocked_app_passes(self):
        self.assertEqual(accept(data(row("contacts-me"), row("mail-compose", "blocked"), row("usps-address"))), ([], []))

    def test_missing_row_and_other_options_are_problems(self):
        p, _ = accept(data(row("contacts-me"), row("mail-compose", "blocked")))
        self.assertEqual(p, ["row usps-address is missing"])
        p, _ = accept(data(row("contacts-me"), opts={"mode": "run", "targets": ["contacts-me"]}))
        self.assertTrue(p and "options" in p[0])

    def test_clipboard_crash_and_budget_are_failures(self):
        _, f = accept(data(row("contacts-me", clipboard="changed"), row("mail-compose", "crashed"),
                           row("usps-address", "budget")))
        self.assertEqual(len(f), 3)

    def test_evidence_incomplete_is_a_problem(self):
        p, _ = accept(data(row("contacts-me", verdict="evidence-incomplete"), row("mail-compose", "blocked"),
                           row("usps-address")))
        self.assertEqual(len(p), 1)

    def test_run_where_nothing_ran_fails(self):
        _, f = accept(data(row("contacts-me", "absent"), row("mail-compose", "blocked"), row("usps-address", "unreachable")))
        self.assertIn("no target ran", f)

    def test_a_row_with_zero_takes_has_not_run(self):
        _, f = accept(data(row("contacts-me", taken=0), row("mail-compose", "blocked"), row("usps-address", "absent")))
        self.assertIn("no target ran", f)

    def test_a_failed_stop_or_undo_fails(self):
        _, f = accept(data(row("contacts-me", undone="no"), row("mail-compose", "blocked"), row("usps-address")))
        self.assertEqual(len(f), 1)
        self.assertIn("undo", f[0])
        stop = {"mode": "run", "targets": ["greenhouse-stop"]}
        _, f = accept(data(row("greenhouse-stop", stopped="no"), opts=stop), stop)
        self.assertEqual(len(f), 1)
        self.assertIn("stop", f[0])

    def test_an_unverified_undo_is_named(self):
        # The harness says unverified when an element is missing from the undo read-back: the undo's effect is unknown.
        p, f = accept(data(row("contacts-me", undone="unverified"), row("mail-compose", "blocked"), row("usps-address")))
        self.assertEqual((p, f), (["undo unverified: contacts-me"], []))

    def test_a_ran_row_without_its_scoring_evidence_is_a_problem(self):
        for field in ("verdict", "taken", "right", "partial", "kept", "missed", "abstained", "extra", "clipboard",
                      "wrong", "undone", "stopped"):
            with self.subTest(field):
                bare = row("contacts-me")
                del bare[field]
                p, _ = accept(data(bare, row("mail-compose", "blocked"), row("usps-address")))
                self.assertTrue(any("contacts-me" in x and field in x for x in p), p)
        for field, bad in (("verdict", "great"), ("taken", -1), ("right", "2"), ("clipboard", "?"), ("wrong", "maybe"),
                           ("undone", "perhaps"), ("stopped", True)):
            with self.subTest(bad=field):
                p, _ = accept(data(row("contacts-me", **{field: bad}), row("mail-compose", "blocked"), row("usps-address")))
                self.assertTrue(any("contacts-me" in x and field in x for x in p), p)

    def test_each_ran_row_must_agree_with_its_score_json(self):
        rows = (row("contacts-me"), row("mail-compose", "blocked"), row("usps-address"))
        good = {r["id"]: score_of(r) for r in rows if r["status"] == "ran"}
        self.assertEqual(accept(data(*rows), scores=good), ([], []))
        bad = {
            "missing": dict(good, **{"contacts-me": None}),
            "another target's": dict(good, **{"contacts-me": score_of(row("usps-address"))}),
            "a count": dict(good, **{"contacts-me": score_of(row("contacts-me"), fields=[])}),
            "the wrong total": dict(good, **{"contacts-me": score_of(row("contacts-me"), wrong=2)}),
            "the wrong flag": dict(good, **{"contacts-me": score_of(row("contacts-me", wrong="yes"), verdict="complete")}),
            "the verdict": dict(good, **{"contacts-me": score_of(row("contacts-me"), verdict="partial")}),
            "no field list": dict(good, **{"contacts-me": score_of(row("contacts-me"), fields=None)}),
        }
        for name, scores in bad.items():
            with self.subTest(name):
                p, _ = accept(data(*rows), scores=scores)
                self.assertTrue(any("contacts-me" in x and "score.json" in x for x in p), p)

    def test_unexpected_writes_and_a_submit_count_as_wrong(self):
        r = row("contacts-me", wrong="yes", verdict="wrong")
        score = score_of(r, fields=[f for f in score_of(r)["fields"] if f["outcome"] != "wrong"],
                         unexpected=[{"element": {"role": "AXTextField"}}])
        rows = (r, row("mail-compose", "blocked"), row("usps-address"))
        scores = {"contacts-me": score, "usps-address": score_of(rows[2])}
        self.assertEqual(accept(data(*rows), scores=scores), ([], []))
        submitted = score_of(rows[2], wrong=1, verdict="wrong", submitted=["the compose window closed"])
        rows = (r, row("mail-compose", "blocked"), row("usps-address", wrong="yes", verdict="wrong"))
        self.assertEqual(accept(data(*rows), scores=dict(scores, **{"usps-address": submitted})), ([], []))

    def test_the_options_must_be_a_mode_and_known_targets(self):
        for opts in ({"mode": "fast", "targets": ["contacts-me"]}, {"mode": "run", "targets": []},
                     {"mode": "run", "targets": ["nowhere"]}, {"mode": "run", "targets": ["contacts-me", "contacts-me"]},
                     {"mode": "run"}):
            with self.subTest(opts):
                p, _ = accept(data(row("contacts-me"), opts=opts), opts)
                self.assertTrue(p and "rae-options.json" in p[0], p)

    def test_probe_mode(self):
        opts = {"mode": "probe", "targets": ["contacts-me", "mail-compose"]}
        self.assertEqual(accept(data(row("contacts-me", "probed"), row("mail-compose", "blocked"), opts=opts), opts),
                         ([], []))
        p, _ = accept(data(row("contacts-me", "ran"), row("mail-compose", "blocked"), opts=opts), opts)
        self.assertTrue(p)

    def test_not_rae_results(self):
        p, _ = accept({"harness": None, "rows": []})
        self.assertTrue(p)

    def test_leak_check(self):
        self.assertTrue(leak_ok("CLEAN SCANNED 40", "rae", "run"))
        self.assertFalse(leak_ok("NO KEYS (nothing to scan for)", "rae", "run"))
        self.assertTrue(leak_ok("NO KEYS (nothing to scan for)", "rae", "probe"))
        self.assertFalse(leak_ok("LEAK", "rae", "probe"))
        for harness in ("h11", "h14"):  # their guests always hold a key
            self.assertFalse(leak_ok("NO KEYS (nothing to scan for)", harness, "probe"))
            self.assertTrue(leak_ok("CLEAN (scanned 3 files)", harness, None))


if __name__ == "__main__":
    unittest.main()
