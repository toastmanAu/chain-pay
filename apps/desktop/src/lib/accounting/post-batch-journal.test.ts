import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PayrollBatch, PayrollBatchLine } from "@chain-pay/shared";
import { MemoryStorage } from "@/stores/test-utils/memory-storage";

// Mock ./ipc before importing the module under test
const postJournal = vi.fn();
vi.mock("./ipc", () => ({ postJournal: (...a: unknown[]) => postJournal(...a) }));

import { postBatchJournal } from "./post-batch-journal";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";

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
  // Reset the store to a clean state by clearing batches
  usePayrollBatchesStore.setState({ batches: [] });
  postJournal.mockReset();
  // Seed a single confirmed batch "pbZ"
  seedConfirmedBatch("pbZ");
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("postBatchJournal", () => {
  it("posts and marks the batch posted with the JE name", async () => {
    postJournal.mockResolvedValue({ jeName: "ACC-JV-1", idempotent: false });
    await postBatchJournal("pbZ");
    expect(postJournal).toHaveBeenCalledTimes(1);
    expect(usePayrollBatchesStore.getState().batches.find((b) => b.id === "pbZ")!.state).toBe(
      "posted",
    );
  });

  it("marks post_failed on a rejected POST", async () => {
    postJournal.mockRejectedValue(new Error("Frappe 417"));
    await postBatchJournal("pbZ");
    const b = usePayrollBatchesStore.getState().batches.find((x) => x.id === "pbZ")!;
    expect(b.state).toBe("post_failed");
    expect((b as PayrollBatch).postError).toMatch(/417/);
  });

  it("is a no-op when the batch is already posting (double-fire guard)", async () => {
    usePayrollBatchesStore.getState().markPosting("pbZ"); // now in "posting"
    await postBatchJournal("pbZ");
    expect(postJournal).not.toHaveBeenCalled();
  });

  it("is a no-op when batch is already posted (double-fire guard)", async () => {
    // Manually force to posted state
    usePayrollBatchesStore.setState({
      batches: usePayrollBatchesStore.getState().batches.map((b) =>
        b.id === "pbZ" ? { ...b, state: "posted" as const, jeName: "ACC-JV-0" } : b,
      ),
    });
    await postBatchJournal("pbZ");
    expect(postJournal).not.toHaveBeenCalled();
  });

  it("is a no-op for a vendor batch (kind guard)", async () => {
    // Add a vendor batch in confirmed state
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
    await postBatchJournal("vb-1");
    expect(postJournal).not.toHaveBeenCalled();
    // State must remain confirmed (not mutated)
    const vb = usePayrollBatchesStore.getState().batches.find((b) => b.id === "vb-1")!;
    expect(vb.state).toBe("confirmed");
  });

  it("is a no-op for an unknown batch id", async () => {
    await postBatchJournal("does-not-exist");
    expect(postJournal).not.toHaveBeenCalled();
  });

  it("can retry from post_failed — posts and marks posted", async () => {
    // Get to post_failed state
    usePayrollBatchesStore.getState().markPosting("pbZ");
    usePayrollBatchesStore.getState().markPostFailed("pbZ", "transient error");
    expect(usePayrollBatchesStore.getState().batches.find((b) => b.id === "pbZ")!.state).toBe(
      "post_failed",
    );

    postJournal.mockResolvedValue({ jeName: "ACC-JV-2", idempotent: true });
    await postBatchJournal("pbZ");
    expect(postJournal).toHaveBeenCalledTimes(1);
    expect(usePayrollBatchesStore.getState().batches.find((b) => b.id === "pbZ")!.state).toBe(
      "posted",
    );
  });
});
