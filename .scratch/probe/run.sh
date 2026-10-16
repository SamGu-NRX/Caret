#!/bin/bash
# Builds Caret (release) from an export of a commit and runs --probe-length, under an lr-lease heavy
# lease and heavy.lock. Usage: run.sh <rev> <out-dir> [probe args...]
set -u
REV="$1"; OUT="$2"; shift 2
WT="/Users/samgu/Programming Projects/caret-v2-inline"
KT="/Users/samgu/Programming Projects/caret-v2-host/packages/keytype"
SRC="$WT/.scratch/probe/src"
LEASE="$HOME/.long-run/bin/lr-lease"
mkdir -p "$OUT"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$OUT/run.log"; }

[ -e "$HOME/.caret-run/HOLD" ] && { log "HOLD present, not starting"; exit 75; }
"$HOME/.long-run/bin/lr-reap" --run caret-inline >/dev/null 2>&1
deadline=$(( $(date +%s) + 5400 ))
while :; do
  if id=$("$LEASE" acquire --run caret-inline --kind heavy --est-mem 4.5 --est-disk 2 --ttl 90 --owner-pid $$ 2>&1); then break; fi
  log "lease refused: $id"
  [ "$(date +%s)" -gt "$deadline" ] && { log "gave up waiting for a lease"; exit 75; }
  sleep 120
  [ -e "$HOME/.caret-run/HOLD" ] && { log "HOLD appeared, stopping"; exit 75; }
done
trap '"$LEASE" release "$id" >/dev/null 2>&1' EXIT
log "lease $id"

build_and_probe() {
  set -e
  [ "$(git -C "$KT" rev-parse HEAD)" = "21df2cc1f5271d3712d567e3c2491ac09174caf3" ]
  rm -rf "$SRC"; mkdir -p "$SRC/packages"
  git -C "$WT" archive "$REV" apps/caret apps/screen-reader bridge | tar -x -C "$SRC"
  cp -cR "$KT" "$SRC/packages/keytype"
  rm -f "$SRC/packages/keytype/.git"
  cd "$SRC/apps/caret"
  log "build start"
  /usr/bin/time -l swift build -c release --product Caret --disable-automatic-resolution > "$OUT/build.log" 2>&1
  log "build done"
  BIN="$SRC/apps/caret/.build/release/Caret"
  log "probe start: $*"
  /usr/bin/time -l "$BIN" --probe-length "$@" > "$OUT/probe.txt" 2> "$OUT/probe.err"
  log "probe done"
}
/usr/bin/lockf -k "$HOME/.caret-run/locks/build.lock" /bin/bash -c "$(declare -f log build_and_probe); OUT='$OUT' SRC='$SRC' WT='$WT' KT='$KT' REV='$REV'; build_and_probe \"\$@\"" _ "$@"
rc=$?
log "exit $rc"
exit $rc
