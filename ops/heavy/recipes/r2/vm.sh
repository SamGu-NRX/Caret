#!/bin/bash
# Runs one staged R2 VM job through R2's feeder (run.sh), which starts rig-run; rig-run takes its own heavy and vm
# leases and heavy.lock. Writes the run's spend control from the host's Jev ledger now, as R2's coordinate.py did, copies
# the run's evidence into OUT and checks it: zero wrong rows, the pinned revision, the plan's H11 options, a CLEAN leak
# check, guest spend within the allowance left. Profile caret-vm.
#   vm.sh h11|h14 JOB-DIR WAIT ALLOWANCE PRIOR-SPEND CONFIG|-
set -u
. "$CARET_HEAVY_RECIPES/lib.sh"
H=${1:?usage: vm.sh h11|h14 JOB-DIR WAIT ALLOWANCE PRIOR-SPEND CONFIG|-}
JOB=${2:?job dir}; WAIT=${3:?wait}; ALLOW=${4:?allowance}; PRIOR=${5:?prior spend}; CONFIG=${6:?config or -}
case "$H" in h11|h14) ;; *) echo "vm: harness must be h11 or h14" >&2; exit 64 ;; esac
CONTROL="$JOB/payload/spend-control.json"
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
check prepare spend-control --log "$OUT/spend-control.log" --exit $? || finish
cp "$CONTROL" "$OUT/spend-control.json"
CAP=$(py -c 'import json, sys; print(json.load(open(sys.argv[1]))["capUsd"])' "$CONTROL")

args=(--job "$JOB" --harness "$H" --wait "$WAIT")
[ "$CONFIG" = - ] || args+=(--config "$CONFIG")
CARET_JEV_DAILY_CAP="$CAP" /bin/bash "$CARET_HEAVY_RECIPES/r2/run.sh" "${args[@]}" &
feeder=$!
# A TERM here (the supervisor's, after rig-run itself was stopped) goes on to the feeder, which leak-scans what came back.
trap 'kill -TERM "$feeder" 2>/dev/null' TERM INT HUP
wait "$feeder"; rc=$?
while kill -0 "$feeder" 2>/dev/null; do wait "$feeder"; rc=$?; done
trap - TERM INT HUP
rm -f "$CONTROL"

RUN=$(cat "$OUT/rig-run-dir" 2>/dev/null)
mkdir -p "$OUT/rig-run/out"
if [ -n "$RUN" ] && [ -d "$RUN" ]; then
  for f in rig.json rig.log out/results.json out/result.json out/leak-check.txt out/job.log; do
    [ -f "$RUN/$f" ] && cp "$RUN/$f" "$OUT/rig-run/$f"
  done
  [ -d "$RUN/out/jev-spend" ] && cp -R "$RUN/out/jev-spend" "$OUT/rig-run/out/"
fi
LIMIT=$(py -c 'import sys; print("%.6f" % (float(sys.argv[1]) - float(sys.argv[2])))' "$ALLOW" "$PRIOR")
check r2 --harness "$H" --run "$OUT/rig-run" --rev "$CARET_HEAVY_REV" --exit "$rc" --spend-limit "$LIMIT" \
  ${H11_OPTIONS:+--options "$H11_OPTIONS"}
finish
