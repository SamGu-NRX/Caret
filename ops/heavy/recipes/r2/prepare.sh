#!/bin/bash
# Builds and stages one R2 VM payload at the pinned commit: H11's or H14's build.sh, then its stage.sh, then a content
# record of the payload (OUT/payload.json) whose REV must be the pinned commit. Profile caret-swift.
#   prepare.sh h11|h14 WORK COMMIT [H11 stage options]
# WORK gets src/ (the export), vm/ (job.sh, tcc.txt, display, payload/) and the build logs; enqueue r2-vm with
# --job-dir WORK/vm afterwards. Exit 14 when the build or the staging fails, 12 when the payload is not the pin's.
set -u
. "$CARET_HEAVY_RECIPES/lib.sh"
H=${1:?usage: prepare.sh h11|h14 WORK COMMIT [options]}
WORK=${2:?work}
REV=${3:?commit}
shift 3
case "$H" in h11|h14) ;; *) echo "prepare: harness must be h11 or h14" >&2; exit 64 ;; esac
case "$WORK" in /?*) ;; *) echo "prepare: WORK must be an absolute directory" >&2; exit 64 ;; esac
[ "$WORK" != "$HOME" ] || { echo "prepare: WORK must not be HOME" >&2; exit 64; }
[ "$REV" = "$CARET_HEAVY_REV" ] || { echo "prepare: $REV is not the job's pinned $CARET_HEAVY_REV" >&2; exit 64; }
HD="$CARET_HEAVY_RECIPES/r2/$H"
mkdir -p "$WORK"
/bin/bash "$HD/build.sh" "$REV" "$WORK" > "$OUT/build.log" 2>&1
check prepare build --log "$OUT/build.log" --exit $? || finish
if [ "$H" = h11 ]; then /bin/bash "$HD/stage.sh" "$WORK" "$@"; else /bin/bash "$HD/stage.sh" "$WORK"; fi > "$OUT/stage.log" 2>&1
check prepare stage --log "$OUT/stage.log" --exit $? || finish
py -c 'import json, sys
sys.path.insert(0, sys.argv[1])
import manifest
json.dump(manifest.record("payload", "payload", sys.argv[2], rev=sys.argv[3]), open(sys.argv[4], "w"), indent=1)' \
  "$CARET_HEAVY_RECIPES/.." "$WORK/vm/payload" "$REV" "$OUT/payload.json" > "$OUT/payload.log" 2>&1
check prepare payload --log "$OUT/payload.log" --exit $? --fail-code 12
finish
