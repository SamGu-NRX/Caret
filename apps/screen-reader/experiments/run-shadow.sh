#!/bin/bash
# Shadow logger run: caret-screen --shadow and the helper in shadow mode for DUR seconds, while
# caret-fixture types into its own forms like a person (half the entries copy a value shown in its
# Reference window, half are invented). The reader reads every app as it would on a real day, with
# the fixture event-driven. Samples CPU and memory every 30 s, then stops everything it started.
#   run-shadow.sh OUTDIR [DUR]
set -euo pipefail
OUT=$1
DUR=${2:-600}
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../.build/debug"
# The bundled fixture (scripts/bundle-fixture.sh): macOS will not activate the bare executable.
FIXTURE="$BIN/CaretFixture.app/Contents/MacOS/caret-fixture"
[[ -x "$FIXTURE" ]] || { echo "no $FIXTURE; run ../scripts/bundle-fixture.sh $BIN"; exit 1; }
HELPER="$HERE/../../../helper"
DATA="$OUT/shadow-data"
mkdir -p "$OUT"
rm -rf "$DATA"
# Signals only pids this script recorded. An empty or zero pid would make `kill` signal the whole process group.
stop() { for p in "$@"; do [[ "$p" =~ ^[0-9]+$ ]] && (( p > 1 )) && { kill "$p" 2>/dev/null || true; }; done; return 0; }
trap 'stop "${READER:-}" "${HELPERPID:-}" "${FIX:-}"' EXIT

(cd "$HELPER" && exec node src/main.ts --shadow --data-dir "$DATA" --status-every 60 > "$OUT/helper.log" 2>&1) &
HELPERPID=$!
sleep 1.5
HPID=$(pgrep -f "node src/main.ts --shadow --data-dir $DATA" | head -1)
"$FIXTURE" --foreground --windows reference,distractors,claim,schedule --activity "$OUT/activity.ndjson" --duration $(( DUR + 20 )) > "$OUT/fixture.log" 2>&1 &
FIX=$!
sleep 1
"$BIN/caret-screen" --shadow --event-pids "$FIX" > "$OUT/reader.log" 2>&1 &
READER=$!

: > "$OUT/resources.tsv"
printf "t\treader_cpu_s\treader_rss_kb\thelper_cpu_s\thelper_rss_kb\treader_footprint_kb\thelper_footprint_kb\n" >> "$OUT/resources.tsv"
secs() { ps -o time= -p "$1" | awk '{ n=split($1,p,":"); s=0; for(i=1;i<=n;i++) s=s*60+p[i]; printf "%.2f", s }'; }
# Physical footprint counts compressed memory too; resident size alone shrank under memory pressure in E1.
fp() { footprint -p "$1" -f bytes --noCategories 2>/dev/null | awk '/Footprint:/ { for(i=1;i<=NF;i++) if ($i=="Footprint:") printf "%d", $(i+1)/1024 }'; }
for (( i=0; i<=DUR; i+=30 )); do
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$i" "$(secs $READER)" "$(ps -o rss= -p $READER | tr -d ' ')" "$(secs $HPID)" "$(ps -o rss= -p $HPID | tr -d ' ')" "$(fp $READER)" "$(fp $HPID)" >> "$OUT/resources.tsv"
  [[ $i -lt $DUR ]] && sleep 30
done
stop "$READER"
sleep 1
stop "$HELPERPID" "${HPID:-}"
sleep 1
echo done
