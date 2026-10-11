#!/bin/bash
# Installs Electron for the real-target evaluation's electron target into DIR (B20), with npm's cache and
# Electron's download cache inside DIR too, so deleting DIR removes every byte this put on disk. The
# version is pinned so runs compare. Stops when less than 8 GB is free (shared-Mac rule).
#   electron-setup.sh DIR     then: real-target-eval.ts --target electron --electron DIR ...
set -euo pipefail
DIR=${1:?usage: electron-setup.sh DIR}
VERSION=44.5.1
free_kb=$(df -k / | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt $((8 * 1024 * 1024)) ]; then echo "blocked: disk ($free_kb KiB free)"; exit 75; fi
mkdir -p "$DIR"
cd "$DIR"
[ -f package.json ] || echo '{"name":"caret-electron-eval","private":true}' > package.json  # store: a fixed package.json, no model text
npm_config_cache="$DIR/.npm" electron_config_cache="$DIR/.electron-cache" npm install --no-audit --no-fund --save-exact "electron@$VERSION" >/dev/null
# Electron 44 downloads its binary on first use rather than at install; fetch it now, into DIR.
electron_config_cache="$DIR/.electron-cache" node node_modules/electron/install.js
exe="$DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$exe" ] || { echo "no Electron executable at $exe"; exit 1; }
du -sh "$DIR" | awk '{print "installed, " $1 " on disk"}'
