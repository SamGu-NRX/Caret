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
HELPER="$HERE/../../../helper"
DATA="$OUT/shadow-data"
mkdir -p "$OUT"
rm -rf "$DATA"
trap 'kill ${READER:-0} ${HELPERPID:-0} ${FIX:-0} 2>/dev/null || true' EXIT

(cd "$HELPER" && exec node src/main.ts --shadow --data-dir "$DATA" --status-every 60 > "$OUT/helper.log" 2>&1) &
HELPERPID=$!
sleep 1.5
HPID=$(pgrep -f "node src/main.ts --shadow --data-dir $DATA" | head -1)
"$BIN/caret-fixture" --windows reference,distractors,claim,schedule --activity "$OUT/activity.ndjson" --duration $(( DUR + 20 )) > "$OUT/fixture.log" 2>&1 &
FIX=$!
sleep 1
"$BIN/caret-screen" --shadow --event-pids "$FIX" > "$OUT/reader.log" 2>&1 &
READER=$!

: > "$OUT/resources.tsv"
printf "t\treader_cpu_s\treader_rss_kb\thelper_cpu_s\thelper_rss_kb\n" >> "$OUT/resources.tsv"
secs() { ps -o time= -p "$1" | awk '{ n=split($1,p,":"); s=0; for(i=1;i<=n;i++) s=s*60+p[i]; printf "%.2f", s }'; }
for (( i=0; i<=DUR; i+=30 )); do
  printf "%s\t%s\t%s\t%s\t%s\n" "$i" "$(secs $READER)" "$(ps -o rss= -p $READER | tr -d ' ')" "$(secs $HPID)" "$(ps -o rss= -p $HPID | tr -d ' ')" >> "$OUT/resources.tsv"
  [[ $i -lt $DUR ]] && sleep 30
done
kill $READER
sleep 1
kill $HELPERPID $HPID 2>/dev/null || true
sleep 1
echo done
