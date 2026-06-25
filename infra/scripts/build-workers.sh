#!/usr/bin/env bash
# Build the Neurion worker container images (allowlisted neurion/* images, G15).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

build() {
  local name="$1" dir="$2"
  echo "== building $name =="
  pnpm --filter "@neurion/$name" build
  docker build -t "neurion/$name:0.1.0" "$ROOT/$dir"
}

build echo-worker apps/workers/echo-worker
build embedding-worker apps/workers/embedding-worker
echo "worker images built"
docker images | grep '^neurion/' || true
