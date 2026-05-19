# crypto_payroll

Custom Frappe app extending ERPNext + Frappe HR with crypto-native payroll & treasury.

This directory will become a real Frappe app in Phase 4 via `bench new-app crypto_payroll`. Until then, the DocType JSON stubs and service module names below act as a design contract.

## Module layout

```
crypto_payroll/
  hooks.py             Frappe app hooks (events, fixtures, scheduler)
  modules.txt          Single line: "Crypto Payroll"
  doctype/             DocType schemas (JSON + .py controller)
    crypto_wallet/
    crypto_payee_profile/
    crypto_payment_batch/
    crypto_payment/
    crypto_transaction/
  api/                 @frappe.whitelist() REST endpoints
    payroll.py
    wallets.py
    payments.py
    accounting.py
    exchange_rates.py
    compliance.py
  services/            Business logic — never accessed directly by REST
    payout_engine.py
    accounting_bridge.py
    pricing.py
    audit.py
    risk.py
    chains/
      base.py
      ckb.py
      ethereum.py
      bitcoin.py        # Phase 5
      solana.py         # Phase 5
```

## Rules

1. **No private keys, ever.** Backend coordinates multisig — frontends + co-signer wallets sign.
2. **Every confirmed payment must call `accounting_bridge.post_journal()`.** No silent settlements.
3. **Audit log is append-only.** Use `frappe.log_error` or a dedicated DocType — never delete entries.
4. **REST endpoints are thin.** They validate input, call a service, return shape. No business logic.
