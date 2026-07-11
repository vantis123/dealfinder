#!/usr/bin/env bash
# Install the DAILY scraper schedule so DealFinder runs by itself whenever this computer is on.
# Usage:  bash scripts/install-schedule.sh          # default 7:00 AM local
#         bash scripts/install-schedule.sh 6 30      # 6:30 AM
set -euo pipefail

HOUR="${1:-7}"; MIN="${2:-0}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || echo /usr/local/bin/node)"
OS="$(uname -s)"

echo "DealFinder daily scan → ${HOUR}:$(printf '%02d' "$MIN") local, using node at: $NODE"
echo "Repo: $REPO"

case "$OS" in
  Darwin)  # macOS → launchd
    PLIST="$HOME/Library/LaunchAgents/com.arvantis.dealfinder-daily.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.arvantis.dealfinder-daily</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/scripts/daily.mjs</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$REPO/daily-cron.log</string>
  <key>StandardErrorPath</key><string>$REPO/daily-cron.log</string>
</dict></plist>
PL
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "✓ Scheduled via launchd. It runs at ${HOUR}:$(printf '%02d' "$MIN") daily (or on next wake if asleep)."
    echo "  Logs: $REPO/daily-cron.log   ·   Remove: launchctl unload \"$PLIST\""
    ;;
  Linux)   # Linux → crontab
    LINE="$MIN $HOUR * * * cd $REPO && $NODE scripts/daily.mjs >> $REPO/daily-cron.log 2>&1"
    ( crontab -l 2>/dev/null | grep -v 'dealfinder/scripts/daily.mjs' ; echo "$LINE" ) | crontab -
    echo "✓ Scheduled via crontab. Logs: $REPO/daily-cron.log   ·   Edit: crontab -e"
    ;;
  *)       # Windows (Git Bash / MSYS) → print Task Scheduler command
    echo "Windows detected. Run this in an ADMIN PowerShell (adjust the node path if needed):"
    echo "  schtasks /Create /SC DAILY /TN DealFinderDaily /TR \"'$NODE' '$REPO\\scripts\\daily.mjs'\" /ST ${HOUR}:$(printf '%02d' "$MIN")"
    echo "  (Note: the stealth browser currently has no Windows build — an Apple-Silicon Mac is recommended.)"
    ;;
esac
