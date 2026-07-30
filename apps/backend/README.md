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

For local desktop accounting, generate an ignored, mode-0600 credential file and
launch Electron with it:

```bash
bash scripts/configure-local-accounting.sh
npm run dev:desktop:accounting
```

The generated `apps/desktop/.env.accounting.local` is main-process-only and is
ignored by Git. Regenerating it rotates the local Administrator API secret.
Login: Administrator / `ADMIN_PASSWORD` from `docker/.env` (default: `admin`).

See [../../docs/phase-5-slice-b-smoke-playbook.md](../../docs/phase-5-slice-b-smoke-playbook.md)
for full details: URL routing, smoke assertions, test mode, reset, reproducibility,
and troubleshooting. HRMS and additional DocTypes are added by later slices.

## DocType list (custom app)

| DocType | Purpose |
|---|---|
| Crypto Wallet | A multisig treasury (CKB or EVM). Stores config blob, address, chain. |
| Crypto Payee Profile | Per-employee/contractor crypto payment preferences. |
| Crypto Payment Batch | Immutable submitted source record for a confirmed send/payroll transaction. |
| Crypto Payment Line | A fiat + crypto output inside a confirmed payment record. |
| Crypto Transaction | Confirmed on-chain tx with hash, block, network fee, FX rate snapshot. |
| Crypto Exchange Rate | FX rate snapshots at payment time, for audit. |
| Crypto Network Fee | Per-tx network fee record (separate so accounting can reference). |
| Crypto Audit Log | Immutable append-only log of every approval/sign/broadcast action. |
| Fiat Ramp Provider | Adapter config for Stripe / Coinbase / Transak / Banxa. Phase 5. |
| Chain Adapter Config | Per-network settings (RPC URL fallback, light client toggle, gas defaults). |

## Accounting bridge (desktop → Frappe)

The Electron **main** process posts confirmed payment records to ERPNext via
the `crypto_payroll.api.post_confirmed_payment` whitelisted endpoint. Frappe
persists and submits the source record before deriving the Journal Entry using
server-owned account mappings. The desktop never selects GL accounts. Three env vars must
be present in the **main-process environment** before launching the desktop app:

| Variable | Description |
|---|---|
| `FRAPPE_URL` | ERPNext site base URL — **must** be the site host, e.g. `http://chainpay.localhost:8000`. Never `http://localhost:PORT` (Frappe routes by HTTP `Host` header; a bare `localhost` request returns 404). |
| `FRAPPE_API_KEY` | API key for the Frappe service account. |
| `FRAPPE_API_SECRET` | API secret for the Frappe service account (one-time reveal on generation). |

**These values must never appear in the renderer process and must never be
committed to the repository.**

### Accounts-role requirement

The persistence and journal endpoints are role-gated:

```python
frappe.only_for(["Accounts Manager", "Accounts User"])
```

The API user whose key/secret the desktop uses must hold **Accounts Manager**
or **Accounts User** in ERPNext. To grant it:

1. Log in to ERPNext as Administrator.
2. Open the target user's document (`Settings → User`).
3. Add **Accounts Manager** (or Accounts User) in the **Roles** table and save.

The built-in Administrator account already holds all roles and can be used for
local development.

### Generating API keys

In ERPNext, open the user document and click **API Access → Generate Keys** (or
use the ⋮ menu). Copy both values — the secret is shown only once. Store them
in your shell profile or a local secrets tool; never in source control.

### Host-header routing note

Frappe's `bench serve` routes requests by the HTTP `Host` header to the correct
site. `FRAPPE_URL` must therefore resolve to the site host
(`http://chainpay.localhost:PORT`). Node's `fetch` derives the `Host` header
from the URL automatically, so no manual header override is needed — just set
the URL correctly.

See the full walkthrough in
[../../docs/phase-5-slice-c-smoke-playbook.md](../../docs/phase-5-slice-c-smoke-playbook.md).

## API surface (preview)

Same as `chainPay` text spec — endpoints under `/api/method/crypto_payroll.api.*`. See [../../docs/api-contract.md](../../docs/api-contract.md).
