#!/bin/bash
# Read-only audit on the real windows (helper/src/audit.ts): its own caret-screen (--shadow
# --no-manual-ax, so it sets nothing in any app) and its own helper in audit mode, on a socket and
# data directory of their own, beside any running shadow logger. Writes counts only:
#   OUT/audit-counts.json   the audit summary, every minute and at exit (mode 0600)
#   OUT/cpu-samples.txt     "<epoch s> <pid> <%cpu> <rss KB> <cpu time>" every 30 s
#   OUT/hid-idle.tsv        "<epoch s> <HID idle s>" every 30 s, for active minutes
#   OUT/pids.txt            the pids this script started
# The seen-text hashes and their key go to SEEN (keep it outside OUT, run the leak check, delete it).
#   run-audit.sh OUT SEEN MAX_SECONDS [ACTIVE_MINUTES]
# With ACTIVE_MINUTES it stops as soon as that many active minutes are in (a 30 s sample with under
# 30 s of HID idle time counts as half a minute), or at MAX_SECONDS, whichever comes first.
set -euo pipefail
DUR=$3
TARGET=${4:-0}
# Absolute paths: the helper runs from helper/, so a relative OUT or SEEN would land somewhere else.
mkdir -p "$1"
OUT="$(cd "$1" && pwd)"
SEEN="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../.build/debug"
HELPER="$HERE/../../../helper"
WORK=$(mktemp -d /tmp/caret-audit.XXXXXX)
SOCK="$WORK/s.sock"
# Signals only pids this script recorded. An empty or zero pid would make `kill` signal the whole process group.
stop() { for p in "$@"; do [[ "$p" =~ ^[0-9]+$ ]] && (( p > 1 )) && { kill "$p" 2>/dev/null || true; }; done; return 0; }
cleanup() { stop "${READER:-}"; sleep 1; stop "${HPID:-}"; sleep 2; rm -rf "$WORK"; }
trap cleanup EXIT

(cd "$HELPER" && exec node src/main.ts --audit-out "$OUT/audit-counts.json" --audit-seen "$SEEN" --socket "$SOCK" --data-dir "$WORK/data" --status-every 300 > "$WORK/helper.log" 2>&1) &
HPID=$!
for _ in $(seq 1 50); do [[ -S "$SOCK" ]] && break; sleep 0.2; done
[[ -S "$SOCK" ]] || { echo "helper did not listen"; cat "$WORK/helper.log"; exit 1; }
"$BIN/caret-screen" --shadow --no-manual-ax --socket "$SOCK" > "$WORK/reader.log" 2>&1 &
READER=$!
printf "helper %s\nreader %s\n" "$HPID" "$READER" > "$OUT/pids.txt"

: > "$OUT/cpu-samples.txt"
: > "$OUT/hid-idle.tsv"
END=$(( $(date +%s) + DUR ))
while (( $(date +%s) < END )); do
  now=$(date +%s)
  for p in "$HPID" "$READER"; do
    s=$(ps -o pid=,%cpu=,rss=,time= -p "$p" 2>/dev/null || true)
    [[ -n "$s" ]] && echo "$now $s" >> "$OUT/cpu-samples.txt"
  done
  # awk reads to the end: exiting early would SIGPIPE ioreg and, under pipefail, end the script.
  idle=$(ioreg -c IOHIDSystem | awk '/HIDIdleTime/ && !d { printf "%.1f", $NF / 1000000000; d = 1 }')
  printf "%s\t%s\n" "$now" "$idle" >> "$OUT/hid-idle.tsv"
  if (( TARGET > 0 )); then
    active=$(awk '$2 < 30 { n++ } END { print int(n / 2) }' "$OUT/hid-idle.tsv")
    (( active >= TARGET )) && { echo "reached $active active minutes"; break; }
  fi
  kill -0 "$READER" 2>/dev/null || { echo "reader exited"; break; }
  kill -0 "$HPID" 2>/dev/null || { echo "helper exited"; break; }
  sleep 30
done
# The helper's and reader's logs hold app names and counts; keep their line counts and the last status line only.
echo "helper log lines $(wc -l < "$WORK/helper.log"); reader log lines $(wc -l < "$WORK/reader.log")" > "$OUT/logs-summary.txt"
grep -c "gave up observing\|cannot observe" "$WORK/reader.log" | sed 's/^/reader observe failures /' >> "$OUT/logs-summary.txt" || true
echo done
