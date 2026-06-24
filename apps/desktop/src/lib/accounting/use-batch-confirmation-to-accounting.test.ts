import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PayrollBatch, PayrollBatchLine } from "@chain-pay/shared";
import { MemoryStorage } from "@/stores/test-utils/memory-storage";

const post = vi.fn().mockResolvedValue(undefined);
vi.mock("./post-batch-journal", () => ({ postBatchJournal: (id: string) => post(id) }));

import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { syncConfirmedToAccounting } from "./use-batch-confirmation-to-accounting";

const sampleLine: PayrollBatchLine = {
  payeeId: "p1",
  fiat: { currency: "USD", minor: 500000n },
  crypto: { asset: "CKB", value: 119047619047619n, decimals: 8 },
  fxRate: "0.0042",
  feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
};

function seedConfirmedBatch(id: string): void {
  const batch: PayrollBatch = {
    id,
    kind: "payroll",
    label: "Test Payroll",
    treasuryId: "t-testnet",
    cycleStart: "2026-06-01",
    cycleEnd: "2026-06-30",
    fxSnapshot: [],
    lines: [sampleLine],
    state: "confirmed",
    pendingTxId: "0x" + "aa".repeat(32),
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
  };
  usePayrollBatchesStore.getState().addBatch(batch);
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  usePayrollBatchesStore.setState({ batches: [] });
  post.mockClear();
});

describe("syncConfirmedToAccounting", () => {
  it("calls postBatchJournal for each confirmed payroll batch", () => {
    seedConfirmedBatch("c1");
    seedConfirmedBatch("c2");
    syncConfirmedToAccounting();
    expect(post).toHaveBeenCalledWith("c1");
    expect(post).toHaveBeenCalledWith("c2");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("ignores batches not in confirmed (posting/posted/post_failed)", () => {
    seedConfirmedBatch("c3");
    usePayrollBatchesStore.getState().markPosting("c3"); // now posting
    syncConfirmedToAccounting();
    expect(post).not.toHaveBeenCalled();
  });

  it("ignores vendor batches even when in confirmed state", () => {
    usePayrollBatchesStore.getState().addBatch({
      kind: "vendor",
      id: "vb-1",
      label: "Vendor Batch",
      treasuryId: "t-testnet",
      invoiceIds: ["inv-1"],
      vendorId: "vendor-1",
      fxSnapshot: [],
      lines: [
        {
          vendorId: "vendor-1",
          fiat: { minor: 100n, currency: "USD" },
          crypto: { value: 1_000_000n, asset: "CKB", decimals: 8 },
          fxRate: "0.01",
          feeAllocated: { value: 0n, asset: "CKB", decimals: 8 },
        },
      ],
      state: "confirmed",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    syncConfirmedToAccounting();
    expect(post).not.toHaveBeenCalled();
  });

  it("calls postBatchJournal only for payroll batches when mixed batch types exist", () => {
    seedConfirmedBatch("payroll-1");
    usePayrollBatchesStore.getState().addBatch({
      kind: "vendor",
      id: "vendor-1",
      label: "Vendor Batch",
      treasuryId: "t-testnet",
      invoiceIds: ["inv-1"],
      vendorId: "v1",
      fxSnapshot: [],
      lines: [
        {
          vendorId: "v1",
          fiat: { minor: 200n, currency: "AUD" },
          crypto: { value: 2_000_000n, asset: "CKB", decimals: 8 },
          fxRate: "0.02",
          feeAllocated: { value: 0n, asset: "CKB", decimals: 8 },
        },
      ],
      state: "confirmed",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    syncConfirmedToAccounting();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("payroll-1");
  });
});
