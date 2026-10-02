#!/bin/bash
# Builds apps/caret/.build/Caret.app: the SwiftPM executable plus llama.framework, ad-hoc signed.
# Usage: scripts/build-app.sh [release|debug]. Runs swift under the shared build lock unless
# CARET_NO_LOCK is set (for a caller that already holds it).
set -euo pipefail
cd "$(dirname "$0")/.."
config="${1:-release}"
lock="$HOME/.caret-run/locks/build.lock"
run() {
  if [[ -n "${CARET_NO_LOCK:-}" ]]; then "$@"; else /usr/bin/lockf -k "$lock" "$@"; fi
}

run swift build -c "$config" --product Caret
bin="$(swift build -c "$config" --show-bin-path)"
app=".build/Caret.app"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks"
cp Bundle/Info.plist "$app/Contents/Info.plist"
cp "$bin/Caret" "$app/Contents/MacOS/Caret"
ditto "$bin/llama.framework" "$app/Contents/Frameworks/llama.framework"
# The prebuilt llama.framework ships unsigned; sign it ad hoc so the bundle seal is valid.
codesign --force --sign - "$app/Contents/Frameworks/llama.framework" 2>/dev/null
codesign --force --sign - --identifier dev.caret.host "$app" 2>/dev/null
echo "$PWD/$app"
