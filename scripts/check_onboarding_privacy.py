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
    hardcoded = any(token in text for token in ("To decide what to offer, Caret sends", "Never a whole document or conversation", "No request takes more than half of any one conversation"))
    if not resource_read or hardcoded or "Text(Self.privacyLine)" not in text:
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
