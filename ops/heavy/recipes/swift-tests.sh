#!/bin/bash
# `swift test` in each named Swift package of a fresh export of the pinned commit (profile caret-swift). The export
# and the build directories live under TMPDIR and are deleted however the recipe ends. packages/keytype and its
# llama.xcframework come from the job's sealed inputs (caret_heavy.keytype_inputs) when the plan has them. Every
# package runs; the recipe exits 11 when any test fails and 14 when a package does not build. The supervisor records
# the job's peak memory (outcome.json "memory"); swift-times.ndjson says when each package ran, to read it against
# memory.ndjson. With CARET_RECORD_SNAPSHOTS=1 (the plan's --env), the reference images the tests record are copied to
# OUT/snapshots with a manifest (snapshots.py). With CARET_AX_ONSCREEN=1, the on-screen guard (onscreen.py) holds
# gui.lock, a gui lease and an idle HID for the run, and the recipe exits 15 when someone uses the Mac during it.
#   swift-tests.sh TAG PACKAGE...
set -u
. "$CARET_HEAVY_RECIPES/lib.sh"
TAG=${1:?usage: swift-tests.sh TAG PACKAGE...}
shift
[ $# -gt 0 ] || { echo "swift-tests: no packages" >&2; exit 64; }
WORK="${TMPDIR:-/tmp}/caret-swift-tests.$CARET_HEAVY_JOB_ID"
[ ! -e "$WORK" ] || { echo "swift-tests: $WORK already exists" >&2; exit 64; }
mkdir -p "$WORK"
GUARD=
trap '[ -z "$GUARD" ] || { kill -TERM "$GUARD" 2>/dev/null; wait "$GUARD"; }; chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT
# 15: the on-screen guard saw HID input during the run and stopped this process group (onscreen.py).
trap '[ -e "$OUT/onscreen.interrupted" ] && exit 15; exit 143' TERM INT HUP
REQUIRED=(export)
/bin/bash "$CARET_HEAVY_RECIPES/r2/export.sh" "$PWD" "$CARET_HEAVY_REV" "$WORK/src" > "$OUT/export.log" 2>&1
check prepare export --log "$OUT/export.log" --exit $? || finish
if [ -d "$IN/keytype" ]; then
  REQUIRED+=(inputs)
  (
    set -e
    K="$WORK/src/packages/keytype"
    rm -rf "$K"
    mkdir -p "$WORK/src/packages"
    # The job's sealed inputs are read-only (enqueue seals them; the supervisor checks them against the plan's digests
    # just before the spawn). The build writes into its own copy (Vendor/, SwiftPM output), so the copy is made
    # writable and checked to hold exactly the sealed content.
    cp -c -R "$IN/keytype" "$K"
    chmod -R u+w "$K"
    diff -r "$IN/keytype" "$K"
    echo "keytype matches the sealed copy"
    mkdir -p "$K/Packages/ModelRuntime/Vendor"
    cp -c -R "$IN/llama.xcframework" "$K/Packages/ModelRuntime/Vendor/llama.xcframework"
    chmod -R u+w "$K/Packages/ModelRuntime/Vendor"
    diff -r "$IN/llama.xcframework" "$K/Packages/ModelRuntime/Vendor/llama.xcframework"
    echo "llama.xcframework matches the sealed copy"
  ) > "$OUT/inputs.log" 2>&1
  check prepare inputs --log "$OUT/inputs.log" --exit $? || finish
fi
if [ "${CARET_AX_ONSCREEN:-}" = 1 ]; then
  # On-screen tests: gui.lock, a gui lease and an idle HID first, held until the recipe ends (onscreen.py).
  REQUIRED+=(onscreen)
  # Started directly, not through py(): a backgrounded function is a subshell, and $! would be its pid, not the guard's.
  "$PY" -I -B -X pycache_prefix=/var/empty "$CARET_HEAVY_RECIPES/onscreen.py" "$OUT" "$$" > "$OUT/onscreen.log" 2>&1 &
  GUARD=$!
  while kill -0 "$GUARD" 2>/dev/null && [ ! -e "$OUT/onscreen.ready" ]; do sleep 0.2; done
  if [ -e "$OUT/onscreen.ready" ]; then code=0; else wait "$GUARD"; GUARD=; code=1; fi
  check prepare onscreen --log "$OUT/onscreen.log" --exit $code || finish
fi
if [ "${CARET_RECORD_SNAPSHOTS:-}" = 1 ]; then
  # Record mode: the reference images the tests write into the export are copied out after the last package
  # (snapshots.py), so they can be reviewed and committed.
  REQUIRED+=(snapshots)
  py "$CARET_HEAVY_RECIPES/snapshots.py" baseline "$WORK/src" "$WORK/snapshots-before.json" "$@" > "$OUT/snapshots.log" 2>&1
  check prepare snapshots-baseline --log "$OUT/snapshots.log" --exit $? || finish
fi
for pkg in "$@"; do
  slug=$(printf '%s' "$pkg" | tr '/' '-')
  REQUIRED+=("swift-$slug-$TAG")
  started=$(date +%s)
  run_suite "swift-$slug-$TAG" swift "$WORK/src/$pkg" swift test --disable-automatic-resolution --scratch-path "$WORK/build/$slug"
  code=$?
  printf '{"package": "%s", "started": %s, "ended": %s, "code": %s}\n' "$pkg" "$started" "$(date +%s)" "$code" >> "$OUT/swift-times.ndjson"
done
if [ "${CARET_RECORD_SNAPSHOTS:-}" = 1 ]; then
  py "$CARET_HEAVY_RECIPES/snapshots.py" collect "$WORK/src" "$WORK/snapshots-before.json" "$OUT/snapshots" \
    "$CARET_HEAVY_REV" "$@" >> "$OUT/snapshots.log" 2>&1
  check prepare snapshots --log "$OUT/snapshots.log" --exit $?
fi
if [ -n "$GUARD" ]; then
  kill -TERM "$GUARD" 2>/dev/null
  wait "$GUARD"
  GUARD=
fi
finish
