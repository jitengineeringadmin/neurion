#!/usr/bin/env bash
# Publish the current source tree and run the project's production deploy script.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${NEURION_VPS_KEY:-$HOME/.ssh/github_actions_sapius}"
VPS="${NEURION_VPS:-root@80.211.141.173}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE="$ROOT/.local-run/neurion-source-$STAMP.tar.gz"
REMOTE_ARCHIVE="/tmp/neurion-source-$STAMP.tar.gz"

mkdir -p "$ROOT/.local-run"
trap 'rm -f "$ARCHIVE"' EXIT

echo "=== creating source archive ==="
tar -czf "$ARCHIVE" \
  --exclude='neurion/.env' \
  --exclude='neurion/.env.*' \
  --exclude='neurion/**/.env' \
  --exclude='neurion/**/.env.*' \
  --exclude='neurion/.git' \
  --exclude='neurion/.local-data' \
  --exclude='neurion/.local-run' \
  --exclude='neurion/.runtime' \
  --exclude='neurion/.turbo' \
  --exclude='neurion/node_modules' \
  --exclude='neurion/**/node_modules' \
  --exclude='neurion/**/.next' \
  --exclude='neurion/**/dist' \
  --exclude='neurion/**/staging' \
  --exclude='neurion/**/dist-installer' \
  --exclude='neurion/**/dist-installer-*' \
  --exclude='neurion/**/cache' \
  --exclude='neurion/**/artifacts' \
  --exclude='neurion/**/*.tsbuildinfo' \
  -C "$(dirname "$ROOT")" "$(basename "$ROOT")"

echo "=== uploading source archive ==="
scp -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=25 \
  "$ARCHIVE" "$VPS:$REMOTE_ARCHIVE"

echo "=== deploying on $VPS ==="
ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=25 "$VPS" \
  "set -euo pipefail; \
   test -f /opt/neurion/.env.production; \
   mkdir -p /opt/neurion-backups; \
   tar -czf /opt/neurion-backups/neurion-before-$STAMP.tar.gz \
     --exclude='neurion/node_modules' --exclude='neurion/**/node_modules' \
     --exclude='neurion/**/.next' --exclude='neurion/**/dist' \
     --exclude='neurion/**/staging' --exclude='neurion/**/dist-installer' \
     -C /opt neurion; \
   test \"\$(realpath /opt/neurion)\" = '/opt/neurion'; \
   find /opt/neurion -mindepth 1 -maxdepth 1 \
     ! -name '.env.production' ! -name '.dbpass' ! -name '.adminpw' \
     -exec rm -rf -- {} +; \
   tar -xzf '$REMOTE_ARCHIVE' -C /opt; \
   rm -f '$REMOTE_ARCHIVE'; \
   bash /opt/neurion/infra/deploy-vps.sh"

echo "=== production deploy complete ==="
