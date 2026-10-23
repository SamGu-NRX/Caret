"""A host can withdraw context even when it can no longer read a field."""

import unittest

from caret.engine import Engine
from caret.registry import WorkflowRegistry
from caret.router import AcceptanceError, Router, RouterConfig, build_inline_offer
from support import Clock, RecordingJudge, RecordingWriter, frame
from test_bridge import BridgeTestCase, synthetic_frame
from test_engine import CountingWorkflow


class ContextPauseTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.invalidated = []
        self.router = Router(on_invalidate=lambda offer, reason: self.invalidated.append(reason))

    def test_pause_retires_the_offer_and_refuses_acceptance_without_a_new_frame(self):
        current = frame(1)
        self.router.submit(current, self.clock())
        claimed = self.router.take_due(self.clock())
        offer = build_inline_offer(claimed, "team", self.clock(), RouterConfig())
        self.assertEqual(self.router.complete_offer(claimed, offer).status, "published")

        self.router.pause("locked")
        self.assertEqual(self.invalidated, ["locked"])
        with self.assertRaisesRegex(AcceptanceError, "no current offer"):
            self.router.accept(offer.proposal_id, 1, current.snapshot.target, self.clock())
        self.router.pause("locked")
        self.assertEqual(self.invalidated, ["locked"], "a repeated pause emits no duplicate invalidation")

    def test_pause_drops_pending_work_and_only_a_new_revision_resumes(self):
        self.router.submit(frame(1), self.clock())
        self.router.pause("sleeping")
        self.clock.advance(20)
        self.assertIsNone(self.router.take_due(self.clock()))
        self.assertIsNone(self.router.next_due_at())
        replay = self.router.submit(frame(1), self.clock())
        self.assertEqual((replay.status, replay.reason), ("skipped", "superseded-revision"))

        self.router.submit(frame(2, captured_at=self.clock()), self.clock())
        self.assertEqual(self.router.take_due(self.clock()).revision, 2)

    def test_pause_discards_in_flight_result_without_releasing_its_slot_early(self):
        self.router.submit(frame(1), self.clock())
        claimed = self.router.take_due(self.clock())
        self.router.pause("accessibility-revoked")
        late = build_inline_offer(claimed, "team", self.clock(), RouterConfig())
        self.assertTrue(self.router.is_stale(claimed))
        self.clock.advance(2)
        admission = self.router.submit(frame(2, captured_at=self.clock()), self.clock())
        self.assertEqual((admission.status, admission.reason), ("coalesced", "evaluation-in-flight"))
        self.assertIsNone(self.router.take_due(self.clock()))

        result = self.router.complete_offer(claimed, late)
        self.assertEqual((result.status, result.reason), ("discarded", "stale-snapshot"))
        fresh = self.router.take_due(self.clock())
        offer = build_inline_offer(fresh, "new text", self.clock(), RouterConfig())
        self.assertEqual(self.router.complete_offer(fresh, offer).offer.replacement, "new text")

    def test_pause_discards_an_abstention_without_suppressing_the_resumed_context(self):
        self.router.submit(frame(1), self.clock())
        claimed = self.router.take_due(self.clock())
        self.router.pause("generated-input")
        result = self.router.complete_abstain(claimed)
        self.assertEqual((result.status, result.reason), ("discarded", "stale-snapshot"))
        self.clock.advance(2)
        self.assertEqual(self.router.submit(frame(2, captured_at=self.clock()), self.clock()).status, "admitted")
        self.assertEqual(self.router.take_due(self.clock()).revision, 2)

    def test_a_failed_in_flight_request_is_discarded_after_pause(self):
        self.router.submit(frame(1), self.clock())
        claimed = self.router.take_due(self.clock())
        self.router.pause("locked")
        result = self.router.complete_failure(claimed, "provider unavailable")
        self.assertEqual((result.status, result.reason), ("discarded", "stale-snapshot"))
        self.clock.advance(10)
        self.router.submit(frame(2, captured_at=self.clock()), self.clock())
        self.assertEqual(self.router.take_due(self.clock()).revision, 2)


class ContextPauseEngineTests(unittest.TestCase):
    def test_pause_during_a_judge_call_stops_the_next_stage(self):
        for route, pause_stage in (("INLINE", "route"), ("ACTION", "route"), ("ACTION", "workflow")):
            with self.subTest(route=route, pause_stage=pause_stage):
                clock = Clock()
                writer = RecordingWriter(text="fresh completion")
                adapter = CountingWorkflow()
                registry = WorkflowRegistry()
                registry.register(adapter)

                class PausingJudge(RecordingJudge):
                    pause_once = True

                    def choose(self, question, context):
                        result = super().choose(question, context)
                        if self.pause_once and question.key == pause_stage:
                            self.pause_once = False
                            engine.router.pause("locked")
                        return result

                judge = PausingJudge(route=[route], workflow=["book-calendar-link"])
                engine = Engine(judge, writer, registry, clock=clock)
                engine.submit(frame(1))
                result = engine.pump()
                self.assertEqual((result.status, result.reason), ("discarded", "stale-snapshot"))
                self.assertEqual(writer.calls, 0)
                self.assertEqual(adapter.prepared, 0)
                self.assertEqual(judge.calls, ["route"] if pause_stage == "route" else ["route", "workflow"])

                clock.advance(2)
                engine.submit(frame(2, captured_at=clock()))
                result = engine.pump()
                self.assertEqual((result.status, result.offer.revision), ("published", 2))
                if route == "INLINE":
                    self.assertEqual(result.offer.replacement, "fresh completion")
                    self.assertEqual(writer.calls, 1)
                else:
                    self.assertEqual(result.offer.title, "Do the thing")
                    self.assertEqual(adapter.prepared, 1)


class ContextPauseBridgeTests(BridgeTestCase):
    script = {"route": ["INLINE"], "inline": ["summary to the team"]}

    def test_pause_without_a_snapshot_invalidates_and_then_allows_fresh_context(self):
        self.bridge.call("context.update", {"frame": synthetic_frame(1)})
        offer = self.bridge.wait_for_event("offer")["offer"]
        reply = self.bridge.call("context.pause", {"reason": "focus-unavailable"})
        self.assertEqual(reply.get("result"), {"paused": True})
        self.assertEqual(self.bridge.wait_for_event("invalidated"), {
            "event": "invalidated", "proposal_id": offer["proposal_id"], "reason": "focus-unavailable",
        })
        rejected = self.bridge.call("offer.accept", {
            "proposal_id": offer["proposal_id"], "revision": 1, "target": offer["target"],
        })
        self.assertEqual(rejected["error"]["code"], "acceptance_rejected")
        self.bridge.call("context.update", {"frame": synthetic_frame(2)})
        fresh = self.bridge.wait_for_event("offer")["offer"]
        self.assertEqual((fresh["revision"], fresh["replacement"]), (2, "summary to the team"))

    def test_pause_rejects_missing_or_unknown_reasons_and_keeps_the_offer(self):
        self.bridge.call("context.update", {"frame": synthetic_frame(1)})
        offer = self.bridge.wait_for_event("offer")["offer"]
        for params in ({}, {"reason": "typo"}, {"reason": True}, {"reason": []}):
            with self.subTest(params=params):
                reply = self.bridge.call("context.pause", params)
                self.assertEqual(reply["error"]["code"], "invalid_request")
                self.assertIn("reason", reply["error"]["message"])
        accepted = self.bridge.call("offer.accept", {
            "proposal_id": offer["proposal_id"], "revision": 1, "target": offer["target"],
        })
        self.assertEqual(accepted["result"]["status"], "ready_to_insert")
