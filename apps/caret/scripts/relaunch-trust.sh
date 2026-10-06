#!/bin/bash
# Launches Caret.app by direct exec N times (default 5) and prints the trust flags each launch
# reports over the debug socket, then stops it with SIGTERM and waits for a clean exit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
binary="$here/../.build/Caret.app/Contents/MacOS/Caret"
count="${1:-5}"
export CARET_ALLOW_BUNDLES="${CARET_ALLOW_BUNDLES:-com.apple.TextEdit}"
for i in $(seq 1 "$count"); do
  # A named helper socket keeps Caret from starting its own helper and reader (H4); this script measures trust only.
  "$binary" --helper-socket "$HOME/.caret-run/sockets/screen.sock" >/dev/null 2>&1 &
  pid=$!
  trust=""
  # Wait for the engine so each launch is a full start, not just a socket answer.
  for _ in $(seq 1 600); do
    reply="$("$here/host-state.py" 2>/dev/null || true)"
    if [[ -n "$reply" ]]; then
      trust="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(json.dumps({"pid": d["pid"], "trust": d["trust"], "engine": d["engine"]["state"], "uptimeSeconds": round(d["uptimeSeconds"], 2)}, sort_keys=True))' "$reply")"
      [[ "$trust" == *'"engine": "loading"'* ]] || break
    fi
    sleep 0.1
  done
  echo "launch $i: ${trust:-no reply}"
  kill -TERM "$pid"
  for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then echo "launch $i: did not exit after SIGTERM"; exit 1; fi
  wait "$pid" || true
done
