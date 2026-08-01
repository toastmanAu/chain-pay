import type { ChainAdapter } from "../types";
import type { ChainId } from "@chain-pay/shared";
import { isAddress } from "viem";
import { getEvmPublicClient } from "./public-client";
import { readEvmExecutionStatus } from "./execution-status";

/**
 * EVM chain adapter. Treasury is a Safe contract; transactions are EIP-712
 * SafeTx typed messages signed by N-of-M owners.
 */
export function evmAdapter(chainId: number): ChainAdapter {
  const chain: ChainId = `evm:${chainId}`;
  return {
    chain,
    status: "stub",

    async getBalance(account) {
      if (!isAddress(account, { strict: false })) throw new Error("invalid EVM address");
      const value = await getEvmPublicClient(chainId).getBalance({ address: account });
      return { asset: "ETH", value, decimals: 18 };
    },

    validateAddress(address) {
      const ok = isAddress(address, { strict: false });
      return ok ? { valid: true, normalized: address.toLowerCase() } : { valid: false, reason: "invalid EVM address" };
    },

    async estimateFee() {
      throw new Error("evmAdapter.estimateFee — Phase 3");
    },

    async createUnsignedTransaction() {
      throw new Error("evmAdapter.createUnsignedTransaction — Phase 3 (Safe protocol-kit)");
    },

    async broadcastTransaction() {
      throw new Error("evmAdapter.broadcastTransaction — Phase 3 (Safe execTransaction)");
    },

    async getTransactionStatus(hash) {
      const status = await readEvmExecutionStatus(chainId, hash);
      if (status.state === "pending") {
        return { hash, state: "confirming", confirmations: 0 };
      }
      if (status.state === "failed") {
        return { hash, state: "failed", confirmations: 0, blockNumber: status.blockNumber };
      }
      return {
        hash,
        state: "confirmed",
        confirmations: status.confirmations,
        blockNumber: status.blockNumber,
      };
    },
  };
}
