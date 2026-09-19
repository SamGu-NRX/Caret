# Current Task: caret-xcodeproj-id-collision

**Complexity:** Level 1

## Fix

- [x] `Caret.xcodeproj` was unreadable: ID `B10000000000000000000055` was both the SettingsMainMenu `PBXBuildFile` and the Info.plist `PBXFileReference`.
- [x] Gave Info.plist ID `B10000000000000000000057`. Left SettingsMainMenu in Sources as `…55`.
- [x] Added `tests/test_xcodeproj.py` so duplicate object IDs and a FileRef in a Sources list fail in CI.
- [x] `xcodebuild -list` and `make install` succeed. Installed `/Applications/Caret.app`.

## Files

- `Caret.xcodeproj/project.pbxproj`
- `tests/test_xcodeproj.py`

## QA

❌ FAIL — Build must rerun

- **Blocking:** Info.plist was remapped to `B10000000000000000000057`. That ID is already the TabCompletions `PBXBuildFile` on `origin/main` (`e4935c9`). Landing this remap recreates the FileRef-vs-Sources collision this task exists to stop.
- **Blocking:** `origin/main` already moved Info.plist to `B100…62` and no longer duplicates `B100…55`. Local main is behind that commit. The pbxproj edit is redundant on current main and unsafe to push.
- **Keep:** `tests/test_xcodeproj.py` matches the failure mode (unique object IDs; Sources entries must be `PBXBuildFile`) and passed on this tree.
- **Advisory:** Push-to-main is still outstanding; do not push until the pbxproj change is dropped or rebased onto a free ID.
