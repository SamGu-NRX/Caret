# Current Task: caret-xcodeproj-id-collision

**Complexity:** Level 1

## Fix

- [x] `Caret.xcodeproj` was unreadable: ID `B10000000000000000000055` was both the SettingsMainMenu `PBXBuildFile` and the Info.plist `PBXFileReference`.
- [x] `origin/main` `e4935c9` already moved Info.plist to `B100…62`. Dropped our `…57` remap so it does not collide with TabCompletions.
- [x] Added `tests/test_xcodeproj.py` so duplicate object IDs and a FileRef in a Sources list fail in CI.
- [x] Rebased onto `origin/main`. `xcodebuild -list` and the full Python suite pass.

## Files

- `tests/test_xcodeproj.py`

## QA

Previous FAIL (Info.plist remapped to `…57` while origin used that ID for TabCompletions). Build reworked. Ready for QA rerun.
