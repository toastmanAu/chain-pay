# Accounting Mapping Core (Phase 5 / Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure TypeScript function that maps the confirmed payments of a payroll batch into a balanced set of double-entry journal lines.

**Architecture:** One new pure module `packages/shared/src/accounting.ts` exporting an internal-but-exported per-payment line builder and the public batch wrapper, reusing the existing `FiatAmount`/`Money`/`JournalEntry`/`AccountingJournalPreview` types. All arithmetic is `bigint` minor units; FX gain/loss is computed as the balancing plug so debits == credits by construction. Unit-tested in vitest.

**Tech Stack:** TypeScript, Vitest (v4, auto-discovered — no config in `packages/shared`).

## Global Constraints

- `packages/shared` only. Pure TS. No new dependencies. No Frappe/docker/network.
- All money is `bigint` minor units (`FiatAmount.minor`) or native units (`Money.value`) — never float, never `number`.
- Immutable: build and return new arrays/objects; never mutate inputs.
- Files < 800 lines, functions < 50 lines, nesting ≤ 4.
- Reuse existing types — do NOT introduce new money or journal-entry primitives.
- `ChainId` valid literal for tests: `"ckb:testnet"`. `TransactionHash` is `` `0x${string}` `` (string literals like `"0xabcdef0123456789"` satisfy it — no cast). `JournalEntry.crypto.amount` is a `string`.
- Exported from `packages/shared/src/index.ts` via the existing `export * from "./<module>"` convention.
- Test command (from `packages/shared`): `npx vitest run` (auto-discovers `src/**/*.test.ts`; target one file with `npx vitest run src/accounting.test.ts`). Typecheck: `npm run typecheck`.
- Spec: `docs/superpowers/specs/2026-06-18-accounting-mapping-core-design.md`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/accounting.ts` (create) | `PaymentJournalInput`, `JournalAccounts` interfaces; `buildPaymentLines` (per-payment → balanced lines); `buildBatchJournal` (batch wrapper) |
| `packages/shared/src/accounting.test.ts` (create) | vitest cases; every case asserts `Σdebit.minor === Σcredit.minor` |
| `packages/shared/src/index.ts` (modify) | add `export * from "./accounting";` |

---

### Task 1: Per-payment journal builder + types

**Files:**
- Create: `packages/shared/src/accounting.ts`
- Test: `packages/shared/src/accounting.test.ts`

**Interfaces:**
- Consumes: `FiatAmount`, `Money` from `./money`; `JournalEntry` from `./payroll`; `ChainId` from `./chainIds`; `TransactionHash` from `./types`.
- Produces:
  - `interface PaymentJournalInput { payeeId: string; obligation: FiatAmount; feeFiat: FiatAmount; carryingCost: FiatAmount; crypto: Money; chain: ChainId; txHash: TransactionHash; salaryAccount: string; treasuryAccount: string }`
  - `interface JournalAccounts { networkFeeExpense: string; fxGainLoss: string }`
  - `function buildPaymentLines(p: PaymentJournalInput, accounts: JournalAccounts): JournalEntry[]` — returns up to 4 balanced lines (salary debit, treasury credit w/ crypto ref, fee debit omitted-if-zero, FX plug omitted-if-zero); throws on within-payment mixed currency and negative `crypto.value`.

- [ ] **Step 1: Write the failing test** — create `packages/shared/src/accounting.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildPaymentLines,
  type PaymentJournalInput,
  type JournalAccounts,
} from "./accounting";
import type { JournalEntry } from "./payroll";

const accounts: JournalAccounts = {
  networkFeeExpense: "Network Fee Expense",
  fxGainLoss: "FX Gain/Loss",
};

const fiat = (minor: bigint, currency = "USD") => ({ currency, minor });

function payment(over: Partial<PaymentJournalInput> = {}): PaymentJournalInput {
  return {
    payeeId: "P1",
    obligation: fiat(100_000n), // $1000.00
    feeFiat: fiat(50n), // $0.50
    carryingCost: fiat(90_000n), // $900.00 basis
    crypto: { asset: "CKB", value: 100_000_000_000n, decimals: 8 },
    chain: "ckb:testnet",
    txHash: "0xabcdef0123456789",
    salaryAccount: "Salary Expense",
    treasuryAccount: "Crypto Treasury - CKB",
    ...over,
  };
}

const sumMinor = (lines: JournalEntry[], side: "debit" | "credit"): bigint =>
  lines.reduce((s, l) => s + (l[side]?.minor ?? 0n), 0n);

const assertBalanced = (lines: JournalEntry[]): void => {
  expect(sumMinor(lines, "debit")).toBe(sumMinor(lines, "credit"));
};

describe("buildPaymentLines", () => {
  it("gain case: basis < obligation+fee → FX credit, 4 lines, balanced", () => {
    const lines = buildPaymentLines(payment(), accounts); // 100000+50-90000 = +10050
    expect(lines).toHaveLength(4);
    assertBalanced(lines);
    const fx = lines.find((l) => l.account === "FX Gain/Loss")!;
    expect(fx.credit?.minor).toBe(10_050n);
    expect(fx.debit).toBeUndefined();
  });

  it("loss case: basis > obligation+fee → FX debit, balanced", () => {
    const lines = buildPaymentLines(payment({ carryingCost: fiat(110_000n) }), accounts); // 100050-110000 = -9950
    assertBalanced(lines);
    const fx = lines.find((l) => l.account === "FX Gain/Loss")!;
    expect(fx.debit?.minor).toBe(9_950n);
    expect(fx.credit).toBeUndefined();
  });

  it("zero fee → no fee line, balanced", () => {
    const lines = buildPaymentLines(payment({ feeFiat: fiat(0n) }), accounts);
    expect(lines.some((l) => l.account === "Network Fee Expense")).toBe(false);
    assertBalanced(lines);
  });

  it("zero gain/loss → no FX line, 3 lines, balanced", () => {
    const lines = buildPaymentLines(payment({ carryingCost: fiat(100_050n) }), accounts);
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.account === "FX Gain/Loss")).toBe(false);
    assertBalanced(lines);
  });

  it("treasury line carries the crypto reference; no other line does", () => {
    const lines = buildPaymentLines(payment(), accounts);
    const withCrypto = lines.filter((l) => l.crypto !== undefined);
    expect(withCrypto).toHaveLength(1);
    expect(withCrypto[0]!.account).toBe("Crypto Treasury - CKB");
    expect(withCrypto[0]!.crypto).toEqual({
      chain: "ckb:testnet",
      asset: "CKB",
      amount: "100000000000",
      txHash: "0xabcdef0123456789",
    });
  });

  it("every line has a non-empty memo", () => {
    for (const l of buildPaymentLines(payment(), accounts)) {
      expect(l.memo && l.memo.length > 0).toBe(true);
    }
  });

  it("throws on mixed fiat currency within a payment", () => {
    expect(() => buildPaymentLines(payment({ feeFiat: fiat(50n, "EUR") }), accounts)).toThrow();
  });

  it("throws on negative crypto amount", () => {
    expect(() =>
      buildPaymentLines(payment({ crypto: { asset: "CKB", value: -1n, decimals: 8 } }), accounts),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/accounting.test.ts`
Expected: FAIL — cannot resolve `./accounting`.

- [ ] **Step 3: Write minimal implementation** — create `packages/shared/src/accounting.ts`:

```ts
import type { ChainId } from "./chainIds";
import type { TransactionHash } from "./types";
import type { FiatAmount, Money } from "./money";
import type { JournalEntry } from "./payroll";

export interface PaymentJournalInput {
  payeeId: string;
  /** F — salary fiat recognized as expense. */
  obligation: FiatAmount;
  /** Network fee in fiat at confirmation. */
  feeFiat: FiatAmount;
  /** Basis (carrying cost) of ALL crypto disposed (salary + fee). Explicit input. */
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

function memoFor(p: PaymentJournalInput): string {
  return `Payroll ${p.payeeId} · ${p.txHash.slice(0, 10)}…`;
}

/**
 * Maps one confirmed payment to its balanced journal lines. FX gain/loss is the
 * balancing plug: (obligation + feeFiat) - carryingCost. Fee and FX lines are
 * omitted when zero. Throws on within-payment mixed currency or negative crypto.
 */
export function buildPaymentLines(
  p: PaymentJournalInput,
  accounts: JournalAccounts,
): JournalEntry[] {
  const currency = p.obligation.currency;
  if (p.feeFiat.currency !== currency || p.carryingCost.currency !== currency) {
    throw new Error(
      `buildPaymentLines: mixed fiat currencies for payee ${p.payeeId} ` +
        `(obligation ${currency}, fee ${p.feeFiat.currency}, basis ${p.carryingCost.currency})`,
    );
  }
  if (p.crypto.value < 0n) {
    throw new Error(`buildPaymentLines: negative crypto amount for payee ${p.payeeId}`);
  }

  const memo = memoFor(p);
  const lines: JournalEntry[] = [
    { account: p.salaryAccount, debit: p.obligation, memo },
    {
      account: p.treasuryAccount,
      credit: p.carryingCost,
      crypto: {
        chain: p.chain,
        asset: p.crypto.asset,
        amount: p.crypto.value.toString(),
        txHash: p.txHash,
      },
      memo,
    },
  ];

  if (p.feeFiat.minor !== 0n) {
    lines.push({ account: accounts.networkFeeExpense, debit: p.feeFiat, memo });
  }

  const gainLoss = p.obligation.minor + p.feeFiat.minor - p.carryingCost.minor;
  if (gainLoss > 0n) {
    lines.push({ account: accounts.fxGainLoss, credit: { currency, minor: gainLoss }, memo });
  } else if (gainLoss < 0n) {
    lines.push({ account: accounts.fxGainLoss, debit: { currency, minor: -gainLoss }, memo });
  }

  return lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/accounting.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/accounting.ts packages/shared/src/accounting.test.ts
git commit -m "feat(accounting): per-payment journal line builder with FX-plug balancing"
```

---

### Task 2: Batch wrapper + index export

**Files:**
- Modify: `packages/shared/src/accounting.ts` (append `buildBatchJournal`)
- Modify: `packages/shared/src/index.ts` (add export)
- Test: `packages/shared/src/accounting.test.ts` (append batch cases)

**Interfaces:**
- Consumes: `buildPaymentLines`, `PaymentJournalInput`, `JournalAccounts` from Task 1; `AccountingJournalPreview` from `./payroll`.
- Produces: `function buildBatchJournal(batchId: string, payments: PaymentJournalInput[], accounts: JournalAccounts): AccountingJournalPreview` — flat balanced entries (per-payment groups, input order); throws on cross-payment mixed currency; empty `payments` → `{ batchId, entries: [] }`.

- [ ] **Step 1: Write the failing test** — append to `packages/shared/src/accounting.test.ts`:

```ts
import { buildBatchJournal } from "./accounting";
import * as shared from "./index";

describe("buildBatchJournal", () => {
  it("multi-payment batch: aggregate balanced, each group balanced, order preserved", () => {
    const payments: PaymentJournalInput[] = [
      payment({ payeeId: "P1" }), // gain
      payment({ payeeId: "P2", carryingCost: fiat(110_000n) }), // loss
      payment({ payeeId: "P3", carryingCost: fiat(100_050n) }), // zero g/l
    ];
    const preview = buildBatchJournal("BATCH-1", payments, accounts);
    expect(preview.batchId).toBe("BATCH-1");
    assertBalanced(preview.entries); // aggregate
    // entry count: P1 4 + P2 4 + P3 3 = 11
    expect(preview.entries).toHaveLength(11);
    // order preserved: first line is P1's salary debit
    expect(preview.entries[0]!.account).toBe("Salary Expense");
    expect(preview.entries[0]!.memo).toContain("P1");
  });

  it("empty batch returns no entries", () => {
    expect(buildBatchJournal("EMPTY", [], accounts)).toEqual({ batchId: "EMPTY", entries: [] });
  });

  it("throws on mixed fiat currency across payments", () => {
    const payments: PaymentJournalInput[] = [
      payment({ payeeId: "P1" }),
      payment({
        payeeId: "P2",
        obligation: fiat(100_000n, "EUR"),
        feeFiat: fiat(50n, "EUR"),
        carryingCost: fiat(90_000n, "EUR"),
      }),
    ];
    expect(() => buildBatchJournal("BATCH-X", payments, accounts)).toThrow();
  });

  it("is re-exported from the package index", () => {
    expect(typeof shared.buildBatchJournal).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/accounting.test.ts`
Expected: FAIL — `buildBatchJournal` is not exported (and `shared.buildBatchJournal` is undefined).

- [ ] **Step 3a: Append the batch wrapper** to `packages/shared/src/accounting.ts`:

```ts
import type { AccountingJournalPreview } from "./payroll";

/**
 * Maps a confirmed batch's payments to a flat, balanced set of journal lines
 * (per-payment groups in input order). Throws if payments disagree on fiat
 * currency. An empty batch returns no entries.
 */
export function buildBatchJournal(
  batchId: string,
  payments: PaymentJournalInput[],
  accounts: JournalAccounts,
): AccountingJournalPreview {
  if (payments.length > 0) {
    const currency = payments[0]!.obligation.currency;
    for (const p of payments) {
      if (p.obligation.currency !== currency) {
        throw new Error(
          `buildBatchJournal: batch mixes fiat currencies ` +
            `(${currency} vs ${p.obligation.currency} for payee ${p.payeeId})`,
        );
      }
    }
  }
  const entries = payments.flatMap((p) => buildPaymentLines(p, accounts));
  return { batchId, entries };
}
```

Note: add `AccountingJournalPreview` to the existing `import type { ... } from "./payroll";` line rather than a duplicate import if you prefer — either compiles. The code block shows a separate import for clarity.

- [ ] **Step 3b: Export from the package index** — add to `packages/shared/src/index.ts` (alongside the other `export *` lines):

```ts
export * from "./accounting";
```

- [ ] **Step 4: Run test + full suite + typecheck**

Run: `cd packages/shared && npx vitest run src/accounting.test.ts`
Expected: PASS (12 tests total — 8 from Task 1 + 4 here).

Run: `cd packages/shared && npx vitest run && npm run typecheck`
Expected: full suite green (42 prior + 12 new = 54), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/accounting.ts packages/shared/src/accounting.test.ts packages/shared/src/index.ts
git commit -m "feat(accounting): batch journal wrapper + shared export"
```

---

## Self-Review

**Spec coverage:**
- Contract (`PaymentJournalInput`, `JournalAccounts`, `buildBatchJournal`) → Tasks 1 + 2. ✓
- No rate math; pure `bigint` minor units → both tasks use only `.minor` arithmetic. ✓
- Per-payment 4-line mapping + FX plug + fee/FX omission → Task 1 impl + tests (gain/loss/zero-fee/zero-gl). ✓
- Treasury line carries `crypto` ref; no other line → Task 1 test "treasury line carries the crypto reference". ✓
- Validation: within-payment mixed currency, negative crypto → Task 1; cross-payment currency → Task 2; empty batch valid → Task 2. ✓
- Memos non-empty → Task 1 test. ✓
- Output `AccountingJournalPreview`, flat, input order → Task 2 test (order, count). ✓
- Exported from index → Task 2 (`export *` + re-export test). ✓
- Balance invariant asserted everywhere → `assertBalanced` in every applicable case. ✓
- Out-of-scope items (basis tracking, summary row, rate conversion, slippage, Frappe) → not implemented, correct. ✓

**Placeholder scan:** none — every step has full code and exact commands. ✓

**Type consistency:** `buildPaymentLines(p, accounts)` and `buildBatchJournal(batchId, payments, accounts)` signatures identical across tasks and tests. `PaymentJournalInput`/`JournalAccounts` field names match the spec and the test factory. `fiat()` returns `{ currency, minor }` matching `FiatAmount`. `chain: "ckb:testnet"` and `txHash: "0xabcdef0123456789"` satisfy `ChainId`/`TransactionHash` without casts (verified against `chainIds.ts`/`types.ts`). ✓

**Note on test count:** "42 prior" reflects the shared suite at plan-writing time; if it has drifted, the assertion is "all prior + 12 new, green" — don't hard-fail on the exact prior number.
