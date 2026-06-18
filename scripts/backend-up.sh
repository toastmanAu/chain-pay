#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/backend-common.sh"

log "Pulling image and starting stack"
dc pull
dc up -d

log "Waiting for MariaDB to be healthy"
status=starting
for i in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' chainpay-db 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && break
  sleep 3
done
[ "$status" = "healthy" ] || { echo "DB did not become healthy"; exit 1; }

log "Configuring bench service hosts (idempotent)"
bench_exec set-config -g db_host db || true
bench_exec set-config -gp db_port 3306 || true
bench_exec set-config -g redis_cache redis://redis-cache:6379 || true
bench_exec set-config -g redis_queue redis://redis-queue:6379 || true
bench_exec set-config -g redis_socketio redis://redis-queue:6379 || true

if dc exec -T backend test -d "/home/frappe/frappe-bench/sites/$SITE_NAME"; then
  log "Site $SITE_NAME already exists — skipping new-site"
else
  log "Creating site $SITE_NAME with ERPNext"
  bench_exec new-site "$SITE_NAME" \
    --mariadb-user-host-login-scope=% \
    --db-root-password "$MARIADB_ROOT_PASSWORD" \
    --admin-password "$ADMIN_PASSWORD" \
    --install-app erpnext
fi

# Set currentsite.txt so bench serve routes Host: chainpay.localhost correctly.
bench_exec use "$SITE_NAME"

log "ERPNext install confirmed"
bench_site list-apps

log "Smoke-checking HTTP endpoint"
# bench serve routes by Host header — use --resolve so it works without an /etc/hosts entry.
PING_URL="http://${SITE_NAME}:${BACKEND_PORT}/api/method/ping"
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --resolve "${SITE_NAME}:${BACKEND_PORT}:127.0.0.1" "$PING_URL")"
if [ "$HTTP_CODE" = "200" ]; then
  log "HTTP ping OK (200)"
else
  echo "WARNING: HTTP ping returned $HTTP_CODE — backend may still be starting up."
  echo "Re-run: curl -s --resolve ${SITE_NAME}:${BACKEND_PORT}:127.0.0.1 $PING_URL"
fi
