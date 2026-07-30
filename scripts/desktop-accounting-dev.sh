#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACCOUNTING_ENV_FILE="$REPO_ROOT/apps/desktop/.env.accounting.local"

if [ ! -f "$ACCOUNTING_ENV_FILE" ]; then
  echo "Accounting credentials are not configured." >&2
  echo "Run: bash scripts/configure-local-accounting.sh" >&2
  exit 1
fi

set -a
source "$ACCOUNTING_ENV_FILE"
set +a

exec npm --workspace apps/desktop run dev -- "$@"
