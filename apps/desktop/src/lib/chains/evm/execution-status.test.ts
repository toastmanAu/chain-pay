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
        operations({ status: "success", blockNumber: 100n }),
      ),
    ).resolves.toEqual({ state: "confirmed", blockNumber: 100n, confirmations: 6 });
  });

  it("reports reverted execution as failed", async () => {
    await expect(
      readEvmExecutionStatus(
        11155111,
        HASH,
        operations({ status: "reverted", blockNumber: 100n }),
      ),
    ).resolves.toEqual({
      state: "failed",
      blockNumber: 100n,
      reason: "Safe execution reverted on Sepolia",
    });
  });
});
