#!/bin/bash
# E1 run: scripted changes in fixture windows this script opens itself (an AppKit window and a
# WKWebView page in caret-fixture, and the same page in a throwaway Chrome profile), for DUR
# seconds, with the reader on or off. Samples CPU time of every process involved at both ends.
#   run-e1.sh on|off OUTDIR [DUR]
# The reader runs in its normal mode over all apps, with the fixture and Chrome event-driven, and
# the helper runs without Jev, so nothing leaves the Mac. Never touches windows it did not open.
set -euo pipefail
MODE=$1
OUT=$2
DUR=${3:-300}
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/launch-secret.sh"
BIN="$HERE/../.build/debug"
# The bundled fixture (scripts/bundle-fixture.sh): macOS will not activate the bare executable.
FIXTURE="$BIN/CaretFixture.app/Contents/MacOS/caret-fixture"
[[ -x "$FIXTURE" ]] || { echo "no $FIXTURE; run ../scripts/bundle-fixture.sh $BIN"; exit 1; }
HELPER="$HERE/../../../helper"
PERIOD_MS=1200
FIX_CYCLES=$(( DUR * 1000 / PERIOD_MS / 7 + 1 ))
PAGE="file://$HERE/e1-page.html?cycles=$FIX_CYCLES&period=$PERIOD_MS"
CHROME_PROFILE="/tmp/caret-e1-chrome-$MODE"
mkdir -p "$OUT"
rm -rf "$CHROME_PROFILE"

# Signals only pids this script recorded. An empty or zero pid would make `kill` signal the whole process group.
stop() { for p in "$@"; do [[ "$p" =~ ^[0-9]+$ ]] && (( p > 1 )) && { kill "$p" 2>/dev/null || true; }; done; return 0; }
cleanup() {
  stop "${READER:-}" "${HELPERPID:-}" "${FIX:-}"
  pkill -f "user-data-dir=$CHROME_PROFILE" 2>/dev/null || true
  sleep 1
  rm -rf "$CHROME_PROFILE"
}
trap cleanup EXIT

"$FIXTURE" --foreground --windows "" --e1 "$OUT/fixture-actions.ndjson" --cycles "$FIX_CYCLES" --period 1.2 \
  --webkit "$PAGE" --duration $(( DUR + 30 )) > "$OUT/fixture.log" 2>&1 &
FIX=$!
open -n -g -a "Google Chrome" --args --user-data-dir="$CHROME_PROFILE" --no-first-run --no-default-browser-check \
  --disable-sync --disable-extensions "$PAGE"
sleep 4
# With set -e and pipefail, a pgrep that matches nothing would end the run here (CodeRabbit on PR #4); "none" is handled below.
CHROME=$(pgrep -f "Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=$CHROME_PROFILE" | head -1 || true)
echo "fixture $FIX chrome ${CHROME:-none}" | tee "$OUT/pids.txt"

if [[ "$MODE" == on ]]; then
  (cd "$HELPER" && exec node src/main.ts --auth-fd 0 --no-jev --data-dir "$OUT/helper-data" --status-every 60 > "$OUT/helper.log" 2>&1) < <(secret_bytes) &
  HELPERPID=$!
  sleep 1.5
  "$BIN/caret-screen" --auth-fd 0 --event-pids "$FIX,${CHROME}" --event-bundles com.t3tools.t3code --e1-log "$OUT/e1.ndjson" < <(secret_bytes) > "$OUT/reader.log" 2>&1 &
  READER=$!
  sleep 1
  HPID=$(pgrep -f "node src/main.ts --auth-fd 0 --no-jev --data-dir $OUT/helper-data" | head -1 || true)
fi

# CPU seconds of a list of pids, from ps's cumulative TIME column.
cpu() {
  local pids="$1"
  [[ -z "$pids" ]] && { echo 0; return; }
  ps -o time= -p "$pids" 2>/dev/null | awk '{ n=split($1,p,":"); s=0; for(i=1;i<=n;i++) s=s*60+p[i]; t+=s } END { printf "%.2f", t+0 }'
}
group() { pgrep -f "$1" | paste -sd, - || true; }
sample() {
  local label=$1
  {
    echo "label=$label t=$(date +%s)"
    echo "fixture $(cpu "$FIX")"
    echo "chrome $(cpu "$(group "user-data-dir=$CHROME_PROFILE")")"
    echo "t3code $(cpu "$(group 'T3 Code \(Nightly\)')")"
    echo "helium $(cpu "$(group '/Applications/Helium.app/')")"
    echo "discord $(cpu "$(group '/Applications/Discord.app/')")"
    if [[ "$MODE" == on ]]; then
      echo "reader $(cpu "$READER")"
      echo "helper $(cpu "${HPID:-}")"
      echo "reader_rss_kb $(ps -o rss= -p "$READER" | tr -d ' ')"
      echo "helper_rss_kb $(ps -o rss= -p "${HPID:-$READER}" | tr -d ' ')"
    fi
  } >> "$OUT/cpu.txt"
}
: > "$OUT/cpu.txt"
sample start
sleep "$DUR"
sample end
echo "done $MODE"
