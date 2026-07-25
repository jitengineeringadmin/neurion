#!/usr/bin/env bash
# Neurion VPS deploy (target /opt/jit-factory/projects/neurion).
set -euo pipefail
ROOT="/opt/jit-factory/projects/neurion"
cd "$ROOT"

echo "[1/6] pull"
git pull --ff-only || true

echo "[2/6] install"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

echo "[3/6] build"
pnpm build

echo "[4/6] migrate"
pnpm --filter @neurion/api exec dotenv -e "$ROOT/.env" -- prisma migrate deploy

echo "[5/6] restart services"
sudo systemctl restart neurion-api
sudo systemctl restart neurion-web

echo "[6/6] healthcheck"
sleep 3
bash infra/scripts/healthcheck.sh
echo "deploy done"
