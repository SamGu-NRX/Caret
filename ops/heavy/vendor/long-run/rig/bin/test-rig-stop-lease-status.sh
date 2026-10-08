#!/bin/bash
# Offline test: rig-stop fails closed when `lr-lease status` fails (2026-10-07 browser-kind audit), as rig-run does. A
# stub lr-lease in a temporary HOME exits 1, hangs, or prints a malformed report: each time rig-stop must exit 75 and
# clean nothing (the clone dir and state dir of a dead owner stay), for a general stop and for --only. A good status
# cleans as before. Clone and state dirs live under a temp root (RIG_STOP_TEST_ROOT); nothing real is touched.
#   RIG_STOP=<path> tests another copy of rig-stop.
set -u
S=${RIG_STOP:-~/.long-run/rig/bin/rig-stop}
T=$(mktemp -d /tmp/rig-stop-status.XXXXXX)
H=$T/home
mkdir -p "$H/.long-run/bin"
cat > "$H/.long-run/bin/lr-lease" <<'STUB'
#!/bin/sh
# Stub lr-lease: `status` per STUB_STATUS (ok, exit1, hang, malformed); anything else succeeds silently.
[ "$1" = status ] || exit 0
case "${STUB_STATUS:-ok}" in
  ok) printf 'Readings (stub): disk=100 GiB free\nQuiet until: none\nLeases: 0\nDecisions for a zero-estimate request:\nvm: GRANT\n' ;;
  exit1) echo "refused: admission unavailable or mutex busy"; exit 1 ;;
  hang) sleep 30 ;;
  malformed) printf 'Readings (stub)\nLeases: 1\n{not json\n' ;;
esac
STUB
printf '#!/bin/sh\nexit 0\n' > "$H/.long-run/bin/lr-reap"
printf '#!/bin/sh\nexit 0\n' > "$T/lume"
chmod +x "$H/.long-run/bin/lr-lease" "$H/.long-run/bin/lr-reap" "$T/lume"
fails=0 n=0
ok() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got '$2', want '$3'"; fails=$((fails+1)); fi; }
cleanup() { rm -rf "$T"; }
trap cleanup EXIT
# A clone and a state dir whose owner is gone: a general stop deletes them.
make_clone() {
  /usr/bin/true & P=$!; wait $P
  VM=rig-run-$P
  mkdir -p "$T/root/rig/runs/$VM" "$T/root/lume/$VM"
  echo "$P" > "$T/root/rig/runs/$VM/owner.pid"
}
run() { HOME=$H STUB_STATUS=$1 RIG_STOP_TEST_ROOT=$T/root RIG_STOP_LUME=$T/lume RIG_STOP_STATUS_TIMEOUT=2 "$S" "${@:2}" > "$T/out" 2>&1; echo $?; }
for mode in exit1 hang malformed; do
  rm -rf "$T/root"; make_clone
  ok "$mode, general stop: exit 75" "$(run $mode --grace 0)" 75
  ok "$mode, general stop: clone kept" "$([ -d "$T/root/lume/$VM" ] && echo kept || echo deleted)" kept
  ok "$mode, general stop: says why" "$(grep -c 'lease state unknown' "$T/out")" 1
  ok "$mode, --only: exit 75" "$(run $mode --only "$P" --grace 0)" 75
  ok "$mode, --only: clone kept" "$([ -d "$T/root/lume/$VM" ] && echo kept || echo deleted)" kept
done
rm -rf "$T/root"; make_clone
ok "good status, general stop: exit 0" "$(run ok --grace 0)" 0
ok "good status, general stop: clone deleted" "$([ -d "$T/root/lume/$VM" ] && echo kept || echo deleted)" deleted
echo "$((n - fails))/$n passed"
[ "$fails" -eq 0 ]
