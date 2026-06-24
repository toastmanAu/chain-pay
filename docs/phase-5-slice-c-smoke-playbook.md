# Phase 5 / Slice C — accounting bridge smoke playbook

End-to-end manual verification that a confirmed payroll batch automatically
posts a Journal Entry in ERPNext via the accounting bridge.

## Prerequisites

- Docker running; `docker/.env` populated (see the Slice B playbook for first-time
  setup: `docs/phase-5-slice-b-smoke-playbook.md`).
- The desktop app built or dev-served with the three `FRAPPE_*` env vars in the
  **main-process environment** (see "Env vars" below).

---

## Step 1 — Start the backend

```bash
bash scripts/backend-up.sh
```

`backend-up.sh` is idempotent. It ensures:

- The Docker stack is running and MariaDB is healthy.
- `crypto_payroll` is pip-installed in the venv and migrated.
- The seed is applied: Company `ChainPay Test` + 4 GL accounts.
- The `crypto_batch_id` custom field exists on Journal Entry (unique, read-only).
- A Fiscal Year covering today and a leaf Cost Center are present.
- The 5 smoke checks pass (`ALL SMOKE CHECKS PASSED`).

> **Self-healing on every call:** the `post_journal` endpoint itself calls
> `ensure_fiscal_year()` and `ensure_cost_center()` before inserting a Journal
> Entry, so even if the seed step was skipped or the Fiscal Year rolled over,
> the endpoint re-creates the required records on demand.

ERPNext is at `http://chainpay.localhost:${BACKEND_PORT}` (default port 8000).
Login: **Administrator** / the `ADMIN_PASSWORD` in `docker/.env` (default: `admin`).

---

## Step 2 — Mint a Frappe API key and grant an Accounts role

The `post_journal` endpoint is role-gated: `frappe.only_for(["Accounts Manager",
"Accounts User"])`. The API user whose key and secret the desktop sends **must**
hold one of those roles.

> **Administrator short-cut for local dev:** The built-in Administrator account
> is a Frappe superuser and already holds all roles. `frappe.only_for` never
> rejects it, so you can use Administrator's API key/secret for local-dev smoke
> without any extra role grant. For a dedicated service account (recommended for
> staging/production) follow 2a below.

### 2a — Create (or reuse) a service account and grant the role

**Via the ERPNext UI (primary):**

1. Open `http://chainpay.localhost:${BACKEND_PORT}` and log in as Administrator.
2. Navigate to **User** (search "User" in the top bar or go to
   `Settings → User`).
3. Open the target user (or create a new one with a valid e-mail).
4. In the **Roles** table, add **Accounts Manager** (or Accounts User).
5. Save.

**Via `bench` console (alternative):**

```bash
docker compose -f docker/docker-compose.yml exec backend \
  bench --site chainpay.localhost console
```

Then in the interactive Python console:

```python
user = frappe.get_doc("User", "service@example.com")
user.add_roles("Accounts Manager")
frappe.db.commit()
```

Replace `service@example.com` with the actual user e-mail.

### 2b — Generate an API key and secret

**Via the ERPNext UI:**

1. Open the target user's document.
2. In the top-right menu (⋮ or the "API Access" button depending on ERPNext
   version), click **Generate Keys** (or **API Access → Generate Keys**).
3. Copy the **API Key** and **API Secret** — the secret is shown only once.

**Via `bench` console (alternative):**

```bash
docker compose -f docker/docker-compose.yml exec backend \
  bench --site chainpay.localhost execute frappe.core.doctype.user.user.generate_keys \
  --kwargs '{"user":"Administrator"}'
```

The output prints both values.

---

## Step 3 — Set the FRAPPE_* env vars in the desktop main process

The accounting host (`electron/main/accounting-host.ts`) reads three variables
from `process.env`. They must be present in the **Electron main-process
environment** — set them before launching the desktop app:

| Variable | Value |
|---|---|
| `FRAPPE_URL` | `http://chainpay.localhost:${BACKEND_PORT}` (e.g. `http://chainpay.localhost:8000`) |
| `FRAPPE_API_KEY` | The key generated in Step 2b |
| `FRAPPE_API_SECRET` | The secret generated in Step 2b |

**Critical — Host-header routing:** Frappe routes requests by the HTTP `Host`
header. A request to `http://localhost:8000` returns a 404 because no site is
named `localhost`. `FRAPPE_URL` **must** be the site host
(`http://chainpay.localhost:PORT`); Node's `fetch` derives the `Host` header
from the URL automatically.

**Never put these values in the renderer or commit them to the repo.**

Example (dev launch from the repo root):

```bash
FRAPPE_URL=http://chainpay.localhost:8000 \
FRAPPE_API_KEY=<key> \
FRAPPE_API_SECRET=<secret> \
npm run dev --workspace=apps/desktop
```

---

## Step 4 — Drive a payroll batch to `confirmed`

Follow the Phase 2.5 smoke path (`docs/phase-2.5-smoke-playbook.md`):

1. Open the desktop app.
2. Create a payroll batch with at least one payment line.
3. Collect partial signatures from the required signers (threshold reached).
4. Broadcast the multisig transaction.
5. Wait for confirmation (or, in a test environment, use the `confirmed` mock trigger).

The batch status transitions: `draft → signing → signed → broadcasting → confirmed`.

---

## Step 5 — Verify the Journal Entry

Once the batch reaches `confirmed` the accounting reactor fires automatically.
The batch status transitions through `posting` (brief, in-flight) and then:

**Expected success path:**

1. The batch row in the desktop UI shows:
   `Posted · ACC-JV-YYYY-MM-DD-NNNNN` (the ERPNext JE name).
2. In ERPNext, navigate to **Accounting → Journal Entry** and search by the JE
   name, or filter by `crypto_batch_id = <batch-id>`.
3. The Journal Entry should be:
   - **Status:** Submitted
   - **Company:** ChainPay Test
   - **`crypto_batch_id`:** the batch's ID
   - **Accounts:** a balanced set of debit/credit rows (Salary or Wage Expense
     debited; Crypto Treasury Asset credited; Network Fee Expense if fee > 0).
   - **Cost Center:** the leaf cost center from the seed (on debit rows).

---

## Step 6 — Verify idempotency (no duplicate JE)

Without changing anything, trigger a reload or re-confirmation of the same batch
(e.g. force a React re-render, or simulate a second `confirmed` event via the
store). This exercises the double-fire guard:

1. The reactor sees the batch is already in state `posting` or `posted` and
   does nothing (the in-flight guard prevents re-entry).
2. Even if a second POST reaches Frappe, the backend checks for an existing JE
   with the same `crypto_batch_id` and returns `{"je_name": ..., "idempotent": true}`
   — no duplicate is created.
3. The batch stays in `posted`; the JE name is unchanged.

---

## Step 7 — Verify `post_failed` and Retry

### 7a — Stop the backend while a batch is being confirmed

```bash
bash scripts/backend-down.sh
```

Now drive a **new** batch to `confirmed` (repeat Step 4 with a different batch).
The accounting host cannot reach Frappe; the HTTP POST fails.

Expected: the batch row shows `Post failed · <error message>` with a **Retry**
button.

### 7b — Restart the backend and retry

```bash
bash scripts/backend-up.sh
```

Wait for `ALL SMOKE CHECKS PASSED`. Then click **Retry** on the failed batch in
the desktop UI.

Expected:
1. The batch transitions back through `posting` and then to `posted`.
2. A new Journal Entry is created in ERPNext (since no JE existed for this
   batch — the previous attempt failed before creating one).
3. The batch row shows `Posted · ACC-JV-…`.

---

## Known residual — trust-the-client (Slice E prerequisite)

The `post_journal` endpoint currently **trusts the caller-supplied `preview`**
(accounts and amounts). It is bounded by the role gate and company-bound account
existence checks, but amounts are **not** independently verified against a
server-side source of truth (batches are not persisted in ERPNext until Slice E).

**This is a production blocker.** Before any real-money use, Slice E must:
- Persist `Crypto Payment Batch` records in ERPNext, and
- Have `post_journal` verify (or derive) the JE from that persisted, confirmed
  batch rather than trusting the `preview` payload.

See the design spec for the full security discussion:
`docs/superpowers/specs/2026-06-24-phase-5-slice-c-accounting-bridge-design.md`
(§ Security → Known residual).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Batch stuck on `post_failed`: `FRAPPE_URL not configured` | Env var missing from main-process env | Set all three `FRAPPE_*` vars before launching the desktop app |
| Frappe returns 404 | `FRAPPE_URL` set to `http://localhost:PORT` instead of site host | Use `http://chainpay.localhost:PORT` |
| Frappe returns 403 | API user lacks Accounts Manager / Accounts User role | Grant the role in ERPNext User document (Step 2a) |
| Frappe returns 417 `batch_id is required` | Batch ID missing from IPC payload | Check IPC bridge wiring |
| Frappe returns 417 `unbalanced journal` | `buildBatchJournal` produced unbalanced output | Should not happen; check `batch-to-journal-inputs.ts` |
| Frappe returns 417 `unknown account` | Account name in preview does not exist in ChainPay Test | Re-run `backend-up.sh` to re-apply seed |
| JE created but not submitted | `je.submit()` failed (e.g. missing Fiscal Year) | Re-run `backend-up.sh`; `ensure_fiscal_year()` and `ensure_cost_center()` are called by the endpoint |
| Duplicate JE created | Idempotency field `crypto_batch_id` not unique-indexed | Check that `backend-up.sh` ran `ensure_custom_fields` successfully |
| `*.localhost` does not resolve | System lacks systemd-resolved | Add `127.0.0.1 chainpay.localhost` to `/etc/hosts` |
