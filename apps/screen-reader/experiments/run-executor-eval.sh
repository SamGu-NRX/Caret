#!/bin/bash
# The executor on caret-fixture's executor window, with the real reader and live Jev for ambiguous
# targets. The helper runs inside the evaluation script on its own socket; the reader reads only the
# fixture's pid and may act only there. The calendar is the in-memory fake.
#   run-executor-eval.sh OUTDIR [RUNS] [FAULT_RUNS]
# Needs CARET_ENV_FILE pointing at a .env with TYPESAFE_API_KEY.
set -euo pipefail
OUT=$1
RUNS=${2:-20}
FAULT_RUNS=${3:-10}
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${CARET_ENV_FILE:?set CARET_ENV_FILE to the .env holding TYPESAFE_API_KEY}"
mkdir -p "$OUT"
cd "$HERE/../../../helper"
exec node scripts/executor-eval.ts --bin "$HERE/../.build/debug" --out "$OUT" --runs "$RUNS" --fault-runs "$FAULT_RUNS"
