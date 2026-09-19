---
task_id: translate-selection-or-clipboard
complexity_level: 1
date: 2026-09-19
status: completed
---

# TASK ARCHIVE: translate-selection-or-clipboard

## SUMMARY

Translate shared the gateway input path (selection, then caret line, then clipboard). A missing or stale target, or a focused line with no selection, made it look clipboard-only — or used the caret line instead of the clipboard. Translate now uses a non-empty selection if one exists, otherwise the clipboard. It never uses the caret line.

## REQUIREMENTS

- Translate uses selected text when a non-empty selection exists.
- Translate uses the clipboard when nothing is selected.
- Other skill actions stay on their existing input rules.

## IMPLEMENTATION

`SkillActionInput` is the testable resolver (`sourceText` / `translateTarget`). The runner uses those for Translate only. Caret keeps `rememberedSelection` when the monitor publishes nil because Caret is frontmost. A live empty selection still means clipboard.

Key files: `apps/mac/Sources/Caret/SkillActionRunner.swift`, `apps/mac/Sources/Caret/CaretApp.swift`, `apps/mac/Tests/SkillActionInputTests.swift`.

Shipped in `c4909fe` / PR #16.

## TESTING

- `SkillActionInputTests` covers selection vs clipboard vs caret line.
- `make check` passed: Python 300 tests (4 skipped), Swift CaretTests + CaretCoreTests, pin check, xcodebuild Debug.
- `/niko-qa` PASS. Advisories (non-blocking): Translate skips `refreshNow()`; `rememberedSelection` is kept on every nil publish, not only Caret-frontmost.

## LESSONS LEARNED

- The shared gateway path hid this: no selection still had a caret line, and a frontmost Caret published a nil target.
- `SelectionMonitor` publishes the same nil when Caret is frontmost and when no text field is focused, so `rememberedSelection` cannot tell those cases apart.
- A live empty selection means clipboard, not a remembered phrase.

## PROCESS IMPROVEMENTS

None. L1 has no reflect/archive phase; this archive exists because the operator asked for it.

## TECHNICAL IMPROVEMENTS

None.

## NEXT STEPS

None.
