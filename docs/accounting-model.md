# Accounting model

Every confirmed crypto payment posts a balanced journal entry into ERPNext. This document specifies exactly what gets posted.

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

## What we explicitly do not model in Phase 4

- Multi-currency consolidation reports (Phase 5)
- Per-jurisdiction tax withholding calculation (relies on payroll provider rules; we just pass through the fiat amount)
- Cost-basis matching (FIFO/LIFO/spec ID) — we use weighted-average carrying cost as the default; specific identification arrives in Phase 5
- Cross-chain treasury rebalancing journals — Phase 5+
