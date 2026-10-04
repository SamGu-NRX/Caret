#!/bin/bash
# Builds Caret.app with everything it runs: the host, the helper on a pinned Node runtime, caret-screen, the page
# bridge and Caret for Chrome. Nothing in it needs the repository, a terminal or a node on PATH (H4).
#
#   scripts/build-app.sh [release|debug|acceptance]
#
#   release     swift -c release, signed inside out with $IDENTITY and the hardened runtime, timestamped.
#               Fails without $IDENTITY.
#   debug       swift -c debug, signed ad hoc. The host runs and starts its services, but logs
#               "page bridge off: this build is not team-signed" and vends nothing.
#   acceptance  release with -DCARET_ACCEPTANCE_HOST, signed with $IDENTITY, as .build/Caret-acceptance.app. It can be
#               told to trust Chrome for Testing (Sources/Caret/Acceptance.swift). Never ship it.
#
# $IDENTITY is team DWGXWVUR2B's Apple Development certificate, as its SHA-1 (security find-identity -v -p codesigning).
# Never commit it: the certificate's name holds an email address.
#
# Only one bundle stays on disk: building one variant deletes the other. Swift runs under the shared build lock unless
# CARET_NO_LOCK is set (for a caller that already holds it).
#
#   Contents/MacOS/Caret                       the host (dev.caret.host)
#   Contents/Helpers/node                      Node, pinned below (dev.caret.node, Bundle/node.entitlements)
#   Contents/Helpers/caret-screen              the reader (dev.caret.screen)
#   Contents/Helpers/caret-bridge              the Native Messaging host Chrome starts (dev.caret.bridge)
#   Contents/Resources/helper/                 the helper, bundled (scripts/helper-bundle.config.mjs)
#   Contents/Resources/Caret for Chrome/       the unpacked extension, for Add to Chrome
#   Contents/Library/LaunchAgents/dev.caret.host.plist   the agent SMAppService registers
#   Contents/Frameworks/llama.framework
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-release}"
case "$mode" in
  release | acceptance) config=release ;;
  debug) config=debug ;;
  *) echo "usage: $0 [release|debug|acceptance]" >&2; exit 2 ;;
esac
if [[ "$mode" != debug && -z "${IDENTITY:-}" ]]; then
  echo "build-app.sh $mode: IDENTITY is not set. Set it to the SHA-1 of team DWGXWVUR2B's Apple Development certificate (security find-identity -v -p codesigning), or run 'scripts/build-app.sh debug' for an ad hoc build without the page bridge." >&2
  exit 2
fi
[[ "$(uname -m)" == arm64 ]] || { echo "build-app.sh: Caret ships for arm64 only; this Mac is $(uname -m)" >&2; exit 2; }

lock="$HOME/.caret-run/locks/build.lock"
# lockf creates the lock file but not its directory, which a fresh checkout does not have yet (CodeRabbit on PR #9).
mkdir -p "$(dirname "$lock")"
run() {
  if [[ -n "${CARET_NO_LOCK:-}" ]]; then "$@"; else /usr/bin/lockf -k "$lock" "$@"; fi
}

# Node v26.5.0, the runtime the helper's tests pass on. The SHA-256 of node-v26.5.0-darwin-arm64.tar.gz is the one in
# https://nodejs.org/dist/v26.5.0/SHASUMS256.txt, whose signature by release key
# C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C (listed in that release's README) was checked on 2026-10-04.
NODE_VERSION=26.5.0
NODE_SHA256=ee920559aaa2391569cff4d737e3b83963430e3a14dedd91bfe0ff53171b5af9
node_dist=".build/node-dist"
node_tar="$node_dist/node-v$NODE_VERSION-darwin-arm64.tar.gz"
node="$node_dist/node-v$NODE_VERSION-darwin-arm64/bin/node"
mkdir -p "$node_dist"
if [[ ! -f "$node_tar" ]]; then
  curl -fsSL -o "$node_tar.part" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz"
  mv "$node_tar.part" "$node_tar"
fi
echo "$NODE_SHA256  $node_tar" | shasum -a 256 -c - >/dev/null || {
  echo "build-app.sh: $node_tar does not match the pinned SHA-256; delete it and build again" >&2
  exit 1
}
[[ -x "$node" ]] || tar -xzf "$node_tar" -C "$node_dist"
node="$PWD/$node"

# Swift: the host, the reader and the bridge.
swiftflags=()
[[ "$mode" == acceptance ]] && swiftflags=(-Xswiftc -DCARET_ACCEPTANCE_HOST)
run swift build -c "$config" --product Caret ${swiftflags[@]+"${swiftflags[@]}"}
bin="$(swift build -c "$config" --show-bin-path)"
run swift build -c "$config" --package-path ../screen-reader --product caret-screen
reader_bin="$(swift build -c "$config" --package-path ../screen-reader --show-bin-path)"
run swift build -c "$config" --package-path ../../bridge --product caret-bridge
bridge_bin="$(swift build -c "$config" --package-path ../../bridge --show-bin-path)"

# The helper, bundled by the pinned runtime, and the extension.
helper_out="$PWD/.build/helper-bundle"
rm -rf "$helper_out"
[[ -f ../../helper/node_modules/rolldown/bin/cli.mjs ]] || (cd ../../helper && pnpm install --offline --frozen-lockfile)
(cd ../../helper && CARET_HELPER_OUT="$helper_out" "$node" node_modules/rolldown/bin/cli.mjs -c ../apps/caret/scripts/helper-bundle.config.mjs >/dev/null)
[[ -f "$helper_out/main.mjs" && -f "$helper_out/worker.mjs" && -f "$helper_out/emscripten-module.wasm" ]] || {
  echo "build-app.sh: the helper bundle in $helper_out is missing main.mjs, worker.mjs or the QuickJS wasm" >&2
  exit 1
}
[[ -d ../../extension/node_modules ]] || (cd ../../extension && pnpm install --offline --frozen-lockfile)
(cd ../../extension && "$node" build.mjs >/dev/null)

if [[ "$mode" == acceptance ]]; then app=".build/Caret-acceptance.app"; other=".build/Caret.app"; else app=".build/Caret.app"; other=".build/Caret-acceptance.app"; fi
rm -rf "$app" "$other"
contents="$app/Contents"
mkdir -p "$contents/MacOS" "$contents/Frameworks" "$contents/Helpers" "$contents/Resources" "$contents/Library/LaunchAgents"
cp Bundle/Info.plist "$contents/Info.plist"
cp "$bin/Caret" "$contents/MacOS/Caret"
ditto "$bin/llama.framework" "$contents/Frameworks/llama.framework"
cp "$node" "$contents/Helpers/node"
cp "$reader_bin/caret-screen" "$contents/Helpers/caret-screen"
cp "$bridge_bin/caret-bridge" "$contents/Helpers/caret-bridge"
ditto "$helper_out" "$contents/Resources/helper"
ditto ../../extension/dist "$contents/Resources/Caret for Chrome"
cp Bundle/dev.caret.host.plist "$contents/Library/LaunchAgents/dev.caret.host.plist"
plutil -lint -s "$contents/Library/LaunchAgents/dev.caret.host.plist" "$contents/Info.plist"

# Inside out: each helper and the framework, then the app, which seals the resources.
if [[ "$mode" == debug ]]; then
  sign() { codesign --force --sign - "$@"; }
else
  if [[ "$mode" == release ]]; then ts=(--timestamp); else ts=(--timestamp=none); fi
  sign() { codesign --force --sign "$IDENTITY" --options runtime "${ts[@]}" "$@"; }
fi
sign --identifier dev.caret.node --entitlements Bundle/node.entitlements "$contents/Helpers/node"
sign --identifier dev.caret.screen "$contents/Helpers/caret-screen"
sign --identifier dev.caret.bridge "$contents/Helpers/caret-bridge"
sign "$contents/Frameworks/llama.framework"
sign --identifier dev.caret.host "$app"
codesign --verify --deep --strict "$app"
echo "$PWD/$app"
