#!/bin/bash
# LY1: Laya's three checkpoints (laya, typed-decisions, multilingual) on the shaped field questions, then the scoring
# beside Jev and the canned key. From ~/.caret-run/evidence/screen/ly1 (run-all.sh, score.py). Profile caret-laya.
#   laya.sh
# Runs in the pinned worktree (caret-v2-screen), whose helper's kind checks score.py's check.ts loads. Everything else is
# a sealed input: the interpreter and its standard library (laya-python), the MLX venv's packages (laya-site), the
# tokenizers wheel (laya-tokenizers), laya_mlx (laya-mlx), the model config and tokenizer (laya-src), and the questions
# and weight digests (laya-data). The weights are fetched from Hugging Face at a pinned revision into memory and checked
# against laya-data/weights-sha256.txt (laya_run.py). Python runs with -S, so nothing outside those paths is imported.
# This recipe measures; it accepts no product. A wrong Laya pick is a result in score.json, not a failure. It fails when
# a checkpoint or the scoring did not complete, or left less than every expected record.
set -u
. "$CARET_HEAVY_RECIPES/lib.sh"
CKPTS="laya typed-decisions multilingual"
REQUIRED=(dependencies $CKPTS score)
install_deps helper || finish
LAYA_PY=("$IN/laya-python/bin/python3.12" -S -B -X pycache_prefix=/var/empty)
export PYTHONPATH="$IN/laya-mlx:$IN/laya-tokenizers:$IN/laya-site"
for c in $CKPTS; do
  expected=$(py -c 'import json, sys
n = 0
for line in open(sys.argv[1]):
    sh = json.loads(line)["shaped"].get(sys.argv[2])
    n += sh is not None and "misfit" not in sh
print(n)' "$IN/laya-data/questions.jsonl" "$c")
  "${LAYA_PY[@]}" "$CARET_HEAVY_RECIPES/laya/laya_run.py" --ckpt "$c" --latency 100 > "$OUT/$c.log" 2>&1
  check laya "$c" --exit $? --expected "${expected:-0}"
done
CARET_HELPER_SRC="$PWD/helper/src" "${LAYA_PY[@]}" "$CARET_HEAVY_RECIPES/laya/score.py" $CKPTS > "$OUT/score.log" 2>&1
check laya-score score --exit $? --ckpts $CKPTS
finish
