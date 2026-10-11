"""Privacy refusals stop every app build route before build or install effects."""

import importlib.util
import os
from pathlib import Path
import re
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class PrivacyBuildGateTests(unittest.TestCase):
    def test_package_refuses_before_build_for_install_and_dmg(self):
        spec = importlib.util.spec_from_file_location("package_gate_route", ROOT / "scripts/package_mac.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for option in ("--install", "--dmg"):
            with self.subTest(option=option), patch("sys.argv", ["package_mac.py", option]), patch.object(module, "run") as build:
                with self.assertRaises(SystemExit) as refused:
                    module.build()
                self.assertIn("pv2-sites-send", str(refused.exception))
                build.assert_not_called()

    def test_build_phase_entrypoint_refuses_in_debug_and_release(self):
        for configuration in ("Debug", "Release"):
            with self.subTest(configuration=configuration):
                result = subprocess.run(
                    ["/bin/sh", str(ROOT / "scripts/privacy_gate.sh")],
                    cwd="/tmp", env={**os.environ, "SRCROOT": str(ROOT), "CONFIGURATION": configuration},
                    capture_output=True, text=True,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("pv2-sites-send", result.stderr)
                self.assertIn("PV2's Sites and send-boundary fixes aren't accepted yet", result.stderr)

    def test_xcode_phase_is_attached_first_and_always_runs(self):
        text = (ROOT / "Caret.xcodeproj/project.pbxproj").read_text()
        target = re.search(r'/\* Caret \*/ = \{\s*isa = PBXNativeTarget;.*?buildPhases = \((.*?)\);', text, re.S)
        self.assertIsNotNone(target)
        self.assertTrue(target.group(1).strip().splitlines()[0].endswith("/* Privacy gate */,"))
        phase = re.search(r'/\* Privacy gate \*/ = \{(.*?)\n\t\t\};', text, re.S)
        self.assertIsNotNone(phase)
        self.assertIn("isa = PBXShellScriptBuildPhase;", phase.group(1))
        self.assertIn("alwaysOutOfDate = 1;", phase.group(1))
        self.assertIn("runOnlyForDeploymentPostprocessing = 0;", phase.group(1))
        self.assertIn("scripts/privacy_gate.sh", phase.group(1))
