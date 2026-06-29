#!/bin/bash
# Nightly Neurion Postgres backup (custom format = compressed + parallel restore).
set -u
TS=$(date +%Y%m%d-%H%M%S)
DEST=/var/backups/neurion
mkdir -p "$DEST"

# DB password: prefer the generated file, else parse it out of DATABASE_URL.
DBPASS=$(cat /opt/neurion/.dbpass 2>/dev/null)
if [ -z "${DBPASS:-}" ]; then
  DBPASS=$(grep -oP 'postgresql://neurion:\K[^@]+' /opt/neurion/.env.production 2>/dev/null)
fi
export PGPASSWORD="$DBPASS"

pg_dump -h 127.0.0.1 -U neurion -Fc -Z 6 -f "$DEST/neurion-${TS}.dump" neurion
if [ $? -eq 0 ]; then
  SIZE=$(stat -c%s "$DEST/neurion-${TS}.dump")
  echo "$(date -Iseconds)  neurion backed up: $SIZE bytes" >> /var/log/neurion-pgbackup.log
else
  echo "$(date -Iseconds)  neurion BACKUP FAILED" >> /var/log/neurion-pgbackup.log
fi
unset PGPASSWORD

# Retain 14 days
find "$DEST" -name "*.dump" -mtime +14 -delete
du -sh "$DEST" >> /var/log/neurion-pgbackup.log
