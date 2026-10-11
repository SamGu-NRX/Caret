"""The foreground runs' input watchdog (fixture_app.Watchdog) under failed reads.

CodeRabbit on PR #9: one exception from the HID idle read ended the watchdog's thread silently, and
the run went on posting keys with nothing watching for a person's input. Run with
`python3 -m unittest apps/caret/scripts/test_fixture_app.py` from the repository root; it reads no
real HID state and posts nothing.
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fixture_app  # noqa: E402


class WatchdogReadFailureTests(unittest.TestCase):
    def setUp(self):
        self.real = fixture_app.hid_idle_seconds

    def tearDown(self):
        fixture_app.hid_idle_seconds = self.real

    def watchdog(self, front=lambda: {"pid": 1}):
        return fixture_app.Watchdog(synthetic=lambda t: False, front=front, names={1: "fixture"}, interval=0.01)

    def test_one_failed_read_is_retried_and_the_watchdog_keeps_running(self):
        reads = iter([ValueError("ioreg line in another shape")])

        def idle():
            for error in reads:
                raise error
            return 600.0  # nobody has touched the Mac for ten minutes

        fixture_app.hid_idle_seconds = idle
        dog = self.watchdog()
        with dog:
            time.sleep(0.2)
            self.assertTrue(dog._thread.is_alive(), "the watchdog still runs after one failed read")
        self.assertIsNone(dog.tripped)

    def test_repeated_failed_reads_stop_the_run(self):
        def idle():
            raise OSError("ioreg is missing")

        fixture_app.hid_idle_seconds = idle
        dog = self.watchdog()
        interrupted = False
        try:
            with dog:
                deadline = time.time() + 2
                while time.time() < deadline:
                    time.sleep(0.01)
        except KeyboardInterrupt:
            interrupted = True
        self.assertTrue(interrupted, "the main thread is interrupted, as for a person's input")
        self.assertIn("could not read the HID idle time 5 times", dog.tripped or "")

    def test_a_failed_front_app_read_skips_one_timeline_entry(self):
        fixture_app.hid_idle_seconds = lambda: 600.0
        calls = []

        def front():
            calls.append(1)
            if len(calls) == 1:
                raise ValueError("fixture-ax printed no JSON")
            return {"pid": 1}

        dog = self.watchdog(front=front)
        with dog:
            time.sleep(0.2)
            self.assertTrue(dog._thread.is_alive())
        self.assertIsNone(dog.tripped)
        self.assertEqual([entry[1:] for entry in dog.timeline], [(1, "fixture")])


if __name__ == "__main__":
    unittest.main()
