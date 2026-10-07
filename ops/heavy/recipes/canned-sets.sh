#!/bin/bash
# The three canned browser sets (tasks blind, tasks labelled, corpus + W4 goal) at the pinned commit, from W1's
# canned-sets.sh and I1's canned step. Stops at the first set with a wrong value (exit 10). Profile caret-browser-eval.
#   canned-sets.sh TAG
# The bridge build, Chrome for Testing and W4's saved pages come from the job's sealed inputs ($CARET_HEAVY_INPUTS),
# cloned at enqueue from the pinned worktree or --binaries-from, and checked by the supervisor just before this started.
set -u
. "$CARET_HEAVY_RECIPES/lib.sh"
TAG=${1:?usage: canned-sets.sh TAG}
REQUIRED=(dependencies binaries page-ids-tasks page-ids-corpus "tasks-blind-$TAG" "tasks-labelled-$TAG" "corpus-goal-$TAG")
install_deps helper fixtures/web-form extension || finish
install_binaries || finish
page_ids tasks || finish
page_ids corpus || finish
w4_flags
for spec in "tasks-blind:tasks:--path goal --suite tasks" "tasks-labelled:tasks:--path goal --suite tasks --sources labelled" \
            "corpus-goal:corpus:--path goal"; do
  name="${spec%%:*}-$TAG"; rest=${spec#*:}; kind=${rest%%:*}; opts=${rest#*:}
  extra=(); [ "$kind" = corpus ] && extra=("${W4_FLAGS[@]}")
  mkdir -p "$OUT/$name"
  # shellcheck disable=SC2086
  node fixtures/web-form/page-loop-eval.ts --sign-identity "$SIGN_IDENTITY" --jev canned --out "$OUT/$name" \
    --log-jev "$OUT/$name/jev.ndjson" $opts ${extra[@]+"${extra[@]}"} > "$OUT/$name.log" 2>&1
  check page-loop "$name" --exit $? --expect-ids "$OUT/ids-$kind.txt" --goal
  [ $? = 10 ] && break
done
finish
