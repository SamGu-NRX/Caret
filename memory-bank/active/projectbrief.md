# Project Brief

## User Story

As a contributor building Caret on this Mac, I want `make install` to read `Caret.xcodeproj` so that I can install a Release build.

## Use-Case(s)

### Use-Case 1

Run `make install` after `git pull` on `main`. Xcode reads the project and the Release package step proceeds.

## Requirements

1. Remove the duplicate `B10000000000000000000055` object ID in `Caret.xcodeproj/project.pbxproj`.
2. Keep `SettingsMainMenu.swift` in the Sources build phase as a `PBXBuildFile`.
3. Keep `Info.plist` as a `PBXFileReference` with its own ID.
4. If the fix is not already on `main`, commit and push it there.

## Constraints

1. Do not change app behavior beyond making the Xcode project readable.
2. Do not add purchases, hotel search, or other out-of-scope product work.
3. Keep credentials and personal data out of Git.

## Acceptance Criteria

1. `xcodebuild` can open `Caret.xcodeproj` without the Sources-phase type error.
2. `make install` gets past the project-read failure that currently exits 74.
3. The fix is on `main` if it was not already there.
