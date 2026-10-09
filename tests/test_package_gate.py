"""Packaging must pass the shared privacy build gate before it builds or copies an app."""

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

    def test_the_copied_app_must_carry_the_promise(self):
        seen = []
        def runner(command, **kwargs):
            seen.append(kwargs["env"]["CARET_VERIFY_PRIVACY_RESOURCE"])
            return subprocess.CompletedProcess(command, 1, "", "privacy gate: refusing to package: the app's privacy promise x is missing")
        with self.assertRaises(SystemExit) as e:
            package_mac.verify_privacy_resource(Path("/tmp/dist/Caret.app"), runner=runner)
        self.assertIn("is missing", str(e.exception))
        self.assertEqual(seen, ["/tmp/dist/Caret.app/Contents/Resources/PrivacyPromise.txt"])

    def test_the_real_gate_refuses_this_tree_until_required_fixes_are_accepted(self):
        with self.assertRaises(SystemExit):
            package_mac.privacy_gate()


if __name__ == "__main__":
    unittest.main()
