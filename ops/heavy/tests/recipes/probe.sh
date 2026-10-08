#!/bin/bash
# A light recipe for the tests: real processes, synthetic evidence, nothing heavy. Runs under the real supervisor.
#   probe.sh MODE [ARG]
# Modes:
#   ok | wrong | suite-fail      write evidence through check.py: exit 0, 10, 11
#   no-result | foreign-result | stale-evidence   exit 0 with evidence the adapter must reject (66)
#   spawn SECONDS                start tracked processes (below), write OUT/ready, sleep SECONDS, then ok
#   spawn-held                   as spawn, but wait until the test creates OUT/release, then ok
#   leftover                     start tracked processes, then ok and exit 0 with them still running
#   alloc MB [SECONDS]           a child touches MB of anonymous memory, writes OUT/ready, holds it SECONDS (2), then ok
#   slow-cleanup SECONDS         on TERM, take SECONDS to clean up, write OUT/cleanup-done, exit 143
#   env-dump                     write this recipe's environment to OUT/env.txt, then ok
#   cat-input NAME               copy the sealed input NAME to OUT/seen.txt, then ok
#   stubborn                     leave a child that closes every inherited descriptor and ignores SIGTERM, then ok
#   launchd-up                   register and start a launchd job with the job's prefix, write OUT/ready, sleep
#   register-bad                 try to register a label outside the job's prefix (OUT/register-bad.txt), then ok
#   group-held                   start a held process in a new session (as rig.ts does for Chrome), register its group,
#                                release it, write OUT/ready, sleep; also try registering a stranger's group
#                                (ARG = its pid), recording the answer in OUT/register-stranger.txt
#   lock-proof                   run rig-run's proof that RIG_HEAVY_LOCK_FD holds heavy.lock (HEAVY_LOCK_PATH),
#                                write the answer to OUT/lock-proof.txt, then ok
#   rig RIG-RUN ARGS...          run RIG-RUN (tests/fake-rig-run.sh, or the real rig-run) with ARGS, forwarding TERM,
#                                then ok
# Tracked processes: a detached process group (setsid), a double-forked orphan, a child with an empty environment,
# and a launchd job whose label starts with the job's prefix (no marker in its environment).
set -u
. "$CARET_HEAVY_RECIPES/lib.sh"
MODE=${1:?mode}
ARG=${2:-}

evidence() { # evidence NAME WRONG-COUNT
  mkdir -p "$OUT/$1"
  py -c 'import json, sys
rows = [{"id": "p1", "walk": {"commandMs": 1}, "wrong": [], "error": None},
        {"id": "p2", "walk": {"commandMs": 1}, "wrong": ["Email: x (key: y)"] * int(sys.argv[2]), "error": None}]
json.dump({"rows": rows, "presses": 0, "posts": 0, "spent": 0}, open(sys.argv[1], "w"))' "$OUT/$1/page-loop.json" "$2"
  echo "[page-loop] pages 2, walked 2, wrong $2" > "$OUT/$1.log"
}

spawn() {
  py -c 'import os, time; os.setsid(); time.sleep(600)' &
  echo "detached-group $!" >> "$OUT/spawned.txt"
  py -c 'import os, time
if os.fork(): os._exit(0)
os.setsid()
if os.fork(): os._exit(0)
open(os.environ["CARET_HEAVY_OUT"] + "/orphan.pid", "w").write(str(os.getpid()))
time.sleep(600)'
  env -i /bin/sleep 600 &
  echo "empty-env-child $!" >> "$OUT/spawned.txt"
  label="${CARET_HEAVY_LAUNCHD_PREFIX}probe"
  cat > "$OUT/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>/bin/sleep</string><string>600</string></array>
<key>RunAtLoad</key><true/></dict></plist>
PLIST
  launchctl bootstrap "gui/$(id -u)" "$OUT/$label.plist"
  echo "launchd $label" >> "$OUT/spawned.txt"
  for _ in $(seq 1 50); do [ -s "$OUT/orphan.pid" ] && break; sleep 0.1; done
}

case "$MODE" in
  ok) evidence set 0; check page-loop set --exit 0; finish ;;
  wrong) evidence set 1; check page-loop set --exit 1; finish ;;
  suite-fail)
    printf ' Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 5 passed (6)\n' > "$OUT/suite.txt"
    check suite suite --log "$OUT/suite.txt" --exit 1 --kind vitest; finish ;;
  no-result) evidence set 0; exit 0 ;;
  foreign-result)
    evidence set 0; check page-loop set --exit 0
    (export CARET_HEAVY_JOB_ID=caret-someone-else; check finish); exit 0 ;;
  stale-evidence)
    evidence set 0; touch -t 202601010000 "$OUT/set/page-loop.json"; check page-loop set --exit 0; finish ;;
  spawn) spawn; touch "$OUT/ready"; sleep "${ARG:-600}" & wait $!; evidence set 0; check page-loop set --exit 0; finish ;;
  spawn-held)
    spawn; touch "$OUT/ready"
    until [ -e "$OUT/release" ]; do sleep 0.1; done
    evidence set 0; check page-loop set --exit 0; finish ;;
  leftover) spawn; touch "$OUT/ready"; evidence set 0; check page-loop set --exit 0; finish ;;
  slow-cleanup)
    trap 'sleep "$ARG"; date +%s > "$OUT/cleanup-done"; exit 143' TERM
    touch "$OUT/ready"; sleep 600 & wait $! ;;
  env-dump) env > "$OUT/env.txt"; evidence set 0; check page-loop set --exit 0; finish ;;
  cat-input) cp "$CARET_HEAVY_INPUTS/$ARG" "$OUT/seen.txt"; evidence set 0; check page-loop set --exit 0; finish ;;
  stubborn)
    py -c 'import os, signal, time
os.closerange(3, 1024)  # holds no lock: only the supervisor and the recovery owner keep exclusion
signal.signal(signal.SIGTERM, signal.SIG_IGN)
open(os.environ["CARET_HEAVY_OUT"] + "/stubborn.pid", "w").write(str(os.getpid()))
time.sleep(600)' &
    for _ in $(seq 1 50); do [ -s "$OUT/stubborn.pid" ] && break; sleep 0.1; done
    evidence set 0; check page-loop set --exit 0; finish ;;
  launchd-up)
    label="${CARET_HEAVY_LAUNCHD_PREFIX}svc"
    cat > "$OUT/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>/bin/sleep</string><string>600</string></array>
<key>RunAtLoad</key><true/></dict></plist>
PLIST
    $CARET_HEAVY_REGISTER launchd "$label" || exit 64
    launchctl bootstrap "gui/$(id -u)" "$OUT/$label.plist"
    echo "$label" > "$OUT/ready"
    sleep 600 & wait $! ;;
  group-held)
    mkfifo "$OUT/go"
    (exec "$PY" -I -B -X pycache_prefix=/var/empty -c 'import os, sys, time
os.setsid()
open(sys.argv[2] + ".sid", "w").close()
with open(sys.argv[1]) as go:
    if go.read(1) != "G":
        os._exit(97)
open(sys.argv[2], "w").write(str(os.getpid()))
time.sleep(600)' "$OUT/go" "$OUT/held.pid") &
    held=$!
    for _ in $(seq 1 50); do [ -e "$OUT/held.pid.sid" ] && break; sleep 0.1; done  # rig.ts's spawn makes the group first
    $CARET_HEAVY_REGISTER group "$held" 2> "$OUT/register-group.txt"; echo "exit $?" >> "$OUT/register-group.txt"
    echo G > "$OUT/go"
    $CARET_HEAVY_REGISTER group "$ARG" 2> "$OUT/register-stranger.txt"; echo "exit $?" >> "$OUT/register-stranger.txt"
    for _ in $(seq 1 50); do [ -s "$OUT/held.pid" ] && break; sleep 0.1; done
    touch "$OUT/ready"
    sleep 600 & wait $! ;;
  register-bad)
    $CARET_HEAVY_REGISTER launchd "com.example.not-this-job" 2> "$OUT/register-bad.txt"; echo "exit $?" >> "$OUT/register-bad.txt"
    evidence set 0; check page-loop set --exit 0; finish ;;
  lock-proof)
    # The same check rig-run's take_heavy_lock makes before using an inherited descriptor.
    py -c 'import fcntl, os, sys
fd, path = int(sys.argv[1]), sys.argv[2]
if not os.path.samestat(os.fstat(fd), os.stat(path)): sys.exit(1)
probe = os.open(path, os.O_RDONLY)
try:
    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
    sys.exit(1)
except BlockingIOError:
    pass
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)' "${RIG_HEAVY_LOCK_FD:-none}" "$ARG" && echo held-through-fd > "$OUT/lock-proof.txt" || echo refused > "$OUT/lock-proof.txt"
    evidence set 0; check page-loop set --exit 0; finish ;;
  rig)
    shift 2
    /bin/bash "$ARG" "$@" &
    rig=$!
    trap 'kill -TERM "$rig" 2>/dev/null' TERM
    touch "$OUT/ready"
    wait "$rig"; while kill -0 "$rig" 2>/dev/null; do wait "$rig"; done
    evidence set 0; check page-loop set --exit 0; finish ;;
  alloc)
    py -c 'import mmap, os, sys, time
m = mmap.mmap(-1, int(sys.argv[1]) * 1024 * 1024)
for i in range(0, len(m), 4096):
    m[i] = 1
open(os.path.join(os.environ["CARET_HEAVY_OUT"], "ready"), "w").close()
time.sleep(float(sys.argv[2]))' "$ARG" "${3:-2}"
    evidence set 0; check page-loop set --exit 0; finish ;;
  *) echo "probe: unknown mode $MODE" >&2; exit 64 ;;
esac
