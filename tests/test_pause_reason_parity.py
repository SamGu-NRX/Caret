"""The Mac host and the Python core must agree on context pause reasons.

The host sends ``ContextPauseReason`` raw values over ``context.pause`` and the
bridge rejects any reason outside ``PAUSE_REASONS``. Nothing else ties the two
lists together, so a reason added on one side only would fail at runtime: the
host gets ``invalid_request`` and keeps showing an offer it meant to withdraw.
This test reads the Swift source directly because the Swift side cannot be
built here.
"""

import re
import unittest
from pathlib import Path

from caret.router import PAUSE_REASONS

ROOT = Path(__file__).resolve().parents[1]
SWIFT_SOURCE = ROOT / "apps/mac/Sources/CaretCore/CoreProtocol.swift"
ENUM_NAME = "ContextPauseReason"

_ENUM_HEADER = re.compile(r"\benum\s+(\w+)\s*:\s*String\b[^{]*\{")
# One case item: `name` (raw value is the name) or `name = "raw-value"`.
_CASE_ITEM = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*"([^"\\]*)")?$')


class SwiftEnumParseError(AssertionError):
    pass


def _without_comments(text: str, enum_name: str) -> str:
    """``text`` with Swift ``//`` and ``/* */`` comments blanked out, string literals kept.

    A brace or ``//`` inside a comment or a raw-value string must not end the enum body
    early or cut a case line, or the parity check would compare only part of the enum.
    Newlines are kept so body line numbers in errors stay right.
    """
    out: list[str] = []
    index, length = 0, len(text)
    in_string = False
    while index < length:
        char = text[index]
        if in_string:
            out.append(char)
            if char == "\\" and index + 1 < length:
                out.append(text[index + 1])
                index += 2
                continue
            if char == '"':
                in_string = False
            index += 1
        elif char == '"':
            in_string = True
            out.append(char)
            index += 1
        elif text.startswith("//", index):
            newline = text.find("\n", index)
            index = length if newline == -1 else newline
        elif text.startswith("/*", index):
            close = text.find("*/", index + 2)
            if close == -1:
                raise SwiftEnumParseError(f"unterminated block comment after `enum {enum_name}`")
            out.append("\n" * text.count("\n", index, close))
            index = close + 2
        else:
            out.append(char)
            index += 1
    return "".join(out)


def swift_string_enum_raw_values(source: str, enum_name: str) -> list[str]:
    """Raw values of a Swift ``String`` enum whose body holds only cases.

    Anything else in the body (methods, computed properties, associated
    values, backtick names) raises, because guessing there could make the
    parity check pass on a list it did not actually read.
    """
    header = next(
        (m for m in _ENUM_HEADER.finditer(source) if m.group(1) == enum_name), None
    )
    if header is None:
        raise SwiftEnumParseError(f"no `enum {enum_name}: String {{` declaration found")

    body = _without_comments(source[header.end():], enum_name)
    depth, end = 1, None
    in_string = False
    for index, char in enumerate(body):
        if in_string:
            if char == "\\":
                continue
            if char == '"' and body[index - 1] != "\\":
                in_string = False
        elif char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                end = index
                break
    if end is None:
        raise SwiftEnumParseError(f"`enum {enum_name}` has no closing brace")

    values: list[str] = []
    for line_number, raw_line in enumerate(body[:end].splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        if not line.startswith("case "):
            raise SwiftEnumParseError(
                f"`enum {enum_name}` body line {line_number} is not a case declaration: "
                f"{raw_line.strip()!r}. Update this parser before trusting the parity check."
            )
        for item in line[len("case "):].split(","):
            match = _CASE_ITEM.match(item.strip())
            if match is None:
                raise SwiftEnumParseError(
                    f"`enum {enum_name}` case item {item.strip()!r} on body line "
                    f"{line_number} is not `name` or `name = \"raw\"`"
                )
            values.append(match.group(2) if match.group(2) is not None else match.group(1))
    if not values:
        raise SwiftEnumParseError(f"`enum {enum_name}` declares no cases")
    return values


class PauseReasonParityTests(unittest.TestCase):
    def test_swift_and_python_pause_reasons_match(self):
        if not SWIFT_SOURCE.is_file():
            self.fail(f"{SWIFT_SOURCE.relative_to(ROOT)} is missing; {ENUM_NAME} moved?")
        swift = swift_string_enum_raw_values(SWIFT_SOURCE.read_text(encoding="utf-8"), ENUM_NAME)
        self.assertEqual(len(swift), len(set(swift)), f"duplicate raw values in {ENUM_NAME}: {swift}")

        swift_only = sorted(set(swift) - PAUSE_REASONS)
        python_only = sorted(PAUSE_REASONS - set(swift))
        problems = []
        if swift_only:
            problems.append(
                f"Swift {ENUM_NAME} has {swift_only} that caret/router.py PAUSE_REASONS lacks "
                "(the bridge will reject these pauses)"
            )
        if python_only:
            problems.append(
                f"caret/router.py PAUSE_REASONS has {python_only} that Swift {ENUM_NAME} lacks "
                "(the host can never send these)"
            )
        if problems:
            self.fail("; ".join(problems))


class SwiftEnumParserTests(unittest.TestCase):
    def test_reads_bare_and_explicit_raw_values_and_ignores_other_enums(self):
        source = """
        enum Other: String { case nope }
        public enum Reason: String, Codable, CaseIterable {
            case idle, locked // trailing comment
            case generatedInput = "generated-input"

            case secureField = "secure-field", workflowActive = "workflow-active"
        }
        """
        self.assertEqual(
            swift_string_enum_raw_values(source, "Reason"),
            ["idle", "locked", "generated-input", "secure-field", "workflow-active"],
        )

    def test_braces_and_slashes_in_comments_and_strings_do_not_end_the_body(self):
        source = """
        enum Reason: String {
            /// The person acted. Never ends the enum } early.
            case idle // also not the end }
            /* a block comment { with } braces */
            case brace = "a}b"
            case path = "a//b"
            case last
        }
        """
        self.assertEqual(
            swift_string_enum_raw_values(source, "Reason"),
            ["idle", "a}b", "a//b", "last"],
        )

    def test_missing_enum_fails_loudly(self):
        with self.assertRaisesRegex(SwiftEnumParseError, "no `enum Reason: String"):
            swift_string_enum_raw_values("enum Reasons: String { case idle }", "Reason")

    def test_non_case_member_fails_loudly(self):
        source = 'enum Reason: String {\n case idle\n var label: String { "x" }\n}'
        with self.assertRaisesRegex(SwiftEnumParseError, "not a case declaration"):
            swift_string_enum_raw_values(source, "Reason")

    def test_unrecognised_case_item_fails_loudly(self):
        with self.assertRaisesRegex(SwiftEnumParseError, "is not `name`"):
            swift_string_enum_raw_values('enum Reason: String { case `default` }', "Reason")

    def test_empty_enum_fails_loudly(self):
        with self.assertRaisesRegex(SwiftEnumParseError, "declares no cases"):
            swift_string_enum_raw_values("enum Reason: String {}", "Reason")


if __name__ == "__main__":
    unittest.main()
