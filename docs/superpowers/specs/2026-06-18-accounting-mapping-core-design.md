# Accounting mapping core (Phase 5 / Slice A) — design

**Date:** 2026-06-18
**Status:** approved (brainstorming) → spec
**Scope:** `packages/shared` only. Pure TypeScript, unit-tested in vitest. No Frappe, no docker, no network.
**Slice of:** the Frappe accounting bridge ("every confirmed payment posts a balanced journal entry"). This is slice **A** of a 6-slice decomposition (A: mapping core; B: Frappe env; C: bridge+accounting REST; D: FX rate service; E: remaining REST + desktop wiring; F: compliance export). Each slice gets its own spec → plan → implementation cycle.

## Goal

A pure function that maps the confirmed payments of a payroll batch to a balanced set of double-entry journal lines, ready for a later slice to post into ERPNext. The function proves and protects the core accounting invariant — **Σdebits == Σcredits** — in isolation, with zero infrastructure.

## Why this slice first

The entire ChainPay thesis is that every confirmed payment posts a *balanced* journal entry. The place that can silently be wrong is the double-entry math (debits must equal credits to the cent; FX gain/loss must be derived correctly). That logic is pure — payment + basis → journal lines — so it is fully unit-testable without standing up Frappe/ERPNext. Building and proving it first de-risks every downstream slice; doing infra first would mean debugging accounting math through a containerized ORM.

## Existing types reused (no new money/JE primitives)

From `packages/shared/src/money.ts` and `payroll.ts` (already present):

- `FiatAmount { currency: string; minor: bigint }` — integer minor units (cents). Exact; no float.
- `Money { asset: string; value: bigint; decimals: number }` — native crypto units.
- `JournalEntry { account: string; debit?: FiatAmount; credit?: FiatAmount; crypto?: { chain: ChainId; asset: string; amount: string; txHash: TransactionHash }; memo?: string }` — a single account line (debit XOR credit).
- `AccountingJournalPreview { batchId: string; entries: JournalEntry[] }` — flat list of lines.
- `ChainId` (from `chainIds.ts`), `TransactionHash` (from `types.ts`).

The core produces `AccountingJournalPreview`; it does not introduce new money or journal types.

## Module

`packages/shared/src/accounting.ts`, exported from `packages/shared/src/index.ts` alongside the other domain modules. Test: `packages/shared/src/accounting.test.ts`.

## Contract

```ts
export interface PaymentJournalInput {
  payeeId: string;
  /** F — salary fiat recognized as expense. */
  obligation: FiatAmount;
  /** Network fee in fiat at confirmation. */
  feeFiat: FiatAmount;
  /** Basis (carrying cost) of ALL crypto disposed for this payment (salary + fee crypto). Explicit input — lot/weighted-average tracking is out of scope. */
  carryingCost: FiatAmount;
  /** Total native crypto out, for the treasury asset-line reference. */
  crypto: Money;
  chain: ChainId;
  txHash: TransactionHash;
  /** Expense account, resolved by the caller per payee department. */
  salaryAccount: string;
  /** Treasury asset (sub-)account, resolved by the caller per chain. */
  treasuryAccount: string;
}

export interface JournalAccounts {
  networkFeeExpense: string;
  fxGainLoss: string;
}

export function buildBatchJournal(
  batchId: string,
  payments: PaymentJournalInput[],
  accounts: JournalAccounts,
): AccountingJournalPreview;
```

**No crypto×rate conversion inside the core.** Every fiat figure (`obligation`, `feeFiat`, `carryingCost`) arrives as `FiatAmount` minor units. Rate→fiat conversion and its rounding live upstream / in a later slice. The core is therefore pure integer (`bigint`) arithmetic on minor units, so the balance invariant holds exactly with no internal rounding.

## Per-payment mapping

Each `PaymentJournalInput` produces up to four `JournalEntry` lines:

| # | Account | Side | Amount | Notes |
|---|---|---|---|---|
| 1 | `salaryAccount` | debit | `obligation` | expense recognized at the fiat obligation |
| 2 | `treasuryAccount` | credit | `carryingCost` | asset relieved at basis; carries the `crypto` ref `{ chain, asset: crypto.asset, amount: crypto.value.toString(), txHash }` |
| 3 | `accounts.networkFeeExpense` | debit | `feeFiat` | **omitted when `feeFiat.minor === 0n`** |
| 4 | `accounts.fxGainLoss` | debit or credit | `gainLoss` (the **plug**) | see below; **omitted when `gainLoss === 0n`** |

**FX gain/loss is the balancing plug, not an independent figure:**

```
gainLoss = (obligation.minor + feeFiat.minor) - carryingCost.minor
gainLoss  > 0n → credit fxGainLoss by gainLoss            (realized gain: asset basis < value settled)
gainLoss  < 0n → debit  fxGainLoss by (-gainLoss)         (realized loss: asset basis > value settled)
gainLoss === 0n → no FX line
```

This construction guarantees, per payment, `Σdebit.minor === Σcredit.minor`:
- debits = `obligation + feeFiat (+ loss if gainLoss<0)`
- credits = `carryingCost (+ gain if gainLoss>0)`

and therefore the whole-batch aggregate balances too (sum of balanced groups).

**Memos:** each line gets a human-readable memo including the `payeeId` and short `txHash` (e.g. `"Payroll <payeeId> · <txHash[0:10]>…"`). Exact wording is an implementation detail, not a spec requirement, but every line must carry a non-empty memo.

**Line ordering:** within a payment, lines appear in the table order above (salary, treasury, fee, fx), omitted lines collapsed out. Payments appear in input order. Deterministic output for testability.

## Validation & errors

`buildBatchJournal` throws a descriptive `Error` (pure function; the caller catches) when:

1. Any single payment mixes fiat currencies among `obligation` / `feeFiat` / `carryingCost`.
2. Payments disagree on fiat currency across the batch (all payments must share one currency — the batch/treasury currency).
3. Any `crypto.value < 0n`.

An **empty `payments` array is valid** and returns `{ batchId, entries: [] }` (a zero-payment batch is trivially balanced).

Negative `obligation` / `feeFiat` / `carryingCost` minor values are not separately rejected — they flow through the arithmetic (a refund/correction is representable); only the three conditions above throw.

## Edge cases

- **Splits:** a split payee is already flattened into multiple `PayrollBatchLine`s upstream, so each becomes its own `PaymentJournalInput`. The core needs no split awareness.
- **Zero fee** → no fee line; still balances.
- **Zero gain/loss** → no FX line; 3 lines; still balances.
- **Single payment** and **many payments** handled identically (map + flatten).

## Testing (vitest)

`accounting.test.ts`, asserting on every case the invariant `sum of debit.minor === sum of credit.minor` (both per-payment and batch-aggregate):

1. **Gain case** — `carryingCost < obligation+feeFiat`: 4 lines, FX line is a **credit**, balances.
2. **Loss case** — `carryingCost > obligation+feeFiat`: FX line is a **debit**, balances.
3. **Zero gain/loss** — `carryingCost == obligation+feeFiat`: 3 lines, no FX line, balances.
4. **Zero fee** — `feeFiat.minor === 0n`: no fee line, balances.
5. **Multi-payment batch** — 3 payments mixing gain/loss/zero: aggregate balances, each payment group balances, total entry count correct, payment order preserved.
6. **Treasury reference** — the treasury credit line carries `crypto` with the correct `chain`, `asset`, `amount` (`crypto.value.toString()`), and `txHash`; no other line carries a `crypto` ref.
7. **Mixed currency within a payment** — throws.
8. **Mixed currency across payments** — throws.
9. **Negative `crypto.value`** — throws.
10. **Empty batch** — returns `{ batchId, entries: [] }`.
11. **Every line has a non-empty memo.**

## Out of scope (later slices)

- Cost-basis lot tracking / weighted-average basis computation (basis arrives as an input here).
- The informational per-batch summary row (batch id, totals, tx hash, confirmed-at) — a report artifact, belongs with the Frappe-posting slice.
- Crypto→fiat rate conversion and its rounding policy (upstream).
- The calc-time-vs-confirmation "slippage" decomposition of FX gain/loss.
- Any Frappe / ERPNext / docker / REST / persistence concern.

## Global constraints

- `packages/shared` only; pure TS; no new dependencies.
- All money is `bigint` minor units / native units — never float, never `number`.
- Immutable: build and return new arrays/objects; never mutate inputs.
- Files < 800 lines, functions < 50 lines, nesting ≤ 4 (extract a per-payment helper from the batch mapper).
- Exported from `packages/shared/src/index.ts`.
- `npx vitest run` and `npx tsc --noEmit` green in `packages/shared`.

## Success criteria

- `buildBatchJournal` returns a balanced `AccountingJournalPreview` for any valid input, with the FX line correctly signed and zero-lines omitted.
- The balance invariant is asserted in every applicable test and holds.
- Invalid inputs (mixed currency, negative crypto) throw descriptive errors.
- Type-checks clean and is exported for downstream slices (desktop preview, Frappe posting) to consume.
