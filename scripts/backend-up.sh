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

log "Ensuring crypto_payroll editable install is registered in venv (idempotent)"
dc exec -T -u root backend bash -lc 'cd /home/frappe/frappe-bench && ./env/bin/pip install -q -e apps/crypto_payroll'
# bench serve (PID 1) starts before the bind-mount is pip-installed; restart it
# so the fresh .pth is picked up before any bench commands run.
dc restart backend
sleep 3

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

if bench_site list-apps | grep -qw crypto_payroll; then
  log "crypto_payroll already installed — running migrate"
else
  log "Installing editable crypto_payroll"
  # app source is bind-mounted at apps/crypto_payroll; the pip -e registration
  # already ran above (root, every boot), so here we only register it in apps.txt.
  dc exec -T backend bash -lc '
    set -e
    grep -qxF crypto_payroll sites/apps.txt || printf "\ncrypto_payroll\n" >> sites/apps.txt
  '
  bench_site install-app crypto_payroll
fi
bench_site migrate

log "Seeding test Company + GL accounts"
bench_site execute crypto_payroll.setup.seed.run

log "Ensuring Journal Entry source-id fields (batch ID + chain tx + SafeTx hash)…"
bench_site execute crypto_payroll.setup.custom_fields.ensure_custom_fields

log "Running smoke checks"
"$REPO_ROOT/scripts/backend-smoke.sh"
