import { TransactionReceiptNotFoundError, type Hex } from "viem";
import { getEvmPublicClient } from "./public-client";

export type EvmExecutionStatus =
  | { state: "pending" }
  | { state: "confirmed"; blockNumber: bigint; confirmations: number }
  | { state: "failed"; blockNumber: bigint; reason: string };

export interface EvmReceiptOperations {
  receipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null>;
  blockNumber(): Promise<bigint>;
}

export async function readEvmExecutionStatus(
  chainId: number,
  hash: Hex,
  operations: EvmReceiptOperations = receiptOperations(chainId),
): Promise<EvmExecutionStatus> {
  const receipt = await operations.receipt(hash);
  if (!receipt) return { state: "pending" };
  if (receipt.status === "reverted") {
    return {
      state: "failed",
      blockNumber: receipt.blockNumber,
      reason: "Safe execution reverted on Sepolia",
    };
  }
  const tip = await operations.blockNumber();
  const count = tip >= receipt.blockNumber ? tip - receipt.blockNumber + 1n : 1n;
  return {
    state: "confirmed",
    blockNumber: receipt.blockNumber,
    confirmations: Number(count > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : count),
  };
}

function receiptOperations(chainId: number): EvmReceiptOperations {
  const client = getEvmPublicClient(chainId);
  return {
    receipt: async (hash) => {
      try {
        return await client.getTransactionReceipt({ hash });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    blockNumber: () => client.getBlockNumber(),
  };
}
