#!/usr/bin/env bash
# Neurion prod watchdog — runs from cron every 5 minutes (see infra/deploy-vps.sh).
# 1) checks the API + web health endpoints;
# 2) if something is down, restarts the systemd unit(s) and re-checks (self-heal);
# 3) pushes a notification via ntfy.sh on FAILURE, on successful SELF-HEAL and on
#    RECOVERY — with a state file so a persistent outage alerts once, not every 5 min.
#
# Subscribe to alerts: install the ntfy app (or open https://ntfy.sh/<topic>) and
# subscribe to the topic below. The topic is a shared secret — don't publish it.
set -u

NTFY_TOPIC="${NEURION_NTFY_TOPIC:-neurion-alerts-85a1704a6dc9}"
STATE_FILE="/var/tmp/neurion-watchdog.state"
HOST="$(hostname)"

check_api() { curl -fsS -m 8 -o /dev/null http://127.0.0.1:8091/api/health; }
check_web() { curl -fsS -m 8 -o /dev/null http://127.0.0.1:3091/; }

notify() { # $1 = title, $2 = body, $3 = priority (default|high)
  curl -fsS -m 10 -H "Title: $1" -H "Priority: ${3:-high}" -H "Tags: neurion" \
    -d "$2" "https://ntfy.sh/${NTFY_TOPIC}" >/dev/null 2>&1 || true
}

fail=""
check_api || fail="api"
check_web || fail="${fail:+$fail+}web"

prev="$(cat "$STATE_FILE" 2>/dev/null || echo ok)"

if [ -z "$fail" ]; then
  # healthy — announce recovery if we were previously down
  if [ "$prev" != "ok" ]; then
    notify "Neurion RECOVERED" "api+web healthy again on ${HOST} ($(date -Is))" default
  fi
  echo ok > "$STATE_FILE"
  exit 0
fi

# something is down — try to self-heal
[ -z "${fail##*api*}" ] && systemctl restart neurion-api
[ -z "${fail##*web*}" ] && systemctl restart neurion-web
sleep 15

fail2=""
check_api || fail2="api"
check_web || fail2="${fail2:+$fail2+}web"

if [ -z "$fail2" ]; then
  # healed — always tell (it means something crashed)
  notify "Neurion self-healed" "${fail} was down on ${HOST}; restart fixed it ($(date -Is))" default
  echo ok > "$STATE_FILE"
  exit 0
fi

# still down — alert loudly, but only on state change (no spam every 5 min)
if [ "$prev" != "down:$fail2" ]; then
  notify "Neurion DOWN" "${fail2} unreachable on ${HOST} even after restart ($(date -Is)) — ssh in and check: journalctl -u neurion-api -n 50" high
fi
echo "down:$fail2" > "$STATE_FILE"
exit 1
