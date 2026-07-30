# API contract

Frappe REST endpoints exposed by the `crypto_payroll` app. Implemented methods
are directly under `/api/method/crypto_payroll.api.*`; the remaining names are
roadmap contracts.

## Conventions

- Auth: Frappe API key + secret in `Authorization: token <key>:<secret>`
- All requests `application/json`
- Successful responses `{ "message": <payload> }` per Frappe convention
- Errors return Frappe's standard error shape (`{ "exc_type": "...", "exception": "..." }`) plus HTTP 4xx/5xx

## Wallets

| Method | Endpoint | Body | Returns |
|---|---|---|---|
| GET | `crypto_payroll.api.wallets.list_wallets` | — | `Treasury[]` |
| POST | `crypto_payroll.api.wallets.create_wallet` | `{ label, chain, config }` | `Treasury` |
| POST | `crypto_payroll.api.wallets.validate_address` | `{ chain, address }` | `{ valid, reason?, normalized? }` |

## Payroll batches

| Method | Endpoint | Body | Returns |
|---|---|---|---|
| GET | `crypto_payroll.api.payroll.list_batches` | — | `PayrollBatch[]` |
| POST | `crypto_payroll.api.payroll.create_batch` | `{ label, treasury_id, cycle_start, cycle_end }` | `PayrollBatch` |
| POST | `crypto_payroll.api.payroll.calculate_batch` | `{ batch_id }` | `PayrollBatch` with `lines` populated and `fx_snapshot` taken |
| POST | `crypto_payroll.api.payroll.approve_batch` | `{ batch_id }` | `PayrollBatch` with `state=approved` |

## Payments (multisig coordination)

| Method | Endpoint | Body | Returns |
|---|---|---|---|
| POST | `crypto_payroll.api.payments.prepare_payment` | `{ batch_id }` | `PendingTx` |
| POST | `crypto_payroll.api.payments.mark_signed` | `{ pending_tx_id, signer_hash, signature_bytes_hex }` | `PendingTx` with updated `signatures` |
| POST | `crypto_payroll.api.payments.broadcast` | `{ pending_tx_id }` | `{ tx_hash }` |
| GET | `crypto_payroll.api.payments.status` | `?pending_tx_id=<id>` | `PendingTx` |

## Accounting

| Method | Endpoint | Body | Returns |
|---|---|---|---|
| POST | `crypto_payroll.api.persist_confirmed_payment` | `{ record: ConfirmedPaymentRecord }` | `{ batch_name, idempotent }` |
| POST | `crypto_payroll.api.post_journal` | `{ batch_id }` | `{ je_name, idempotent }` |
| POST | `crypto_payroll.api.post_confirmed_payment` | `{ record: ConfirmedPaymentRecord }` | persist + post result |

`ConfirmedPaymentRecord` contains `batchId`, `sourceType`, `label`, `chain`,
`txHash`, `confirmedAt`, and payment `lines` with fiat/crypto values. It cannot
contain GL account selections. Frappe stores it as a submitted
`Crypto Payment Batch` and derives the Journal Entry from server-owned mappings.

## Exchange rates

| Method | Endpoint | Body | Returns |
|---|---|---|---|
| GET | `crypto_payroll.api.exchange_rates.latest` | `?base=USD&quotes=CKB,ETH` | `FxQuote[]` |
| POST | `crypto_payroll.api.exchange_rates.refresh` | `{ base, quotes[] }` | `FxQuote[]` |

## Compliance

| Method | Endpoint | Body | Returns |
|---|---|---|---|
| GET | `crypto_payroll.api.compliance.audit_export` | `?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv\|pdf` | binary download |

## Type references

All TypeScript types here live in `packages/shared/src/`. The Python side mirrors them in DocType controllers and serialises matching JSON shapes. Drift between the two is a code-review blocker.
