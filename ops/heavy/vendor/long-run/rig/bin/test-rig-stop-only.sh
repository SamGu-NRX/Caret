#!/bin/bash
# Isolated tests of `rig-stop --only OWNER_PID` and `--grace`, against synthetic lease records
# (RIG_STOP_LEASE_STATUS) and a temp root (RIG_STOP_TEST_ROOT). Every target is a process this script
# starts. Prints PASS/FAIL per case; exit 1 on a FAIL.
set -u
S=${RIG_STOP:-~/.long-run/rig/bin/rig-stop}
T=$(mktemp -d); L=$T/leases; FAKE=$T/bin/rig-run; mkdir -p "$T/bin" "$T/rig/runs" "$T/lume"
printf '#!/bin/bash\ntrap "" TERM\nwhile :; do sleep 1; done\n' > "$FAKE"; chmod +x "$FAKE"
export RIG_STOP_TEST_ROOT=$T RIG_STOP_RIG_RUN=$FAKE
fails=0 n=0
lease() { local now; now=$(python3 -c 'import time;print(int(time.time()*1000))')
  printf '{"id":"%s","ownerPid":%s,"run":"rig","kind":"vm","estMemGB":6,"estDiskGB":2,"createdAt":%s,"expiresAt":%s}\n' "$1" "$2" $((now+${3:-0})) $((now+600000)) > "$L"; }
check() { # NAME WANT_RC RC WANT_ALIVE(yes|no) PID OUT
  n=$((n+1)); local a; a=$(kill -0 "$5" 2>/dev/null && echo yes || echo no)
  if [ "$3" = "$2" ] && [ "$a" = "$4" ]; then r=PASS; else r=FAIL; fails=$((fails+1)); fi
  echo "$r $1: exit=$3 (want $2) target alive=$a (want $4) | $(echo "$6" | tr '\n' ' ' | cut -c1-200)"; }
: > "$L"
sleep 300 & P=$!; sleep 1
out=$(RIG_STOP_LEASE_STATUS=$L "$S" --only "$P" 2>&1); check "no lease owned by the pid -> refuse" 2 $? yes "$P" "$out"
lease t1 "$P"; out=$(RIG_STOP_LEASE_STATUS=$L "$S" --only "$P" 2>&1); check "lease owner is not a rig-run (sleep) -> refuse" 2 $? yes "$P" "$out"
kill "$P"; wait "$P" 2>/dev/null
out=$(RIG_STOP_LEASE_STATUS=$L "$S" --only "$P" 2>&1); check "lease owner pid no longer running -> refuse" 2 $? no "$P" "$out"
bash -c 'exec /usr/bin/python3 -c "import time; time.sleep(300)" "review bin/rig-run" '"$FAKE" & B=$!; sleep 1; lease t2 "$B"
out=$(RIG_STOP_LEASE_STATUS=$L "$S" --only "$B" 2>&1); check "exec'd lookalike whose argv mentions rig-run -> refuse" 2 $? yes "$B" "$out"; kill "$B"
/bin/bash -c "sleep 300; : $FAKE" & C=$!; sleep 1; lease t3 "$C"
out=$(RIG_STOP_LEASE_STATUS=$L "$S" --only "$C" 2>&1); check "/bin/bash -c '... rig-run' (argv[1] is -c) -> refuse" 2 $? yes "$C" "$out"; pkill -P "$C"; kill "$C" 2>/dev/null
"$FAKE" & F=$!; sleep 2; lease t4 "$F" -60000
out=$(RIG_STOP_LEASE_STATUS=$L "$S" --only "$F" 2>&1); check "rig-run argv but started after the lease (reused pid) -> refuse" 2 $? yes "$F" "$out"
lease t5 "$F"; mkdir -p "$T/rig/runs/rig-run-$F"; echo "Thu Oct  1 09:00:00 2026" > "$T/rig/runs/rig-run-$F/owner.start"
out=$(RIG_STOP_LEASE_STATUS=$L "$S" --only "$F" 2>&1); check "recorded owner.start differs (reused pid) -> refuse" 2 $? yes "$F" "$out"
ps -o lstart= -p "$F" > "$T/rig/runs/rig-run-$F/owner.start"
t=$(date +%s); out=$(RIG_STOP_LEASE_STATUS=$L "$S" --only "$F" --grace 0 2>&1); rc=$?
check "owner ignores SIGTERM, --grace 0 -> no SIGKILL, exit 1 ($(( $(date +%s)-t )) s)" 1 $rc yes "$F" "$out"
echo h5 > "$T/rig/runs/rig-run-$F/heavy.id"
t=$(date +%s); out=$(RIG_STOP_RELEASED=$T/released RIG_STOP_LEASE_STATUS=$L "$S" --only "$F" --grace 2 2>&1); rc=$?
check "owner ignores SIGTERM, --grace 2 -> SIGKILL after 2 s, exit 0 ($(( $(date +%s)-t )) s)" 0 $rc no "$F" "$out"
rel=$(cat "$T/released" 2>/dev/null | tr '\n' ' '); n=$((n+1))
[ "$rel" = "t5 h5 " ] && echo "PASS SIGKILLed owner -> vm and recorded heavy lease released ($rel)" || { echo "FAIL released '$rel', want 't5 h5 '"; fails=$((fails+1)); }
out=$("$S" --grace x 2>&1); rc=$?; n=$((n+1)); [ $rc = 64 ] && echo "PASS bad --grace -> 64" || { echo "FAIL bad --grace"; fails=$((fails+1)); }
out=$("$S" --only 1 --orphans 2>&1); rc=$?; n=$((n+1)); [ $rc = 64 ] && echo "PASS --only with --orphans -> 64" || { echo "FAIL --only with --orphans"; fails=$((fails+1)); }
kill -KILL "$F" 2>/dev/null; wait 2>/dev/null; rm -rf "$T"
echo "$((n-fails))/$n passed"
[ "$fails" = 0 ]
