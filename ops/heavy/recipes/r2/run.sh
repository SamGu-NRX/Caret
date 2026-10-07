#!/bin/bash
# R2's feeder for H11 and H14: submits the staged VM job to rig-run once and hands the guest the Jev key at run time.
# From ~/.caret-run/evidence/host/r2/h11/harness/run.sh and h14/harness/run.sh, which differed only in H11's --config
# and their log paths. Changed for ops/heavy: the key file is $CARET_ENV_FILE (the path the job's plan recorded) instead
# of a fixed .env, so the recorded path is the one used; logs go to $CARET_HEAVY_OUT; the rig run directory is written to
# $CARET_HEAVY_OUT/rig-run-dir for recipes/r2/vm.sh.
#
#   run.sh --job DIR --harness h11|h14 [--config off|on] [--wait SECONDS]   (--config is required for h11)
#
# Why a feeder: rig-run starts job.sh as a LaunchAgent from a fixed plist and has no channel for a secret, and the rig's
# rule is that no key goes into a payload file. So this shell reads the key from CARET_ENV_FILE into an unexported
# variable, waits for the job to create its FIFO (~/rig/job/secret.fifo), and writes the key into it over ssh stdin. The
# guest side opens the path only if it is a FIFO and never creates it, so a vanished FIFO can't become a file holding
# the key. The job acknowledges with keys.ok. Nothing here passes a key in argv or a child's environment: printf is a
# builtin, and its output goes to ssh's or python's stdin. No Groq key is ever read (Sam's rule: no Groq).
#
# After the run, this run's directory (runs/*-<rig-run pid>) is scanned for the key with leakscan.py, which fails
# closed. A hit deletes the file and exits 99; a scan that can't finish exits 98.
set -uo pipefail
set +x
unset K_JEV TYPESAFE_API_KEY GROQ_API_KEY
HERE=$(cd "$(dirname "$0")" && pwd)
R="$HOME/.long-run/rig"
# Test only: CARET_HEAVY_TEST_LUME replaces Lume (tests/test_recipes.py). The supervisor's environment allowlist never
# passes it to a real job.
LUME=${CARET_HEAVY_TEST_LUME:-/Users/samgu/.local/share/lume/lume.app/Contents/MacOS/lume}
export LUME_TELEMETRY_ENABLED=false
JOB=""; HARNESS=""; WAIT=3600; CONFIG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --job) JOB=${2:?}; shift 2 ;; --harness) HARNESS=${2:?}; shift 2 ;;
    --wait) WAIT=${2:?}; shift 2 ;; --config) CONFIG=${2:?}; shift 2 ;;
    *) echo "usage: run.sh --job DIR --harness h11|h14 [--config off|on] [--wait SECONDS]" >&2; exit 64 ;;
  esac
done
case "$HARNESS" in h11) case "$CONFIG" in off|on) ;; *) echo "run.sh: h11 needs --config off|on" >&2; exit 64 ;; esac ;;
  h14) [ -z "$CONFIG" ] || { echo "run.sh: --config is H11's only" >&2; exit 64; } ;;
  *) echo "run.sh: --harness h11|h14 is required" >&2; exit 64 ;; esac
[ -f "$JOB/job.sh" ] && [ -d "$JOB/payload/tools" ] || { echo "run.sh: $JOB is not staged; run stage.sh" >&2; exit 64; }
ENVF=${CARET_ENV_FILE:-}
[ -n "$ENVF" ] && [ -f "$ENVF" ] || { echo "run.sh: CARET_ENV_FILE must name the .env holding TYPESAFE_API_KEY" >&2; exit 64; }
LOGDIR=${CARET_HEAVY_OUT:-$JOB}
[ -z "$CONFIG" ] || printf '%s\n' "$CONFIG" > "$JOB/payload/CONFIG"

envval() { sed -n "s/^$1=//p" "$ENVF" | head -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | tr -d '\r'; }
K_JEV=$(envval TYPESAFE_API_KEY)
[ -n "$K_JEV" ] || { echo "run.sh: TYPESAFE_API_KEY missing from CARET_ENV_FILE" >&2; exit 64; }
[ ${#K_JEV} -ge 20 ] || { echo "run.sh: TYPESAFE_API_KEY is shorter than 20 characters; refusing (the leak check needs 16-character ends)" >&2; exit 64; }

say() { echo "$(date -u +%H:%M:%SZ) $*" | tee -a "$LOGDIR/run.log"; }
gssh() {
  ssh -i "$R/tmp/rig_ed25519" -o HostKeyAlias=rig-golden -o UserKnownHostsFile="$R/tmp/known_hosts_rig" -o StrictHostKeyChecking=yes \
      -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o LogLevel=ERROR "lume@$IP" "$@"
}
wait_ack() { local i; for i in $(seq 1 10); do gssh 'test -e ~/rig/job/keys.ok' 2>/dev/null && return 0; sleep 1; done; return 1; }
trap '[ -n "${RP:-}" ] && kill -TERM "$RP" 2>/dev/null; [ -n "${RP:-}" ] && wait "$RP"; exit 143' TERM INT HUP

say "submit $(cat "$JOB/payload/REV" 2>/dev/null) harness $HARNESS${CONFIG:+ config $CONFIG} wait $WAIT"
# One rig attempt after rig-run's own bounded lease wait (R2's rule). Started by its absolute path, so rig-run does not
# re-exec and its pid names the clone (rig-run-<pid>).
"$R/bin/rig-run" "$JOB" --wait "$WAIT" >> "$LOGDIR/run.log" 2>&1 &
RP=$!
VM="rig-run-$RP"
fed=0
while kill -0 "$RP" 2>/dev/null; do
  if [ $fed = 0 ]; then
    IP=$("$LUME" get "$VM" --format json 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print(d.get("ipAddress") or "")' 2>/dev/null)
    if [ -n "$IP" ] && gssh 'test -p ~/rig/job/secret.fifo && ! test -e ~/rig/job/keys.ok' 2>/dev/null; then
      printf 'TYPESAFE_API_KEY=%s\n' "$K_JEV" |
        gssh 'perl -MFcntl -e '\''alarm 120; my $p = "$ENV{HOME}/rig/job/secret.fifo"; -p $p or die "not a FIFO"; sysopen(my $f, $p, O_WRONLY) or die "open: $!"; -p $f or die "not a FIFO"; print $f <STDIN>; close $f'\''' 2>/dev/null
      if wait_ack; then fed=1; say "key handed to $VM over ssh stdin (job acknowledged)"; else say "feeding $VM: no acknowledgment yet; will retry"; fi
    fi
  fi
  sleep 3
done
wait "$RP"; rc=$?
say "rig-run exit $rc"

RUN=$(ls -d "$JOB"/runs/*-"$RP" 2>/dev/null | head -1)
[ -n "$RUN" ] || { say "no run directory for rig-run $RP"; K_JEV=""; exit "$rc"; }
[ -z "${CARET_HEAVY_OUT:-}" ] || printf '%s\n' "$RUN" > "$CARET_HEAVY_OUT/rig-run-dir"
say "run directory $RUN"
# The leak check (leakscan.py): the key on stdin, never argv; a scanner failure fails the run.
scan=$(printf '%s\n' "$K_JEV" | python3 "$HERE/leakscan.py" "$RUN"); src=$?
K_JEV=""
leaks=$(printf '%s\n' "$scan" | sed '1d' | grep .)
say "guest leak check: $(cat "$RUN/out/leak-check.txt" 2>/dev/null || echo missing)"
if [ $src != 0 ]; then say "host leak check could not finish (exit $src); treat $RUN as unscanned"; exit 98; fi
if [ -n "$leaks" ]; then
  printf '%s\n' "$leaks" | while read -r f; do rm -rf "$f"; done
  echo "A model key (or 16 characters of one) was found in $(printf '%s\n' "$leaks" | wc -l | tr -d ' ') file(s) copied back; they were deleted." > "$RUN/KEY-LEAK.txt"
  say "KEY LEAK on the host: files deleted; see $RUN/KEY-LEAK.txt"
  exit 99
fi
say "host leak check: clean ($(printf '%s\n' "$scan" | head -1))"
[ "$fed" = 1 ] || say "the key was never handed over (the job ran without live models)"
exit "$rc"
