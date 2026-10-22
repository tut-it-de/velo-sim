#!/usr/bin/env bash
# Installs a launchd job that runs deploy/ipad-refresh.sh daily at 09:30 and after login
# (missed runs while the Mac sleeps are made up on wake). Log: ~/Library/Logs/velo-sim-ipad.log
#   deploy/ipad-refresh-install.sh            # install / update
#   deploy/ipad-refresh-install.sh --remove   # uninstall
set -euo pipefail
LABEL=de.tutit.velosim.ipad-refresh
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/ipad-refresh.sh"
LOG="$HOME/Library/Logs/velo-sim-ipad.log"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--remove" ]; then
  rm -f "$PLIST"
  echo "Entfernt."
  exit 0
fi

# launchd starts with a bare PATH; take node/npm from the current shell (nvm).
NODE_BIN="$(dirname "$(command -v node)")"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SCRIPT</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$NODE_BIN:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Eingerichtet: täglich 09:30 und nach dem Anmelden. Log: $LOG"
