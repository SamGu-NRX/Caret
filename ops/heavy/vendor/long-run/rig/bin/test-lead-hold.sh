#!/bin/bash
# Offline tests of the lead's hold marker: bin/lead-hold on its own, then rig-run and with-heavy.sh
# against a held marker. The marker is a temp file (RIG_HOLD_FILE); the real ~/.caret-run/HOLD is
# never read or written. rig-run runs only its lease step (--wait 0 on jobs/smoke): no clone, and the
# test checks it took no lease. Prints PASS/FAIL per case; exit 1 on a FAIL.
# RIG_RUN / WITH_HEAVY override the scripts under test.
set -u
R=~/.long-run/rig
H=$R/bin/lead-hold
RR=${RIG_RUN:-$R/bin/rig-run}
WH=${WITH_HEAVY:-$R/bin/with-heavy.sh}
T=$(mktemp -d); export RIG_HOLD_FILE=$T/HOLD
fails=0 n=0
ok() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got '$2', want '$3'"; fails=$((fails+1)); fi; }
now=$(date +%s)

"$H" >/dev/null; ok "no marker -> not held" $? 1
echo "$((now + 600)) CogPortal slot" > "$RIG_HOLD_FILE"
out=$("$H"); ok "future marker -> held" $? 0
case "$out" in "CogPortal slot (until "*) r=yes ;; *) r="$out" ;; esac; ok "reason printed with end time" "$r" yes
echo "$((now - 5)) old hold" > "$RIG_HOLD_FILE"; "$H" >/dev/null; ok "past marker -> not held" $? 1
echo "soon CogPortal" > "$RIG_HOLD_FILE"; "$H" >/dev/null; ok "unreadable first field -> held (fails closed)" $? 0
echo "$((now + 600))" > "$RIG_HOLD_FILE"; out=$("$H"); ok "marker without reason -> held" $? 0

# rig-run: held -> exit 75 with no lease, and the hold logged; --wait keeps retrying through it.
echo "$((now + 600)) test hold" > "$RIG_HOLD_FILE"
before=$(ls -d "$R"/jobs/smoke/runs/* 2>/dev/null | wc -l)
"$RR" "$R/jobs/smoke" --wait 0 > "$T/rr.out" 2>&1; rc=$?
ok "rig-run under a hold -> exit 75" "$rc" 75
run=$(ls -td "$R"/jobs/smoke/runs/* | head -1)
grep -q "held by lead: test hold" "$run/rig.log" && r=yes || r=no; ok "rig-run logs 'held by lead: <reason>' in rig.log" "$r" yes
grep -q "held by lead: test hold" "$run/lease-refusals.log" && r=yes || r=no; ok "rig-run records the hold in lease-refusals.log" "$r" yes
pid=${run##*-}
n_leases=$(~/.long-run/bin/lr-lease status | grep '"run":"rig"' | grep -c "\"ownerPid\":$pid,")
ok "rig-run under a hold took no lease" "$n_leases" 0
grep -q "no lease: held by lead" "$run/rig.log" && r=yes || r=no; ok "rig-run's final refusal names the hold" "$r" yes
# --wait: the hold ends 35 s from now, so the run must retry past it (it then stops at the real lease
# check, which is fine either way: the test only needs to see it waited, not what came after).
echo "$(( $(date +%s) + 35 )) short hold" > "$RIG_HOLD_FILE"
"$RR" "$R/jobs/smoke" --wait 30 > "$T/rr2.out" 2>&1 &
p=$!
sleep 5; run2=$(ls -td "$R"/jobs/smoke/runs/* | head -1)
kill -0 "$p" 2>/dev/null && r=waiting || r=exited; ok "rig-run --wait 30 waits through a hold" "$r" waiting
grep -q "held by lead: short hold" "$run2/rig.log" && r=yes || r=no; ok "rig-run --wait logs the hold while waiting" "$r" yes
kill -TERM "$p" 2>/dev/null; wait "$p" 2>/dev/null
n_leases=$(~/.long-run/bin/lr-lease status | grep '"run":"rig"' | grep -c "\"ownerPid\":$p,")
ok "interrupted while held: no lease left" "$n_leases" 0

# with-heavy.sh: held -> it does not acquire, and says why (stopped after its first try).
echo "$((now + 600)) build hold" > "$RIG_HOLD_FILE"
"$WH" 0 0 true > "$T/wh.out" 2>&1 &
p=$!; sleep 3
kill -0 "$p" 2>/dev/null && r=waiting || r=exited; ok "with-heavy.sh under a hold keeps waiting" "$r" waiting
grep -q "held by lead: build hold" "$T/wh.out" && r=yes || r=no; ok "with-heavy.sh says 'held by lead: <reason>'" "$r" yes
n_leases=$(~/.long-run/bin/lr-lease status | grep '"run":"rig"' | grep -c "\"ownerPid\":$p,")
ok "with-heavy.sh under a hold took no lease" "$n_leases" 0
pkill -P "$p"; kill "$p" 2>/dev/null; wait "$p" 2>/dev/null

rm -rf "$T"
echo "$((n-fails))/$n passed"
[ "$fails" = 0 ]
