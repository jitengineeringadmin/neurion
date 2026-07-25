#!/usr/bin/env bash
# Build the GRID job-worker Docker images locally on a node host so the node
# agent can run jobs (the agent runs allowlisted images by tag, no registry).
# Run on the machine that hosts the node-agent. Requires Docker + npx.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

build() {
  local dir="$1" tag="$2"
  echo "### building $tag from $dir"
  ( cd "$ROOT/apps/workers/$dir"
    npx -y -p typescript@5.4.5 tsc -p tsconfig.json
    docker build -t "$tag" .
  )
}

build echo-worker      neurion/echo-worker:0.1.0
build embedding-worker neurion/embedding-worker:0.1.0 || echo "embedding-worker build skipped/failed (model deps) — echo is enough for GRID e2e"

# image-worker is Python (no tsc) and heavy (torch + SD-Turbo baked, ~6 GB) — opt-in.
if [ "${BUILD_IMAGE_WORKER:-false}" = "true" ]; then
  echo "### building neurion/image-worker:0.1.0 (torch + SD-Turbo, this is large/slow)"
  ( cd "$ROOT/apps/workers/image-worker" && docker build -t neurion/image-worker:0.1.0 . ) \
    || echo "image-worker build failed (torch/model deps)"
fi

echo "### images:"
docker images | grep -E "neurion/(echo|embedding|image)-worker" || echo "none"
