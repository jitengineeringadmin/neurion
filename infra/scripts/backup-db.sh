#!/usr/bin/env bash
# pg_dump the Neurion database to a timestamped file.
set -euo pipefail
OUT_DIR="${BACKUP_DIR:-/opt/jit-factory/backups/neurion}"
mkdir -p "$OUT_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
: "${DATABASE_URL:?set DATABASE_URL}"
pg_dump "$DATABASE_URL" | gzip > "$OUT_DIR/neurion-$STAMP.sql.gz"
echo "backup written: $OUT_DIR/neurion-$STAMP.sql.gz"
# retain last 14
ls -1t "$OUT_DIR"/neurion-*.sql.gz | tail -n +15 | xargs -r rm -f
