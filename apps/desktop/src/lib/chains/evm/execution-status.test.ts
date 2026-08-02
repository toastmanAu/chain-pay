import { describe, expect, it, vi } from "vitest";
import { readEvmExecutionStatus, type EvmReceiptOperations } from "./execution-status";

const HASH = `0x${"ab".repeat(32)}` as const;

function operations(
  receipt: Awaited<ReturnType<EvmReceiptOperations["receipt"]>>,
  tip = 105n,
): EvmReceiptOperations {
  return {
    receipt: vi.fn().mockResolvedValue(receipt),
    blockNumber: vi.fn().mockResolvedValue(tip),
    blockTimestamp: vi.fn().mockResolvedValue(1_785_552_000n),
  };
}

describe("readEvmExecutionStatus", () => {
  it("reports a transaction without a receipt as pending", async () => {
    await expect(readEvmExecutionStatus(11155111, HASH, operations(null))).resolves.toEqual({
      state: "pending",
    });
  });

  it("reports successful receipt confirmations", async () => {
    await expect(
      readEvmExecutionStatus(
        11155111,
        HASH,
        operations({
          status: "success",
          blockNumber: 100n,
          from: "0x1111111111111111111111111111111111111111",
          gasUsed: 100_000n,
          effectiveGasPrice: 2_000_000_000n,
        }),
      ),
    ).resolves.toEqual({
      state: "confirmed",
      blockNumber: 100n,
      confirmations: 6,
      confirmedAt: "2026-08-01T02:40:00.000Z",
      executorAddress: "0x1111111111111111111111111111111111111111",
      gasUsed: 100_000n,
      effectiveGasPriceWei: 2_000_000_000n,
      gasFeeWei: 200_000_000_000_000n,
    });
  });

  it("reports reverted execution as failed", async () => {
    await expect(
      readEvmExecutionStatus(
        11155111,
        HASH,
        operations({
          status: "reverted",
          blockNumber: 100n,
          from: "0x1111111111111111111111111111111111111111",
          gasUsed: 100_000n,
          effectiveGasPrice: 2_000_000_000n,
        }),
      ),
    ).resolves.toEqual({
      state: "failed",
      blockNumber: 100n,
      reason: "Safe execution reverted on Sepolia",
    });
  });
});
