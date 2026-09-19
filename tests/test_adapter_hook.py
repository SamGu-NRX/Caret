"""--adapter loading, explicit replacement, and the demo pattern judge over the real bridge."""

import io
import tempfile
import unittest
from pathlib import Path

from caret.bridge import build_registry, load_adapter
from caret.context import ContextFrame
from caret.registry import Availability, ExecutionResult, Preparation, WorkflowDescriptor, WorkflowError
from test_bridge import ROOT, BridgeProcess, synthetic_frame

FIXTURE = ROOT / "fixtures" / "meeting.json"


class MeetingStub:
    """Zero-arg adapter the way the live-adapters branch will supply one."""

    descriptor = WorkflowDescriptor(
        id="book-calendar-link", name="Meeting draft", description="stub", execution_method="draft-only"
    )

    def availability(self, frame):
        return Availability(True, "stub")

    def prepare(self, frame):
        return Preparation(title="t", effect="draft only, nothing sent")

    def execute(self, frame, preparation):
        return ExecutionResult(status="completed", summary="stub")

    def cancel(self, preparation):
        return ExecutionResult(status="cancelled", summary="stub")


class Incomplete:
    descriptor = WorkflowDescriptor(id="half", name="Half", description="")


class Exploding:
    def __init__(self):
        raise RuntimeError("needs CALENDAR_TOKEN")


class AdapterLoadingTests(unittest.TestCase):
    def test_a_bad_spec_shape_is_refused(self):
        with self.assertRaisesRegex(WorkflowError, "package.module:ClassName"):
            load_adapter("no-colon-here")

    def test_a_missing_module_is_refused_with_its_name(self):
        with self.assertRaisesRegex(WorkflowError, "cannot import 'caret.does_not_exist'"):
            load_adapter("caret.does_not_exist:Thing")

    def test_a_missing_class_is_refused(self):
        with self.assertRaisesRegex(WorkflowError, "has no attribute 'Nope'"):
            load_adapter("test_adapter_hook:Nope")

    def test_a_constructor_error_is_refused_with_its_message(self):
        with self.assertRaisesRegex(WorkflowError, "CALENDAR_TOKEN"):
            load_adapter("test_adapter_hook:Exploding")

    def test_an_adapter_missing_protocol_methods_is_refused_at_startup(self):
        with self.assertRaisesRegex(WorkflowError, "missing availability, prepare, execute, cancel"):
            load_adapter("test_adapter_hook:Incomplete")


class ReplacementTests(unittest.TestCase):
    def test_an_external_adapter_replaces_the_built_in_with_the_same_id_and_says_so(self):
        notices = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            registry = build_registry(
                FIXTURE, Path(directory) / "x.sqlite", adapters=("test_adapter_hook:MeetingStub",), notices=notices
            )
        winner = registry.get("book-calendar-link")
        self.assertIsInstance(winner, MeetingStub)
        self.assertIn("replaced built-in 'book-calendar-link'", notices.getvalue())
        self.assertIn("local-sample-planner", notices.getvalue())
        self.assertEqual(
            [row["execution_method"] for row in registry.catalog() if row["id"] == "book-calendar-link"],
            ["draft-only"],
        )

    def test_two_externals_with_one_id_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(WorkflowError, "both register 'book-calendar-link'"):
                build_registry(
                    FIXTURE,
                    Path(directory) / "x.sqlite",
                    adapters=("test_adapter_hook:MeetingStub", "test_adapter_hook:MeetingStub"),
                )


class PatternJudgeOverTheBridgeTests(unittest.TestCase):
    """The demo path end to end: real process, pattern judge, sample planner, local holds."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.bridge = BridgeProcess({"inline": ["unused"]}, Path(self._tmp.name), judge="pattern")

    def tearDown(self):
        self.bridge.close()
        self._tmp.cleanup()

    def test_meeting_text_offers_the_sample_workflow_and_acceptance_records_holds(self):
        self.bridge.call(
            "context.update", {"frame": synthetic_frame(1, text="Could we meet in Dallas next Tuesday? ")}
        )
        offer = self.bridge.wait_for_event("offer")["offer"]
        self.assertEqual(offer["workflow_id"], "book-calendar-link")
        self.assertEqual(offer["execution_method"], "local-sample-planner")
        self.assertTrue(offer["sample_only"])
        accepted = self.bridge.call(
            "offer.accept",
            {"proposal_id": offer["proposal_id"], "revision": offer["revision"], "target": offer["target"]},
        )
        self.assertTrue(accepted["ok"])
        result = accepted["result"]
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["execution_method"], "local-sample-planner")
        self.assertEqual(len(result["data"]["holds"]), 3)

    def test_non_meeting_text_abstains(self):
        self.bridge.call("context.update", {"frame": synthetic_frame(1, text="The invoice is attached. ")})
        event = self.bridge.wait_for_event("abstain")
        self.assertIsNotNone(event)
        self.assertEqual(event["revision"], 1)


if __name__ == "__main__":
    unittest.main()
