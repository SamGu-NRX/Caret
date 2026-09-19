"""The opt-in jev-scheduler adapter.

The tests that need Paul's checkout skip without it, because it is a separate
read-only reference clone and not part of this repository. The failure-handling
tests use a stub `node` so they run anywhere.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from caret.adapters.paul_scheduler import WRAPPER, PaulSchedulerWorkflow
from caret.registry import WorkflowError

REFERENCE = Path("/Users/samgu/Programming Projects/Caret-paul-reference/jev-scheduler")
HAS_REFERENCE = (REFERENCE / "lib" / "pipeline.ts").exists()
HAS_NODE = shutil.which("node") is not None


def stub_node(directory: Path, stdout: str, *, version: str = "v26.5.0", exit_code: int = 0, sleep: int = 0):
    """A fake `node` that answers --version and then prints canned output."""
    path = directory / "stub-node"
    path.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "--version" ]; then echo "%s"; exit 0; fi\n'
        "%s"
        "cat <<'STUBEOF'\n%s\nSTUBEOF\n"
        "exit %d\n" % (version, f"sleep {sleep}\n" if sleep else "", stdout, exit_code)
    )
    path.chmod(0o755)
    return str(path)


class AvailabilityTests(unittest.TestCase):
    def test_a_missing_checkout_is_unavailable_with_the_path(self):
        adapter = PaulSchedulerWorkflow(Path("/nonexistent/jev-scheduler"))
        available = adapter.availability(None)
        self.assertFalse(available.available)
        self.assertIn("/nonexistent/jev-scheduler", available.reason)

    def test_an_unavailable_adapter_refuses_to_prepare(self):
        adapter = PaulSchedulerWorkflow(Path("/nonexistent/jev-scheduler"))
        with self.assertRaisesRegex(WorkflowError, "unavailable"):
            adapter.prepare(None)

    @unittest.skipUnless(HAS_REFERENCE, "needs the read-only jev-scheduler reference checkout")
    def test_a_node_too_old_for_typescript_sources_is_unavailable_with_the_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = PaulSchedulerWorkflow(
                REFERENCE, node_executable=stub_node(Path(directory), "{}", version="v20.11.0")
            )
            available = adapter.availability(None)
            self.assertFalse(available.available)
            self.assertIn("cannot import TypeScript", available.reason)

    def test_an_unrunnable_node_is_unavailable_rather_than_an_error(self):
        adapter = PaulSchedulerWorkflow(REFERENCE, node_executable="/nonexistent/node")
        self.assertFalse(adapter.availability(None).available)


class ProcessFailureTests(unittest.TestCase):
    """A broken subprocess produces a failed result, never a fabricated one."""

    def run_with(self, stdout, **kwargs):
        with tempfile.TemporaryDirectory() as directory:
            adapter = PaulSchedulerWorkflow(
                REFERENCE, node_executable=stub_node(Path(directory), stdout, **kwargs), timeout=5
            )
            return adapter.execute(None, None)

    def test_output_that_is_not_json_fails(self):
        result = self.run_with("Segmentation fault")
        self.assertEqual(result.status, "failed")
        self.assertIn("not JSON", result.summary)

    def test_an_error_payload_fails_with_its_message(self):
        result = self.run_with(json.dumps({"ok": False, "error": "Cannot find module"}))
        self.assertEqual(result.status, "failed")
        self.assertIn("Cannot find module", result.summary)

    def test_an_unrecognized_pipeline_status_fails(self):
        result = self.run_with(json.dumps({"ok": True, "result": {"status": "surprise"}}))
        self.assertEqual(result.status, "failed")
        self.assertIn("surprise", result.summary)

    def test_a_run_that_exceeds_the_time_budget_is_stopped(self):
        result = self.run_with(json.dumps({"ok": True, "result": {"status": "scheduled"}}), sleep=10)
        self.assertEqual(result.status, "failed")
        self.assertIn("did not finish", result.summary)

    def test_a_reported_webhook_post_is_treated_as_a_broken_guard(self):
        with self.assertRaisesRegex(WorkflowError, "webhook"):
            self.run_with(
                json.dumps(
                    {"ok": True, "result": {"status": "scheduled", "webhook": {"url": "x", "status": 200}}}
                )
            )

    def test_his_own_no_option_outcome_completes_without_claiming_holds(self):
        result = self.run_with(json.dumps({"ok": True, "result": {"status": "no_options", "holds": []}}))
        self.assertEqual(result.status, "completed")
        self.assertIn("no candidate", result.summary)
        self.assertEqual(result.data["holds"], [])


@unittest.skipUnless(HAS_NODE, "needs Node on PATH")
class WrapperGuardTests(unittest.TestCase):
    def test_the_wrapper_refuses_to_run_when_a_webhook_url_is_present(self):
        environment = dict(os.environ, SCHEDULE_WEBHOOK_URL="https://example.invalid/hook")
        completed = subprocess.run(
            ["node", str(WRAPPER), str(REFERENCE)],
            capture_output=True,
            text=True,
            env=environment,
            timeout=60,
            check=False,
        )
        self.assertEqual(completed.returncode, 1)
        payload = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertFalse(payload["ok"])
        self.assertIn("SCHEDULE_WEBHOOK_URL", payload["error"])

    def test_the_wrapper_reports_a_missing_checkout_instead_of_crashing(self):
        completed = subprocess.run(
            ["node", str(WRAPPER), "/nonexistent/jev-scheduler"],
            capture_output=True,
            text=True,
            env={key: value for key, value in os.environ.items() if key != "SCHEDULE_WEBHOOK_URL"},
            timeout=60,
            check=False,
        )
        payload = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertFalse(payload["ok"])
        self.assertIn("No jev-scheduler pipeline", payload["error"])


@unittest.skipUnless(
    HAS_REFERENCE and HAS_NODE, "needs Node and the read-only jev-scheduler reference checkout"
)
class RealPipelineTests(unittest.TestCase):
    """Runs his actual pipeline. Jev is mocked and the webhook is unreachable."""

    def setUp(self):
        self.adapter = PaulSchedulerWorkflow(REFERENCE)

    def test_preparing_describes_the_run_without_starting_it(self):
        preparation = self.adapter.prepare(None)
        self.assertIn("separate Node process", preparation.effect)
        self.assertTrue(
            any("does not receive Caret's current context" in line for line in preparation.evidence),
            "the proposal must say it ignores live context",
        )

    def test_accepting_runs_his_pipeline_and_returns_its_real_result(self):
        preparation = self.adapter.prepare(None)
        result = self.adapter.execute(None, preparation)
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.data["jev_mode"], "mock", "his Jev client must stay off the network")
        self.assertIn(result.data["pipeline_status"], ("scheduled", "no_options", "stopped"))
        self.assertTrue(result.data["run_id"])

    def test_running_it_leaves_the_reference_checkout_unmodified(self):
        before = subprocess.run(
            ["git", "-C", str(REFERENCE.parent), "status", "--porcelain"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout
        self.adapter.execute(None, self.adapter.prepare(None))
        after = subprocess.run(
            ["git", "-C", str(REFERENCE.parent), "status", "--porcelain"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout
        self.assertEqual(before, after, "the adapter must not write into another contributor's checkout")


if __name__ == "__main__":
    unittest.main()
