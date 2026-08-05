# Accounting model

Every confirmed crypto payment posts a balanced journal entry into ERPNext. This document specifies exactly what gets posted.

## Trusted source record

Before posting, Frappe persists a submitted `Crypto Payment Batch` with child
`Crypto Payment Line` rows. Its canonical digest, external batch ID, and chain
transaction hash are immutable and unique. The journal endpoint accepts only
the batch ID; account names and amounts cannot be supplied in the posting call.

## Per-payment entries

For a single payroll payment of `X` crypto to a payee, where the fiat-denominated obligation was `F`:

| Account | Debit | Credit | Memo |
|---|---|---|---|
| `Salary or Wage Expense` (payee dept) | F | | Per payslip |
| `Crypto Treasury Asset` (per-chain sub-account) | | F (at carrying cost) | Outflow of crypto |
| `Network Fee Expense` | fee_F | | Network fee in fiat at confirmation rate |
| `FX Gain/Loss` | (signed) | (signed) | Difference between carrying cost and current rate |

**Carrying cost vs current rate:** crypto on the books has a basis (acquired at price X). When you pay someone with it, the "expense" is denominated in the payee's salary fiat, but the asset moving out comes off the books at its carrying cost. The FX gain or loss is the difference.

## Per-batch summary entry

In addition to per-payment entries, each batch posts one summary entry for accounting clarity:

| Field | Value |
|---|---|
| Batch ID | `BATCH-YYMM-####` |
| Cycle | start → end |
| Total fiat paid | sum of all `salary_fiat` |
| Total crypto out | sum per (chain, asset) |
| Total network fees | sum |
| FX gain/loss | sum |
| Tx hash | broadcast tx hash |
| Confirmed at | block timestamp |

## Required attributes for compliance

Every `Crypto Transaction` DocType row must store:

1. **Tx hash** — chain reference, immutable
2. **Block number** — auditable on-chain
3. **Confirmed timestamp** — block time, UTC
4. **Amount in native units** — exact BigInt as string
5. **Amount in fiat at confirmation** — for tax/reporting
6. **FX rate** — exact decimal string, with `source` and `taken_at`
7. **Network fee** — both native and fiat
8. **Payee Frappe ref** — link to Employee or Supplier

This is the minimum set for typical jurisdictions (AU/US/UK/EU). Per-jurisdiction reporting templates live in `compliance.py` (Phase 4).

## FX rate handling

- FX rate is **snapshotted at calculation time** (batch state `calculated`) — locks in payslip values.
- FX rate is **snapshotted again at confirmation time** — drives FX gain/loss.
- Both snapshots store: `base`, `quote`, `rate`, `source`, `taken_at`.
- Difference between the two snapshots is the **slippage component** of FX gain/loss; isolate it from carrying-cost FX so the auditor can see the parts.

## Provider strategy

- **Primary:** CoinGecko API
- **Sanity check:** Coinbase or another independent feed; warn if > 1 % drift
- **Manual override:** any user with `System Manager` role can override per-batch (logged to audit)

## Current CKB accounting scope

The shipped CKB send path uses the entered fiat obligation as carrying cost
(zero-FX) and derives Salary/Wage Expense debit plus Crypto Treasury Asset
credit. The richer fee, FX, and cost-basis rows below remain the next accounting
extension.

## Current native-SOL accounting scope

A Solana payment commits one payee reference and positive USD obligation in a
version-2 review digest before any signature is accepted. ERPNext receives a
source record only after main-process validation of finalized legacy-transaction
bytes, the submitted signature, durable-nonce instruction order, actual fee,
slot, and block time. SOL is stored as exact lamport text with 9 decimals.

The current zero-FX policy books the committed USD obligation as a balanced
Salary/Wage Expense debit and Crypto Treasury Asset credit. The actual network
fee and its transaction fee payer remain immutable audit metadata; they do not
change the journal value until the fee/cost-basis extension is implemented.
Legacy version-1 Solana reviews have no committed accounting intent and are
never posted.

## Current native-BTC accounting scope

Bitcoin accounting begins only with a version-2 broadcast review. Before the
operator can approve broadcast, every positive external output is mapped in
canonical vout order to its immutable destination, exact satoshis, payee
reference, and positive USD obligation. Watched outputs are change candidates;
zero-value OP_RETURN outputs are metadata. The mapping is operator-approved at
broadcast time and is not cryptographically signed by the external Bitcoin
signers. Legacy A2 reviews remain broadcast/status compatible but are never
accounting sources.

After six canonical confirmations, Electron main re-fetches the exact raw
transaction and verifies txid, wtxid, bytes, version/locktime, all inputs and
outputs, totals, fee/rate, block height/hash/time, and current depth against the
immutable review. One deterministic `ConfirmedPaymentRecord` then contains one
BTC/8-decimal line per committed external output. ERPNext derives the balanced
zero-FX journal from the committed USD obligations; the transaction-input-paid
network fee is immutable audit metadata and does not change journal value yet.
Posting is single-flight and idempotent by batch ID, txid, review digest, and
record digest. Reorgs block an unposted record; after evidence/posting they
retain the receipt, evidence, and backend IDs and require manual reconciliation
without automatic reversal or rebroadcast.

## What we explicitly do not model yet

- Multi-currency consolidation reports (Phase 5)
- Per-jurisdiction tax withholding calculation (relies on payroll provider rules; we just pass through the fiat amount)
- Cost-basis matching (FIFO/LIFO/spec ID) — we use weighted-average carrying cost as the default; specific identification arrives in Phase 5
- Cross-chain treasury rebalancing journals — Phase 5+
