#!/usr/bin/env bash
# Keeps the Velo Sim app on the iPad alive: with a free Apple account (Personal Team) the signature only
# lasts 7 days. Run daily by launchd (deploy/ipad-refresh-install.sh); it only rebuilds when the installed
# build expires within REFRESH_HOURS, fetches a fresh profile, signs and installs via USB or Wi-Fi.
#   deploy/ipad-refresh.sh          # refresh if due
#   deploy/ipad-refresh.sh --force  # refresh now
set -euo pipefail

TEAM="${TEAM:-A6B454J928}"
DEVICE="${DEVICE:-00008027-001105390E22002E}"  # iPad von Ali
BUNDLE_ID=de.tutit.velosim
REFRESH_HOURS="${REFRESH_HOURS:-60}"
STATE="$HOME/Library/Caches/velo-sim-ipad"
DERIVED="$STATE/DerivedData"
APP="$DERIVED/Build/Products/Debug-iphoneos/App.app"
PROFILES="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$STATE"

log() { echo "$(date '+%F %T') $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Velo Sim iPad\"" >/dev/null 2>&1 || true; }
profile_expiry() { security cms -D -i "$1" 2>/dev/null | plutil -extract ExpirationDate raw -o - - 2>/dev/null; }
epoch() { date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s; }

if [ "${1:-}" != "--force" ] && [ -f "$STATE/installed" ] && [ -f "$APP/embedded.mobileprovision" ]; then
  expires=$(profile_expiry "$APP/embedded.mobileprovision")
  if [ -n "$expires" ] && [ $(( $(epoch "$expires") - $(date +%s) )) -gt $(( REFRESH_HOURS * 3600 )) ]; then
    log "Noch gültig bis $expires – nichts zu tun."
    exit 0
  fi
fi

# Drop this app's cached profiles so Xcode fetches a fresh one with a new 7-day window.
for f in "$PROFILES"/*.mobileprovision; do
  [ -f "$f" ] || continue
  id=$(security cms -D -i "$f" 2>/dev/null | plutil -extract Entitlements.application-identifier raw -o - - 2>/dev/null || true)
  [ "$id" = "$TEAM.$BUNDLE_ID" ] && rm -f "$f"
done

log "Baue $(git -C "$ROOT" rev-parse --short HEAD) …"
(cd "$ROOT/apps/client" && npm run -s ios:sync)
xcodebuild -project "$ROOT/apps/client/ios/App/App.xcodeproj" -scheme App -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath "$DERIVED" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic build -quiet

if ! xcrun devicectl device install app --device "$DEVICE" "$APP" >/dev/null 2>&1; then
  log "Gebaut, aber das iPad hat die Installation nicht angenommen (gesperrt/nicht erreichbar) – nächster Versuch beim nächsten Lauf."
  notify "App gebaut, aber iPad nicht erreichbar. iPad entsperren, ins WLAN oder ans Kabel."
  exit 1
fi
touch "$STATE/installed"
log "Installiert, gültig bis $(profile_expiry "$APP/embedded.mobileprovision")."
notify "App neu signiert und installiert."
