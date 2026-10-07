#!/bin/bash
# The deliberate cancellation proof (profile caret-vm): boots a real rig VM on the sealed job (default the rig's smoke
# job), cancels its own rig-run once the guest is ready, then proves what is left. OUT/proof.json's checks:
#   rig_run_cancelled    rig-run ended by the cancel: exit 143, its rig.json says 143
#   clone_gone           no ~/.lume/rig-run-<pid>
#   lume_gone            no process of this user runs `lume run rig-run-<pid>`
#   virtualization_gone  every Virtualization process the VM started (rig-run's vz.pids, and any that appeared since
#                        the recipe started) exited within the grace; they are waited for, never signalled
#   vm_lease_released / vm_lease_left_for_custody
#                        without managed mode rig-run releases its vm lease; in managed mode (the supervisor hands it
#                        the queue's lease) it leaves it listed, cleanup-required for this attempt, and the job's
#                        conclusion acknowledges it with the token (outcome.json, recovery journal)
# The leases' settlement is the supervisor's: a CLEAN conclusion, and no lease of the attempt in `lr-lease status`
# afterwards. 14 when no guest becomes ready, 11 when a check fails.
#   vm-cancel-proof.sh RIG-WAIT BOOT-TIMEOUT VZ-GRACE
set -u
. "$CARET_HEAVY_RECIPES/lib.sh"
WAIT=${1:?usage: vm-cancel-proof.sh RIG-WAIT BOOT-TIMEOUT VZ-GRACE}; BOOT=${2:?boot timeout}; GRACE=${3:?vz grace}
R="$HOME/.long-run/rig"
JOB="$IN/vm-job"
VZ='com.apple.Virtualization.VirtualMachine'
REQUIRED=(boot cancel proof)
pgrep -f "$VZ" | sort > "$OUT/vz-before.txt"
date +%s > "$OUT/started"
ID_FILE="$OUT/.rig-run-id"
# By its absolute path, so rig-run does not re-exec and its pid names the clone (rig-run-<pid>).
RIG_RUN_ID_FILE="$ID_FILE" "$R/bin/rig-run" "$JOB" --wait "$WAIT" > "$OUT/rig-run.log" 2>&1 &
RP=$!
VM="rig-run-$RP"
echo "$VM" > "$OUT/vm-name"
stop_rig() { kill -TERM "$RP" 2>/dev/null; while kill -0 "$RP" 2>/dev/null; do wait "$RP"; done; }
# A cancellation of this job stops rig-run too, and its trap does rig-run's own cleanup.
trap 'stop_rig; exit 143' TERM INT HUP

booted="" waited=0
while kill -0 "$RP" 2>/dev/null; do
  run=$(cat "$ID_FILE" 2>/dev/null)
  if [ -n "$run" ] && grep -q 'guest ready at' "$run/rig.log" 2>/dev/null; then booted=1; break; fi
  [ "$waited" -ge $((WAIT + BOOT)) ] && break
  sleep 1 & wait $!
  waited=$((waited + 1))
done
# What rig-run recorded while the VM ran; its cleanup deletes the state directory.
mkdir -p "$OUT/state-before"
cp "$R/runs/$VM/"{lume.pid,vz.pids,lease.id,heavy.id} "$OUT/state-before/" 2>/dev/null
if [ -z "$booted" ]; then
  stop_rig
  cp "$(cat "$ID_FILE" 2>/dev/null)/rig.log" "$OUT/rig.log" 2>/dev/null
  echo "no guest became ready within the lease wait plus ${BOOT}s" >> "$OUT/rig-run.log"
  check prepare boot --log "$OUT/rig-run.log" --exit 1
  finish
fi
check prepare boot --log "$OUT/rig-run.log" --exit 0

kill -TERM "$RP"
while kill -0 "$RP" 2>/dev/null; do wait "$RP"; done
wait "$RP"; rc=$?
echo "$rc" > "$OUT/rig-run.exit"
run=$(cat "$ID_FILE")
cp "$run/rig.log" "$run/rig.json" "$OUT/" 2>/dev/null
check prepare cancel --log "$OUT/rig-run.log" --exit 0

py - "$OUT" "$VM" "$rc" "$GRACE" "$VZ" "${RIG_RUN_MANAGED:-}" "${CARET_HEAVY_ATTEMPT:-}" "$HOME/.long-run/bin/lr-lease" \
  > "$OUT/proof.log" 2>&1 <<'PY'
import json, os, subprocess, sys, time
out, vm, rc, grace, vz, managed, attempt, lr_lease = sys.argv[1:]

def read(name):
    try:
        with open(os.path.join(out, name)) as fh:
            return fh.read().split()
    except OSError:
        return []

def processes():
    listing = subprocess.run(["ps", "-axww", "-o", "pid=,command="], capture_output=True, text=True, check=True).stdout
    return [(int(line.split(None, 1)[0]), line.split(None, 1)[1] if len(line.split(None, 1)) > 1 else "")
            for line in listing.splitlines() if line.strip()]

def lume_runs(command):
    argv = command.split()
    for at in (0, 1):
        if len(argv) >= at + 3 and os.path.basename(argv[at]) == "lume":
            return argv[at + 1] == "run" and argv[at + 2] == vm
    return False

checks, details = {}, {}
try:
    with open(os.path.join(out, "rig.json")) as fh:
        rig_exit = json.load(fh).get("exit")
except (OSError, ValueError):
    rig_exit = None
details["rig_run_exit"], details["rig_json_exit"] = int(rc), rig_exit
checks["rig_run_cancelled"] = int(rc) == 143 and rig_exit == 143
clone = os.path.expanduser("~/.lume/" + vm)
checks["clone_gone"] = not os.path.lexists(clone)
details["clone"] = clone
before = set(read("vz-before.txt"))
recorded = set(read("state-before/vz.pids"))
deadline = time.monotonic() + int(grace)
while True:
    procs = processes()
    lume = [p for p, c in procs if lume_runs(c)]
    vz_alive = [p for p, c in procs if vz in c.split(" ")[0] and (str(p) in recorded or str(p) not in before)]
    if not vz_alive or time.monotonic() >= deadline:
        break
    time.sleep(1)
details.update(lume_left=lume, virtualization_left=vz_alive, virtualization_recorded=sorted(recorded))
checks["lume_gone"] = not lume
checks["virtualization_gone"] = not vz_alive
lease_id = (read("state-before/lease.id") or [None])[0]
details["vm_lease"] = lease_id
status = subprocess.run([lr_lease, "status"], capture_output=True, text=True)
leases = [json.loads(line) for line in status.stdout.splitlines() if line.startswith("{")] if status.returncode == 0 else None
listed = None if leases is None or lease_id is None else next((l for l in leases if l.get("id") == lease_id), None)
details["vm_lease_listed"] = listed
if managed:
    checks["vm_lease_left_for_custody"] = bool(listed and listed.get("cleanupRequired") and listed.get("attempt") == attempt)
else:
    checks["vm_lease_released"] = leases is not None and lease_id is not None and listed is None
json.dump({"vm": vm, "checks": checks, "details": details}, open(os.path.join(out, "proof.json"), "w"), indent=1)
print(json.dumps(checks))
PY
check vm-proof --exit $?
finish
