#!/bin/bash
# Offline test: rig-run takes ~/.long-run/locks/heavy.lock after its two leases, and a busy lock is a
# refusal that leaves no lease held. Runs entirely in a temporary HOME: copies of rig-run, lead-hold and
# a shim over the real lr-lease-core, a zero-floor policy and an empty lease directory. rig-run stops at its test hook
# (RIG_RUN_TEST_HOLD_AT_LOCK) or at the refusal, before anything touches Lume. The real leases, lock,
# HOLD and VMs are never read or written. Prints PASS/FAIL per case; exit 1 on a FAIL.
#   RIG_RUN=<path> tests another copy of rig-run.
set -u
SRC=~/.long-run
RR_SRC=${RIG_RUN:-$SRC/rig/bin/rig-run}
PY=/opt/homebrew/opt/python@3.14/bin/python3.14
T=$(mktemp -d /tmp/rig-heavy-lock.XXXXXX)
H=$T/home
L=$H/.long-run
mkdir -p "$L/bin" "$L/rig/bin" "$L/locks" "$L/leases" "$T/job"
# lr-lease here is a shim over the real lr-lease-core.mjs (acquire, release, reap, policy, count limits) with fixed
# readings: rig-run's vm lease charges 6 + 2 GiB against free disk, which this Mac may not have, and the lease
# arithmetic is lr-lease.test.mjs's subject, not this test's.
cat > "$L/bin/lr-lease-shim.mjs" <<SHIM
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { acquire, release, reap, readPolicy, machineReaders } from '$SRC/bin/lr-lease-core.mjs';
const root = path.join(process.env.HOME, '.long-run'), dir = path.join(root, 'leases');
const real = machineReaders(root);
const readers = { ...real, diskGB: () => 1000, swapGB: () => 1000, pressure: () => 'normal', quietUntil: () => 0 };
const [mode, verb, ...rest] = process.argv.slice(2);
const opt = name => rest[rest.indexOf(name) + 1];
if (mode === 'reap') { reap(dir, readers, opt('--run')); process.exit(0); }
if (verb === 'release') { release(dir, rest[0]); process.exit(0); }
if (verb !== 'acquire') { console.log('refused: shim supports acquire, release and reap'); process.exit(75); }
// SHIM_HOLD_ON_VM=<file>: the lead's hold appears while rig-run is taking its vm lease (after its own hold check).
if (opt('--kind') === 'vm' && process.env.SHIM_HOLD_ON_VM) writeFileSync(process.env.SHIM_HOLD_ON_VM, '4102444800 appeared mid-acquire\n');
const result = acquire(dir, readPolicy(path.join(root, 'lease-policy.json')), readers, { run: opt('--run'), kind: opt('--kind'),
  estMemGB: Number(opt('--est-mem')), estDiskGB: Number(opt('--est-disk')), ttlMinutes: Number(opt('--ttl')), ownerPid: Number(opt('--owner-pid')) });
if (result.reason) { console.log('refused: ' + result.reason); process.exit(75); }
console.log(result.lease.id);
SHIM
printf '%s\n' '#!/bin/sh' 'exec node "$(dirname "$0")/lr-lease-shim.mjs" lease "$@"' > "$L/bin/lr-lease"
printf '%s\n' '#!/bin/sh' 'exec node "$(dirname "$0")/lr-lease-shim.mjs" reap "$@"' > "$L/bin/lr-reap"
chmod +x "$L/bin/lr-lease" "$L/bin/lr-reap"
cp "$RR_SRC" "$L/rig/bin/rig-run"; cp "$SRC/rig/bin/lead-hold" "$L/rig/bin/"
"$PY" - "$SRC/lease-policy.json" "$L/lease-policy.json" <<'EOF'
import json, sys
policy = json.load(open(sys.argv[1]))
for rule in policy["kinds"].values():
    rule["diskFloorGB"] = 0
policy["kinds"]["heavy"]["maxCount"] = policy["kinds"]["vm"]["maxCount"] = 1
json.dump(policy, open(sys.argv[2], "w"))
EOF
printf '%s\n' '#!/bin/bash' '# rig-timeout-seconds: 60' 'exit 0' > "$T/job/job.sh"
LOCK=$L/locks/heavy.lock
export HOME=$H RIG_HOLD_FILE=$T/no-hold
fails=0 n=0
ok() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got '$2', want '$3'"; fails=$((fails+1)); fi; }
leases_of() { grep -l "\"ownerPid\":$1," "$L"/leases/*.json 2>/dev/null | wc -l | tr -d ' '; }
lock_free() { /usr/bin/lockf -k -t 0 "$LOCK" true 2>/dev/null && echo free || echo held; }
wait_for() { local i; for i in $(seq 1 100); do [ -e "$1" ] && return 0; sleep 0.1; done; return 1; }
cleanup() { [ -n "${KEEP:-}" ] && { echo "kept $T"; return; }; [ -n "${HP:-}" ] && kill "$HP" 2>/dev/null; [ -n "${P:-}" ] && kill "$P" 2>/dev/null; wait 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT

# 1. Lock free: rig-run holds both leases and the lock, so with-heavy's door (lockf on the lock) is shut.
RIG_RUN_TEST_HOLD_AT_LOCK=$T/at-lock "$L/rig/bin/rig-run" "$T/job" --wait 0 > "$T/rr1.out" 2>&1 &
P=$!
wait_for "$T/at-lock" && r=yes || r=no; ok "rig-run reaches the point after leases and lock" "$r" yes
ok "heavy.lock is held while rig-run holds its leases" "$(lock_free)" held
ok "rig-run holds the heavy and vm leases" "$(leases_of "$P")" 2
rm -f "$T/at-lock"; wait "$P"; rc=$?; P=""
ok "rig-run exits 0 at the test hook" "$rc" 0
ok "heavy.lock is free after rig-run exits" "$(lock_free)" free
ok "no lease is left after rig-run exits" "$(ls "$L/leases" | grep -c json)" 0

# 2. Lock busy (as with-heavy holds it while a build runs): refusal, exit 75, no lease left.
"$PY" -c 'import fcntl, os, sys, time; fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT); fcntl.flock(fd, fcntl.LOCK_EX); open(sys.argv[2], "w").close(); time.sleep(120)' "$LOCK" "$T/holder-up" &
HP=$!
wait_for "$T/holder-up"
RIG_RUN_TEST_HOLD_AT_LOCK=$T/at-lock2 "$L/rig/bin/rig-run" "$T/job" --wait 0 > "$T/rr2.out" 2>&1; rc=$?
ok "busy heavy.lock: rig-run exits 75" "$rc" 75
[ -e "$T/at-lock2" ] && r=yes || r=no; ok "busy heavy.lock: rig-run never passes the lease step" "$r" no
ok "busy heavy.lock: no lease is left" "$(ls "$L/leases" | grep -c json)" 0
run=$(ls -td "$T"/job/runs/* | head -1)
grep -q "no lease: heavy.lock is held by another heavy job" "$run/rig.log" && r=yes || r=no
ok "busy heavy.lock: the refusal is logged" "$r" yes

# 3. Waiting on a busy lock holds no lease between tries; a TERM while waiting leaves nothing.
"$L/rig/bin/rig-run" "$T/job" --wait 600 > "$T/rr3.out" 2>&1 &
P=$!
sleep 4
kill -0 "$P" 2>/dev/null && r=waiting || r=exited; ok "rig-run --wait keeps waiting on a busy lock" "$r" waiting
ok "no lease is held while waiting on the lock" "$(leases_of "$P")" 0
kill -TERM "$P"; wait "$P"; rc=$?; P=""
ok "TERM while waiting: exit 143" "$rc" 143
ok "TERM while waiting: no lease left" "$(ls "$L/leases" | grep -c json)" 0
kill "$HP"; wait "$HP" 2>/dev/null; HP=""
ok "heavy.lock free once the holder exits" "$(lock_free)" free

# 4. A queue runner holds heavy.lock and passes its descriptor down: rig-run proves that descriptor holds the lock and
#    goes ahead instead of waiting on its own caller.
(
  exec 7>>"$LOCK"
  "$PY" -c 'import fcntl; fcntl.flock(7, fcntl.LOCK_EX | fcntl.LOCK_NB)' || exit 9
  RIG_HEAVY_LOCK_FD=7 RIG_RUN_TEST_HOLD_AT_LOCK=$T/at-lock4 "$L/rig/bin/rig-run" "$T/job" --wait 0 > "$T/rr4.out" 2>&1
  echo $? > "$T/rr4.rc"
) &
SUB=$!
wait_for "$T/at-lock4" && r=yes || r=no; ok "inherited holder: rig-run passes the lock step" "$r" yes
ok "inherited holder: heavy.lock held" "$(lock_free)" held
ok "inherited holder: both leases taken" "$(ls "$L/leases" | grep -c json)" 2
rm -f "$T/at-lock4"; wait "$SUB"
ok "inherited holder: rig-run exits 0" "$(cat "$T/rr4.rc")" 0
ok "inherited holder: lock free once the holder's shell exits" "$(lock_free)" free
ok "inherited holder: no lease left" "$(ls "$L/leases" | grep -c json)" 0

# 5. RIG_HEAVY_LOCK_FD naming a descriptor that does not hold the lock, while another process does: refused.
"$PY" -c 'import fcntl, os, sys, time; fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT); fcntl.flock(fd, fcntl.LOCK_EX); open(sys.argv[2], "w").close(); time.sleep(120)' "$LOCK" "$T/holder5-up" &
HP=$!
wait_for "$T/holder5-up"
( exec 7>>"$LOCK"; RIG_HEAVY_LOCK_FD=7 RIG_RUN_TEST_HOLD_AT_LOCK=$T/at-lock5 "$L/rig/bin/rig-run" "$T/job" --wait 0 > "$T/rr5.out" 2>&1; echo $? > "$T/rr5.rc" )
ok "foreign holder: a non-holding inherited descriptor is refused (exit 75)" "$(cat "$T/rr5.rc")" 75
[ -e "$T/at-lock5" ] && r=yes || r=no; ok "foreign holder: rig-run never passes the lease step" "$r" no
ok "foreign holder: no lease left" "$(ls "$L/leases" | grep -c json)" 0
kill "$HP"; wait "$HP" 2>/dev/null; HP=""

# 6. RIG_HEAVY_LOCK_FD while nobody holds heavy.lock proves nothing: refused, rather than taking it through that file.
( exec 7>>"$LOCK"; RIG_HEAVY_LOCK_FD=7 RIG_RUN_TEST_HOLD_AT_LOCK=$T/at-lock6 "$L/rig/bin/rig-run" "$T/job" --wait 0 > "$T/rr6.out" 2>&1; echo $? > "$T/rr6.rc" )
ok "unheld lock: an inherited descriptor is refused (exit 75)" "$(cat "$T/rr6.rc")" 75
ok "unheld lock: heavy.lock still free" "$(lock_free)" free

# 7. RIG_RUN_ID_FILE: rig-run writes its exact run directory there, so a caller never globs runs/ by pid.
RIG_RUN_ID_FILE=$T/run-id RIG_RUN_TEST_HOLD_AT_LOCK=$T/at-lock7 "$L/rig/bin/rig-run" "$T/job" --wait 0 > "$T/rr7.out" 2>&1 &
P=$!
wait_for "$T/at-lock7"
id=$(cat "$T/run-id" 2>/dev/null)
[ -n "$id" ] && [ -d "$id" ] && [ "${id##*-}" = "$P" ] && r=yes || r="no ($id)"
ok "RIG_RUN_ID_FILE names this run's directory" "$r" yes
rm -f "$T/at-lock7"; wait "$P"; P=""

# 8. Admission is rechecked once both leases and heavy.lock are held, before any clone: free disk below
#    RIG_RUN_MIN_FREE_GIB refuses (75) and releases everything.
RIG_RUN_MIN_FREE_GIB=999999 RIG_RUN_TEST_HOLD_AT_LOCK=$T/at-lock8 "$L/rig/bin/rig-run" "$T/job" --wait 0 > "$T/rr8.out" 2>&1
ok "disk below RIG_RUN_MIN_FREE_GIB after resources: exit 75" "$?" 75
[ -e "$T/at-lock8" ] && r=yes || r=no; ok "disk recheck: stops before the clone step" "$r" no
ok "disk recheck: no lease left" "$(ls "$L/leases" | grep -c json)" 0
ok "disk recheck: heavy.lock free" "$(lock_free)" free
run=$(ls -td "$T"/job/runs/* | head -1)
grep -q "blocked after leases: disk" "$run/rig.log" && r=yes || r=no; ok "disk recheck: logged" "$r" yes

# 9. The lead's hold appearing while rig-run takes its leases is caught by the same recheck.
SHIM_HOLD_ON_VM=$RIG_HOLD_FILE RIG_RUN_TEST_HOLD_AT_LOCK=$T/at-lock9 "$L/rig/bin/rig-run" "$T/job" --wait 0 > "$T/rr9.out" 2>&1
ok "hold after leases: exit 75" "$?" 75
[ -e "$T/at-lock9" ] && r=yes || r=no; ok "hold after leases: stops before the clone step" "$r" no
ok "hold after leases: no lease left" "$(ls "$L/leases" | grep -c json)" 0
rm -f "$RIG_HOLD_FILE"

echo "$((n-fails))/$n passed"
[ "$fails" -eq 0 ]
