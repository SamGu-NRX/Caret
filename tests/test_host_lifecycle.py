"""Host lifecycle ordering at the Python bridge boundary."""

import json
import threading
import unittest

from caret.bridge import Bridge
from caret.registry import WorkflowRegistry


class RecordingEngine:
    def __init__(self, events):
        self.events = events
        self.config = type("Config", (), {
            "interval_seconds": 2.0,
            "max_offer_age_seconds": 30.0,
            "max_inline_units": 120,
        })()

    def pump(self):
        return None

    def shutdown(self):
        self.events.append("shutdown")


class Output:
    def __init__(self, events):
        self.events = events
        self.lines = []
        self.lock = threading.Lock()

    def write(self, text):
        with self.lock:
            self.events.append("write")
            self.lines.append(text)

    def flush(self):
        pass


class HostLifecycleTests(unittest.TestCase):
    def test_shutdown_drains_the_engine_before_acknowledging_stop(self):
        events = []
        engine = RecordingEngine(events)
        output = Output(events)
        stdin = iter([json.dumps({"id": 1, "method": "shutdown", "params": {}})])
        bridge = Bridge(lambda *_: engine, WorkflowRegistry(), stdin, output)

        self.assertEqual(bridge.run(), 0)
        self.assertEqual(events, ["shutdown", "write"])
        self.assertEqual(json.loads(output.lines[0])["result"], {"stopped": True})



if __name__ == "__main__":
    unittest.main()
