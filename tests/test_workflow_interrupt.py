"""Accepted workflows stop before their late result can be reported."""

import threading
import unittest
from queue import Queue

from caret.engine import Engine
from caret.registry import Availability, ExecutionResult, Preparation, WorkflowDescriptor, WorkflowRegistry
from support import Clock, RecordingJudge, RecordingWriter, frame


class BlockingWorkflow:
    def __init__(self):
        self._descriptor = WorkflowDescriptor(
            id="book-calendar-link", name="Calendar", description="Synthetic", sample_only=True,
            execution_method="test",
        )
        self.started = threading.Event()
        self.release = threading.Event()
        self.cancelled = threading.Event()
        self.cancel_calls = 0
        self.execute_calls = 0

    @property
    def descriptor(self):
        return self._descriptor

    def availability(self, frame):
        return Availability(True)

    def prepare(self, frame):
        return Preparation(title="Calendar", effect="Writes nothing", payload={"token": "t1"})

    def execute(self, frame, preparation):
        self.execute_calls += 1
        self.started.set()
        self.release.wait(5)
        return ExecutionResult(status="completed", summary="late completion")

    def cancel(self, preparation):
        self.cancel_calls += 1
        self.cancelled.set()
        self.release.set()
        return ExecutionResult(status="cancelled", summary="cancelled by Caret")


def accepted_engine(workflow):
    registry = WorkflowRegistry()
    registry.register(workflow)
    clock = Clock()
    engine = Engine(
        RecordingJudge(route=["ACTION"], workflow=["book-calendar-link"]),
        RecordingWriter(), registry, clock=clock,
    )
    engine.submit(frame(1))
    offer = engine.pump().offer
    return engine, clock, offer


class AcceptedWorkflowInterruptTests(unittest.TestCase):
    def test_pause_cancels_an_accepted_workflow_and_fences_its_late_result(self):
        workflow = BlockingWorkflow()
        engine, _, offer = accepted_engine(workflow)
        results = Queue()

        accepted = engine.accept_async(
            offer.proposal_id, offer.revision, offer.target, results.put
        )
        self.assertEqual(accepted["status"], "started")
        self.assertTrue(workflow.started.wait(1))

        engine.pause("generated-input")
        result = results.get(timeout=1)
        self.assertEqual(result["status"], "interrupted")
        self.assertEqual(result["interrupted_by"], "generated-input")
        self.assertEqual(workflow.cancel_calls, 1)

        workflow.release.set()
        self.assertIsNone(engine.active_workflow)
        self.assertIsNone(results.get(timeout=0.1) if not results.empty() else None)

    def test_newer_context_cancels_an_accepted_workflow_before_resuming_ambient_routing(self):
        workflow = BlockingWorkflow()
        engine, clock, offer = accepted_engine(workflow)
        results = Queue()
        engine.accept_async(offer.proposal_id, offer.revision, offer.target, results.put)
        self.assertTrue(workflow.started.wait(1))

        clock.advance(2)
        admission = engine.submit(frame(2, text="new text", captured_at=clock()))
        self.assertEqual((admission.status, admission.reason), ("skipped", "workflow-active"))
        result = results.get(timeout=1)
        self.assertEqual((result["status"], result["interrupted_by"]), ("interrupted", "newer-context"))
        self.assertEqual(workflow.cancel_calls, 1)

    def test_a_second_acceptance_is_rejected_while_the_first_workflow_is_running(self):
        workflow = BlockingWorkflow()
        engine, _, offer = accepted_engine(workflow)
        results = Queue()
        engine.accept_async(offer.proposal_id, offer.revision, offer.target, results.put)
        self.assertTrue(workflow.started.wait(1))
        with self.assertRaisesRegex(RuntimeError, "already running"):
            engine.accept_async(offer.proposal_id, offer.revision, offer.target, results.put)
        engine.pause("locked")
        self.assertEqual(results.get(timeout=1)["status"], "interrupted")


if __name__ == "__main__":
    unittest.main()
