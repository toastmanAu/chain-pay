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

For `btc:testnet` and `btc:mainnet`, `bitcoin` is required and contains the
review digest, txid-adjacent wtxid/raw-byte identity, canonical block
height/hash and depth, exact input/output/fee satoshis, fee rate and
`transaction_inputs` fee policy, plus the ordered accounting output mapping.
Every payment line must be BTC with 8 decimals and match its mapped output.
Depth below six, malformed addresses, mismatched conservation/mappings,
cross-chain metadata, caller account names, and reused txids or review digests
with changed data are rejected.

## Exchange rates

| Method | Endpoint | Body | Returns |
|---|---|---|---|
| GET | `crypto_payroll.api.exchange_rates.latest` | `?base=USD&quotes=CKB,ETH` | `FxQuote[]` |
| POST | `crypto_payroll.api.exchange_rates.refresh` | `{ base, quotes[] }` | `FxQuote[]` |

## Compliance

| Method | Endpoint | Body | Returns |
|---|---|---|---|
| POST | `crypto_payroll.api.export_compliance` | `{ filters: { from_date?, to_date?, chain? }, format: "csv"\|"pdf" }` | `{ filename, mime_type, bytes_base64, sha256, row_count }` |

The endpoint accepts filters only. It selects submitted, confirmed
`Crypto Payment Batch` records with posted Journal Entries, verifies each
source→journal identity binding, and assembles rows server-side. Dates are
inclusive `YYYY-MM-DD` values and `chain`, when supplied, is one of
`ckb:mainnet`, `ckb:testnet`, `evm:11155111`, `sol:devnet`, `sol:mainnet`,
`btc:testnet`, or `btc:mainnet`. Both Accounts Manager and
Accounts User may export. Empty result sets and malformed/unknown filters are
errors rather than ambiguous empty files.

CSV and PDF contain the same ordered payment evidence. The response digest is
checked again in Electron main before its native save dialog writes the file;
credentials and report bytes do not cross into renderer JavaScript.

## Type references

All TypeScript types here live in `packages/shared/src/`. The Python side mirrors them in DocType controllers and serialises matching JSON shapes. Drift between the two is a code-review blocker.
