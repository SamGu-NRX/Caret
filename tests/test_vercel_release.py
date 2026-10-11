"""A launch-time development opt-in never opens Vercel from a release host."""
import os
import unittest
from unittest.mock import patch
from caret.completions import complete_text, CompletionError
from caret.providers.gateway import GatewayJudge, GatewayWriter
from caret.judge import JudgeError
from caret.engine import ProviderFailure


class VercelReleaseTests(unittest.TestCase):
    def test_completions_release_refuses_even_with_development_opt_in(self):
        with patch.dict(os.environ, {"CARET_DEV_VERCEL_GEMINI": "1", "CARET_RELEASE_HOST": "1"}, clear=True), patch("caret.completions.urlopen") as send:
            with self.assertRaisesRegex(CompletionError, "release host"):
                complete_text("fixture", api_key="fixture-key")
            send.assert_not_called()

    def test_gateway_writer_release_refuses_gemini_and_other_models(self):
        for model in ("google/gemini-2.5-flash", "amazon/nova-micro"):
            with self.subTest(model=model), patch.dict(os.environ, {"CARET_DEV_VERCEL_GEMINI": "1", "CARET_RELEASE_HOST": "1"}, clear=True), patch("caret.providers.gateway.inline_completion") as send:
                writer = GatewayWriter("fixture-key", model=model)
                with self.assertRaisesRegex(ProviderFailure, "release host"):
                    writer.complete(None, "fixture")
                send.assert_not_called()

    def test_gateway_writer_without_opt_in_refuses(self):
        with patch.dict(os.environ, {}, clear=True), patch("caret.providers.gateway.inline_completion") as send:
            with self.assertRaisesRegex(ProviderFailure, "disabled"):
                GatewayWriter("fixture-key").complete(None, "fixture")
            send.assert_not_called()

    def test_gateway_judge_release_refuses(self):
        with patch.dict(os.environ, {"CARET_DEV_VERCEL_GEMINI": "1", "CARET_RELEASE_HOST": "1"}, clear=True), patch("caret.providers.openai_chat.OpenAIChatClient.send") as send:
            with self.assertRaisesRegex(JudgeError, "release host"):
                GatewayJudge("fixture-key").choose(None, None)
            send.assert_not_called()
