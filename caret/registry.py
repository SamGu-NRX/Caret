"""The seam workflows plug into.

A workflow is three operations over one context frame: report whether it is
available, prepare a proposal the user can read, and execute an accepted
proposal. The judge only ever sees the IDs of workflows that reported
themselves available, so a model cannot name a workflow that is not installed,
not configured, or not supported on this machine.

An adapter that cannot run says so through :class:`Availability`. It becomes a
choice the judge is not offered. It never returns a successful-looking result
it did not produce.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from .context import ContextFrame
from .judge import Choice


class WorkflowError(RuntimeError):
    """A registered workflow failed while preparing or executing."""


@dataclass(frozen=True)
class Availability:
    available: bool
    reason: str = ""

    def to_dict(self) -> dict:
        return {"available": self.available, "reason": self.reason}


@dataclass(frozen=True)
class WorkflowDescriptor:
    id: str
    name: str
    description: str
    required_inputs: tuple[str, ...] = ()
    execution_method: str = "unspecified"
    sample_only: bool = False
    """True when the workflow runs on labeled synthetic data and produces no
    external effect. Shown to the user; never inferred from a missing key."""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "required_inputs": list(self.required_inputs),
            "execution_method": self.execution_method,
            "sample_only": self.sample_only,
        }


@dataclass(frozen=True)
class Preparation:
    """A read-only proposal. Preparing must not send, write or navigate."""

    title: str
    effect: str
    evidence: tuple[str, ...] = ()
    missing_inputs: tuple[str, ...] = ()
    payload: dict = field(default_factory=dict)
    """Adapter-private state carried to execute() so it need not redo its work."""

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "effect": self.effect,
            "evidence": list(self.evidence),
            "missing_inputs": list(self.missing_inputs),
        }


@dataclass(frozen=True)
class ExecutionResult:
    status: str
    summary: str
    effects: tuple[str, ...] = ()
    evidence: tuple[str, ...] = ()
    data: dict = field(default_factory=dict)

    STATUSES = ("completed", "needs_input", "failed", "cancelled")

    def __post_init__(self) -> None:
        if self.status not in self.STATUSES:
            raise WorkflowError(f"Execution status must be one of {self.STATUSES}, got '{self.status}'")

    @property
    def succeeded(self) -> bool:
        return self.status == "completed"

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "summary": self.summary,
            "effects": list(self.effects),
            "evidence": list(self.evidence),
            "data": self.data,
        }


@runtime_checkable
class WorkflowAdapter(Protocol):
    """Implemented by each workflow. The registry holds instances of these."""

    @property
    def descriptor(self) -> WorkflowDescriptor:  # pragma: no cover - protocol
        ...

    def availability(self, frame: ContextFrame) -> Availability:  # pragma: no cover - protocol
        ...

    def prepare(self, frame: ContextFrame) -> Preparation:  # pragma: no cover - protocol
        ...

    def execute(self, frame: ContextFrame, preparation: Preparation) -> ExecutionResult:  # pragma: no cover
        ...

    def cancel(self, preparation: Preparation) -> ExecutionResult:  # pragma: no cover - protocol
        ...


class WorkflowRegistry:
    """Holds the adapters and answers "what may the judge choose right now"."""

    def __init__(self) -> None:
        self._adapters: dict[str, WorkflowAdapter] = {}

    def register(self, adapter: WorkflowAdapter) -> None:
        workflow_id = adapter.descriptor.id
        if workflow_id in self._adapters:
            raise WorkflowError(f"Workflow '{workflow_id}' is already registered")
        self._adapters[workflow_id] = adapter

    def replace(self, adapter: WorkflowAdapter) -> WorkflowAdapter | None:
        """Register, replacing any adapter with the same ID. Returns what was replaced."""
        workflow_id = adapter.descriptor.id
        previous = self._adapters.get(workflow_id)
        self._adapters[workflow_id] = adapter
        return previous

    def get(self, workflow_id: str) -> WorkflowAdapter:
        try:
            return self._adapters[workflow_id]
        except KeyError:
            raise WorkflowError(f"No workflow registered as '{workflow_id}'") from None

    def all(self) -> tuple[WorkflowAdapter, ...]:
        return tuple(self._adapters.values())

    def available(self, frame: ContextFrame) -> tuple[WorkflowAdapter, ...]:
        return tuple(
            adapter for adapter in self._adapters.values() if adapter.availability(frame).available
        )

    def choices(self, frame: ContextFrame) -> tuple[Choice, ...]:
        """The judge's allowed answers for the workflow question."""
        return tuple(
            Choice(
                id=adapter.descriptor.id,
                label=adapter.descriptor.name,
                detail=adapter.descriptor.description
                + (" Runs on labeled sample data only." if adapter.descriptor.sample_only else ""),
            )
            for adapter in self.available(frame)
        )

    def catalog(self, frame: ContextFrame | None = None) -> list[dict]:
        """Every registered workflow with its current availability, for the app."""
        rows = []
        for adapter in self._adapters.values():
            row = adapter.descriptor.to_dict()
            if frame is not None:
                row["availability"] = adapter.availability(frame).to_dict()
            rows.append(row)
        return rows
