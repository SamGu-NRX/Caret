"""Require onboarding to load the bundled privacy promise, with no copy of it in Swift and no fallback text.

This guards against drift: a sentence of the promise pasted into a view, or text shown when the resource is missing.
It does not try to prove what the view draws; the onboarding snapshot tests do that with marked sample text.
"""
from pathlib import Path
import re

VIEW = "apps/caret/Sources/CaretHost/Onboarding/OnboardingView.swift"
# The sentences of the promise onboarding used to hard-code; none of them may come back either.
RETIRED = (
    "To decide what to offer, Caret sends short snippets to a cloud model",
    "Never a whole document or conversation.",
    "The next words are written on this Mac.",
    "No request carries more than half of a conversation.",
)
LOAD = ('Bundle.main.url(forResource: "PrivacyPromise", withExtension: "txt")', "String(contentsOf: url, encoding: .utf8)",
        "return PrivacyPromise(text)")


def promise_sentences(root: Path) -> list[str]:
    source = (root / "helper/src/privacy.ts").read_text()
    promise = re.search(r"export const PRIVACY_PROMISE = `(.*?)`;", source, re.S)
    if promise is None:
        raise OSError("helper/src/privacy.ts has no PRIVACY_PROMISE template literal")
    pieces = re.split(r"\n\n|(?<=[.?!])\s+", promise.group(1))
    # Headings and very short sentences are words a view may use for its own reasons.
    return [piece.strip() for piece in pieces if len(piece.strip()) >= 40] + list(RETIRED)


def refusals(root: Path) -> list[str]:
    reasons = []
    view = (root / VIEW).read_text()
    binding = re.search(r"static let privacyLine\s*=\s*\{(.*?)\}\(\)", view, re.S)
    if binding is None or not all(token in binding.group(1) for token in LOAD):
        reasons.append(f"{root / VIEW}: PermissionsScreen.privacyLine must load and parse the bundled PrivacyPromise.txt")
    elif set(re.findall(r'"([^"]*)"', binding.group(1))) - {"PrivacyPromise", "txt"}:
        reasons.append(f"{root / VIEW}: PermissionsScreen.privacyLine may contain no text but the resource's name")
    if any("??" in line and re.search(r"promise|privacyLine", line, re.I) for line in view.splitlines()):
        reasons.append(f"{root / VIEW}: nothing may stand in for a missing privacy promise (??)")
    sentences = promise_sentences(root)
    for swift in sorted(path for folder in ("apps/caret/Sources", "apps/mac/Sources") for path in (root / folder).rglob("*.swift")):
        text = swift.read_text()
        copied = [sentence for sentence in sentences if sentence in text]
        if copied:
            reasons.append(f"{swift}: holds a copy of the privacy promise ({copied[0]!r}); render the bundled PrivacyPromise.txt instead")
    # apps/mac's permission panel has no cloud-data promise. If one is added, require the resource there too.
    mac_text = (root / "apps/mac/Sources/Caret/PermissionView.swift").read_text()
    if any(token in mac_text for token in ("Caret sends", "whole document", "Who receives it", "cloud model")):
        reasons.append(f"{root / 'apps/mac/Sources/Caret/PermissionView.swift'}: a privacy promise must render the bundled PrivacyPromise.txt")
    return [f"the onboarding copy must render PRIVACY_PROMISE from privacy.ts: {why}" for why in reasons]


if __name__ == "__main__":
    try:
        reasons = refusals(Path(__file__).resolve().parents[1])
    except OSError as error:
        raise SystemExit(f"Cannot verify onboarding privacy copy: {error}") from None
    if reasons:
        raise SystemExit("\n".join(reasons))
