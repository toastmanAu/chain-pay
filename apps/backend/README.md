# ChainPay backend

ERPNext + Frappe HR + custom `crypto_payroll` Frappe app.

**Status:** Phase 5 / Slice B — scripted local environment with ERPNext + crypto_payroll.

## Local standup (Phase 5 / Slice B)

The environment is fully scripted. From the repo root:

```bash
cp .env.example docker/.env   # first time only; set BACKEND_PORT if host :8000 is taken
./scripts/backend-up.sh       # first run pulls a multi-GB image (~10–20 min)
```

ERPNext is then at `http://chainpay.localhost:${BACKEND_PORT}` (default port 8000).
Login: Administrator / `ADMIN_PASSWORD` from `docker/.env` (default: `admin`).

See [../../docs/phase-5-slice-b-smoke-playbook.md](../../docs/phase-5-slice-b-smoke-playbook.md)
for full details: URL routing, smoke assertions, test mode, reset, reproducibility,
and troubleshooting. HRMS and additional DocTypes are added by later slices.

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
