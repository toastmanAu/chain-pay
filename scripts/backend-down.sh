#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/backend-common.sh"

if [ "${1:-}" = "-v" ]; then
  log "Tearing down stack AND wiping volumes"
  dc down -v
else
  log "Tearing down stack (volumes preserved; pass -v to wipe)"
  dc down
fi
