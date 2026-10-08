"""Require onboarding to show the generated privacy resource and nothing in its place.

The promise's path from the bundle to the screen is checked piece by piece: the binding that loads it is pinned
whole, the window and the step pass it on without a fallback, the view that draws it has no text of its own, and
the one message shown without a resource is pinned word for word. tests/test_onboarding_privacy_check.py records
the edits each rule refuses.
"""
from pathlib import Path
import re

VIEW = "apps/caret/Sources/CaretHost/Onboarding/OnboardingView.swift"
MODEL = "apps/caret/Sources/CaretHostCore/PrivacyPromise.swift"
HEAD = "apps/caret/Sources/CaretHost/Design/WindowParts.swift"

# The only words the promise's place may show without a resource. A development run reaches it; an app build cannot
# (privacy-gate.ts refuses an app whose PrivacyPromise.txt is missing, empty or different).
MISSING_TITLE = "No privacy promise in this build"
MISSING_LINE = ("PrivacyPromise.txt is missing or empty, so this screen can't say what Caret sends. Development runs have no "
                "app bundle; apps/caret/scripts/build-app.sh writes the file into the app.")

BINDING = '''static let privacyLine = { () -> PrivacyPromise? in
    guard let url = Bundle.main.url(forResource: "PrivacyPromise", withExtension: "txt"),
          let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    return PrivacyPromise(text)
}()'''
# Where the promise sits on the step: the parsed resource, or the pinned message. Nothing else.
PLACE = '''Group {
    if let promise {
        PrivacyPromiseText(promise: promise)
    } else {
        VStack(alignment: .leading, spacing: 4) {
            GroupHead(text: Self.missingPromiseTitle)
            Text(Self.missingPromiseLine)
                .font(.system(size: 12))
                .foregroundStyle(Color(token: Tokens.ink))
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}'''
# Exact lines that hand the loaded promise from the binding to the step.
HAND_OFF = [
    "var promise = PermissionsScreen.privacyLine",
    "case .permissions: PermissionsScreen(state: state, promise: promise, animated: animated, send: send)",
    "var promise: PrivacyPromise?",
]
# What PrivacyPromiseText may construct: layout and the two text views, each fed only the block's own text.
DRAWING_TYPES = {"ScrollingColumn", "VStack", "ForEach", "Array", "GroupHead", "Text", "Color", "LinearGradient", "CGFloat"}
LITERAL = re.compile(r'"((?:[^"\\\n]|\\.)*)"')


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def block(text: str, start: str) -> str | None:
    """The text from `start` through its matching closing brace, or None."""
    at = text.find(start)
    if at < 0:
        return None
    depth = 0
    for i in range(text.index("{", at), len(text)):
        depth += {"{": 1, "}": -1}.get(text[i], 0)
        if depth == 0:
            return text[at:i + 1]
    return None


def code(text: str) -> str:
    """Swift without its comments, so a word in a comment counts for nothing."""
    return re.sub(r"//[^\n]*", "", text)


def calls(text: str, name: str) -> list[str]:
    """Every `name(...)` call with its balanced arguments."""
    found = []
    for match in re.finditer(rf"\b{re.escape(name)}\(", text):
        depth = 0
        for i in range(match.end() - 1, len(text)):
            depth += {"(": 1, ")": -1}.get(text[i], 0)
            if depth == 0:
                found.append(text[match.start():i + 1])
                break
    return found


def view_problems(text: str) -> list[str]:
    problems = []
    binding = re.search(r"static let privacyLine\s*=\s*\{.*?\}\(\)", text, re.S)
    if binding is None or squash(binding.group(0)) != squash(BINDING):
        problems.append("PermissionsScreen.privacyLine must be exactly the binding that loads PrivacyPromise.txt and returns it parsed")
    for line in HAND_OFF:
        if len(re.findall(rf"^\s*{re.escape(line)}\s*$", text, re.M)) != 1:
            problems.append(f"the promise must be handed on by exactly this line: {line}")
    if any("??" in line and re.search(r"promise|privacyLine", line, re.I) for line in code(text).splitlines()):
        problems.append("nothing may stand in for a missing promise (??)")
    for name, value in (("missingPromiseTitle", MISSING_TITLE), ("missingPromiseLine", MISSING_LINE)):
        if not re.search(rf'^\s*static let {name} = "{re.escape(value)}"\s*$', text, re.M):
            problems.append(f"PermissionsScreen.{name} must read exactly: {value}")
    screen = block(text, "struct PermissionsScreen: View {")
    place = screen and block(screen[screen.find("var body"):], "Group {")
    if place is None or squash(code(place)) != squash(PLACE):
        problems.append("the step must show the loaded promise or the pinned missing message, and nothing else, in the promise's place")
    drawing = block(text, "struct PrivacyPromiseText: View {")
    if drawing is None:
        return problems + ["PrivacyPromiseText is missing"]
    body = code(drawing)
    if LITERAL.search(body) or '"""' in body or "??" in body:
        problems.append("PrivacyPromiseText may show no text of its own")
    if set(calls(body, "Text")) != {"Text(text)"} or set(calls(body, "GroupHead")) != {"GroupHead(text: text)"}:
        problems.append("PrivacyPromiseText must draw each block's own text, as Text(text) and GroupHead(text: text)")
    if "ForEach(Array(promise.blocks.enumerated())" not in body or sorted(re.findall(r"case \.\w+\(let text\)", body)) != ["case .heading(let text)", "case .paragraph(let text)"]:
        problems.append("PrivacyPromiseText's text must come from promise.blocks")
    if len(re.findall(r"\blet text\b", body)) != 2 or re.search(r"\b(var text\b|text\s*=[^=])", body):
        problems.append("PrivacyPromiseText may not bind text other than from a block")
    constructed = set(re.findall(r"\b([A-Z]\w*)\s*[({]", body)) - {"View", "PrivacyPromise"}
    if not constructed <= DRAWING_TYPES:
        problems.append(f"PrivacyPromiseText may draw only layout and the block's text, not {sorted(constructed - DRAWING_TYPES)}")
    if set(re.findall(r"\b(?:Self|PrivacyPromiseText)\.\w+", body)) - {"Self.fade", "Self.gap"}:
        problems.append("PrivacyPromiseText may read no other value to show")
    return problems


def refusals(root: Path) -> list[str]:
    path = root / VIEW
    problems = view_problems(path.read_text())
    # A group head draws the heading: it must show the text it is given.
    head = block(code((root / HEAD).read_text()), "struct GroupHead: View {")
    if head is None or LITERAL.search(head) or set(calls(head, "Text")) != {"Text(text)"}:
        problems.append(f"{root / HEAD}: GroupHead must draw only the text it is given")
    # The parse keeps the words: no literal but its separator and the punctuation that ends a sentence.
    model = code((root / MODEL).read_text())
    if set(LITERAL.findall(model)) - {r"\n\n", r"\n", r".,;:!?\"'\u{201D}\u{2019})"} or '"""' in model:
        problems.append(f"{root / MODEL}: the parse may add no words of its own")
    # Only renders pass their own promise; the window uses the binding's default.
    for swift in sorted((root / "apps/caret/Sources").rglob("*.swift")):
        if swift.name.startswith("Gallery"):
            continue
        if any("promise:" in call for call in calls(code(swift.read_text()), "OnboardingView")):
            problems.append(f"{swift}: the window must show the bundled promise, not pass its own")
    if problems:
        return [f"{path}: the onboarding copy must render PRIVACY_PROMISE from privacy.ts: {why}" for why in problems]
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
