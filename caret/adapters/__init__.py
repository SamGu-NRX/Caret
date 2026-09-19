"""Workflow adapters. Each one plugs into caret.registry.WorkflowRegistry."""

from .sample_scheduler import SampleSchedulerWorkflow
from .unavailable import UnavailableWorkflow, seeds_from_catalog

__all__ = ["SampleSchedulerWorkflow", "UnavailableWorkflow", "seeds_from_catalog"]
