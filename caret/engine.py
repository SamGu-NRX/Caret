"""The two decisions, joined to the router and the workflow registry.

``evaluate`` is the whole ambient loop: ask the judge what to do, and only on
ACTION ask it a second time which registered workflow fits. Nothing here
executes anything. Execution happens in :meth:`Engine.accept`, which runs only
after the user accepts a specific proposal that is still current.

A provider failure ends the tick with a failure publication. It never becomes
an abstention, a cached answer or an empty offer that looks like a decision.
"""

from __future__ import annotations

from datetime import datetime
from dataclasses import dataclass, field
import threading
from typing import Callable

from .context import ContextFrame, TargetIdentity, now_utc
from .judge import (
    ABSTAIN,
    ACTION,
    INLINE,
    NONE,
    Judge,
    JudgeError,
    Writer,
    route_question,
    workflow_question,
)
from .registry import ExecutionResult, WorkflowError, WorkflowRegistry
from .router import (
    ACTION_KIND,
    INLINE_KIND,
    INTERRUPTING_PAUSE_REASONS,
    SUPERSEDED_REVISION,
    Admission,
    Publication,
    Router,
    RouterConfig,
    Offer,
    AcceptanceError,
    build_action_offer,
    build_inline_offer,
)

INLINE_INSTRUCTION = (
    "Continue or correct the user's text at the caret. Reply with only the text to insert or "
    "the text that replaces the selection. No explanation, no quotes, no markdown."
)

# Neither bound is measured. The in-repo cancel hooks only drop a dict entry,
# so 5 seconds is generous for them. The drain bound covers the native
# adapter's 15-second SIGINT grace before it kills its executor, plus margin.
CANCEL_HOOK_TIMEOUT_SECONDS = 5.0
SHUTDOWN_DRAIN_TIMEOUT_SECONDS = 20.0


class ProviderFailure(RuntimeError):
    """Raised by a Writer when generation could not be completed."""


@dataclass
class _WorkflowRun:
    offer: Offer
    adapter: object
    on_complete: Callable[[dict], None]
    interrupted_by: str | None = None
    started: bool = False
    """Set under the workflow lock once execute may run. An interrupt before
    this point means execute is never called."""
    settled: bool = False
    """Set when on_complete has been called, so a late result is dropped."""
    cancelled: threading.Event = field(default_factory=threading.Event)
    """Handed to execute; set under the workflow lock by an interrupt."""
    cancellation_done: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    cancellation_error: str | None = None


def _bare_result(offer: Offer, status: str, summary: str) -> dict:
    return {"kind": ACTION_KIND, "proposal_id": offer.proposal_id, "workflow_id": offer.workflow_id,
            "status": status, "summary": summary, "effects": [], "evidence": [], "data": {}}


class Engine:
    """Owns one router, one judge, one writer and one registry."""

    def __init__(
        self,
        judge: Judge,
        writer: Writer,
        registry: WorkflowRegistry,
        config: RouterConfig | None = None,
        clock: Callable[[], datetime] = now_utc,
        on_invalidate: Callable[[object, str], None] | None = None,
        on_publish: Callable[[Publication], None] | None = None,
        cancel_timeout_seconds: float = CANCEL_HOOK_TIMEOUT_SECONDS,
        drain_timeout_seconds: float = SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
    ) -> None:
        self.judge = judge
        self.writer = writer
        self.registry = registry
        self.config = config or RouterConfig()
        self.router = Router(self.config, on_invalidate=on_invalidate, on_publish=on_publish)
        self.clock = clock
        self.cancel_timeout_seconds = cancel_timeout_seconds
        self.drain_timeout_seconds = drain_timeout_seconds
        self._workflow_lock = threading.RLock()
        self._active_workflow: _WorkflowRun | None = None

    # -- Ambient loop ----------------------------------------------------

    def submit(self, frame: ContextFrame) -> Admission:
        with self._workflow_lock:
            run = self._active_workflow
            if run is not None:
                # A replayed or out-of-order frame says nothing new about the
                # field, so it must not stop the run. The host stops sending
                # frames while its executor types (it pauses with
                # generated-input), so a newer revision is the user's change.
                if not self.router.record_revision(frame.revision):
                    return Admission("skipped", SUPERSEDED_REVISION, frame.revision)
                self._interrupt_locked("newer-context")
                self.router.pause("workflow-active")
                return Admission("skipped", "workflow-active", frame.revision)
            return self.router.submit(frame, self.clock())

    def pause(self, reason: str) -> None:
        """Withdraw ambient context; stop an accepted run only for input or an unsafe state."""
        with self._workflow_lock:
            self.router.pause(reason)
            if reason in INTERRUPTING_PAUSE_REASONS:
                self._interrupt_locked(reason)

    @property
    def active_workflow(self) -> str | None:
        with self._workflow_lock:
            return self._active_workflow.offer.proposal_id if self._active_workflow else None

    def _interrupt_locked(self, reason: str) -> None:
        run = self._active_workflow
        if run is None or run.interrupted_by is not None:
            return
        run.interrupted_by = reason
        # Set before the hook runs and under the same lock as the start check,
        # so an execute that has not reached its effect yet still sees it.
        run.cancelled.set()

        def cancel():
            try:
                run.adapter.cancel(run.offer.preparation)
            except Exception as error:
                with self._workflow_lock:
                    run.cancellation_error = f"{type(error).__name__}: {error}"
            finally:
                run.cancellation_done.set()

        threading.Thread(target=cancel, name="caret-cancel", daemon=True).start()

    def pump(self) -> Publication | None:
        """Run at most one due evaluation. Returns None when nothing is due."""
        with self._workflow_lock:
            if self._active_workflow is not None:
                return None
            frame = self.router.take_due(self.clock())
        if frame is None:
            return None
        return self.evaluate(frame)

    def evaluate(self, frame: ContextFrame) -> Publication:
        """Decide about one claimed frame, and always finish it.

        Every ordinary exception becomes a failure publication. The router's
        single in-flight slot is cleared only by a ``complete_*`` call, so an
        exception escaping this method would leave that slot set for good: every
        later context update would be coalesced behind a frame nobody is
        evaluating, and the loop would stop for the rest of the session. The
        typed provider and workflow errors below stay separate because their
        reasons name where the failure happened; this boundary catches the rest,
        including a bug in Caret's own code.
        """
        try:
            return self._evaluate(frame)
        except Exception as error:
            return self.router.complete_failure(
                frame, f"unexpected {type(error).__name__}: {error}"
            )

    def _evaluate(self, frame: ContextFrame) -> Publication:
        if self.router.is_stale(frame):
            return self.router.complete_abstain(frame)
        try:
            verdict = self.judge.choose(route_question(), frame)
        except JudgeError as error:
            return self.router.complete_failure(frame, f"judge/route: {error}")

        # A host pause can arrive while the judge runs, without a newer frame.
        # Finish through the router so it emits discarded and releases the slot.
        if self.router.is_stale(frame):
            return self.router.complete_abstain(frame)
        if verdict.choice_id == ABSTAIN:
            return self.router.complete_abstain(frame, verdict.reason or "judge-abstained")
        if verdict.choice_id == INLINE:
            return self._offer_inline(frame)
        if verdict.choice_id == ACTION:
            return self._offer_action(frame)
        # validate_choice already rejects anything else; this guards a Judge
        # implementation that skipped it.
        return self.router.complete_failure(frame, f"judge/route returned '{verdict.choice_id}'")

    def _offer_inline(self, frame: ContextFrame) -> Publication:
        try:
            text = self.writer.complete(frame, INLINE_INSTRUCTION)
        except ProviderFailure as error:
            return self.router.complete_failure(frame, f"writer: {error}")
        if not isinstance(text, str):
            return self.router.complete_failure(frame, "writer returned a non-string result")
        try:
            offer = build_inline_offer(frame, text, self.clock(), self.config)
        except ValueError as error:
            return self.router.complete_failure(frame, f"inline: {error}")
        return self.router.complete_offer(frame, offer)

    def _offer_action(self, frame: ContextFrame) -> Publication:
        choices = self.registry.choices(frame)
        if not choices:
            return self.router.complete_abstain(frame, "no-available-workflow")
        try:
            verdict = self.judge.choose(workflow_question(choices), frame)
        except JudgeError as error:
            return self.router.complete_failure(frame, f"judge/workflow: {error}")
        if self.router.is_stale(frame):
            return self.router.complete_abstain(frame)
        if verdict.choice_id == NONE:
            return self.router.complete_abstain(frame, "no-workflow-fits")

        try:
            adapter = self.registry.get(verdict.choice_id)
        except WorkflowError as error:
            return self.router.complete_failure(frame, str(error))
        availability = adapter.availability(frame)
        if not availability.available:
            return self.router.complete_failure(
                frame, f"workflow '{verdict.choice_id}' became unavailable: {availability.reason}"
            )
        try:
            preparation = adapter.prepare(frame)
        except WorkflowError as error:
            return self.router.complete_failure(frame, f"workflow/prepare: {error}")
        offer = build_action_offer(frame, adapter.descriptor, preparation, self.clock())
        return self.router.complete_offer(frame, offer)

    # -- Acceptance ------------------------------------------------------

    def accept(self, proposal_id: str, revision: int, target: TargetIdentity) -> dict:
        """Synchronous convenience for callers outside the bridge."""
        done = threading.Event()
        result = []

        def completed(value):
            result.append(value)
            done.set()

        self.accept_async(proposal_id, revision, target, completed)
        done.wait()
        return result[0]

    def accept_async(
        self, proposal_id: str, revision: int, target: TargetIdentity,
        on_complete: Callable[[dict], None],
    ) -> dict:
        """Consume synchronously, then execute without blocking context updates."""
        with self._workflow_lock:
            if self._active_workflow is not None:
                raise AcceptanceError("An accepted workflow is already running")
            offer = self.router.accept(proposal_id, revision, target, self.clock())
            if offer.kind == INLINE_KIND:
                result = self._execute_offer(offer)
                on_complete(result)
                return result
            adapter = self.registry.get(offer.workflow_id)
            run = _WorkflowRun(offer, adapter, on_complete)
            self._active_workflow = run
            # Retire any ambient evaluation already claimed before acceptance.
            self.router.pause("workflow-active")
            threading.Thread(target=self._run_workflow, args=(run,), name="caret-workflow", daemon=True).start()
            return {"kind": ACTION_KIND, "proposal_id": proposal_id, "status": "started"}

    def _run_workflow(self, run: _WorkflowRun) -> None:
        with self._workflow_lock:
            run.started = run.interrupted_by is None
        try:
            if run.started:
                result = self._execute_offer(run.offer, run.adapter, run.cancelled)
            else:
                result = _bare_result(run.offer, "not-started", "Execution did not start")
        except Exception as error:
            result = _bare_result(run.offer, "failed", f"{type(error).__name__}: {error}")

        # Resolve completion versus interruption under the same lock as submit.
        with self._workflow_lock:
            if run.interrupted_by is None:
                self._settle_locked(run, result)
                return
        # The cancel hook may still be working after execute returned. Wait for
        # it, but not forever: a hook that hangs must not hold the reply back.
        if not run.cancellation_done.wait(self.cancel_timeout_seconds):
            with self._workflow_lock:
                run.cancellation_error = run.cancellation_error or (
                    f"cancel hook did not return within {self.cancel_timeout_seconds:g}s"
                )
        with self._workflow_lock:
            self._settle_locked(run, self._interrupted_result(run, result))

    def _interrupted_result(self, run: _WorkflowRun, execution: dict) -> dict:
        ran = run.started
        result = {
            **execution,
            "status": "interrupted",
            "interrupted_by": run.interrupted_by,
            # Only a run whose execute was never called is known to have no effect.
            "effects_may_remain": ran,
            "summary": ("Workflow interrupted. Reported effects may remain." if ran
                        else "Workflow interrupted before execution started. Nothing ran."),
            "execution_status": execution["status"],
        }
        if run.cancellation_error:
            result["cancellation_error"] = run.cancellation_error
        return result

    def _settle_locked(self, run: _WorkflowRun, result: dict) -> None:
        """Report a run exactly once and release the workflow slot."""
        if run.settled:
            return
        run.settled = True
        if self._active_workflow is run:
            self._active_workflow = None
        run.on_complete(result)
        run.done.set()

    def shutdown(self) -> None:
        """Interrupt accepted execution and wait, bounded, for it to settle.

        If execution has not returned within the drain bound, the acceptance
        is answered now as interrupted, with ``execution_status`` set to
        ``unfinished``, and the late result is dropped.
        """
        with self._workflow_lock:
            self.router.pause("workflow-active")
            run = self._active_workflow
            self._interrupt_locked("shutdown")
        if run is None or run.done.wait(self.drain_timeout_seconds):
            return
        with self._workflow_lock:
            if run.cancellation_error is None:
                run.cancellation_error = (
                    f"execution did not stop within {self.drain_timeout_seconds:g}s of shutdown"
                )
            self._settle_locked(run, self._interrupted_result(
                run, _bare_result(run.offer, "unfinished", "Execution had not returned")
            ))

    def _execute_offer(self, offer: Offer, adapter=None, cancelled: threading.Event | None = None) -> dict:
        """Execute exactly one accepted proposal.

        The router consumes the proposal before any workflow runs, so a repeated
        acceptance is refused rather than executed a second time.
        """
        if offer.kind == INLINE_KIND:
            # Caret proposes; the app inserts, owns undo and owns the clipboard.
            return {
                "kind": INLINE_KIND,
                "proposal_id": offer.proposal_id,
                "status": "ready_to_insert",
                "target": offer.target.to_dict(),
                "replace_start": offer.replace_start,
                "replace_end": offer.replace_end,
                "replacement": offer.replacement,
                "original_digest": offer.original_digest,
                "note": "Revalidate the range against the live field before inserting.",
            }

        adapter = adapter or self.registry.get(offer.workflow_id)
        if offer.missing_inputs:
            result = ExecutionResult(
                status="needs_input",
                summary=f"'{offer.workflow_id}' still needs: {', '.join(offer.missing_inputs)}",
                evidence=offer.evidence,
            )
        else:
            frame = offer.frame
            if frame is None:  # pragma: no cover - offers are always built with a frame
                raise WorkflowError("Accepted offer carries no context frame")
            try:
                result = adapter.execute(frame, offer.preparation, cancelled=cancelled)
            except WorkflowError as error:
                result = ExecutionResult(status="failed", summary=str(error))
        return {
            "kind": ACTION_KIND,
            "proposal_id": offer.proposal_id,
            "workflow_id": offer.workflow_id,
            "sample_only": offer.sample_only,
            "execution_method": offer.execution_method,
            **result.to_dict(),
        }

    def dismiss(self, proposal_id: str) -> bool:
        return self.router.dismiss(proposal_id)
