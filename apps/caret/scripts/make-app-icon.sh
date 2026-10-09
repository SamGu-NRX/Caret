#!/bin/bash
# Rebuilds Bundle/AppIcon.icns from Bundle/AppIcon/AppIcon.svg: one 1024 px render in headless Chromium,
# scaled down with sips to every size an iconset holds, packed by iconutil. build-app.sh copies the .icns
# into Caret.app/Contents/Resources; Info.plist names it (CFBundleIconFile). Run it after changing the SVG
# and commit both.
#
#   scripts/make-app-icon.sh        CHROME=<path> picks the browser (default: Playwright's headless shell)
set -euo pipefail
cd "$(dirname "$0")/.."
chrome="${CHROME:-$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell}"
[[ -x "$chrome" ]] || { echo "make-app-icon.sh: no Chromium at $chrome; set CHROME" >&2; exit 1; }
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
svg="$PWD/Bundle/AppIcon/AppIcon.svg"
# Transparent page, the SVG at exactly 1024 by 1024.
printf '<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style><img src="file://%s" width="1024" height="1024">' "$svg" > "$work/icon.html"
"$chrome" --headless --user-data-dir="$work/profile" --host-resolver-rules="MAP * ~NOTFOUND" --allow-file-access-from-files \
  --hide-scrollbars --default-background-color=00000000 --window-size=1024,1024 --force-device-scale-factor=1 \
  --virtual-time-budget=2000 --screenshot="$work/1024.png" "file://$work/icon.html" >/dev/null 2>&1
[[ "$(sips -g pixelWidth "$work/1024.png" | awk '/pixelWidth/ {print $2}')" == 1024 ]] || { echo "make-app-icon.sh: render is not 1024 wide" >&2; exit 1; }
set_dir="$work/AppIcon.iconset"; mkdir "$set_dir"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$work/1024.png" --out "$set_dir/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$work/1024.png" --out "$set_dir/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o Bundle/AppIcon.icns
echo "Bundle/AppIcon.icns"
