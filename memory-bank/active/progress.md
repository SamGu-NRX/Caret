# Progress

Repair the duplicate object ID in `Caret.xcodeproj` so `make install` can read the project, then push to `main` if needed.

**Complexity:** Level 1

## 2026-09-19 - COMPLEXITY-ANALYSIS - COMPLETE

* Work completed
    - Confirmed Fresh state and operator-approved intent
    - Classified as Level 1 (isolated pbxproj ID collision)
* Decisions made
    - Task id: `caret-xcodeproj-id-collision`
    - Skip plan/creative/preflight per Level 1 workflow
* Insights
    - `B10000000000000000000055` is both SettingsMainMenu.swift in Sources and Info.plist as a file reference

## 2026-09-19 - BUILD - COMPLETE

* Work completed
    - Added `tests/test_xcodeproj.py` (unique IDs; Sources entries must be PBXBuildFile)
    - Reassigned Info.plist to `B10000000000000000000057`
    - `python3 -m unittest discover -s tests -v` passed (39 tests)
    - `xcodebuild -list` and `make install` succeeded
* Decisions made
    - Keep SettingsMainMenu's existing Sources ID; only the colliding FileRef changed
    - Contract test lives under `tests/` so Linux CI can catch the next collision
* Insights
    - Xcode resolves a duplicate ID to the later object; the FileRef won, so Sources looked invalid

## 2026-09-19 - QA - FAIL

* Work completed
    - QA by [Niko QA review](0b8aed7c-c8d5-4d94-8800-9eaf63745c0a) against `origin/main` `e4935c9`
* Decisions made
    - Do not push the Info.plist `…57` remap; that ID is TabCompletions on origin
    - Re-enter Build: rebase onto `origin/main`, keep `tests/test_xcodeproj.py`, drop the pbxproj remap unless a collision remains
* Insights
    - `origin/main` already moved Info.plist to `B100…62` in the Tab completions commit

## 2026-09-19 - QA - COMPLETE (FAIL)

* Work completed
    - Reviewed pbxproj remap and `tests/test_xcodeproj.py` against the brief
    - Confirmed local IDs are unique and both new tests pass
    - Compared the remap to `origin/main` (ahead 2, behind 1)
* Decisions made
    - FAIL: Build must rerun. Do not land Info.plist as `B100…57`.
    - The contract tests are acceptable and should be kept
* Insights
    - `e4935c9` on origin already fixed the `B100…55` collision by moving Info.plist to `B100…62` and assigned `B100…57` to TabCompletions
    - A locally unused "next" ID is not safe when main has moved

## 2026-09-19 - BUILD - COMPLETE (rework)

* Work completed
    - Rebased local main onto `origin/main`
    - Resolved pbxproj conflict by keeping origin's Info.plist `B100…62`
    - Kept `tests/test_xcodeproj.py`; 44 tests pass; `xcodebuild -list` and `make install` succeed
* Decisions made
    - Do not carry a pbxproj ID remap when main already fixed the collision
    - The remaining shippable change is the contract test
* Insights
    - `B100…57` is TabCompletions on current main; do not reuse it for Info.plist
