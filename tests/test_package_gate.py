"""The app is not packaged while the helper sends more than the privacy promise discloses (scripts/package_mac.py)."""

import importlib.util
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("package_mac", ROOT / "scripts" / "package_mac.py")
package_mac = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_mac)


class PackageGateTest(unittest.TestCase):
    def test_refuses_when_the_gate_refuses(self):
        refused = lambda *a, **k: subprocess.CompletedProcess(a, 1, "", "privacy gate: refusing to package: x")
        with self.assertRaises(SystemExit) as e:
            package_mac.privacy_gate(runner=refused)
        self.assertIn("refusing to package", str(e.exception))

    def test_passes_when_the_gate_passes(self):
        package_mac.privacy_gate(runner=lambda *a, **k: subprocess.CompletedProcess(a, 0, "ok", ""))

    def test_build_runs_the_gate_before_anything_else(self):
        calls = []
        original_gate, original_run = package_mac.privacy_gate, package_mac.run
        package_mac.privacy_gate = lambda: (calls.append("gate"), (_ for _ in ()).throw(SystemExit("refused")))
        package_mac.run = lambda command: calls.append("run")
        try:
            with self.assertRaises(SystemExit):
                package_mac.build()
        finally:
            package_mac.privacy_gate, package_mac.run = original_gate, original_run
        self.assertEqual(calls, ["gate"])

    def test_the_real_gate_refuses_this_tree_until_the_promise_discloses_the_owner_note(self):
        with self.assertRaises(SystemExit):
            package_mac.privacy_gate()


if __name__ == "__main__":
    unittest.main()
