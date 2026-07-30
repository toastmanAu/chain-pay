#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/backend-common.sh"

fail() { echo "✗ $*"; exit 1; }
ok()   { echo "✓ $*"; }

log "1. Site responds on :${BACKEND_PORT}"
code="$(curl -s -o /dev/null -w '%{http_code}' \
  --resolve "${SITE_NAME}:${BACKEND_PORT}:127.0.0.1" \
  "http://${SITE_NAME}:${BACKEND_PORT}/api/method/ping" || true)"
[ "$code" = "200" ] && ok "ping 200" || fail "ping returned $code"

log "2. erpnext + crypto_payroll installed"
apps="$(bench_site list-apps)"
echo "$apps" | grep -qw erpnext        || fail "erpnext not installed"
echo "$apps" | grep -qw crypto_payroll || fail "crypto_payroll not installed"
ok "both apps installed"

log "3. The 5 DocTypes exist"
count="$(bench_site execute frappe.client.get_count \
  --kwargs '{"doctype":"DocType","filters":{"module":"Crypto Payroll"}}' | tr -dc '0-9')"
[ "$count" = "5" ] && ok "5 DocTypes" || fail "expected 5 DocTypes, got '$count'"

log "4. Seed present (Company + 4 accounts)"
bench_site execute frappe.client.get_value \
  --kwargs '{"doctype":"Company","filters":{"name":"ChainPay Test"},"fieldname":"name"}' \
  | grep -q "ChainPay Test" || fail "Company missing"
acc_count="$(bench_site execute frappe.client.get_count \
  --kwargs '{"doctype":"Account","filters":{"company":"ChainPay Test","account_name":["in",["Salary or Wage Expense","Crypto Treasury Asset","Network Fee Expense","FX Gain/Loss"]]}}' \
  | tr -dc '0-9')"
[ "$acc_count" = "4" ] && ok "4 GL accounts" || fail "expected 4 accounts, got '$acc_count'"

log "5. A balanced Journal Entry posts and cancels"
bench_site execute crypto_payroll.setup.smoke_je.post_and_cancel || fail "JE post/cancel failed"
ok "JE post + cancel"

echo
echo "ALL SMOKE CHECKS PASSED"
