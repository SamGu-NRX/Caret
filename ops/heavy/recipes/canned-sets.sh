#!/bin/bash
# The three canned browser sets (tasks blind, tasks labelled, corpus + W4 goal) at the pinned commit, from W1's
# canned-sets.sh and I1's canned step. Stops at the first set with a wrong value (exit 10). Profile caret-browser-eval.
#   canned-sets.sh TAG [BINARIES-FROM]
# BINARIES-FROM: a worktree whose bridge build and Chrome for Testing replace the pinned worktree's (W1's baseline has
# none). The plan's manifest pinned them by content at enqueue, and the supervisor checked them before this started.
set -u
. "$CARET_HEAVY_RECIPES/lib.sh"
TAG=${1:?usage: canned-sets.sh TAG [BINARIES-FROM]}
SRC=${2:-}
install_deps helper fixtures/web-form extension || finish
if [ -n "$SRC" ]; then
  (
    set -e
    mkdir -p bridge/.build/release
    for b in caret-bridge caret-bridge-testhost; do
      rm -f "bridge/.build/release/$b"
      cp -c "$SRC/bridge/.build/release/$b" bridge/.build/release/
      cmp "$SRC/bridge/.build/release/$b" "bridge/.build/release/$b"
    done
    rm -rf fixtures/web-form/.browsers
    cp -cR "$SRC/fixtures/web-form/.browsers" fixtures/web-form/
  ) >> "$OUT/prepare.log" 2>&1
  check prepare binaries --log "$OUT/prepare.log" --exit $? || finish
fi
for spec in "tasks-blind:--path goal --suite tasks" "tasks-labelled:--path goal --suite tasks --sources labelled" "corpus-goal:--path goal"; do
  name="${spec%%:*}-$TAG"
  mkdir -p "$OUT/$name"
  # shellcheck disable=SC2086
  node fixtures/web-form/page-loop-eval.ts --sign-identity "$SIGN_IDENTITY" --jev canned --out "$OUT/$name" \
    --log-jev "$OUT/$name/jev.ndjson" ${spec#*:} > "$OUT/$name.log" 2>&1
  check page-loop "$name" --exit $?
  [ $? = 10 ] && break
done
finish
