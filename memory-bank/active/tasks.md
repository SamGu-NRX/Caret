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
