import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from caret.notes import write_note
from caret.skill_action import (
    GATEWAY_SKILL_ACTION_IDS,
    build_skill_messages,
    complete_skill_action,
    load_action_instructions,
    normalize_skill_output,
)


class SkillActionTests(unittest.TestCase):
    def test_gateway_action_ids_include_writing_skills(self):
        self.assertTrue({"extract-tasks", "tone-polite", "revise", "summarize", "translate"} <= GATEWAY_SKILL_ACTION_IDS)

    def test_load_action_instructions_from_notes_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            skills = Path(tmp) / "skills"
            write_note(
                skills / "summarize.md",
                title="Summarize",
                icon="list.bullet",
                body="Produce short bullet points.",
            )
            with patch.dict(os.environ, {"CARET_NOTES_ROOT": tmp}, clear=False):
                title, body = load_action_instructions("summarize")
            self.assertEqual(title, "Summarize")
            self.assertIn("bullet", body)

    def test_build_skill_messages_use_instructions_only(self):
        messages = build_skill_messages(
            instructions="Translate to Chinese by default.",
            input_text="Hola mundo",
        )
        self.assertIn("Translate to Chinese", messages[0]["content"])
        self.assertEqual(messages[1]["content"], "Hola mundo")

    def test_normalize_skill_output_strips_fences(self):
        self.assertEqual(normalize_skill_output('  "Hello"  '), "Hello")

    def test_complete_skill_action_calls_gateway(self):
        with tempfile.TemporaryDirectory() as tmp:
            skills = Path(tmp) / "skills"
            write_note(
                skills / "revise.md",
                title="Revise draft",
                icon="pencil",
                body="Tighten wording.",
            )
            with patch.dict(os.environ, {"CARET_NOTES_ROOT": tmp}, clear=False):
                with patch("caret.skill_action.complete_text", return_value="  Revised line.  ") as mock:
                    out = complete_skill_action(
                        "revise",
                        "  Draft line.  ",
                        instructions_override="Tighten wording.",
                    )
            mock.assert_called_once()
            self.assertEqual(out, "Revised line.")

    def test_complete_skill_action_uses_live_instructions_override(self):
        with patch("caret.skill_action.complete_text", return_value="你好") as mock:
            out = complete_skill_action(
                "translate",
                "Hello",
                instructions_override="Translate to Chinese by default.",
            )
        self.assertEqual(out, "你好")
        self.assertIn("Chinese", mock.call_args.kwargs["system"])

    def test_complete_skill_action_rejects_unknown_action(self):
        with self.assertRaises(ValueError):
            complete_skill_action("book-flight", "Fly me to Paris")


if __name__ == "__main__":
    unittest.main()
