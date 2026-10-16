#!/bin/bash
# The rewrite probe as a heavy-queue job: the queue holds the lease and heavy.lock for the job's life, so this takes
# neither. Builds Caret (release) from an export of <rev> and runs --probe-rewrite. Usage: job.sh <rev> <out-dir> [probe args]
set -euo pipefail
REV="$1"; OUT="$2"; shift 2
PROBE_ARGS=("$@")
WT="/Users/samgu/Programming Projects/caret-v2-inline"
KT="/Users/samgu/Programming Projects/caret-v2-host/packages/keytype"
SRC="$WT/.scratch/probe/src"
mkdir -p "$OUT"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$OUT/run.log"; }
[ "$(git -C "$KT" rev-parse HEAD)" = "21df2cc1f5271d3712d567e3c2491ac09174caf3" ]
rm -rf "$SRC"; mkdir -p "$SRC/packages"
git -C "$WT" archive "$REV" apps/caret apps/screen-reader bridge | tar -x -C "$SRC"
cp -cR "$KT" "$SRC/packages/keytype"; rm -f "$SRC/packages/keytype/.git"
cd "$SRC/apps/caret"
log "build start $REV"
/usr/bin/time -l swift build -c release --product Caret --disable-automatic-resolution > "$OUT/build.log" 2>&1
log "build done"
/usr/bin/time -l "$SRC/apps/caret/.build/release/Caret" --probe-rewrite "$WT/apps/caret/scripts/rewrite-corpus.txt" "$OUT/rows.ndjson" \
  ${PROBE_ARGS[@]+"${PROBE_ARGS[@]}"} > "$OUT/probe.txt" 2> "$OUT/probe.err"
log "probe done"
rm -rf "$SRC/apps/caret/.build" "$SRC/apps/screen-reader/.build" "$SRC/bridge/.build"
log "build products removed"
