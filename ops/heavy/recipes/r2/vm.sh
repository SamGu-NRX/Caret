#!/bin/bash
# Runs one staged R2 VM job through R2's feeder (run.sh), which starts rig-run; rig-run takes its own heavy and vm
# leases and heavy.lock. The job runs the sealed copy of the staged job ($CARET_HEAVY_INPUTS/vm-job). Writes the run's
# configuration and spend control into the sealed payload (the two files the manifest leaves out), the spend control
# from the host's Jev ledger now, as R2's coordinate.py did. Copies the run's evidence into OUT only after the feeder's
# leak scan passed, then checks it: zero wrong rows, the pinned revision, the plan's H11 or RAE options and rows, a CLEAN
# guest leak check (NO KEYS for a RAE probe), guest spend within the allowance left. Profile caret-vm.
#   vm.sh h11|h14|rae WAIT ALLOWANCE PRIOR-SPEND CONFIG|-
set -u
. "$CARET_HEAVY_RECIPES/lib.sh"
H=${1:?usage: vm.sh h11|h14|rae WAIT ALLOWANCE PRIOR-SPEND CONFIG|-}
WAIT=${2:?wait}; ALLOW=${3:?allowance}; PRIOR=${4:?prior spend}; CONFIG=${5:?config or -}
case "$H" in h11|h14|rae) ;; *) echo "vm: harness must be h11, h14 or rae" >&2; exit 64 ;; esac
REQUIRED=(spend-control "$H")
JOB="$IN/vm-job"
CONTROL="$JOB/payload/spend-control.json"
chmod u+w "$JOB/payload"
[ "$CONFIG" = - ] || printf '%s\n' "$CONFIG" > "$JOB/payload/CONFIG"
py -c 'import datetime, json, sys
from pathlib import Path
allow, prior = float(sys.argv[2]), float(sys.argv[3])
day = datetime.date.today().isoformat()
ledger = Path.home() / "Library/Application Support/CaretV2/jev-spend" / (day + ".ndjson")
rows = [json.loads(x) for x in ledger.read_text().splitlines() if x] if ledger.exists() else []
total = sum(r["usd"] for r in rows)
controls = {"hostDay": day, "hostLedger": str(ledger), "hostLedgerLines": len(rows), "hostTotalUsd": total,
            "priorR2SpendUsd": prior, "seedUsd": total + prior, "capUsd": total + allow, "remainingUsd": allow - prior}
Path(sys.argv[1]).write_text(json.dumps(controls, indent=2) + "\n")' "$CONTROL" "$ALLOW" "$PRIOR" > "$OUT/spend-control.log" 2>&1
rc=$?
chmod a-w "$JOB/payload"
check prepare spend-control --log "$OUT/spend-control.log" --exit $rc || finish
cp "$CONTROL" "$OUT/spend-control.json"
CAP=$(py -c 'import json, sys; print(json.load(open(sys.argv[1]))["capUsd"])' "$CONTROL")

args=(--job "$JOB" --harness "$H" --wait "$WAIT")
[ "$CONFIG" = - ] || args+=(--config "$CONFIG")
CARET_JEV_DAILY_CAP="$CAP" /bin/bash "$CARET_HEAVY_RECIPES/r2/run.sh" "${args[@]}" &
feeder=$!
# A TERM here goes on to the feeder, which stops rig-run and still leak-scans what came back before it exits.
trap 'kill -TERM "$feeder" 2>/dev/null' TERM INT HUP
wait "$feeder"; rc=$?
while kill -0 "$feeder" 2>/dev/null; do wait "$feeder"; rc=$?; done
trap - TERM INT HUP

RUN=$(cat "$OUT/rig-run-dir" 2>/dev/null)
mkdir -p "$OUT/rig-run/out"
# Published only when the feeder recorded a clean host leak scan of this exact run directory.
if [ -n "$RUN" ] && [ -d "$RUN" ] && [ "$(cat "$OUT/rig-run-scanned" 2>/dev/null)" = "$RUN" ]; then
  for f in rig.json rig.log out/results.json out/result.json out/leak-check.txt out/job.log out/scoreboard.md \
           out/rows.json; do
    [ -f "$RUN/$f" ] && cp "$RUN/$f" "$OUT/rig-run/$f"
  done
  [ -d "$RUN/out/jev-spend" ] && cp -R "$RUN/out/jev-spend" "$OUT/rig-run/out/"
fi
LIMIT=$(py -c 'import sys; print("%.6f" % (float(sys.argv[1]) - float(sys.argv[2])))' "$ALLOW" "$PRIOR")
check r2 --harness "$H" --run "$OUT/rig-run" --rev "$CARET_HEAVY_REV" --exit "$rc" --spend-limit "$LIMIT" \
  ${H11_OPTIONS:+--options "$H11_OPTIONS"} ${RAE_OPTIONS:+--options "$RAE_OPTIONS"}
finish
