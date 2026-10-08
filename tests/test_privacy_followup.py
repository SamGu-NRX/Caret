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

    def test_current_onboarding_renders_the_resource(self):
        onboarding = importlib.util.spec_from_file_location("check_onboarding", ROOT / "scripts/check_onboarding_privacy.py")
        module = importlib.util.module_from_spec(onboarding)
        onboarding.loader.exec_module(module)
        self.assertEqual(module.refusals(ROOT), [])

    def test_every_app_build_checks_the_finished_apps_promise_before_signing(self):
        bundler = (ROOT / "apps/caret/scripts/build-app.sh").read_text()
        check = bundler.index('CARET_VERIFY_PRIVACY_RESOURCE="$PWD/$contents/Resources/PrivacyPromise.txt"')
        self.assertLess(bundler.rindex("ditto "), check)
        self.assertLess(check, bundler.index("sign --identifier"))
        phase = re.search(r'/\* Processed privacy gate \*/ = \{(.*?)\n\t\t\};', (ROOT / "Caret.xcodeproj/project.pbxproj").read_text(), re.S)
        self.assertIn('CARET_VERIFY_PRIVACY_RESOURCE=\\"$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/PrivacyPromise.txt\\"', phase.group(1))
        package = (ROOT / "scripts/package_mac.py").read_text()
        self.assertLess(package.index("verify_privacy_resource(dist_app)"), package.index("adhoc_sign(dist_app)\n    print"))

    def test_effective_xcode_plist_is_checked_when_present(self):
        with tempfile.TemporaryDirectory() as directory:
            plist = Path(directory) / "Caret.app/Contents/Info.plist"
            plist.parent.mkdir(parents=True)
            plist.write_bytes(plistlib.dumps({"LSEnvironment": {"CARET_DEV_VERCEL_GEMINI": "1"}}))
            with patch.dict(os.environ, {"TARGET_BUILD_DIR": directory, "INFOPLIST_PATH": "Caret.app/Contents/Info.plist", "INFOPLIST_FILE": "apps/mac/Sources/Caret/Info.plist", "CARET_REQUIRE_PROCESSED_PLIST": "1"}, clear=True):
                self.assertTrue(any("LSEnvironment" in why for why in checker.refusals(ROOT)))

    def test_stale_safe_output_cannot_hide_unsafe_selected_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "caret").mkdir()
            (root / "caret/completions.py").write_text("VERCEL_GEMINI_ENABLED = False\n")
            for selected in ("apps/mac/Sources/Caret/Info.plist", "apps/caret/Bundle/Info.plist"):
                source = root / selected
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_bytes(plistlib.dumps({"LSEnvironment": {"CARET_DEV_VERCEL_GEMINI": "1"}}))
                built = root / "build/Caret.app/Contents/Info.plist"
                built.parent.mkdir(parents=True, exist_ok=True)
                built.write_bytes(plistlib.dumps({}))
                with self.subTest(source=selected), patch.dict(os.environ, {
                    "INFOPLIST_FILE": selected, "TARGET_BUILD_DIR": str(root / "build"),
                    "INFOPLIST_PATH": "Caret.app/Contents/Info.plist",
                }, clear=True):
                    self.assertTrue(any("LSEnvironment" in why for why in checker.refusals(root)))

    def test_required_processed_plist_must_exist(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "CARET_REQUIRE_PROCESSED_PLIST": "1", "TARGET_BUILD_DIR": directory,
            "INFOPLIST_PATH": "Caret.app/Contents/Info.plist",
        }, clear=True):
            self.assertTrue(any("processed Info.plist" in why for why in checker.refusals(ROOT)))

    def test_final_xcode_gate_depends_on_processed_plist_and_runs_last(self):
        text = (ROOT / "Caret.xcodeproj/project.pbxproj").read_text()
        target = re.search(r'/\* Caret \*/ = \{\s*isa = PBXNativeTarget;.*?buildPhases = \((.*?)\);', text, re.S)
        self.assertIsNotNone(target)
        self.assertTrue(target.group(1).strip().splitlines()[-1].endswith("/* Processed privacy gate */,"))
        phase = re.search(r'/\* Processed privacy gate \*/ = \{(.*?)\n\t\t\};', text, re.S)
        self.assertIsNotNone(phase)
        self.assertIn('"$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)"', phase.group(1))
        self.assertIn("CARET_REQUIRE_PROCESSED_PLIST=1", phase.group(1))
        self.assertIn("$TARGET_BUILD_DIR/$INFOPLIST_PATH", phase.group(1))
        self.assertIn("alwaysOutOfDate = 1;", phase.group(1))
        self.assertIn("runOnlyForDeploymentPostprocessing = 0;", phase.group(1))
        self.assertIn("scripts/privacy_gate.sh", phase.group(1))

    def test_v2_bundler_checks_selected_source_and_copied_plist_before_signing(self):
        text = (ROOT / "apps/caret/scripts/build-app.sh").read_text()
        self.assertIn('CARET_SOURCE_PLIST="$root/apps/caret/Bundle/Info.plist"', text)
        self.assertIn('CARET_REQUIRE_PROCESSED_PLIST=1', text)
        final = text.index('CARET_BUILD_PLIST="$PWD/$contents/Info.plist"')
        self.assertLess(text.index('cp Bundle/Info.plist'), final)
        self.assertLess(final, text.index('sign --identifier'))

    def test_source_gate_does_not_block_on_stale_output_before_processing(self):
        with tempfile.TemporaryDirectory() as directory:
            plist = Path(directory) / "Caret.app/Contents/Info.plist"
            plist.parent.mkdir(parents=True)
            plist.write_bytes(plistlib.dumps({"LSEnvironment": {"CARET_DEV_VERCEL_GEMINI": "1"}}))
            with patch.dict(os.environ, {
                "TARGET_BUILD_DIR": directory, "INFOPLIST_PATH": "Caret.app/Contents/Info.plist",
                "INFOPLIST_FILE": "apps/mac/Sources/Caret/Info.plist",
            }, clear=True):
                self.assertEqual(checker.refusals(ROOT), [])
