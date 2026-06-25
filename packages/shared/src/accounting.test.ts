import { describe, it, expect } from "vitest";
import {
  buildBatchJournal,
  buildPaymentLines,
  type PaymentJournalInput,
  type JournalAccounts,
} from "./accounting";
import type { JournalEntry } from "./payroll";
import * as shared from "./index";

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

  it("negative obligation still balances", () => {
    const lines = buildPaymentLines(
      payment({ obligation: fiat(-100_000n), carryingCost: fiat(-90_000n) }),
      accounts,
    );
    assertBalanced(lines);
  });

  it("zero-everything payment yields 2 balanced lines", () => {
    const lines = buildPaymentLines(
      payment({ obligation: fiat(0n), feeFiat: fiat(0n), carryingCost: fiat(0n) }),
      accounts,
    );
    expect(lines).toHaveLength(2);
    assertBalanced(lines);
  });
});

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
    // per-group balance: P1 = 4 lines, P2 = 4 lines, P3 = 3 lines
    assertBalanced(preview.entries.slice(0, 4));   // P1 group
    assertBalanced(preview.entries.slice(4, 8));   // P2 group
    assertBalanced(preview.entries.slice(8, 11));  // P3 group
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

  it("default memoLabel (undefined) produces 'Payroll' prefix, unchanged from before", () => {
    const payments = [payment({ payeeId: "P1" })];
    const preview = buildBatchJournal("BATCH-1", payments, {
      networkFeeExpense: "Network Fee Expense",
      fxGainLoss: "FX Gain/Loss",
    });
    const memos = preview.entries.map((e) => e.memo);
    expect(memos.every((m) => m?.startsWith("Payroll P1"))).toBe(true);
  });

  it("memoLabel: 'Send' produces 'Send' prefix on all lines", () => {
    const payments = [payment({ payeeId: "vendor-1" })];
    const preview = buildBatchJournal("SEND-1", payments, {
      networkFeeExpense: "Network Fee Expense",
      fxGainLoss: "FX Gain/Loss",
      memoLabel: "Send",
    });
    const memos = preview.entries.map((e) => e.memo);
    expect(memos.every((m) => m?.startsWith("Send vendor-1"))).toBe(true);
  });
});
