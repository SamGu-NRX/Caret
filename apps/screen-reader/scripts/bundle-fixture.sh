#!/bin/bash
# Wraps the built caret-fixture in an app bundle, CaretFixture.app, with bundle ID dev.caret.fixture.
# macOS will not activate the bare executable however long the Mac has been idle (A4, A5), so an
# on-screen check needs the bundle. Launch it by exec'ing CaretFixture.app/Contents/MacOS/caret-fixture,
# never with `open`, so it inherits the launcher's Accessibility grant. The Info.plist sets no
# LSUIElement or LSBackgroundOnly: the binary chooses its activation policy at run time, background-only
# by default and accessory with --foreground.
#   bundle-fixture.sh BIN_DIR [OUT_DIR]     OUT_DIR defaults to BIN_DIR; prints the bundle's path
set -euo pipefail
BIN=${1:?usage: bundle-fixture.sh BIN_DIR [OUT_DIR]}
OUT=${2:-$BIN}
SRC="$BIN/caret-fixture"
[[ -x "$SRC" ]] || { echo "bundle-fixture: no executable $SRC; run swift build --product caret-fixture first" >&2; exit 1; }
APP="$OUT/CaretFixture.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
# A copy, not a link: macOS finds an app's bundle from its executable's real path.
cp "$SRC" "$APP/Contents/MacOS/caret-fixture"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.caret.fixture</string>
  <key>CFBundleName</key><string>Caret Fixture</string>
  <key>CFBundleExecutable</key><string>caret-fixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
plutil -lint -s "$APP/Contents/Info.plist"
# An ad-hoc signature seals the plist to the executable, so the system reads the bundle as one app.
if file -b "$APP/Contents/MacOS/caret-fixture" | grep -q "Mach-O"; then
  codesign --force --sign - "$APP" >/dev/null 2>&1 || { echo "bundle-fixture: codesign failed for $APP" >&2; exit 1; }
fi
echo "$APP"
