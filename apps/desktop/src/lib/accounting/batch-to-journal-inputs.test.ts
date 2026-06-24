import { describe, it, expect } from "vitest";
import type { PayrollBatch } from "@chain-pay/shared";
import { DEFAULT_ACCOUNT_MAP } from "./account-map";
import { buildBatchJournalForBatch } from "./batch-to-journal-inputs";

function batch(over: Partial<PayrollBatch> = {}): PayrollBatch {
  return {
    kind: "payroll", id: "pb_1", createdAt: "t", updatedAt: "t",
    label: "L", treasuryId: "tr1", cycleStart: "a", cycleEnd: "b",
    fxSnapshot: [], state: "confirmed", pendingTxId: "0xabc123",
    lines: [{
      payeeId: "alice",
      fiat: { currency: "USD", minor: 200000n },
      crypto: { asset: "CKB", value: 1000_00000000n, decimals: 8 },
      fxRate: "2.0",
      feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
    }],
    ...over,
  };
}

describe("buildBatchJournalForBatch", () => {
  it("maps a zero-fee line to a balanced two-line journal (no fee/FX lines)", () => {
    const preview = buildBatchJournalForBatch(batch(), DEFAULT_ACCOUNT_MAP);
    expect(preview.batchId).toBe("pb_1");
    expect(preview.entries).toHaveLength(2);
    const debit = preview.entries.find((e) => e.debit);
    const credit = preview.entries.find((e) => e.credit);
    expect(debit?.account).toBe("Salary or Wage Expense");
    expect(debit?.debit?.minor).toBe(200000n);
    expect(credit?.account).toBe("Crypto Treasury Asset");
    expect(credit?.credit?.minor).toBe(200000n); // carryingCost = obligation + 0 fee
  });

  it("throws when a confirmed batch has no pendingTxId", () => {
    const b = batch();
    delete (b as Partial<typeof b>).pendingTxId;
    expect(() => buildBatchJournalForBatch(b, DEFAULT_ACCOUNT_MAP))
      .toThrow(/pendingTxId/);
  });
});
