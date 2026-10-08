"""Packaging routes, effective configuration and onboarding are release blockers."""
import importlib.util
import os
from pathlib import Path
import plistlib
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("check_gateway", ROOT / "scripts/check_vercel_gemini.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class PrivacyFollowupTests(unittest.TestCase):
    def test_real_bundler_gates_before_any_side_effect_in_every_mode(self):
        text = (ROOT / "apps/caret/scripts/build-app.sh").read_text()
        self.assertIn("privacy_gate.sh", text)
        self.assertLess(text.index("privacy_gate.sh"), text.index('mode="'))
        self.assertLess(text.index("privacy_gate.sh"), text.index("mkdir -p"))
        for mode in ("debug", "release", "acceptance"):
            result = subprocess.run(["/bin/bash", str(ROOT / "apps/caret/scripts/build-app.sh"), mode], capture_output=True, text=True, env={**os.environ, "IDENTITY": ""})
            self.assertEqual(result.returncode, 1)
            self.assertIn("privacy gate: refusing", result.stderr)

    def test_all_product_artifact_entrypoints_are_gated(self):
        producers = {"scripts/run_mac.py", "scripts/package_mac.py", "apps/caret/scripts/build-app.sh", "apps/caret/scripts/helper-bundle.config.mjs"}
        # Synthetic fixture apps have no Caret runtime/helper. The bridge test only re-signs a copied bridge executable.
        nonshipping = {"apps/screen-reader/scripts/bundle-fixture.sh", "apps/caret/scripts/fixture_app.py", "apps/caret/scripts/agent_bridge_acceptance.ts"}
        commands = re.compile(r"xcodebuild|swift build|codesign|hdiutil|rolldown")
        files = list((ROOT / "scripts").glob("*")) + list((ROOT / "apps").glob("*/scripts/*"))
        discovered = set()
        for path in files:
            if not path.is_file() or path.suffix not in {".py", ".sh", ".ts", ".mjs", ".swift"}:
                continue
            text = path.read_text()
            if commands.search(text):
                file = str(path.relative_to(ROOT))
                discovered.add(file)
                self.assertIn(file, producers | nonshipping, f"Unclassified artifact route: {file}")
        self.assertTrue(producers <= discovered)
        for file in producers:
            with self.subTest(file=file):
                self.assertIn("privacy_gate.sh", (ROOT / file).read_text())
        makefile = (ROOT / "Makefile").read_text()
        self.assertIn("scripts/run_mac.py", makefile)
        self.assertIn("scripts/package_mac.py --install", makefile)
        self.assertIn("scripts/package_mac.py --dmg", makefile)
        self.assertIn("xcodebuild", makefile)  # This route is enforced by the target's always-run phase.

    def test_unknown_xcode_plist_is_refused(self):
        with patch.dict(os.environ, {"INFOPLIST_FILE": "/tmp/unreviewed.plist"}, clear=True):
            self.assertTrue(any("INFOPLIST_FILE" in why for why in checker.refusals(ROOT)))

    def test_actual_bundle_plist_is_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            plist = Path(directory) / "Info.plist"
            plist.write_bytes(plistlib.dumps({"LSEnvironment": {"CARET_DEV_VERCEL_GEMINI": "1"}}))
            with patch.dict(os.environ, {"CARET_BUILD_PLIST": str(plist)}, clear=True):
                self.assertTrue(any("LSEnvironment" in why for why in checker.refusals(ROOT)))

    def test_current_onboarding_blocks_the_gate(self):
        result = subprocess.run(["/bin/sh", str(ROOT / "scripts/privacy_gate.sh")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("OnboardingView.swift", result.stderr)
        self.assertIn("the onboarding copy must render PRIVACY_PROMISE from privacy.ts", result.stderr)

    def test_effective_xcode_plist_is_checked_when_present(self):
        with tempfile.TemporaryDirectory() as directory:
            plist = Path(directory) / "Caret.app/Contents/Info.plist"
            plist.parent.mkdir(parents=True)
            plist.write_bytes(plistlib.dumps({"LSEnvironment": {"CARET_DEV_VERCEL_GEMINI": "1"}}))
            with patch.dict(os.environ, {"TARGET_BUILD_DIR": directory, "INFOPLIST_PATH": "Caret.app/Contents/Info.plist", "INFOPLIST_FILE": "apps/mac/Sources/Caret/Info.plist"}, clear=True):
                self.assertTrue(any("LSEnvironment" in why for why in checker.refusals(ROOT)))
