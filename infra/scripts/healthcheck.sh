#!/usr/bin/env bash
# Probe all Neurion health endpoints. Non-zero exit if any core check is down.
set -uo pipefail
API="${API:-http://localhost:8091}"
fail=0
for path in health health/db health/redis health/storage health/contracts health/ai-router; do
  body=$(curl -s "$API/api/$path" || echo '{}')
  status=$(echo "$body" | sed -n 's/.*"status":"\([a-z_]*\)".*/\1/p')
  printf "  %-20s %s\n" "$path" "${status:-unreachable}"
  case "$path" in
    health|health/db) [ "$status" = "ok" ] || fail=1 ;;
  esac
done
[ "$fail" = 0 ] && echo "healthcheck OK" || { echo "healthcheck FAILED (core down)"; exit 1; }
