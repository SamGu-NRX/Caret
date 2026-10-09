"""Edits that would show other words than the bundled promise; the check must refuse each and pass the real tree."""

import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("check_onboarding", ROOT / "scripts/check_onboarding_privacy.py")
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

VIEW = "apps/caret/Sources/CaretHost/Onboarding/OnboardingView.swift"
MAC = "apps/mac/Sources/Caret/PermissionView.swift"
SWITCHED_OFF = "It sends nothing from an app or website you've switched off."

MUTATIONS = [
    ("a promise sentence pasted into the view", "Text(text)\n", f'Text("{SWITCHED_OFF}")\n'),
    ("the retired promise pasted back", "Text(text)\n", 'Text("Never a whole document or conversation.")\n'),
    ("a fallback for the missing promise", "var promise = PrivacyPromiseText.bundled\n", 'var promise = PrivacyPromiseText.bundled ?? PrivacyPromise("")\n'),
    ("the load returns nothing", "return PrivacyPromise(text)", "return nil"),
    ("the load returns other words", "return PrivacyPromise(text)", 'return PrivacyPromise("Caret sends very little.")'),
]


class OnboardingPrivacyCheckTests(unittest.TestCase):
    def tree(self) -> Path:
        path = Path(tempfile.mkdtemp(prefix="caret-onboarding-check-"))
        self.addCleanup(shutil.rmtree, path)
        for file in (VIEW, MAC, "helper/src/privacy.ts"):
            (path / file).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / file, path / file)
        return path

    def test_the_real_tree_passes(self):
        self.assertEqual(check.refusals(ROOT), [])

    def test_each_edit_is_refused(self):
        for name, original, replacement in MUTATIONS:
            with self.subTest(name):
                path = self.tree()
                text = (path / VIEW).read_text()
                self.assertEqual(text.count(original), 1, name)
                (path / VIEW).write_text(text.replace(original, replacement))
                self.assertNotEqual(check.refusals(path), [], name)


if __name__ == "__main__":
    unittest.main()
