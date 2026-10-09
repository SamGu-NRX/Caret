#!/bin/bash
# The fixture activation proof (brief B9): does CaretFixture.app become frontmost when asked?
# On screen, so it runs only when the gui lease grants, gui.lock is held, HID idle is at least 300 s
# and no quiet window is on (~/.long-run/QUIET-UNTIL). It makes up to three attempts in one idle
# window (activation-proof.swift stops the moment HID idle drops under 5 s) and waits for a window
# until WAIT_UNTIL (epoch seconds), then writes "deferred: user active".
#   run-activation-proof.sh BIN_DIR OUT_DIR WAIT_UNTIL
# BIN_DIR holds CaretFixture.app (scripts/bundle-fixture.sh). Attempts land in OUT_DIR/attempts.ndjson.
set -uo pipefail
BIN=${1:?usage: run-activation-proof.sh BIN_DIR OUT_DIR WAIT_UNTIL}
OUT=${2:?}
WAIT_UNTIL=${3:?}
FIXTURE="$BIN/CaretFixture.app/Contents/MacOS/caret-fixture"
PROBE="$BIN/activation-proof"
LEASE="$HOME/.long-run/bin/lr-lease"
GUI_LOCK="$HOME/.long-run/locks/gui.lock"
[[ -x "$FIXTURE" ]] || { echo "no $FIXTURE; run scripts/bundle-fixture.sh first" >&2; exit 1; }
[[ -x "$PROBE" ]] || { echo "no $PROBE; build it with swiftc -O -o \"$PROBE\" experiments/activation-proof.swift" >&2; exit 1; }
mkdir -p "$OUT"
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$OUT/status.txt"; }

idle_s() { ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'; }
quiet() {
  [[ -f "$HOME/.long-run/QUIET-UNTIL" ]] || return 1
  local until; until=$(awk '{print int($1); exit}' "$HOME/.long-run/QUIET-UNTIL")
  [[ -z "$until" || "$until" -gt $(date +%s) ]]
}
# grep -c prints 0 and exits 1 when nothing matches, so "|| echo 0" printed a second 0 (CodeRabbit on PR #4).
done_attempts() { local c=0; [[ -f "$OUT/attempts.ndjson" ]] && c=$(grep -c '"becameFrontmost"' "$OUT/attempts.ndjson" || true); echo "${c:-0}"; }

while :; do
  n=$(done_attempts)
  if (( n >= 3 )); then log "three attempts recorded"; exit 0; fi
  if (( $(date +%s) >= WAIT_UNTIL )); then log "deferred: user active (no idle window before the deadline)"; exit 4; fi
  if quiet; then log "quiet window on; waiting"; sleep 30; continue; fi
  idle=$(idle_s)
  if (( idle < 300 )); then sleep 20; continue; fi
  if ! lease_id=$("$LEASE" acquire --run caret-v2 --kind gui --est-mem 0.5 --est-disk 0 --ttl 10 --owner-pid $$); then
    log "gui lease refused: $lease_id"; sleep 30; continue
  fi
  log "gui lease $lease_id; idle ${idle} s; waiting for gui.lock"
  # -t 60: another run holding gui.lock means wait and re-check idle, not queue blind.
  /usr/bin/lockf -k -t 60 "$GUI_LOCK" "$PROBE" "$FIXTURE" "$OUT/attempts.ndjson" $(( 3 - n )) "$n" 2>&1 | tee -a "$OUT/status.txt"
  rc=${PIPESTATUS[0]}
  "$LEASE" release "$lease_id" >/dev/null
  case $rc in
    0) log "window done" ;;
    3) log "stopped: user back or quiet window; waiting for the next idle window" ;;
    75) log "gui.lock busy for 60 s; retrying" ;;
    *) log "probe exit $rc"; exit "$rc" ;;
  esac
  sleep 5
done
