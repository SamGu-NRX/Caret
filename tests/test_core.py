import copy
import json
from pathlib import Path
import tempfile
import unittest

from caret.planner import plan
from caret.store import Store


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads(Path("fixtures/meeting.json").read_text())

    def test_buffers_and_failed_sources_remove_options(self):
        result = plan(self.fixture)
        self.assertEqual([item["id"] for item in result["options"]], ["a", "b", "c"])
        self.assertEqual(set(result["dropped"]), {"conflict", "failed-source"})
        self.assertNotIn("16:00", result["draft"])
        self.assertEqual(result["options"][0]["hold_start"], "2026-09-22T10:00:00-05:00")

    def test_equivalent_timezones_conflict(self):
        self.fixture["busy"] = [{"start": "2026-09-22T15:59:00+00:00", "end": "2026-09-22T16:01:00+00:00"}]
        self.assertNotIn("a", [item["id"] for item in plan(self.fixture)["options"]])

    def test_no_options_produces_no_draft(self):
        for item in self.fixture["candidates"]:
            item["status"] = "error"
        self.assertEqual(plan(self.fixture)["draft"], "")

    def test_naive_time_and_negative_buffers_are_rejected(self):
        bad = copy.deepcopy(self.fixture)
        bad["candidates"][0]["start"] = "2026-09-22T10:30:00"
        with self.assertRaisesRegex(ValueError, "timezone"):
            plan(bad)
        self.fixture["buffer_before_minutes"] = -1
        with self.assertRaisesRegex(ValueError, "nonnegative"):
            plan(self.fixture)

    def test_candidate_identity_is_unique_and_nonempty(self):
        self.fixture["candidates"][2]["id"] = self.fixture["candidates"][1]["id"]
        with self.assertRaisesRegex(ValueError, "Duplicate candidate ID"):
            plan(self.fixture)
        for invalid in (None, "", " ", 42):
            with self.subTest(candidate_id=invalid):
                self.fixture["candidates"][2]["id"] = invalid
                with self.assertRaisesRegex(ValueError, "nonempty string ID"):
                    plan(self.fixture)

    def test_confirm_releases_only_this_runs_holds_and_retries_are_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "memory.sqlite")
            try:
                first = store.save_preview(plan(self.fixture))
                second = store.save_preview(plan(self.fixture))
                store.hold(first)
                store.hold(first)
                store.hold(second)
                rows = store.confirm(first, "b")
                self.assertEqual({row["option_id"]: row["status"] for row in rows}, {"a": "released", "b": "confirmed", "c": "released"})
                self.assertEqual(store.confirm(first, "b"), rows)
                self.assertEqual(store.hold(first), rows)
                self.assertTrue(all(row["status"] == "tentative" for row in store.holds(second)))
                with self.assertRaises(ValueError):
                    store.confirm(first, "a")
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
