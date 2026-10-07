#!/bin/bash
# H14 (from H13's stage.sh): adds the harness's tools, the F1 fixture site and an empty replay file to the payload
# build.sh made, and puts job.sh, tcc.txt and display in the job directory (harness/vm). Light; no lease.
#
# The site is the commit's own fixtures/web-form/public, taken from build.sh's export (checked to be the payload's commit)
# and made read-only. h14.py serves it with http.server, which answers no POST: probe.js's /tasks/oracle/* posts fail
# harmlessly, and a /tasks/submit would show in the server's log (row zero-submits).
#
# The replay file is empty: --ghost-replay keeps the host from loading the ghost model (it does not fit in the guest's
# 4 GB), and nothing in H14 types into a field for a ghost.
# Ported to ops/heavy: WORK replaces the fixed evidence path; the harness files come from beside this script.
#   stage.sh WORK
set -euo pipefail
HA=${1:?usage: stage.sh WORK}; J="$HA/vm"; P="$J/payload"
H=$(cd "$(dirname "$0")" && pwd)
SITE="$HA/src/fixtures/web-form/public"
[ -d "$P/acc/Caret.app" ] || { echo "no bundles in $P; run build.sh first"; exit 1; }
[ -d "$P/apps/Google Chrome for Testing.app" ] || { echo "no Chrome for Testing in $P; run build.sh first"; exit 1; }
[ "$(cat "$HA/src/.REV" 2>/dev/null)" = "$(cat "$P/REV")" ] || { echo "stage.sh: the export in $HA/src is not the payload's commit $(cat "$P/REV"); run build.sh"; exit 1; }
for f in wizard-3.html tasks.css options.js pages.js probe.js; do
  [ -f "$SITE/tasks/$f" ] || { echo "stage.sh: no $SITE/tasks/$f"; exit 1; }
done

rm -rf "$P/tools" "$P/site" "$P/ghost"; mkdir -p "$P/tools" "$P/ghost"
for t in h14-key q2-ax winlist; do swiftc -O "$H/tools/$t.swift" -o "$P/tools/$t"; done
cp "$H/tools/h14.py" "$H/tools/cdp.py" "$H/../leakscan.py" "$P/tools/"
ditto "$SITE" "$P/site"
find "$P/site" -type f -exec chmod a-w {} +
echo '{"entries": []}' > "$P/ghost/replay.json"

cp "$H/job.sh" "$H/tcc.txt" "$J/"; echo 1920x1200 > "$J/display"
python3 -m py_compile "$P/tools/h14.py" "$P/tools/cdp.py"; bash -n "$J/job.sh"
rm -rf "$P/tools/__pycache__"
echo "staged $(cat "$P/REV"): site $(find "$P/site" -type f | wc -l | tr -d ' ') files, empty replay"
