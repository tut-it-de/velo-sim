#!/usr/bin/env bash
# Rollt den aktuellen Commit (HEAD) auf den netcup-VPS aus:
#   deploy/deploy.sh                 (Standard: root@159.195.46.106 mit ~/.ssh/salonflow_vps)
#   VPS=root@host SSH_KEY=~/.ssh/key VELO_DOMAIN=velo.tut-it.de deploy/deploy.sh
# Beim ersten Mal: legt /opt/velo-sim/.env mit zufälligen Geheimnissen an und trägt den Caddy-Block ein.
set -euo pipefail
VPS="${VPS:-root@159.195.46.106}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/salonflow_vps}"
VELO_DOMAIN="${VELO_DOMAIN:-velo.tut-it.de}"
CADDYFILE=/opt/salon-flow/Caddyfile
CADDY=salonflow-prod-caddy-1
ssh_vps() { ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$VPS" "$@"; }

cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain --untracked-files=no)" ] || echo "⚠ Uncommittete Änderungen werden NICHT ausgerollt (nur HEAD)."
echo "→ Code ($(git rev-parse --short HEAD)) nach $VPS:/opt/velo-sim/app"
git archive --format=tar HEAD | ssh_vps 'set -e; mkdir -p /opt/velo-sim; rm -rf /opt/velo-sim/app.new; mkdir /opt/velo-sim/app.new; tar -x -C /opt/velo-sim/app.new; rm -rf /opt/velo-sim/app; mv /opt/velo-sim/app.new /opt/velo-sim/app'

ssh_vps VELO_DOMAIN="$VELO_DOMAIN" CADDYFILE="$CADDYFILE" CADDY="$CADDY" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/velo-sim
if [ ! -f .env ]; then
  umask 077
  printf 'POSTGRES_PASSWORD=%s\nJWT_SECRET=%s\nVELO_DOMAIN=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" "$VELO_DOMAIN" > .env
  echo "→ .env mit neuen Geheimnissen angelegt"
fi

echo "→ Image bauen und starten"
docker compose --env-file .env -f app/deploy/docker-compose.yml up -d --build --remove-orphans
docker image prune -f >/dev/null

if ! grep -q "^$VELO_DOMAIN {" "$CADDYFILE"; then
  cp "$CADDYFILE" "$CADDYFILE.bak-$(date +%Y%m%d-%H%M%S)"
  printf '\n# Velo Sim (Tut IT) - Container velo im Netz salonflow-prod_default, siehe /opt/velo-sim\n%s {\n\tencode zstd gzip\n\treverse_proxy velo:8080\n}\n' "$VELO_DOMAIN" >> "$CADDYFILE"
  docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  echo "→ Caddy: $VELO_DOMAIN eingetragen und neu geladen"
fi

echo "→ Warte auf den Server"
for i in $(seq 1 30); do
  docker exec "$CADDY" wget -qO- http://velo:8080/api/health >/dev/null 2>&1 && { echo "✓ velo antwortet"; exit 0; }
  sleep 2
done
echo "✗ velo antwortet nicht – docker compose -f /opt/velo-sim/app/deploy/docker-compose.yml logs velo"; exit 1
REMOTE
echo "Fertig: https://$VELO_DOMAIN (sobald der DNS-A-Eintrag auf den Server zeigt)"
