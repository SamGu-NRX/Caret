#!/bin/bash
# Grounded fill on caret-fixture with live Jev. Starts a helper with Jev, the fixture, and a reader
# limited to the fixture's pid (so Jev only ever sees synthetic text), then scores proposals.
#   run-fill-eval.sh OUTDIR WINDOWS [ROUNDS]
#   WINDOWS: e.g. reference,claim,schedule  or  reference,distractors,claim,schedule
#   VISIT=distractors,reference   windows made key before each form, the last being the one the user just left
#   FILL_CUTOFF=0                 override the helper's cutoff (0 keeps every agreed choice, for calibration)
# Needs CARET_ENV_FILE pointing at a .env with TYPESAFE_API_KEY.
set -euo pipefail
OUT=$1
WINDOWS=$2
ROUNDS=${3:-3}
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/launch-secret.sh"
BIN="$HERE/../.build/debug"
# The bundled fixture (scripts/bundle-fixture.sh): macOS will not activate the bare executable.
FIXTURE="$BIN/CaretFixture.app/Contents/MacOS/caret-fixture"
[[ -x "$FIXTURE" ]] || { echo "no $FIXTURE; run ../scripts/bundle-fixture.sh $BIN"; exit 1; }
HELPER="$HERE/../../../helper"
: "${CARET_ENV_FILE:?set CARET_ENV_FILE to the .env holding TYPESAFE_API_KEY}"
stop() { for p in "$@"; do [[ "$p" =~ ^[0-9]+$ ]] && (( p > 1 )) && { kill "$p" 2>/dev/null || true; }; done; return 0; }
trap 'stop "${READER:-}" "${FIX:-}" "${HELPERPID:-}"' EXIT
mkdir -p "$OUT"
rm -rf "$OUT/helper-data" "$OUT/reader-record.ndjson"

CUTOFF_ARGS=()
[[ -n "${FILL_CUTOFF:-}" ]] && CUTOFF_ARGS=(--fill-cutoff "$FILL_CUTOFF")
VISIT_ARGS=()
NVISIT=0
if [[ -n "${VISIT:-}" ]]; then
  VISIT_ARGS=(--visit "$VISIT")
  NVISIT=$(awk -F, '{print NF}' <<<"$VISIT")
fi
(cd "$HELPER" && exec node src/main.ts --auth-fd 0 --data-dir "$OUT/helper-data" --allow-background-focus --status-every 60 ${CUTOFF_ARGS[@]+"${CUTOFF_ARGS[@]}"} > "$OUT/helper.log" 2>&1) < <(secret_bytes) &
HELPERPID=$!
sleep 1.5
"$FIXTURE" --foreground --windows "$WINDOWS" --gold "$OUT/gold.json" --focus-forms ${VISIT_ARGS[@]+"${VISIT_ARGS[@]}"} --duration 300 > "$OUT/fixture.log" 2>&1 &
FIX=$!
# The fixture prints its pid line once its windows exist; a reader started earlier can find no windows to walk.
for _ in $(seq 1 40); do grep -q 'caret-fixture pid' "$OUT/fixture.log" 2>/dev/null && break; sleep 0.25; done
sleep 1
"$BIN/caret-screen" --auth-fd 0 --only-pids "$FIX" --event-pids "$FIX" --record "$OUT/reader-record.ndjson" < <(secret_bytes) > "$OUT/reader.log" 2>&1 &
READER=$!
# Wait until the reader has recorded both form windows (the first walk of every window can take a few seconds).
for _ in $(seq 1 60); do
  [[ -f "$OUT/reader-record.ndjson" ]] && grep -q 'Claim form' "$OUT/reader-record.ndjson" && grep -q 'Schedule follow-up' "$OUT/reader-record.ndjson" && break
  sleep 0.25
done
(cd "$HELPER" && node scripts/fill-eval.ts --gold "$OUT/gold.json" --record "$OUT/reader-record.ndjson" --rounds "$ROUNDS" --out "$OUT" --wait-focus $((14 + 3 * NVISIT)))
