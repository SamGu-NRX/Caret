# Shared by the recipes; sourced, never run. The supervisor sets CARET_HEAVY_* (supervise.py, _recipe_env) and starts
# every recipe in the pinned worktree.
PY=$CARET_HEAVY_PY
CHECK="$CARET_HEAVY_RECIPES/check.py"
OUT=$CARET_HEAVY_OUT
# The Developer ID the eval signs its bridge with; a certificate hash, not a secret.
SIGN_IDENTITY=DC7B5D99A0E1EE3CFA464E216C400A5A91F7F439

# Every Python the recipes start: isolated, no bytecode written, none read from beside a module (caret_heavy.PY_FLAGS).
py() { "$PY" -I -B -X pycache_prefix=/var/empty "$@"; }
# Every step's code comes from check.py, and only the documented codes count. Anything else (a crash, a missing
# interpreter) is logged to OUT/checker-errors.txt, which makes finish 12, and the step reads as 12.
check() {
  py "$CHECK" "$@"
  local rc=$?
  case $rc in 0|10|11|12|13|14|98|99) return $rc ;; esac
  printf '%s (exit %s)\n' "$*" "$rc" >> "$OUT/checker-errors.txt"
  echo "check: the checker exited $rc for: $*" >&2
  return 12
}
# REQUIRED: the step names this recipe must record (set by each recipe); a missing one makes finish 12.
REQUIRED=()
finish() { check finish --require ${REQUIRED[@]+"${REQUIRED[@]}"}; exit $?; }

# Installs each package's dependencies from its committed lockfile, offline, so node_modules match the pinned commit.
install_deps() {
  local d rc=0
  for d in "$@"; do
    echo "== pnpm install --frozen-lockfile --offline in $d" >> "$OUT/prepare.log"
    (cd "$d" && pnpm install --frozen-lockfile --offline --package-import-method hardlink) >> "$OUT/prepare.log" 2>&1 || { rc=$?; break; }
  done
  check prepare dependencies --log "$OUT/prepare.log" --exit "$rc"
}

# run_suite NAME KIND DIR COMMAND...: runs COMMAND in DIR, logs to OUT/NAME.txt, records the suite's result.
run_suite() {
  local name=$1 kind=$2 dir=$3
  shift 3
  (cd "$dir" && "$@") > "$OUT/$name.txt" 2>&1
  check suite "$name" --log "$OUT/$name.txt" --exit $? --kind "$kind"
}

IN=$CARET_HEAVY_INPUTS
# The eval's W4_SITES (page-loop-eval.ts): the saved real pages the corpus set adds when their markup exists.
W4_SITES="greenhouse-discord greenhouse-embed-figma lever-palantir-apply ashby-ramp-application hubspot-contact-sales"

# Clones the job's sealed bridge build and Chrome for Testing into the pinned worktree, where the eval loads them, and
# checks each against its sealed copy.
install_binaries() {
  (
    set -e
    mkdir -p bridge/.build/release
    for b in caret-bridge caret-bridge-testhost; do
      rm -f "bridge/.build/release/$b"
      cp -c -p "$IN/bridge/$b" bridge/.build/release/
      cmp "$IN/bridge/$b" "bridge/.build/release/$b"
    done
    rm -rf fixtures/web-form/.browsers
    cp -c -R -p "$IN/browsers" fixtures/web-form/.browsers
    diff -r "$IN/browsers" fixtures/web-form/.browsers > /dev/null
  ) >> "$OUT/prepare.log" 2>&1
  check prepare binaries --log "$OUT/prepare.log" --exit $?
}

# page_ids tasks|heldout|corpus: the page ids a set must report, one per line, to OUT/ids-<kind>.txt. tasks: the pinned
# fixture's tasks/expect/*.json; heldout: the sealed held-out manifest; corpus: the pinned corpus.json's forms plus the
# W4 sites whose sealed markup exists.
page_ids() {
  py -c 'import glob, json, os, sys
kind, inputs, sites = sys.argv[1], sys.argv[2], sys.argv[3].split()
if kind == "tasks":
    ids = [os.path.basename(p)[:-5] for p in glob.glob("fixtures/web-form/tasks/expect/*.json")]
elif kind == "heldout":
    ids = [m["name"] for m in json.load(open(os.path.join(inputs, "heldout/manifest.json")))]
else:
    ids = [f["id"] for f in json.load(open("fixtures/realfill/corpus.json"))["forms"]]
    ids += [s for s in sites if os.path.exists(os.path.join(inputs, "w4/real", s + ".html"))]
if not ids or len(ids) != len(set(ids)):
    sys.exit("no page ids, or duplicates: %r" % ids)
print("\n".join(sorted(ids)))' "$1" "$IN" "$W4_SITES" > "$OUT/ids-$1.txt" 2> "$OUT/ids-$1.log"
  check prepare "page-ids-$1" --log "$OUT/ids-$1.log" --exit $? --fail-code 12
}

# The eval's --w4-* options, pointing at the sealed W4 copies (owners only where this commit's eval reads them).
w4_flags() {
  W4_FLAGS=(--w4-dir "$IN/w4/real" --w4-key "$IN/w4/replay/key.json" --w4-note "$IN/w4/replay/note.txt")
  if [ -f "$IN/w4/replay/owners.json" ] && grep -q '"w4-owners"' fixtures/web-form/page-loop-eval.ts; then
    W4_FLAGS+=(--w4-owners "$IN/w4/replay/owners.json")
  fi
}
