#!/bin/bash
# H11 (from Q2/H10): builds the VM payload from a `git archive` of caret-v2-host at one commit. The worktree is only
# read: git archive, and APFS clones (cp -c) of its gitignored inputs (llama.xcframework, the pinned Node tarball,
# helper and extension node_modules), so nothing there changes. Ported to ops/heavy (recipes/r2/prepare.sh runs it
# under the supervisor's lease): the worktree is the pinned one it runs in, and WORK replaces the fixed evidence path.
#   build.sh <full commit> WORK INPUTS
# INPUTS: the job's sealed copies of the gitignored inputs (caret_heavy._r2_prepare_plan); nothing is cloned from the
# worktree's own ignored files, and the export is made fresh every time (export.sh).
set -euo pipefail
W=$PWD
Q=${2:?usage: build.sh <commit> WORK}
S="$Q/src"            # the export; stage.sh copies the task pages and their oracle from it
P="$Q/vm/payload"
TEAM=472BDE15DB7ADCB740F9E2508F0916EE1671FD75
IN=${3:?usage: build.sh <commit> WORK INPUTS}
CFT="$IN/Google Chrome for Testing.app"
want=${1:?usage: build.sh <commit>}
free() { df -k / | awk 'NR==2{printf "%.1f", $4/1048576}'; }
echo "== $(date -u +%FT%TZ) $(free) GiB free"
[ "$(df -k / | awk 'NR==2{print $4}')" -ge 8000000 ] || { echo "blocked: disk"; exit 75; }

full=$(git -C "$W" rev-parse "$want^{commit}")
echo "== export $full (fresh)"
/bin/bash "$(dirname "$0")/../export.sh" "$W" "$full" "$S"
# keytype from the job's sealed archive of the pin's gitlinked commit (caret_heavy.keytype_inputs): the pinned worktree
# need not have the submodule checked out.
rm -rf "$S/packages/keytype"; mkdir -p "$S/packages"
cp -cR "$IN/keytype" "$S/packages/keytype"
chmod -R u+w "$S/packages/keytype"
# H11: no Groq. Since the L1 merge, Ask makes its intent with Jev in one request ("heads"), and ASK_MAKER is a
# compile-time constant with no runtime switch, so the export is checked, not edited: any other value fails the build.
ASK_LINE='export const ASK_MAKER: "writer" | "jev" | "heads" = "heads";'
if ! grep -qxF "$ASK_LINE" "$S/helper/src/writer/config.ts"; then
  echo "build.sh: helper/src/writer/config.ts at $full does not say: $ASK_LINE" >&2
  echo "build.sh: its ASK_MAKER lines are: $(grep -n 'ASK_MAKER' "$S/helper/src/writer/config.ts" | head -3)" >&2
  exit 1
fi
grep -n '^export const ASK_MAKER' "$S/helper/src/writer/config.ts"
# Gitignored inputs, as clones. Lockfiles must match, or the cloned node_modules may not be this commit's.
mkdir -p "$S/packages/keytype/Packages/ModelRuntime/Vendor"
cp -cR "$IN/llama.xcframework" "$S/packages/keytype/Packages/ModelRuntime/Vendor/llama.xcframework"
mkdir -p "$S/apps/caret/.build/node-dist"
# The tarball build-app.sh pins at this commit, sealed against its SHA-256 (caret_heavy.node_pin); build-app.sh checks it again.
cp -c "$IN"/node-dist/node-v*-darwin-arm64.tar.gz "$S/apps/caret/.build/node-dist/"
for d in helper extension; do
  cmp -s "$W/$d/pnpm-lock.yaml" "$S/$d/pnpm-lock.yaml" || { echo "$d/pnpm-lock.yaml differs from the worktree's; run pnpm install --offline in $S/$d"; exit 1; }
  cp -cR "$IN/$d-node_modules" "$S/$d/node_modules"
done

echo "== acceptance bundle (team-signed; the page bridge needs a team-signed agent)"
(cd "$S/apps/caret" && IDENTITY=$TEAM CARET_NO_LOCK=1 scripts/build-app.sh acceptance) > "$Q/build-acceptance.log" 2>&1 || { tail -30 "$Q/build-acceptance.log"; exit 1; }
codesign --verify --deep --strict "$S/apps/caret/.build/Caret-acceptance.app"

mkdir -p "$Q/vm"
echo "== native fixture"
(cd "$S/apps/screen-reader" && swift build --product caret-fixture && scripts/bundle-fixture.sh "$(swift build --show-bin-path)" "$Q/vm") > "$Q/build-fixture.log" 2>&1 || { tail -20 "$Q/build-fixture.log"; exit 1; }

echo "== stage the bundles (stage.sh adds tools, pages and documents)"
rm -rf "$P"; mkdir -p "$P/acc" "$P/apps"
ditto "$S/apps/caret/.build/Caret-acceptance.app" "$P/acc/Caret.app"
codesign --verify --deep --strict "$P/acc/Caret.app"
mv "$Q/vm/CaretFixture.app" "$P/apps/CaretFixture.app"
cp -cR "$CFT" "$P/apps/Google Chrome for Testing.app"
echo "$full" > "$P/REV"

echo "== drop build intermediates (disk); the export stays for stage.sh, and the next build exports afresh anyway"
rm -rf "$S/apps/caret/.build" "$S/apps/screen-reader/.build" "$S/bridge/.build" "$S/helper/node_modules" "$S/extension/node_modules" "$S/extension/dist"
du -sh "$P"
echo "== $(date -u +%FT%TZ) $(free) GiB free"
echo build-ok
