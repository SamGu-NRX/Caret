"""Internal builds (build-app.sh debug and acceptance) skip only the release acceptance records; distribution keeps them.

Every other gate check still applies to an internal build, and an internal build is stamped CaretInternalBuild so
release and packaging refuse it.
"""

import importlib.util
import os
from pathlib import Path
import plistlib
import re
import runpy
import shutil
import subprocess
import unittest
from unittest.mock import patch

from tests.privacy_fixture import CHANGED, ROOT, app, clean_env, gate, tree


def bundler_prelude(root: Path) -> Path:
    """build-app.sh through its first gate call: everything it does before any build or file effect."""
    lines = (ROOT / "apps/caret/scripts/build-app.sh").read_text().splitlines(keepends=True)
    end = next(i for i, line in enumerate(lines) if "privacy_gate.sh" in line and not line.lstrip().startswith("#"))
    script = root / "apps/caret/scripts/build-app.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text("".join(lines[:end + 1]))
    return script


def package_module(root: Path):
    spec = importlib.util.spec_from_file_location("package_internal", ROOT / "scripts/package_mac.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.root = root
    return module


class InternalBuildGateTests(unittest.TestCase):
    def tree(self, accepted: bool) -> Path:
        root = tree(accepted)
        self.addCleanup(shutil.rmtree, root)
        return root

    def test_internal_bundler_modes_pass_without_the_records_and_release_does_not(self):
        root = self.tree(accepted=False)
        script = bundler_prelude(root)
        for mode, status in (("debug", 0), ("acceptance", 0), ("release", 1)):
            with self.subTest(mode):
                # An inherited flag must not turn a release build internal.
                result = subprocess.run(["/bin/bash", str(script), mode], capture_output=True, text=True, env=clean_env(CARET_INTERNAL_BUILD="1"))
                self.assertEqual(result.returncode, status, result.stderr)
                if status:
                    self.assertIn("pv2-sites-send", result.stderr)

    def run_mac(self, root: Path) -> list:
        """run_mac.py from the tree, up to its first command after the gate, which is recorded and not run."""
        (root / "scripts/run_mac.py").write_text((ROOT / "scripts/run_mac.py").read_text())
        calls, real_run = [], subprocess.run

        class Stop(Exception):
            pass

        def runner(command, **kwargs):
            if "privacy_gate.sh" in str(command):
                return real_run(command, **{**kwargs, "env": clean_env(**{k: v for k, v in (kwargs.get("env") or os.environ).items() if k == "CARET_INTERNAL_BUILD"})})
            calls.append((command, kwargs.get("env") or {}))
            raise Stop

        with patch("subprocess.run", side_effect=runner), patch("sys.argv", ["run_mac.py", "--build-only"]):
            try:
                runpy.run_path(str(root / "scripts/run_mac.py"), run_name="__main__")
            except Stop:
                pass
        return calls

    def test_make_app_is_an_internal_debug_build(self):
        root = self.tree(accepted=False)
        calls = self.run_mac(root)
        self.assertEqual(len(calls), 1, "the gate must pass without the records and hand on to xcodebuild")
        command, env = calls[0]
        self.assertEqual(command[0], "xcodebuild")
        self.assertEqual(command[command.index("-configuration") + 1], "Debug")
        self.assertEqual(env.get("CARET_INTERNAL_BUILD"), "1")

    def test_make_app_still_refuses_a_content_failure(self):
        root = self.tree(accepted=False)
        completions = root / "caret/completions.py"
        completions.write_text(completions.read_text().replace("VERCEL_GEMINI_ENABLED = False", "VERCEL_GEMINI_ENABLED = True"))
        with self.assertRaises(SystemExit) as refused:
            self.run_mac(root)
        self.assertIn("VERCEL_GEMINI_ENABLED", str(refused.exception))

    def xcode_phase(self, root: Path, phase: str, **env: str) -> subprocess.CompletedProcess:
        text = (ROOT / "Caret.xcodeproj/project.pbxproj").read_text()
        script = re.search(rf'/\* {phase} \*/ = \{{.*?shellScript = "((?:[^"\\]|\\.)*)";', text, re.S).group(1)
        return subprocess.run(["/bin/sh", "-c", script.replace('\\"', '"').replace("\\n", "\n")], capture_output=True, text=True, env=clean_env(
            SRCROOT=str(root), TARGET_BUILD_DIR=str(root / "build"), INFOPLIST_PATH="Caret.app/Contents/Info.plist",
            UNLOCALIZED_RESOURCES_FOLDER_PATH="Caret.app/Contents/Resources", **env))

    def test_an_internal_xcode_debug_build_is_stamped_and_a_later_plain_one_is_not(self):
        root = self.tree(accepted=False)
        plist = root / "build/Caret.app/Contents/Info.plist"
        plist.parent.mkdir(parents=True)
        plist.write_bytes(plistlib.dumps({}))
        internal = {"CONFIGURATION": "Debug", "CARET_INTERNAL_BUILD": "1"}
        for phase in ("Privacy gate", "Processed privacy gate"):
            result = self.xcode_phase(root, phase, **internal)
            self.assertEqual(result.returncode, 0, f"{phase}: {result.stderr}")
        self.assertIs(plistlib.loads(plist.read_bytes()).get("CaretInternalBuild"), True)
        # Again, incrementally: the stamp is already there.
        self.assertEqual(self.xcode_phase(root, "Processed privacy gate", **internal).returncode, 0)
        # The flag counts only in Debug.
        result = self.xcode_phase(root, "Processed privacy gate", CONFIGURATION="Release", CARET_INTERNAL_BUILD="1")
        self.assertIn("pv2-sites-send", result.stderr)
        self.assertNotIn("CaretInternalBuild", plistlib.loads(plist.read_bytes()))

    def test_packaging_and_xcode_ignore_an_inherited_internal_flag(self):
        root = self.tree(accepted=False)
        with patch.dict(os.environ, {"CARET_INTERNAL_BUILD": "1"}), self.assertRaises(SystemExit) as refused:
            package_module(root).privacy_gate()
        self.assertIn("pv2-sites-send", str(refused.exception))
        text = (ROOT / "Caret.xcodeproj/project.pbxproj").read_text()
        for phase in ("Privacy gate", "Processed privacy gate"):
            with self.subTest(phase):
                script = re.search(rf'/\* {phase} \*/ = \{{.*?shellScript = "((?:[^"\\]|\\.)*)";', text, re.S).group(1)
                build = root / "xcode"
                (build / "Caret.app/Contents/Resources").mkdir(parents=True, exist_ok=True)
                result = subprocess.run(["/bin/sh", "-c", script.replace('\\"', '"').replace("\\n", "\n")], capture_output=True, text=True, env=clean_env(
                    CONFIGURATION="Release", CARET_INTERNAL_BUILD="1", SRCROOT=str(root), TARGET_BUILD_DIR=str(build), INFOPLIST_PATH="Caret.app/Contents/Info.plist",
                    UNLOCALIZED_RESOURCES_FOLDER_PATH="Caret.app/Contents/Resources"))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("pv2-sites-send", result.stderr)

    def test_packaging_refuses_an_internal_stamped_bundle(self):
        root = self.tree(accepted=True)
        stamped = app(root, internal=True)
        with patch.dict(os.environ, {"CARET_INTERNAL_BUILD": "1"}), self.assertRaises(SystemExit) as refused:
            package_module(root).verify_privacy_resource(stamped)
        self.assertIn("CaretInternalBuild", str(refused.exception))

    def test_a_release_check_refuses_a_stamped_bundle_and_an_internal_check_an_unstamped_one(self):
        root = self.tree(accepted=True)
        stamped = app(root, internal=True)
        resource = str(stamped / "Contents/Resources/PrivacyPromise.txt")
        self.assertIn("CaretInternalBuild", gate(root, CARET_VERIFY_PRIVACY_RESOURCE=resource).stderr)
        (stamped / "Contents/Info.plist").write_bytes(b'<?xml version="1.0"?><plist version="1.0"><dict/></plist>')
        result = gate(root, CARET_VERIFY_PRIVACY_RESOURCE=resource, CARET_INTERNAL_BUILD="1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("CaretInternalBuild", result.stderr)

    def test_an_internal_build_still_refuses_a_missing_or_changed_promise(self):
        root = self.tree(accepted=False)
        stamped = app(root, internal=True)
        resource = stamped / "Contents/Resources/PrivacyPromise.txt"
        verify = lambda: gate(root, CARET_VERIFY_PRIVACY_RESOURCE=str(resource), CARET_INTERNAL_BUILD="1")
        self.assertEqual(verify().returncode, 0, verify().stderr)
        resource.write_text(CHANGED)
        self.assertIn("differs from PRIVACY_PROMISE", verify().stderr)
        resource.unlink()
        self.assertIn("is missing", verify().stderr)
        self.assertEqual(verify().returncode, 1)

    def test_internal_builds_are_stamped_before_signing(self):
        text = (ROOT / "apps/caret/scripts/build-app.sh").read_text()
        stamp = text.index("Add :CaretInternalBuild bool true")
        self.assertLess(text.index('cp Bundle/Info.plist "$contents/Info.plist"'), stamp)
        self.assertLess(stamp, text.index("sign --identifier"))


if __name__ == "__main__":
    unittest.main()
