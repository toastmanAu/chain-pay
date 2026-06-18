#!/usr/bin/env bash
# Shared helpers for ChainPay backend scripts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/docker/.env"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"

# Load SITE_NAME / ADMIN_PASSWORD / MARIADB_ROOT_PASSWORD / BACKEND_PORT from docker/.env
set -a; [ -f "$ENV_FILE" ] && . "$ENV_FILE"; set +a
SITE_NAME="${SITE_NAME:-chainpay.localhost}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
MARIADB_ROOT_PASSWORD="${MARIADB_ROOT_PASSWORD:-frappe}"
BACKEND_PORT="${BACKEND_PORT:-8000}"

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
# Run a bench command inside the backend container.
bench_exec() { dc exec -T backend bench "$@"; }
# Run a bench command scoped to our site.
bench_site() { dc exec -T backend bench --site "$SITE_NAME" "$@"; }

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
