#!/bin/sh
# Xcode and the Python build routes use this entry point, including incremental Debug builds.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Finder-launched Xcode may omit Homebrew's bin directory from PATH.
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
export PATH
if ! command -v node >/dev/null 2>&1; then
    echo "privacy gate: refusing to package: Node.js 24 or newer is required to check the privacy promise" >&2
    exit 1
fi
exec node "$root/helper/scripts/privacy-gate.ts"
