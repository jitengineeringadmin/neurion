#!/usr/bin/env bash
# Build the desktop installer LOCALLY and publish it to the VPS /download — no GitHub
# Actions needed. Run on the platform you want to build for:
#   - Windows  → produces Neurion-Setup-<ver>.exe
#   - Linux    → produces Neurion-<ver>-linux-x86_64.AppImage (+ .deb)
# Usage: bash infra/release-local.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(node -p "require('$ROOT/apps/desktop/package.json').version")"
# Deploy target comes from your environment — no server details are baked into this
# repo. Set them for your own host, e.g.:  export NEURION_VPS=root@your-server-ip
KEY="${NEURION_VPS_KEY:-$HOME/.ssh/id_ed25519}"
VPS="${NEURION_VPS:?set NEURION_VPS=user@host to publish (e.g. export NEURION_VPS=root@1.2.3.4)}"

echo "=== building Neurion v$VER ($(uname -s)) ==="
( cd "$ROOT/apps/desktop" && pnpm run pack ) || { echo "BUILD FAILED"; exit 1; }

# collect the platform artifacts electron-builder produced
shopt -s nullglob
ART=("$ROOT/apps/desktop/dist-installer"/Neurion-Setup-*.exe \
     "$ROOT/apps/desktop/dist-installer"/Neurion-*-linux-*.AppImage \
     "$ROOT/apps/desktop/dist-installer"/Neurion-*-linux-*.deb)
[ ${#ART[@]} -gt 0 ] || { echo "no installer produced"; exit 1; }

echo "=== publishing to $VPS:/var/www/neurion/download ==="
for f in "${ART[@]}"; do
  name="$(basename "$f")"
  for try in 1 2 3 4 5; do
    if scp -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=25 "$f" "$VPS:/var/www/neurion/download/"; then
      echo "  uploaded $name"; break
    fi
    echo "  retry $try for $name (ssh flaky)…"; sleep 6
  done
done
ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=25 "$VPS" "chown www-data:www-data /var/www/neurion/download/*" 2>/dev/null || true
echo "=== done → https://neurionproject.org/download/ (v$VER) ==="
