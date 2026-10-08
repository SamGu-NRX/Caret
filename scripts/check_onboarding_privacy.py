"""Require the onboarding owner to render the generated privacy resource, not a second promise."""
from pathlib import Path
import re


def refusals(root: Path) -> list[str]:
    path = root / "apps/caret/Sources/CaretHost/Onboarding/OnboardingView.swift"
    text = path.read_text()
    # This is the existing view's binding. Keep the check specific so merely mentioning the resource cannot pass.
    binding = re.search(r'static let privacyLine\s*=\s*\{(.*?)\}\(\)', text, re.S)
    resource_read = binding is not None and all(token in binding.group(1) for token in (
        'Bundle.main.url(forResource: "PrivacyPromise", withExtension: "txt")',
        'String(contentsOf:', 'encoding: .utf8',
    ))
    # The resource's name is the binding's only text, so a missing resource cannot fall back to written-in words.
    fallback = binding is not None and set(re.findall(r'"((?:[^"\\]|\\.)*)"', binding.group(1))) - {"PrivacyPromise", "txt"}
    hardcoded = any(token in text for token in ("To decide what to offer, Caret sends", "Never a whole document or conversation", "No request carries more than half of a conversation"))
    # The window shows what the binding read (renders may pass their own text through the same parameter).
    rendered = all(token in text for token in ("var promise = PermissionsScreen.privacyLine", "PrivacyPromiseText(promise: promise)"))
    if not resource_read or fallback or hardcoded or not rendered:
        return [f"{path}: the onboarding copy must render PRIVACY_PROMISE from privacy.ts"]
    # apps/mac's permission panel has no cloud-data promise. If one is added, require the resource there too.
    mac_path = root / "apps/mac/Sources/Caret/PermissionView.swift"
    mac_text = mac_path.read_text()
    if any(token in mac_text for token in ("Caret sends", "whole document", "Who receives it", "cloud model")):
        return [f"{mac_path}: the onboarding copy must render PRIVACY_PROMISE from privacy.ts"]
    return []


if __name__ == "__main__":
    try:
        reasons = refusals(Path(__file__).resolve().parents[1])
    except OSError as error:
        raise SystemExit(f"Cannot verify onboarding privacy copy: {error}") from None
    if reasons:
        raise SystemExit("\n".join(reasons))
