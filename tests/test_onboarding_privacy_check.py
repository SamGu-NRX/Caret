"""Recorded mutations of the onboarding promise path: each one shows other words than the bundled promise, and the
check must refuse every one of them while passing the real tree."""

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
MODEL = "apps/caret/Sources/CaretHostCore/PrivacyPromise.swift"
HEAD = "apps/caret/Sources/CaretHost/Design/WindowParts.swift"
CONTROLLER = "apps/caret/Sources/CaretHost/Onboarding/OnboardingController.swift"
SWITCHED_OFF = "It sends nothing from an app or website you've switched off."

# (name, file, original, replacement)
MUTATIONS = [
    ("paragraph shows a literal sentence", VIEW, "Text(text)\n", f'Text("{SWITCHED_OFF}")\n'),
    ("paragraph shows another static", VIEW, "Text(text)\n", "Text(PermissionsScreen.missingPromiseLine)\n"),
    ("paragraph shows verbatim text", VIEW, "Text(text)\n", "Text(verbatim: text + \".\")\n"),
    ("heading shows a literal", VIEW, "GroupHead(text: text).padding", 'GroupHead(text: "What Caret sends").padding'),
    ("window default falls back", VIEW, "var promise = PermissionsScreen.privacyLine\n", 'var promise = PermissionsScreen.privacyLine ?? PrivacyPromise("")\n'),
    ("step call falls back", VIEW, "PermissionsScreen(state: state, promise: promise,", 'PermissionsScreen(state: state, promise: promise ?? PrivacyPromise("x"),'),
    ("render site falls back", VIEW, "PrivacyPromiseText(promise: promise)", 'PrivacyPromiseText(promise: promise ?? PrivacyPromise("x")!)'),
    ("load returns nothing", VIEW, "return PrivacyPromise(text)", "return nil"),
    ("load returns other words", VIEW, "return PrivacyPromise(text)", f'return PrivacyPromise("{SWITCHED_OFF}")'),
    ("load falls back inside the binding", VIEW, 'withExtension: "txt"),', 'withExtension: "txt") ?? URL(fileURLWithPath: "/tmp/p.txt"),'),
    ("missing message reworded", VIEW, "PrivacyPromise.txt is missing or empty", "Caret sends very little. PrivacyPromise.txt is missing or empty"),
    ("missing branch shows a promise sentence", VIEW, "Text(Self.missingPromiseLine)", f'Text("{SWITCHED_OFF}")'),
    ("window passes another promise", CONTROLLER, "OnboardingView(state: state, character: figure.character, send: send)",
     'OnboardingView(state: state, character: figure.character, send: send, promise: PrivacyPromise("x"))'),
    ("model adds a block", MODEL, ".map { block in", '.map { block in _ = "x";'),
    ("group head draws other words", HEAD, "        Text(text)\n            .font(.system(size: 12, weight: .semibold))",
     '        Text(text + " (approved)")\n            .font(.system(size: 12, weight: .semibold))'),
]


class OnboardingPrivacyCheckTests(unittest.TestCase):
    def tree(self) -> Path:
        path = Path(tempfile.mkdtemp(prefix="caret-onboarding-check-"))
        self.addCleanup(shutil.rmtree, path)
        for file in (VIEW, MODEL, HEAD, CONTROLLER, "apps/mac/Sources/Caret/PermissionView.swift"):
            (path / file).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / file, path / file)
        return path

    def test_the_real_tree_passes(self):
        self.assertEqual(check.refusals(ROOT), [])
        self.assertEqual(check.refusals(self.tree()), [])

    def test_every_recorded_mutation_is_refused(self):
        for name, file, original, replacement in MUTATIONS:
            with self.subTest(name):
                path = self.tree()
                text = (path / file).read_text()
                self.assertEqual(text.count(original), 1, f"{name}: the mutation must apply to exactly one place")
                (path / file).write_text(text.replace(original, replacement))
                self.assertNotEqual(check.refusals(path), [], name)


if __name__ == "__main__":
    unittest.main()
