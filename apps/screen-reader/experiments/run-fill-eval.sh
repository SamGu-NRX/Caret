#!/bin/bash
# Grounded fill on caret-fixture with live Jev. Starts a helper with Jev, the fixture, and a reader
# limited to the fixture's pid (so Jev only ever sees synthetic text), then scores proposals.
#   run-fill-eval.sh OUTDIR WINDOWS [ROUNDS]
#   WINDOWS: e.g. reference,claim,schedule  or  reference,distractors,claim,schedule
# Needs CARET_ENV_FILE pointing at a .env with TYPESAFE_API_KEY.
set -euo pipefail
OUT=$1
WINDOWS=$2
ROUNDS=${3:-3}
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../.build/debug"
HELPER="$HERE/../../../helper"
: "${CARET_ENV_FILE:?set CARET_ENV_FILE to the .env holding TYPESAFE_API_KEY}"
stop() { for p in "$@"; do [[ "$p" =~ ^[0-9]+$ ]] && (( p > 1 )) && kill "$p" 2>/dev/null; done; return 0; }
trap 'stop "${READER:-}" "${FIX:-}" "${HELPERPID:-}"' EXIT
mkdir -p "$OUT"
rm -rf "$OUT/helper-data" "$OUT/reader-record.ndjson"

(cd "$HELPER" && exec node src/main.ts --data-dir "$OUT/helper-data" --allow-background-focus --status-every 60 > "$OUT/helper.log" 2>&1) &
HELPERPID=$!
sleep 1.5
"$BIN/caret-fixture" --windows "$WINDOWS" --gold "$OUT/gold.json" --focus-forms --duration 300 > "$OUT/fixture.log" 2>&1 &
FIX=$!
sleep 1
"$BIN/caret-screen" --only-pids "$FIX" --event-pids "$FIX" --record "$OUT/reader-record.ndjson" > "$OUT/reader.log" 2>&1 &
READER=$!
# Wait until the reader has recorded both form windows (the first walk of every window can take a few seconds).
for _ in $(seq 1 60); do
  [[ -f "$OUT/reader-record.ndjson" ]] && grep -q 'Claim form' "$OUT/reader-record.ndjson" && grep -q 'Schedule follow-up' "$OUT/reader-record.ndjson" && break
  sleep 0.25
done
(cd "$HELPER" && node scripts/fill-eval.ts --gold "$OUT/gold.json" --record "$OUT/reader-record.ndjson" --rounds "$ROUNDS" --out "$OUT" --wait-focus 14)
