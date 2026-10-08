#!/bin/bash
# H14 (from H13's build.sh): builds the VM payload from a `git archive` of caret-v2-host at one commit. The worktree is
# only read: git archive, and APFS clones (cp -c) of its gitignored inputs (llama.xcframework, the pinned Node tarball,
# helper and extension node_modules), so nothing there changes. go.sh runs it under h14/heavy.sh (HOLD check, 60 s gap,
# heavy lease). Changed from H13: the commit must hold H14's host half (GoalFiles.swift, DebugState.pageTask).
# Ported to ops/heavy (recipes/r2/prepare.sh runs it under the supervisor's lease): the worktree is the pinned one it
# runs in, and WORK replaces the fixed evidence path.
#   build.sh <full commit> WORK INPUTS
# INPUTS: the job's sealed copies of the gitignored inputs (caret_heavy._r2_prepare_plan); nothing is cloned from the
# worktree's own ignored files, and the export is made fresh every time (export.sh).
set -euo pipefail
W=$PWD
HA=${2:?usage: build.sh <commit> WORK}
S="$HA/src"           # the export
P="$HA/vm/payload"
L="$HA/logs"
TEAM=DC7B5D99A0E1EE3CFA464E216C400A5A91F7F439
IN=${3:?usage: build.sh <commit> WORK INPUTS}
CFT="$IN/Google Chrome for Testing.app"
want=${1:?usage: build.sh <commit>}
free() { df -k / | awk 'NR==2{printf "%.1f", $4/1048576}'; }
mkdir -p "$L"
echo "== $(date -u +%FT%TZ) $(free) GiB free"
[ "$(df -k / | awk 'NR==2{print $4}')" -ge 8000000 ] || { echo "blocked: disk"; exit 75; }
[ -d "$CFT" ] || { echo "build.sh: no Chrome for Testing at $CFT"; exit 1; }

full=$(git -C "$W" rev-parse "$want^{commit}")
echo "== export $full (fresh)"
/bin/bash "$(dirname "$0")/../export.sh" "$W" "$full" "$S"
# keytype from the job's sealed archive of the pin's gitlinked commit (caret_heavy.keytype_inputs): the pinned worktree
# need not have the submodule checked out.
rm -rf "$S/packages/keytype"; mkdir -p "$S/packages"
cp -cR "$IN/keytype" "$S/packages/keytype"
chmod -R u+w "$S/packages/keytype"
# The attach rows this run checks must be in the commit: the host's file types and the debug state's pageTask.
for f in apps/caret/Sources/CaretHostCore/GoalFiles.swift fixtures/web-form/public/tasks/wizard-3.html; do
  [ -f "$S/$f" ] || { echo "build.sh: $full has no $f (H14's host half is not committed there)"; exit 1; }
done
grep -q 'public var pageTask: PageTaskInfo?' "$S/apps/caret/Sources/CaretHostCore/DebugState.swift" || { echo "build.sh: $full has no DebugState.pageTask"; exit 1; }
grep -q 'public var lastAcceptFileStep: Int?' "$S/apps/caret/Sources/CaretHostCore/DebugState.swift" || { echo "build.sh: $full has no pageTask.lastAcceptFileStep"; exit 1; }

# Gitignored inputs, as clones. Lockfiles must match, or the cloned node_modules may not be this commit's.
mkdir -p "$S/packages/keytype/Packages/ModelRuntime/Vendor"
cp -cR "$IN/llama.xcframework" "$S/packages/keytype/Packages/ModelRuntime/Vendor/llama.xcframework"
chmod -R u+w "$S/packages/keytype/Packages/ModelRuntime/Vendor"  # the sealed inputs are read-only; this copy is the build's
mkdir -p "$S/apps/caret/.build/node-dist"
# The tarball build-app.sh pins at this commit, sealed against its SHA-256 (caret_heavy.node_pin); build-app.sh checks it again.
cp -c "$IN"/node-dist/node-v*-darwin-arm64.tar.gz "$S/apps/caret/.build/node-dist/"
for d in helper extension; do
  cmp -s "$W/$d/pnpm-lock.yaml" "$S/$d/pnpm-lock.yaml" || { echo "$d/pnpm-lock.yaml differs from the worktree's; run pnpm install --offline in $S/$d"; exit 1; }
  cp -cR "$IN/$d-node_modules" "$S/$d/node_modules"
  chmod -R u+w "$S/$d/node_modules"
done

echo "== acceptance bundle (team-signed; the page bridge needs a team-signed agent)"
(cd "$S/apps/caret" && IDENTITY=$TEAM CARET_NO_LOCK=1 scripts/build-app.sh acceptance) > "$L/build-acceptance.log" 2>&1 || { tail -30 "$L/build-acceptance.log"; exit 1; }
codesign --verify --deep --strict "$S/apps/caret/.build/Caret-acceptance.app"

echo "== stage the bundles (stage.sh adds tools, the fixture site and the replay file)"
rm -rf "$P"; mkdir -p "$P/acc" "$P/apps"
ditto "$S/apps/caret/.build/Caret-acceptance.app" "$P/acc/Caret.app"
codesign --verify --deep --strict "$P/acc/Caret.app"
cp -cR "$CFT" "$P/apps/Google Chrome for Testing.app"
echo "$full" > "$P/REV"

echo "== drop build intermediates (disk); the export stays for stage.sh, and the next build exports afresh anyway"
rm -rf "$S/apps/caret/.build" "$S/apps/screen-reader/.build" "$S/bridge/.build" "$S/helper/node_modules" "$S/extension/node_modules" "$S/extension/dist"
du -sh "$P"
echo "== $(date -u +%FT%TZ) $(free) GiB free"
echo build-ok
