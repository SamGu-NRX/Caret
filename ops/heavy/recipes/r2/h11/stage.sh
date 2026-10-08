#!/bin/bash
# H11 (from Q2/H10): copies the harness's own tools, pages and documents into the payload build.sh made, plus the
# repo's task pages and their oracle from build.sh's export of the same commit. Light; no lease.
#
# The guest can't see this shell's environment (rig-run starts job.sh from a fixed plist), so the run's options are
# written to payload/h11-options.json here. Ported to ops/heavy: the options are arguments, so the job's plan records
# them (they were environment variables nothing recorded), and WORK replaces the fixed evidence path.
#   stage.sh WORK [--pages LIST] [--sources S] [--next-page 0|1] [--scenarios LIST]   (defaults in brackets)
#   --pages      [wizard-1]   comma-separated task pages to run page_task on: wizard-1, reveal
#   --sources    [note]       note: one TextEdit window with the person's note; all: also their email and memory
#                             entries as two more TextEdit documents
#   --next-page  [0]          1: after wizard-1, the harness presses Next and expects the goal to carry (P3)
#   --scenarios  [page_task]  add h10 to also run H10's browser fills and Asks (q2_site.py's pages)
set -euo pipefail
Q=${1:?usage: stage.sh WORK [options]}; shift
H=$(cd "$(dirname "$0")" && pwd); P="$Q/vm/payload"; S="$Q/src"
pages=wizard-1; sources=note; next=0; scen=page_task
while [ $# -gt 0 ]; do
  case "$1" in
    --pages) pages=${2:?}; shift 2 ;; --sources) sources=${2:?}; shift 2 ;;
    --next-page) next=${2:?}; shift 2 ;; --scenarios) scen=${2:?}; shift 2 ;;
    *) echo "stage.sh: unknown option $1"; exit 64 ;;
  esac
done
[ -d "$P/acc/Caret.app" ] || { echo "no bundles in $P; run build.sh first"; exit 1; }
[ -f "$S/fixtures/web-form/server.ts" ] || { echo "no export at $S (fixtures/web-form/server.ts); run build.sh first"; exit 1; }
[ "$(cat "$S/.REV")" = "$(cat "$P/REV")" ] || { echo "the export ($(cat "$S/.REV")) is not the payload's commit ($(cat "$P/REV")); run build.sh again"; exit 1; }
rm -rf "$P/tools" "$P/site" "$P/docs" "$P/ghost" "$P/fixture"; mkdir -p "$P/tools" "$P/ghost" "$P/fixture/tasks"
for t in q2-key q2-ax h10-ax; do swiftc -O "$H/tools/$t.swift" -o "$P/tools/$t"; done
# Calendar and native fixture scenarios are not part of R2.
cp "$H/hostq.py" "$H/q2.py" "$H/q2_site.py" "$H/../leakscan.py" "$P/tools/"
ditto "$H/site" "$P/site"; ditto "$H/docs" "$P/docs"
echo '{"entries": []}' > "$P/ghost/replay.json"

# The task pages and their oracle, at the payload's commit. server.ts needs only Node's own modules and the prebuilt
# public/tasks/tasks.bundle.js, so no node_modules; the guest runs it with the bundle's own Node (type stripping).
F="$S/fixtures/web-form"
cp "$F/server.ts" "$F/oracle.ts" "$F/package.json" "$P/fixture/"
cp "$F/tasks/site.ts" "$P/fixture/tasks/"
ditto "$F/tasks/expect" "$P/fixture/tasks/expect"
ditto "$F/public" "$P/fixture/public"
cp "$H/h11_site.ts" "$P/fixture/"

for p in ${pages//,/ }; do
  case "$p" in wizard-1|reveal) [ -f "$P/fixture/tasks/expect/$p.json" ] || { echo "--pages: no tasks/expect/$p.json at this commit"; exit 64; } ;;
  *) echo "--pages: $p is not one of wizard-1, reveal"; exit 64 ;; esac
done
case "$sources" in note|all) ;; *) echo "--sources must be note or all, not $sources"; exit 64 ;; esac
case "$next" in 0|1) ;; *) echo "--next-page must be 0 or 1, not $next"; exit 64 ;; esac
for s in ${scen//,/ }; do case "$s" in page_task|h10) ;; *) echo "--scenarios: $s is not page_task or h10"; exit 64 ;; esac; done
python3 -c 'import json,sys; print(json.dumps({"pages": [x for x in sys.argv[1].split(",") if x], "sources": sys.argv[2], "nextPage": sys.argv[3] == "1", "scenarios": [x for x in sys.argv[4].split(",") if x]}))' \
  "$pages" "$sources" "$next" "$scen" > "$P/h11-options.json"

cp "$H/job.sh" "$H/tcc.txt" "$Q/vm/"; echo 1920x1200 > "$Q/vm/display"
# py_compile writes bytecode even with -B, which fails at the job's /var/empty cache prefix.
python3 -c 'import sys
for path in sys.argv[1:]:
    with open(path, "rb") as source: compile(source.read(), path, "exec")' "$P/tools/q2.py" "$P/tools/q2_site.py"
bash -n "$Q/vm/job.sh"
echo "staged $(cat "$P/REV") options $(cat "$P/h11-options.json")"
