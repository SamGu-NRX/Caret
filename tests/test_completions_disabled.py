"""The undisclosed gateway route requires an explicit development opt-in."""

from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import os
import unittest
import warnings
from unittest.mock import patch

from caret import completions
from caret.__main__ import main


class CompletionsDisabledTests(unittest.TestCase):
    def test_default_is_off_and_disabled_sends_nothing_or_loads_no_key(self):
        self.assertIs(getattr(completions, "VERCEL_GEMINI_ENABLED", None), False)
        for environment in ({}, {"CARET_DEV_VERCEL_GEMINI": "true"}, {"CARET_DEV_VERCEL_GEMINI": "0"}):
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True), patch(
                "caret.completions.urlopen"
            ) as transport, patch("caret.completions.gateway_api_key") as key:
                with self.assertRaises(completions.CompletionError) as disabled:
                    completions.complete_text("Synthetic prompt", api_key="test-key")
                self.assertIn("disabled", str(disabled.exception))
                transport.assert_not_called()
                key.assert_not_called()

    def test_all_cli_callers_report_disabled_without_inserting_error_text(self):
        commands = [
            ["complete", "--prompt", "Synthetic prompt"],
            ["run-action", "--action", "revise", "--text", "Synthetic selection", "--instructions", "Be brief"],
            ["auto-expand", "--prefix", "Synthetic prefix"],
        ]
        for command in commands:
            out, err = StringIO(), StringIO()
            with self.subTest(command=command), patch.dict(os.environ, {"CARET_INLINE_PROVIDER": "gateway"}, clear=True), patch(
                "caret.completions.urlopen"
            ) as transport, patch("caret.providers.http.post_json") as groq, patch(
                "sys.argv", ["caret", *command]
            ), redirect_stdout(out), redirect_stderr(err), warnings.catch_warnings():
                warnings.simplefilter("ignore", ResourceWarning)
                self.assertEqual(main(), 1)
                result = json.loads(err.getvalue())
                self.assertEqual(result["status"], "disabled")
                self.assertIn("disabled", result["error"])
                self.assertEqual(out.getvalue(), "")
                transport.assert_not_called()
                groq.assert_not_called()
