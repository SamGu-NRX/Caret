#!/usr/bin/env bash
# Sync VERCEL_API_GATEWAY_KEY from GitHub Actions secrets into .local/ for Caret.
# Bridge: workflow export-gateway-key.yml writes the secret to a short-lived artifact.
set -euo pipefail

REPO="${CARET_GITHUB_REPO:-theodorexli/hackathon-2026-09-19}"
WORKFLOW_FILE="${CARET_GATEWAY_EXPORT_WORKFLOW:-export-gateway-key.yml}"
WORKFLOW_NAME="${CARET_GATEWAY_EXPORT_WORKFLOW_NAME:-Export gateway key (local dev)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_PATH="$ROOT/.local/vercel-api-gateway-key"
SUPPORT_DIR="${HOME}/Library/Application Support/Caret"
SUPPORT_KEY="${SUPPORT_DIR}/vercel-api-gateway-key"

if [[ -n "${VERCEL_API_GATEWAY_KEY:-}" ]]; then
  exit 0
fi
if [[ -s "$KEY_PATH" ]]; then
  exit 0
fi
if [[ -s "$SUPPORT_KEY" ]]; then
  exit 0
fi

command -v gh >/dev/null 2>&1 || {
  echo "gh CLI is required to sync VERCEL_API_GATEWAY_KEY from GitHub." >&2
  exit 1
}

gh auth status >/dev/null 2>&1 || {
  echo "Run gh auth login to sync the gateway key from GitHub." >&2
  exit 1
}

mkdir -p "$ROOT/.local"
mkdir -p "$SUPPORT_DIR"

echo "Requesting gateway key export from GitHub Actions (${REPO})..." >&2
BEFORE_ID="$(gh run list -R "$REPO" --workflow="$WORKFLOW_FILE" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
gh workflow run "$WORKFLOW_NAME" -R "$REPO" >/dev/null 2>&1 \
  || gh workflow run "$WORKFLOW_FILE" -R "$REPO" >/dev/null

RUN_ID=""
for _ in $(seq 1 90); do
  RUN_ID="$(gh run list -R "$REPO" --workflow="$WORKFLOW_FILE" --limit 1 --json databaseId,status -q '.[0].databaseId' 2>/dev/null || true)"
  STATUS="$(gh run list -R "$REPO" --workflow="$WORKFLOW_FILE" --limit 1 --json status -q '.[0].status' 2>/dev/null || true)"
  if [[ -n "$RUN_ID" && "$RUN_ID" != "$BEFORE_ID" ]]; then
    break
  fi
  if [[ "$STATUS" == "queued" || "$STATUS" == "in_progress" ]]; then
    break
  fi
  sleep 2
done

if [[ -z "$RUN_ID" ]]; then
  echo "Timed out waiting for export workflow run." >&2
  exit 1
fi

gh run watch "$RUN_ID" -R "$REPO" --exit-status >/dev/null

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
gh run download "$RUN_ID" -R "$REPO" -n caret-gateway-key -D "$TMP_DIR" >/dev/null
install -m 600 "$TMP_DIR/vercel-api-gateway-key" "$KEY_PATH"
install -m 600 "$TMP_DIR/vercel-api-gateway-key" "$SUPPORT_KEY"
echo "Synced gateway key from GitHub Actions secret." >&2
