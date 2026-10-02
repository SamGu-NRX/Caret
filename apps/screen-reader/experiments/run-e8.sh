#!/bin/bash
# E8: walk the same fixture windows 100 times and measure key stability, in three conditions:
#   still   - caret-fixture's forms and reference windows, nothing changing
#   active  - caret-fixture typing into its forms, plus the E1 page in a WKWebView and in a
#             throwaway Chrome profile, all changing while they are walked
#   drift   - caret-fixture's drift window, built to move keys: toggling labels and an inserted
#             unnamed field that shifts its siblings' ordinals
#   run-e8.sh OUTDIR [RUNS]
set -euo pipefail
OUT=$1
RUNS=${2:-100}
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../.build/debug"
PROFILE=/tmp/caret-e8-chrome
mkdir -p "$OUT"
# Signals only pids this script recorded. An empty or zero pid would make `kill` signal the whole process group.
stop() { for p in "$@"; do [[ "$p" =~ ^[0-9]+$ ]] && (( p > 1 )) && { kill "$p" 2>/dev/null || true; }; done; return 0; }
trap 'stop "${FIX:-}" "${FIX2:-}"; pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true; sleep 1; rm -rf "$PROFILE"' EXIT

"$BIN/caret-fixture" --windows reference,distractors,claim,schedule --duration 600 > /dev/null 2>&1 &
FIX=$!
sleep 2
"$BIN/caret-screen" --e8 --pids "$FIX" --title-match "Caret" --runs "$RUNS" --interval 0.25 --out "$OUT/still.json" | tee "$OUT/still.txt"
stop "$FIX"

PAGE="file://$HERE/e1-page.html?cycles=200&period=700"
"$BIN/caret-fixture" --windows reference,claim,schedule --activity "$OUT/activity.ndjson" --webkit "$PAGE" --duration 600 > /dev/null 2>&1 &
FIX2=$!
rm -rf "$PROFILE"
open -n -g -a "Google Chrome" --args --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check --disable-sync --disable-extensions "$PAGE"
sleep 5
CHROME=$(pgrep -f "Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=$PROFILE" | head -1)
"$BIN/caret-screen" --e8 --pids "$FIX2,$CHROME" --title-match "Caret" --runs "$RUNS" --interval 0.25 --out "$OUT/active.json" | tee "$OUT/active.txt"
stop "$FIX2"

"$BIN/caret-fixture" --windows drift --duration 600 > /dev/null 2>&1 &
FIX=$!
sleep 2
"$BIN/caret-screen" --e8 --pids "$FIX" --title-match "Drift" --runs "$RUNS" --interval 0.25 --out "$OUT/drift.json" | tee "$OUT/drift.txt"
