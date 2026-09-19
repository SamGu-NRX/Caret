#!/usr/bin/env bash
# Compatibility entry point. Keys must be supplied locally, never through artifacts.
set -euo pipefail
if [[ -n "${VERCEL_API_GATEWAY_KEY:-${AI_GATEWAY_API_KEY:-}}" ]]; then
  exit 0
fi
echo "Set VERCEL_API_GATEWAY_KEY or AI_GATEWAY_API_KEY in your local Caret environment." >&2
exit 1
