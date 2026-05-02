#!/usr/bin/env bash
# Cards deploy script. Run from the cards app directory.
#
# Defaults match the Hetzner box already running rebuilding-iran:
#   - SSH host: root@89.167.33.158
#   - Cards lives at /opt/cards (the RI app is at /opt/app)
#   - Caddy is the `caddy` service inside /opt/app/docker-compose.yml
#     and reloads its config from the bind-mounted /etc/caddy/Caddyfile
#
# Override via env vars when needed:
#   CARDS_HETZNER_HOST   default root@89.167.33.158
#   CARDS_REMOTE_DIR     default /opt/cards
#   CARDS_CADDY_RELOAD   default 'cd /opt/app && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile'

set -euo pipefail

HOST="${CARDS_HETZNER_HOST:-root@89.167.33.158}"
REMOTE_DIR="${CARDS_REMOTE_DIR:-/opt/cards}"
CADDY_RELOAD="${CARDS_CADDY_RELOAD:-cd /opt/app && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile}"

# 1. Sanity: clean working tree.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[deploy] working tree has uncommitted changes; commit or stash first."
  exit 1
fi

# 2. Push to remote so the box can pull.
echo "[deploy] pushing to origin..."
git push origin "$(git rev-parse --abbrev-ref HEAD)"

# 3. Pull, build, and bring up the container on the Hetzner box.
echo "[deploy] building + starting on ${HOST}..."
ssh "$HOST" "set -e; \
  cd '$REMOTE_DIR'; \
  git pull --ff-only; \
  docker compose build cards; \
  docker compose up -d cards"

# 4. Reload Caddy so any new routes pick up. Idempotent — safe to skip if
#    you haven't touched the Caddyfile.
if [ -n "$CADDY_RELOAD" ]; then
  echo "[deploy] reloading Caddy..."
  ssh "$HOST" "$CADDY_RELOAD"
fi

# 5. Smoke test.
echo "[deploy] verifying https://rebuilding-iran.com/cards/ ..."
http_code="$(curl -s -o /dev/null -w '%{http_code}' https://rebuilding-iran.com/cards/ || true)"
if [ "$http_code" = "200" ]; then
  echo "[deploy] OK — https://rebuilding-iran.com/cards/ responding 200."
else
  echo "[deploy] WARN — got HTTP $http_code. Check container logs:"
  echo "  ssh $HOST 'docker logs --tail 100 cards'"
  exit 1
fi
