# ChainPay backend

ERPNext + Frappe HR + custom `crypto_payroll` Frappe app.

**Status:** Phase 0 skeleton. The Python code below documents the intended DocType schemas and module layout — actual installation lands in **Phase 4**.

## Phase 4 setup (preview)

```bash
# Inside this directory
docker compose -f ../../docker/docker-compose.yml up -d
docker exec -it chainpay-frappe bash

bench init frappe-bench --skip-redis-config-generation
cd frappe-bench
bench new-site chainpay.local
bench get-app erpnext --branch version-15
bench get-app https://github.com/frappe/hrms --branch develop
bench install-app erpnext
bench install-app hrms

# Install our custom app from the local path
bench get-app crypto_payroll /workspace/apps/crypto_payroll
bench install-app crypto_payroll

bench start
```

## DocType list (custom app)

| DocType | Purpose |
|---|---|
| Crypto Wallet | A multisig treasury (CKB or EVM). Stores config blob, address, chain. |
| Crypto Payee Profile | Per-employee/contractor crypto payment preferences. |
| Crypto Payment Batch | Payroll run for a cycle — produces one multisig tx. |
| Crypto Payment | A single output line within a batch. |
| Crypto Transaction | Confirmed on-chain tx with hash, block, network fee, FX rate snapshot. |
| Crypto Exchange Rate | FX rate snapshots at payment time, for audit. |
| Crypto Network Fee | Per-tx network fee record (separate so accounting can reference). |
| Crypto Audit Log | Immutable append-only log of every approval/sign/broadcast action. |
| Fiat Ramp Provider | Adapter config for Stripe / Coinbase / Transak / Banxa. Phase 5. |
| Chain Adapter Config | Per-network settings (RPC URL fallback, light client toggle, gas defaults). |

## API surface (preview)

Same as `chainPay` text spec — endpoints under `/api/method/crypto_payroll.api.*`. See [../../docs/api-contract.md](../../docs/api-contract.md).
