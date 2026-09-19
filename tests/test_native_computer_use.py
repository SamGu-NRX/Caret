"""Hermetic process-boundary tests. No desktop or live Jev calls."""
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from caret.adapters.native_computer_use import NativeComputerUseWorkflow
from caret.bridge import load_adapter
from support import frame


class NativeComputerUseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.binary = self.root / "executor"
        self.marker = self.root / "executed"
        self.write_executor()
        self.now = 0.0
        self.adapter = NativeComputerUseWorkflow(
            environ={"CARET_COMPUTER_USE_JEV": str(self.binary), "TYPESAFE_API_KEY": "test-secret"},
            clock=lambda: self.now,
        )
        self.frame = frame()

    def write_executor(self, *, exit_code=0, output=None):
        trace = output if output is not None else json.dumps({"number": 1, "action": "done", "output": "goal satisfied; no action taken"})
        self.binary.write_text("#!/bin/sh\n" + f"touch '{self.marker}'\n" + "cat <<'TRACE'\n" + trace + "\nTRACE\n" + f"exit {exit_code}\n")
        self.binary.chmod(0o755)

    def test_adapter_is_loadable_by_existing_bridge(self):
        self.assertEqual(load_adapter("caret.adapters.native_computer_use:NativeComputerUseWorkflow").descriptor.id, "native-open-calendar")

    def test_prepare_does_not_start_executor_and_accept_runs_once(self):
        proposal = self.adapter.prepare(self.frame)
        self.assertFalse(self.marker.exists())
        result = self.adapter.execute(self.frame, proposal)
        self.assertEqual(result.status, "completed")
        self.assertTrue(self.marker.exists())
        self.assertEqual(result.data["step_count"], 1)
        self.assertEqual(self.adapter.execute(self.frame, proposal).status, "failed")

    def test_changed_field_expired_and_tampered_proposals_do_not_execute(self):
        for kind in ("field", "expired", "tampered", "permission"):
            with self.subTest(kind=kind):
                self.now = 0
                proposal = self.adapter.prepare(self.frame)
                current = self.frame
                if kind == "field": current = frame(text="different")
                if kind == "expired": self.now = 31
                if kind == "tampered": proposal = replace(proposal, effect="something else")
                if kind == "permission": current = frame(accessibility=False)
                self.assertEqual(self.adapter.execute(current, proposal).status, "failed")
                self.assertFalse(self.marker.exists())

    def test_cancel_prevents_execution(self):
        proposal = self.adapter.prepare(self.frame)
        self.adapter.cancel(proposal)
        self.assertEqual(self.adapter.execute(self.frame, proposal).status, "failed")
        self.assertFalse(self.marker.exists())

    def test_child_receives_fixed_goal_and_bounded_step_count(self):
        arguments = self.root / "arguments"
        self.binary.write_text(
            "#!/bin/sh\n" + f"printf '%s\\n' \"$@\" > '{arguments}'\n" +
            "echo '{\"number\":1,\"action\":\"done\",\"output\":\"goal satisfied; no action taken\"}'\n"
        )
        self.binary.chmod(0o755)
        self.adapter.execute(self.frame, self.adapter.prepare(self.frame))
        self.assertEqual(arguments.read_text().splitlines(),
                         ["-json", "-max-steps", "8", "-goal", "Activate the Calendar application."])

    def test_timeout_never_claims_completion(self):
        self.binary.write_text("#!/bin/sh\nexec /bin/sleep 20\n")
        self.binary.chmod(0o755)
        self.adapter.timeout = 0.02
        result = self.adapter.execute(self.frame, self.adapter.prepare(self.frame))
        self.assertEqual(result.status, "failed")
        self.assertIn("timed out", result.summary)

    def test_missing_key_is_unavailable(self):
        self.adapter.environ.pop("TYPESAFE_API_KEY")
        self.assertFalse(self.adapter.availability(self.frame).available)

    def test_failures_and_missing_completion_never_claim_success(self):
        for output, code in (("not json", 0), ("{}", 0), ("[]", 0), ('{"number":1}', 0), ('{"number":1}', 1)):
            with self.subTest(output=output, code=code):
                self.write_executor(exit_code=code, output=output)
                result = self.adapter.execute(self.frame, self.adapter.prepare(self.frame))
                self.assertEqual(result.status, "failed")


if __name__ == "__main__":
    unittest.main()
