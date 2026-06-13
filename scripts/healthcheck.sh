#!/usr/bin/env bash
# Hourly health check for LabPlot AI (https://labplotai.com/).
# If the site does not return a healthy status, restart the docker compose stack.
# Failure mode this guards against: instance reboot where only caddy auto-restarts
# (returning 502) while db/backend/frontend stay down.
set -u
PROJECT_DIR="/home/ubuntu/web_projects/LabPlot"
LOG="$PROJECT_DIR/scripts/healthcheck.log"
URL="https://labplotai.com/"
SWAPFILE="/swapfile"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# Ensure swap is active (this box is memory-constrained; reboots can drop it).
if [ -f "$SWAPFILE" ] && ! swapon --show 2>/dev/null | grep -q "$SWAPFILE"; then
  swapon "$SWAPFILE" 2>>"$LOG" && echo "$(ts) swap re-enabled" >> "$LOG"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL" || echo "000")
if [ "$code" = "200" ] || [ "$code" = "301" ] || [ "$code" = "302" ] || [ "$code" = "307" ] || [ "$code" = "308" ]; then
  echo "$(ts) OK ($code)" >> "$LOG"
  exit 0
fi

echo "$(ts) DOWN ($code) — restarting compose" >> "$LOG"
cd "$PROJECT_DIR" || exit 1
docker compose up -d >> "$LOG" 2>&1
echo "$(ts) restart finished" >> "$LOG"
