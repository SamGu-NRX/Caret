#!/bin/bash
# Offline test of rig-run's handed heavy lease (RIG_HEAVY_LEASE_ID) and managed cleanup mode (RIG_RUN_MANAGED=1).
# Runs entirely in a temporary HOME: copies of rig-run and lead-hold, an lr-lease shim over lr-lease-core.mjs with fixed
# readings, a zero-floor policy and an empty lease directory. rig-run stops at its test hook (RIG_RUN_TEST_HOLD_AT_LOCK)
# or at a refusal, before anything touches Lume. The real leases, lock, HOLD and VMs are never read or written.
# Prints PASS/FAIL per case; exit 1 on a FAIL.
#   RIG_RUN=<path> tests another copy of rig-run; LR_CORE=<path> another lr-lease-core.mjs (default: beside rig-run's
#   long-run tree, else ~/.long-run/bin).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
RR_SRC=${RIG_RUN:-$HERE/rig-run}
CORE=${LR_CORE:-$HERE/../../bin/lr-lease-core.mjs}
[ -f "$CORE" ] || CORE=~/.long-run/bin/lr-lease-core.mjs
PY=/opt/homebrew/opt/python@3.14/bin/python3.14
T=$(mktemp -d /tmp/rig-managed.XXXXXX)
H=$T/home
L=$H/.long-run
mkdir -p "$L/bin" "$L/rig/bin" "$L/locks" "$L/leases" "$T/job"
cat > "$L/bin/lr-lease-shim.mjs" <<SHIM
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { acquire, release, reap, oblige, readLeases, readPolicy, machineReaders } from '$CORE';
const root = path.join(process.env.HOME, '.long-run'), dir = path.join(root, 'leases');
const readers = { ...machineReaders(root), diskGB: () => 1000, swapGB: () => 1000, pressure: () => 'normal', quietUntil: () => 0 };
const [mode, verb, ...rest] = process.argv.slice(2);
const opt = name => rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined;
if (mode === 'reap') { reap(dir, readers, opt('--run')); process.exit(0); }
if (verb === 'release') { release(dir, rest[0]); process.exit(0); }
if (verb === 'status') {
  // STATUS_FAULT (a file): its content picks a failure, "exit" or "malformed".
  const fault = process.env.STATUS_FAULT && existsSync(process.env.STATUS_FAULT) ? readFileSync(process.env.STATUS_FAULT, 'utf8').trim() : '';
  if (fault === 'exit') process.exit(1);
  const leases = readLeases(dir);
  if (fault === 'malformed') { console.log('Readings (shim)'); console.log('Leases: 1'); console.log('{not json'); process.exit(0); }
  console.log('Readings (shim)'); console.log('Leases: ' + leases.length);
  for (const lease of leases) console.log(JSON.stringify(lease));
  process.exit(0);
}
if (verb === 'oblige') {
  const r = oblige(dir, rest[0], opt('--run'), opt('--attempt'), opt('--cleanup-token-sha256'));
  if (r.reason) { console.log('refused: ' + r.reason); process.exit(75); }
  console.log(rest[0]); process.exit(0);
}
if (verb !== 'acquire') { console.log('refused: shim supports acquire, release, status, oblige and reap'); process.exit(75); }
const cleanup = opt('--cleanup-attempt') ? { attempt: opt('--cleanup-attempt'), tokenSha256: opt('--cleanup-token-sha256') } : undefined;
const result = acquire(dir, readPolicy(path.join(root, 'lease-policy.json')), readers, { run: opt('--run'), kind: opt('--kind'),
  estMemGB: Number(opt('--est-mem')), estDiskGB: Number(opt('--est-disk')), ttlMinutes: Number(opt('--ttl') ?? 15),
  ownerPid: Number(opt('--owner-pid')), ...(cleanup ? { cleanup } : {}) });
if (result.reason) { console.log('refused: ' + result.reason); process.exit(75); }
console.log(result.lease.id);
SHIM
printf '%s\n' '#!/bin/sh' 'exec node "$(dirname "$0")/lr-lease-shim.mjs" lease "$@"' > "$L/bin/lr-lease"
printf '%s\n' '#!/bin/sh' 'exec node "$(dirname "$0")/lr-lease-shim.mjs" reap "$@"' > "$L/bin/lr-reap"
chmod +x "$L/bin/lr-lease" "$L/bin/lr-reap"
cp "$RR_SRC" "$L/rig/bin/rig-run"; cp "$HERE/lead-hold" "$L/rig/bin/"
"$PY" - "$HERE/../../lease-policy.json" "$L/lease-policy.json" <<'EOF'
import json, sys
policy = json.load(open(sys.argv[1]))
for rule in policy["kinds"].values():
    rule["diskFloorGB"] = 0
policy["kinds"]["heavy"]["maxCount"] = policy["kinds"]["vm"]["maxCount"] = 1
json.dump(policy, open(sys.argv[2], "w"))
EOF
printf '%s\n' '#!/bin/bash' '# rig-timeout-seconds: 60' 'exit 0' > "$T/job/job.sh"
# Stands in for Caret's register.py: logs each registration; refuses while $T/refuse exists.
printf '%s\n' '#!/bin/sh' "echo \"\$*\" >> $T/register.log" "[ -e $T/refuse ] && exit 1" 'exit 0' > "$T/register"
chmod +x "$T/register"
LOCK=$L/locks/heavy.lock
LR=$L/bin/lr-lease
ATTEMPT=attempt-0123456789abcdef
DIGEST=$(printf '%s' synthetic-token-not-a-credential | shasum -a 256 | cut -d' ' -f1)
export HOME=$H RIG_HOLD_FILE=$T/no-hold STATUS_FAULT=$T/status-fault
fails=0 n=0
ok() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got '$2', want '$3'"; fails=$((fails+1)); fi; }
lock_free() { /usr/bin/lockf -k -t 0 "$LOCK" true 2>/dev/null && echo free || echo held; }
wait_for() { local i; for i in $(seq 1 100); do [ -e "$1" ] && return 0; sleep 0.1; done; return 1; }
field() { "$LR" status | "$PY" -c 'import json, sys
want, key = sys.argv[1], sys.argv[2]
for line in sys.stdin:
    if line.startswith("{"):
        r = json.loads(line)
        if eval(want, {}, {"r": r}): print(r.get(key))' "$1" "$2"; }
count() { "$LR" status | grep -c '^{' ; }
cleanup() { [ -n "${KEEP:-}" ] && { echo "kept $T"; return; }; [ -n "${P:-}" ] && kill "$P" 2>/dev/null; wait 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
reset() { rm -f "$L"/leases/*.json "$T/register.log" "$T/refuse" "$T/hold" "$T/status-fault"; }
# The queue's lease for the job: owned by this shell (the "runner"), run heavy-job-queue, then obliged to the attempt.
queue_lease() { "$LR" acquire --run heavy-job-queue --kind heavy --est-mem 0 --est-disk 0 --owner-pid $$; }
managed() { env RIG_HEAVY_LEASE_ID="$1" RIG_RUN_MANAGED=1 CARET_HEAVY_REGISTER="$T/register" CARET_HEAVY_ATTEMPT="$ATTEMPT" \
  CARET_HEAVY_TOKEN_SHA256="$DIGEST" RIG_RUN_TEST_HOLD_AT_LOCK="${HOOK:-$T/hold}" "$L/rig/bin/rig-run" "$T/job" "${@:2}"; }
# Cases that expect a refusal point the hook where it cannot be created, so a rig-run that wrongly gets through exits 0
# at the hook instead of waiting there.
NOHOOK=$T/no-such-dir/hold

# 1. An obliged handed lease: no heavy lease of rig-run's own, a cleanup-required vm lease, the VM registered before
#    anything is cloned; at exit the handed lease and the vm lease both stay (the job's custody settles them).
reset
Q=$(queue_lease); "$LR" oblige "$Q" --run heavy-job-queue --attempt "$ATTEMPT" --cleanup-token-sha256 "$DIGEST" >/dev/null
managed "$Q" > "$T/out1" 2>&1 & P=$!
if wait_for "$T/hold"; then
  RP=$(ls "$L/rig/runs" | sed -n 's/^rig-run-//p')  # rig-run's own pid ($P is the subshell running managed)
  ok "handed: two leases while running" "$(count)" 2
  ok "handed: rig-run took no heavy lease" "$(field "r['kind'] == 'heavy' and r['ownerPid'] == $RP" id)" ""
  ok "handed: the vm lease is rig-run's" "$(field "r['kind'] == 'vm'" ownerPid)" "$RP"
  ok "handed: vm lease is cleanup-required" "$(field "r['kind'] == 'vm'" cleanupRequired)" True
  ok "handed: vm lease names the attempt" "$(field "r['kind'] == 'vm'" attempt)" "$ATTEMPT"
  ok "handed: VM registered before the clone step" "$(cat "$T/register.log" 2>/dev/null)" "vm rig-run-$RP"
  ok "handed: heavy.id not written" "$(ls "$L/rig/runs/rig-run-$RP/heavy.id" 2>/dev/null)" ""
  ok "handed: heavy.lock held" "$(lock_free)" held
else
  ok "handed: reached the hold" "$(cat "$T/out1")" "the hook"
fi
rm -f "$T/hold"; wait "$P"; rc=$?; P=""
ok "handed: exit 0 at the hook" "$rc" 0
ok "handed: the handed lease is still active" "$(field "r['id'] == '$Q'" state)" None
ok "handed: the vm lease is left for custody" "$(field "r['kind'] == 'vm'" attempt)" "$ATTEMPT"
ok "handed: heavy.lock free after exit" "$(lock_free)" free
ok "handed: rig.log says the vm lease was left" "$(cat "$T"/job/runs/*/rig.log | grep -c "left to the job's custody")" 1

# 2-4. A handed lease that is not usable: refused (75) before any vm lease or registration.
for case in plain other-attempt missing; do
  reset
  Q=$(queue_lease)
  case $case in
    other-attempt) "$LR" oblige "$Q" --run heavy-job-queue --attempt attempt-other --cleanup-token-sha256 "$DIGEST" >/dev/null ;;
    missing) "$LR" release "$Q"; Q=00000000-0000-4000-8000-000000000000 ;;
  esac
  HOOK=$NOHOOK managed "$Q" > "$T/out" 2>&1; rc=$?
  ok "$case: refused" "$rc" 75
  ok "$case: no vm lease" "$(field "r['kind'] == 'vm'" id)" ""
  ok "$case: nothing registered" "$(cat "$T/register.log" 2>/dev/null)" ""
  ok "$case: reason logged" "$(grep -c 'handed lease' "$T/out")" 1
done

# 4b. A lease list that cannot be read refuses too: a failed or malformed status never admits.
for fault in exit malformed; do
  reset
  Q=$(queue_lease); "$LR" oblige "$Q" --run heavy-job-queue --attempt "$ATTEMPT" --cleanup-token-sha256 "$DIGEST" >/dev/null
  echo "$fault" > "$T/status-fault"
  HOOK=$NOHOOK managed "$Q" > "$T/out" 2>&1; rc=$?
  rm -f "$T/status-fault"
  ok "status $fault: refused" "$rc" 75
  ok "status $fault: no vm lease" "$(field "r['kind'] == 'vm'" id)" ""
  ok "status $fault: nothing registered" "$(cat "$T/register.log" 2>/dev/null)" ""
done

# 5. Managed mode without its custody variables is a usage error.
reset
RIG_RUN_MANAGED=1 RIG_RUN_TEST_HOLD_AT_LOCK="$NOHOOK" "$L/rig/bin/rig-run" "$T/job" > "$T/out" 2>&1; rc=$?
ok "managed without custody: usage error" "$rc" 64
ok "managed without custody: no lease" "$(count)" 0

# 6. A refused registration stops the run before the clone step (70); the vm lease stays for the job's custody.
reset
Q=$(queue_lease); "$LR" oblige "$Q" --run heavy-job-queue --attempt "$ATTEMPT" --cleanup-token-sha256 "$DIGEST" >/dev/null
: > "$T/refuse"
HOOK=$NOHOOK managed "$Q" > "$T/out" 2>&1; rc=$?
ok "refused registration: exit 70" "$rc" 70
ok "refused registration: the hook was never reached" "$(grep -c 'registered rig-run' "$T"/job/runs/*/rig.log | tail -1 | sed 's/.*://')" 0
ok "refused registration: vm lease left for custody" "$(field "r['kind'] == 'vm'" attempt)" "$ATTEMPT"
ok "refused registration: heavy.lock free" "$(lock_free)" free

echo "$((n - fails))/$n passed"
[ "$fails" -eq 0 ]
