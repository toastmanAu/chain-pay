# Phase 5 / Slice C — Accounting Bridge + Accounting REST

**Date:** 2026-06-24
**Status:** Design approved, pending implementation plan
**Predecessors:** Slice A (`buildBatchJournal`, merged #13), Slice B (Frappe env standup, merged #14)

## Goal

A thin vertical slice: when a payroll batch reaches `confirmed`, automatically build its
balanced journal (Slice A's `buildBatchJournal`), POST it to a new whitelisted Frappe REST
endpoint that creates and submits a real ERPNext Journal Entry, and record the returned JE
name back on the batch. Honors hard-rule #5 ("every confirmed payment posts a journal entry").

## Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope | Full vertical: confirm → POST → JE recorded |
| 2 | Transport + auth | Electron **main** holds Frappe creds; renderer triggers via typed IPC; creds never in renderer |
| 3 | Trigger | **Automatic** on `confirmed` + **manual retry** on failure |
| 4 | Idempotency anchor | Custom field `crypto_batch_id` on Journal Entry, **unique** index |
| 5 | Account mapping | Hardcoded default map matching the 4 seeded accounts (configurable = later slice) |
| 6 | Async lifecycle model | **Approach A**: extend `PayrollBatchState` with `posting / posted / post_failed` |

## Architecture & data flow

```
batch → confirmed
  └─ reactor (renderer)  use-batch-confirmation-to-accounting.ts
       ├─ store.markPosting(batchId)                    ← in-flight guard (state = "posting")
       ├─ preview = buildBatchJournal(batchToInputs(batch), accountMap)
       └─ ipc.postJournal(batchId, preview) ──IPC──▶ accounting-host (main)
                                                          ├─ reads FRAPPE_URL / KEY / SECRET (env)
                                                          └─ POST /api/method/crypto_payroll.api.post_journal
                                                                  └─▶ Frappe: idempotency check
                                                                       → create+submit JE → {je_name}
       ◀── {je_name, idempotent} ───────────────────────────────────────────────────────────┘
       ├─ success → store.markPosted(batchId, jeName)   → UI shows JE name
       └─ failure → store.markPostFailed(batchId, msg)  → UI shows error + [Retry]
```

Single source of truth = the batch's own state. The backend's unique `crypto_batch_id`
index is the second line of defense: even if the known React-19 double-effect slips a second
fire through before `markPosting` lands, the endpoint returns the existing JE rather than
creating a duplicate.

The reactor mirrors the existing synchronous `useBatchConfirmationSync`
(`src/lib/invoices/use-batch-confirmation-to-invoice.ts`), with the critical difference that
posting is **async** — so the `posting` state is what prevents re-entry during the IPC round-trip.

## Components

### Backend — `apps/backend/apps/crypto_payroll`

- **`crypto_payroll/setup/custom_fields.py`** — idempotently ensures a `crypto_batch_id`
  Custom Field on `Journal Entry` (`fieldtype: Data`, `unique: 1`, `read_only: 1`,
  `no_copy: 1`). Invoked from `backend-up.sh` alongside seed, because the container's `env/`
  is not volume-persisted and editable installs are re-registered every boot (Slice B gotcha #4).

- **`crypto_payroll/api.py`** — `@frappe.whitelist()` `post_journal(batch_id, preview)`,
  `allow_guest=False` (auth required):
  1. **Validate** payload: `batch_id` non-empty; `preview.entries` non-empty; each entry has
     an `account` and exactly one of `debit` / `credit`.
  2. **Idempotency:** if a JE exists with `crypto_batch_id == batch_id`, return
     `{je_name, idempotent: true}` without creating anything.
  3. **Map** preview entries → JE account rows: `debit_in_account_currency` /
     `credit_in_account_currency` derived from `FiatAmount.minor` converted to major units by
     the currency's precision; `cost_center` set on debit rows (leaf cost center from seed).
  4. **Balance assertion:** Σ(debits) == Σ(credits); `frappe.throw` if not (defense in depth —
     `buildBatchJournal` already balances).
  5. Set `crypto_batch_id = batch_id`, optional `user_remark` from memo; `insert()` + `submit()`.
  6. Return `{je_name, idempotent: false}`.

- **`crypto_payroll/setup/seed.py`** — **move** `_ensure_fiscal_year` and `_ensure_cost_center`
  here from `smoke_je.py` (deferred handoff item) so the seed delivers a *postable* GL.
  `smoke_je.py` imports them from seed. Add a seed test asserting the Fiscal Year and a leaf
  Cost Center exist after `run()`.

- **Frappe tests** (`setup/test_*.py` style, run via `bench run-tests`):
  - posts a balanced, submitted JE carrying `crypto_batch_id`;
  - re-posting the same `batch_id` returns the same `je_name` and creates no duplicate;
  - an unbalanced payload is rejected;
  - a payload naming a non-existent account is rejected;
  - a payload with zero fee and zero FX still balances (fee/FX lines omitted upstream).

### Desktop — `apps/desktop`

- **`electron/main/accounting-host.ts`** — holds Frappe base URL + API key/secret from
  `process.env` (`FRAPPE_URL`, `FRAPPE_API_KEY`, `FRAPPE_API_SECRET`); exposes
  `postJournal(batchId, preview): Promise<PostJournalResult>` doing the Node-side HTTP POST.
  Mirrors `light-client-host.ts`. Fails fast with a clear error if creds are absent.
  **Slice B gotcha #1:** Frappe's `bench serve` routes by HTTP `Host` header — a plain
  `localhost:PORT` request 404s. `FRAPPE_URL` must resolve to the site host
  (`chainpay.localhost:PORT`), or the request must carry an explicit `Host: chainpay.localhost`
  header. This is recorded in the smoke playbook and must be honored by the host module.

- **Typed IPC** — `accounting:postJournal` channel registered in the preload bridge; renderer
  wrapper `src/lib/accounting/ipc.ts` with a zod-validated request/response.

- **`src/lib/accounting/account-map.ts`** — centralized default mapping:
  `{ salary: "Salary or Wage Expense", treasury: "Crypto Treasury Asset",
  networkFeeExpense: "Network Fee Expense", fxGainLoss: "FX Gain/Loss" }`.

- **`src/lib/accounting/batch-to-journal-inputs.ts`** — maps a `PayrollBatch` →
  `PaymentJournalInput[]`. Carrying-cost / FX policy lives here (see below).

- **`src/lib/accounting/post-batch-journal.ts`** — the shared execution function
  `postBatchJournal(batchId)`: `markPosting` → build preview → `ipc.postJournal` →
  `markPosted` / `markPostFailed`. Called by **both** the reactor (on `confirmed`) and the
  Retry handler (on `post_failed`), so the two triggers share one code path.

- **`src/lib/accounting/use-batch-confirmation-to-accounting.ts`** — reactor subscribing to
  the payroll-batches store; for each batch in `confirmed`, calls `postBatchJournal`. Fires
  only on `confirmed` (the `posting` transition inside `postBatchJournal` is the re-entry guard).
  Retry is a **separate explicit trigger** from the UI that also calls `postBatchJournal` — it
  does not depend on the reactor, which never watches `post_failed`.

- **State machine** (`src/lib/payroll/state-machine.ts`, `packages/shared/src/payroll.ts`) —
  add `posting | posted | post_failed` to `PayrollBatchState`; add `jeName?: string` and
  `postError?: string` to `PayrollBatch`; transitions `confirmed → posting → posted | post_failed`
  and `post_failed → posting` (retry). Store actions `markPosting / markPosted / markPostFailed`.

- **UI** (`src/features/payroll/PayrollBatches.tsx`) — render `posted` (JE name) and
  `post_failed` (error + **Retry** button). Retry calls `postBatchJournal(batchId)` directly.

## Carrying cost / FX policy (this slice)

`buildBatchJournal` computes FX gain/loss as the balancing plug:
`(obligation + feeFiat) − carryingCost`. A faithful carrying cost requires lot / cost-basis
tracking (which crypto lots were disposed and at what acquisition price) — a system that does
not exist yet. For this slice:

- **`carryingCost = obligation + feeFiat`** ⇒ FX gain/loss is **zero** ⇒ no FX line emitted.

This is honest (we do not fabricate an FX figure we cannot source) and is documented as a
placeholder until a dedicated lot-tracking slice. `feeFiat` is derived from the line's
`feeAllocated` (crypto) converted at the line's `fxRate`; `obligation` is the line's `fiat`.

## Error handling

- Network/HTTP failure or Frappe validation error → `post_failed` with the message; retryable.
- Idempotent re-post (`idempotent: true`) → treated as success, JE name recorded.
- Missing Frappe creds in main → fail fast with a clear, non-leaking error.
- IPC payload validated with zod on the renderer boundary; server-side validated with `frappe.throw`.

## Security

- Frappe API key/secret live only in the Electron **main** process (env). The renderer never
  receives them.
- Endpoint is `@frappe.whitelist()` with `allow_guest=False` — authenticated API user only.
- Input validation on both boundaries (zod renderer/main; `frappe.throw` server-side).
- No secrets logged. Error messages surfaced to the UI carry no credentials or internal paths.

## Testing

- **Backend:** the Frappe tests listed above.
- **Desktop unit (vitest):**
  - `batch-to-journal-inputs` produces correct `PaymentJournalInput[]` (incl. zero-FX);
  - reactor transitions: `confirmed → posting → posted`, `→ post_failed` on rejection, and the
    **double-fire guard** (a second invocation while `posting` is a no-op);
  - IPC client maps success and error responses;
  - state-machine transitions including `post_failed → posting` retry.
- **Manual smoke** (new playbook `docs/phase-5-slice-c-smoke-playbook.md`): a confirmed batch
  yields a submitted JE in ERPNext carrying `crypto_batch_id`; re-triggering creates no
  duplicate; stopping the backend drives `post_failed`; **Retry** after restart succeeds.

## Scope boundaries (YAGNI)

- Single company (`ChainPay Test`), single fiat currency, hardcoded account map.
- Zero-FX carrying cost; lot / cost-basis tracking deferred.
- **No** batch persistence in ERPNext — that is Slice E ("replace renderer Zustand with REST").
- Bridge is chain-agnostic via the `AccountingJournalPreview` contract, but only CKB batches
  are exercised this slice (EVM/Safe batches arrive with Phase 3 / later).

## Out of scope / follow-ups

- Configurable account mapping (per chain / per department) — Slice D/E.
- Lot-based cost basis and real FX gain/loss — dedicated future slice.
- Persisting `Crypto Payment Batch` records in ERPNext — Slice E.
