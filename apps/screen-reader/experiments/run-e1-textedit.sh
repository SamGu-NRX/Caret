#!/bin/bash
# E1 for TextEdit: opens a new TextEdit instance on a scratch file of its own (never an existing
# window or instance), writes markers into it through Accessibility, logs notifications, then quits
# that instance by pid.   run-e1-textedit.sh OUTDIR [COUNT]
set -euo pipefail
OUT=$1
COUNT=${2:-50}
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/launch-secret.sh"
BIN="$HERE/../.build/debug"
SCRATCH=/tmp/caret-e1-textedit
DRIVER=/tmp/caret-e1-drive-ax-value
mkdir -p "$OUT" "$SCRATCH"
echo "Caret E1 TextEdit scratch" > "$SCRATCH/caret-e1-textedit.txt"
[[ -x "$DRIVER" ]] || swiftc -O "$HERE/drive-ax-value.swift" -o "$DRIVER"
before=$(pgrep -x TextEdit | sort || true)
open -n -g -a TextEdit "$SCRATCH/caret-e1-textedit.txt"
sleep 3
after=$(pgrep -x TextEdit | sort || true)
TE=$(comm -13 <(echo "$before") <(echo "$after") | head -1)
[[ -n "$TE" ]] || { echo "no new TextEdit instance"; exit 1; }
echo "textedit $TE" | tee "$OUT/pids.txt"
# Signals only pids this script recorded. An empty or zero pid would make `kill` signal the whole process group.
stop() { for p in "$@"; do [[ "$p" =~ ^[0-9]+$ ]] && (( p > 1 )) && { kill "$p" 2>/dev/null || true; }; done; return 0; }
trap 'stop "${READER:-}" "$TE"' EXIT
"$BIN/caret-screen" --auth-fd 0 --only-pids "$TE" --event-pids "$TE" --socket /tmp/caret-e1-textedit/none.sock --e1-log "$OUT/e1.ndjson" < <(secret_bytes) > "$OUT/reader.log" 2>&1 &
READER=$!
sleep 2
"$DRIVER" --pid "$TE" --title caret-e1-textedit --count "$COUNT" --period 1.2 --log "$OUT/driver.ndjson"
sleep 2
echo done
