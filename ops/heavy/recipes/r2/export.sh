#!/bin/bash
# A fresh export of one commit for an R2 build: DEST is deleted and rebuilt every time, never reused because its .REV
# matches, since a reused export can hold files (left by an earlier build or edited by hand) that no commit has.
#   export.sh WORKTREE COMMIT DEST [SUBMODULE-PATH...]
# Submodules listed are exported at the commit their gitlink records. DEST must be a directory named src.
set -euo pipefail
W=${1:?usage: export.sh WORKTREE COMMIT DEST [SUBMODULE...]}; C=${2:?commit}; D=${3:?dest}; shift 3
case "$D" in /*/src) ;; *) echo "export.sh: DEST must be an absolute path ending in /src, not $D" >&2; exit 64 ;; esac
full=$(git -C "$W" rev-parse --verify "$C^{commit}")
[ "$full" = "$C" ] || { echo "export.sh: $C is not a full commit id ($full)" >&2; exit 64; }
rm -rf "$D"
mkdir -p "$D"
git -C "$W" archive "$full" | tar -x -C "$D"
for sub in "$@"; do
  sha=$(git -C "$W" ls-tree "$full" "$sub" | awk '$2 == "commit" {print $3}')
  [ -n "$sha" ] || { echo "export.sh: $sub is not a submodule at $full" >&2; exit 1; }
  mkdir -p "$D/$sub"
  git -C "$W/$sub" archive "$sha" | tar -x -C "$D/$sub"
done
echo "$full" > "$D/.REV"
