import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { readSafeSnapshot, type SafeReadOperations } from "./safe-reader";

const SAFE = "0x1234567890123456789012345678901234567890";
const OWNER_A = "0x1111111111111111111111111111111111111111";
const OWNER_B = "0x2222222222222222222222222222222222222222";

function operations(overrides: Partial<SafeReadOperations> = {}): SafeReadOperations {
  return {
    getChainId: vi.fn().mockResolvedValue(11155111),
    getBytecode: vi.fn().mockResolvedValue("0x6000"),
    getOwners: vi.fn().mockResolvedValue([OWNER_A, OWNER_B] as Address[]),
    getThreshold: vi.fn().mockResolvedValue(2n),
    getVersion: vi.fn().mockResolvedValue("1.4.1"),
    getBalance: vi.fn().mockResolvedValue(25n),
    getBlockNumber: vi.fn().mockResolvedValue(7_000_000n),
    ...overrides,
  };
}

describe("readSafeSnapshot", () => {
  it("reads and normalises an existing Safe", async () => {
    await expect(readSafeSnapshot(11155111, SAFE, operations())).resolves.toEqual({
      chainId: 11155111,
      address: SAFE,
      owners: [OWNER_A, OWNER_B],
      threshold: 2,
      version: "1.4.1",
      balanceWei: 25n,
      blockNumber: 7_000_000n,
    });
  });

  it("rejects an RPC connected to the wrong chain", async () => {
    await expect(
      readSafeSnapshot(11155111, SAFE, operations({ getChainId: vi.fn().mockResolvedValue(1) })),
    ).rejects.toThrow("RPC chain mismatch");
  });

  it("rejects an address with no deployed contract", async () => {
    await expect(
      readSafeSnapshot(11155111, SAFE, operations({ getBytecode: vi.fn().mockResolvedValue("0x") })),
    ).rejects.toThrow("No contract is deployed");
  });

  it("rejects a contract that does not expose the Safe read interface", async () => {
    await expect(
      readSafeSnapshot(
        11155111,
        SAFE,
        operations({ getOwners: vi.fn().mockRejectedValue(new Error("execution reverted")) }),
      ),
    ).rejects.toThrow("Contract is not a readable Safe");
  });

  it("rejects impossible threshold data", async () => {
    await expect(
      readSafeSnapshot(11155111, SAFE, operations({ getThreshold: vi.fn().mockResolvedValue(3n) })),
    ).rejects.toThrow("Safe returned an invalid owner threshold");
  });
});
