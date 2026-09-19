"""Workflows that are registered but cannot run here.

They exist so the catalog the app shows is complete and so the reason a
workflow is missing is visible. The judge is never offered them: the registry
filters on availability before building the question. An adapter that cannot
run returns an explanation, never a result it did not produce.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..context import ContextFrame
from ..registry import (
    Availability,
    ExecutionResult,
    Preparation,
    WorkflowDescriptor,
    WorkflowError,
)


class UnavailableWorkflow:
    """A declared workflow whose executor is not wired in this checkout."""

    def __init__(self, descriptor: WorkflowDescriptor, reason: str) -> None:
        self._descriptor = descriptor
        self._reason = reason

    @property
    def descriptor(self) -> WorkflowDescriptor:
        return self._descriptor

    def availability(self, frame: ContextFrame) -> Availability:
        return Availability(False, self._reason)

    def prepare(self, frame: ContextFrame) -> Preparation:
        raise WorkflowError(f"'{self._descriptor.id}' is unavailable: {self._reason}")

    def execute(self, frame: ContextFrame, preparation: Preparation | None) -> ExecutionResult:
        raise WorkflowError(f"'{self._descriptor.id}' is unavailable: {self._reason}")

    def cancel(self, preparation: Preparation | None) -> ExecutionResult:
        return ExecutionResult(status="cancelled", summary=f"'{self._descriptor.id}' never started")


def seeds_from_catalog(
    catalog_path: Path,
    *,
    skip: frozenset[str] = frozenset(),
) -> list[UnavailableWorkflow]:
    """Register the workflows.json seeds whose executors do not exist yet.

    ``skip`` names IDs a real adapter already covers.
    """
    seeds = json.loads(catalog_path.read_text())
    adapters = []
    for seed in seeds:
        if seed["id"] in skip or seed.get("status") == "local_preview":
            continue
        adapters.append(
            UnavailableWorkflow(
                WorkflowDescriptor(
                    id=seed["id"],
                    name=seed["name"],
                    description=f"Stages: {', '.join(seed.get('stages', []))}.",
                    required_inputs=tuple(seed.get("inputs", ())),
                    execution_method="unwired",
                ),
                reason=(
                    "No executor is connected. Skyvern owns browser steps and Computer Use Jev "
                    "owns native steps; neither adapter is implemented in this slice."
                ),
            )
        )
    return adapters
