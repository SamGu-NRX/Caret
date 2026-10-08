#!/bin/bash
# Isolated tests of `rig-stop --orphans` against a running VM process whose owner is gone, the path
# the memory guard takes after SIGKILLing a rig-run (`--orphans --grace 0`). The VM is a fake `lume`
# binary built here: `lume run <vm>` waits for SIGTERM, `lume stop` SIGTERMs it unless
# FAKE_LUME_IGNORE is set. Temp root, synthetic leases (RIG_STOP_LEASE_STATUS=/dev/null), and every
# process it signals is one this script started. Prints PASS/FAIL per case; exit 1 on a FAIL.
set -u
S=${RIG_STOP:-~/.long-run/rig/bin/rig-stop}
T=$(mktemp -d); mkdir -p "$T/bin"
cat > "$T/lume.c" <<'C'
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *pf = getenv("FAKE_LUME_PIDFILE");
  if (argc > 2 && !strcmp(argv[1], "run")) {
    FILE *f = fopen(pf, "w"); fprintf(f, "%d\n", getpid()); fclose(f);
    if (getenv("FAKE_LUME_IGNORE")) signal(SIGTERM, SIG_IGN);
    for (;;) pause();
  }
  if (argc > 2 && !strcmp(argv[1], "stop")) {
    if (getenv("FAKE_LUME_IGNORE")) return 0;
    FILE *f = fopen(pf, "r"); int p = 0;
    if (f && fscanf(f, "%d", &p) == 1 && p > 0) kill(p, SIGTERM);
    return 0;
  }
  return 2;
}
C
cc -O -o "$T/bin/lume" "$T/lume.c" || { echo "FAIL could not build the fake lume"; exit 1; }
fails=0 n=0
# case NAME GRACE IGNORE(0|1) WANT_RC WANT_CLONE(kept|gone) WANT_VM(alive|gone) WANT_RELEASED
case_() {
  local name=$1 grace=$2 ign=$3 want_rc=$4 want_clone=$5 want_vm=$6 want_rel=$7 root d vm vp rc clone vmst rel t
  root=$(mktemp -d "$T/case.XXXX"); n=$((n+1))
  sleep 600 & d=$!; kill $d; wait $d 2>/dev/null          # an owner pid that is gone
  vm=rig-run-$d
  mkdir -p "$root/rig/runs/$vm" "$root/lume/$vm"; echo disk > "$root/lume/$vm/disk.img"
  echo "$d" > "$root/rig/runs/$vm/owner.pid"; echo "Thu Oct  1 09:00:00 2026" > "$root/rig/runs/$vm/owner.start"
  echo "vm-$d" > "$root/rig/runs/$vm/lease.id"; echo "heavy-$d" > "$root/rig/runs/$vm/heavy.id"
  export FAKE_LUME_PIDFILE=$root/vm.pid
  if [ "$ign" = 1 ]; then export FAKE_LUME_IGNORE=1; else unset FAKE_LUME_IGNORE; fi
  "$T/bin/lume" run "$vm" & vp=$!
  for i in $(seq 1 40); do [ -s "$root/vm.pid" ] && break; sleep 0.05; done
  echo "$vp" > "$root/rig/runs/$vm/lume.pid"
  t=$(date +%s)
  out=$(RIG_STOP_TEST_ROOT=$root RIG_STOP_LEASE_STATUS=/dev/null RIG_STOP_LUME=$T/bin/lume RIG_STOP_RELEASED=$root/released "$S" --orphans --grace "$grace" 2>&1); rc=$?
  t=$(( $(date +%s) - t ))
  [ -d "$root/lume/$vm" ] && clone=kept || clone=gone
  kill -0 "$vp" 2>/dev/null && vmst=alive || vmst=gone
  rel=$(cat "$root/released" 2>/dev/null | tr '\n' ' ')
  [ "$want_rel" = yes ] && want_rel="vm-$d heavy-$d " || want_rel=""
  if [ "$rc" = "$want_rc" ] && [ "$clone" = "$want_clone" ] && [ "$vmst" = "$want_vm" ] && [ "$rel" = "$want_rel" ]; then r=PASS; else r=FAIL; fails=$((fails+1)); fi
  echo "$r $name: exit=$rc (want $want_rc) clone=$clone (want $want_clone) vm=$vmst (want $want_vm) released='$rel' ${t}s | $(echo "$out" | tr '\n' ' ' | cut -c1-200)"
  kill -KILL "$vp" 2>/dev/null; wait "$vp" 2>/dev/null
}
case_ "--grace 0, VM stops on lume stop -> VM gone, clone deleted, vm+heavy leases released" 0 0 0 gone gone yes
case_ "--grace 0, VM ignores lume stop -> no SIGKILL, clone kept, exit 1 after LUME_STOP_WAIT" 0 1 1 kept alive no
case_ "--grace 2, VM ignores lume stop -> SIGKILL after 2 s, clone deleted" 2 1 0 gone gone yes
rm -rf "$T"
echo "$((n-fails))/$n passed"
[ "$fails" = 0 ]
