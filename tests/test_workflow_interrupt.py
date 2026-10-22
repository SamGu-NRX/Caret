"""Accepted workflows stop only for genuine user input or an unsafe state.

Each stop cancels the adapter, fences its late result and never resumes the
run. Generated input, idle time and the host's own workflow-active pause leave
the run alone, because the host sends them while Caret's executor is typing.
"""

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from queue import Empty, Queue

from caret.adapters import SampleSchedulerWorkflow
from caret.bridge import Bridge
from caret.engine import Engine
from caret.registry import (
    Availability,
    ExecutionResult,
    Preparation,
    WorkflowDescriptor,
    WorkflowError,
    WorkflowRegistry,
)
from caret.router import RouterConfig
from support import Clock, RecordingJudge, RecordingWriter, frame
from test_bridge import ROOT, OrderedOutput, synthetic_frame

UNSAFE_REASONS = (
    "locked", "sleeping", "accessibility-revoked", "secure-field", "app-excluded",
    "focus-unavailable", "ime-composing",
)
AMBIENT_REASONS = ("idle", "generated-input", "workflow-active")
WAIT = 2.0


class BlockingWorkflow:
    """Runs until released, and reports what it saw of the cancellation token.

    ``proceed`` holds execute between entering and starting its effect, which
    is the window an interrupt can land in after the engine decided to start.
    """

    def __init__(self, *, honours_token=True, cancel_error=None, cancel_blocks=None):
        self._descriptor = WorkflowDescriptor(
            id="book-calendar-link", name="Calendar", description="Synthetic", sample_only=True,
            execution_method="test",
        )
        self.honours_token = honours_token
        self.cancel_error = cancel_error
        self.cancel_blocks = cancel_blocks
        self.entered = threading.Event()
        self.proceed = threading.Event()
        self.proceed.set()
        self.started = threading.Event()
        self.release = threading.Event()
        self.cancel_seen = threading.Event()
        self.cancel_calls = 0
        self.execute_calls = 0

    @property
    def descriptor(self):
        return self._descriptor

    def availability(self, frame):
        return Availability(True)

    def prepare(self, frame):
        return Preparation(title="Calendar", effect="Writes nothing", payload={"token": "t1"})

    def execute(self, frame, preparation, cancelled=None):
        self.execute_calls += 1
        self.entered.set()
        self.proceed.wait(WAIT)
        if self.honours_token and cancelled is not None and cancelled.is_set():
            return ExecutionResult(status="cancelled", summary="stopped before its effect")
        self.started.set()
        deadline = time.monotonic() + WAIT
        while time.monotonic() < deadline and not self.release.is_set():
            if self.honours_token and cancelled is not None and cancelled.wait(0.01):
                return ExecutionResult(status="cancelled", summary="stopped mid-run")
            self.release.wait(0.01)
        return ExecutionResult(status="completed", summary="late completion")

    def cancel(self, preparation):
        self.cancel_calls += 1
        self.cancel_seen.set()
        if self.cancel_error:
            raise RuntimeError(self.cancel_error)
        if self.cancel_blocks is not None:
            self.cancel_blocks.wait(WAIT)
        return ExecutionResult(status="cancelled", summary="cancelled by Caret")


def accepted_engine(workflow, **engine_options):
    registry = WorkflowRegistry()
    registry.register(workflow)
    clock = Clock()
    engine = Engine(
        RecordingJudge(route=["ACTION"], workflow=["book-calendar-link"]),
        RecordingWriter(), registry, clock=clock, **engine_options,
    )
    engine.submit(frame(1))
    offer = engine.pump().offer
    return engine, clock, offer


def start(workflow, **engine_options):
    engine, clock, offer = accepted_engine(workflow, **engine_options)
    results = Queue()
    accepted = engine.accept_async(offer.proposal_id, offer.revision, offer.target, results.put)
    return engine, clock, results, accepted


def nothing_more(results, seconds=0.2):
    try:
        return results.get(timeout=seconds)
    except Empty:
        return None


class PauseReasonTests(unittest.TestCase):
    def test_every_pause_reason_is_either_interrupting_or_ambient(self):
        from caret.router import AMBIENT_PAUSE_REASONS, INTERRUPTING_PAUSE_REASONS, PAUSE_REASONS

        self.assertEqual(INTERRUPTING_PAUSE_REASONS | AMBIENT_PAUSE_REASONS, PAUSE_REASONS)
        self.assertFalse(INTERRUPTING_PAUSE_REASONS & AMBIENT_PAUSE_REASONS)
        self.assertEqual(AMBIENT_PAUSE_REASONS, frozenset(AMBIENT_REASONS))
        self.assertEqual(INTERRUPTING_PAUSE_REASONS, frozenset(UNSAFE_REASONS + ("user-input",)))

    def test_user_input_and_unsafe_pauses_interrupt_and_fence_the_late_result(self):
        for reason in ("user-input",) + UNSAFE_REASONS:
            with self.subTest(reason=reason):
                workflow = BlockingWorkflow()
                engine, _, results, accepted = start(workflow)
                self.assertEqual(accepted["status"], "started")
                self.assertTrue(workflow.started.wait(1))

                engine.pause(reason)
                result = results.get(timeout=1)
                self.assertEqual(result["status"], "interrupted")
                self.assertEqual(result["interrupted_by"], reason)
                self.assertIs(result["effects_may_remain"], True)
                self.assertEqual(result["execution_status"], "cancelled")
                self.assertNotIn("cancellation_error", result)
                self.assertEqual(workflow.cancel_calls, 1)

                workflow.release.set()
                self.assertIsNone(engine.active_workflow)
                self.assertIsNone(nothing_more(results))

    def test_ambient_pauses_leave_an_accepted_workflow_running(self):
        for reason in AMBIENT_REASONS:
            with self.subTest(reason=reason):
                workflow = BlockingWorkflow()
                engine, _, results, _ = start(workflow)
                self.assertTrue(workflow.started.wait(1))

                engine.pause(reason)
                self.assertIsNone(nothing_more(results))
                self.assertEqual(workflow.cancel_calls, 0)
                self.assertIsNotNone(engine.active_workflow)

                workflow.release.set()
                result = results.get(timeout=1)
                self.assertEqual(result["status"], "completed")
                self.assertNotIn("interrupted_by", result)


class ContextRevisionTests(unittest.TestCase):
    def test_newer_context_interrupts_and_its_revision_stays_consumed(self):
        workflow = BlockingWorkflow()
        engine, clock, results, _ = start(workflow)
        self.assertTrue(workflow.started.wait(1))

        clock.advance(2)
        admission = engine.submit(frame(2, text="new text", captured_at=clock()))
        self.assertEqual((admission.status, admission.reason), ("skipped", "workflow-active"))
        result = results.get(timeout=1)
        self.assertEqual((result["status"], result["interrupted_by"]), ("interrupted", "newer-context"))
        self.assertEqual(workflow.cancel_calls, 1)

        # Revisions stay monotonic across the run: the host resubmits with a newer one.
        clock.advance(2)
        replay = engine.submit(frame(2, text="new text", captured_at=clock()))
        self.assertEqual((replay.status, replay.reason), ("skipped", "superseded-revision"))
        self.assertEqual(engine.submit(frame(3, text="new text", captured_at=clock())).status, "admitted")

    def test_a_stale_or_duplicate_revision_does_not_interrupt(self):
        workflow = BlockingWorkflow()
        engine, clock, results, _ = start(workflow)
        self.assertTrue(workflow.started.wait(1))

        for revision in (1, 0):
            admission = engine.submit(frame(revision, text="replayed", captured_at=clock()))
            self.assertEqual((admission.status, admission.reason), ("skipped", "superseded-revision"))
        self.assertIsNone(nothing_more(results))
        self.assertEqual(workflow.cancel_calls, 0)

        workflow.release.set()
        self.assertEqual(results.get(timeout=1)["status"], "completed")


class StartAndCancelTests(unittest.TestCase):
    def test_an_interrupt_before_execute_starts_reports_that_nothing_ran(self):
        workflow = BlockingWorkflow()
        engine, _, offer = accepted_engine(workflow)
        results = Queue()
        # Holding the engine lock keeps the workflow thread before its start check.
        with engine._workflow_lock:
            engine.accept_async(offer.proposal_id, offer.revision, offer.target, results.put)
            engine.pause("locked")

        result = results.get(timeout=1)
        self.assertEqual(result["status"], "interrupted")
        self.assertEqual(result["interrupted_by"], "locked")
        self.assertEqual(result["execution_status"], "not-started")
        self.assertIs(result["effects_may_remain"], False)
        self.assertEqual(workflow.execute_calls, 0)
        self.assertEqual(workflow.cancel_calls, 1)

    def test_an_interrupt_after_the_start_decision_reaches_execute_before_its_effect(self):
        workflow = BlockingWorkflow()
        workflow.proceed.clear()
        engine, _, results, _ = start(workflow)
        self.assertTrue(workflow.entered.wait(1))

        engine.pause("locked")
        self.assertTrue(workflow.cancel_seen.wait(1))
        workflow.proceed.set()

        result = results.get(timeout=1)
        self.assertFalse(workflow.started.is_set(), "execute started its effect after the interrupt")
        self.assertEqual(result["execution_status"], "cancelled")
        self.assertIs(result["effects_may_remain"], True)

    def test_a_cancel_hook_that_raises_is_reported(self):
        workflow = BlockingWorkflow(cancel_error="executor already gone")
        engine, _, results, _ = start(workflow)
        self.assertTrue(workflow.started.wait(1))

        engine.pause("user-input")
        result = results.get(timeout=1)
        self.assertEqual(result["status"], "interrupted")
        self.assertEqual(result["cancellation_error"], "RuntimeError: executor already gone")
        self.assertEqual(result["execution_status"], "cancelled")
        self.assertIs(result["effects_may_remain"], True)
        self.assertIsNone(engine.active_workflow)

    def test_a_cancel_hook_that_does_not_return_is_bounded(self):
        stuck = threading.Event()
        self.addCleanup(stuck.set)
        workflow = BlockingWorkflow(cancel_blocks=stuck)
        engine, _, results, _ = start(workflow, cancel_timeout_seconds=0.2)
        self.assertTrue(workflow.started.wait(1))

        engine.pause("user-input")
        result = results.get(timeout=1)
        self.assertEqual(result["status"], "interrupted")
        self.assertEqual(result["execution_status"], "cancelled")
        self.assertIn("did not return within 0.2s", result["cancellation_error"])
        self.assertIsNone(engine.active_workflow)


class ShutdownTests(unittest.TestCase):
    def test_shutdown_drains_a_running_workflow_before_returning(self):
        workflow = BlockingWorkflow()
        engine, _, results, _ = start(workflow)
        self.assertTrue(workflow.started.wait(1))

        engine.shutdown()
        result = results.get_nowait()
        self.assertEqual((result["status"], result["interrupted_by"]), ("interrupted", "shutdown"))
        self.assertEqual(result["execution_status"], "cancelled")
        self.assertIsNone(engine.active_workflow)

    def test_shutdown_stops_waiting_for_an_execution_that_ignores_cancellation(self):
        workflow = BlockingWorkflow(honours_token=False)
        engine, _, results, _ = start(workflow, drain_timeout_seconds=0.2)
        self.assertTrue(workflow.started.wait(1))

        began = time.monotonic()
        engine.shutdown()
        self.assertLess(time.monotonic() - began, 1.5)
        result = results.get_nowait()
        self.assertEqual((result["status"], result["interrupted_by"]), ("interrupted", "shutdown"))
        self.assertEqual(result["execution_status"], "unfinished")
        self.assertIs(result["effects_may_remain"], True)
        self.assertIn("did not stop within 0.2s", result["cancellation_error"])

        workflow.release.set()
        self.assertIsNone(nothing_more(results, 0.5), "a late result was reported after shutdown settled the run")


class AdapterContractTests(unittest.TestCase):
    def test_an_adapter_whose_execute_cannot_take_the_token_is_refused(self):
        class Untokened(BlockingWorkflow):
            def execute(self, frame, preparation):  # noqa: D401 - the old signature
                return ExecutionResult(status="completed", summary="ran")

        with self.assertRaisesRegex(WorkflowError, "cancelled"):
            WorkflowRegistry().register(Untokened())
        with self.assertRaisesRegex(WorkflowError, "cancelled"):
            WorkflowRegistry().replace(Untokened())

    def test_the_sample_planner_writes_nothing_once_cancelled(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "holds.sqlite"
            adapter = SampleSchedulerWorkflow(ROOT / "fixtures" / "meeting.json", database)
            preparation = adapter.prepare(frame())
            cancelled = threading.Event()
            cancelled.set()
            result = adapter.execute(frame(), preparation, cancelled=cancelled)
            self.assertEqual(result.status, "cancelled")
            self.assertFalse(database.exists())


class QueuedStdin:
    """Request lines fed one at a time, so a test can act between them."""

    def __init__(self):
        self._lines = Queue()

    def send(self, payload):
        self._lines.put(json.dumps(payload))

    def close(self):
        self._lines.put(None)

    def __iter__(self):
        while True:
            line = self._lines.get(timeout=10)
            if line is None:
                return
            yield line


def wait_for(output, predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for message in output.messages():
            if predicate(message):
                return message
        time.sleep(0.01)
    raise AssertionError(f"no matching message in {output.messages()}")


class BridgeInterruptTests(unittest.TestCase):
    def test_pauses_are_answered_while_an_acceptance_is_pending(self):
        workflow = BlockingWorkflow()
        registry = WorkflowRegistry()
        registry.register(workflow)
        stdin = QueuedStdin()
        output = OrderedOutput()

        def factory(on_invalidate, on_publish):
            return Engine(
                RecordingJudge(route=["ACTION"], workflow=["book-calendar-link"]),
                RecordingWriter(), registry, RouterConfig(interval_seconds=0.0),
                on_invalidate=on_invalidate, on_publish=on_publish,
            )

        bridge = Bridge(factory, registry, stdin, output)
        running = threading.Thread(target=bridge.run, name="bridge-under-test", daemon=True)
        running.start()
        try:
            stdin.send({"id": 1, "method": "context.update", "params": {"frame": synthetic_frame(1)}})
            offer = wait_for(output, lambda m: m.get("event") == "offer")["offer"]
            stdin.send({"id": 2, "method": "offer.accept", "params": {
                "proposal_id": offer["proposal_id"], "revision": offer["revision"], "target": offer["target"],
            }})
            self.assertTrue(workflow.started.wait(2))

            stdin.send({"id": 3, "method": "context.pause", "params": {"reason": "generated-input"}})
            self.assertEqual(wait_for(output, lambda m: m.get("id") == 3)["result"], {"paused": True})
            self.assertEqual(workflow.cancel_calls, 0)

            stdin.send({"id": 4, "method": "context.pause", "params": {"reason": "user-input"}})
            accepted = wait_for(output, lambda m: m.get("id") == 2)
        finally:
            stdin.send({"id": 5, "method": "shutdown"})
            stdin.close()
            running.join(timeout=5)

        replies = {message["id"]: message for message in output.messages() if "id" in message}
        ids = [message.get("id") for message in output.messages() if "id" in message]
        self.assertLess(ids.index(3), ids.index(2), "a pause waited behind the pending acceptance")
        self.assertEqual(replies[4]["result"], {"paused": True})
        self.assertEqual(accepted["result"]["status"], "interrupted")
        self.assertEqual(accepted["result"]["interrupted_by"], "user-input")
        self.assertEqual(workflow.cancel_calls, 1)
        self.assertEqual(ids.count(2), 1)


if __name__ == "__main__":
    unittest.main()
