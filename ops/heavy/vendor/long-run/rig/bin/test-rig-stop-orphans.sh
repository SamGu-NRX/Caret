#!/bin/bash
# Isolated tests of `rig-stop --orphans` owner classes. Each case builds its own state dir and clone
# dir under a temp root (RIG_STOP_TEST_ROOT) with no leases (RIG_STOP_LEASE_STATUS=/dev/null), so
# no real clone, lease or other builder's run is seen. Prints PASS/FAIL per case; exit 1 on a FAIL.
set -u
S=${RIG_STOP:-~/.long-run/rig/bin/rig-stop}
FAKE=$(mktemp -d)/bin; mkdir -p "$FAKE"
printf '#!/bin/bash\ntrap "" TERM\nwhile :; do sleep 1; done\n' > "$FAKE/rig-run"; chmod +x "$FAKE/rig-run"
fails=0 n=0 started=()
lst() { ps -o lstart= -p "$1"; }
earlier() { LC_ALL=C date -j -v-"$2"S -f "%a %b %d %T %Y" "$(echo $(lst "$1"))" "+%a %b %d %T %Y"; }
# case NAME EXPECT_EXIT EXPECT_CLONE(kept|gone) PID [START_TEXT|-]
case_() {
  local name=$1 want_rc=$2 want_clone=$3 pid=$4 start=${5:--} root rc clone alive
  root=$(mktemp -d); n=$((n+1))
  mkdir -p "$root/rig/runs/rig-run-$pid" "$root/lume/rig-run-$pid"
  echo "$pid" > "$root/rig/runs/rig-run-$pid/owner.pid"
  [ "$start" != - ] && echo "$start" > "$root/rig/runs/rig-run-$pid/owner.start"
  echo "vm-$pid" > "$root/rig/runs/rig-run-$pid/lease.id"; echo "heavy-$pid" > "$root/rig/runs/rig-run-$pid/heavy.id"
  echo disk > "$root/lume/rig-run-$pid/disk.img"
  out=$(RIG_STOP_RELEASED=$root/released PATH=${CASE_PATH:-$PATH} RIG_STOP_TEST_ROOT=$root RIG_STOP_LEASE_STATUS=/dev/null RIG_STOP_RIG_RUN=$FAKE/rig-run "$S" --orphans --grace 2 2>&1); rc=$?
  [ -d "$root/lume/rig-run-$pid" ] && clone=kept || clone=gone
  alive=$(ps -p "$pid" >/dev/null 2>&1 && echo alive || echo absent)
  # A swept clone's recorded vm and heavy leases are released; a kept one's are not.
  rel=$(cat "$root/released" 2>/dev/null | tr '\n' ' ')
  [ "$want_clone" = gone ] && want_rel="vm-$pid heavy-$pid " || want_rel=""
  if [ "$rc" = "$want_rc" ] && [ "$clone" = "$want_clone" ] && [ "$rel" = "$want_rel" ]; then r=PASS; else r=FAIL; fails=$((fails+1)); fi
  echo "$r $name: exit=$rc (want $want_rc) clone=$clone (want $want_clone) released='$rel' owner pid $pid $alive | $(echo "$out" | tr '\n' ' ' | cut -c1-230)"
  rm -rf "$root"
}
sleep 600 & D=$!; kill $D; wait $D 2>/dev/null                                   # a pid that is gone
case_ "gone: owner pid absent -> swept" 0 gone "$D" "Thu Oct  1 09:00:00 2026"
sleep 600 & A=$!; started+=($A); sleep 1
case_ "replaced: start differs by 2 days -> swept, owner not signalled" 0 gone "$A" "Thu Oct  1 09:00:00 2026"
case_ "replaced: recorded start 2 s off (> 1000 ms) -> swept" 0 gone "$A" "$(earlier "$A" 2)"
case_ "unverifiable: live owner, argv unreadable (pid 1, start as recorded) -> untouched" 1 kept 1 "$(lst 1)"
"$FAKE/rig-run" & F=$!; started+=($F); sleep 1
case_ "live: argv is rig-run, start as recorded -> untouched, not reported" 0 kept "$F" "$(lst "$F")"
case_ "unverifiable: start as recorded but argv is not rig-run (exec'd lookalike) -> untouched" 1 kept "$A" "$(lst "$A")"
case_ "unverifiable: recorded start 1 s off (not > 1000 ms) -> untouched" 1 kept "$A" "$(earlier "$A" 1)"
case_ "unverifiable: no recorded start and no lease, pid present -> untouched" 1 kept "$A" -
case_ "unverifiable: recorded start unparseable -> untouched" 1 kept "$A" "not a date"
# A failing `ps` (spawn error, fault) on a live rig-run owner with matching start must not read as "gone".
BADPS=$(mktemp -d); printf '#!/bin/sh\nexit 1\n' > "$BADPS/ps"; chmod +x "$BADPS/ps"
CASE_PATH="$BADPS:$PATH" case_ "unverifiable: ps fails for a live rig-run owner -> untouched" 1 kept "$F" "$(lst "$F")"
rm -rf "$BADPS"
for p in "${started[@]}"; do kill -KILL "$p" 2>/dev/null; done; wait 2>/dev/null
rm -rf "$(dirname "$FAKE")"
echo "$((n-fails))/$n passed"
[ "$fails" = 0 ]
