#!/usr/bin/env bash
# Build the desktop installer locally and publish it to the VPS download directory.
# Set NEURION_SKIP_BUILD=1 to publish an installer that has already been built.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(node -p "require('$ROOT/apps/desktop/package.json').version")"
KEY="${NEURION_VPS_KEY:-$HOME/.ssh/github_actions_sapius}"
VPS="${NEURION_VPS:-root@80.211.141.173}"

if [ "${NEURION_SKIP_BUILD:-0}" = "1" ]; then
  echo "=== using the existing Neurion v$VER installer ==="
else
  echo "=== building Neurion v$VER ($(uname -s)) ==="
  ( cd "$ROOT/apps/desktop" && pnpm run pack ) || { echo "BUILD FAILED"; exit 1; }
fi

shopt -s nullglob
ART=("$ROOT/apps/desktop/dist-installer"/Neurion-Setup-"$VER".exe \
     "$ROOT/apps/desktop/dist-installer"/Neurion-"$VER"-linux-*.AppImage \
     "$ROOT/apps/desktop/dist-installer"/Neurion-"$VER"-linux-*.deb)
[ ${#ART[@]} -gt 0 ] || { echo "no installer produced for v$VER"; exit 1; }

# Update manifest: the desktop app polls latest.json and verifies the installer
# against this digest before running it, so hash the exact file being uploaded.
EXE="$ROOT/apps/desktop/dist-installer/Neurion-Setup-$VER.exe"
if [ -f "$EXE" ]; then
  SHA="$(sha256sum "$EXE" | cut -d' ' -f1)"
  MANIFEST="$ROOT/apps/desktop/dist-installer/latest.json"
  printf '{\n  "version": "%s",\n  "url": "Neurion-Setup-%s.exe",\n  "sha256": "%s",\n  "notes": "Neurion %s"\n}\n' \
    "$VER" "$VER" "$SHA" "$VER" > "$MANIFEST"
  ART+=("$MANIFEST")
  echo "=== manifest: v$VER sha256=$SHA ==="
fi

echo "=== publishing to $VPS:/var/www/neurion/download ==="
FAILED=0
for f in "${ART[@]}"; do
  name="$(basename "$f")"
  uploaded=0
  for try in 1 2 3 4 5; do
    if scp -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=25 "$f" "$VPS:/var/www/neurion/download/"; then
      echo "  uploaded $name"
      uploaded=1
      break
    fi
    echo "  retry $try for $name (SSH unavailable)"
    sleep 6
  done
  if [ "$uploaded" -ne 1 ]; then
    echo "UPLOAD FAILED: $name"
    FAILED=1
  fi
done
[ "$FAILED" -eq 0 ] || exit 1

ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=25 "$VPS" \
  "set -e; cd /var/www/neurion/download; if [ -f 'Neurion-Setup-$VER.exe' ]; then cp -f 'Neurion-Setup-$VER.exe' 'Neurion-Setup-latest.exe'; fi; chown www-data:www-data ./*; if [ -f /var/www/neurion/index.html ]; then sed -Ei 's/v[0-9]+\.[0-9]+\.[0-9]+/v$VER/g' /var/www/neurion/index.html; fi"

echo "=== done: https://neurionproject.org/download/ (v$VER) ==="
