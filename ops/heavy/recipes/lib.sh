# Shared by the recipes; sourced, never run. The supervisor sets CARET_HEAVY_* (supervise.py, _recipe_env) and starts
# every recipe in the pinned worktree.
PY=$CARET_HEAVY_PY
CHECK="$CARET_HEAVY_RECIPES/check.py"
OUT=$CARET_HEAVY_OUT
# The Developer ID the eval signs its bridge with; a certificate hash, not a secret.
SIGN_IDENTITY=472BDE15DB7ADCB740F9E2508F0916EE1671FD75

# Every Python the recipes start: isolated, no bytecode written, none read from beside a module (caret_heavy.PY_FLAGS).
py() { "$PY" -I -B -X pycache_prefix=/var/empty "$@"; }
check() { py "$CHECK" "$@"; }
finish() { check finish; exit $?; }

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
