"""The demo pattern judge: deterministic, labeled, and never a writer."""

import unittest

from caret.judge import Choice, route_question, workflow_question
from caret.pattern_judge import PatternJudge, match_meeting
from support import frame


class PatternJudgeTests(unittest.TestCase):
    def setUp(self):
        self.judge = PatternJudge()

    def test_a_scheduling_phrase_in_the_field_routes_to_action(self):
        verdict = self.judge.choose(route_question(), frame(1, text="Could we meet in Dallas next Tuesday? "))
        self.assertEqual(verdict.choice_id, "ACTION")
        self.assertEqual(verdict.model, "pattern-demo")
        self.assertIn("meet", verdict.reason)

    def test_plain_prose_abstains(self):
        verdict = self.judge.choose(route_question(), frame(1, text="The quarterly report is attached. ", clipboard=False))
        self.assertEqual(verdict.choice_id, "ABSTAIN")

    def test_it_never_answers_inline(self):
        for text in ("meet tomorrow", "hello there", "send three times please"):
            verdict = self.judge.choose(route_question(), frame(1, text=text, clipboard=False))
            self.assertNotEqual(verdict.choice_id, "INLINE", text)

    def test_the_clipboard_counts_when_the_field_does_not_match(self):
        # support.frame() puts "Austin to Dallas" on the clipboard: not a scheduling phrase.
        verdict = self.judge.choose(route_question(), frame(1, text="ok ", clipboard=True))
        self.assertEqual(verdict.choice_id, "ABSTAIN")

    def test_it_picks_the_meeting_workflow_only_when_offered(self):
        offered = workflow_question((Choice("book-calendar-link", "Propose times"), Choice("revise", "Revise")))
        meeting = frame(1, text="Could we meet next week?", clipboard=False)
        self.assertEqual(self.judge.choose(offered, meeting).choice_id, "book-calendar-link")
        not_offered = workflow_question((Choice("revise", "Revise"),))
        self.assertEqual(self.judge.choose(not_offered, meeting).choice_id, "NONE")

    def test_explicit_open_calendar_phrases_route_to_action(self):
        for text in ("open calendar", "Open the Calendar"):
            with self.subTest(text=text):
                verdict = self.judge.choose(route_question(), frame(1, text=text, clipboard=False))
                self.assertEqual(verdict.choice_id, "ACTION")
                self.assertEqual(verdict.model, "pattern-demo")

    def test_open_calendar_selects_the_native_adapter_only_when_offered(self):
        native = workflow_question((Choice("native-open-calendar", "Open Calendar"),))
        self.assertEqual(
            self.judge.choose(native, frame(1, text="open the calendar", clipboard=False)).choice_id,
            "native-open-calendar",
        )
        missing_native = workflow_question((Choice("book-calendar-link", "Propose times"),))
        self.assertEqual(
            self.judge.choose(missing_native, frame(1, text="open calendar", clipboard=False)).choice_id,
            "NONE",
        )

    def test_meeting_intent_wins_when_open_calendar_is_also_present(self):
        offered = workflow_question(
            (Choice("book-calendar-link", "Propose times"), Choice("native-open-calendar", "Open Calendar"))
        )
        self.assertEqual(
            self.judge.choose(
                offered,
                frame(1, text="Open Calendar so we can schedule a meeting", clipboard=False),
            ).choice_id,
            "book-calendar-link",
        )

    def test_matching_is_whole_word_and_case_insensitive(self):
        self.assertIsNotNone(match_meeting("Let's SCHEDULE it"))
        self.assertIsNone(match_meeting("the schedulers are busy"), "partial words must not match")
        self.assertIsNotNone(match_meeting("please send three times that work"))


if __name__ == "__main__":
    unittest.main()
