#!/bin/bash
# Starts the slow Laya runner (scripts/slow-eval.ts) detached: in its own session under nohup, so it outlives the shell
# and the agent that started it. Arguments go to slow-eval.ts (--only id,id; --pace-ms MS; --dir DIR).
#
#   helper/scripts/slow-eval.sh            start, or resume where a stopped run left off (the cache replays)
#   kill <pid>                             stop it (SIGTERM: it ends the pass in flight and closes Chrome); pid in runner.pid
#
# Refuses to start while DIR/STOPPED exists (a stop on cost, auth, billing, the cap or a refused answer) or while a runner
# from this DIR is alive. The key comes from Caret's .env through CARET_ENV_FILE and is never printed.
set -u
DIR=$HOME/.caret-run/evidence/screen/r1
prev=""
for a in "$@"; do [ "$prev" = "--dir" ] && DIR=$a; prev=$a; done
HELPER="$(cd "$(dirname "$0")/.." && pwd)"
COMMON="$(git -C "$HELPER" rev-parse --path-format=absolute --git-common-dir)"
ENV_FILE=${CARET_ENV_FILE:-"$(dirname "$COMMON")/.env"}
[ -f "$ENV_FILE" ] || { echo "no .env at $ENV_FILE; set CARET_ENV_FILE" >&2; exit 1; }
[ -e "$DIR/STOPPED" ] && { echo "refusing: $DIR/STOPPED says:" >&2; cat "$DIR/STOPPED" >&2; exit 1; }
if [ -f "$DIR/runner.pid" ]; then
  pid=$(cat "$DIR/runner.pid")
  if ps -p "$pid" -o command= 2>/dev/null | grep -q "scripts/slow-eval.ts"; then echo "already running: pid $pid" >&2; exit 1; fi
fi
mkdir -p "$DIR"
cd "$HELPER"
# perl's setsid gives the runner its own session, so a signal to the starting shell's process group does not reach it.
CARET_ENV_FILE="$ENV_FILE" nohup /usr/bin/perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV' "$(command -v node)" scripts/slow-eval.ts "$@" >> "$DIR/runner.log" 2>&1 < /dev/null &
pid=$!
echo "$pid" > "$DIR/runner.pid"
sleep 2
if ps -p "$pid" -o command= | grep -q "scripts/slow-eval.ts"; then
  echo "slow-eval running: pid $pid; log $DIR/runner.log; status $DIR/status.json; stop with: kill $pid"
else
  echo "slow-eval exited at once; see $DIR/runner.log" >&2
  tail -5 "$DIR/runner.log" >&2
  exit 1
fi
