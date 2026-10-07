#!/bin/bash
# Stands in for rig-run in the light VM-path tests: the state rig-run and rig-stop share, with no Lume and no VM. Takes
# rig's leases through the real lr-lease (the test's HOME), records them in ~/.long-run/rig/runs/rig-run-$$ as rig-run
# does, and makes a clone directory ~/.lume/rig-run-$$. Then waits.
#   clean: on TERM, takes SECONDS to "stop the VM", deletes the clone, releases both leases, exits 143 (rig-run's trap).
#   crash: on TERM, dies by SIGKILL with nothing cleaned up, like a rig-run killed mid-job.
#   managed: rig-run's handed lease and managed mode (RIG_HEAVY_LEASE_ID, RIG_RUN_MANAGED). Takes no heavy lease, takes
#     its vm lease cleanup-required for CARET_HEAVY_ATTEMPT, registers the VM with the job's recovery owner before the
#     clone exists, then runs a stand-in `lume run rig-run-$$`. On TERM, stops it, takes SECONDS, deletes the clone and
#     exits 143, leaving the vm lease to the job's custody.
# The supervisor matches it as rig-run by argv [/bin/bash, <its plan's rig_run path>].
set -u
MODE=${1:?clean|crash|managed}
SECONDS_TO_CLEAN=${2:?seconds}
L=~/.long-run/bin/lr-lease
STATE=~/.long-run/rig/runs/rig-run-$$
CLONE=~/.lume/rig-run-$$
mkdir -p "$STATE"
echo $$ > "$STATE/owner.pid"
ps -o lstart= -p $$ > "$STATE/owner.start"
if [ "$MODE" = managed ]; then
  : "${RIG_HEAVY_LEASE_ID:?}" "${RIG_RUN_MANAGED:?}" "${CARET_HEAVY_ATTEMPT:?}" "${CARET_HEAVY_TOKEN_SHA256:?}"
  VMID=$("$L" acquire --run rig --kind vm --est-mem 0 --est-disk 0 --ttl 30 --owner-pid $$ \
    --cleanup-attempt "$CARET_HEAVY_ATTEMPT" --cleanup-token-sha256 "$CARET_HEAVY_TOKEN_SHA256") || exit 75
  echo "$VMID" > "$STATE/lease.id"
  $CARET_HEAVY_REGISTER vm "rig-run-$$" || exit 70
  mkdir -p "$CLONE"; echo "disk image stand-in" > "$CLONE/disk.img"
  printf '%s\n' '#!/bin/bash' "trap 'exit 0' TERM" 'sleep 600 & wait $!' > "$STATE/lume"
  chmod +x "$STATE/lume"
  "$STATE/lume" run "rig-run-$$" & LUME=$!
  echo "$LUME" > "$STATE/lume.pid"
  trap 'kill "$LUME"; wait "$LUME"; sleep "$SECONDS_TO_CLEAN"; rm -rf "$CLONE" "$STATE"; exit 143' TERM
  sleep 600 & wait $!
  exit 0
fi
mkdir -p "$CLONE"
echo "disk image stand-in" > "$CLONE/disk.img"
HEAVY=$("$L" acquire --run rig --kind heavy --est-mem 0 --est-disk 0 --ttl 30 --owner-pid $$) || exit 75
VMID=$("$L" acquire --run rig --kind vm --est-mem 0 --est-disk 0 --ttl 30 --owner-pid $$) || { "$L" release "$HEAVY"; exit 75; }
echo "$VMID" > "$STATE/lease.id"; echo "$HEAVY" > "$STATE/heavy.id"
cleanup() { sleep "$SECONDS_TO_CLEAN"; rm -rf "$CLONE"; "$L" release "$VMID"; "$L" release "$HEAVY"; rm -rf "$STATE"; exit 143; }
if [ "$MODE" = clean ]; then trap cleanup TERM; else trap 'kill -KILL $$' TERM; fi
sleep 600 & wait $!
