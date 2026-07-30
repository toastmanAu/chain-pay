#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/backend-common.sh"

ACCOUNTING_ENV_FILE="$REPO_ROOT/apps/desktop/.env.accounting.local"

log "Checking the local Frappe site"
curl --fail --silent --show-error \
  "http://$SITE_NAME:$BACKEND_PORT/api/method/ping" >/dev/null

log "Generating local-dev API credentials"
credentials="$(
  bench_site execute frappe.core.doctype.user.user.generate_keys \
    --kwargs '{"user":"Administrator"}'
)"
api_key="$(jq -r '.api_key // .message.api_key // empty' <<<"$credentials")"
api_secret="$(jq -r '.api_secret // .message.api_secret // empty' <<<"$credentials")"
if [ -z "$api_key" ] || [ -z "$api_secret" ]; then
  echo "Frappe did not return a usable API key and secret" >&2
  exit 1
fi

umask 077
{
  printf 'FRAPPE_URL=%q\n' "http://$SITE_NAME:$BACKEND_PORT"
  printf 'FRAPPE_API_KEY=%q\n' "$api_key"
  printf 'FRAPPE_API_SECRET=%q\n' "$api_secret"
} >"$ACCOUNTING_ENV_FILE"
chmod 600 "$ACCOUNTING_ENV_FILE"

log "Accounting bridge configured in apps/desktop/.env.accounting.local"
printf 'Launch ChainPay with: npm run dev:desktop:accounting\n'
