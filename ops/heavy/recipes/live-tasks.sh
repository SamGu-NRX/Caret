#!/bin/bash
# One live pass of the task pages with blind notes, or of the held-out pages, at the pinned commit (I1's live and
# held-out steps). The key reaches the eval only as CARET_ENV_FILE, the path recorded in the plan; this script never
# reads it. The day's Jev cap is the ledger's total at the start plus LIMIT, and the ledger may grow by at most LIMIT
# (exit 13). The first page reporting a wrong value stops the eval by its exact pid (exit 10). Profile caret-browser-eval.
#   live-tasks.sh TAG LIMIT [heldout]
# heldout: run the job's sealed copy of the held-out pages ($CARET_HEAVY_INPUTS/heldout) instead of the task pages.
set -u
. "$CARET_HEAVY_RECIPES/lib.sh"
TAG=${1:?usage: live-tasks.sh TAG LIMIT [heldout]}
LIMIT=${2:?limit}
HELDOUT=""; [ "${3:-}" = heldout ] && HELDOUT="$IN/heldout"
[ -n "${CARET_ENV_FILE:-}" ] || { echo "live-tasks: CARET_ENV_FILE is not set" >&2; exit 64; }
if [ -n "$HELDOUT" ]; then name="heldout-$TAG"; ids=heldout; else name="live-tasks-blind-$TAG"; ids=tasks; fi
REQUIRED=(dependencies binaries "page-ids-$ids" "$name" spend)
install_deps helper fixtures/web-form extension || finish
install_binaries || finish
page_ids "$ids" || finish
DAY=$(date +%Y-%m-%d)
LEDGER="$HOME/Library/Application Support/CaretV2/jev-spend/$DAY.ndjson"
N0=$( [ -f "$LEDGER" ] && wc -l < "$LEDGER" | tr -d ' ' || echo 0 )
CAP=$(py -c 'import json, os, sys
p = sys.argv[1]
rows = [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []
print("%.4f" % (sum(r["usd"] for r in rows) + float(sys.argv[2])))' "$LEDGER" "$LIMIT")
if [ -n "$HELDOUT" ]; then
  hook=(--import "$CARET_HEAVY_RECIPES/heldout-hook.mjs")
  export CARET_HELDOUT_ROOT="$HELDOUT" CARET_HELDOUT_FIXTURE="$PWD/fixtures/web-form/"
else
  hook=()
fi
mkdir -p "$OUT/$name"
echo "== $name: ledger $DAY lines $N0, cap \$$CAP, limit \$$LIMIT"
CARET_JEV_DAILY_CAP="$CAP" CARET_JEV_CACHE=off node ${hook[@]+"${hook[@]}"} fixtures/web-form/page-loop-eval.ts \
  --sign-identity "$SIGN_IDENTITY" --engine jev --spend-limit "$LIMIT" --path goal --suite tasks \
  --out "$OUT/$name" --log-jev "$OUT/$name/jev.ndjson" > "$OUT/$name.log" 2>&1 &
pid=$!
wrong=""
while kill -0 "$pid" 2>/dev/null; do
  if grep -qE "\bwrong [1-9]" "$OUT/$name.log" 2>/dev/null; then
    echo "$name: wrong value seen, stopping pid $pid"
    kill -TERM "$pid"
    wrong=1
    break
  fi
  sleep 2
done
wait "$pid"
check page-loop "$name" --exit $? ${wrong:+--wrong-seen} --expect-ids "$OUT/ids-$ids.txt" --goal
check spend --day "$DAY" --from-line $((N0 + 1)) --limit "$LIMIT"
finish
